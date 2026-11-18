"""Company profiles and fundamentals for the Company view.

Fetched from Yahoo on demand and cached for six hours. Only slow-moving facts are returned
(what the company does, earnings and dividends per share, shares on issue, margins). Ratios
that depend on the share price (P/E, dividend yield, market cap, price to book) are left to
the browser, which works them out from the price on screen. Yahoo's own versions use
today's price, which in a demo replaying an older day would reveal where the price went.

Price statistics (52-week range, returns) are computed here from daily history that the
caller has already cut off before the session day.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from asxsim.data.universe import yahoo_symbol

CACHE_SECONDS = 6 * 3600

InfoFetcher = Callable[[str], dict[str, Any]]  # yahoo symbol -> Yahoo's "info" dictionary
DividendFetcher = Callable[[str], list[tuple[date, float]]]  # yahoo symbol -> payments
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_dividend_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
MAX_DIVIDENDS = 16  # most recent payments shown

# Trailing periods for the returns table: label -> calendar days back.
RETURN_PERIODS = (
    ("1 week", 7),
    ("1 month", 30),
    ("3 months", 91),
    ("6 months", 182),
    ("1 year", 365),
    ("3 years", 1095),
)


def yahoo_info(symbol: str) -> dict[str, Any]:
    import yfinance as yf  # lazy: tests never touch the network

    info: dict[str, Any] = yf.Ticker(symbol).info
    return info


def yahoo_dividends(symbol: str) -> list[tuple[date, float]]:
    import yfinance as yf  # lazy: tests never touch the network

    series = yf.Ticker(symbol).dividends
    return [(ts.date(), float(amount)) for ts, amount in series.items()]


RATINGS = {
    "strong_buy": "Strong buy",
    "buy": "Buy",
    "hold": "Hold",
    "underperform": "Underperform",
    "sell": "Sell",
    "strong_sell": "Strong sell",
}


def _number(value: object) -> float | None:
    """A finite number, or None (Yahoo sends None, NaN, 'Infinity' and strings at times)."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) else None


def _text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _day(value: object) -> str | None:
    """Yahoo gives dates as epoch seconds."""
    seconds = _number(value)
    if seconds is None:
        return None
    try:
        return datetime.fromtimestamp(seconds, tz=UTC).date().isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def to_profile(code: str, info: dict[str, Any]) -> dict[str, Any]:
    """Pick the facts the Company view shows out of Yahoo's (large, inconsistent) dictionary."""
    place = ", ".join(p for p in (_text(info.get("city")), _text(info.get("country"))) if p)
    employees = _number(info.get("fullTimeEmployees"))
    return {
        "code": code,
        "name": _text(info.get("longName")) or _text(info.get("shortName")) or code,
        "kind": (_text(info.get("quoteType")) or "EQUITY").lower(),  # equity, etf, index
        "sector": _text(info.get("sector")),
        "industry": _text(info.get("industry")),
        "summary": _text(info.get("longBusinessSummary")),
        "website": _text(info.get("website")),
        "headquarters": place or None,
        "employees": None if employees is None else int(employees),
        "fundamentals": {
            # Per-share figures: the browser combines these with the current price.
            "eps": _number(info.get("trailingEps")),
            "forward_eps": _number(info.get("forwardEps")),
            "dividend_per_share": _number(info.get("trailingAnnualDividendRate")),
            "book_value_per_share": _number(info.get("bookValue")),
            "shares_outstanding": _number(info.get("sharesOutstanding")),
            # Company-level figures that don't depend on today's price.
            "revenue": _number(info.get("totalRevenue")),
            "net_income": _number(info.get("netIncomeToCommon")),
            "profit_margin": _number(info.get("profitMargins")),
            "return_on_equity": _number(info.get("returnOnEquity")),
            "debt_to_equity": _number(info.get("debtToEquity")),
            "payout_ratio": _number(info.get("payoutRatio")),
            "beta": _number(info.get("beta")),
            "ex_dividend_date": _day(info.get("exDividendDate")),
            "reporting_currency": _text(info.get("financialCurrency")),
            "trading_currency": _text(info.get("currency")),
            # Added for the broker-style tabs.
            "forward_dividend_per_share": _number(info.get("dividendRate")),
            "five_year_average_yield": _number(info.get("fiveYearAvgDividendYield")),
            "operating_margin": _number(info.get("operatingMargins")),
            "gross_margin": _number(info.get("grossMargins")),
            "revenue_growth": _number(info.get("revenueGrowth")),
            "earnings_growth": _number(info.get("earningsGrowth")),
            "total_cash": _number(info.get("totalCash")),
            "total_debt": _number(info.get("totalDebt")),
            "current_ratio": _number(info.get("currentRatio")),
        },
        # What analysts think. Yahoo's latest consensus: the browser says so, and that in a
        # replay of an older day it reflects today, not that day.
        "analysts": {
            "rating": RATINGS.get(_text(info.get("recommendationKey")) or ""),
            "rating_score": _number(info.get("recommendationMean")),  # 1 strong buy .. 5 sell
            "count": _int(info.get("numberOfAnalystOpinions")),
            "target_mean": _number(info.get("targetMeanPrice")),
            "target_median": _number(info.get("targetMedianPrice")),
            "target_high": _number(info.get("targetHighPrice")),
            "target_low": _number(info.get("targetLowPrice")),
        },
        "ownership": {
            "insiders": _number(info.get("heldPercentInsiders")),
            "institutions": _number(info.get("heldPercentInstitutions")),
            "float_shares": _number(info.get("floatShares")),
        },
        "officers": _officers(info.get("companyOfficers")),
    }


