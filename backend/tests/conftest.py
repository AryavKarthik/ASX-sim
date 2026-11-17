"""Shared test fixtures: a small, realistic recorded trading day on disk."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date, datetime, time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from asxsim.data.recorder import write_daily
from asxsim.data.store import LocalBarStore
from asxsim.market.calendar import SYDNEY

TRADING_DAY = date(2026, 11, 13)  # a Friday


def day_bars(day: date = TRADING_DAY, symbols: tuple[str, ...] = ("BHP", "CBA")) -> pd.DataFrame:
    """Bars shaped like a real recorded day: 10:00-15:59 plus the 16:10/16:11 auction bars."""
    session = pd.date_range(
        datetime.combine(day, time(10, 0), tzinfo=SYDNEY), periods=360, freq="1min"
    )
    auction = pd.DatetimeIndex(
        [datetime.combine(day, time(16, m), tzinfo=SYDNEY) for m in (10, 11)]
    )
    stamps = pd.DatetimeIndex(session.append(auction))
    frames = []
    for i, sym in enumerate(symbols):
        base = 40.0 + 60 * i + np.sin(np.arange(len(stamps)) / 30)
        frames.append(
            pd.DataFrame(
                {
                    "symbol": sym,
                    "ts": stamps.tz_convert("UTC"),
                    "open": base,
                    "high": base + 0.05,
                    "low": base - 0.05,
                    "close": base + 0.01,
                    "volume": 1000 + i,
                }
            )
        )
    return pd.concat(frames, ignore_index=True)


@pytest.fixture
def bar_store(tmp_path: Path) -> LocalBarStore:
    write_daily(day_bars(), tmp_path)
    return LocalBarStore(tmp_path)


@pytest.fixture(autouse=True)
def coach_switched_off() -> Iterator[None]:
    """Tests never read the real .env or call the real API: the coach is off unless a test
    installs a fake one."""
    from asxsim.api import live
    from asxsim.api.app import app
    from asxsim.coach.service import Coach

    app.dependency_overrides[live.get_coach] = lambda: Coach(None)
    yield
    app.dependency_overrides.pop(live.get_coach, None)
