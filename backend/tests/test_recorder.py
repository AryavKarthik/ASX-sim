from __future__ import annotations

from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from asxsim.data import recorder
from asxsim.data.recorder import (
    BAR_COLUMNS,
    SYDNEY,
    fetch_windows,
    record,
    to_long,
    write_daily,
)

YAHOO_TO_CODE = {"BHP.AX": "BHP", "CBA.AX": "CBA", "^AXJO": "XJO"}


def yahoo_frame(
    symbols: list[str], start_local: str, minutes: int, tickers_first: bool = True
) -> pd.DataFrame:
    """Build a DataFrame shaped like `yfinance.download(..., group_by="ticker")` output."""
    index = pd.date_range(start_local, periods=minutes, freq="1min", tz=SYDNEY, name="Datetime")
    data: dict[tuple[str, str], np.ndarray] = {}
    for i, sym in enumerate(symbols):
        base = 10.0 * (i + 1) + np.arange(minutes) * 0.01
        data[(sym, "Open")] = base
        data[(sym, "High")] = base + 0.05
        data[(sym, "Low")] = base - 0.05
        data[(sym, "Close")] = base + 0.02
        data[(sym, "Adj Close")] = base + 0.02
        data[(sym, "Volume")] = np.full(minutes, 1000.0)
    frame = pd.DataFrame(data, index=index)
    frame.columns = pd.MultiIndex.from_tuples(list(data), names=["Ticker", "Price"])
    return frame if tickers_first else frame.swaplevel(0, 1, axis=1)


def bars(start_local: str, minutes: int, symbols: tuple[str, ...] = ("BHP.AX",)) -> pd.DataFrame:
    return to_long(yahoo_frame(list(symbols), start_local, minutes), YAHOO_TO_CODE)


# ---------- fetch_windows ----------


def test_fetch_windows_cover_range_contiguously_within_yahoo_limit() -> None:
    end = datetime(2026, 11, 14, 8, 30, tzinfo=UTC)
    windows = fetch_windows(end, lookback_days=29)

    assert windows[0][0] == end - timedelta(days=29)
    assert windows[-1][1] == end
    for (_, prev_end), (next_start, _) in pairwise(windows):
        assert prev_end == next_start
    assert all(stop - start <= timedelta(days=7) for start, stop in windows)


@pytest.mark.parametrize("days", [0, 30, -1])
def test_fetch_windows_rejects_lookback_outside_yahoo_range(days: int) -> None:
    with pytest.raises(ValueError, match="lookback_days"):
        fetch_windows(datetime(2026, 11, 14, tzinfo=UTC), lookback_days=days)


# ---------- to_long ----------


def test_to_long_reshapes_to_tidy_utc_bars() -> None:
    raw = yahoo_frame(["BHP.AX", "CBA.AX"], "2026-11-13 10:00", minutes=3)

    out = to_long(raw, YAHOO_TO_CODE)

    assert list(out.columns) == BAR_COLUMNS
    assert len(out) == 6
    assert set(out["symbol"]) == {"BHP", "CBA"}
    # 10:00 in Sydney during daylight saving (AEDT, UTC+11) is 23:00 UTC the day before.
    assert out["ts"].min() == pd.Timestamp("2026-11-12 23:00", tz="UTC")
    assert out["volume"].dtype == "int64"
    assert out["close"].dtype == "float64"


def test_to_long_accepts_fields_first_column_layout() -> None:
    raw = yahoo_frame(["BHP.AX"], "2026-11-13 10:00", minutes=2, tickers_first=False)

    assert len(to_long(raw, YAHOO_TO_CODE)) == 2


def test_to_long_drops_empty_rows_and_unknown_tickers() -> None:
    raw = yahoo_frame(["BHP.AX", "CBA.AX", "ZZZ.AX"], "2026-11-13 10:00", minutes=3)
    # CBA has no trades in the first minute (e.g. a halt): Yahoo returns NaN for that row.
    for fld in ["Open", "High", "Low", "Close", "Volume"]:
        raw.loc[raw.index[0], ("CBA.AX", fld)] = np.nan

    out = to_long(raw, YAHOO_TO_CODE)

    assert (out["symbol"] == "CBA").sum() == 2
    assert "ZZZ" not in set(out["symbol"])


def test_to_long_of_empty_response_is_empty_with_schema() -> None:
    out = to_long(pd.DataFrame(), YAHOO_TO_CODE)

    assert out.empty
    assert list(out.columns) == BAR_COLUMNS


# ---------- write_daily ----------


def test_write_daily_files_bars_under_their_sydney_trading_date(tmp_path: Path) -> None:
    written = write_daily(bars("2026-11-13 10:00", 5), tmp_path)

    assert written == [tmp_path / "2026" / "2026-11-13.parquet"]
    stored = pd.read_parquet(written[0])
    assert len(stored) == 5
    assert list(stored.columns) == BAR_COLUMNS