def _int(value: object) -> int | None:
    n = _number(value)
    return None if n is None else int(n)


def _officers(raw: object) -> list[dict[str, str]]:
    """The first few listed executives: name and title only."""
    if not isinstance(raw, list):
        return []
    out = []
    for person in raw:
        if not isinstance(person, dict):
            continue
        name, title = _text(person.get("name")), _text(person.get("title"))
        if name and title:
            out.append({"name": " ".join(name.split()), "title": title})
        if len(out) == 6:
            break
    return out


def dividends(
    code: str,
    until: date | None = None,
    fetch: DividendFetcher | None = None,
    now: Callable[[], float] = time.monotonic,
) -> list[dict[str, Any]]:
    """Recent dividend payments (ex-dividend date, cash per share), newest first.

    Payments on or after `until` are left out, so a replay of an older day can't see them.
    """
    cached = _dividend_cache.get(code)
    if cached is None or now() - cached[0] > CACHE_SECONDS:
        payments = (fetch or yahoo_dividends)(yahoo_symbol(code))
        fresh: list[dict[str, Any]] = [
            {"date": day.isoformat(), "amount": round(amount, 4)}
            for day, amount in sorted(payments, key=lambda p: p[0])
            if math.isfinite(amount) and amount > 0
        ]
        cached = (now(), fresh)
        _dividend_cache[code] = cached
    rows = cached[1]
    if until is not None:
        cutoff = until.isoformat()
        rows = [r for r in rows if str(r["date"]) < cutoff]
    return list(reversed(rows[-MAX_DIVIDENDS:]))


def profile(
    code: str, fetch: InfoFetcher | None = None, now: Callable[[], float] = time.monotonic
) -> dict[str, Any]:
    cached = _cache.get(code)
    if cached is None or now() - cached[0] > CACHE_SECONDS:
        cached = (now(), to_profile(code, (fetch or yahoo_info)(yahoo_symbol(code))))
        _cache[code] = cached
    return cached[1]


def price_stats(daily: list[dict[str, Any]]) -> dict[str, Any]:
    """52-week range, trailing returns and average volume from daily bars (oldest first).

    Everything is measured to the last bar given, so a caller that cuts history off before
    the session day gets statistics that know nothing later.
    """
    if not daily:
        return {
            "as_of": None,
            "sma50": None,
            "sma200": None,
            "last_close": None,
            "week52_high": None,
            "week52_low": None,
            "average_volume_30d": None,
            "returns": [],
        }
    last = daily[-1]
    last_day = date.fromisoformat(last["date"])
    year = [b for b in daily if b["date"] > (last_day - timedelta(days=365)).isoformat()]
    month = daily[-30:]
    returns = []
    for label, days in RETURN_PERIODS:
        target = (last_day - timedelta(days=days)).isoformat()
        earlier = [b for b in daily if b["date"] <= target]
        # Only when history really reaches back that far (not just "the oldest bar we have").
        value = None
        if earlier and earlier[-1]["close"]:
            value = round(100 * (last["close"] / earlier[-1]["close"] - 1), 2)
        returns.append({"label": label, "pct": value})
    closes = [b["close"] for b in daily]
    return {
        "as_of": last["date"],
        "sma50": round(sum(closes[-50:]) / 50, 4) if len(closes) >= 50 else None,
        "sma200": round(sum(closes[-200:]) / 200, 4) if len(closes) >= 200 else None,
        "last_close": last["close"],
        "week52_high": max(b["high"] for b in year),
        "week52_low": min(b["low"] for b in year),
        "average_volume_30d": round(sum(b["volume"] for b in month) / len(month)),
        "returns": returns,
    }


def clear_cache() -> None:
    _cache.clear()
    _dividend_cache.clear()
