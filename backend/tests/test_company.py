from collections.abc import Iterator
from datetime import date, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from asxsim.api.app import app
from asxsim.data import company, history
from tests.test_history import yahoo_daily

INFO: dict[str, Any] = {
    "longName": "BHP Group Limited",
    "quoteType": "EQUITY",
    "sector": "Basic Materials",
    "industry": "Other Industrial Metals & Mining",
    "longBusinessSummary": " BHP Group Limited operates as a resources company. ",
    "website": "https://www.bhp.com",
    "city": "Melbourne",
    "country": "Australia",
    "fullTimeEmployees": 38833,
    "trailingEps": 2.77,
    "trailingAnnualDividendRate": 1.72,
    "bookValue": 14.26,
    "sharesOutstanding": 5_082_953_802,
    "totalRevenue": 58_759_999_488,
    "profitMargins": 0.16734,
    "beta": 0.886,
    "exDividendDate": 1788393600,
    "financialCurrency": "USD",
    "currency": "AUD",
    # Price-dependent values Yahoo also sends: these must never be passed on.
    "marketCap": 280_884_019_200,
    "trailingPE": 19.95,
    "dividendYield": 4.11,
    "fiftyTwoWeekHigh": 68.77,
    "currentPrice": 57.21,
}


@pytest.fixture(autouse=True)
def fresh_caches() -> Iterator[None]:
    company.clear_cache()
    history.clear_cache()
    yield
    company.clear_cache()
    history.clear_cache()


def test_profile_keeps_facts_and_drops_anything_based_on_todays_price() -> None:
    p = company.to_profile("BHP", INFO)

    assert p["name"] == "BHP Group Limited"
    assert p["headquarters"] == "Melbourne, Australia"
    assert p["summary"] == "BHP Group Limited operates as a resources company."
    assert p["employees"] == 38833
    assert p["fundamentals"]["eps"] == 2.77
    assert p["fundamentals"]["ex_dividend_date"] == "2026-09-03"
    assert p["fundamentals"]["reporting_currency"] == "USD"
    flat = str(p)
    for leaked in ("280884019200", "19.95", "4.11", "68.77", "57.21"):
        assert leaked not in flat


def test_missing_and_malformed_values_become_none() -> None:
    p = company.to_profile(
        "XJO", {"shortName": "S&P/ASX 200", "quoteType": "INDEX", "trailingEps": float("nan")}
    )

    assert p["name"] == "S&P/ASX 200"
    assert p["kind"] == "index"
    assert p["sector"] is None
    assert p["fundamentals"]["eps"] is None
    assert p["fundamentals"]["beta"] is None
    assert company.to_profile("ZZZ", {"beta": "Infinity", "fullTimeEmployees": True})["name"] == (
        "ZZZ"
    )


def test_profile_is_cached_for_six_hours() -> None:
    calls: list[str] = []

    def fetch(symbol: str) -> dict[str, Any]:
        calls.append(symbol)
        return INFO

    clock = {"t": 0.0}
    company.profile("BHP", fetch, now=lambda: clock["t"])
    company.profile("BHP", fetch, now=lambda: clock["t"])
    clock["t"] = 7 * 3600
    company.profile("BHP", fetch, now=lambda: clock["t"])

    assert calls == ["BHP.AX", "BHP.AX"]


def bars(closes: dict[str, float]) -> list[dict[str, Any]]:
    return [
        {"date": d, "open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 1000}
        for d, c in closes.items()
    ]


def test_price_stats_are_measured_to_the_last_bar_given() -> None:
    end = date(2026, 11, 12)
    daily = bars(
        {
            (end - timedelta(days=400)).isoformat(): 90.0,  # outside the 52-week window
            (end - timedelta(days=365)).isoformat(): 40.0,
            (end - timedelta(days=30)).isoformat(): 50.0,
            (end - timedelta(days=7)).isoformat(): 55.0,
            end.isoformat(): 60.0,
        }
    )

    stats = company.price_stats(daily)

    assert stats["as_of"] == "2026-11-12"
    assert stats["last_close"] == 60.0
    assert stats["week52_high"] == 61.0  # the 90 close is more than a year old
    assert stats["week52_low"] == 49.0
    by_label = {r["label"]: r["pct"] for r in stats["returns"]}
    assert by_label["1 week"] == pytest.approx(9.09)
    assert by_label["1 month"] == 20.0
    assert by_label["1 year"] == 50.0
    assert by_label["3 years"] is None  # history doesn't reach back that far
    assert company.price_stats([])["returns"] == []


def test_company_endpoint_cuts_price_history_off_before_the_session_day(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(company, "yahoo_info", lambda s: INFO)
    days = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]
    monkeypatch.setattr(history, "yahoo_daily", lambda s: yahoo_daily(days))
    client = TestClient(app)

    body = client.get("/api/live/company", params={"symbol": "bhp", "until": "2026-11-13"}).json()

    assert body["name"] == "BHP Group Limited"
    assert body["price"]["as_of"] == "2026-11-12"  # the demo day itself is unseen
    assert body["price"]["last_close"] == 52.5
    assert client.get("/api/live/company", params={"symbol": "ZZZ"}).status_code == 404
