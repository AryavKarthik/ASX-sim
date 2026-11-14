from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime, timedelta
from itertools import pairwise

import pandas as pd
import pytest

from asxsim.live.feeds import (
    DemoFeed,
    FallbackFeed,
    YahooPollingFeed,
    demo_ticks,
    fetch_recent_session,
)
from asxsim.live.quotes import Tick
from tests.conftest import TRADING_DAY, day_bars
from tests.test_recorder import yahoo_frame

T0 = datetime(2026, 11, 12, 23, 0, tzinfo=UTC)


async def collect(stream: AsyncIterator[Tick], limit: int = 1000) -> list[Tick]:
    out: list[Tick] = []
    async for tick in stream:
        out.append(tick)
        if len(out) >= limit:
            break
    return out


# ---------- demo ----------


def test_demo_ticks_walk_each_bar_open_extremes_close() -> None:
    bars = day_bars(symbols=("BHP",)).head(2)
    ticks = demo_ticks(bars)

    assert len(ticks) == 8
    first_bar = bars.iloc[0]
    assert [t.price for t in ticks[:4]] == pytest.approx(
        [first_bar.open, first_bar.low, first_bar.high, first_bar.close]
    )
    assert ticks[3].day_volume == int(first_bar.volume)
    assert all(a.time < b.time for a, b in pairwise(ticks))


def test_demo_feed_paces_ticks_like_the_real_day() -> None:
    clock = {"now": 0.0}
    waits: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        waits.append(seconds)
        clock["now"] += seconds

    feed = DemoFeed(
        day_bars(symbols=("BHP", "CBA")), speed=10, sleep=fake_sleep, monotonic=lambda: clock["now"]
    )
    ticks = asyncio.run(collect(feed.stream(["BHP"]), limit=5))

    assert {t.symbol for t in ticks} == {"BHP"}
    # Trades 15s apart in the market are 1.5s apart at 10x speed.
    assert waits[0] == pytest.approx(1.5)


# ---------- polling ----------


def test_polling_reports_only_the_forming_bar_first_then_changes() -> None:
    frames = iter(
        [
            yahoo_frame(["BHP.AX"], "2026-11-13 10:00", minutes=3),
            yahoo_frame(["BHP.AX"], "2026-11-13 10:00", minutes=4),  # a new minute appears
        ]
    )

    async def no_sleep(_: float) -> None:
        return None

    feed = YahooPollingFeed(fetch=lambda s, a, b: next(frames), sleep=no_sleep, polls=2)
    ticks = asyncio.run(collect(feed.stream(["BHP"])))

    assert [t.time.astimezone(UTC).minute for t in ticks] == [2, 3]  # 10:02 then 10:03 (UTC mins)
    assert all(t.time.second == 59 for t in ticks)


def test_polling_survives_fetch_errors() -> None:
    calls = {"n": 0}

    def flaky(symbols: list[str], start: datetime, end: datetime) -> pd.DataFrame:
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("Yahoo hiccup")
        return yahoo_frame(["BHP.AX"], "2026-11-13 10:00", minutes=2)

    async def no_sleep(_: float) -> None:
        return None

    feed = YahooPollingFeed(fetch=flaky, sleep=no_sleep, polls=2)
    ticks = asyncio.run(collect(feed.stream(["BHP"])))

    assert len(ticks) == 1


# ---------- fallback ----------


class ListFeed:
    def __init__(
        self, name: str, ticks: list[Tick], then: BaseException | None = None, hang: bool = False
    ):
        self.name = name
        self._ticks = ticks
        self._then = then
        self._hang = hang

    async def stream(self, symbols: Sequence[str]) -> AsyncIterator[Tick]:
        for t in self._ticks:
            yield t
        if self._then is not None:
            raise self._then
        if self._hang:
            await asyncio.sleep(3600)


def ticks(n: int, symbol: str = "BHP") -> list[Tick]:
    return [Tick(symbol, 59.0 + i, T0 + timedelta(seconds=i)) for i in range(n)]


def test_fallback_switches_when_the_stream_fails() -> None:
    feed = FallbackFeed(
        ListFeed("stream", ticks(2), then=ConnectionError("dropped")),
        ListFeed("poll", ticks(1, "CBA")),
        should_be_trading=lambda: True,
    )

    got = asyncio.run(collect(feed.stream(["BHP"])))

    assert [t.symbol for t in got] == ["BHP", "BHP", "CBA"]
    assert feed.name == "poll"
    assert feed.reason is not None
    assert "dropped" in feed.reason


def test_fallback_switches_when_the_stream_goes_silent_in_trading_hours() -> None:
    feed = FallbackFeed(
        ListFeed("stream", ticks(1), hang=True),
        ListFeed("poll", ticks(1, "CBA")),
        should_be_trading=lambda: True,
        silence=0.05,
    )

    got = asyncio.run(collect(feed.stream(["BHP"])))

    assert [t.symbol for t in got] == ["BHP", "CBA"]
    assert feed.reason is not None
    assert "no prices" in feed.reason


def test_silence_outside_trading_hours_is_not_a_failure() -> None:
    feed = FallbackFeed(
        ListFeed("stream", [], hang=True),
        ListFeed("poll", ticks(1, "CBA")),
        should_be_trading=lambda: False,
        silence=0.02,
    )

    async def run() -> list[Tick]:
        try:
            return await asyncio.wait_for(collect(feed.stream(["BHP"])), timeout=0.2)
        except TimeoutError:
            return []

    assert asyncio.run(run()) == []
    assert feed.name == "stream"


# ---------- history ----------


def test_fetch_recent_session_keeps_only_the_latest_day() -> None:
    two_days = pd.concat(
        [
            yahoo_frame(["BHP.AX"], "2026-11-12 10:00", minutes=3),
            yahoo_frame(["BHP.AX"], "2026-11-13 10:00", minutes=2),
        ]
    )

    bars, day = fetch_recent_session(["BHP"], fetch=lambda s, a, b: two_days)

    assert day == TRADING_DAY.isoformat()
    assert len(bars) == 2
