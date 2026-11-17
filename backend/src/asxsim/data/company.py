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
_cache: dict[str, tuple[float, dict[str, Any]]] = {}

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
        },
    }


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
    return {
        "as_of": last["date"],
        "last_close": last["close"],
        "week52_high": max(b["high"] for b in year),
        "week52_low": min(b["low"] for b in year),
        "average_volume_30d": round(sum(b["volume"] for b in month) / len(month)),
        "returns": returns,
    }


def clear_cache() -> None:
    _cache.clear()
