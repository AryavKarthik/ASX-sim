"""The live market as the simulator sees it: latest quotes, live candles, and a delayed clock.

The *delayed market clock* is wall-clock time minus the measured data delay. With Yahoo's
~20-minute delay, at 10:20 your time the simulated market is at 10:00 and opening. The
delay is measured from the trades themselves (time received minus time traded), so it
adapts if the real delay isn't exactly 20 minutes.
"""

from __future__ import annotations

import math
import statistics
from collections import deque
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta

from asxsim.live.candles import Candle, CandleSeries
from asxsim.live.quotes import Tick
from asxsim.market.calendar import SYDNEY, TradingCalendar
from asxsim.market.phases import DaySchedule, MarketPhase, day_schedule

DEFAULT_DELAY = timedelta(minutes=20)  # used until enough trades have been seen to measure it
DELAY_SAMPLES = 50
# On subscribing, Yahoo sends each symbol's last known price, which outside trading hours can
# be days old. Anything older than this is a snapshot of the last close, not a live trade:
# it updates the quote but doesn't count toward the delay or mean prices are streaming.
MAX_LIVE_LAG = timedelta(hours=1)
# Trading halts aren't published in the feed, so they are inferred: a stock goes silent for
# far longer than its own trading rhythm makes plausible, while other stocks keep trading in
# continuous trading (ADR 0009).
HALT_QUIET = timedelta(minutes=15)  # never flag a gap shorter than this
HALT_MIN_CANDLES = 15  # needs this much of today's history to know the stock's rhythm
HALT_MIN_ACTIVITY = 0.3  # stocks trading in fewer minutes than this are too thin to judge
HALT_CHANCE = 1e-8  # flag a gap only if chance alone would produce it less often than this


def quiet_needed(activity: float) -> timedelta:
    """How long a silence must last before it looks like a halt rather than a lull.

    `activity` is the share of minutes the stock has traded in today. If it trades in a
    minute with probability p, n silent minutes in a row happen by chance with probability
    (1 - p)^n; the gap must be long enough to push that below HALT_CHANCE. A stock trading
    in 90% of minutes only needs the 15-minute minimum; one trading half the time needs 27.
    """
    if activity < HALT_MIN_ACTIVITY:
        return timedelta.max
    if activity >= 1:
        return HALT_QUIET
    minutes = math.log(HALT_CHANCE) / math.log(1 - activity)
    return max(HALT_QUIET, timedelta(minutes=minutes))


@dataclass
class SymbolState:
    quote: Tick | None = None
    candles: CandleSeries = field(default_factory=CandleSeries)
    last_day_volume: int | None = None


@dataclass(frozen=True, slots=True)
class TickUpdate:
    symbol: str
    quote: Tick
    candle: Candle | None  # the candle this trade landed in (None if it arrived too late)
    live: bool  # False for stale snapshots (e.g. last Friday's close sent on a weekend)
    volume: int = 0  # shares traded in this update


