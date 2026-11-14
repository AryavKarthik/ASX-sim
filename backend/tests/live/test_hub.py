from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from asxsim.live.hub import LiveHub, load_engine, parse_order
from asxsim.live.quotes import Tick
from asxsim.trading.engine import OrderRejectedError
from asxsim.trading.orders import OrderType, Side
from tests.live.test_live_api import MARKET_TIME, WALL_CLOCK


class NoFeed:
    name = "none"

    async def stream(self, symbols: Sequence[str]) -> AsyncIterator[Tick]:
        return
        yield  # pragma: no cover


def make_hub(tmp_path: Path) -> LiveHub:
    return LiveHub(
        "live", lambda m: NoFeed(), state_path=tmp_path / "acct.json", clock=lambda: WALL_CLOCK
    )


def prime(hub: LiveHub) -> None:
    hub.market.watch(["BHP"])
    hub.on_tick(Tick("BHP", 59.20, MARKET_TIME - timedelta(minutes=1), day_volume=40_000))
    hub.on_tick(Tick("BHP", 59.26, MARKET_TIME - timedelta(seconds=5), day_volume=41_000))


def test_stale_snapshot_never_fills_a_resting_order(tmp_path: Path) -> None:
    hub = make_hub(tmp_path)
    prime(hub)
    order = hub.submit(
        {"symbol": "BHP", "side": "buy", "type": "limit", "quantity": 100, "limit_price": "59.00"}
    )

    # Yesterday's low (an hours-old price) arrives as a snapshot: must not fill us.
    hub.on_tick(Tick("BHP", 58.50, MARKET_TIME - timedelta(hours=20), day_volume=900_000))

    assert hub.engine.orders[order["id"]].status.value == "working"


def test_live_trade_through_fills_and_is_saved(tmp_path: Path) -> None:
    hub = make_hub(tmp_path)
    prime(hub)
    order = hub.submit(
        {"symbol": "BHP", "side": "buy", "type": "limit", "quantity": 100, "limit_price": "59.00"}
    )

    hub.on_tick(Tick("BHP", 58.95, MARKET_TIME, day_volume=45_000))

    assert hub.engine.orders[order["id"]].status.value == "filled"
    saved = json.loads((tmp_path / "acct.json").read_text(encoding="utf-8"))
    assert saved["account"]["positions"]["BHP"]["quantity"] == 100


def test_held_symbols_keep_streaming_after_leaving_the_watchlist(tmp_path: Path) -> None:
    hub = make_hub(tmp_path)
    prime(hub)
    hub.submit({"symbol": "BHP", "side": "buy", "type": "market", "quantity": 100})

    assert "BHP" in hub.wanted_symbols()  # no clients watching, but we hold it


def test_account_summary(tmp_path: Path) -> None:
    hub = make_hub(tmp_path)
    prime(hub)
    hub.submit({"symbol": "BHP", "side": "buy", "type": "market", "quantity": 100})  # at 59.27

    summary = hub.account_json()

    assert summary["positions"][0]["unrealised"] == "-1.00"  # valued at last trade 59.26
    assert summary["net_pnl"] == "-11.00"  # includes $10 brokerage
    assert summary["fills"][0]["price"] == "59.27"


def test_parse_order_validates_input() -> None:
    request = parse_order(
        {"symbol": "bhp", "side": "sell", "type": "limit", "quantity": 5, "limit_price": "60.1"}
    )
    assert (request.symbol, request.side, request.type, request.limit_price) == (
        "BHP",
        Side.SELL,
        OrderType.LIMIT,
        Decimal("60.1"),
    )
    with pytest.raises(OrderRejectedError, match="Unknown ASX code"):
        parse_order({"symbol": "ZZZ", "side": "buy", "type": "market", "quantity": 1})
    with pytest.raises(OrderRejectedError, match="whole number"):
        parse_order({"symbol": "BHP", "side": "buy", "type": "market", "quantity": 1.5})
    with pytest.raises(OrderRejectedError, match="limit price"):
        parse_order(
            {"symbol": "BHP", "side": "buy", "type": "limit", "quantity": 1, "limit_price": "abc"}
        )


def test_reset_rejects_silly_amounts(tmp_path: Path) -> None:
    with pytest.raises(OrderRejectedError, match="between"):
        make_hub(tmp_path).reset(Decimal("5"))


def test_corrupt_saved_account_is_kept_aside(tmp_path: Path) -> None:
    path = tmp_path / "acct.json"
    path.write_text("{not json", encoding="utf-8")

    engine = load_engine(path)

    assert engine.account.cash == Decimal("50000.00")
    assert not path.exists()
    assert len(list(tmp_path.glob("acct.corrupt-*.json"))) == 1
