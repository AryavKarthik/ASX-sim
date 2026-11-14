"""Where live prices come from.

Every feed has the same shape: give it ASX codes, and it yields `Tick`s in the order they
happen. That keeps the rest of the app independent of the source (ADR 0007):

- `YahooStreamFeed`  pushes each delayed price update as Yahoo publishes it (main source)
- `YahooPollingFeed` asks for 1-minute bars every few seconds (fallback)
- `FallbackFeed`     uses the stream and switches to polling if the stream fails or goes
                     quiet while the market should be trading
- `DemoFeed`         plays a recorded day as if it were live (weekends, testing; labelled)

A paid real-time feed would be one more class with the same `stream` method.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time as _time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

import pandas as pd

from asxsim.data.recorder import to_long, yahoo_fetch
from asxsim.data.universe import yahoo_symbol
from asxsim.live.quotes import Tick, parse_yahoo_message
from asxsim.market.calendar import SYDNEY

log = logging.getLogger("asxsim.live")


class PriceFeed(Protocol):
    name: str

    def stream(self, symbols: Sequence[str]) -> AsyncIterator[Tick]: ...


# ---------------------------------------------------------------- Yahoo stream


class YahooStreamFeed:
    """Yahoo Finance's streaming endpoint (via yfinance.AsyncWebSocket)."""

    name = "yahoo-stream"

    async def stream(self, symbols: Sequence[str]) -> AsyncIterator[Tick]:
        import yfinance as yf  # lazy: tests never open a network connection

        yahoo_to_code = {yahoo_symbol(code): code for code in symbols}
        messages: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        socket = yf.AsyncWebSocket(verbose=False)
        await socket.subscribe(list(yahoo_to_code))
        listener = asyncio.create_task(socket.listen(messages.put_nowait))
        try:
            while True:
                getter = asyncio.create_task(messages.get())
                done, _ = await asyncio.wait(
                    {getter, listener}, return_when=asyncio.FIRST_COMPLETED
                )
                if getter not in done:
                    getter.cancel()
                    listener.result()  # re-raise whatever stopped the stream
                    raise ConnectionError("Yahoo price stream stopped")
                tick = parse_yahoo_message(getter.result(), yahoo_to_code)
                if tick is not None:
                    yield tick
        finally:
            listener.cancel()
            with contextlib.suppress(Exception):
                await socket.close()


# ---------------------------------------------------------------- Yahoo polling


BarFetcher = Callable[[list[str], datetime, datetime], pd.DataFrame]


class YahooPollingFeed:
    """Fallback: fetch today's 1-minute bars every `interval` seconds and emit what changed.

    Coarser than the stream (one price per minute, up to `interval` seconds late), but it
    keeps the session going if the stream is unavailable.
    """

    name = "yahoo-poll"

    def __init__(
        self,
        interval: float = 15.0,
        fetch: BarFetcher | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        polls: int | None = None,  # stop after this many polls (for tests)
    ) -> None:
        self.interval = interval
        self._fetch = fetch or yahoo_fetch
        self._sleep = sleep
        self._polls = polls

    async def stream(self, symbols: Sequence[str]) -> AsyncIterator[Tick]:
        yahoo_to_code = {yahoo_symbol(code): code for code in symbols}
        seen: dict[tuple[str, pd.Timestamp], tuple[float, int]] = {}
        first = True  # until a fetch succeeds, history hasn't been looked at yet
        count = 0
        while self._polls is None or count < self._polls:
            count += 1
            end = datetime.now(UTC)
            try:
                raw = await asyncio.to_thread(
                    self._fetch, list(yahoo_to_code), end - timedelta(hours=12), end
                )
                bars = to_long(raw, yahoo_to_code)
            except Exception as exc:  # network trouble: try again next interval
                log.warning("Polling fetch failed: %s", exc)
                await self._sleep(self.interval)
                continue

            latest = bars.groupby("symbol")["ts"].transform("max")
            rows = zip(
                bars["symbol"].astype(str),
                pd.DatetimeIndex(bars["ts"]),
                bars["close"].astype(float),
                bars["volume"].astype(int),
                pd.DatetimeIndex(latest),
                strict=True,
            )
            for symbol, ts, close, volume, symbol_latest in rows:
                key = (symbol, ts)
                value = (close, volume)
                previous = seen.get(key)
                seen[key] = value
                # On the first look, history is loaded separately: only report each
                # symbol's current (still forming) bar.
                if first and ts != symbol_latest:
                    continue
                if previous == value:
                    continue
                added = volume - (previous[1] if previous else 0)
                yield Tick(
                    symbol=symbol,
                    price=close,
                    time=ts.to_pydatetime() + timedelta(seconds=59),
                    last_size=max(0, added),
                )
            first = False
            await self._sleep(self.interval)


# ---------------------------------------------------------------- fallback


