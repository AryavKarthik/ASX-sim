"""One swing-practice session: a stock, a stretch of daily bars, and a simulated account.

You see the chart up to "today's" close, decide, and step to the next trading day. Orders
placed after the close are worked on the following days:

- a market order fills at the next day's open,
- a limit order fills when the day's range reaches it: at the open if the price has already
  gapped through the limit (you get the better price), otherwise at the limit,
- a stop order triggers when the range reaches it: at the stop, or at the open if the price
  gapped past it (you get the worse price, as in real life).

Orders stay open until they fill or you cancel them. The session never hands out a bar
beyond the current day; in blind mode it also hides the stock's name and the real dates
until the session is finished.

Prices are split-adjusted but dividends are ignored, so results understate the return of
dividend-paying shares. Buy and hold is shown on the same basis.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from asxsim.market.ticks import is_valid_price, tick_size
from asxsim.trading.brokerage import Brokerage

LOOKBACK_BARS = 250  # chart history shown before the first practice day (about a year)
MAX_QUANTITY = 10_000_000
BLIND_EPOCH = int(datetime(2000, 1, 3, tzinfo=UTC).timestamp())  # fake dates start here
DAY = 86_400

Bar = dict[str, Any]


class SwingError(ValueError):
    """The request breaks a rule; the message is shown to the learner."""


def money(value: float | Decimal) -> Decimal:
    return Decimal(str(round(float(value), 4)))


@dataclass
class SwingOrder:
    id: int
    side: str  # "buy" | "sell"
    type: str  # "market" | "limit" | "stop"
    quantity: int
    price: Decimal | None  # limit or stop price
    placed_on: int  # index of the day it was placed after
    status: str = "working"  # working | filled | cancelled | rejected
    filled_on: int | None = None
    fill_price: Decimal | None = None
    fee: Decimal = Decimal("0")
    pnl: Decimal | None = None  # for sells: profit after brokerage on both sides
    note: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "side": self.side,
            "type": self.type,
            "quantity": self.quantity,
            "price": None if self.price is None else str(self.price),
            "placed_on": self.placed_on,
            "status": self.status,
            "filled_on": self.filled_on,
            "fill_price": None if self.fill_price is None else str(self.fill_price),
            "fee": str(self.fee),
            "pnl": None if self.pnl is None else str(self.pnl),
            "note": self.note,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> SwingOrder:
        def dec(key: str) -> Decimal | None:
            return None if data[key] is None else Decimal(data[key])

        return cls(
            id=data["id"],
            side=data["side"],
            type=data["type"],
            quantity=data["quantity"],
            price=dec("price"),
            placed_on=data["placed_on"],
            status=data["status"],
            filled_on=data["filled_on"],
            fill_price=dec("fill_price"),
            fee=Decimal(data["fee"]),
            pnl=dec("pnl"),
            note=data["note"],
        )


def fill_price(order: SwingOrder, bar: Bar) -> Decimal | None:
    """Where `order` fills on this day's bar, or None if the day never reaches it."""
    open_, high, low = money(bar["open"]), money(bar["high"]), money(bar["low"])
    if order.type == "market":
        return open_
    price = order.price
    assert price is not None
    buying = order.side == "buy"
    if order.type == "limit":
        if buying:
            return min(open_, price) if low <= price else None
        return max(open_, price) if high >= price else None
    # Stop: a buy stop sits above the market, a sell stop below it.
    if buying:
        return max(open_, price) if high >= price else None
    return min(open_, price) if low <= price else None


