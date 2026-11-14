"""Brokerage: what each order costs in fees.

Australian brokers charge per order (one "contract note"), either a flat fee, a percentage
of the trade value, or a percentage with a minimum. A partly filled order is still one
order, so the fee is based on its total filled value, and each fill only pays the extra.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

CENT = Decimal("0.01")


@dataclass(frozen=True, slots=True)
class Brokerage:
    flat: Decimal = Decimal("10.00")
    percent: Decimal = Decimal("0")  # e.g. Decimal("0.0011") for 0.11%
    minimum: Decimal = Decimal("0")

    def fee(self, value: Decimal) -> Decimal:
        """Total brokerage for an order whose filled value is `value`."""
        if value <= 0:
            return Decimal("0.00")
        return max(self.flat + value * self.percent, self.minimum).quantize(CENT, ROUND_HALF_UP)

    def to_json(self) -> dict[str, Any]:
        return {"flat": str(self.flat), "percent": str(self.percent), "minimum": str(self.minimum)}

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Brokerage:
        return cls(Decimal(data["flat"]), Decimal(data["percent"]), Decimal(data["minimum"]))
