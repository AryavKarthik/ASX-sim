from datetime import UTC, datetime, timedelta

from asxsim.live.candles import Candle
from asxsim.live.market import DEFAULT_DELAY, LiveMarket
from asxsim.live.quotes import Tick
from asxsim.market.phases import MarketPhase

# Tue 17 Nov 2026, 10:30 Sydney (AEDT) = 23:30 UTC on the 16th.
TRADE = datetime(2026, 11, 16, 23, 30, tzinfo=UTC)


def tick(price: float, at: datetime, **kw: object) -> Tick:
    return Tick("BHP", price, at, **kw)  # type: ignore[arg-type]


def test_measures_the_delay_from_trade_timestamps() -> None:
    market = LiveMarket(["BHP"])
    assert market.measured_delay is None
    assert market.market_now(TRADE) == TRADE - DEFAULT_DELAY

    for i, lag in enumerate([1201, 1199, 1203]):  # about 20 minutes
        at = TRADE + timedelta(seconds=i)
        market.on_tick(tick(59.0, at), received_at=at + timedelta(seconds=lag))

    assert market.measured_delay == timedelta(seconds=1201)


def test_market_clock_and_phase_follow_the_delay() -> None:
    market = LiveMarket(["BHP"])
    received = TRADE + timedelta(minutes=20)
    market.on_tick(tick(59.0, TRADE), received_at=received)

    assert market.market_now(received) == TRADE
    assert market.phase_at(received) is MarketPhase.OPEN
    # At 10:15 your time the delayed market is still in pre-open (09:55).
    early = datetime(2026, 11, 16, 23, 15, tzinfo=UTC)
    assert market.phase_at(early) is MarketPhase.PRE_OPEN


def test_volume_comes_from_the_running_day_total() -> None:
    market = LiveMarket(["BHP"])
    market.on_tick(tick(59.0, TRADE, day_volume=1000, last_size=40), TRADE)
    update = market.on_tick(tick(59.1, TRADE + timedelta(seconds=5), day_volume=1300), TRADE)

    assert update is not None
    assert update.candle is not None
    assert update.candle.volume == 40 + 300


def test_ticks_extend_seeded_history() -> None:
    market = LiveMarket(["BHP"])
    minute = TRADE.replace(second=0)
    market.seed_candles("BHP", [Candle(minute - timedelta(minutes=1), 58, 59, 57, 58.5, 900)])

    market.on_tick(tick(58.7, TRADE + timedelta(seconds=10)), TRADE)

    assert [c.time for c in market.candles("BHP")] == [minute - timedelta(minutes=1), minute]


def test_stale_snapshots_update_the_quote_but_not_the_clock() -> None:
    # On a Saturday, Yahoo sends Friday's closing price when you subscribe.
    market = LiveMarket(["BHP"])
    saturday = TRADE + timedelta(days=4, hours=-10)

    update = market.on_tick(tick(58.86, TRADE), received_at=saturday)

    assert update is not None
    assert not update.live
    assert market.quote("BHP") is not None
    assert market.measured_delay is None  # still using the 20-minute default
    assert market.market_now(saturday) == saturday - DEFAULT_DELAY


def test_demo_markets_trust_any_lag() -> None:
    market = LiveMarket(["BHP"], max_live_lag=None)
    much_later = TRADE + timedelta(days=2)

    update = market.on_tick(tick(59.0, TRADE), received_at=much_later)

    assert update is not None
    assert update.live
    assert market.market_now(much_later) == TRADE


def test_liquidity_estimate_uses_the_busier_of_last_and_current_minute() -> None:
    market = LiveMarket(["BHP"])
    minute = TRADE.replace(second=0)
    market.seed_candles("BHP", [Candle(minute - timedelta(minutes=1), 59, 59, 59, 59, 800)])
    assert market.previous_minute_volume("BHP", TRADE) == 800

    market.on_tick(tick(59.0, TRADE + timedelta(seconds=5), last_size=5000), TRADE)
    assert market.previous_minute_volume("BHP", TRADE + timedelta(seconds=10)) == 5000
    assert LiveMarket(["BHP"]).previous_minute_volume("BHP", TRADE) is None


def test_open_and_day_range_come_from_todays_candles_when_missing() -> None:
    market = LiveMarket(["BHP"])
    minute = TRADE.replace(second=0)
    yesterday = Candle(minute - timedelta(days=1), 70, 75, 65, 70, 1)
    today = Candle(minute - timedelta(minutes=2), 58.0, 58.6, 57.9, 58.4, 10)
    market.seed_candles("BHP", [yesterday, today])

    update = market.on_tick(tick(57.5, TRADE), TRADE)

    assert update is not None
    assert update.quote.open_price == 58.0
    assert update.quote.day_high == 58.6
    assert update.quote.day_low == 57.5  # today's new low, from this trade


def test_ignores_symbols_not_on_the_watchlist() -> None:
    market = LiveMarket(["BHP"])
    assert market.on_tick(Tick("CBA", 150.0, TRADE), TRADE) is None
