"""Record 1-minute ASX bars from Yahoo Finance into one Parquet file per trading day.

Why this exists: Yahoo only serves 1-minute history for roughly the last 30 days. Live
trading streams delayed prices directly (ADR 0007), but its charts need earlier days'
intraday history, and so does the secondary past-day replay feature. Running this after
every trading day builds that history up. In production it runs on a schedule inside a
*private* GitHub repo, so recorded data is never published (see docs/adr/0004).

Layout written:  <out>/<YYYY>/<YYYY-MM-DD>.parquet   (date = Sydney trading date)
Columns:         symbol (ASX code), ts (UTC), open, high, low, close, volume

Re-running is safe: each day's file is merged with what is already there, so overlapping
runs never duplicate bars and a missed day can be backfilled (within Yahoo's ~30 day limit).

Usage:
    uv run python -m asxsim.data.recorder --out ../../ASX-sim-data/bars_1m --lookback-days 29
    uv run python -m asxsim.data.recorder --out ./data/bars_1m --symbols BHP CBA
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

from asxsim.data.universe import recording_universe, yahoo_symbol

log = logging.getLogger("asxsim.recorder")

SYDNEY = ZoneInfo("Australia/Sydney")
BAR_COLUMNS = ["symbol", "ts", "open", "high", "low", "close", "volume"]
PRICE_COLUMNS = ["open", "high", "low", "close"]
_YAHOO_FIELDS = {"Open": "open", "High": "high", "Low": "low", "Close": "close", "Volume": "volume"}

# Yahoo's limits for 1-minute bars: ~30 days back in total, and ~8 days per request.
MAX_LOOKBACK_DAYS = 29
MAX_WINDOW_DAYS = 7

# A fetcher takes (yahoo_symbols, start, end) and returns yfinance-shaped wide data.
# Injecting it keeps the recorder testable without touching the network.
Fetcher = Callable[[list[str], datetime, datetime], pd.DataFrame]


@dataclass
class RecordResult:
    rows: int
    files: list[Path] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    failed_windows: int = 0


def empty_bars() -> pd.DataFrame:
    return normalise(pd.DataFrame({c: [] for c in BAR_COLUMNS}))


def normalise(bars: pd.DataFrame) -> pd.DataFrame:
    """Enforce column order and dtypes, drop duplicate bars (newest wins), sort."""
    out = bars.loc[:, BAR_COLUMNS].copy()
    out["symbol"] = out["symbol"].astype(str)
    out["ts"] = pd.to_datetime(out["ts"], utc=True)
    out[PRICE_COLUMNS] = out[PRICE_COLUMNS].astype("float64")
    out["volume"] = out["volume"].fillna(0).astype("int64")
    out = out.drop_duplicates(subset=["symbol", "ts"], keep="last")
    return out.sort_values(["symbol", "ts"], ignore_index=True)


def fetch_windows(
    end: datetime, lookback_days: int, window_days: int = MAX_WINDOW_DAYS
) -> list[tuple[datetime, datetime]]:
    """Split [end - lookback_days, end) into back-to-back windows Yahoo will accept."""
    if not 1 <= lookback_days <= MAX_LOOKBACK_DAYS:
        raise ValueError(f"lookback_days must be 1-{MAX_LOOKBACK_DAYS}, got {lookback_days}")
    windows: list[tuple[datetime, datetime]] = []
    cursor = end - timedelta(days=lookback_days)
    while cursor < end:
        stop = min(cursor + timedelta(days=window_days), end)
        windows.append((cursor, stop))
        cursor = stop
    return windows


def to_long(raw: pd.DataFrame, yahoo_to_code: dict[str, str]) -> pd.DataFrame:
    """Reshape yfinance's wide output (one column group per ticker) into tidy bar rows."""
    if raw.empty:
        return empty_bars()
    if not isinstance(raw.columns, pd.MultiIndex):
        raise ValueError("Expected yfinance output with a (ticker, field) column MultiIndex")
    # With group_by="ticker" tickers sit on column level 0; otherwise fields come first.
    if set(raw.columns.get_level_values(0)) & _YAHOO_FIELDS.keys():
        raw = raw.swaplevel(0, 1, axis=1)

    frames: list[pd.DataFrame] = []
    for ysym in raw.columns.get_level_values(0).unique():
        code = yahoo_to_code.get(str(ysym))
        if code is None:
            log.warning("Ignoring unexpected ticker in Yahoo response: %s", ysym)
            continue
        sub = raw[ysym]
        if not set(_YAHOO_FIELDS) <= set(sub.columns):
            log.warning("Skipping %s: response is missing OHLCV fields", code)
            continue
        sub = sub[list(_YAHOO_FIELDS)].rename(columns=_YAHOO_FIELDS)
        sub = sub.dropna(subset=PRICE_COLUMNS, how="all")
        if sub.empty:
            continue
        index = pd.DatetimeIndex(sub.index)
        if index.tz is None:  # yfinance returns exchange-local times; be defensive anyway
            index = index.tz_localize(SYDNEY)
        frames.append(
            pd.DataFrame(
                {
                    "symbol": code,
                    "ts": index.tz_convert("UTC"),
                    **{col: sub[col].to_numpy() for col in [*PRICE_COLUMNS, "volume"]},
                }
            )
        )
    if not frames:
        return empty_bars()
    return normalise(pd.concat(frames, ignore_index=True))


