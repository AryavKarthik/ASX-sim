from datetime import date, datetime, time
from decimal import Decimal as D  # noqa: N817 - short alias keeps price tables readable

import pytest

from asxsim.market.calendar import SYDNEY
from asxsim.trading.account import Account
from asxsim.trading.engine import ExecutionEngine, MarketQuote, OrderRejectedError, touch
from asxsim.trading.orders import OrderRequest, OrderStatus, OrderType, Side

DAY = date(2026, 11, 17)  # Tuesday, a normal trading day


def at(hh: int, mm: int, ss: int = 0, day: date = DAY) -> datetime:
    return datetime.combine(day, time(hh, mm, ss), tzinfo=SYDNEY)


def engine(minute_volume: int | None = 40_000, cash: str = "50000") -> ExecutionEngine:
    e = ExecutionEngine(Account.opened_with(D(cash)))
    e.on_tick("BHP", D("59.26"), at(10, 5), 500, minute_volume=minute_volume)
    return e


def buy(qty: int, limit: str | None = None, symbol: str = "BHP") -> OrderRequest:
    kind = OrderType.LIMIT if limit else OrderType.MARKET
    return OrderRequest(symbol, Side.BUY, kind, qty, D(limit) if limit else None)


def sell(qty: int, limit: str | None = None) -> OrderRequest:
    kind = OrderType.LIMIT if limit else OrderType.MARKET
    return OrderRequest("BHP", Side.SELL, kind, qty, D(limit) if limit else None)


# ---------- bid / ask model ----------


@pytest.mark.parametrize(
    ("last", "bid", "ask"),
    [("59.26", "59.26", "59.27"), ("19.695", "19.69", "19.70"), ("1.995", "1.995", "2.00")],
)
def test_one_tick_spread_around_the_last_trade(last: str, bid: str, ask: str) -> None:
    assert touch(MarketQuote(D(last))) == (D(bid), D(ask))


def test_feed_bid_ask_win_when_provided() -> None:
    assert touch(MarketQuote(D("59.26"), D("59.20"), D("59.30"))) == (D("59.20"), D("59.30"))


# ---------- continuous trading ----------


def test_market_buy_fills_at_the_ask_with_brokerage() -> None:
    e = engine()
    order, fills = e.submit(buy(100), at(10, 6))

    assert order.status is OrderStatus.FILLED
    assert [(f.quantity, f.price, f.fee) for f in fills] == [(100, D("59.27"), D("10.00"))]
    assert e.account.cash == D("50000") - D("5927.00") - D("10.00")
    assert e.account.position("BHP").quantity == 100


def test_big_market_order_fills_partly_then_rests_as_a_limit() -> None:
    e = engine(minute_volume=400)  # only 100 shares (25%) available now
    order, fills = e.submit(buy(300), at(10, 6))

    assert fills[0].quantity == 100
    assert order.status is OrderStatus.WORKING
    assert order.type is OrderType.LIMIT
    assert order.limit_price == D("59.27")

    later = e.on_tick("BHP", D("59.25"), at(10, 7), 1000)  # trades through our limit

    assert [f.quantity for f in later] == [200]  # capacity 250
    assert e.orders[order.id].status is OrderStatus.FILLED
    assert later[0].fee == D("0.00")  # one order, one $10 brokerage
    assert order.fees == D("10.00")


def test_resting_limit_needs_trades_through_or_a_cleared_queue() -> None:
    e = engine()
    order, fills = e.submit(buy(200, "59.20"), at(10, 6))
    assert fills == []
    assert order.status is OrderStatus.WORKING

    assert e.on_tick("BHP", D("59.20"), at(10, 7), 150) == []  # at our price, queue not cleared
    assert e.on_tick("BHP", D("59.24"), at(10, 8), 5000) == []  # above our price
    fills = e.on_tick("BHP", D("59.20"), at(10, 9), 1000)  # 1150 traded at 59.20 >= our 200

    assert [(f.quantity, f.price) for f in fills] == [(200, D("59.20"))]


def test_trade_through_fills_at_the_limit_not_better() -> None:
    e = engine()
    e.submit(buy(100, "59.20"), at(10, 6))

    fills = e.on_tick("BHP", D("59.10"), at(10, 7), 1000)

    assert fills[0].price == D("59.20")


def test_marketable_limit_fills_at_the_ask() -> None:
    e = engine()
    _, fills = e.submit(buy(100, "59.50"), at(10, 6))
    assert fills[0].price == D("59.27")


def test_selling_realises_profit() -> None:
    e = engine()
    e.submit(buy(100), at(10, 6))  # at 59.27
    e.on_tick("BHP", D("59.60"), at(10, 30), 500, minute_volume=40_000)

    _, fills = e.submit(sell(100), at(10, 31))

    assert fills[0].price == D("59.60")  # bid = last trade rounded down
    assert e.account.position("BHP").realised == D("33.00")


# ---------- rules ----------


def test_rejects_prices_off_the_tick_grid() -> None:
    with pytest.raises(OrderRejectedError, match=r"Nearest valid prices: \$59.26 or \$59.27"):
        engine().submit(buy(100, "59.265"), at(10, 6))


