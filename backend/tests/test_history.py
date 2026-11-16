from collections.abc import Iterator
from datetime import date

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from asxsim.api.app import app
from asxsim.data import history


def yahoo_daily(days: list[str]) -> pd.DataFrame:
    index = pd.DatetimeIndex([pd.Timestamp(d, tz="Australia/Sydney") for d in days], name="Date")
    n = len(days)
    return pd.DataFrame(
        {
            "Open": [50.0 + i for i in range(n)],
            "High": [51.0 + i for i in range(n)],
            "Low": [49.0 + i for i in range(n)],
            "Close": [50.5 + i for i in range(n)],
            "Volume": [1000 * (i + 1) for i in range(n)],
        },
        index=index,
    )


# Mon 9 - Fri 13 Nov 2026, then Mon 16 Nov.
WEEK = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16"]


@pytest.fixture(autouse=True)
def fresh_cache() -> Iterator[None]:
    history.clear_cache()
    yield
    history.clear_cache()


def test_daily_bars_are_cut_off_before_until() -> None:
    frame = yahoo_daily(WEEK[:3])

    bars = history.history("BHP", "1d", until=date(2026, 11, 11), fetch=lambda s: frame)

    assert [b["date"] for b in bars] == ["2026-11-09", "2026-11-10"]  # the demo day is hidden
    assert bars[0]["close"] == 50.5
    assert bars[1]["volume"] == 2000


def test_weekly_bars_are_built_after_the_cut_off_so_they_cannot_leak_the_future() -> None:
    frame = yahoo_daily(WEEK)

    bars = history.history("BHP", "1wk", until=date(2026, 11, 13), fetch=lambda s: frame)

    # Mon-Thu only: Friday's close (54.5) and high (55) must not appear in Monday's weekly bar.
    assert bars == [
        {
            "time": bars[0]["time"],
            "date": "2026-11-09",
            "open": 50.0,
            "high": 54.0,
            "low": 49.0,
            "close": 53.5,
            "volume": 1000 + 2000 + 3000 + 4000,
        }
    ]


def test_weekly_and_monthly_grouping() -> None:
    frame = yahoo_daily([*WEEK, "2026-12-01"])

    weekly = history.history("BHP", "1wk", fetch=lambda s: frame)
    monthly = history.history("BHP", "1mo", fetch=lambda s: frame)

    assert [b["date"] for b in weekly] == ["2026-11-09", "2026-11-16", "2026-12-01"]
    assert [b["date"] for b in monthly] == ["2026-11-09", "2026-12-01"]
    assert monthly[0]["close"] == 55.5  # the last November close
    assert monthly[0]["high"] == 56.0


def test_history_is_fetched_once_and_cached_for_an_hour() -> None:
    calls: list[str] = []

    def fetch(symbol: str) -> pd.DataFrame:
        calls.append(symbol)
        return yahoo_daily(WEEK)

    clock = {"t": 0.0}
    history.history("BHP", "1d", fetch=fetch, now=lambda: clock["t"])
    history.history("BHP", "1wk", fetch=fetch, now=lambda: clock["t"])  # same daily data
    clock["t"] = 4000
    history.history("BHP", "1d", fetch=fetch, now=lambda: clock["t"])

    assert calls == ["BHP.AX", "BHP.AX"]  # refreshed after an hour


def test_rejects_unknown_intervals() -> None:
    with pytest.raises(ValueError, match="Interval"):
        history.history("BHP", "5m")


def test_history_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(history, "yahoo_daily", lambda s: yahoo_daily(WEEK))
    client = TestClient(app)

    body = client.get(
        "/api/live/history", params={"symbol": "bhp", "interval": "1d", "until": "2026-11-13"}
    ).json()
    assert body["symbol"] == "BHP"
    assert len(body["bars"]) == 4

    assert client.get("/api/live/history", params={"symbol": "ZZZ"}).status_code == 404
    bad = client.get("/api/live/history", params={"symbol": "BHP", "interval": "5m"})
    assert bad.status_code == 422
