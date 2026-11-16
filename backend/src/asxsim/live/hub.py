"""The live hub: one price feed shared by every open browser tab and the trading engine.

Prices flow one way: feed -> LiveMarket (quotes, candles, delayed clock) -> ExecutionEngine
(fills) -> every connected tab. Orders flow back from a tab to the engine. The hub keeps
streaming any stock you hold or have an open order in, even if it isn't on a watchlist,
so positions keep updating and resting orders keep working.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import pandas as pd

from asxsim.data.universe import recording_universe
from asxsim.live.candles import candles_from_bars, sydney_epoch
from asxsim.live.feeds import PriceFeed
from asxsim.live.market import MAX_LIVE_LAG, LiveMarket
from asxsim.live.quotes import Tick
from asxsim.market.calendar import SYDNEY
from asxsim.market.ticks import clean_reported_price
from asxsim.trading.account import Account
from asxsim.trading.engine import ExecutionEngine, MarketQuote, OrderRejectedError
from asxsim.trading.orders import OrderRequest, OrderType, Side, TimeInForce, price_text

log = logging.getLogger("asxsim.live")

STATUS_SECONDS = 1.0
MAX_FEED_SYMBOLS = 40
RECENT_ROWS = 100

FeedFactory = Callable[[LiveMarket], PriceFeed]
HistoryLoader = Callable[[list[str]], tuple[pd.DataFrame, str | None]]


def _round(value: float | None) -> float | None:
    # Yahoo sends float32 values (58.45 arrives as 58.4500007629); 4 decimals removes the noise.
    return None if value is None else round(value, 4)


def quote_json(tick: Tick) -> dict[str, Any]:
    reference = tick.previous_close or tick.open_price
    change = tick.price - reference if reference else None
    return {
        "price": round(tick.price, 4),
        "time": sydney_epoch(tick.time),
        "previous_close": _round(tick.previous_close),
        "open": _round(tick.open_price),
        "day_high": _round(tick.day_high),
        "day_low": _round(tick.day_low),
        "day_volume": tick.day_volume,
        "bid": _round(tick.bid),
        "ask": _round(tick.ask),
        "change": None if change is None else round(change, 4),
        "change_pct": None
        if change is None or not reference
        else round(100 * change / reference, 3),
        "change_basis": "previous close" if tick.previous_close else "open",
    }


def _decimal(value: float | None) -> Decimal | None:
    return None if value is None else clean_reported_price(value)


def parse_order(payload: dict[str, Any]) -> OrderRequest:
    """Turn a browser's order message into an OrderRequest (raises OrderRejectedError)."""
    symbol = str(payload.get("symbol", "")).strip().upper()
    if symbol not in recording_universe():
        raise OrderRejectedError(f"Unknown ASX code {symbol!r}")
    try:
        side = Side(str(payload.get("side")))
        kind = OrderType(str(payload.get("type")))
        time_in_force = TimeInForce(str(payload.get("time_in_force") or "day"))
    except ValueError as exc:
        raise OrderRejectedError("Choose buy or sell, an order type and day or GTC") from exc
    quantity = payload.get("quantity")
    if not isinstance(quantity, int) or isinstance(quantity, bool):
        raise OrderRejectedError("Quantity must be a whole number of shares")

    def number(field: str, label: str, needed: bool) -> Decimal | None:
        raw = payload.get(field)
        if raw in (None, ""):
            if needed:
                raise OrderRejectedError(f"Enter a {label}")
            return None
        try:
            return Decimal(str(raw))
        except InvalidOperation as exc:
            raise OrderRejectedError(f"Enter a valid {label}") from exc

    limit_price = number(
        "limit_price", "limit price", kind in (OrderType.LIMIT, OrderType.STOP_LIMIT)
    )
    trigger_price = number(
        "trigger_price", "trigger price", kind in (OrderType.STOP, OrderType.STOP_LIMIT)
    )
    trailing = kind is OrderType.TRAILING_STOP
    trail_amount = number("trail_amount", "trail amount", False) if trailing else None
    trail_percent = number("trail_percent", "trail percentage", False) if trailing else None
    return OrderRequest(
        symbol,
        side,
        kind,
        quantity,
        limit_price if kind in (OrderType.LIMIT, OrderType.STOP_LIMIT) else None,
        trigger_price if kind in (OrderType.STOP, OrderType.STOP_LIMIT) else None,
        trail_amount,
        trail_percent,
        time_in_force,
    )


def load_engine(path: Path | None) -> ExecutionEngine:
    """Load the saved account, or start a fresh one. A corrupt file is kept aside, not lost."""
    if path is None or not path.exists():
        return ExecutionEngine()
    try:
        return ExecutionEngine.from_json(json.loads(path.read_text(encoding="utf-8")))
    except (ValueError, KeyError, TypeError) as exc:
        backup = path.with_suffix(f".corrupt-{datetime.now(UTC):%Y%m%d%H%M%S}.json")
        path.rename(backup)
        log.error("Saved account couldn't be read (%s); moved it to %s", exc, backup)
        return ExecutionEngine()


