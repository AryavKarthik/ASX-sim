"""Your notes on each trade: the plan going in, how you felt, and the review afterwards.

A plan can be written on the order ticket before the trade exists. It's stored against the
order and becomes the trade's journal entry once that order opens a trade.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from asxsim.journal.trades import Trade

log = logging.getLogger("asxsim.journal")

SETUPS = ["Breakout", "Pullback", "VWAP bounce", "Reversal", "Momentum", "Gap and go", "News"]
EMOTIONS = ["Calm", "Confident", "Patient", "FOMO", "Anxious", "Greedy", "Revenge", "Bored"]
MAX_TEXT = 2000


class JournalError(ValueError):
    """A journal entry failed validation."""


@dataclass
class JournalEntry:
    setup: str | None = None
    thesis: str = ""  # why I'm taking this trade
    planned_stop: Decimal | None = None
    planned_target: Decimal | None = None
    confidence: int | None = None  # 1-5
    emotions: list[str] = field(default_factory=list)
    followed_plan: bool | None = None  # review, after the trade
    went_well: str = ""
    to_improve: str = ""
    rating: int | None = None  # 1-5: how well did I trade it (not how much I made)
    updated_at: str | None = None

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        for key in ("planned_stop", "planned_target"):
            data[key] = None if data[key] is None else str(data[key])
        return data

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> JournalEntry:
        return parse_entry(data, cls())


def _price(value: Any, label: str) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        price = Decimal(str(value))
    except InvalidOperation as exc:
        raise JournalError(f"{label} must be a price") from exc
    if not price.is_finite() or price <= 0:
        raise JournalError(f"{label} must be above zero")
    return price


def _score(value: Any, label: str) -> int | None:
    if value in (None, ""):
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 5:
        raise JournalError(f"{label} must be a whole number from 1 to 5")
    return value


def _text(value: Any, label: str, limit: int = MAX_TEXT) -> str:
    text = "" if value is None else str(value).strip()
    if len(text) > limit:
        raise JournalError(f"{label} is too long (max {limit} characters)")
    return text


def parse_entry(data: dict[str, Any], base: JournalEntry) -> JournalEntry:
    """Validate the fields present in `data` and apply them on top of `base`."""
    changes: dict[str, Any] = {}
    if "setup" in data:
        changes["setup"] = _text(data["setup"], "Setup", 40) or None
    for key, label in (
        ("thesis", "Reason"),
        ("went_well", "What went well"),
        ("to_improve", "What to improve"),
    ):
        if key in data:
            changes[key] = _text(data[key], label)
    if "planned_stop" in data:
        changes["planned_stop"] = _price(data["planned_stop"], "Planned stop")
    if "planned_target" in data:
        changes["planned_target"] = _price(data["planned_target"], "Planned target")
    if "confidence" in data:
        changes["confidence"] = _score(data["confidence"], "Confidence")
    if "rating" in data:
        changes["rating"] = _score(data["rating"], "Rating")
    if "followed_plan" in data:
        value = data["followed_plan"]
        if value is not None and not isinstance(value, bool):
            raise JournalError("Followed plan must be yes, no or blank")
        changes["followed_plan"] = value
    if "emotions" in data:
        raw = data["emotions"] or []
        if not isinstance(raw, list) or len(raw) > 5:
            raise JournalError("Pick up to 5 emotions")
        changes["emotions"] = [_text(e, "Emotion", 20) for e in raw if str(e).strip()]
    if "updated_at" in data:
        changes["updated_at"] = data["updated_at"]
    return replace(base, **changes)


def r_multiple(trade: Trade, entry: JournalEntry) -> Decimal | None:
    """Profit or loss in units of the risk you planned (needs a planned stop below entry).

    +2R means you made twice what you were prepared to lose; -1R means you lost exactly
    what you planned to risk. Uses net P&L, so brokerage counts.
    """
    if entry.planned_stop is None or trade.exit_quantity == 0:
        return None
    risk_per_share = trade.average_entry - entry.planned_stop
    if risk_per_share <= 0:
        return None
    return trade.net_pnl / (risk_per_share * trade.exit_quantity)


class Journal:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path
        self.entries: dict[str, JournalEntry] = {}  # trade id -> entry
        self.plans: dict[str, JournalEntry] = {}  # order id -> plan written on the ticket
        if path is not None and path.exists():
            self._load(path)

    def _load(self, path: Path) -> None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            self.entries = {
                k: JournalEntry.from_json(v) for k, v in data.get("entries", {}).items()
            }
            self.plans = {k: JournalEntry.from_json(v) for k, v in data.get("plans", {}).items()}
        except (ValueError, KeyError, TypeError) as exc:
            backup = path.with_suffix(f".corrupt-{datetime.now(UTC):%Y%m%d%H%M%S}.json")
            path.rename(backup)
            log.error("Journal couldn't be read (%s); moved it to %s", exc, backup)

    def entry_for(self, trade: Trade) -> JournalEntry:
        """The trade's entry, or the plan written on the order that opened it."""
        if trade.id in self.entries:
            return self.entries[trade.id]
        opening_order = trade.order_ids[0] if trade.order_ids else None
        return self.plans.get(opening_order or "", JournalEntry())

    def attach_plan(self, order_id: str, plan: dict[str, Any]) -> None:
        entry = parse_entry(plan, JournalEntry())
        if entry != JournalEntry():
            self.plans[order_id] = replace(entry, updated_at=_now())
            self.save()

    def update(self, trade: Trade, fields: dict[str, Any]) -> JournalEntry:
        entry = replace(parse_entry(fields, self.entry_for(trade)), updated_at=_now())
        self.entries[trade.id] = entry
        self.save()
        return entry

    def clear(self) -> None:
        self.entries.clear()
        self.plans.clear()
        self.save()

    def save(self) -> None:
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        data = {
            "entries": {k: v.to_json() for k, v in self.entries.items()},
            "plans": {k: v.to_json() for k, v in self.plans.items()},
        }
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        tmp.replace(self._path)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")
