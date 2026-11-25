"""FastAPI app for ASX-sim.

- Live mode (the core, ADR 0007): see `asxsim.api.live`, streaming the delayed market.
- Past-day replay (secondary): the /api/replay endpoints below.

Run locally:  uv run uvicorn asxsim.api.app:app --reload   (from backend/)
Interactive API docs are then at http://127.0.0.1:8000/docs
"""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from collections import OrderedDict
from datetime import date
from typing import Annotated, Any, Literal

import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from asxsim.api.deps import get_store
from asxsim.api.live import router as live_router
from asxsim.api.plans import router as plans_router
from asxsim.api.swing import router as swing_router
from asxsim.data.store import LocalBarStore, NoDataError
from asxsim.data.universe import BENCHMARKS, security_names
from asxsim.engine.replay import ReplaySession, ReplayState
from asxsim.market.calendar import SYDNEY

TICK_SECONDS = 0.25  # how often a playing replay pushes updates to the browser
MAX_SESSIONS = 20

app = FastAPI(title="ASX-sim API", version="1.1.0")
app.include_router(live_router)
app.include_router(swing_router)
app.include_router(plans_router)

__all__ = ["app", "get_store"]

StoreDep = Annotated[LocalBarStore, Depends(get_store)]

_sessions: OrderedDict[str, ReplaySession] = OrderedDict()

_NAMES: dict[str, str] = security_names()


# ---------- response shapes ----------


class Security(BaseModel):
    code: str
    name: str


class SessionRequest(BaseModel):
    symbol: str = Field(examples=["BHP"])
    day: date = Field(examples=["2026-11-13"])
    seed: int = 0


class Command(BaseModel):
    action: Literal["play", "pause", "step", "speed"]
    value: float | None = None


# ---------- JSON helpers ----------


def _local_epoch(ts: pd.Series) -> list[int]:
    """Epoch seconds of the *Sydney wall-clock* time.

    The chart library draws timestamps as UTC, so we shift them by the Sydney offset to make
    the axis read 10:00-16:00 instead of 23:00-05:00.
    """
    local = pd.DatetimeIndex(ts).tz_convert(SYDNEY).tz_localize(None).as_unit("s")
    return [int(x) for x in local.asi8]


def bars_json(bars: pd.DataFrame) -> list[dict[str, float | int]]:
    times = _local_epoch(bars["ts"])
    return [
        {
            "time": t,
            "open": round(float(o), 4),
            "high": round(float(h), 4),
            "low": round(float(lo), 4),
            "close": round(float(c), 4),
            "volume": int(v),
        }
        for t, o, h, lo, c, v in zip(
            times,
            bars["open"],
            bars["high"],
            bars["low"],
            bars["close"],
            bars["volume"],
            strict=True,
        )
    ]


def state_json(state: ReplayState) -> dict[str, Any]:
    local = state.now.astimezone(SYDNEY)
    return {
        "symbol": state.symbol,
        "name": _NAMES.get(state.symbol, state.symbol),
        "day": state.day.isoformat(),
        "now": local.isoformat(timespec="seconds"),
        "phase": state.phase.value,
        "speed": state.speed,
        "playing": state.playing,
        "finished": state.finished,
        "bars_visible": state.bars_visible,
        "last_price": None if state.last_price is None else round(state.last_price, 4),
        "open_price": None if state.open_price is None else round(state.open_price, 4),
    }


# ---------- REST endpoints ----------


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/replay/days")
def replay_days(store: StoreDep) -> dict[str, list[str]]:
    """Days with recorded 1-minute data, newest first."""
    return {"days": [d.isoformat() for d in reversed(store.available_days())]}


@app.get("/api/replay/symbols")
def replay_symbols(store: StoreDep, day: Annotated[date, Query()]) -> list[Security]:
    """Stocks with data on `day`, ASX 200 first then benchmarks."""
    try:
        codes = store.symbols(day)
    except NoDataError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    ordered = sorted(codes, key=lambda c: (c in BENCHMARKS, c))
    return [Security(code=c, name=_NAMES.get(c, c)) for c in ordered]


@app.post("/api/replay/sessions", status_code=201)
def create_session(request: SessionRequest, store: StoreDep) -> dict[str, Any]:
    try:
        bars = store.bars(request.day, request.symbol.upper())
        session = ReplaySession(request.symbol.upper(), request.day, bars, seed=request.seed)
    except NoDataError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    session_id = uuid.uuid4().hex
    _sessions[session_id] = session
    while len(_sessions) > MAX_SESSIONS:
        _sessions.popitem(last=False)
    return {"session_id": session_id, "state": state_json(session.state())}


# ---------- live replay stream ----------


def apply_command(session: ReplaySession, command: Command) -> None:
    match command.action:
        case "play":
            session.clock.play()
        case "pause":
            session.clock.pause()
        case "step":
            session.clock.pause()
            session.step()
        case "speed":
            if command.value is None:
                raise ValueError("speed needs a value")
            session.clock.set_speed(command.value)


@app.websocket("/api/replay/sessions/{session_id}/ws")
async def replay_stream(websocket: WebSocket, session_id: str) -> None:
    """Push the replay to the browser and accept play/pause/step/speed commands.

    Messages sent: {"type": "snapshot" | "update", "state": {...}, "bars": [...]}
    where "bars" holds only bars that became visible since the last message.
    """
    session = _sessions.get(session_id)
    await websocket.accept()
    if session is None:
        await websocket.close(code=4404, reason="Unknown replay session")
        return

    commands: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def read_commands() -> None:
        with contextlib.suppress(WebSocketDisconnect):
            while True:
                await commands.put(await websocket.receive_json())
        await commands.put({"action": "_disconnect"})

    reader = asyncio.create_task(read_commands())
    sent = session.gate.visible_count()
    await websocket.send_json(
        {
            "type": "snapshot",
            "state": state_json(session.state()),
            "bars": bars_json(session.gate.visible()),
        }
    )

    last = time.monotonic()
    pending: list[dict[str, Any]] = []
    try:
        while True:
            changed = False
            while not commands.empty():
                pending.append(commands.get_nowait())
            for raw in pending:
                if raw.get("action") == "_disconnect":
                    return
                try:
                    apply_command(session, Command.model_validate(raw))
                    changed = True
                except ValueError as exc:
                    await websocket.send_json({"type": "error", "message": str(exc)})
            pending.clear()

            now = time.monotonic()
            was_playing = session.clock.playing
            session.clock.advance(now - last)
            last = now

            new_bars = session.gate.since(sent)
            if changed or was_playing or not new_bars.empty:
                sent += len(new_bars)
                await websocket.send_json(
                    {
                        "type": "update",
                        "state": state_json(session.state()),
                        "bars": bars_json(new_bars),
                    }
                )
            # Wake early if a command arrives; otherwise tick at TICK_SECONDS.
            with contextlib.suppress(TimeoutError):
                pending.append(await asyncio.wait_for(commands.get(), timeout=TICK_SECONDS))
    except WebSocketDisconnect:
        return
    finally:
        reader.cancel()
