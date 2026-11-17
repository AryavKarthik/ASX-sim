"""Trading halts are inferred from the feed: a busy stock goes quiet while others trade."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

from asxsim.live.hub import LiveHub
from asxsim.live.market import LiveMarket
from asxsim.live.quotes import Tick
from tests.live.test_hub import NoFeed
from tests.live.test_live_api import MARKET_TIME, WALL_CLOCK

OPEN = datetime(2026, 11, 16, 23, 0, tzinfo=UTC)  # Tue 17 Nov, 10:00 Sydney


def busy_market(minutes: int = 30) -> LiveMarket:
    """BHP and CBA both trade every minute from the open; THIN is watched but silent."""
    market = LiveMarket(["BHP", "CBA", "THIN"])
    for i in range(minutes):
        t = OPEN + timedelta(minutes=i, seconds=5)
        for symbol in ("BHP", "CBA"):
            market.on_tick(Tick(symbol, 59.0, t, last_size=100), received_at=t)
    return market


def test_busy_stock_that_goes_quiet_while_others_trade_looks_halted() -> None:
    market = busy_market(30)
    assert market.halted() == set()

    for i in range(30, 47):  # CBA keeps trading for 17 more minutes; BHP prints nothing
        t = OPEN + timedelta(minutes=i, seconds=5)
        market.on_tick(Tick("CBA", 170.0, t, last_size=100), received_at=t)
    assert market.halted() == {"BHP"}

    t = OPEN + timedelta(minutes=50)
    market.on_tick(Tick("BHP", 61.0, t, last_size=5_000), received_at=t)
    assert market.halted() == set()  # its first trade ends the halt


def test_feed_outage_is_not_a_halt() -> None:
    market = busy_market(30)
    # Nothing trades anywhere afterwards: "now" is the last trade seen, so nobody is halted
    # however long the wall clock runs on.
    assert market.halted() == set()


def test_thinly_traded_stock_is_not_flagged() -> None:
    market = busy_market(60)
    t = OPEN + timedelta(minutes=3)
    market.on_tick(Tick("THIN", 0.5, t, last_size=100), received_at=t)  # one trade all morning
    assert "THIN" not in market.halted()


def test_no_halts_outside_continuous_trading() -> None:
    market = busy_market(30)
    close = datetime(2026, 11, 17, 5, 10, 40, tzinfo=UTC)  # 16:10:40 Sydney: closing auction
    market.on_tick(Tick("CBA", 170.0, close, last_size=100), received_at=close)
    assert market.halted() == set()


def test_halted_stock_is_reported_and_orders_wait_for_the_reopening(tmp_path: Path) -> None:
    hub = LiveHub("demo", lambda m: NoFeed(), clock=lambda: WALL_CLOCK, max_live_lag=None)
    hub.market.watch(["BHP", "CBA", "XJO"])
    start = MARKET_TIME - timedelta(minutes=40)
    for i in range(20):  # all trade every minute, then BHP and the index stop
        t = start + timedelta(minutes=i)
        hub.on_tick(Tick("BHP", 59.26, t, last_size=1_000))
        hub.on_tick(Tick("CBA", 170.0, t, last_size=1_000))
        hub.on_tick(Tick("XJO", 8000.0, t, last_size=1))
    for i in range(20, 38):
        hub.on_tick(Tick("CBA", 170.0, start + timedelta(minutes=i), last_size=1_000))

    hub.refresh_halts()
    assert hub.status()["halted"] == ["BHP"]  # an index can't be "halted"

    order = hub.submit({"symbol": "BHP", "side": "buy", "type": "market", "quantity": 100})
    assert order["status"] == "queued"

    hub.on_tick(Tick("BHP", 61.0, MARKET_TIME + timedelta(minutes=5), last_size=20_000))
    assert hub.engine.orders[order["id"]].status.value == "filled"
    assert hub.status()["halted"] == []


def test_the_silence_needed_depends_on_how_busy_the_stock_is() -> None:
    from asxsim.live.market import quiet_needed

    assert quiet_needed(1.0) == timedelta(minutes=15)  # the minimum
    assert quiet_needed(0.9) == timedelta(minutes=15)
    assert timedelta(minutes=26) < quiet_needed(0.5) < timedelta(minutes=27)
    assert quiet_needed(0.2) == timedelta.max  # too thin to judge