def test_no_short_selling() -> None:
    with pytest.raises(OrderRejectedError, match="Short selling isn't enabled"):
        engine().submit(sell(10), at(10, 6))


def test_open_sell_orders_reserve_shares() -> None:
    e = engine()
    e.submit(buy(100), at(10, 6))
    e.submit(sell(60, "60.00"), at(10, 7))
    with pytest.raises(OrderRejectedError, match="at most 40"):
        e.submit(sell(50, "60.10"), at(10, 8))


def test_minimum_first_purchase() -> None:
    with pytest.raises(OrderRejectedError, match="at least \\$500"):
        engine().submit(buy(5), at(10, 6))


def test_buying_power_includes_brokerage_and_open_orders() -> None:
    e = engine(cash="6000")
    with pytest.raises(OrderRejectedError, match="Not enough buying power"):
        e.submit(buy(102), at(10, 6))  # 102 x 59.27 + 10 > 6000

    e.submit(buy(90, "59.00"), at(10, 6))  # rests, reserving about $5,320
    assert e.buying_power() < D("700")
    with pytest.raises(OrderRejectedError, match="Not enough buying power"):
        e.submit(buy(20), at(10, 7))


def test_rejects_orders_while_the_market_is_closed() -> None:
    e = engine()
    with pytest.raises(OrderRejectedError, match="isn't taking orders at 06:00"):
        e.submit(buy(100), at(6, 0))
    with pytest.raises(OrderRejectedError, match="isn't taking orders"):
        e.submit(buy(100), at(11, 0, day=date(2026, 11, 21)))  # Saturday


def test_needs_a_price_first() -> None:
    with pytest.raises(OrderRejectedError, match="No price for CBA"):
        engine().submit(buy(10, symbol="CBA"), at(10, 6))


# ---------- auctions and expiry ----------


def test_pre_open_orders_fill_at_the_opening_auction_price() -> None:
    e = ExecutionEngine(Account.opened_with(D("50000")))
    e.on_tick("BHP", D("58.90"), at(16, 10, day=date(2026, 11, 16)), 0)  # yesterday's close
    order, fills = e.submit(buy(100), at(8, 30))
    assert fills == []
    assert order.status is OrderStatus.QUEUED

    opening = e.on_tick("BHP", D("59.05"), at(10, 0, 5), 250_000)

    assert [(f.quantity, f.price, f.liquidity) for f in opening] == [
        (100, D("59.05"), "opening auction")
    ]


def test_unmatched_pre_open_limit_joins_continuous_trading() -> None:
    e = ExecutionEngine(Account.opened_with(D("50000")))
    e.on_tick("BHP", D("58.90"), at(16, 10, day=date(2026, 11, 16)), 0)
    order, _ = e.submit(buy(100, "58.50"), at(8, 30))

    assert e.on_tick("BHP", D("59.05"), at(10, 0, 5), 250_000) == []
    assert order.status is OrderStatus.WORKING
    assert order.auction is None


def test_pre_close_orders_fill_in_the_closing_auction_and_the_rest_expire() -> None:
    e = engine()
    e.submit(buy(100), at(10, 6))
    queued, _ = e.submit(sell(100), at(16, 5))
    resting, _ = e.submit(buy(50, "50.00"), at(16, 6))
    assert queued.status is OrderStatus.QUEUED

    fills = e.on_tick("BHP", D("59.40"), at(16, 10, 40), 900_000)

    assert [(f.side, f.price, f.liquidity) for f in fills] == [
        (Side.SELL, D("59.40"), "closing auction")
    ]
    assert resting.status is OrderStatus.EXPIRED


def test_day_orders_expire_after_the_close_even_without_a_trade() -> None:
    e = engine()
    order, _ = e.submit(buy(100, "50.00"), at(10, 6))

    assert e.expire(at(15, 0)) == []
    assert e.expire(at(16, 12)) == [order]
    assert order.status is OrderStatus.EXPIRED


def test_orders_after_the_close_wait_for_the_next_trading_day() -> None:
    e = engine()
    order, _ = e.submit(buy(100), at(17, 0))  # Adjust On phase

    assert order.status is OrderStatus.QUEUED
    assert order.session == date(2026, 11, 18)
    assert e.expire(at(17, 30)) == []


# ---------- cancel and persistence ----------


def test_cancel() -> None:
    e = engine()
    order, _ = e.submit(buy(100, "50.00"), at(10, 6))
    e.cancel(order.id, at(10, 7))
    assert order.status is OrderStatus.CANCELLED
    assert e.buying_power() == e.account.cash

    filled, _ = e.submit(buy(100), at(10, 8))
    with pytest.raises(OrderRejectedError, match="already filled"):
        e.cancel(filled.id, at(10, 9))


def test_state_survives_a_restart() -> None:
    e = engine()
    e.submit(buy(100), at(10, 6))
    e.submit(buy(50, "50.00"), at(10, 7))

    restored = ExecutionEngine.from_json(e.to_json())

    assert restored.account == e.account
    assert [o.to_json() for o in restored.orders.values()] == [
        o.to_json() for o in e.orders.values()
    ]
    restored.quotes = e.quotes
    nxt, _ = restored.submit(buy(10, "50.00"), at(10, 8))
    assert nxt.id == "O00003"
