from datetime import UTC, date, datetime, time, timedelta
from itertools import pairwise

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from asxsim.market.calendar import SYDNEY
from asxsim.market.phases import MarketPhase, day_schedule, phase_at

FRIDAY = date(2026, 11, 13)
P = MarketPhase


def sydney(day: date, hh: int, mm: int, ss: int = 0) -> datetime:
    return datetime.combine(day, time(hh, mm, ss), tzinfo=SYDNEY)


@pytest.mark.parametrize(
    ("hh", "mm", "expected"),
    [
        (6, 0, P.CLOSED),
        (8, 30, P.PRE_OPEN),
        (10, 30, P.OPEN),
        (15, 59, P.OPEN),
        (16, 5, P.PRE_CSPA),
        (16, 15, P.POST_CLOSE),
        (16, 30, P.ADJUST),
        (17, 0, P.ADJUST_ON),
        (18, 55, P.PURGE_ORDERS),
        (19, 30, P.CLOSED),
    ],
)
def test_phase_at_fixed_times_on_a_normal_day(hh: int, mm: int, expected: MarketPhase) -> None:
    assert phase_at(sydney(FRIDAY, hh, mm)) is expected


def test_auction_times_fall_in_the_asx_random_windows() -> None:
    s = day_schedule(FRIDAY)

    assert sydney(FRIDAY, 9, 59) <= s.opening_auction_at <= sydney(FRIDAY, 9, 59, 15)
    assert sydney(FRIDAY, 9, 59, 45) <= s.open_at <= sydney(FRIDAY, 10, 0)
    assert s.open_at - s.opening_auction_at >= timedelta(seconds=30)  # ASX minimum
    assert s.continuous_end == sydney(FRIDAY, 16, 0)
    assert sydney(FRIDAY, 16, 10) <= s.closing_auction_at <= sydney(FRIDAY, 16, 10, 30)


def test_auction_phases_in_their_windows() -> None:
    s = day_schedule(FRIDAY)

    assert s.phase_at(s.opening_auction_at) is P.OPENING_AUCTION
    assert s.phase_at(s.open_at - timedelta(milliseconds=1)) is P.OPENING_AUCTION
    assert s.phase_at(s.open_at) is P.OPEN
    assert s.phase_at(s.closing_auction_at) is P.CLOSING_AUCTION


def test_same_seed_same_timetable_different_seed_different_timetable() -> None:
    assert day_schedule(FRIDAY, seed=7) == day_schedule(FRIDAY, seed=7)
    opens = {day_schedule(FRIDAY, seed=s).open_at for s in range(10)}
    assert len(opens) > 1


def test_holidays_and_weekends_are_closed_all_day() -> None:
    australia_day = date(2026, 1, 26)
    s = day_schedule(australia_day)

    assert not s.is_trading_day
    assert s.phase_at(sydney(australia_day, 11, 0)) is P.CLOSED
    assert phase_at(sydney(date(2026, 11, 14), 11, 0)) is P.CLOSED  # Saturday
    with pytest.raises(ValueError, match="not a trading day"):
        _ = s.open_at


def test_early_close_on_christmas_eve() -> None:
    eve = date(2026, 12, 24)
    s = day_schedule(eve)

    assert s.phase_at(sydney(eve, 13, 0)) is P.OPEN
    assert s.phase_at(sydney(eve, 14, 5)) is P.PRE_CSPA
    assert sydney(eve, 14, 10) <= s.closing_auction_at <= sydney(eve, 14, 10, 30)
    assert s.phase_at(sydney(eve, 14, 15)) is P.POST_CLOSE
    assert s.phase_at(sydney(eve, 17, 0)) is P.ADJUST_ON


def test_phase_at_accepts_any_timezone() -> None:
    # 10:30 AEDT on 13 Nov 2026 is 23:30 UTC on the 12th.
    assert phase_at(datetime(2026, 11, 12, 23, 30, tzinfo=UTC)) is P.OPEN


def test_phase_at_rejects_naive_datetimes() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        phase_at(datetime(2026, 11, 13, 10, 30))


def test_phase_rules() -> None:
    assert P.OPEN.matches_continuously
    assert not P.PRE_OPEN.matches_continuously
    assert P.PRE_OPEN.accepts_new_orders
    assert not P.CLOSING_AUCTION.accepts_new_orders
    assert P.ADJUST.allows_cancel
    assert not P.ADJUST.accepts_new_orders
    assert {p for p in P if p.is_auction} == {P.OPENING_AUCTION, P.CLOSING_AUCTION}


@settings(max_examples=200, deadline=None)
@given(
    st.dates(min_value=date(2020, 1, 1), max_value=date(2027, 12, 31)),
    st.integers(min_value=0, max_value=10_000),
)
def test_every_trading_day_has_ordered_gapless_phases(day: date, seed: int) -> None:
    s = day_schedule(day, seed)
    if not s.is_trading_day:
        return
    assert [w.phase for w in s.windows][:3] == [P.PRE_OPEN, P.OPENING_AUCTION, P.OPEN]
    for a, b in pairwise(s.windows):
        assert a.end == b.start
    assert all(w.start < w.end for w in s.windows)
