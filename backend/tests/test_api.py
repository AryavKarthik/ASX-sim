from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from asxsim.api.app import app, get_store
from asxsim.data.store import LocalBarStore


@pytest.fixture
def client(bar_store: LocalBarStore) -> Iterator[TestClient]:
    app.dependency_overrides[get_store] = lambda: bar_store
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def test_health(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok"}


def test_lists_days_and_symbols(client: TestClient) -> None:
    assert client.get("/api/replay/days").json() == {"days": ["2026-11-13"]}

    symbols = client.get("/api/replay/symbols", params={"day": "2026-11-13"}).json()
    assert symbols == [
        {"code": "BHP", "name": "BHP"},
        {"code": "CBA", "name": "Commonwealth Bank"},
    ]


def test_unknown_day_is_404(client: TestClient) -> None:
    response = client.get("/api/replay/symbols", params={"day": "2026-11-12"})
    assert response.status_code == 404


def test_create_session_validates_input(client: TestClient) -> None:
    assert (
        client.post("/api/replay/sessions", json={"symbol": "ZZZ", "day": "2026-11-13"}).status_code
        == 404
    )
    assert (
        client.post("/api/replay/sessions", json={"symbol": "BHP", "day": "2026-11-14"}).status_code
        == 404
    )


def test_replay_stream_snapshot_step_and_speed(client: TestClient) -> None:
    created = client.post("/api/replay/sessions", json={"symbol": "bhp", "day": "2026-11-13"})
    assert created.status_code == 201
    session_id = created.json()["session_id"]
    assert created.json()["state"]["phase"] == "pre_open"

    with client.websocket_connect(f"/api/replay/sessions/{session_id}/ws") as ws:
        snapshot = ws.receive_json()
        assert snapshot["type"] == "snapshot"
        assert snapshot["bars"] == []
        assert snapshot["state"]["now"] == "2026-11-13T09:50:00+11:00"

        for _ in range(11):  # 09:50 -> 10:01, when the 10:00 bar has finished
            ws.send_json({"action": "step"})
            update = ws.receive_json()
        assert update["state"]["now"] == "2026-11-13T10:01:00+11:00"
        assert update["state"]["phase"] == "open"
        assert len(update["bars"]) == 1
        bar = update["bars"][0]
        assert set(bar) == {"time", "open", "high", "low", "close", "volume"}
        # Chart time is Sydney wall-clock: 10:00 on 13 Nov 2026 as if it were UTC.
        assert bar["time"] == 1794564000

        ws.send_json({"action": "speed", "value": 60})
        assert ws.receive_json()["state"]["speed"] == 60

        ws.send_json({"action": "speed", "value": 0})
        assert ws.receive_json()["type"] == "error"


def test_unknown_session_closes_socket(client: TestClient) -> None:
    with client.websocket_connect("/api/replay/sessions/nope/ws") as ws:
        message = ws.receive()
        assert message["type"] == "websocket.close"
        assert message["code"] == 4404
