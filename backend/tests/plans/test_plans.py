"""Trade plans: checking, saving and the API."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from asxsim.api import plans as plans_api
from asxsim.api.app import app
from asxsim.plans.store import MAX_PLANS, PlanError, PlanStore, clean

NAMES = {"BHP": "BHP Group", "CBA": "Commonwealth Bank"}


def plan(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "symbol": "bhp",
        "title": "Breakout above $46",
        "setup": "Breakout",
        "entry": "45.50",
        "stop": "44.80",
        "target": "47.00",
        "risk_mode": "percent",
        "risk_value": "1",
        "shares": None,
        "notes": "Holding above VWAP.",
        "checklist": [{"text": "Trend agrees", "done": True}, {"text": "  ", "done": False}],
    }
    return {**base, **overrides}


def test_clean_keeps_a_valid_plan_and_tidies_it() -> None:
    cleaned = clean(plan(), NAMES)
    assert cleaned["symbol"] == "BHP"
    assert cleaned["entry"] == "45.50"
    assert cleaned["checklist"] == [{"text": "Trend agrees", "done": True}]  # blank item dropped


def test_stop_and_target_are_optional() -> None:
    cleaned = clean(plan(stop=None, target=""), NAMES)
    assert cleaned["stop"] is None
    assert cleaned["target"] is None


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"symbol": "ZZZ"}, "Unknown ASX code"),
        ({"entry": ""}, "Enter the entry price"),
        ({"entry": "abc"}, "must be a number"),
        ({"entry": "-1"}, "above zero"),
        ({"stop": "46"}, "stop-loss must be below"),
        ({"target": "45"}, "target must be above"),
        ({"risk_value": "150"}, "more than 100%"),
        ({"risk_mode": "lots"}, "percentage or a dollar"),
        ({"shares": 1.5}, "whole number"),
        ({"shares": True}, "whole number"),
    ],
)
def test_clean_rejects_bad_plans(overrides: dict[str, Any], message: str) -> None:
    with pytest.raises(PlanError, match=message):
        clean(plan(**overrides), NAMES)


def test_store_saves_updates_and_deletes(tmp_path: Path) -> None:
    path = tmp_path / "plans.json"
    store = PlanStore(NAMES, path)
    first = store.create(plan())
    second = store.create(plan(symbol="CBA", entry="150", stop="147", target="156"))
    assert [p["id"] for p in store.list()] == [second["id"], first["id"]]  # newest first

    updated = store.update(first["id"], plan(notes="Moved stop under the low."))
    assert updated["created_at"] == first["created_at"]
    assert store.list()[0]["id"] == first["id"]  # just changed, so now first

    reloaded = PlanStore(NAMES, path)
    assert {p["id"] for p in reloaded.list()} == {first["id"], second["id"]}
    assert reloaded.list()[0]["notes"] == "Moved stop under the low."

    reloaded.delete(second["id"])
    assert [p["id"] for p in PlanStore(NAMES, path).list()] == [first["id"]]
    with pytest.raises(KeyError):
        reloaded.delete(second["id"])


def test_store_limits_how_many_plans_are_kept() -> None:
    store = PlanStore(NAMES)
    for _ in range(MAX_PLANS):
        store.create(plan())
    with pytest.raises(PlanError, match="Delete some"):
        store.create(plan())


def test_unreadable_file_starts_clean(tmp_path: Path) -> None:
    path = tmp_path / "plans.json"
    path.write_text("not json", encoding="utf-8")
    assert PlanStore(NAMES, path).list() == []


@pytest.fixture
def client() -> Iterator[TestClient]:
    store = PlanStore(NAMES)
    app.dependency_overrides[plans_api.get_plan_store] = lambda: store
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(plans_api.get_plan_store, None)


def test_api_round_trip(client: TestClient) -> None:
    created = client.post("/api/plans", json=plan())
    assert created.status_code == 201
    plan_id = created.json()["id"]

    assert [p["id"] for p in client.get("/api/plans").json()] == [plan_id]

    changed = client.put(f"/api/plans/{plan_id}", json=plan(target="48"))
    assert changed.status_code == 200
    assert changed.json()["target"] == "48"

    assert client.delete(f"/api/plans/{plan_id}").status_code == 204
    assert client.get("/api/plans").json() == []


def test_api_errors(client: TestClient) -> None:
    bad = client.post("/api/plans", json=plan(stop="50"))
    assert bad.status_code == 400
    assert "stop-loss" in bad.json()["detail"]
    assert client.put("/api/plans/nope", json=plan()).status_code == 404
    assert client.delete("/api/plans/nope").status_code == 404
