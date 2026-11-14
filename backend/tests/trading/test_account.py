from datetime import UTC, datetime
from decimal import Decimal as D  # noqa: N817 - short alias keeps money tables readable

import pytest

from asxsim.trading.account import Account
from asxsim.trading.brokerage import Brokerage
from asxsim.trading.orders import Fill, Side

NOW = datetime(2026, 11, 17, 0, 0, tzinfo=UTC)


def fill(side: Side, qty: int, price: str, fee: str = "10.00", symbol: str = "BHP") -> Fill:
    return Fill("O1", symbol, side, qty, D(price), D(fee), NOW, "continuous")


@pytest.mark.parametrize(
    ("brokerage", "value", "fee"),
    [
        (Brokerage(), "5000", "10.00"),
        (Brokerage(flat=D("0"), percent=D("0.0011"), minimum=D("19.95")), "5000", "19.95"),
        (Brokerage(flat=D("0"), percent=D("0.0011"), minimum=D("19.95")), "50000", "55.00"),
        (Brokerage(), "0", "0.00"),
    ],
)
def test_brokerage(brokerage: Brokerage, value: str, fee: str) -> None:
    assert brokerage.fee(D(value)) == D(fee)


def test_buying_and_selling_track_average_cost_and_realised_pnl() -> None:
    account = Account.opened_with(D("10000"))
    account.apply(fill(Side.BUY, 100, "10.00"))
    account.apply(fill(Side.BUY, 100, "11.00"))

    position = account.position("BHP")
    assert position.quantity == 200
    assert position.average_price == D("10.50")
    assert account.cash == D("10000") - D("2100") - D("20")

    account.apply(fill(Side.SELL, 50, "12.00"))

    assert position.quantity == 150
    assert position.realised == D("75.00")  # 50 x (12.00 - 10.50)
    assert position.average_price == D("10.50")  # selling doesn't change average cost
    assert account.fees_paid == D("30.00")


def test_equity_and_unrealised() -> None:
    account = Account.opened_with(D("10000"))
    account.apply(fill(Side.BUY, 100, "10.00"))
    prices = {"BHP": D("10.40")}

    assert account.unrealised(prices) == D("40.00")
    assert account.equity(prices) == D("10000") - D("1000") - D("10") + D("1040")


def test_cannot_sell_more_than_held() -> None:
    account = Account.opened_with(D("10000"))
    with pytest.raises(ValueError, match="only 0 held"):
        account.apply(fill(Side.SELL, 1, "10.00"))


@pytest.mark.parametrize(
    ("price", "text"),
    [("59.2700", "59.27"), ("59.265", "59.265"), ("1.78753333", "1.7875"), ("60", "60.00")],
)
def test_price_text(price: str, text: str) -> None:
    from asxsim.trading.orders import price_text

    assert price_text(D(price)) == text


def test_json_round_trip() -> None:
    account = Account.opened_with(D("10000"))
    account.apply(fill(Side.BUY, 100, "10.00"))

    restored = Account.from_json(account.to_json())

    assert restored == account
