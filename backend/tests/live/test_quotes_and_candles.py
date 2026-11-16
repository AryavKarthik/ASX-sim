from datetime import UTC, datetime, timedelta

from asxsim.live.candles import Candle, CandleSeries, sydney_epoch
from asxsim.live.quotes import Tick, parse_yahoo_message

Y2C = {"BHP.AX": "BHP", "^AXJO": "XJO"}
T0 = datetime(2026, 11, 16, 23, 0, 5, tzinfo=UTC)  # 10:00:05 Sydney on Tue 17 Nov


def test_parses_a_yahoo_stream_message() -> None:
    message = {
        "id": "BHP.AX",
        "price": 59.31,
        "time": str(int(T0.timestamp() * 1000)),  # 64-bit ints arrive as strings
        "day_volume": "1250000",
        "previous_close": 58.9,
        "open_price": 59.1,
        "bid": 0,  # protobuf zero means "not provided"
    }

    tick = parse_yahoo_message(message, Y2C)

    assert tick is not None
    assert tick.symbol == "BHP"
    assert tick.price == 59.31
    assert tick.time == T0
    assert tick.day_volume == 1_250_000
    assert tick.previous_close == 58.9
    assert tick.bid is None


def test_previous_close_is_recovered_from_change_when_yahoo_omits_it() -> None:
    # The real shape of an ASX message from Yahoo's stream (16 Nov 2026): no previous_close.
    message = {
        "id": "BHP.AX",
        "price": 57.58,
        "time": str(int(T0.timestamp() * 1000)),
        "change": -0.42,
    }

    tick = parse_yahoo_message(message, Y2C)

    assert tick is not None
    assert tick.previous_close == 58.0


def test_ignores_unusable_messages() -> None:
    assert parse_yahoo_message({"id": "ZZZ.AX", "price": 1, "time": "1"}, Y2C) is None
    assert parse_yahoo_message({"id": "BHP.AX", "time": "1"}, Y2C) is None  # no price
    assert parse_yahoo_message({"error": "decode failed"}, Y2C) is None


def test_missing_fields_are_carried_over_from_the_previous_quote() -> None:
    first = Tick("BHP", 59.0, T0, previous_close=58.9, day_high=59.2)
    second = Tick("BHP", 59.3, T0 + timedelta(seconds=3), day_high=59.3)

    merged = second.filled_from(first)

    assert merged.previous_close == 58.9
    assert merged.day_high == 59.3  # new values win


def test_candles_build_minute_by_minute() -> None:
    series = CandleSeries()
    series.apply(59.0, T0, 100)
    series.apply(59.4, T0 + timedelta(seconds=20), 50)
    series.apply(58.8, T0 + timedelta(seconds=40), 25)
    nxt = series.apply(58.9, T0 + timedelta(seconds=60), 10)

    first = series.candles[0]
    assert (first.open, first.high, first.low, first.close, first.volume) == (
        59.0,
        59.4,
        58.8,
        58.8,
        175,
    )
    assert nxt is not None
    assert nxt.time == T0.replace(second=0) + timedelta(minutes=1)
    assert len(series.candles) == 2


def test_late_trades_never_rewrite_a_closed_candle() -> None:
    series = CandleSeries()
    series.apply(59.0, T0 + timedelta(minutes=1), 10)

    assert series.apply(70.0, T0, 10) is None
    assert series.candles[-1].high == 59.0


def test_chart_time_is_sydney_wall_clock() -> None:
    # 23:00 UTC on 16 Nov is 10:00 in Sydney (AEDT) on 17 Nov.
    candle = Candle(T0.replace(second=0), 1, 1, 1, 1, 0)
    assert candle.to_json()["time"] == sydney_epoch(T0.replace(second=0))
    assert sydney_epoch(T0.replace(second=0)) == int(
        datetime(2026, 11, 17, 10, 0, tzinfo=UTC).timestamp()
    )
