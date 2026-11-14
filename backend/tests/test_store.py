from datetime import date
from pathlib import Path

import pytest

from asxsim.data.store import LocalBarStore, NoDataError
from tests.conftest import TRADING_DAY


def test_lists_recorded_days(bar_store: LocalBarStore, tmp_path: Path) -> None:
    (tmp_path / "2026" / "notes.parquet").write_text("not a day file")  # ignored

    assert bar_store.available_days() == [TRADING_DAY]


def test_symbols_and_bars(bar_store: LocalBarStore) -> None:
    assert bar_store.symbols(TRADING_DAY) == ["BHP", "CBA"]

    bhp = bar_store.bars(TRADING_DAY, "BHP")
    assert len(bhp) == 362
    assert "symbol" not in bhp.columns
    assert bhp["ts"].is_monotonic_increasing


def test_missing_day_or_symbol_raises_no_data(bar_store: LocalBarStore) -> None:
    with pytest.raises(NoDataError, match="No recorded data for 2026-11-12"):
        bar_store.load_day(date(2026, 11, 12))
    with pytest.raises(NoDataError, match="ZZZ"):
        bar_store.bars(TRADING_DAY, "ZZZ")
