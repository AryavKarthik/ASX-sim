"""Swing practice API: step through daily bars and trade them.

    GET    /api/swing/options                     stocks and periods to choose from
    GET    /api/swing/sessions                    saved sessions, newest first
    POST   /api/swing/sessions                    start one
    GET    /api/swing/sessions/{id}               its current state
    POST   /api/swing/sessions/{id}/advance       move forward 1+ trading days
    POST   /api/swing/sessions/{id}/orders        place an order
    DELETE /api/swing/sessions/{id}/orders/{n}    cancel an order

Every response carries the session's whole visible state. It never includes a bar after
the current day, so the browser can't peek ahead.
"""

from __future__ import annotations

import asyncio
from datetime import date
from decimal import Decimal, InvalidOperation
from functools import cache
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from asxsim.data import history
from asxsim.data.universe import BENCHMARKS, recording_universe, security_names
from asxsim.settings import state_dir
from asxsim.swing.session import SwingError, SwingSession
from asxsim.swing.store import PERIODS, SwingStore

router = APIRouter(prefix="/api/swing", tags=["swing"])


def tradeable_names() -> dict[str, str]:
    """Stocks you can practise on (indexes can't be bought)."""
    names = security_names()
    return {c: names.get(c, c) for c in recording_universe() if c not in BENCHMARKS}


@cache
def get_swing_store() -> SwingStore:
    """The store for this server process (overridden in tests)."""
    return SwingStore(history.all_daily, tradeable_names(), state_dir() / "swing_sessions.json")


StoreDep = Annotated[SwingStore, Depends(get_swing_store)]


class NewSession(BaseModel):
    symbol: str | None = Field(default=None, description="ASX code, or null for a surprise")
    start: date | None = Field(default=None, description="First day, or null for a random one")
    days: int = Field(default=126, description="Trading days to practise over")
    cash: str = "50000"
    blind: bool = False


class Advance(BaseModel):
    days: int = Field(default=1, ge=1, le=30)


class NewOrder(BaseModel):
    side: Literal["buy", "sell"]
    type: Literal["market", "limit", "stop"]
    quantity: int
    price: str | None = None


def _decimal(text: str, label: str) -> Decimal:
    try:
        return Decimal(text)
    except InvalidOperation as exc:
        raise HTTPException(status_code=400, detail=f"Enter a number for the {label}") from exc


def _session(store: SwingStore, key: str) -> SwingSession:
    try:
        return store.get(key)
    except KeyError as exc:
        raise HTTPException(
            status_code=404, detail="That practice session no longer exists"
        ) from exc


def _view(key: str, session: SwingSession) -> dict[str, Any]:
    return {"id": key, **session.to_view()}


@router.get("/options")
def options() -> dict[str, Any]:
    return {
        "stocks": [{"code": c, "name": n} for c, n in sorted(tradeable_names().items())],
        "periods": [{"label": label, "days": days} for label, days in PERIODS.items()],
    }


@router.get("/sessions")
def list_sessions(store: StoreDep) -> dict[str, Any]:
    return {"sessions": store.recent()}


@router.post("/sessions", status_code=201)
async def create_session(request: NewSession, store: StoreDep) -> dict[str, Any]:
    symbol = request.symbol.strip().upper() if request.symbol else None
    cash = _decimal(request.cash, "starting cash")
    try:
        # Loading a stock's full history can take a second the first time: keep it off the loop.
        key, session = await asyncio.to_thread(
            store.create, symbol, request.start, request.days, cash, request.blind
        )
    except SwingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # Yahoo unavailable
        raise HTTPException(status_code=502, detail=f"Couldn't load price history: {exc}") from exc
    return _view(key, session)


@router.get("/sessions/{key}")
def read_session(key: str, store: StoreDep) -> dict[str, Any]:
    return _view(key, _session(store, key))


@router.post("/sessions/{key}/advance")
def advance(key: str, request: Advance, store: StoreDep) -> dict[str, Any]:
    session = _session(store, key)
    filled = session.advance(request.days)
    store.save()
    return {**_view(key, session), "filled": [o.to_json() for o in filled]}


@router.post("/sessions/{key}/orders", status_code=201)
def place_order(key: str, request: NewOrder, store: StoreDep) -> dict[str, Any]:
    session = _session(store, key)
    price = None if request.price in (None, "") else _decimal(str(request.price), "price")
    try:
        session.place(request.side, request.type, request.quantity, price)
    except SwingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    store.save()
    return _view(key, session)


@router.delete("/sessions/{key}/orders/{order_id}")
def cancel_order(key: str, order_id: int, store: StoreDep) -> dict[str, Any]:
    session = _session(store, key)
    try:
        session.cancel(order_id)
    except SwingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    store.save()
    return _view(key, session)