class SwingSession:
    def __init__(
        self,
        symbol: str,
        name: str,
        bars: list[Bar],
        first: int,
        cash: Decimal,
        blind: bool = False,
        brokerage: Brokerage | None = None,
    ) -> None:
        if not 0 <= first < len(bars) - 1:
            raise SwingError("There isn't enough price history for that period")
        self.symbol = symbol
        self.name = name
        self.bars = bars
        self.first = first  # the day the practice starts on (its close is the first decision)
        self.cursor = first  # the last day you can see
        self.blind = blind
        self.brokerage = brokerage or Brokerage()
        self.starting_cash = cash
        self.cash = cash
        self.quantity = 0
        self.cost = Decimal("0")  # what the shares held cost, including buy brokerage
        self.fees = Decimal("0")
        self.orders: list[SwingOrder] = []
        self.equity: list[Decimal] = [cash]  # after each day's close, from `first`
        self.days_invested = 0

    # ------------------------------------------------------------------ state

    @property
    def finished(self) -> bool:
        return self.cursor >= len(self.bars) - 1

    @property
    def close(self) -> Decimal:
        return money(self.bars[self.cursor]["close"])

    def working(self) -> list[SwingOrder]:
        return [o for o in self.orders if o.status == "working"]

    def _reserved_cash(self) -> Decimal:
        total = Decimal("0")
        for order in self.working():
            if order.side == "buy":
                value = (order.price or self.close) * order.quantity
                total += value + self.brokerage.fee(value)
        return total

    def _reserved_shares(self) -> int:
        return sum(o.quantity for o in self.working() if o.side == "sell")

    # ------------------------------------------------------------------ orders

    def place(
        self, side: str, kind: str, quantity: int, price: Decimal | None = None
    ) -> SwingOrder:
        if self.finished:
            raise SwingError("This session has finished. Start a new one to keep practising.")
        if side not in ("buy", "sell") or kind not in ("market", "limit", "stop"):
            raise SwingError("Unknown order")
        if not 0 < quantity <= MAX_QUANTITY:
            raise SwingError("Quantity must be a whole number of shares above zero")
        close = self.close
        if kind == "market":
            if price is not None:
                raise SwingError("A market order doesn't take a price")
        else:
            if price is None or price <= 0:
                raise SwingError(f"Enter a {kind} price")
            if not is_valid_price(price):
                raise SwingError(
                    f"${price} isn't a valid price: at this level prices move in steps of "
                    f"${tick_size(price)}"
                )
            if kind == "stop" and side == "sell" and price >= close:
                raise SwingError(
                    f"A sell stop must be below the last close (${close}). "
                    "It sells if the price falls to it."
                )
            if kind == "stop" and side == "buy" and price <= close:
                raise SwingError(
                    f"A buy stop must be above the last close (${close}). "
                    "It buys if the price rises to it."
                )
        if side == "sell":
            available = self.quantity - self._reserved_shares()
            if quantity > available:
                raise SwingError(
                    f"You can sell at most {available} shares. Short selling isn't enabled."
                )
        else:
            value = (price or close) * quantity
            needed = value + self.brokerage.fee(value)
            available_cash = self.cash - self._reserved_cash()
            if needed > available_cash:
                raise SwingError(
                    f"Not enough cash: this needs about ${needed:,.2f} including brokerage, "
                    f"you have ${available_cash:,.2f} free"
                )
        order = SwingOrder(len(self.orders) + 1, side, kind, quantity, price, self.cursor)
        self.orders.append(order)
        return order

    def cancel(self, order_id: int) -> SwingOrder:
        for order in self.orders:
            if order.id == order_id:
                if order.status != "working":
                    raise SwingError(f"Order {order_id} is already {order.status}")
                order.status = "cancelled"
                return order
        raise SwingError(f"No order {order_id}")

    # ------------------------------------------------------------------ time

    def advance(self, days: int = 1) -> list[SwingOrder]:
        """Move forward up to `days` trading days. Returns the orders that filled."""
        if days < 1:
            raise SwingError("Advance by at least one day")
        filled: list[SwingOrder] = []
        for _ in range(days):
            if self.finished:
                break
            self.cursor += 1
            bar = self.bars[self.cursor]
            for order in self.working():
                price = fill_price(order, bar)
                if price is not None:
                    self._fill(order, price)
                    if order.status == "filled":
                        filled.append(order)
            if self.quantity:
                self.days_invested += 1
            self.equity.append(self.cash + self.quantity * money(bar["close"]))
        return filled

    def _fill(self, order: SwingOrder, price: Decimal) -> None:
        value = price * order.quantity
        fee = self.brokerage.fee(value)
        if order.side == "buy":
            if value + fee > self.cash:
                order.status = "rejected"
                order.note = f"Not enough cash at ${price}: the price moved up before it filled"
                return
            self.cash -= value + fee
            self.cost += value + fee
            self.quantity += order.quantity
        else:
            quantity = min(order.quantity, self.quantity)
            if quantity == 0:
                order.status = "rejected"
                order.note = "No shares left to sell"
                return
            order.quantity = quantity
            value = price * quantity
            fee = self.brokerage.fee(value)
            basis = self.cost * quantity / self.quantity
            order.pnl = (value - fee - basis).quantize(Decimal("0.01"))
            self.cash += value - fee
            self.cost -= basis
            self.quantity -= quantity
        self.fees += fee
        order.status = "filled"
        order.filled_on = self.cursor
        order.fill_price = price
        order.fee = fee

    # ------------------------------------------------------------------ results

    def summary(self) -> dict[str, Any]:
        start_close = money(self.bars[self.first]["close"])
        equity = self.equity[-1]
        peak, drawdown = self.equity[0], Decimal("0")
        for value in self.equity:
            peak = max(peak, value)
            if peak:
                drawdown = max(drawdown, (peak - value) / peak)
        sells = [o for o in self.orders if o.status == "filled" and o.pnl is not None]
        wins = sum(1 for o in sells if o.pnl is not None and o.pnl > 0)
        days = self.cursor - self.first
        return {
            "return_pct": round(float(100 * (equity / self.starting_cash - 1)), 2),
            "buy_hold_pct": round(float(100 * (self.close / start_close - 1)), 2),
            "max_drawdown_pct": round(float(100 * drawdown), 2),
            "closed_trades": len(sells),
            "wins": wins,
            "win_rate": round(100 * wins / len(sells), 1) if sells else None,
            "fees": str(self.fees.quantize(Decimal("0.01"))),
            "days_invested_pct": round(100 * self.days_invested / days, 1) if days else None,
        }

    def _time(self, index: int) -> int:
        """Chart time for a bar: the real date, or a made-up one while the session is blind."""
        if self.hidden:
            return BLIND_EPOCH + index * DAY
        day = date.fromisoformat(self.bars[index]["date"])
        return int(datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp())

    @property
    def hidden(self) -> bool:
        """Whether the stock and dates are still secret (blind mode, not yet finished)."""
        return self.blind and not self.finished

    def to_view(self) -> dict[str, Any]:
        """Everything the browser is allowed to see: nothing after the current day."""
        visible = self.bars[: self.cursor + 1]
        start_close = money(self.bars[self.first]["close"])
        average = self.cost / self.quantity if self.quantity else None
        market_value = self.quantity * self.close
        return {
            "symbol": None if self.hidden else self.symbol,
            "name": "Mystery stock" if self.hidden else self.name,
            "blind": self.blind,
            "hidden": self.hidden,
            "finished": self.finished,
            "day": self.cursor - self.first,
            "total_days": len(self.bars) - 1 - self.first,
            "date": None if self.hidden else self.bars[self.cursor]["date"],
            "start_date": None if self.hidden else self.bars[self.first]["date"],
            "first_index": self.first,
            "bars": [
                {
                    "time": self._time(i),
                    "open": bar["open"],
                    "high": bar["high"],
                    "low": bar["low"],
                    "close": bar["close"],
                    "volume": bar["volume"],
                }
                for i, bar in enumerate(visible)
            ],
            "close": str(self.close),
            "cash": str(self.cash.quantize(Decimal("0.01"))),
            "free_cash": str((self.cash - self._reserved_cash()).quantize(Decimal("0.01"))),
            "starting_cash": str(self.starting_cash),
            "equity": str(self.equity[-1].quantize(Decimal("0.01"))),
            "position": {
                "quantity": self.quantity,
                "free_quantity": self.quantity - self._reserved_shares(),
                "average_price": None if average is None else str(round(average, 4)),
                "market_value": str(market_value.quantize(Decimal("0.01"))),
                "unrealised": str((market_value - self.cost).quantize(Decimal("0.01"))),
            },
            "orders": [o.to_json() | {"time": self._order_time(o)} for o in reversed(self.orders)],
            "curve": [
                {
                    "time": self._time(self.first + i),
                    "equity": float(round(value, 2)),
                    "buy_hold": float(
                        round(
                            self.starting_cash
                            * money(self.bars[self.first + i]["close"])
                            / start_close,
                            2,
                        )
                    ),
                }
                for i, value in enumerate(self.equity)
            ],
            "brokerage": self.brokerage.to_json(),
            "summary": self.summary(),
        }

    def _order_time(self, order: SwingOrder) -> int | None:
        return None if order.filled_on is None else self._time(order.filled_on)

    # ------------------------------------------------------------------ saving

    def to_json(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "name": self.name,
            "bars": self.bars,
            "first": self.first,
            "cursor": self.cursor,
            "blind": self.blind,
            "brokerage": self.brokerage.to_json(),
            "starting_cash": str(self.starting_cash),
            "cash": str(self.cash),
            "quantity": self.quantity,
            "cost": str(self.cost),
            "fees": str(self.fees),
            "orders": [o.to_json() for o in self.orders],
            "equity": [str(v) for v in self.equity],
            "days_invested": self.days_invested,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> SwingSession:
        session = cls(
            data["symbol"],
            data["name"],
            data["bars"],
            data["first"],
            Decimal(data["starting_cash"]),
            data["blind"],
            Brokerage.from_json(data["brokerage"]),
        )
        session.cursor = data["cursor"]
        session.cash = Decimal(data["cash"])
        session.quantity = data["quantity"]
        session.cost = Decimal(data["cost"])
        session.fees = Decimal(data["fees"])
        session.orders = [SwingOrder.from_json(o) for o in data["orders"]]
        session.equity = [Decimal(v) for v in data["equity"]]
        session.days_invested = data["days_invested"]
        return session
