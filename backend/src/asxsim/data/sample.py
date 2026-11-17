"""Make up a few trading days of 1-minute bars, to try ASX-sim without any market data.

    uv run python -m asxsim.data.sample --out ../../ASX-sim-data/bars_1m

The prices are invented: a seeded random walk around a round starting price for each
stock, with busier trading at the open and close, valid ASX price steps, and the closing
auction prints at 16:10. They look plausible on a chart but are not real, which is the
point. Real prices can't be published (ADR 0004), so sample data is what the README's
screenshots use and what anyone can run the demo on. Files have the same layout as the
recorder's, and the same seed always gives the same days.
"""

from __future__ import annotations

import argparse
import math
import random
from collections.abc import Sequence
from datetime import date, datetime, time, timedelta
from pathlib import Path

import pandas as pd

from asxsim.data.recorder import write_daily
from asxsim.market.calendar import SYDNEY, asx_calendar
from asxsim.market.ticks import Rounding, round_to_tick

# Round starting prices and typical volume per minute. Invented, not quotes.
STOCKS: dict[str, tuple[float, int]] = {
    "BHP": (45.00, 9_000),
    "CBA": (120.00, 3_000),
    "CSL": (250.00, 900),
    "NAB": (35.00, 6_000),
    "WBC": (30.00, 7_000),
    "ANZ": (30.00, 6_500),
    "MQG": (200.00, 800),
    "WES": (70.00, 1_800),
    "WOW": (32.00, 3_500),
    "FMG": (20.00, 9_000),
    "RIO": (115.00, 1_500),
    "WDS": (25.00, 5_000),
    "TLS": (4.00, 30_000),
    "XRO": (150.00, 600),
    "PLS": (3.00, 40_000),
}
INDEX = ("XJO", 8000.0)
MINUTES = 360  # 10:00 to 15:59
MINUTE_VOLATILITY = 0.0006  # about 1.1% a day


def _activity(minute: int) -> float:
    """Trading is busiest at the open and into the close: a U shape across the day."""
    x = minute / (MINUTES - 1)
    return 0.6 + 2.2 * (2 * x - 1) ** 2


def _price(value: float) -> float:
    return float(round_to_tick(max(value, 0.01), Rounding.NEAREST))


def day_bars(day: date, start_prices: dict[str, float], rng: random.Random) -> pd.DataFrame:
    """One day of bars for every stock and the index. Updates `start_prices` to the closes."""
    opened = datetime.combine(day, time(10, 0), tzinfo=SYDNEY)
    rows = []
    market_drift = rng.gauss(0, 0.0004)  # a shared push, so stocks loosely move together
    index_level = start_prices[INDEX[0]]
    for symbol, (_, typical_volume) in STOCKS.items():
        price = start_prices[symbol] * (1 + rng.gauss(0, 0.004))  # overnight gap
        drift = market_drift / MINUTES + rng.gauss(0, 0.00002)
        for minute in range(MINUTES):
            open_ = _price(price)
            price *= math.exp(drift + rng.gauss(0, MINUTE_VOLATILITY))
            close = _price(price)
            wiggle = abs(rng.gauss(0, MINUTE_VOLATILITY / 2)) * price
            high = _price(max(open_, close) + wiggle)
            low = _price(min(open_, close) - wiggle)
            volume = int(typical_volume * _activity(minute) * rng.uniform(0.3, 1.9))
            rows.append(
                (symbol, opened + timedelta(minutes=minute), open_, high, low, close, volume)
            )
        # Closing auction: one big print at 16:10, and a small tail at 16:11.
        auction = _price(price * (1 + rng.gauss(0, 0.001)))
        for offset, share in ((10, 12.0), (11, 0.4)):
            stamp = datetime.combine(day, time(16, offset), tzinfo=SYDNEY)
            volume = int(typical_volume * share * 10)
            rows.append((symbol, stamp, auction, auction, auction, auction, volume))
        start_prices[symbol] = auction

    for minute in range(MINUTES):  # the index: smoother, and it has no volume
        level = index_level
        index_level *= math.exp(market_drift / MINUTES + rng.gauss(0, MINUTE_VOLATILITY / 3))
        stamp = opened + timedelta(minutes=minute)
        rows.append(
            (
                INDEX[0],
                stamp,
                round(level, 1),
                round(max(level, index_level), 1),
                round(min(level, index_level), 1),
                round(index_level, 1),
                0,
            )
        )
    start_prices[INDEX[0]] = index_level

    frame = pd.DataFrame(rows, columns=["symbol", "ts", "open", "high", "low", "close", "volume"])
    frame["ts"] = pd.to_datetime(frame["ts"], utc=True)
    return frame


def generate(out_dir: Path, days: int = 3, seed: int = 7, end: date | None = None) -> list[Path]:
    """Write `days` trading days ending at or before `end` (default: yesterday)."""
    calendar = asx_calendar()
    day = end or (datetime.now(SYDNEY).date() - timedelta(days=1))
    chosen: list[date] = []
    while len(chosen) < days:
        if calendar.is_trading_day(day):
            chosen.append(day)
        day -= timedelta(days=1)
    rng = random.Random(seed)
    prices = {symbol: start for symbol, (start, _) in STOCKS.items()} | {INDEX[0]: INDEX[1]}
    written: list[Path] = []
    for trading_day in reversed(chosen):
        written += write_daily(day_bars(trading_day, prices, rng), out_dir)
    return written


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--out", type=Path, required=True, help="output directory for Parquet")
    parser.add_argument("--days", type=int, default=3, help="how many trading days to make up")
    parser.add_argument("--seed", type=int, default=7, help="same seed, same prices")
    args = parser.parse_args(argv)
    for path in generate(args.out, args.days, args.seed):
        print(f"wrote {path}")
    print("These prices are invented. Open the app and choose 'Try the demo'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
