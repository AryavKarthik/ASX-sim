from datetime import date, time

import pytest

from asxsim.market.calendar import TradingCalendar, asx_calendar


@pytest.fixture(scope="module")
def cal() -> TradingCalendar:
    return asx_calendar()


def test_2026_public_holidays(cal: TradingCalendar) -> None:
    weekdays = [d for d in cal.trading_days(date(2026, 1, 1), date(2026, 12, 31))]
    all_weekdays = {
        date.fromordinal(o)
        for o in range(date(2026, 1, 1).toordinal(), date(2026, 12, 31).toordinal() + 1)
        if date.fromordinal(o).weekday() < 5
    }
    holidays = sorted(all_weekdays - set(weekdays))

    assert holidays == [
        date(2026, 1, 1),  # New Year's Day
        date(2026, 1, 26),  # Australia Day
        date(2026, 4, 3),  # Good Friday
        date(2026, 4, 6),  # Easter Monday
        date(2026, 6, 8),  # King's Birthday
        date(2026, 12, 25),  # Christmas Day
        date(2026, 12, 28),  # Boxing Day falls on a Saturday, observed Monday
    ]


def test_weekends_are_closed(cal: TradingCalendar) -> None:
    assert not cal.is_trading_day(date(2026, 11, 14))  # Saturday
    assert cal.is_trading_day(date(2026, 11, 13))


def test_covid_crash_days_traded(cal: TradingCalendar) -> None:
    assert cal.is_trading_day(date(2020, 3, 16))


def test_next_and_previous_skip_weekends_and_holidays(cal: TradingCalendar) -> None:
    assert cal.next_trading_day(date(2026, 12, 24)) == date(2026, 12, 29)
    assert cal.previous_trading_day(date(2026, 1, 27)) == date(2026, 1, 23)
    assert cal.next_trading_day(date(2026, 11, 14)) == date(2026, 11, 16)  # from a Saturday


def test_trading_days_range_is_inclusive(cal: TradingCalendar) -> None:
    assert len(cal.trading_days(date(2026, 11, 9), date(2026, 11, 13))) == 5


def test_early_closes(cal: TradingCalendar) -> None:
    assert cal.is_early_close(date(2026, 12, 24))
    assert cal.is_early_close(date(2026, 12, 31))
    assert not cal.is_early_close(date(2026, 11, 13))
    assert cal.closing_auction_time(date(2026, 12, 24)) == time(14, 10)
    assert cal.closing_auction_time(date(2026, 11, 13)) == time(16, 10)


def test_closing_auction_time_needs_a_trading_day(cal: TradingCalendar) -> None:
    with pytest.raises(ValueError, match="not an ASX trading day"):
        cal.closing_auction_time(date(2026, 12, 25))


def test_out_of_range_dates_fail_clearly() -> None:
    small = TradingCalendar(start=date(2026, 1, 1), end=date(2026, 12, 31))
    with pytest.raises(ValueError, match="outside the calendar's range"):
        small.is_trading_day(date(2019, 1, 2))
