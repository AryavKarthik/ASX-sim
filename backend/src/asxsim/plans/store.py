"""Saving trade plans from the risk planner.

A plan is a long trade worked out before placing it: the entry, the stop-loss that proves it
wrong, the target, how much of the account to risk, and notes. Plans are saved beside the
simulated account (never in the repository) so they survive a restart.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

MAX_PLANS = 200
MAX_TEXT = 5000
MAX_CHECKLIST = 20


class PlanError(ValueError):
    """A plan that can't be saved, with a message meant for the user."""


def _price(value: Any, label: str, required: bool) -> str | None:
    if value in (None, ""):
        if required:
            raise PlanError(f"Enter the {label}")
        return None
    try:
        number = Decimal(str(value))
    except InvalidOperation as exc:
        raise PlanError(f"The {label} must be a number") from exc
    if not number.is_finite() or number <= 0:
        raise PlanError(f"The {label} must be above zero")
    return str(number)


def clean(raw: dict[str, Any], names: dict[str, str]) -> dict[str, Any]:
    """Check a plan from the browser and keep only the fields we store."""
    symbol = str(raw.get("symbol", "")).strip().upper()
    if symbol not in names:
        raise PlanError(f"Unknown ASX code {symbol or '(blank)'}")
    entry = _price(raw.get("entry"), "entry price", required=True)
    stop = _price(raw.get("stop"), "stop-loss", required=False)
    target = _price(raw.get("target"), "target", required=False)
    assert entry is not None
    if stop is not None and Decimal(stop) >= Decimal(entry):
        raise PlanError("The stop-loss must be below the entry price")
    if target is not None and Decimal(target) <= Decimal(entry):
        raise PlanError("The target must be above the entry price")

    risk_mode = raw.get("risk_mode", "percent")
    if risk_mode not in ("percent", "dollars"):
        raise PlanError("Risk must be a percentage or a dollar amount")
    risk_value = _price(raw.get("risk_value"), "amount to risk", required=False)
    if risk_mode == "percent" and risk_value is not None and Decimal(risk_value) > 100:
        raise PlanError("You can't risk more than 100% of the account")

    shares = raw.get("shares")
    if shares is not None and (
        not isinstance(shares, int) or isinstance(shares, bool) or shares < 0
    ):
        raise PlanError("Shares must be a whole number")

    checklist = []
    for item in raw.get("checklist") or []:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "")).strip()[:200]
        if text:
            checklist.append({"text": text, "done": bool(item.get("done"))})
    if len(checklist) > MAX_CHECKLIST:
        raise PlanError(f"A checklist can have at most {MAX_CHECKLIST} items")

    return {
        "symbol": symbol,
        "title": str(raw.get("title") or "").strip()[:120],
        "setup": str(raw.get("setup") or "").strip()[:60] or None,
        "entry": entry,
        "stop": stop,
        "target": target,
        "risk_mode": risk_mode,
        "risk_value": risk_value,
        "shares": shares,
        "notes": str(raw.get("notes") or "")[:MAX_TEXT],
        "checklist": checklist,
    }


class PlanStore:
    def __init__(self, names: dict[str, str], path: Path | None = None) -> None:
        self._names = names
        self._path = path
        self._plans: dict[str, dict[str, Any]] = {}
        self._last = ""
        if path is not None and path.exists():
            try:
                saved = json.loads(path.read_text(encoding="utf-8"))
                self._plans = {p["id"]: p for p in saved if isinstance(p, dict) and "id" in p}
            except (OSError, ValueError, KeyError, TypeError):
                self._plans = {}  # unreadable: start clean rather than fail to boot

    def list(self) -> list[dict[str, Any]]:
        """All plans, most recently changed first."""
        return sorted(self._plans.values(), key=lambda p: p["updated_at"], reverse=True)

    def create(self, raw: dict[str, Any]) -> dict[str, Any]:
        if len(self._plans) >= MAX_PLANS:
            raise PlanError(f"You have {MAX_PLANS} saved plans. Delete some old ones first.")
        now = self._now()
        plan = {"id": uuid.uuid4().hex, **clean(raw, self._names)}
        plan |= {"created_at": now, "updated_at": now}
        self._plans[plan["id"]] = plan
        self._save()
        return plan

    def update(self, plan_id: str, raw: dict[str, Any]) -> dict[str, Any]:
        old = self._plans.get(plan_id)
        if old is None:
            raise KeyError(plan_id)
        plan = {
            "id": plan_id,
            **clean(raw, self._names),
            "created_at": old["created_at"],
            "updated_at": self._now(),
        }
        self._plans[plan_id] = plan
        self._save()
        return plan

    def delete(self, plan_id: str) -> None:
        if self._plans.pop(plan_id, None) is None:
            raise KeyError(plan_id)
        self._save()

    def _now(self) -> str:
        """The current time, always later than the last one given, so "newest first" is exact
        even when the clock hasn't ticked between two quick saves."""
        now = datetime.now(UTC)
        if self._last and now.isoformat(timespec="microseconds") <= self._last:
            now = datetime.fromisoformat(self._last) + timedelta(microseconds=1)
        self._last = now.isoformat(timespec="microseconds")
        return self._last

    def _save(self) -> None:
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(list(self._plans.values())), encoding="utf-8")