def write_daily(bars: pd.DataFrame, out_dir: Path) -> list[Path]:
    """Write bars into one Parquet file per Sydney trading date, merging with existing files."""
    written: list[Path] = []
    if bars.empty:
        return written
    days = bars["ts"].dt.tz_convert(SYDNEY).dt.strftime("%Y-%m-%d")
    for day, group in bars.groupby(days, sort=True):
        day_str = str(day)
        path = out_dir / day_str[:4] / f"{day_str}.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        merged = group
        if path.exists():
            # Existing rows first, so freshly fetched bars win on (symbol, ts) clashes.
            merged = pd.concat([pd.read_parquet(path), group], ignore_index=True)
        merged = normalise(merged)
        tmp = path.with_name(path.name + ".tmp")
        merged.to_parquet(tmp, index=False, compression="zstd")
        tmp.replace(path)  # atomic: a crash never leaves a half-written file
        written.append(path)
    return written


_YF_CACHE_DIR = Path(tempfile.gettempdir()) / "asxsim-yfinance"


def yahoo_fetch(symbols: list[str], start: datetime, end: datetime) -> pd.DataFrame:
    """Download 1-minute bars for many tickers in one request via yfinance."""
    import yfinance as yf  # imported lazily so tests never need the network library

    # yfinance's download threads race to create its default cache folder, which on Windows
    # fails with "database is locked" and silently drops tickers. Create our own up front.
    _YF_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    yf.set_tz_cache_location(str(_YF_CACHE_DIR))

    frame: pd.DataFrame = yf.download(
        tickers=symbols,
        start=start,
        end=end,
        interval="1m",
        group_by="ticker",
        auto_adjust=False,  # raw traded prices; corporate actions are applied by the app
        actions=False,
        prepost=False,
        threads=True,
        progress=False,
        multi_level_index=True,
    )
    return frame


def _fetch_with_retries(
    fetch: Fetcher,
    symbols: list[str],
    window: tuple[datetime, datetime],
    attempts: int,
    pause: float,
) -> pd.DataFrame | None:
    start, end = window
    for attempt in range(1, attempts + 1):
        try:
            return fetch(symbols, start, end)
        except Exception as exc:  # yfinance raises many unrelated exception types
            log.warning(
                "Fetch %s..%s failed (attempt %d/%d): %s", start, end, attempt, attempts, exc
            )
            if attempt < attempts:
                time.sleep(pause * 2 ** (attempt - 1))
    return None


def record(
    out_dir: Path,
    lookback_days: int,
    universe: dict[str, str],
    fetch: Fetcher | None = None,
    now: datetime | None = None,
    attempts: int = 3,
    pause: float = 5.0,
) -> RecordResult:
    """Fetch the last `lookback_days` of 1-minute bars for `universe` and store them."""
    fetch = fetch or yahoo_fetch
    now = now or datetime.now(UTC)
    yahoo_to_code = {ysym: code for code, ysym in universe.items()}
    symbols = sorted(yahoo_to_code)

    parts: list[pd.DataFrame] = []
    failed = 0
    for window in fetch_windows(now, lookback_days):
        raw = _fetch_with_retries(fetch, symbols, window, attempts, pause)
        if raw is None:
            failed += 1
            continue
        part = to_long(raw, yahoo_to_code)
        # A bulk request can drop individual tickers (throttling, transient errors). If the
        # window had trading in it, ask again for just the missing ones. Some may genuinely
        # have no data (halted or delisted), which costs one extra small request.
        got = set(part["symbol"])
        retry = [ysym for ysym, code in yahoo_to_code.items() if code not in got]
        if got and retry:
            log.info("Retrying %d symbols missing from this window", len(retry))
            again = _fetch_with_retries(fetch, sorted(retry), window, attempts, pause)
            if again is not None:
                part = pd.concat([part, to_long(again, yahoo_to_code)], ignore_index=True)
        log.info("Window %s..%s: %d bars", window[0].date(), window[1].date(), len(part))
        parts.append(part)

    bars = normalise(pd.concat(parts, ignore_index=True)) if parts else empty_bars()
    files = write_daily(bars, out_dir)
    missing = sorted(set(universe) - set(bars["symbol"].unique()))
    return RecordResult(rows=len(bars), files=files, missing=missing, failed_windows=failed)


def _write_github_summary(result: RecordResult) -> None:
    """When running in GitHub Actions, show a short report on the workflow run page."""
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return
    days = ", ".join(p.stem for p in result.files) or "none"
    missing = ", ".join(result.missing) or "none"
    with open(summary_path, "a", encoding="utf-8") as fh:
        fh.write(
            "## 1-minute bar recording\n\n"
            f"- Bars stored: **{result.rows:,}**\n"
            f"- Trading days written: {days}\n"
            f"- Failed fetch windows: {result.failed_windows}\n"
            f"- Symbols with no data ({len(result.missing)}): {missing}\n"
        )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--out", type=Path, required=True, help="output directory for Parquet")
    parser.add_argument(
        "--lookback-days",
        type=int,
        default=7,
        help=f"how many calendar days back to fetch (1-{MAX_LOOKBACK_DAYS}, default 7)",
    )
    parser.add_argument(
        "--symbols", nargs="*", help="ASX codes to record (default: ASX 200 + benchmarks)"
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    universe = (
        {code: yahoo_symbol(code) for code in args.symbols}
        if args.symbols
        else recording_universe()
    )
    log.info(
        "Recording %d symbols, %d days back, into %s", len(universe), args.lookback_days, args.out
    )

    result = record(args.out, args.lookback_days, universe)
    log.info(
        "Stored %d bars across %d trading days; %d symbols had no data",
        result.rows,
        len(result.files),
        len(result.missing),
    )
    if result.missing:
        log.info("No data for: %s", ", ".join(result.missing))
    _write_github_summary(result)
    return 0 if result.rows > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
