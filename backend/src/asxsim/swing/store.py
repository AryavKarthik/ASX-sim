"""Creating, keeping and saving swing-practice sessions.

Sessions are saved beside the simulated account (never in the repository), so a practice
run survives a backend restart. Only the most recent few are kept.
"""

from __future__ import annotations

import json
import random
import uuid
from collections import OrderedDict
from collections.abc import Callable
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from asxsim.swing.session import LOOKBACK_BARS, Bar, SwingError, SwingSession

MAX_SESSIONS = 10
MIN_HISTORY_BARS = 30  # chart context needed before the first practice day
# Large, liquid companies with long price histories: used for "surprise me".
SURPRISE_POOL = (
    "BHP", "CBA", "CSL", "NAB", "WBC", "ANZ", "MQG", "WES", "WOW", "FMG",
    "RIO", "WDS", "TLS", "QBE", "STO", "ALL", "COL", "TCL", "GMG", "SUN",
    "ORG", "AMC", "BXB", "RMD", "COH", "JHX", "ASX", "QAN", "S32", "REA",
)  # fmt: skip
PERIODS = {"3 months": 63, "6 months": 126, "1 year": 252, "2 years": 504}

DailyLoader = Callable[[str, date], list[Bar]]  # (code, before this date) -> daily bars


class SwingStore:
    def __init__(
        self,
        load_daily: DailyLoader,
        names: dict[str, str],
        path: Path | None = None,
        rng: random.Random | None = None,
        today: Callable[[], date] = date.today,
    ) -> None:
        self._load_daily = load_daily
        self._names = names
        self._path = path
        self._rng = rng or random.Random()
        self._today = today
        self._sessions: OrderedDict[str, SwingSession] = OrderedDict()
        if path is not None and path.exists():
            try:
                saved = json.loads(path.read_text(encoding="utf-8"))
                for key, data in saved.items():
                    self._sessions[key] = SwingSession.from_json(data)
            except (OSError, ValueError, KeyError, TypeError):
                self._sessions.clear()  # unreadable: start clean rather than fail to boot

    def create(
        self,
        symbol: str | None,
        start: date | None,
        days: int,
        cash: Decimal,
        blind: bool,
    ) -> tuple[str, SwingSession]:
        """Start a session. `symbol` None picks a surprise stock; `start` None a random date."""
        if not 20 <= days <= 1300:
            raise SwingError("Choose a period between one month and five years")
        if not Decimal("1000") <= cash <= Decimal("10000000"):
            raise SwingError("Starting cash must be between $1,000 and $10,000,000")
        if symbol is None:
            symbol = self._rng.choice([s for s in SURPRISE_POOL if s in self._names])
        elif symbol not in self._names:
            raise SwingError(f"Unknown ASX code {symbol}")
        # Today's bar is still forming (and delayed), so practice only on finished days.
        bars = self._load_daily(symbol, self._today())
        latest_first = len(bars) - 1 - days
        if latest_first < MIN_HISTORY_BARS:
            raise SwingError(
                f"{symbol} doesn't have enough price history for that period. "
                "Try a shorter one or another stock."
            )
        if start is None:
            first = self._rng.randint(MIN_HISTORY_BARS, latest_first)
        else:
            first = next(
                (i for i, bar in enumerate(bars) if bar["date"] >= start.isoformat()), len(bars)
            )
            if first > latest_first:
                last_start = bars[latest_first]["date"]
                raise SwingError(
                    f"That start date leaves less than the chosen period of history. "
                    f"The latest possible start for {symbol} is {last_start}."
                )
            first = max(first, MIN_HISTORY_BARS)
        begin = max(0, first - LOOKBACK_BARS)
        session = SwingSession(
            symbol,
            self._names.get(symbol, symbol),
            bars[begin : first + days + 1],
            first - begin,
            cash,
            blind,
        )
        key = uuid.uuid4().hex
        self._sessions[key] = session
        while len(self._sessions) > MAX_SESSIONS:
            self._sessions.popitem(last=False)
        self.save()
        return key, session

    def get(self, key: str) -> SwingSession:
        session = self._sessions.get(key)
        if session is None:
            raise KeyError(key)
        return session

    def recent(self) -> list[dict[str, Any]]:
        """Saved sessions, newest first, for a "continue" list."""
        rows = []
        for key, s in reversed(self._sessions.items()):
            rows.append(
                {
                    "id": key,
                    "name": "Mystery stock" if s.hidden else f"{s.symbol} · {s.name}",
                    "start_date": None if s.hidden else s.bars[s.first]["date"],
                    "day": s.cursor - s.first,
                    "total_days": len(s.bars) - 1 - s.first,
                    "finished": s.finished,
                    "return_pct": s.summary()["return_pct"],
                }
            )
        return rows

    def save(self) -> None:
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {key: s.to_json() for key, s in self._sessions.items()}
        self._path.write_text(json.dumps(payload), encoding="utf-8")
