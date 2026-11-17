"""Long-term price history (daily, weekly, monthly bars) for charts.

Daily bars come from Yahoo on demand (cached for an hour). Prices are split-adjusted, as
Yahoo's charts are, but not dividend-adjusted.

Weekly and monthly bars are built here from the daily bars *after* cutting history off at
`until`, never taken from Yahoo directly. Yahoo dates a weekly bar on its Monday, so a demo
replaying a Friday would otherwise get a bar "from Monday" that already contains Friday's
close: the future it is meant to be trading blind.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pandas as pd

from asxsim.data.universe import yahoo_symbol

INTERVALS = ("1d", "1wk", "1mo")
# How far back each interval goes, in days of history sent to the browser.
LOOKBACK_DAYS = {"1d": 3 * 366, "1wk": 15 * 366, "1mo": None}
CACHE_SECONDS = 3600

HistoryFetcher = Callable[[str], pd.DataFrame]  # yahoo symbol -> daily frame
Bar = dict[str, Any]
_cache: dict[str, tuple[float, list[Bar]]] = {}


def yahoo_daily(symbol: str) -> pd.DataFrame:
    import yfinance as yf  # lazy: tests never touch the network

    frame: pd.DataFrame = yf.Ticker(symbol).history(
        period="max", interval="1d", auto_adjust=False, actions=False
    )
    return frame


def to_bars(frame: pd.DataFrame) -> list[Bar]:
    """Yahoo's frame -> chart bars, one per day, timed at 00:00 UTC of the trading date."""
    bars = []
    rows = zip(
        pd.DatetimeIndex(frame.index),
        frame["Open"].astype(float),
        frame["High"].astype(float),
        frame["Low"].astype(float),
        frame["Close"].astype(float),
        frame["Volume"].fillna(0).astype(int),
        strict=True,
    )
    for ts, o, h, lo, c, v in rows:
        if pd.isna(c):
            continue
        day = ts.date()
        bars.append(
            {
                "time": _epoch(day),
                "date": day.isoformat(),
                "open": round(o, 4),
                "high": round(h, 4),
                "low": round(lo, 4),
                "close": round(c, 4),
                "volume": v,
            }
        )
    return bars


def _epoch(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp())


def period_key(day: date, interval: str) -> tuple[int, int]:
    """Which bar a day belongs to: (year, ISO week) for weekly, (year, month) for monthly."""
    if interval == "1wk":
        iso = day.isocalendar()
        return (iso.year, iso.week)
    return (day.year, day.month)


def group(bars: list[Bar], interval: str) -> list[Bar]:
    """Combine daily bars into weekly or monthly ones, dated on their first trading day."""
    out: list[Bar] = []
    last_key: tuple[int, int] | None = None
    for bar in bars:
        key = period_key(date.fromisoformat(bar["date"]), interval)
        if out and key == last_key:
            current = out[-1]
            current["high"] = max(current["high"], bar["high"])
            current["low"] = min(current["low"], bar["low"])
            current["close"] = bar["close"]
            current["volume"] += bar["volume"]
        else:
            out.append(dict(bar))
            last_key = key
    return out


def all_daily(
    code: str,
    until: date | None = None,
    fetch: HistoryFetcher | None = None,
    now: Callable[[], float] = time.monotonic,
) -> list[Bar]:
    """Every daily bar Yahoo has for an ASX code, oldest first, before `until` if given."""
    cached = _cache.get(code)
    if cached is None or now() - cached[0] > CACHE_SECONDS:
        cached = (now(), to_bars((fetch or yahoo_daily)(yahoo_symbol(code))))
        _cache[code] = cached
    daily = cached[1]
    if until is not None:
        daily = [b for b in daily if b["date"] < until.isoformat()]
    return daily


def history(
    code: str,
    interval: str,
    until: date | None = None,
    fetch: HistoryFetcher | None = None,
    now: Callable[[], float] = time.monotonic,
) -> list[Bar]:
    """Bars for an ASX code at `interval` ("1d", "1wk" or "1mo"), oldest first.

    `until` excludes that date and everything after it.
    """
    if interval not in INTERVALS:
        raise ValueError(f"Interval must be one of {', '.join(INTERVALS)}")
    daily = all_daily(code, until, fetch, now)
    lookback = LOOKBACK_DAYS[interval]
    if lookback is not None and daily:
        start = (date.fromisoformat(daily[-1]["date"]) - timedelta(days=lookback)).isoformat()
        daily = [b for b in daily if b["date"] >= start]
    return daily if interval == "1d" else group(daily, interval)


def clear_cache() -> None:
    _cache.clear()
