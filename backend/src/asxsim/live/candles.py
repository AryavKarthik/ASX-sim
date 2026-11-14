"""Build 1-minute candles from a stream of price updates."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

import pandas as pd

from asxsim.market.calendar import SYDNEY


def sydney_epoch(moment: datetime) -> int:
    """Epoch seconds of the Sydney wall-clock time (the chart draws timestamps as UTC)."""
    local = moment.astimezone(SYDNEY).replace(tzinfo=None)
    return int((local - datetime(1970, 1, 1)).total_seconds())


@dataclass(slots=True)
class Candle:
    time: datetime  # start of the minute (UTC)
    open: float
    high: float
    low: float
    close: float
    volume: int

    def to_json(self) -> dict[str, float | int]:
        return {
            "time": sydney_epoch(self.time),
            "open": round(self.open, 4),
            "high": round(self.high, 4),
            "low": round(self.low, 4),
            "close": round(self.close, 4),
            "volume": self.volume,
        }


def candles_from_bars(bars: pd.DataFrame) -> list[Candle]:
    """Convert recorder-style bars (ts, open, high, low, close, volume) into candles."""
    return [
        Candle(ts.to_pydatetime(), float(o), float(h), float(lo), float(c), int(v))
        for ts, o, h, lo, c, v in zip(
            pd.DatetimeIndex(bars["ts"]),
            bars["open"],
            bars["high"],
            bars["low"],
            bars["close"],
            bars["volume"],
            strict=True,
        )
    ]


class CandleSeries:
    """1-minute candles for one symbol, updated tick by tick."""

    def __init__(self, candles: Iterable[Candle] = ()) -> None:
        self.candles: list[Candle] = sorted(candles, key=lambda c: c.time)

    def apply(self, price: float, at: datetime, volume: int = 0) -> Candle | None:
        """Fold one trade into the candle for its minute. Returns that candle.

        Trades for a minute that has already closed (late or out-of-order updates) are
        ignored, so a candle never changes after the next one has started.
        """
        minute = at.replace(second=0, microsecond=0)
        last = self.candles[-1] if self.candles else None
        if last is not None and minute < last.time:
            return None
        if last is None or minute > last.time:
            candle = Candle(minute, price, price, price, price, volume)
            self.candles.append(candle)
            return candle
        last.high = max(last.high, price)
        last.low = min(last.low, price)
        last.close = price
        last.volume += volume
        return last
