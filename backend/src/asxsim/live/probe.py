"""Diagnose the live feed: how often Yahoo's stream updates, how delayed it is, what it sends.

Run during ASX trading hours (about 10:20am-4:30pm Sydney time with the delay):

    uv run python -m asxsim.live.probe                  # 60s, default stocks
    uv run python -m asxsim.live.probe --seconds 120 BHP CBA PLS
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import time
from collections import defaultdict
from collections.abc import Sequence
from itertools import pairwise
from typing import Any

from asxsim.data.universe import yahoo_symbol

DEFAULT_CODES = ["BHP", "CBA", "CSL", "NAB", "WBC", "ANZ", "FMG", "WDS", "PLS", "XJO"]


async def probe(codes: Sequence[str], seconds: float) -> dict[str, dict[str, Any]]:
    import yfinance as yf

    to_code = {yahoo_symbol(c): c for c in codes}
    arrivals: dict[str, list[float]] = defaultdict(list)
    lags: dict[str, list[float]] = defaultdict(list)
    fields: dict[str, set[str]] = defaultdict(set)
    prices: dict[str, set[float]] = defaultdict(set)

    def handle(message: dict[str, Any]) -> None:
        code = to_code.get(str(message.get("id")))
        if code is None:
            return
        now = time.time()
        arrivals[code].append(now)
        fields[code].update(message)
        if message.get("time"):
            lags[code].append(now - int(message["time"]) / 1000)
        if message.get("price"):
            prices[code].add(float(message["price"]))

    socket = yf.AsyncWebSocket(verbose=False)
    await socket.subscribe(list(to_code))
    try:
        await asyncio.wait_for(socket.listen(handle), timeout=seconds)
    except TimeoutError:
        pass
    finally:
        await socket.close()

    report: dict[str, dict[str, Any]] = {}
    for code in codes:
        times = arrivals.get(code, [])
        gaps = [b - a for a, b in pairwise(times)]
        report[code] = {
            "messages": len(times),
            "median_gap_s": statistics.median(gaps) if gaps else None,
            "median_lag_s": statistics.median(lags[code]) if lags.get(code) else None,
            "distinct_prices": len(prices.get(code, ())),
            "bid_ask": {"bid", "ask"} <= fields.get(code, set()),
            "fields": sorted(fields.get(code, ())),
        }
    return report


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Measure Yahoo's live ASX stream")
    parser.add_argument("codes", nargs="*", default=DEFAULT_CODES, help="ASX codes")
    parser.add_argument("--seconds", type=float, default=60)
    args = parser.parse_args(argv)

    report = asyncio.run(probe([c.upper() for c in args.codes], args.seconds))
    print(f"{'code':6} {'msgs':>5} {'median gap':>11} {'median delay':>13} {'prices':>7}  bid/ask")
    for code, r in report.items():
        gap = "-" if r["median_gap_s"] is None else f"{r['median_gap_s']:.1f}s"
        lag = "-" if r["median_lag_s"] is None else f"{r['median_lag_s'] / 60:.1f} min"
        bid_ask = "yes" if r["bid_ask"] else "no"
        prices = r["distinct_prices"]
        print(f"{code:6} {r['messages']:>5} {gap:>11} {lag:>13} {prices:>7}  {bid_ask}")
    total = sum(r["messages"] for r in report.values())
    print(f"\n{total} messages in {args.seconds:.0f}s")
    seen = sorted(set().union(*(r["fields"] for r in report.values())))
    print("Fields seen:", ", ".join(seen) or "none")


if __name__ == "__main__":
    main()
