"""Trading halts: orders queue during a halt and match in the reopening auction."""

from decimal import Decimal as D  # noqa: N817

from asxsim.trading.orders import Auction, OrderRequest, OrderStatus, OrderType, Side, TimeInForce
from tests.trading.test_engine import at, buy, engine, sell


def test_market_order_during_a_halt_waits_instead_of_filling_at_a_stale_price() -> None:
    e = engine()
    e.halted = {"BHP"}

    order, fills = e.submit(buy(100), at(11, 0))

    assert fills == []
    assert order.status is OrderStatus.QUEUED
    assert order.auction is Auction.RESUME
    assert "halted" in (order.message or "")


def test_reopening_auction_fills_queued_orders_at_the_reopening_price() -> None:
    e = engine()
    e.halted = {"BHP"}
    market, _ = e.submit(buy(100), at(11, 0))
    cheap, _ = e.submit(buy(100, limit="57.00"), at(11, 1))

    # The stock reopens well above the last price (good news during the halt).
    fills = e.on_tick("BHP", D("61.00"), at(11, 30), 50_000)

    assert [(f.order_id, f.price, f.liquidity) for f in fills] == [
        (market.id, D("61.00"), "reopening auction")
    ]
    assert market.status is OrderStatus.FILLED
    assert cheap.status is OrderStatus.WORKING  # didn't cross: now an ordinary resting limit
    assert cheap.auction is None
    assert "BHP" not in e.halted  # a trade ends the halt


def test_resting_limit_gets_the_reopening_price_not_its_limit() -> None:
    e = engine()
    e.submit(buy(100), at(10, 6))
    resting, _ = e.submit(sell(100, limit="60.00"), at(10, 7))
    e.halted = {"BHP"}

    fills = e.on_tick("BHP", D("61.00"), at(11, 30), 50_000)

    assert [(f.order_id, f.price) for f in fills] == [(resting.id, D("61.00"))]


def test_stops_survive_a_halt_and_trigger_on_the_reopening_trade() -> None:
    e = engine()
    e.submit(buy(100), at(10, 6))
    stop, _ = e.submit(
        OrderRequest("BHP", Side.SELL, OrderType.STOP, 100, trigger_price=D("58.00")), at(10, 7)
    )
    e.halted = {"BHP"}

    fills = e.on_tick("BHP", D("55.00"), at(11, 30), 50_000, minute_volume=50_000)

    # The stop can't protect you through a halt: it sells after the gap, near $55, not at $58.
    assert stop.status is OrderStatus.FILLED
    assert fills[0].price == D("55.00")


def test_other_stocks_trade_normally_during_a_halt() -> None:
    e = engine()
    e.on_tick("CBA", D("170.00"), at(10, 5), 500, minute_volume=40_000)
    e.halted = {"BHP"}

    order, fills = e.submit(buy(10, symbol="CBA"), at(11, 0))

    assert order.status is OrderStatus.FILLED
    assert len(fills) == 1


def test_day_order_queued_in_a_halt_that_lasts_to_the_close_takes_the_closing_auction() -> None:
    e = engine()
    e.halted = {"BHP"}
    order, _ = e.submit(buy(100), at(15, 0))
    gtc, _ = e.submit(
        OrderRequest(
            "BHP", Side.BUY, OrderType.LIMIT, 100, D("50.00"), time_in_force=TimeInForce.GTC
        ),
        at(15, 1),
    )

    fills = e.on_tick("BHP", D("60.00"), at(16, 10, 30), 900_000)

    assert [(f.order_id, f.liquidity) for f in fills] == [(order.id, "closing auction")]
    assert gtc.status is OrderStatus.WORKING
    assert gtc.auction is None