class Client:
    """One connected browser tab: what it watches, and messages waiting to be sent to it."""

    def __init__(self, symbols: list[str]) -> None:
        self.symbols = symbols
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()


class LiveHub:
    def __init__(
        self,
        source: str,
        feed_factory: FeedFactory,
        engine: ExecutionEngine | None = None,
        history: HistoryLoader | None = None,
        state_path: Path | None = None,
        max_live_lag: timedelta | None = MAX_LIVE_LAG,
        fixed_symbols: list[str] | None = None,
        session_day: str | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.source = source
        self.engine = engine or ExecutionEngine()
        self.market = LiveMarket([], max_live_lag=max_live_lag)
        self.session_day = session_day
        self.clients: set[Client] = set()
        self.last_tick_at: datetime | None = None
        self.error: str | None = None
        self._feed_factory = feed_factory
        self._feed: PriceFeed | None = None
        self._history = history
        self._state_path = state_path
        self._fixed = fixed_symbols
        self._clock = clock
        self._streaming: tuple[str, ...] = ()
        self._feed_task: asyncio.Task[None] | None = None
        self._status_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ clients

    async def connect(self, symbols: list[str]) -> Client:
        client = Client(symbols)
        self.clients.add(client)
        await self._refresh()
        if self._status_task is None:
            self._status_task = asyncio.create_task(self._status_loop())
        client.queue.put_nowait(self.snapshot(symbols))
        return client

    def disconnect(self, client: Client) -> None:
        self.clients.discard(client)

    async def watch(self, client: Client, symbols: list[str]) -> None:
        client.symbols = symbols
        await self._refresh()
        client.queue.put_nowait(self.snapshot(symbols))

    def broadcast(self, message: dict[str, Any], symbol: str | None = None) -> None:
        for client in self.clients:
            if symbol is None or symbol in client.symbols:
                client.queue.put_nowait(message)

    # ------------------------------------------------------------------ feed

    def wanted_symbols(self) -> list[str]:
        if self._fixed is not None:
            return self._fixed
        wanted: list[str] = []
        held = [s for s, p in self.engine.account.positions.items() if p.quantity]
        working = [o.symbol for o in self.engine.open_orders()]
        for symbol in [*[s for c in self.clients for s in c.symbols], *held, *working]:
            if symbol not in wanted:
                wanted.append(symbol)
        return wanted[:MAX_FEED_SYMBOLS]

    async def _refresh(self) -> None:
        async with self._lock:
            wanted = self.wanted_symbols()
            new = self.market.watch(wanted)
            if new and self._history is not None:
                await self._load_history(new)
            running = self._feed_task is not None and not self._feed_task.done()
            if running and set(wanted) == set(self._streaming):
                return
            if self._feed_task is not None:
                self._feed_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._feed_task
            self._streaming = tuple(wanted)
            self._feed = self._feed_factory(self.market)
            self.error = None
            self._feed_task = asyncio.create_task(self._run_feed(list(wanted)))

    async def _load_history(self, symbols: list[str]) -> None:
        assert self._history is not None
        try:
            bars, day = await asyncio.to_thread(self._history, symbols)
        except Exception as exc:  # Yahoo down: charts start empty, the stream fills in
            log.warning("Couldn't load the session so far: %s", exc)
            return
        if day is not None and (self.session_day is None or day > self.session_day):
            self.session_day = day
        if bars.empty:
            return
        for code, group in bars.groupby("symbol"):
            if not self.market.candles(str(code)):
                self.market.seed_candles(str(code), candles_from_bars(group))

    async def _run_feed(self, symbols: list[str]) -> None:
        assert self._feed is not None
        try:
            async for tick in self._feed.stream(symbols):
                self.on_tick(tick)
            if self.source == "demo":
                self.error = "Demo day finished"
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("Price feed stopped")
            self.error = f"Price feed stopped: {exc}"

    def on_tick(self, tick: Tick) -> None:
        now = self._clock()
        update = self.market.on_tick(tick, now)
        if update is None:
            return
        price = clean_reported_price(tick.price)
        bid, ask = _decimal(tick.bid), _decimal(tick.ask)
        minute_volume = self.market.previous_minute_volume(tick.symbol, tick.time)
        fills = []
        if update.live:
            self.last_tick_at = now
            fills = self.engine.on_tick(
                tick.symbol, price, tick.time, update.volume, bid, ask, minute_volume
            )
        else:
            # A stale snapshot (e.g. last close) may refresh price estimates but must never
            # fill an order at an old price.
            self.engine.quotes[tick.symbol] = MarketQuote(price, bid, ask, minute_volume)
        self.broadcast(
            {
                "type": "tick",
                "symbol": update.symbol,
                "live": update.live,
                "quote": quote_json(update.quote),
                "candle": None if update.candle is None else update.candle.to_json(),
            },
            symbol=update.symbol,
        )
        # Fills, or an open order that changed without filling (a trailing stop's trigger
        # moved), are saved and shown.
        if self.engine.take_changes() or fills:
            self.save()
            self.broadcast(
                {
                    "type": "account",
                    "account": self.account_json(),
                    "fills": [f.to_json() for f in fills],
                }
            )

    # ------------------------------------------------------------------ status

    def status(self) -> dict[str, Any]:
        now = self._clock()
        delay = self.market.measured_delay
        return {
            "type": "status",
            "source": self.source,
            "feed": getattr(self._feed, "name", self.source),
            "fallback_reason": getattr(self._feed, "reason", None),
            "delay_seconds": None if delay is None else round(delay.total_seconds(), 1),
            "delay_measured": delay is not None,
            "market_time": self.market.market_now(now)
            .astimezone(SYDNEY)
            .isoformat(timespec="seconds"),
            "phase": self.market.phase_at(now).value,
            "seconds_since_tick": None
            if self.last_tick_at is None
            else round((now - self.last_tick_at).total_seconds(), 1),
            "error": self.error,
        }

    async def _status_loop(self) -> None:
        while True:
            expired = self.engine.expire(self.market.market_now(self._clock()))
            if expired:
                self.save()
                self.broadcast({"type": "account", "account": self.account_json(), "fills": []})
            self.broadcast(self.status())
            await asyncio.sleep(STATUS_SECONDS)

    # ------------------------------------------------------------------ trading

    def submit(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = parse_order(payload)
        order, fills = self.engine.submit(request, self.market.market_now(self._clock()))
        self.save()
        self.broadcast(
            {
                "type": "account",
                "account": self.account_json(),
                "fills": [f.to_json() for f in fills],
            }
        )
        return order.to_view()

    def cancel(self, order_id: str) -> dict[str, Any]:
        order = self.engine.cancel(order_id, self.market.market_now(self._clock()))
        self.save()
        self.broadcast({"type": "account", "account": self.account_json(), "fills": []})
        return order.to_view()

    def reset(self, starting_cash: Decimal) -> None:
        if not Decimal("1000") <= starting_cash <= Decimal("10000000"):
            raise OrderRejectedError("Starting cash must be between $1,000 and $10,000,000")
        self.engine.account = Account.opened_with(starting_cash.quantize(Decimal("0.01")))
        self.engine.orders = {}
        self.save()
        self.broadcast({"type": "account", "account": self.account_json(), "fills": []})

    def account_json(self) -> dict[str, Any]:
        engine, account = self.engine, self.engine.account
        prices = {s: q.last for s, q in engine.quotes.items()}
        positions = []
        for symbol, p in account.positions.items():
            if not p.quantity:
                continue
            last = prices.get(symbol)
            value = None if last is None else last * p.quantity
            unrealised = None if value is None else value - p.cost
            positions.append(
                {
                    "symbol": symbol,
                    "quantity": p.quantity,
                    "average_price": price_text(p.average_price or Decimal("0")),
                    "last_price": None if last is None else price_text(last),
                    "market_value": None if value is None else str(round(value, 2)),
                    "unrealised": None if unrealised is None else str(round(unrealised, 2)),
                    "unrealised_pct": None
                    if unrealised is None or not p.cost
                    else round(float(100 * unrealised / p.cost), 2),
                    "realised": str(round(p.realised, 2)),
                }
            )
        equity = account.equity(prices)
        orders = sorted(engine.orders.values(), key=lambda o: o.created_at, reverse=True)
        today = self.market.market_now(self._clock()).astimezone(SYDNEY).date()
        return {
            "starting_cash": str(account.starting_cash),
            "cash": str(round(account.cash, 2)),
            "settled_cash": str(round(account.settled_cash(today), 2)),
            "pending_settlement": [
                {"date": day.isoformat(), "amount": str(round(amount, 2))}
                for day, amount in account.pending_settlement(today)
            ],
            "buying_power": str(round(engine.buying_power(), 2)),
            "market_value": str(round(account.market_value(prices), 2)),
            "equity": str(round(equity, 2)),
            "unrealised": str(round(account.unrealised(prices), 2)),
            "realised": str(round(account.realised, 2)),
            "fees": str(round(account.fees_paid, 2)),
            "net_pnl": str(round(equity - account.starting_cash, 2)),
            "positions": positions,
            "orders": [o.to_view() for o in orders[:RECENT_ROWS]],
            "fills": [f.to_json() for f in reversed(account.fills[-RECENT_ROWS:])],
            "brokerage": engine.brokerage.to_json(),
        }

    def snapshot(self, symbols: list[str]) -> dict[str, Any]:
        def symbol_data(code: str) -> dict[str, Any]:
            quote = self.market.quote(code) if code in self.market.symbols else None
            candles = self.market.candles(code) if code in self.market.symbols else []
            return {
                "quote": None if quote is None else quote_json(quote),
                "candles": [c.to_json() for c in candles],
            }

        return {
            "type": "snapshot",
            "source": self.source,
            "session_day": self.session_day,
            "symbols": {code: symbol_data(code) for code in symbols},
            "account": self.account_json(),
        }

    def save(self) -> None:
        if self._state_path is None:
            return
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.engine.to_json(), indent=1), encoding="utf-8")
        tmp.replace(self._state_path)  # atomic: never a half-written account

    async def close(self) -> None:
        for task in (self._feed_task, self._status_task):
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
