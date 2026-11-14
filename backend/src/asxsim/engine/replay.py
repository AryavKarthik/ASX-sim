"""An intraday replay session: one stock, one past trading day, a clock and a time gate."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

import pandas as pd

from asxsim.engine.clock import ReplayClock
from asxsim.engine.timegate import TimeGate
from asxsim.market.calendar import SYDNEY, TradingCalendar
from asxsim.market.phases import MarketPhase, day_schedule

# Start a few minutes before the opening auction so you see the market wake up, and stop
# once the closing-auction bars (16:10 and 16:11) have finished.
REPLAY_START = time(9, 50)
REPLAY_END = time(16, 15)


@dataclass(frozen=True, slots=True)
class ReplayState:
    symbol: str
    day: date
    now: datetime
    phase: MarketPhase
    speed: float
    playing: bool
    finished: bool
    bars_visible: int
    last_price: float | None
    open_price: float | None


class ReplaySession:
    def __init__(
        self,
        symbol: str,
        day: date,
        bars: pd.DataFrame,
        seed: int = 0,
        calendar: TradingCalendar | None = None,
    ) -> None:
        self.symbol = symbol
        self.day = day
        self.schedule = day_schedule(day, seed, calendar)
        if not self.schedule.is_trading_day:
            raise ValueError(f"{day} is not an ASX trading day")
        self.clock = ReplayClock(
            now=datetime.combine(day, REPLAY_START, tzinfo=SYDNEY),
            end=datetime.combine(day, REPLAY_END, tzinfo=SYDNEY),
        )
        self.gate = TimeGate(bars, self.clock)

    def step(self) -> None:
        """Jump to the next whole minute, i.e. until the next bar finishes."""
        minute = self.clock.now.replace(second=0, microsecond=0)
        self.clock.jump_to(minute + timedelta(minutes=1))

    def state(self) -> ReplayState:
        visible = self.gate.visible()
        has_bars = not visible.empty
        return ReplayState(
            symbol=self.symbol,
            day=self.day,
            now=self.clock.now,
            phase=self.schedule.phase_at(self.clock.now),
            speed=self.clock.speed,
            playing=self.clock.playing,
            finished=self.clock.finished,
            bars_visible=len(visible),
            last_price=float(visible["close"].iloc[-1]) if has_bars else None,
            open_price=float(visible["open"].iloc[0]) if has_bars else None,
        )
