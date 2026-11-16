"""Stop, stop-limit and trailing-stop orders, good-till-cancelled, and T+2 settlement."""

from datetime import date, timedelta
from decimal import Decimal as D  # noqa: N817 - short alias keeps price tables readable

import pytest

from asxsim.trading.engine import ExecutionEngine, OrderRejectedError
from asxsim.trading.orders import Order, OrderRequest, OrderStatus, OrderType, Side, TimeInForce
from tests.trading.test_engine import DAY, at, buy, engine

NEXT_DAY = date(2026, 11, 18)


def holding(qty: int = 100) -> ExecutionEngine:
    e = engine()
    e.submit(buy(qty), at(10, 6))  # bought at 59.27; last trade 59.26
    return e


def stop(side: Side, trigger: str, limit: str | None = None, qty: int = 100) -> OrderRequest:
    kind = OrderType.STOP_LIMIT if limit else OrderType.STOP
    return OrderRequest("BHP", side, kind, qty, D(limit) if limit else None, D(trigger))


def trailing(side: Side, amount: str | None = None, percent: str | None = None) -> OrderRequest:
    return OrderRequest(
        "BHP",
        side,
        OrderType.TRAILING_STOP,
        100,
        trail_amount=D(amount) if amount else None,
        trail_percent=D(percent) if percent else None,
    )


def status(e: ExecutionEngine, order: Order) -> OrderStatus:
    return e.orders[order.id].status


# ---------- stops ----------


def test_stop_loss_waits_then_sells_when_the_price_falls_to_the_trigger() -> None:
    e = holding()
    order, fills = e.submit(stop(Side.SELL, "59.00"), at(10, 7))
    assert fills == []
    assert order.status is OrderStatus.PENDING

    assert e.on_tick("BHP", D("59.10"), at(10, 8), 1000) == []
    fills = e.on_tick("BHP", D("58.99"), at(10, 9), 1000)

    assert [(f.quantity, f.price) for f in fills] == [(100, D("58.99"))]  # at the bid
    assert status(e, order) is OrderStatus.FILLED
    assert order.display_type is OrderType.STOP
    assert order.message is not None
    assert "Triggered" in order.message


def test_pending_stop_reserves_the_shares() -> None:
    e = holding()
    e.submit(stop(Side.SELL, "59.00"), at(10, 7))
    with pytest.raises(OrderRejectedError, match="at most 0"):
        e.submit(OrderRequest("BHP", Side.SELL, OrderType.MARKET, 10), at(10, 8))


def test_stop_limit_rests_if_the_price_gaps_past_the_limit() -> None:
    e = holding()
    order, _ = e.submit(stop(Side.SELL, "59.00", limit="58.95"), at(10, 7))

    assert e.on_tick("BHP", D("58.90"), at(10, 8), 1000) == []  # triggered, but below the limit
    assert status(e, order) is OrderStatus.WORKING
    assert order.type is OrderType.LIMIT

    fills = e.on_tick("BHP", D("59.00"), at(10, 9), 1000)  # trades back above the limit
    assert [(f.quantity, f.price) for f in fills] == [(100, D("58.95"))]


def test_buy_stop_buys_a_breakout() -> None:
    e = engine()
    order, _ = e.submit(stop(Side.BUY, "59.50"), at(10, 7))

    fills = e.on_tick("BHP", D("59.55"), at(10, 8), 1000)

    assert fills[0].price == D("59.56")  # at the ask
    assert status(e, order) is OrderStatus.FILLED


@pytest.mark.parametrize(
    ("request_", "message"),
    [
        (stop(Side.SELL, "59.30"), "must be below the current price"),
        (stop(Side.BUY, "59.20"), "must be above the current price"),
        (stop(Side.SELL, "59.005"), "isn't a valid ASX price step"),
        (OrderRequest("BHP", Side.SELL, OrderType.STOP, 100), "Enter a trigger price"),
    ],
)
def test_stop_validation(request_: OrderRequest, message: str) -> None:
    with pytest.raises(OrderRejectedError, match=message):
        holding().submit(request_, at(10, 7))


def test_stops_do_not_trigger_outside_continuous_trading() -> None:
    e = holding()
    order, _ = e.submit(stop(Side.SELL, "59.00"), at(10, 7))

    e.on_tick("BHP", D("58.00"), at(16, 10, 40), 900_000)  # closing auction price

    assert status(e, order) is OrderStatus.PENDING
    e.expire(at(16, 12))
    assert status(e, order) is OrderStatus.EXPIRED
    assert order.message == "Didn't trigger by the close (day order)"


# ---------- trailing stops ----------


def test_trailing_stop_follows_the_price_up_then_triggers() -> None:
    e = holding()
    order, _ = e.submit(trailing(Side.SELL, amount="0.20"), at(10, 7))
    assert order.trigger_price == D("59.06")  # 59.26 - 0.20

    e.on_tick("BHP", D("59.60"), at(10, 8), 1000)
    assert order.trigger_price == D("59.40")  # moved up with the new high
    e.on_tick("BHP", D("59.45"), at(10, 9), 1000)
    assert order.trigger_price == D("59.40")  # never moves down
    assert status(e, order) is OrderStatus.PENDING

    fills = e.on_tick("BHP", D("59.39"), at(10, 10), 1000)

    assert [(f.quantity, f.price) for f in fills] == [(100, D("59.39"))]
    assert order.display_type is OrderType.TRAILING_STOP


