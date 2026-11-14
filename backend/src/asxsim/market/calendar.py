"""ASX trading days: weekends, public holidays and early closes.

This wraps the open-source `exchange_calendars` package (its "XASX" calendar) behind a
small interface of our own, so the rest of the app never depends on that library directly
and it could be swapped out without touching callers.
"""

from __future__ import annotations

from datetime import date, time
from functools import cache
from zoneinfo import ZoneInfo

import exchange_calendars as xc
import pandas as pd

SYDNEY = ZoneInfo("Australia/Sydney")

# Normal days: continuous trading ends 16:00 and the closing auction runs at 16:10.
REGULAR_CLOSING_AUCTION = time(16, 10)

# Daily replay is planned back to at least 2020; leave plenty of room either side.
DEFAULT_START = date(2000, 1, 1)


class TradingCalendar:
    """Which days the ASX trades, and when its closing auction happens."""

    def __init__(self, start: date = DEFAULT_START, end: date | None = None) -> None:
        end = end or date(date.today().year + 2, 12, 31)
        self._cal = xc.get_calendar("XASX", start=start.isoformat(), end=end.isoformat())
        self._early_closes = {ts.date() for ts in self._cal.early_closes}
        self.first_day: date = self._cal.first_session.date()
        self.last_day: date = self._cal.last_session.date()

    def _check_range(self, day: date) -> None:
        if not self.first_day <= day <= self.last_day:
            raise ValueError(
                f"{day} is outside the calendar's range ({self.first_day} to {self.last_day})"
            )

    def is_trading_day(self, day: date) -> bool:
        self._check_range(day)
        return bool(self._cal.is_session(day.isoformat()))

    def trading_days(self, start: date, end: date) -> list[date]:
        """All trading days from `start` to `end`, inclusive."""
        self._check_range(start)
        self._check_range(end)
        sessions = self._cal.sessions_in_range(start.isoformat(), end.isoformat())
        return [ts.date() for ts in sessions]

    def next_trading_day(self, day: date) -> date:
        """The first trading day strictly after `day`."""
        self._check_range(day)
        nxt: pd.Timestamp = self._cal.date_to_session(day.isoformat(), direction="next")
        if nxt.date() == day:
            nxt = self._cal.next_session(nxt)
        return nxt.date()

    def previous_trading_day(self, day: date) -> date:
        """The last trading day strictly before `day`."""
        self._check_range(day)
        prev: pd.Timestamp = self._cal.date_to_session(day.isoformat(), direction="previous")
        if prev.date() == day:
            prev = self._cal.previous_session(prev)
        return prev.date()

    def is_early_close(self, day: date) -> bool:
        """Christmas Eve and New Year's Eve close early (closing auction at 14:10)."""
        return self.is_trading_day(day) and day in self._early_closes

    def closing_auction_time(self, day: date) -> time:
        """Scheduled start of the closing single price auction (before its random offset)."""
        if not self.is_trading_day(day):
            raise ValueError(f"{day} is not an ASX trading day")
        if day in self._early_closes:
            close: pd.Timestamp = self._cal.session_close(day.isoformat())
            return close.tz_convert(SYDNEY).time()
        return REGULAR_CLOSING_AUCTION


@cache
def asx_calendar() -> TradingCalendar:
    """A shared calendar instance (building one takes a moment, so reuse it)."""
    return TradingCalendar()
