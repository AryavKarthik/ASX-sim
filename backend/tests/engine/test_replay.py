from datetime import date, datetime, time

import pytest

from asxsim.engine.replay import ReplaySession
from asxsim.market.calendar import SYDNEY
from asxsim.market.phases import MarketPhase
from tests.conftest import TRADING_DAY, day_bars

BHP = day_bars(symbols=("BHP",)).drop(columns="symbol")


def at(hh: int, mm: int) -> datetime:
    return datetime.combine(TRADING_DAY, time(hh, mm), tzinfo=SYDNEY)


def test_starts_paused_in_pre_open_with_no_prices() -> None:
    state = ReplaySession("BHP", TRADING_DAY, BHP).state()

    assert state.now == at(9, 50)
    assert state.phase is MarketPhase.PRE_OPEN
    assert not state.playing
    assert state.bars_visible == 0
    assert state.last_price is None


def test_step_moves_one_whole_minute_and_reveals_bars() -> None:
    session = ReplaySession("BHP", TRADING_DAY, BHP)
    session.clock.jump_to(at(10, 3))
    session.clock.now = session.clock.now.replace(second=20)  # mid-minute

    session.step()

    state = session.state()
    assert state.now == at(10, 4)
    assert state.bars_visible == 4
    assert state.phase is MarketPhase.OPEN
    assert state.open_price == pytest.approx(float(BHP["open"].iloc[0]))
    assert state.last_price == pytest.approx(float(BHP["close"].iloc[3]))


def test_playing_through_the_day_reaches_the_close() -> None:
    session = ReplaySession("BHP", TRADING_DAY, BHP)
    session.clock.set_speed(600)
    session.clock.play()
    session.clock.advance(60)  # 600 market minutes: past the end

    state = session.state()
    assert state.finished
    assert state.bars_visible == len(BHP)


def test_rejects_non_trading_days() -> None:
    with pytest.raises(ValueError, match="not an ASX trading day"):
        ReplaySession("BHP", date(2026, 11, 14), BHP)