def test_a_moving_trail_is_reported_as_a_change() -> None:
    e = holding()
    e.submit(trailing(Side.SELL, amount="0.20"), at(10, 7))
    e.take_changes()

    e.on_tick("BHP", D("59.10"), at(10, 8), 1000)  # lower: trigger stays
    assert not e.take_changes()
    e.on_tick("BHP", D("59.60"), at(10, 9), 1000)  # new high: trigger moves
    assert e.take_changes()
    assert not e.take_changes()  # reported once


def test_trailing_percent_rounds_to_a_valid_price() -> None:
    e = holding()
    order, _ = e.submit(trailing(Side.SELL, percent="1"), at(10, 7))
    assert order.trigger_price == D("58.66")  # 59.26 x 0.99 = 58.6674, rounded down


@pytest.mark.parametrize(
    ("amount", "percent", "message"),
    [
        (None, None, "either a dollar amount or a percentage"),
        ("0.10", "1", "either a dollar amount or a percentage"),
        (None, "60", "between 0% and 50%"),
    ],
)
def test_trailing_validation(amount: str | None, percent: str | None, message: str) -> None:
    with pytest.raises(OrderRejectedError, match=message):
        holding().submit(trailing(Side.SELL, amount, percent), at(10, 7))


# ---------- good till cancelled ----------


def gtc_buy(limit: str) -> OrderRequest:
    return OrderRequest(
        "BHP", Side.BUY, OrderType.LIMIT, 100, D(limit), time_in_force=TimeInForce.GTC
    )


def test_gtc_order_survives_the_close_and_joins_the_next_opening_auction() -> None:
    e = engine()
    order, _ = e.submit(gtc_buy("58.00"), at(10, 6))
    assert order.expires_on == DAY + timedelta(days=30)

    e.on_tick("BHP", D("59.40"), at(16, 10, 40), 900_000)  # doesn't cross in the close
    assert e.expire(at(16, 12)) == []
    assert status(e, order) is OrderStatus.WORKING

    e.expire(at(8, 0, day=NEXT_DAY))  # next morning: rolls into the opening auction
    assert order.session == NEXT_DAY
    assert status(e, order) is OrderStatus.QUEUED

    fills = e.on_tick("BHP", D("57.90"), at(10, 0, 5, day=NEXT_DAY), 300_000)

    assert [(f.price, f.liquidity) for f in fills] == [(D("57.90"), "opening auction")]


def test_gtc_order_expires_after_30_days() -> None:
    e = engine()
    order, _ = e.submit(gtc_buy("58.00"), at(10, 6))

    e.expire(at(10, 0, day=DAY + timedelta(days=31)))

    assert status(e, order) is OrderStatus.EXPIRED
    assert order.message is not None
    assert "30-day limit" in order.message


def test_market_orders_are_day_only() -> None:
    request = OrderRequest("BHP", Side.BUY, OrderType.MARKET, 100, time_in_force=TimeInForce.GTC)
    with pytest.raises(OrderRejectedError, match="day orders"):
        engine().submit(request, at(10, 6))


def test_closing_auction_runs_once_per_day() -> None:
    e = engine()
    order, _ = e.submit(gtc_buy("59.10"), at(10, 6))  # below the 59.27 ask: rests
    e.on_tick("BHP", D("59.40"), at(16, 10, 40), 900_000)  # close at 59.40: doesn't cross

    # A late print below our limit after the close must not rerun the auction.
    assert e.on_tick("BHP", D("59.00"), at(16, 15), 500) == []
    assert status(e, order) is OrderStatus.WORKING


# ---------- T+2 settlement ----------


def test_trades_settle_two_trading_days_later() -> None:
    e = engine()
    _, fills = e.submit(buy(100), at(10, 6))

    assert fills[0].settles_on == date(2026, 11, 19)  # Tuesday -> Thursday
    assert e.account.pending_settlement(DAY) == [(date(2026, 11, 19), D("-5937.00"))]
    assert e.account.settled_cash(DAY) == D("50000")
    assert e.account.settled_cash(date(2026, 11, 19)) == e.account.cash


def test_settlement_skips_weekends_and_holidays() -> None:
    e = engine()
    assert e.settlement_day(date(2026, 11, 20)) == date(2026, 11, 24)  # Fri -> Tue
    assert e.settlement_day(date(2026, 12, 24)) == date(2026, 12, 30)  # over Christmas


# ---------- persistence ----------


def test_conditional_orders_survive_a_restart() -> None:
    e = holding()
    order, _ = e.submit(trailing(Side.SELL, amount="0.20"), at(10, 7))

    restored = ExecutionEngine.from_json(e.to_json())

    again = restored.orders[order.id]
    assert again.to_json() == order.to_json()
    assert restored.account.fills[0].settles_on == date(2026, 11, 19)


def test_accounts_saved_before_these_features_still_load() -> None:
    e = holding()
    data = e.to_json()
    for saved in data["orders"]:
        for key in ("time_in_force", "expires_on", "trigger_price", "conditional"):
            saved.pop(key)
    for fill in data["account"]["fills"]:
        fill.pop("settles_on")

    restored = ExecutionEngine.from_json(data)

    first = next(iter(restored.orders.values()))
    assert first.time_in_force is TimeInForce.DAY
    assert restored.account.fills[0].settles_on is None
    assert restored.account.pending_settlement(DAY) == []
