"""The account ledger: cash, holdings, average cost, P&L and fees."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from asxsim.trading.orders import Fill, Side

ZERO = Decimal("0")
DEFAULT_STARTING_CASH = Decimal("50000.00")


@dataclass
class Position:
    quantity: int = 0
    cost: Decimal = ZERO  # total purchase cost of the shares still held (excluding fees)
    realised: Decimal = ZERO  # profit/loss locked in by selling (excluding fees)

    @property
    def average_price(self) -> Decimal | None:
        return self.cost / self.quantity if self.quantity else None


@dataclass
class Account:
    starting_cash: Decimal = DEFAULT_STARTING_CASH
    cash: Decimal = DEFAULT_STARTING_CASH
    positions: dict[str, Position] = field(default_factory=dict)
    fees_paid: Decimal = ZERO
    fills: list[Fill] = field(default_factory=list)

    @classmethod
    def opened_with(cls, starting_cash: Decimal) -> Account:
        return cls(starting_cash=starting_cash, cash=starting_cash)

    def position(self, symbol: str) -> Position:
        return self.positions.setdefault(symbol, Position())

    def apply(self, fill: Fill) -> None:
        position = self.position(fill.symbol)
        if fill.side is Side.BUY:
            self.cash -= fill.value + fill.fee
            position.cost += fill.value
            position.quantity += fill.quantity
        else:
            if fill.quantity > position.quantity:
                raise ValueError(
                    f"Can't sell {fill.quantity} {fill.symbol}: only {position.quantity} held"
                )
            cost_out = position.cost * fill.quantity / position.quantity
            position.realised += fill.value - cost_out
            position.cost -= cost_out
            position.quantity -= fill.quantity
            self.cash += fill.value - fill.fee
        self.fees_paid += fill.fee
        self.fills.append(fill)

    def market_value(self, prices: Mapping[str, Decimal]) -> Decimal:
        return sum(
            (
                p.quantity * prices.get(s, p.average_price or ZERO)
                for s, p in self.positions.items()
                if p.quantity
            ),
            ZERO,
        )

    def unrealised(self, prices: Mapping[str, Decimal]) -> Decimal:
        return sum(
            (
                p.quantity * prices[s] - p.cost
                for s, p in self.positions.items()
                if p.quantity and s in prices
            ),
            ZERO,
        )

    @property
    def realised(self) -> Decimal:
        return sum((p.realised for p in self.positions.values()), ZERO)

    def pending_settlement(self, today: date) -> list[tuple[date, Decimal]]:
        """Net cash still to settle (T+2), by settlement date. Sales are +, purchases -."""
        amounts: dict[date, Decimal] = {}
        for fill in self.fills:
            if fill.settles_on is not None and fill.settles_on > today:
                amounts[fill.settles_on] = amounts.get(fill.settles_on, ZERO) + fill.cash_effect
        return sorted(amounts.items())

    def settled_cash(self, today: date) -> Decimal:
        """Cash that has actually settled (excludes trades still inside T+2)."""
        return self.cash - sum((amount for _, amount in self.pending_settlement(today)), ZERO)

    def equity(self, prices: Mapping[str, Decimal]) -> Decimal:
        return self.cash + self.market_value(prices)

    def to_json(self) -> dict[str, Any]:
        return {
            "starting_cash": str(self.starting_cash),
            "cash": str(self.cash),
            "fees_paid": str(self.fees_paid),
            "positions": {
                s: {"quantity": p.quantity, "cost": str(p.cost), "realised": str(p.realised)}
                for s, p in self.positions.items()
            },
            "fills": [f.to_json() for f in self.fills],
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Account:
        return cls(
            starting_cash=Decimal(data["starting_cash"]),
            cash=Decimal(data["cash"]),
            fees_paid=Decimal(data["fees_paid"]),
            positions={
                s: Position(int(p["quantity"]), Decimal(p["cost"]), Decimal(p["realised"]))
                for s, p in data["positions"].items()
            },
            fills=[Fill.from_json(f) for f in data["fills"]],
        )
