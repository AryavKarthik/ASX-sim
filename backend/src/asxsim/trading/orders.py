"""Orders and fills."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any


def price_text(price: Decimal) -> str:
    """A price for display: up to 4 decimals, trailing zeros trimmed, at least 2 ($59.27)."""
    text = f"{price:.4f}".rstrip("0")
    whole, _, cents = text.partition(".")
    return f"{whole}.{cents.ljust(2, '0')}"


class Side(StrEnum):
    BUY = "buy"
    SELL = "sell"


class OrderType(StrEnum):
    MARKET = "market"
    LIMIT = "limit"
    # Conditional orders. On the ASX these live at your broker, not the exchange: the broker
    # watches the last traded price and sends a market or limit order when it reaches the trigger.
    STOP = "stop"  # becomes a market order at the trigger (e.g. a stop-loss)
    STOP_LIMIT = "stop_limit"  # becomes a limit order at the trigger
    TRAILING_STOP = "trailing_stop"  # trigger follows the best price by a set amount or %

    @property
    def is_conditional(self) -> bool:
        return self in (OrderType.STOP, OrderType.STOP_LIMIT, OrderType.TRAILING_STOP)


class TimeInForce(StrEnum):
    DAY = "day"  # expires at the close
    GTC = "gtc"  # good till cancelled, up to GTC_MAX_DAYS


GTC_MAX_DAYS = 30  # brokers cap how long a good-till-cancelled order can stay open


class OrderStatus(StrEnum):
    PENDING = "pending"  # a conditional order waiting for its trigger price
    QUEUED = "queued"  # waiting for an auction (placed in pre-open / pre-close)
    WORKING = "working"  # live in continuous trading, possibly partly filled
    FILLED = "filled"
    CANCELLED = "cancelled"
    EXPIRED = "expired"  # a day order that didn't fill by the close
    REJECTED = "rejected"

    @property
    def is_open(self) -> bool:
        return self in (OrderStatus.PENDING, OrderStatus.QUEUED, OrderStatus.WORKING)


class Auction(StrEnum):
    OPEN = "open"
    CLOSE = "close"
    RESUME = "resume"  # the reopening auction after a trading halt


@dataclass(frozen=True, slots=True)
class OrderRequest:
    symbol: str
    side: Side
    type: OrderType
    quantity: int
    limit_price: Decimal | None = None
    trigger_price: Decimal | None = None  # stop and stop-limit
    trail_amount: Decimal | None = None  # trailing stop: dollars behind the best price...
    trail_percent: Decimal | None = None  # ...or percent behind it
    time_in_force: TimeInForce = TimeInForce.DAY


def _dec(value: Any) -> Decimal | None:
    return None if value is None else Decimal(value)


@dataclass
class Order:
    id: str
    symbol: str
    side: Side
    type: OrderType
    quantity: int
    limit_price: Decimal | None
    created_at: datetime  # delayed-market time when placed
    session: date  # the trading day the order is for
    status: OrderStatus
    auction: Auction | None = None  # which auction a queued order waits for
    filled: int = 0
    average_price: Decimal | None = None
    fees: Decimal = Decimal("0")
    message: str | None = None
    volume_at_limit: int = 0  # volume traded at our limit since we joined (queue estimate)
    time_in_force: TimeInForce = TimeInForce.DAY
    expires_on: date | None = None  # last day a GTC order can stay open
    trigger_price: Decimal | None = None
    trail_amount: Decimal | None = None
    trail_percent: Decimal | None = None
    trail_extreme: Decimal | None = None  # best price seen since placing a trailing stop
    conditional: OrderType | None = None  # the conditional type this order started as
    triggered_at: datetime | None = None

    @property
    def remaining(self) -> int:
        return self.quantity - self.filled

    @property
    def display_type(self) -> OrderType:
        """What the trader placed (a triggered stop shows as a stop, not a market order)."""
        return self.conditional or self.type

    def record_fill(self, quantity: int, price: Decimal, fee: Decimal) -> None:
        total = (self.average_price or Decimal("0")) * self.filled + price * quantity
        self.filled += quantity
        self.average_price = total / self.filled
        self.fees += fee
        if self.remaining == 0:
            self.status = OrderStatus.FILLED

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "symbol": self.symbol,
            "side": self.side.value,
            "type": self.type.value,
            "quantity": self.quantity,
            "limit_price": None if self.limit_price is None else str(self.limit_price),
            "created_at": self.created_at.isoformat(),
            "session": self.session.isoformat(),
            "status": self.status.value,
            "auction": None if self.auction is None else self.auction.value,
            "filled": self.filled,
            "average_price": None if self.average_price is None else str(self.average_price),
            "fees": str(self.fees),
            "message": self.message,
            "volume_at_limit": self.volume_at_limit,
            "time_in_force": self.time_in_force.value,
            "expires_on": None if self.expires_on is None else self.expires_on.isoformat(),
            "trigger_price": None if self.trigger_price is None else str(self.trigger_price),
            "trail_amount": None if self.trail_amount is None else str(self.trail_amount),
            "trail_percent": None if self.trail_percent is None else str(self.trail_percent),
            "trail_extreme": None if self.trail_extreme is None else str(self.trail_extreme),
            "conditional": None if self.conditional is None else self.conditional.value,
            "triggered_at": None if self.triggered_at is None else self.triggered_at.isoformat(),
        }

    def to_view(self) -> dict[str, Any]:
        """Like to_json, with prices formatted for display (to_json keeps full precision)."""
        view = self.to_json()
        view["display_type"] = self.display_type.value
        if self.average_price is not None:
            view["average_price"] = price_text(self.average_price)
        return view

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Order:
        return cls(
            id=data["id"],
            symbol=data["symbol"],
            side=Side(data["side"]),
            type=OrderType(data["type"]),
            quantity=int(data["quantity"]),
            limit_price=None if data["limit_price"] is None else Decimal(data["limit_price"]),
            created_at=datetime.fromisoformat(data["created_at"]),
            session=date.fromisoformat(data["session"]),
            status=OrderStatus(data["status"]),
            auction=None if data["auction"] is None else Auction(data["auction"]),
            filled=int(data["filled"]),
            average_price=None if data["average_price"] is None else Decimal(data["average_price"]),
            fees=Decimal(data["fees"]),
            message=data["message"],
            volume_at_limit=int(data.get("volume_at_limit", 0)),
            # Fields added later default sensibly, so older saved accounts still load.
            time_in_force=TimeInForce(data.get("time_in_force", "day")),
            expires_on=None
            if data.get("expires_on") is None
            else date.fromisoformat(data["expires_on"]),
            trigger_price=_dec(data.get("trigger_price")),
            trail_amount=_dec(data.get("trail_amount")),
            trail_percent=_dec(data.get("trail_percent")),
            trail_extreme=_dec(data.get("trail_extreme")),
            conditional=None if data.get("conditional") is None else OrderType(data["conditional"]),
            triggered_at=None
            if data.get("triggered_at") is None
            else datetime.fromisoformat(data["triggered_at"]),
        )


@dataclass(frozen=True, slots=True)
class Fill:
    order_id: str
    symbol: str
    side: Side
    quantity: int
    price: Decimal
    fee: Decimal
    time: datetime  # market time of the trade that filled us
    liquidity: str  # "continuous", "opening auction" or "closing auction"
    settles_on: date | None = None  # T+2: when the cash and shares actually change hands

    @property
    def value(self) -> Decimal:
        return (self.price * self.quantity).quantize(Decimal("0.01"))

    @property
    def cash_effect(self) -> Decimal:
        """Cash this fill moves at settlement: positive for a sale, negative for a purchase."""
        if self.side is Side.SELL:
            return self.value - self.fee
        return -(self.value + self.fee)

    def to_json(self) -> dict[str, Any]:
        return {
            "order_id": self.order_id,
            "symbol": self.symbol,
            "side": self.side.value,
            "quantity": self.quantity,
            "price": str(self.price),
            "fee": str(self.fee),
            "value": str(self.value),
            "time": self.time.isoformat(),
            "liquidity": self.liquidity,
            "settles_on": None if self.settles_on is None else self.settles_on.isoformat(),
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Fill:
        return cls(
            order_id=data["order_id"],
            symbol=data["symbol"],
            side=Side(data["side"]),
            quantity=int(data["quantity"]),
            price=Decimal(data["price"]),
            fee=Decimal(data["fee"]),
            time=datetime.fromisoformat(data["time"]),
            liquidity=data["liquidity"],
            settles_on=None
            if data.get("settles_on") is None
            else date.fromisoformat(data["settles_on"]),
        )
