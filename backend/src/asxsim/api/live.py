"""Live mode API: stream a watchlist of ASX stocks from the delayed market (ADR 0007).

    WS /api/live/ws?symbols=BHP,CBA,...&source=live          Yahoo, ~20 min delayed
    WS /api/live/ws?symbols=BHP,CBA,...&source=demo&day=...  a recorded day played as live

Messages sent to the browser:
    {"type": "snapshot", "session_day", "source", "symbols": {code: {"quote", "candles"}}}
    {"type": "tick", "symbol", "quote", "candle"}       on every price update
    {"type": "status", "source", "delay_seconds", "market_time", "phase", ...}  every second
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect

from asxsim.api.deps import get_store
from asxsim.data.store import LocalBarStore, NoDataError
from asxsim.data.universe import BENCHMARKS, recording_universe, security_names
from asxsim.live.candles import candles_from_bars, sydney_epoch
from asxsim.live.feeds import (
    DemoFeed,
    FallbackFeed,
    PriceFeed,
    YahooPollingFeed,
    YahooStreamFeed,
    fetch_recent_session,
)
from asxsim.live.market import LiveMarket
from asxsim.live.quotes import Tick
from asxsim.market.calendar import SYDNEY

log = logging.getLogger("asxsim.live")

router = APIRouter(prefix="/api/live", tags=["live"])

MAX_SYMBOLS = 20
STATUS_SECONDS = 1.0
DEFAULT_WATCHLIST = [
    "BHP", "CBA", "CSL", "NAB", "WBC", "ANZ", "MQG", "WES",
    "WOW", "FMG", "RIO", "WDS", "TLS", "XRO", "PLS", "XJO",
]  # fmt: skip


def quote_json(tick: Tick) -> dict[str, Any]:
    reference = tick.previous_close or tick.open_price
    change = tick.price - reference if reference else None
    return {
        "price": round(tick.price, 4),
        "time": sydney_epoch(tick.time),
        "previous_close": tick.previous_close,
        "open": tick.open_price,
        "day_high": tick.day_high,
        "day_low": tick.day_low,
        "day_volume": tick.day_volume,
        "bid": tick.bid,
        "ask": tick.ask,
        "change": None if change is None else round(change, 4),
        "change_pct": None
        if change is None or not reference
        else round(100 * change / reference, 3),
        "change_basis": "previous close" if tick.previous_close else "open",
    }


def parse_symbols(raw: str) -> list[str]:
    known = recording_universe()
    codes: list[str] = []
    for part in raw.split(","):
        code = part.strip().upper()
        if code and code in known and code not in codes:
            codes.append(code)
    return codes[:MAX_SYMBOLS]


FeedFactory = Callable[[LiveMarket], PriceFeed]


def yahoo_feed_factory(market: LiveMarket) -> PriceFeed:
    return FallbackFeed(
        YahooStreamFeed(),
        YahooPollingFeed(),
        should_be_trading=lambda: market.phase_at(datetime.now(UTC)).matches_continuously,
    )


def get_feed_factory() -> FeedFactory:
    return yahoo_feed_factory


@router.get("/defaults")
def defaults() -> dict[str, Any]:
    """The default watchlist and every symbol that can be watched."""
    names = security_names()
    universe = sorted(recording_universe(), key=lambda c: (c in BENCHMARKS, c))
    return {
        "watchlist": DEFAULT_WATCHLIST,
        "max_symbols": MAX_SYMBOLS,
        "universe": [{"code": c, "name": names.get(c, c)} for c in universe],
    }


@router.websocket("/ws")
async def live_stream(
    websocket: WebSocket,
    store: Annotated[LocalBarStore, Depends(get_store)],
    feed_factory: Annotated[FeedFactory, Depends(get_feed_factory)],
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

    # A demo replays an old day, so its trades are always "old": trust every lag there.
    market = LiveMarket(codes, max_live_lag=None) if source == "demo" else LiveMarket(codes)
    feed: PriceFeed
    if source == "demo":
        try:
            demo_day = day or store.available_days()[-1]
            bars = store.load_day(demo_day)
        except (NoDataError, IndexError):
            await websocket.close(code=4404, reason="No recorded day available for the demo")
            return
        session_day: str | None = demo_day.isoformat()
        feed = DemoFeed(bars, speed=speed)
    else:
        try:
            history, session_day = await asyncio.to_thread(fetch_recent_session, codes)
        except Exception as exc:  # Yahoo down: start empty, the stream can still fill in
            log.warning("Could not load today's session so far: %s", exc)
            history, session_day = None, None
        if history is not None and not history.empty:
            for code, group in history.groupby("symbol"):
                market.seed_candles(str(code), candles_from_bars(group))
        feed = feed_factory(market)

    outbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    await outbox.put(
        {
            "type": "snapshot",
            "source": source,
            "session_day": session_day,
            "symbols": {
                code: {
                    "quote": None,
                    "candles": [c.to_json() for c in market.candles(code)],
                }
                for code in codes
            },
        }
    )
    last_tick_at: datetime | None = None
    feed_error: str | None = None

    async def run_feed() -> None:
        nonlocal last_tick_at, feed_error
        try:
            async for tick in feed.stream(codes):
                now = datetime.now(UTC)
                update = market.on_tick(tick, now)
                if update is None:
                    continue
                if update.live:
                    last_tick_at = now
                await outbox.put(
                    {
                        "type": "tick",
                        "symbol": update.symbol,
                        "live": update.live,
                        "quote": quote_json(update.quote),
                        "candle": None if update.candle is None else update.candle.to_json(),
                    }
                )
            if source == "demo":
                feed_error = "Demo day finished"
        except Exception as exc:
            log.exception("Live feed stopped")
            feed_error = f"Price feed stopped: {exc}"

    async def report_status() -> None:
        while True:
            now = datetime.now(UTC)
            delay = market.measured_delay
            market_time = market.market_now(now).astimezone(SYDNEY)
            await outbox.put(
                {
                    "type": "status",
                    "source": source,
                    "feed": getattr(feed, "name", source),
                    "fallback_reason": getattr(feed, "reason", None),
                    "delay_seconds": None if delay is None else round(delay.total_seconds(), 1),
                    "delay_measured": delay is not None,
                    "market_time": market_time.isoformat(timespec="seconds"),
                    "phase": market.phase_at(now).value,
                    "seconds_since_tick": None
                    if last_tick_at is None
                    else round((now - last_tick_at).total_seconds(), 1),
                    "error": feed_error,
                }
            )
            await asyncio.sleep(STATUS_SECONDS)

    async def send_all() -> None:
        while True:
            await websocket.send_json(await outbox.get())

    async def wait_for_disconnect() -> None:
        with contextlib.suppress(WebSocketDisconnect):
            while True:
                await websocket.receive_text()

    tasks = [asyncio.create_task(t()) for t in (run_feed, report_status, send_all)]
    try:
        await wait_for_disconnect()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
