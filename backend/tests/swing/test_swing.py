"""Swing practice: daily-bar fills, no peeking, blind mode, results, saving, and the API."""

from __future__ import annotations

import random
from collections.abc import Iterator
from datetime import date, timedelta
from decimal import Decimal as D  # noqa: N817
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from asxsim.api import swing as swing_api
from asxsim.api.app import app
from asxsim.swing.session import BLIND_EPOCH, SwingError, SwingOrder, SwingSession, fill_price
from asxsim.swing.store import SwingStore


def bar(day: str, o: float, h: float, lo: float, c: float) -> dict[str, Any]:
    return {"date": day, "open": o, "high": h, "low": lo, "close": c, "volume": 1000}


def session(rows: list[tuple[float, float, float, float]], cash: str = "10000") -> SwingSession:
    """A session whose first row is "today"; each later row is one more trading day."""
    start = date(2026, 1, 5)
    bars = [bar((start + timedelta(days=i)).isoformat(), *r) for i, r in enumerate(rows)]
    return SwingSession("BHP", "BHP Group", bars, 0, D(cash))


FLAT = (50.0, 50.5, 49.5, 50.0)

# ---------- how orders fill on a daily bar ----------


def order(side: str, kind: str, price: str | None = None) -> SwingOrder:
    return SwingOrder(1, side, kind, 100, None if price is None else D(price), 0)


@pytest.mark.parametrize(
    ("side", "kind", "price", "ohlc", "expected"),
    [
        ("buy", "market", None, (51, 52, 50, 51.5), "51"),  # the next open
        ("buy", "limit", "50", (51, 52, 50.5, 51), None),  # never came down to it
        ("buy", "limit", "50", (51, 52, 49.8, 51), "50"),  # traded down through the limit
        ("buy", "limit", "50", (49, 50, 48, 49.5), "49"),  # gapped below: the better price
        ("sell", "limit", "55", (54, 56, 53, 55), "55"),
        ("sell", "limit", "55", (57, 58, 56, 57), "57"),  # gapped above: the better price
        ("sell", "stop", "48", (49, 50, 48.5, 49), None),  # held above the stop
        ("sell", "stop", "48", (49, 50, 47, 47.5), "48"),  # fell through the stop
        ("sell", "stop", "48", (45, 46, 44, 45), "45"),  # gapped below: the worse price
        ("buy", "stop", "52", (51, 53, 50, 52.5), "52"),
        ("buy", "stop", "52", (54, 55, 53, 54), "54"),  # gapped above: the worse price
    ],
)
def test_fill_prices(
    side: str,
    kind: str,
    price: str | None,
    ohlc: tuple[float, float, float, float],
    expected: str | None,
) -> None:
    got = fill_price(order(side, kind, price), bar("2026-01-06", *ohlc))
    assert got == (None if expected is None else D(expected))


# ---------- a session ----------


def test_market_order_fills_at_the_next_open_with_brokerage() -> None:
    s = session([FLAT, (51.0, 52.0, 50.5, 51.5)])
    s.place("buy", "market", 100)
    assert s.quantity == 0  # nothing happens until the next day

    filled = s.advance()

    assert [(o.fill_price, o.fee) for o in filled] == [(D("51.0"), D("10.00"))]
    assert s.cash == D("10000") - D("5100") - D("10")
    assert s.equity[-1] == s.cash + 100 * D("51.5")


def test_stop_protects_but_a_gap_fills_at_the_open() -> None:
    s = session([FLAT, FLAT, (45.0, 46.0, 44.0, 45.0)])
    s.place("buy", "market", 100)
    s.advance()
    s.place("sell", "stop", 100, D("48.00"))

    filled = s.advance()

    assert filled[0].fill_price == D("45.0")  # not $48: the price opened below the stop
    # Bought 100 @ 50 (+$10), sold @ 45 (-$10): -$520.
    assert filled[0].pnl == D("-520.00")
    assert s.quantity == 0
    assert s.summary()["wins"] == 0


def test_orders_stay_open_until_they_fill_or_are_cancelled() -> None:
    s = session([FLAT, FLAT, FLAT, (48.0, 48.5, 47.0, 47.5), FLAT])
    limit = s.place("buy", "limit", 100, D("48.00"))
    s.advance(2)
    assert limit.status == "working"

    s.advance()
    assert limit.status == "filled"
    assert limit.fill_price == D("48.0")

    other = s.place("sell", "limit", 100, D("60.00"))
    s.cancel(other.id)
    assert other.status == "cancelled"
    with pytest.raises(SwingError, match="already cancelled"):
        s.cancel(other.id)


