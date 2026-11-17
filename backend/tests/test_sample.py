from datetime import date
from pathlib import Path

from asxsim.data import sample
from asxsim.data.store import LocalBarStore
from asxsim.market.ticks import is_valid_price


def test_sample_days_are_trading_days_in_the_recorders_layout(tmp_path: Path) -> None:
    # Ends on a Sunday: the days chosen must be the Friday, Thursday and Wednesday before.
    sample.generate(tmp_path, days=3, end=date(2026, 11, 15))

    store = LocalBarStore(tmp_path)
    assert store.available_days() == [date(2026, 11, 11), date(2026, 11, 12), date(2026, 11, 13)]
    assert set(store.symbols(date(2026, 11, 13))) == {*sample.STOCKS, "XJO"}


def test_sample_bars_look_like_a_real_session(tmp_path: Path) -> None:
    sample.generate(tmp_path, days=1, end=date(2026, 11, 13))
    bars = LocalBarStore(tmp_path).bars(date(2026, 11, 13), "BHP")

    assert len(bars) == 362  # 360 minutes plus the two closing-auction bars
    assert (bars["high"] >= bars[["open", "close"]].max(axis=1)).all()
    assert (bars["low"] <= bars[["open", "close"]].min(axis=1)).all()
    assert all(is_valid_price(str(p)) for p in bars["close"])  # real ASX price steps
    assert bars["volume"].iloc[0] > bars["volume"].iloc[180]  # busier at the open than midday
    assert 40 < bars["close"].iloc[-1] < 50  # a random walk, not a runaway


def test_the_same_seed_gives_the_same_prices(tmp_path: Path) -> None:
    sample.generate(tmp_path / "a", days=1, seed=3, end=date(2026, 11, 13))
    sample.generate(tmp_path / "b", days=1, seed=3, end=date(2026, 11, 13))
    sample.generate(tmp_path / "c", days=1, seed=4, end=date(2026, 11, 13))

    day = date(2026, 11, 13)
    a, b, c = (LocalBarStore(tmp_path / n).bars(day, "CBA")["close"].tolist() for n in "abc")
    assert a == b
    assert a != c


def test_command_line(tmp_path: Path) -> None:
    assert sample.main(["--out", str(tmp_path), "--days", "1"]) == 0
    assert len(LocalBarStore(tmp_path).available_days()) == 1
