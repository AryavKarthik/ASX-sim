"""Risk planner API: save, list and delete trade plans.

    GET    /api/plans          saved plans, most recently changed first
    POST   /api/plans          save a new plan
    PUT    /api/plans/{id}     replace a plan
    DELETE /api/plans/{id}     delete a plan

All the risk maths happens in the browser, where it updates as you drag; the server only
checks and keeps the plan.
"""

from __future__ import annotations

from functools import cache
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException

from asxsim.api.swing import tradeable_names
from asxsim.plans.store import PlanError, PlanStore
from asxsim.settings import state_dir

router = APIRouter(prefix="/api/plans", tags=["plans"])


@cache
def get_plan_store() -> PlanStore:
    """The store for this server process (overridden in tests)."""
    return PlanStore(tradeable_names(), state_dir() / "trade_plans.json")


StoreDep = Annotated[PlanStore, Depends(get_plan_store)]
PlanBody = Annotated[dict[str, Any], Body()]


def _not_found(plan_id: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"No saved plan {plan_id}")


@router.get("")
def list_plans(store: StoreDep) -> list[dict[str, Any]]:
    return store.list()


@router.post("", status_code=201)
def create_plan(body: PlanBody, store: StoreDep) -> dict[str, Any]:
    try:
        return store.create(body)
    except PlanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/{plan_id}")
def update_plan(plan_id: str, body: PlanBody, store: StoreDep) -> dict[str, Any]:
    try:
        return store.update(plan_id, body)
    except KeyError as exc:
        raise _not_found(plan_id) from exc
    except PlanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/{plan_id}", status_code=204)
def delete_plan(plan_id: str, store: StoreDep) -> None:
    try:
        store.delete(plan_id)
    except KeyError as exc:
        raise _not_found(plan_id) from exc
