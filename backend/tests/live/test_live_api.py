from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator, Sequence
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from asxsim.api import live
from asxsim.api.app import app, get_store
from asxsim.data.store import LocalBarStore
from asxsim.live.hub import LiveHub
from asxsim.live.market import LiveMarket
from asxsim.live.quotes import Tick
from asxsim.market.calendar import SYDNEY
from tests.trading.test_engine import DAY

MARKET_TIME = datetime.combine(DAY, time(10, 30), tzinfo=SYDNEY)  # Tue 17 Nov, trading
WALL_CLOCK = MARKET_TIME + timedelta(minutes=20)  # what your PC's clock says


class ScriptedFeed:
    name = "scripted"

    def __init__(self, ticks: list[Tick]) -> None:
        self._ticks = ticks

    async def stream(self, symbols: Sequence[str]) -> AsyncIterator[Tick]:
        for tick in self._ticks:
            if tick.symbol in symbols:
                yield tick


SCRIPT = [
    Tick("BHP", 59.10, MARKET_TIME - timedelta(minutes=2), previous_close=58.90, day_volume=10_000),
    Tick("BHP", 59.20, MARKET_TIME - timedelta(minutes=1), day_volume=50_000),
    Tick("BHP", 59.26, MARKET_TIME - timedelta(seconds=5), day_volume=51_500),
]


@pytest.fixture
def hub(tmp_path: Path) -> LiveHub:
    return LiveHub(
        "live",
        lambda market: ScriptedFeed(SCRIPT),
        state_path=tmp_path / "live_account.json",
        clock=lambda: WALL_CLOCK,
    )


@pytest.fixture
def client(bar_store: LocalBarStore, hub: LiveHub) -> Iterator[TestClient]:
    app.dependency_overrides[get_store] = lambda: bar_store
    app.dependency_overrides[live.get_live_hub] = lambda: hub
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def receive_until(ws: Any, kind: str, limit: int = 60, **match: Any) -> dict[str, Any]:
    for _ in range(limit):
        message: dict[str, Any] = ws.receive_json()
        if message["type"] == kind and all(message.get(k) == v for k, v in match.items()):
            return message
    raise AssertionError(f"no {kind} message matching {match}")


def ticks_seen(ws: Any, n: int) -> list[dict[str, Any]]:
    return [receive_until(ws, "tick") for _ in range(n)]


def result_and_account(
    ws: Any, request_id: str, limit: int = 30
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The reply to a command and the account update it caused (they can arrive in either order)."""
    result: dict[str, Any] | None = None
    account: dict[str, Any] | None = None
    for _ in range(limit):
        message: dict[str, Any] = ws.receive_json()
        if message["type"] == "result" and message.get("request_id") == request_id:
            result = message
        elif message["type"] == "account":
            account = message["account"]
        if result is not None and account is not None:
            return result, account
    raise AssertionError(f"missing result or account for {request_id}")


def test_defaults_list_watchlist_and_universe(client: TestClient) -> None:
    body = client.get("/api/live/defaults").json()

    assert "BHP" in body["watchlist"]
    assert body["max_symbols"] == 20
    assert {"code": "CBA", "name": "Commonwealth Bank"} in body["universe"]


def test_stream_sends_snapshot_ticks_and_status(client: TestClient) -> None:
    with client.websocket_connect("/api/live/ws?symbols=bhp,CBA,nope") as ws:
        snapshot = receive_until(ws, "snapshot")
        assert set(snapshot["symbols"]) == {"BHP", "CBA"}  # unknown codes dropped
        assert snapshot["account"]["cash"] == "50000.00"

        first, _, third = ticks_seen(ws, 3)
        assert first["quote"]["change"] == pytest.approx(0.20)
        assert third["candle"]["volume"] == 41_500  # same minute as the 2nd update: 40,000 + 1,500

        status = receive_until(ws, "status")
        assert status["feed"] == "scripted"
        assert status["phase"] == "open"
        assert 1195 < status["delay_seconds"] < 1325  # about 20 minutes


def test_place_an_order_and_see_the_account_update(client: TestClient, tmp_path: Path) -> None:
    with client.websocket_connect("/api/live/ws?symbols=BHP") as ws:
        ticks_seen(ws, 3)
        ws.send_json(
            {
                "action": "order",
                "request_id": "r1",
                "symbol": "BHP",
                "side": "buy",
                "type": "market",
                "quantity": 100,
            }
        )

        result, account = result_and_account(ws, "r1")
        assert result["ok"] is True
        assert result["order"]["status"] == "filled"
        assert result["order"]["average_price"] == "59.27"  # bought at the ask
        assert account["positions"][0]["quantity"] == 100
        assert account["fees"] == "10.00"

    saved = json.loads((tmp_path / "live_account.json").read_text(encoding="utf-8"))
    assert saved["account"]["positions"]["BHP"]["quantity"] == 100


def test_rule_breaks_come_back_as_readable_errors(client: TestClient) -> None:
    with client.websocket_connect("/api/live/ws?symbols=BHP") as ws:
        ticks_seen(ws, 3)
        ws.send_json(
            {
                "action": "order",
                "request_id": "r2",
                "symbol": "BHP",
                "side": "sell",
                "type": "market",
                "quantity": 10,
            }
        )

        result = receive_until(ws, "result", request_id="r2")
        assert result["ok"] is False
        assert "Short selling isn't enabled" in result["error"]


def test_cancel_and_reset(client: TestClient) -> None:
    with client.websocket_connect("/api/live/ws?symbols=BHP") as ws:
        ticks_seen(ws, 3)
        ws.send_json(
            {
                "action": "order",
                "request_id": "r3",
                "symbol": "BHP",
                "side": "buy",
                "type": "limit",
                "quantity": 100,
                "limit_price": "58.00",
            }
        )
        order = result_and_account(ws, "r3")[0]["order"]
        assert order["status"] == "working"

        ws.send_json({"action": "cancel", "request_id": "r4", "order_id": order["id"]})
        assert result_and_account(ws, "r4")[0]["order"]["status"] == "cancelled"

        ws.send_json({"action": "reset_account", "request_id": "r5", "starting_cash": "25000"})
        result, account = result_and_account(ws, "r5")
        assert result["ok"] is True
        assert account["cash"] == "25000.00"


def test_watch_changes_the_watchlist(client: TestClient) -> None:
    with client.websocket_connect("/api/live/ws?symbols=BHP") as ws:
        receive_until(ws, "snapshot")
        ws.send_json({"action": "watch", "symbols": ["CBA", "CSL"]})
        assert set(receive_until(ws, "snapshot")["symbols"]) == {"CBA", "CSL"}


def test_demo_source_plays_a_recorded_day(client: TestClient) -> None:
    with client.websocket_connect("/api/live/ws?symbols=BHP&source=demo&speed=60") as ws:
        snapshot = receive_until(ws, "snapshot")
        assert snapshot["source"] == "demo"
        assert snapshot["session_day"] == "2026-11-13"
        assert receive_until(ws, "tick")["symbol"] == "BHP"


def test_rejects_an_empty_watchlist(client: TestClient) -> None:
    with client.websocket_connect("/api/live/ws?symbols=nope") as ws:
        message = ws.receive()
        assert message["type"] == "websocket.close"
        assert message["code"] == 4400


def test_yahoo_factory_wires_stream_with_polling_fallback() -> None:
    feed = live.yahoo_feed_factory(LiveMarket(["BHP"]))
    assert feed.name == "yahoo-stream"
