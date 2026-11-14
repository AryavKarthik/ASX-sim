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


class OrderStatus(StrEnum):
    QUEUED = "queued"  # waiting for an auction (placed in pre-open / pre-close)
    WORKING = "working"  # live in continuous trading, possibly partly filled
    FILLED = "filled"
    CANCELLED = "cancelled"
    EXPIRED = "expired"  # a day order that didn't fill by the close
    REJECTED = "rejected"

    @property
    def is_open(self) -> bool:
        return self in (OrderStatus.QUEUED, OrderStatus.WORKING)


class Auction(StrEnum):
    OPEN = "open"
    CLOSE = "close"


@dataclass(frozen=True, slots=True)
class OrderRequest:
    symbol: str
    side: Side
    type: OrderType
    quantity: int
    limit_price: Decimal | None = None


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

    @property
    def remaining(self) -> int:
        return self.quantity - self.filled

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
        }

    def to_view(self) -> dict[str, Any]:
        """Like to_json, with prices formatted for display (to_json keeps full precision)."""
        view = self.to_json()
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

    @property
    def value(self) -> Decimal:
        return (self.price * self.quantity).quantize(Decimal("0.01"))

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
        )