class FallbackFeed:
    """Prefer the primary feed; switch to the fallback if it errors or goes silent.

    "Silent" only counts while `should_be_trading()` is true, so a quiet stream overnight or
    on a weekend is normal, not a failure.
    """

    def __init__(
        self,
        primary: PriceFeed,
        fallback: PriceFeed,
        should_be_trading: Callable[[], bool],
        silence: float = 90.0,
    ) -> None:
        self._primary = primary
        self._fallback = fallback
        self._should_be_trading = should_be_trading
        self._silence = silence
        self.name = primary.name
        self.reason: str | None = None

    async def stream(self, symbols: Sequence[str]) -> AsyncIterator[Tick]:
        queue: asyncio.Queue[Tick | BaseException] = asyncio.Queue()

        async def pump() -> None:
            try:
                async for tick in self._primary.stream(symbols):
                    await queue.put(tick)
                await queue.put(ConnectionError(f"{self._primary.name} ended"))
            except Exception as exc:
                await queue.put(exc)

        task = asyncio.create_task(pump())
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=self._silence)
                except TimeoutError:
                    if self._should_be_trading():
                        self.reason = f"no prices for {self._silence:.0f}s during trading hours"
                        break
                    continue
                if isinstance(item, BaseException):
                    self.reason = f"{self._primary.name} failed: {item}"
                    break
                yield item
        finally:
            task.cancel()

        log.warning("Switching to %s: %s", self._fallback.name, self.reason)
        self.name = self._fallback.name
        async for tick in self._fallback.stream(symbols):
            yield tick


# ---------------------------------------------------------------- demo


def demo_ticks(bars: pd.DataFrame) -> list[Tick]:
    """Turn recorded 1-minute bars into a believable sequence of trades.

    Each bar becomes four trades inside its minute: open, then low and high (in the order
    the candle's colour suggests), then close, with the bar's volume split between them.
    """
    ticks: list[Tick] = []
    for symbol, group in bars.sort_values("ts").groupby("symbol"):
        day_open = float(group["open"].iloc[0])
        day_high, day_low, day_volume = day_open, day_open, 0
        rows = zip(
            pd.DatetimeIndex(group["ts"]),
            group["open"].astype(float),
            group["high"].astype(float),
            group["low"].astype(float),
            group["close"].astype(float),
            group["volume"].astype(int),
            strict=True,
        )
        for ts, o, h, lo, c, v in rows:
            path = [o, lo, h, c] if c >= o else [o, h, lo, c]
            sizes = [v // 4] * 3 + [v - 3 * (v // 4)]
            start = ts.to_pydatetime()
            for offset, price, size in zip((5, 20, 35, 55), path, sizes, strict=True):
                day_high, day_low, day_volume = (
                    max(day_high, price),
                    min(day_low, price),
                    day_volume + size,
                )
                ticks.append(
                    Tick(
                        symbol=str(symbol),
                        price=price,
                        time=start + timedelta(seconds=offset),
                        day_volume=day_volume,
                        last_size=size,
                        day_high=day_high,
                        day_low=day_low,
                        open_price=day_open,
                    )
                )
    ticks.sort(key=lambda t: t.time)
    return ticks


class DemoFeed:
    """Plays a recorded trading day from the open, in real time (or faster), as if live."""

    name = "demo"

    def __init__(
        self,
        bars: pd.DataFrame,
        speed: float = 1.0,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        monotonic: Callable[[], float] = _time.monotonic,
    ) -> None:
        self._bars = bars
        self.speed = speed
        self._sleep = sleep
        self._monotonic = monotonic

    async def stream(self, symbols: Sequence[str]) -> AsyncIterator[Tick]:
        ticks = demo_ticks(self._bars[self._bars["symbol"].isin(list(symbols))])
        if not ticks:
            return
        anchor_market = ticks[0].time
        anchor_wall = self._monotonic()
        for tick in ticks:
            due = (tick.time - anchor_market).total_seconds() / self.speed
            wait = due - (self._monotonic() - anchor_wall)
            if wait > 0:
                await self._sleep(wait)
            yield tick


# ---------------------------------------------------------------- history


def fetch_recent_session(
    symbols: Sequence[str], fetch: BarFetcher | None = None
) -> tuple[pd.DataFrame, str | None]:
    """The latest trading session's 1-minute bars so far (today's, or the last one).

    Used to fill the chart when live mode opens part-way through a day (or at the weekend).
    Returns the bars and the session date (YYYY-MM-DD), or None if nothing came back.
    """
    yahoo_to_code = {yahoo_symbol(code): code for code in symbols}
    end = datetime.now(UTC)
    raw = (fetch or yahoo_fetch)(list(yahoo_to_code), end - timedelta(days=6), end)
    bars = to_long(raw, yahoo_to_code)
    if bars.empty:
        return bars, None
    session = bars["ts"].dt.tz_convert(SYDNEY).dt.date
    latest = session.max()
    return bars[session == latest].reset_index(drop=True), latest.isoformat()
