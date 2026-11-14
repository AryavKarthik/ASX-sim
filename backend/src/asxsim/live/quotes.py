"""A single live price update ("tick"), and parsing Yahoo's streamed messages into one."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, fields, replace
from datetime import UTC, datetime
from typing import Any


@dataclass(frozen=True, slots=True)
class Tick:
    """One price update for one symbol, stamped with the time the trade happened."""

    symbol: str  # ASX code, e.g. "BHP"
    price: float
    time: datetime  # exchange time of the trade (UTC); with delayed data this lags real time
    day_volume: int | None = None
    last_size: int | None = None
    day_high: float | None = None
    day_low: float | None = None
    open_price: float | None = None
    previous_close: float | None = None
    bid: float | None = None
    ask: float | None = None

    def filled_from(self, previous: Tick | None) -> Tick:
        """Copy any fields this update left out from the previous quote for the symbol."""
        if previous is None:
            return self
        missing = {
            f.name: getattr(previous, f.name)
            for f in fields(self)
            if getattr(self, f.name) is None and getattr(previous, f.name) is not None
        }
        return replace(self, **missing) if missing else self


def _float(message: Mapping[str, Any], key: str) -> float | None:
    value = message.get(key)
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _int(message: Mapping[str, Any], key: str) -> int | None:
    # Yahoo's protobuf messages decode 64-bit integers as strings ("1794564000000").
    value = message.get(key)
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_yahoo_message(
    message: Mapping[str, Any], yahoo_to_code: Mapping[str, str]
) -> Tick | None:
    """Turn one decoded Yahoo stream message into a Tick, or None if it isn't usable."""
    code = yahoo_to_code.get(str(message.get("id", "")))
    price = _float(message, "price")
    millis = _int(message, "time")
    if code is None or price is None or millis is None:
        return None
    return Tick(
        symbol=code,
        price=price,
        time=datetime.fromtimestamp(millis / 1000, tz=UTC),
        day_volume=_int(message, "day_volume"),
        last_size=_int(message, "last_size"),
        day_high=_float(message, "day_high"),
        day_low=_float(message, "day_low"),
        open_price=_float(message, "open_price"),
        previous_close=_float(message, "previous_close"),
        bid=_float(message, "bid"),
        ask=_float(message, "ask"),
    )
