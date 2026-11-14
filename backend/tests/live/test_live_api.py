from __future__ import annotations

from collections.abc import AsyncIterator, Iterator, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from asxsim.api import live
from asxsim.api.app import app, get_store
from asxsim.data.store import LocalBarStore
from asxsim.live.market import LiveMarket
from asxsim.live.quotes import Tick


class ScriptedFeed:
    name = "scripted"

    def __init__(self, ticks: list[Tick]) -> None:
        self._ticks = ticks

    async def stream(self, symbols: Sequence[str]) -> AsyncIterator[Tick]:
        for tick in self._ticks:
            yield tick


@pytest.fixture
def client(bar_store: LocalBarStore, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    now = datetime.now(UTC)
    scripted = [
        Tick("BHP", 59.10, now - timedelta(minutes=20), previous_close=58.90, day_volume=1000),
        Tick("BHP", 59.25, now - timedelta(minutes=20) + timedelta(seconds=3), day_volume=1500),
    ]
    app.dependency_overrides[get_store] = lambda: bar_store
    app.dependency_overrides[live.get_feed_factory] = lambda: lambda market: ScriptedFeed(scripted)
    monkeypatch.setattr(live, "fetch_recent_session", lambda codes: (pd.DataFrame(), None))
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def receive_until(ws: Any, kind: str, limit: int = 50) -> dict[str, Any]:
    for _ in range(limit):
        message: dict[str, Any] = ws.receive_json()
        if message["type"] == kind:
            return message
    raise AssertionError(f"no {kind} message")


def test_defaults_list_watchlist_and_universe(client: TestClient) -> None:
    body = client.get("/api/live/defaults").json()

    assert "BHP" in body["watchlist"]
    assert body["max_symbols"] == 20
    assert {"code": "CBA", "name": "Commonwealth Bank"} in body["universe"]


def test_live_stream_sends_snapshot_ticks_and_status(client: TestClient) -> None:
    with client.websocket_connect("/api/live/ws?symbols=bhp,CBA,nope") as ws:
        snapshot = receive_until(ws, "snapshot")
        assert set(snapshot["symbols"]) == {"BHP", "CBA"}  # unknown codes dropped

        first = receive_until(ws, "tick")
        assert first["symbol"] == "BHP"
        assert first["quote"]["price"] == 59.10
        assert first["quote"]["change"] == pytest.approx(0.20)
        assert first["quote"]["change_basis"] == "previous close"

        second = receive_until(ws, "tick")
        assert second["candle"]["volume"] == 500  # day volume rose by 500

        status = receive_until(ws, "status")
        assert status["feed"] == "scripted"
        assert status["delay_measured"] is True
        assert 1190 < status["delay_seconds"] < 1210  # about 20 minutes


def test_demo_source_plays_a_recorded_day(client: TestClient) -> None:
    with client.websocket_connect("/api/live/ws?symbols=BHP&source=demo&speed=60") as ws:
        snapshot = receive_until(ws, "snapshot")
        assert snapshot["source"] == "demo"
        assert snapshot["session_day"] == "2026-11-13"

        tick = receive_until(ws, "tick")
        assert tick["symbol"] == "BHP"


def test_rejects_an_empty_watchlist(client: TestClient) -> None:
    with client.websocket_connect("/api/live/ws?symbols=nope") as ws:
        message = ws.receive()
        assert message["type"] == "websocket.close"
        assert message["code"] == 4400


def test_yahoo_factory_wires_stream_with_polling_fallback() -> None:
    feed = live.yahoo_feed_factory(LiveMarket(["BHP"]))
    assert feed.name == "yahoo-stream"