def test_rules_are_checked_when_an_order_is_placed() -> None:
    s = session([FLAT, FLAT])
    with pytest.raises(SwingError, match="Not enough cash"):
        s.place("buy", "market", 500)  # $25,000 against $10,000
    with pytest.raises(SwingError, match="at most 0 shares"):
        s.place("sell", "market", 10)
    with pytest.raises(SwingError, match="below the last close"):
        s.place("sell", "stop", 10, D("51.00"))
    with pytest.raises(SwingError, match="steps of"):
        s.place("buy", "limit", 10, D("49.995"))  # half-cent prices only exist under $2
    with pytest.raises(SwingError, match="above zero"):
        s.place("buy", "market", 0)
    s.place("buy", "limit", 190, D("50.00"))  # reserves $9,510
    with pytest.raises(SwingError, match="Not enough cash"):
        s.place("buy", "limit", 20, D("50.00"))


def test_a_buy_is_rejected_if_the_price_gaps_beyond_your_cash() -> None:
    s = session([FLAT, (60.0, 61.0, 59.0, 60.0)])
    big = s.place("buy", "market", 199)  # affordable at $50, not at $60

    assert s.advance() == []
    assert big.status == "rejected"
    assert "Not enough cash" in (big.note or "")
    assert s.cash == D("10000")


def test_the_browser_never_sees_past_the_current_day() -> None:
    s = session([FLAT, (51.0, 52.0, 50.0, 51.0), (99.0, 99.0, 99.0, 99.0)])
    s.advance()

    view = s.to_view()

    assert len(view["bars"]) == 2
    assert "99" not in str(view)
    assert view["day"] == 1
    assert view["total_days"] == 2
    assert view["finished"] is False
    with pytest.raises(SwingError, match="at least one day"):
        s.advance(0)


def test_session_ends_at_the_last_bar_and_compares_with_buy_and_hold() -> None:
    s = session([FLAT, (50.0, 51.0, 49.0, 50.0), (55.0, 56.0, 54.0, 55.0)])
    s.place("buy", "market", 100)

    s.advance(10)  # more days than exist: stops at the end

    assert s.finished
    summary = s.summary()
    assert summary["buy_hold_pct"] == 10.0  # 50 -> 55
    assert summary["return_pct"] == pytest.approx(4.9)  # 100 shares x $5, less $10 brokerage
    assert summary["days_invested_pct"] == 100.0
    with pytest.raises(SwingError, match="finished"):
        s.place("sell", "market", 100)


def test_drawdown_is_the_worst_fall_from_a_peak() -> None:
    s = session([FLAT, FLAT, (60.0, 60.0, 60.0, 60.0), (45.0, 45.0, 45.0, 45.0)], cash="5010")
    s.place("buy", "market", 100)
    s.advance(3)
    # Equity: 5010, 5000, 6000, 4500 -> worst fall is 6000 to 4500 = 25%.
    assert s.summary()["max_drawdown_pct"] == 25.0


def test_blind_mode_hides_the_stock_and_dates_until_the_end() -> None:
    s = session([FLAT, FLAT, FLAT])
    s.blind = True
    s.advance()

    view = s.to_view()
    assert view["symbol"] is None
    assert view["name"] == "Mystery stock"
    assert view["date"] is None
    assert view["bars"][0]["time"] == BLIND_EPOCH
    assert "2026-01" not in str(view)

    s.advance()
    revealed = s.to_view()
    assert revealed["symbol"] == "BHP"
    assert revealed["date"] == "2026-01-07"


def test_a_session_survives_saving_and_loading() -> None:
    s = session([FLAT, (51.0, 52.0, 50.5, 51.5), FLAT])
    s.place("buy", "market", 100)
    s.advance()
    s.place("sell", "stop", 100, D("49.00"))

    copy = SwingSession.from_json(s.to_json())

    assert copy.to_view() == s.to_view()


# ---------- the store ----------


def long_history(n: int = 700) -> list[dict[str, Any]]:
    start = date(2020, 1, 1)
    return [
        bar((start + timedelta(days=i)).isoformat(), 50, 51, 49, 50 + i / 100) for i in range(n)
    ]


def make_store(tmp_path: Path | None = None, seed: int = 1) -> SwingStore:
    return SwingStore(
        lambda code, before: [b for b in long_history() if b["date"] < before.isoformat()],
        {"BHP": "BHP Group", "CBA": "Commonwealth Bank"},
        None if tmp_path is None else tmp_path / "swing.json",
        random.Random(seed),
        today=lambda: date(2026, 11, 17),
    )