class LiveMarket:
    def __init__(
        self,
        symbols: list[str],
        calendar: TradingCalendar | None = None,
        default_delay: timedelta = DEFAULT_DELAY,
        max_live_lag: timedelta | None = MAX_LIVE_LAG,  # None: trust every lag (demo replays)
    ) -> None:
        self._states = {symbol: SymbolState() for symbol in symbols}
        self._max_live_lag = max_live_lag
        self._lags: deque[timedelta] = deque(maxlen=DELAY_SAMPLES)
        self._calendar = calendar
        self._default_delay = default_delay
        self._schedules: dict[date, DaySchedule] = {}

    @property
    def symbols(self) -> list[str]:
        return list(self._states)

    def watch(self, symbols: list[str]) -> list[str]:
        """Start tracking more symbols. Returns the ones that are new."""
        new = [s for s in symbols if s not in self._states]
        for symbol in new:
            self._states[symbol] = SymbolState()
        return new

    def previous_minute_volume(self, symbol: str, at: datetime) -> int | None:
        """A liquidity estimate: shares traded in about the last minute before `at`.

        The larger of the previous completed minute and the current minute so far, so a
        quiet or unknown previous minute doesn't hide trading that is happening now.
        """
        candles = self._states[symbol].candles.candles
        minute = at.replace(second=0, microsecond=0)
        current = 0
        for candle in reversed(candles):
            if candle.time == minute:
                current = candle.volume
            elif candle.time < minute:
                return max(candle.volume, current)
        return current if current else None

    def seed_candles(self, symbol: str, candles: list[Candle]) -> None:
        """Load earlier candles (e.g. today's session so far) before live updates arrive."""
        self._states[symbol].candles = CandleSeries(candles)

    def quote(self, symbol: str) -> Tick | None:
        return self._states[symbol].quote

    def candles(self, symbol: str) -> list[Candle]:
        return self._states[symbol].candles.candles

    def on_tick(self, tick: Tick, received_at: datetime) -> TickUpdate | None:
        """Apply one price update. Returns what changed, or None for unwatched symbols."""
        state = self._states.get(tick.symbol)
        if state is None:
            return None
        lag = received_at - tick.time
        live = self._max_live_lag is None or lag <= self._max_live_lag
        if live:
            self._lags.append(lag)

        # Volume traded since the previous update: from the running day total when we have
        # two in a row, otherwise the size of this trade.
        if tick.day_volume is not None and state.last_day_volume is not None:
            volume = max(0, tick.day_volume - state.last_day_volume)
        else:
            volume = tick.last_size or 0
        if tick.day_volume is not None:
            state.last_day_volume = tick.day_volume

        state.quote = tick.filled_from(state.quote)
        candle = state.candles.apply(tick.price, tick.time, volume)
        state.quote = self._with_session_stats(tick, state.quote, state.candles.candles)
        return TickUpdate(tick.symbol, state.quote, candle, live, volume)

    @staticmethod
    def _with_session_stats(tick: Tick, quote: Tick, candles: list[Candle]) -> Tick:
        """Fill the open and day high/low from today's candles when the feed didn't send them.

        Yahoo's ASX stream omits these fields; a value carried over from an earlier quote
        could belong to a previous day, so today's candles are the reliable source.
        """
        if tick.open_price is not None and tick.day_high is not None and tick.day_low is not None:
            return quote
        day = tick.time.astimezone(SYDNEY).date()
        session = [c for c in candles if c.time.astimezone(SYDNEY).date() == day]
        if not session:
            return quote
        return replace(
            quote,
            open_price=tick.open_price or session[0].open,
            day_high=tick.day_high or max(c.high for c in session),
            day_low=tick.day_low or min(c.low for c in session),
        )

    def halted(self) -> set[str]:
        """Symbols that look halted right now (see HALT_QUIET).

        "Now" is the most recent trade in any watched symbol, not the wall clock, so a feed
        outage (nothing trading anywhere) never looks like a halt, and demos replayed at
        any speed behave the same.
        """
        times = [s.quote.time for s in self._states.values() if s.quote is not None]
        if not times:
            return set()
        latest = max(times)
        local = latest.astimezone(SYDNEY)
        if self._schedule(local.date()).phase_at(local) is not MarketPhase.OPEN:
            return set()
        halted = set()
        for symbol, state in self._states.items():
            if state.quote is None or latest - state.quote.time < HALT_QUIET:
                continue
            today = [
                c for c in state.candles.candles if c.time.astimezone(SYDNEY).date() == local.date()
            ]
            if len(today) < HALT_MIN_CANDLES:
                continue
            span = (today[-1].time - today[0].time).total_seconds() / 60 + 1
            if latest - state.quote.time >= quiet_needed(len(today) / span):
                halted.add(symbol)
        return halted

    def _schedule(self, day: date) -> DaySchedule:
        schedule = self._schedules.get(day)
        if schedule is None:
            schedule = day_schedule(day, calendar=self._calendar)
            self._schedules[day] = schedule
        return schedule

    @property
    def measured_delay(self) -> timedelta | None:
        """Median lag between a trade happening and us receiving it (None until measured)."""
        if not self._lags:
            return None
        return timedelta(seconds=statistics.median(lag.total_seconds() for lag in self._lags))

    def market_now(self, now: datetime) -> datetime:
        """The delayed market clock: what time it is in the market we're seeing."""
        return now - (self.measured_delay or self._default_delay)

    def phase_at(self, now: datetime) -> MarketPhase:
        market = self.market_now(now).astimezone(SYDNEY)
        return self._schedule(market.date()).phase_at(market)