def test_write_daily_merges_overlapping_runs_without_duplicates(tmp_path: Path) -> None:
    write_daily(bars("2026-11-13 10:00", 3), tmp_path)  # 10:00-10:02
    write_daily(bars("2026-11-13 10:02", 3), tmp_path)  # 10:02-10:04 (one overlapping bar)
    path = write_daily(bars("2026-11-13 10:02", 3), tmp_path)[0]  # exact repeat

    stored = pd.read_parquet(path)
    assert len(stored) == 5
    assert stored["ts"].is_monotonic_increasing


def test_write_daily_ignores_empty_input(tmp_path: Path) -> None:
    assert write_daily(to_long(pd.DataFrame(), YAHOO_TO_CODE), tmp_path) == []


# ---------- record (end to end, fake network) ----------


def test_record_stores_bars_and_reports_missing_symbols(tmp_path: Path) -> None:
    calls: list[tuple[datetime, datetime]] = []

    def fake_fetch(symbols: list[str], start: datetime, end: datetime) -> pd.DataFrame:
        calls.append((start, end))
        available = [s for s in symbols if s in {"BHP.AX", "^AXJO"}]  # CBA has no data
        return (
            yahoo_frame(available, "2026-11-13 10:00", minutes=4) if available else pd.DataFrame()
        )

    result = record(
        tmp_path,
        lookback_days=10,
        universe={"BHP": "BHP.AX", "CBA": "CBA.AX", "XJO": "^AXJO"},
        fetch=fake_fetch,
        now=datetime(2026, 11, 14, 8, 30, tzinfo=UTC),
    )

    # 10 days -> two windows of at most 7 days, each followed by one retry for CBA.
    assert len(calls) == 4
    assert result.rows == 8  # same bars returned by both windows are de-duplicated
    assert result.missing == ["CBA"]
    assert result.failed_windows == 0
    assert [p.name for p in result.files] == ["2026-11-13.parquet"]


def test_record_retries_tickers_dropped_from_a_bulk_request(tmp_path: Path) -> None:
    requests: list[list[str]] = []

    def lossy_fetch(symbols: list[str], start: datetime, end: datetime) -> pd.DataFrame:
        requests.append(symbols)
        # The bulk request silently loses CBA; asking for CBA alone works.
        returned = ["BHP.AX"] if len(symbols) > 1 else symbols
        return yahoo_frame(returned, "2026-11-13 10:00", minutes=3)

    result = record(
        tmp_path,
        lookback_days=1,
        universe={"BHP": "BHP.AX", "CBA": "CBA.AX"},
        fetch=lossy_fetch,
        now=datetime(2026, 11, 14, tzinfo=UTC),
    )

    assert requests == [["BHP.AX", "CBA.AX"], ["CBA.AX"]]
    assert result.missing == []
    assert result.rows == 6


def test_record_does_not_retry_windows_with_no_trading(tmp_path: Path) -> None:
    requests: list[list[str]] = []

    def weekend_fetch(symbols: list[str], start: datetime, end: datetime) -> pd.DataFrame:
        requests.append(symbols)
        return pd.DataFrame()

    result = record(
        tmp_path,
        lookback_days=1,
        universe={"BHP": "BHP.AX"},
        fetch=weekend_fetch,
        now=datetime(2026, 11, 15, tzinfo=UTC),
    )

    assert len(requests) == 1
    assert result.rows == 0


def test_record_continues_when_a_window_keeps_failing(tmp_path: Path) -> None:
    attempts: list[datetime] = []

    def flaky_fetch(symbols: list[str], start: datetime, end: datetime) -> pd.DataFrame:
        attempts.append(start)
        if len(attempts) <= 2:  # the first window fails on both attempts
            raise ConnectionError("Yahoo said no")
        return yahoo_frame(["BHP.AX"], "2026-11-13 10:00", minutes=2)

    result = record(
        tmp_path,
        lookback_days=10,
        universe={"BHP": "BHP.AX"},
        fetch=flaky_fetch,
        now=datetime(2026, 11, 14, tzinfo=UTC),
        attempts=2,
        pause=0,
    )

    assert result.failed_windows == 1
    assert result.rows == 2


# ---------- main (CLI) ----------


def test_main_succeeds_and_writes_github_summary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    monkeypatch.setattr(
        recorder,
        "yahoo_fetch",
        lambda symbols, start, end: yahoo_frame(["BHP.AX"], "2026-11-13 10:00", minutes=3),
    )

    code = recorder.main(
        ["--out", str(tmp_path / "bars"), "--lookback-days", "1", "--symbols", "BHP"]
    )

    assert code == 0
    assert "Bars stored: **3**" in summary.read_text(encoding="utf-8")


def test_main_fails_when_nothing_was_recorded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    monkeypatch.setattr(recorder, "yahoo_fetch", lambda symbols, start, end: pd.DataFrame())

    code = recorder.main(["--out", str(tmp_path), "--lookback-days", "1", "--symbols", "BHP"])

    assert code == 1
