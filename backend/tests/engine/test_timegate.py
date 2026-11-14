from datetime import datetime, time, timedelta

import pandas as pd
import pytest
from hypothesis import given
from hypothesis import strategies as st

from asxsim.engine.clock import ReplayClock
from asxsim.engine.timegate import BAR_LENGTH, TimeGate
from asxsim.market.calendar import SYDNEY
from tests.conftest import TRADING_DAY, day_bars

BHP = day_bars(symbols=("BHP",)).drop(columns="symbol")


def at(hh: int, mm: int, ss: int = 0) -> datetime:
    return datetime.combine(TRADING_DAY, time(hh, mm, ss), tzinfo=SYDNEY)


def gate_at(moment: datetime) -> TimeGate:
    return TimeGate(BHP, ReplayClock(now=moment, end=at(16, 15)))


def test_nothing_visible_before_the_first_bar_finishes() -> None:
    assert gate_at(at(9, 50)).visible().empty
    assert gate_at(at(10, 0, 59)).visible().empty  # the 10:00 bar is still forming


def test_a_bar_appears_the_moment_it_finishes() -> None:
    visible = gate_at(at(10, 1)).visible()

    assert len(visible) == 1
    assert visible["ts"].iloc[0] == pd.Timestamp(at(10, 0))


def test_closing_auction_bar_waits_until_it_ends() -> None:
    assert gate_at(at(16, 10, 30)).visible_count() == 360
    assert gate_at(at(16, 12)).visible_count() == 362


def test_since_returns_only_new_bars() -> None:
    clock = ReplayClock(now=at(10, 5), end=at(16, 15))
    gate = TimeGate(BHP, clock)
    seen = gate.visible_count()

    clock.jump_to(at(10, 8))

    new = gate.since(seen)
    assert len(new) == 3
    assert new["ts"].iloc[0] == pd.Timestamp(at(10, 5))


def test_rejects_unsorted_bars() -> None:
    with pytest.raises(ValueError, match="sorted"):
        TimeGate(BHP.iloc[::-1], ReplayClock(now=at(10, 0), end=at(16, 15)))


@given(st.integers(min_value=0, max_value=7 * 3600 * 1000))
def test_never_reveals_a_bar_that_had_not_finished(offset_ms: int) -> None:
    moment = at(9, 30) + timedelta(milliseconds=offset_ms)
    visible = gate_at(min(moment, at(16, 15))).visible()

    if not visible.empty:
        last_end = visible["ts"].iloc[-1] + BAR_LENGTH
        assert last_end <= pd.Timestamp(min(moment, at(16, 15)))
    # and nothing that *had* finished is withheld
    finished = (BHP["ts"] + BAR_LENGTH <= pd.Timestamp(min(moment, at(16, 15)))).sum()
    assert len(visible) == finished