def test_store_starts_on_the_chosen_date_with_a_year_of_chart_before_it() -> None:
    store = make_store()
    _, s = store.create("BHP", date(2021, 6, 1), 63, D("50000"), blind=False)

    view = s.to_view()
    assert view["start_date"] == "2021-06-01"
    assert view["total_days"] == 63
    assert len(view["bars"]) == 251  # 250 earlier days, plus the first day
    assert len(s.bars) == 251 + 63  # the practice period is held server-side only


def test_store_picks_a_surprise_stock_and_a_random_date() -> None:
    a = make_store(seed=1).create(None, None, 126, D("50000"), blind=True)[1]
    b = make_store(seed=2).create(None, None, 126, D("50000"), blind=True)[1]

    assert a.symbol in ("BHP", "CBA")
    assert a.bars[a.first]["date"] != b.bars[b.first]["date"]
    assert len(a.bars) - 1 - a.first == 126


def test_store_refuses_periods_that_dont_fit() -> None:
    store = make_store()
    with pytest.raises(SwingError, match="latest possible start"):
        store.create("BHP", date(2021, 11, 1), 252, D("50000"), blind=False)
    with pytest.raises(SwingError, match="enough price history"):
        store.create("BHP", None, 690, D("50000"), blind=False)
    with pytest.raises(SwingError, match="Unknown ASX code"):
        store.create("ZZZ", None, 63, D("50000"), blind=False)
    with pytest.raises(SwingError, match="Starting cash"):
        store.create("BHP", None, 63, D("5"), blind=False)


def test_store_saves_sessions_and_keeps_only_recent_ones(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    key, s = store.create("BHP", date(2021, 6, 1), 63, D("50000"), blind=False)
    s.place("buy", "market", 100)
    s.advance(5)
    store.save()

    reloaded = make_store(tmp_path)
    assert reloaded.get(key).to_view() == s.to_view()
    assert reloaded.recent()[0]["day"] == 5

    for _ in range(12):
        store.create("BHP", None, 63, D("50000"), blind=False)
    assert len(store.recent()) == 10
    with pytest.raises(KeyError):
        store.get(key)


# ---------- the API ----------


@pytest.fixture
def client() -> Iterator[TestClient]:
    store = make_store()
    app.dependency_overrides[swing_api.get_swing_store] = lambda: store
    yield TestClient(app)
    app.dependency_overrides.pop(swing_api.get_swing_store, None)


def test_api_runs_a_session_end_to_end(client: TestClient) -> None:
    assert client.get("/api/swing/options").json()["periods"][0] == {
        "label": "3 months",
        "days": 63,
    }

    created = client.post(
        "/api/swing/sessions", json={"symbol": "bhp", "start": "2021-06-01", "days": 63}
    )
    assert created.status_code == 201
    key = created.json()["id"]

    placed = client.post(
        f"/api/swing/sessions/{key}/orders", json={"side": "buy", "type": "market", "quantity": 100}
    )
    assert placed.json()["orders"][0]["status"] == "working"

    moved = client.post(f"/api/swing/sessions/{key}/advance", json={"days": 5}).json()
    assert moved["day"] == 5
    assert moved["position"]["quantity"] == 100
    assert moved["filled"][0]["side"] == "buy"
    assert len(moved["curve"]) == 6

    stop = client.post(
        f"/api/swing/sessions/{key}/orders",
        json={"side": "sell", "type": "stop", "quantity": 100, "price": "45.00"},
    ).json()
    cancelled = client.delete(f"/api/swing/sessions/{key}/orders/{stop['orders'][0]['id']}")
    assert cancelled.json()["orders"][0]["status"] == "cancelled"

    assert client.get("/api/swing/sessions").json()["sessions"][0]["id"] == key
    assert client.get(f"/api/swing/sessions/{key}").json()["day"] == 5


def test_api_errors_are_readable(client: TestClient) -> None:
    bad = client.post("/api/swing/sessions", json={"symbol": "ZZZ"})
    assert bad.status_code == 400
    assert "Unknown ASX code" in bad.json()["detail"]
    assert client.get("/api/swing/sessions/nope").status_code == 404

    key = client.post("/api/swing/sessions", json={"symbol": "BHP"}).json()["id"]
    refused = client.post(
        f"/api/swing/sessions/{key}/orders", json={"side": "sell", "type": "market", "quantity": 5}
    )
    assert refused.status_code == 400
    assert "Short selling" in refused.json()["detail"]
    odd = client.post(
        f"/api/swing/sessions/{key}/orders",
        json={"side": "buy", "type": "limit", "quantity": 5, "price": "abc"},
    )
    assert odd.status_code == 400
