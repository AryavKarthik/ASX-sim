"""The live market as the simulator sees it: latest quotes, live candles, and a delayed clock.

The *delayed market clock* is wall-clock time minus the measured data delay. With Yahoo's
~20-minute delay, at 10:20 your time the simulated market is at 10:00 and opening. The
delay is measured from the trades themselves (time received minus time traded), so it
adapts if the real delay isn't exactly 20 minutes.
"""

from __future__ import annotations

import statistics
from collections import deque
from dataclasses import dataclass, field
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
        return TickUpdate(tick.symbol, state.quote, candle, live, volume)

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
        schedule = self._schedules.get(market.date())
        if schedule is None:
            schedule = day_schedule(market.date(), calendar=self._calendar)
            self._schedules[market.date()] = schedule
        return schedule.phase_at(market)
