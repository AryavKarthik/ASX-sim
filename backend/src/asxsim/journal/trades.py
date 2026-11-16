"""Group fills into round-trip trades.

A trade opens when a position goes from no shares to some, and closes when it's back to
zero. Adding to or trimming a position in between is part of the same trade. P&L uses the
same average-cost method as the account, so the journal always agrees with it.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from asxsim.trading.orders import Fill, Side

ZERO = Decimal("0")


@dataclass
class Trade:
    id: str  # "<symbol>-<id of the order that opened it>", stable across restarts
    symbol: str
    opened_at: datetime
    closed_at: datetime | None = None
    entry_quantity: int = 0  # all shares bought during the trade
    exit_quantity: int = 0  # all shares sold
    entry_value: Decimal = ZERO
    exit_value: Decimal = ZERO
    gross_pnl: Decimal = ZERO  # realised, before fees
    fees: Decimal = ZERO
    order_ids: list[str] = field(default_factory=list)
    open_quantity: int = 0
    _cost: Decimal = ZERO  # cost of the shares still held

    @property
    def is_open(self) -> bool:
        return self.closed_at is None

    @property
    def average_entry(self) -> Decimal:
        return self.entry_value / self.entry_quantity

    @property
    def average_exit(self) -> Decimal | None:
        return self.exit_value / self.exit_quantity if self.exit_quantity else None

    @property
    def net_pnl(self) -> Decimal:
        return self.gross_pnl - self.fees

    def unrealised(self, last_price: Decimal) -> Decimal:
        return last_price * self.open_quantity - self._cost

    def _apply(self, fill: Fill) -> None:
        if fill.order_id not in self.order_ids:
            self.order_ids.append(fill.order_id)
        self.fees += fill.fee
        if fill.side is Side.BUY:
            self.entry_quantity += fill.quantity
            self.entry_value += fill.value
            self.open_quantity += fill.quantity
            self._cost += fill.value
        else:
            cost_out = self._cost * fill.quantity / self.open_quantity
            self.exit_quantity += fill.quantity
            self.exit_value += fill.value
            self.gross_pnl += fill.value - cost_out
            self._cost -= cost_out
            self.open_quantity -= fill.quantity
            if self.open_quantity == 0:
                self.closed_at = fill.time


def build_trades(fills: Iterable[Fill]) -> list[Trade]:
    """Every round-trip trade in the fills, oldest first."""
    trades: list[Trade] = []
    current: dict[str, Trade] = {}
    for fill in sorted(fills, key=lambda f: f.time):
        trade = current.get(fill.symbol)
        if trade is None:
            if fill.side is Side.SELL:
                continue  # can't happen without short selling; ignore defensively
            trade = Trade(
                id=f"{fill.symbol}-{fill.order_id}", symbol=fill.symbol, opened_at=fill.time
            )
            trades.append(trade)
            current[fill.symbol] = trade
        trade._apply(fill)
        if not trade.is_open:
            del current[fill.symbol]
    return trades
