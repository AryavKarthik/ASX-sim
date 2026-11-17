"""What the coach has cost this month, and the budget that stops it.

Costs are estimates from each reply's token counts and list prices. The hard backstop is
the spend limit set in the Anthropic console; this ledger is the friendly first line.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class Usage:
    input_tokens: int = 0  # not served from or written to the cache
    output_tokens: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0


@dataclass(frozen=True, slots=True)
class Price:
    """US dollars per million tokens."""

    input: float
    output: float
    cache_read: float

    @property
    def cache_write(self) -> float:
        return self.input * 1.25  # 5-minute cache writes cost 1.25x input


PRICES = {
    "claude-haiku-5-5": Price(input=0.10, output=0.50, cache_read=0.01),
    "claude-sonnet-5-5": Price(input=2.00, output=10.00, cache_read=0.10),
    "claude-opus-5-5": Price(input=4.00, output=20.00, cache_read=0.20),
}
# An unlisted model is costed at the dearest listed rate, so the budget errs on the safe side.
UNKNOWN_MODEL_PRICE = PRICES["claude-opus-5-5"]


def cost_usd(model: str, usage: Usage) -> float:
    price = PRICES.get(model, UNKNOWN_MODEL_PRICE)
    return (
        usage.input_tokens * price.input
        + usage.output_tokens * price.output
        + usage.cache_write_tokens * price.cache_write
        + usage.cache_read_tokens * price.cache_read
    ) / 1_000_000


class Ledger:
    """Month-by-month spend, saved as JSON next to the simulated account."""

    def __init__(
        self,
        path: Path | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._path = path
        self._clock = clock
        self._months: dict[str, dict[str, Any]] = {}
        if path is not None and path.exists():
            try:
                self._months = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                self._months = {}  # unreadable: start again rather than block the coach

    def _month(self) -> str:
        return self._clock().strftime("%Y-%m")

    def spent(self) -> float:
        return float(self._months.get(self._month(), {}).get("cost_usd", 0.0))

    def calls(self) -> int:
        return int(self._months.get(self._month(), {}).get("calls", 0))

    def record(self, model: str, usage: Usage) -> float:
        """Add one reply. Returns what it cost."""
        cost = cost_usd(model, usage)
        month = self._months.setdefault(
            self._month(), {"cost_usd": 0.0, "calls": 0, "input_tokens": 0, "output_tokens": 0}
        )
        month["cost_usd"] = round(month["cost_usd"] + cost, 6)
        month["calls"] += 1
        month["input_tokens"] += (
            usage.input_tokens + usage.cache_write_tokens + usage.cache_read_tokens
        )
        month["output_tokens"] += usage.output_tokens
        if self._path is not None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(json.dumps(self._months, indent=2), encoding="utf-8")
        return cost
