"""The time gate: the only way to see market data during a replay.

A 1-minute bar labelled 10:30 covers trades from 10:30:00 to 10:30:59. Its high, low and
close aren't known until 10:31:00, so the gate releases a bar only once the replay clock
has passed the bar's *end*. Nothing in the app (chart, order engine, or later the AI coach)
reads replay data except through a gate, so "no peeking at the future" is enforced in one
place instead of being something every feature has to remember.
"""

from __future__ import annotations

from datetime import timedelta

import numpy as np
import pandas as pd

from asxsim.engine.clock import ReplayClock

BAR_LENGTH = timedelta(minutes=1)


class TimeGate:
    """Releases bars from `bars` (sorted by `ts`) as the clock passes the end of each one."""

    def __init__(self, bars: pd.DataFrame, clock: ReplayClock) -> None:
        if not bars["ts"].is_monotonic_increasing:
            raise ValueError("TimeGate needs bars sorted by time")
        self._bars = bars.reset_index(drop=True)
        # Compare in one explicit unit. pandas 3 may store times in microseconds while a
        # Timestamp's .value is nanoseconds; mixing them silently revealed every bar.
        ends = pd.DatetimeIndex(bars["ts"]).as_unit("ns") + BAR_LENGTH
        self._ends_ns = ends.asi8
        self._clock = clock

    def visible_count(self) -> int:
        """How many bars have finished by the clock's current time."""
        now_ns = pd.Timestamp(self._clock.now).as_unit("ns").value
        return int(np.searchsorted(self._ends_ns, now_ns, side="right"))

    def visible(self) -> pd.DataFrame:
        """Every bar that has finished by now. Never includes a bar still in progress."""
        return self._bars.iloc[: self.visible_count()]

    def since(self, already_seen: int) -> pd.DataFrame:
        """Bars that became visible after the first `already_seen` ones."""
        return self._bars.iloc[already_seen : self.visible_count()]
