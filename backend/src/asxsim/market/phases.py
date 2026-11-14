"""The phases of an ASX trading day, and which one applies at any moment.

Source: ASX "Equity market phases (Sydney times)", checked 2026-11-14 (see ADR 0005).

    07:00:00            PRE_OPEN          orders queue up; nothing trades
    09:59:00 (+0-15s)   OPENING_AUCTION   one single price auction opens every stock
    09:59:45 (+0-15s)   OPEN              continuous trading
    16:00:00            PRE_CSPA          orders queue up for the close
    16:10:00 (+0-30s)   CLOSING_AUCTION   closing single price auction (CSPA)
    16:11:00            POST_CLOSE
    16:21:30            ADJUST            amend or cancel only
    16:42:00            ADJUST_ON         orders may be entered for the next day
    18:50:00            PURGE_ORDERS      expired (good-for-day) orders are removed
    18:59:00            CLOSED

The random offsets are real: the ASX randomises auction times so nobody can game the
exact second. Here they are drawn from a seeded generator, so a replayed day always has
the same timetable for the same seed.

On early-close days (Christmas Eve, New Year's Eve) the closing auction is at 14:10. We
assume the rest of the afternoon shifts with it (continuous trading ends 14:00, and so
on). ADJUST_ON and later keep their normal clock times.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from enum import StrEnum

from asxsim.market.calendar import SYDNEY, TradingCalendar, asx_calendar


class MarketPhase(StrEnum):
    PRE_OPEN = "pre_open"
    OPENING_AUCTION = "opening_auction"
    OPEN = "open"
    PRE_CSPA = "pre_cspa"
    CLOSING_AUCTION = "closing_auction"
    POST_CLOSE = "post_close"
    ADJUST = "adjust"
    ADJUST_ON = "adjust_on"
    PURGE_ORDERS = "purge_orders"
    CLOSED = "closed"

    @property
    def accepts_new_orders(self) -> bool:
        return self in _ACCEPTS_NEW_ORDERS

    @property
    def allows_cancel(self) -> bool:
        return self in _ALLOWS_CANCEL

    @property
    def matches_continuously(self) -> bool:
        """True only in normal trading, when orders can fill the moment they cross."""
        return self is MarketPhase.OPEN

    @property
    def is_auction(self) -> bool:
        return self in (MarketPhase.OPENING_AUCTION, MarketPhase.CLOSING_AUCTION)


_ACCEPTS_NEW_ORDERS = frozenset(
    {MarketPhase.PRE_OPEN, MarketPhase.OPEN, MarketPhase.PRE_CSPA, MarketPhase.ADJUST_ON}
)
_ALLOWS_CANCEL = _ACCEPTS_NEW_ORDERS | {MarketPhase.ADJUST}


@dataclass(frozen=True, slots=True)
class PhaseWindow:
    phase: MarketPhase
    start: datetime  # inclusive
    end: datetime  # exclusive

    def contains(self, ts: datetime) -> bool:
        return self.start <= ts < self.end


@dataclass(frozen=True, slots=True)
class DaySchedule:
    """The full timetable for one calendar day. Non-trading days have no windows."""

    day: date
    windows: tuple[PhaseWindow, ...]

    @property
    def is_trading_day(self) -> bool:
        return bool(self.windows)

    def _start_of(self, phase: MarketPhase) -> datetime:
        for window in self.windows:
            if window.phase is phase:
                return window.start
        raise ValueError(f"{self.day} is not a trading day")

    @property
    def opening_auction_at(self) -> datetime:
        return self._start_of(MarketPhase.OPENING_AUCTION)

    @property
    def open_at(self) -> datetime:
        """When continuous trading starts (the opening auction has just matched)."""
        return self._start_of(MarketPhase.OPEN)

    @property
    def continuous_end(self) -> datetime:
        return self._start_of(MarketPhase.PRE_CSPA)

    @property
    def closing_auction_at(self) -> datetime:
        return self._start_of(MarketPhase.CLOSING_AUCTION)

    def phase_at(self, ts: datetime) -> MarketPhase:
        if ts.tzinfo is None:
            raise ValueError("phase_at needs a timezone-aware datetime")
        for window in self.windows:
            if window.contains(ts):
                return window.phase
        return MarketPhase.CLOSED


def day_schedule(day: date, seed: int = 0, calendar: TradingCalendar | None = None) -> DaySchedule:
    """Build the phase timetable for `day`, with seeded random auction times."""
    calendar = calendar or asx_calendar()
    if not calendar.is_trading_day(day):
        return DaySchedule(day=day, windows=())

    rng = random.Random(f"{day.isoformat()}:{seed}")

    def at(hh: int, mm: int, ss: int = 0) -> datetime:
        return datetime.combine(day, time(hh, mm, ss), tzinfo=SYDNEY)

    def jitter(max_seconds: float) -> timedelta:
        return timedelta(milliseconds=round(rng.uniform(0, max_seconds) * 1000))

    auction_start = at(9, 59) + jitter(15)
    open_at = at(9, 59, 45) + jitter(15)

    cspa_scheduled = datetime.combine(day, calendar.closing_auction_time(day), tzinfo=SYDNEY)
    shift = cspa_scheduled - at(16, 10)  # 0 normally, -2h on early-close days
    continuous_end = cspa_scheduled - timedelta(minutes=10)
    cspa_at = cspa_scheduled + jitter(30)

    boundaries = [
        (MarketPhase.PRE_OPEN, at(7, 0)),
        (MarketPhase.OPENING_AUCTION, auction_start),
        (MarketPhase.OPEN, open_at),
        (MarketPhase.PRE_CSPA, continuous_end),
        (MarketPhase.CLOSING_AUCTION, cspa_at),
        (MarketPhase.POST_CLOSE, at(16, 11) + shift),
        (MarketPhase.ADJUST, at(16, 21, 30) + shift),
        (MarketPhase.ADJUST_ON, at(16, 42)),
        (MarketPhase.PURGE_ORDERS, at(18, 50)),
    ]
    end_of_day = at(18, 59)
    windows = tuple(
        PhaseWindow(phase, start, boundaries[i + 1][1] if i + 1 < len(boundaries) else end_of_day)
        for i, (phase, start) in enumerate(boundaries)
    )
    return DaySchedule(day=day, windows=windows)


def phase_at(ts: datetime, seed: int = 0, calendar: TradingCalendar | None = None) -> MarketPhase:
    """The market phase at an instant (any timezone; converted to Sydney time)."""
    if ts.tzinfo is None:
        raise ValueError("phase_at needs a timezone-aware datetime")
    local = ts.astimezone(SYDNEY)
    return day_schedule(local.date(), seed, calendar).phase_at(local)
