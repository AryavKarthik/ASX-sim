"""Live mode API: stream the delayed market and trade on it (ADR 0007).

    WS /api/live/ws?symbols=BHP,CBA,...&source=live          Yahoo, ~20 min delayed
    WS /api/live/ws?symbols=BHP,CBA,...&source=demo&day=...  a recorded day played as live

Server -> browser:
    {"type": "snapshot", "session_day", "source", "symbols": {...}, "account": {...}}
    {"type": "tick", "symbol", "live", "quote", "candle"}   every price update
    {"type": "status", ...}                                 every second
    {"type": "account", "account": {...}, "fills": [...]}  after any order activity
    {"type": "result", "request_id", "ok", "order" | "error"}  reply to a command

Browser -> server:
    {"action": "watch", "symbols": [...]}
    {"action": "order", "request_id", "symbol", "side", "type", "quantity", "limit_price"}
    {"action": "cancel", "request_id", "order_id"}
    {"action": "reset_account", "request_id", "starting_cash"}

The live account is shared by every tab and saved to disk; a demo gets its own throwaway
account so practice on old days never mixes with it.
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from functools import cache
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect

from asxsim.api.deps import get_store
from asxsim.coach.service import Coach, CoachError, coach_from_env
from asxsim.data import company, history
from asxsim.data.store import LocalBarStore, NoDataError
from asxsim.data.universe import BENCHMARKS, recording_universe, security_names
from asxsim.journal.journal import EMOTIONS, SETUPS, Journal
from asxsim.live.feeds import (
    DemoFeed,
    FallbackFeed,
    PriceFeed,
    YahooPollingFeed,
    YahooStreamFeed,
    fetch_recent_session,
)
from asxsim.live.hub import LiveHub, load_engine
from asxsim.live.market import LiveMarket
from asxsim.settings import state_dir
from asxsim.trading.engine import OrderRejectedError

router = APIRouter(prefix="/api/live", tags=["live"])

MAX_SYMBOLS = 20
DEFAULT_WATCHLIST = [
    "BHP", "CBA", "CSL", "NAB", "WBC", "ANZ", "MQG", "WES",
    "WOW", "FMG", "RIO", "WDS", "TLS", "XRO", "PLS", "XJO",
]  # fmt: skip


def parse_symbols(raw: str | list[Any]) -> list[str]:
    known = recording_universe()
    parts = raw.split(",") if isinstance(raw, str) else [str(p) for p in raw]
    codes: list[str] = []
    for part in parts:
        code = part.strip().upper()
        if code and code in known and code not in codes:
            codes.append(code)
    return codes[:MAX_SYMBOLS]


def yahoo_feed_factory(market: LiveMarket) -> PriceFeed:
    return FallbackFeed(
        YahooStreamFeed(),
        YahooPollingFeed(),
        should_be_trading=lambda: market.phase_at(datetime.now(UTC)).matches_continuously,
    )


@cache
def get_live_hub() -> LiveHub:
    """The one live hub for this server process (overridden in tests)."""
    path = state_dir() / "live_account.json"
    return LiveHub(
        "live",
        yahoo_feed_factory,
        engine=load_engine(path),
        journal=Journal(state_dir() / "live_journal.json"),
        day_bars=get_store().load_day,
        history=fetch_recent_session,
        state_path=path,
    )


def demo_hub(store: LocalBarStore, day: date | None, speed: float) -> LiveHub:
    demo_day = day or store.available_days()[-1]
    bars = store.load_day(demo_day)
    symbols = sorted(bars["symbol"].unique().tolist())
    return LiveHub(
        "demo",
        lambda market: DemoFeed(bars, speed=speed),
        max_live_lag=None,  # a demo replays an old day: every lag is "live" there
        fixed_symbols=symbols,  # stream the whole day once, so watchlist changes don't restart it
        day_bars=store.load_day,
        session_day=demo_day.isoformat(),
    )


@cache
def get_coach() -> Coach:
    """The AI coach for this server process (overridden in tests)."""
    return coach_from_env()


async def run_coach(hub: LiveHub, coach: Coach, client: Any, message: dict[str, Any]) -> None:
    """Answer one coach request, streaming the reply to the browser as it is written."""
    reply: dict[str, Any] = {
        "type": "result",
        "request_id": message.get("request_id"),
        "action": "coach",
    }
    try:
        symbol = message.get("symbol")
        request = coach.build(
            message.get("kind", "chat"),
            message.get("question"),
            message.get("history"),
            hub.coach_context(symbol if isinstance(symbol, str) else None),
        )
        async for text in coach.reply(request):
            client.queue.put_nowait(
                {"type": "coach", "request_id": message.get("request_id"), "delta": text}
            )
    except CoachError as exc:
        reply.update(ok=False, error=str(exc))
    else:
        reply["ok"] = True
    reply["coach"] = coach.status()
    client.queue.put_nowait(reply)


@router.get("/history")
async def price_history(
    symbol: Annotated[str, Query()],
    interval: Annotated[str, Query(pattern="^(1d|1wk|1mo)$")] = "1d",
    until: Annotated[date | None, Query()] = None,
) -> dict[str, Any]:
    """Daily, weekly or monthly bars. `until` excludes that date and later (used by demos)."""
    code = symbol.strip().upper()
    if code not in recording_universe():
        raise HTTPException(status_code=404, detail=f"Unknown ASX code {code}")
    try:
        bars = await asyncio.to_thread(history.history, code, interval, until)
    except Exception as exc:  # Yahoo unavailable
        raise HTTPException(status_code=502, detail=f"Couldn't load history: {exc}") from exc
    return {"symbol": code, "interval": interval, "bars": bars}


@router.get("/company")
async def company_page(
    symbol: Annotated[str, Query()],
    until: Annotated[date | None, Query()] = None,
) -> dict[str, Any]:
    """What the company does, its fundamentals, and price statistics up to `until`."""
    code = symbol.strip().upper()
    if code not in recording_universe():
        raise HTTPException(status_code=404, detail=f"Unknown ASX code {code}")
    try:
        profile = await asyncio.to_thread(company.profile, code)
        daily = await asyncio.to_thread(history.history, code, "1d", until)
    except Exception as exc:  # Yahoo unavailable
        raise HTTPException(status_code=502, detail=f"Couldn't load company data: {exc}") from exc
    return {**profile, "price": company.price_stats(daily)}


@router.get("/defaults")
def defaults(coach: Annotated[Coach, Depends(get_coach)]) -> dict[str, Any]:
    """The default watchlist and every symbol that can be watched."""
    names = security_names()
    universe = sorted(recording_universe(), key=lambda c: (c in BENCHMARKS, c))
    return {
        "watchlist": DEFAULT_WATCHLIST,
        "max_symbols": MAX_SYMBOLS,
        "journal": {"setups": SETUPS, "emotions": EMOTIONS},
        "coach": coach.status(),
        "universe": [{"code": c, "name": names.get(c, c)} for c in universe],
    }


def handle_command(hub: LiveHub, message: dict[str, Any]) -> dict[str, Any] | None:
    """Run one browser command; returns the reply (None for commands without one)."""
    action = message.get("action")
    reply: dict[str, Any] = {
        "type": "result",
        "request_id": message.get("request_id"),
        "action": action,
    }
    try:
        if action == "order":
            reply["order"] = hub.submit(message)
        elif action == "cancel":
            reply["order"] = hub.cancel(str(message.get("order_id")))
        elif action == "reset_account":
            try:
                cash = Decimal(str(message.get("starting_cash")))
            except InvalidOperation as exc:
                raise OrderRejectedError("Enter a starting cash amount") from exc
            hub.reset(cash)
        elif action == "analytics":
            reply["analytics"] = hub.analytics_json()
        elif action == "journal":
            fields = message.get("fields")
            if not isinstance(fields, dict):
                raise OrderRejectedError("Journal fields are missing")
            hub.update_journal(str(message.get("trade_id")), fields)
        else:
            raise OrderRejectedError(f"Unknown action {action!r}")
    except OrderRejectedError as exc:
        reply.update(ok=False, error=str(exc))
        return reply
    reply["ok"] = True
    return reply


@router.websocket("/ws")
async def live_stream(
    websocket: WebSocket,
    store: Annotated[LocalBarStore, Depends(get_store)],
    live_hub: Annotated[LiveHub, Depends(get_live_hub)],
    coach: Annotated[Coach, Depends(get_coach)],
    symbols: Annotated[str, Query()] = ",".join(DEFAULT_WATCHLIST),
    source: Annotated[str, Query(pattern="^(live|demo)$")] = "live",
    day: Annotated[date | None, Query()] = None,
    speed: Annotated[float, Query(gt=0, le=60)] = 1.0,
) -> None:
    await websocket.accept()
    codes = parse_symbols(symbols)
    if not codes:
        await websocket.close(code=4400, reason="No valid ASX codes in the watchlist")
        return

    owns_hub = source == "demo"
    if owns_hub:
        try:
            hub = demo_hub(store, day, speed)
        except (NoDataError, IndexError):
            await websocket.close(code=4404, reason="No recorded day available for the demo")
            return
    else:
        hub = live_hub

    client = await hub.connect(codes)

    async def send_all() -> None:
        while True:
            await websocket.send_json(await client.queue.get())

    sender = asyncio.create_task(send_all())
    coaching: asyncio.Task[None] | None = None  # one coach reply at a time
    try:
        with contextlib.suppress(WebSocketDisconnect):
            while True:
                message = await websocket.receive_json()
                if not isinstance(message, dict):
                    continue
                if message.get("action") == "watch":
                    wanted = parse_symbols(message.get("symbols") or [])
                    if wanted:
                        await hub.watch(client, wanted)
                    continue
                if message.get("action") == "coach":
                    if coaching is not None and not coaching.done():
                        client.queue.put_nowait(
                            {
                                "type": "result",
                                "request_id": message.get("request_id"),
                                "action": "coach",
                                "ok": False,
                                "error": "The coach is still answering your last question",
                            }
                        )
                    else:
                        coaching = asyncio.create_task(run_coach(hub, coach, client, message))
                    continue
                reply = handle_command(hub, message)
                if reply is not None:
                    client.queue.put_nowait(reply)
    finally:
        if coaching is not None:
            coaching.cancel()
        sender.cancel()
        hub.disconnect(client)
        if owns_hub:
            await hub.close()
