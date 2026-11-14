"""The execution engine: accepts orders and fills them against the price stream.

Prices arrive in the order trades happened (the live delayed feed, or a demo day). Per the
project owner's decision, you trade at the delayed prices you see, as if they were live.

How fills are modelled:

- **Bid/ask.** If the feed provides a bid and ask we use them. Otherwise we assume a one-tick
  spread around the last trade: bid = last trade rounded down to the tick grid, ask = one
  tick above that. A midpoint print of $19.695 implies a 19.69 / 19.70 market.
- **Liquidity.** We can be at most `participation` (25%) of the volume that actually trades,
  so big orders fill partly and the rest waits for more volume.
- **Market orders** in continuous trading buy at the ask / sell at the bid. Any unfilled
  remainder becomes a limit order at the last fill price, which is how ASX "market to
  limit" orders behave.
- **Limit orders** fill straight away if they cross the market. Otherwise they rest and fill
  when trades go *through* the limit, or trade *at* the limit after enough volume has traded
  there to clear the queue ahead of us (estimated as our own order size).
- **Auctions.** Orders placed in pre-open wait for the opening auction; orders placed in
  pre-close (16:00-16:10) wait for the closing auction. They fill at the auction price
  (the first trade at or after the auction). Resting orders also take part in the close.
- **Day orders** that haven't filled by the closing auction expire.
"""

from __future__ import annotations

import itertools
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from asxsim.market.calendar import SYDNEY, TradingCalendar, asx_calendar
from asxsim.market.phases import DaySchedule, MarketPhase, day_schedule
from asxsim.market.ticks import Rounding, is_valid_price, next_tick_up, round_to_tick
from asxsim.trading.account import Account
from asxsim.trading.brokerage import Brokerage
from asxsim.trading.orders import (
    Auction,
    Fill,
    Order,
    OrderRequest,
    OrderStatus,
    OrderType,
    Side,
)

PARTICIPATION = 0.25
MIN_FIRST_PURCHASE = Decimal("500")  # ASX minimum marketable parcel for a new holding
MAX_QUANTITY = 10_000_000


class OrderRejectedError(ValueError):
    """The order breaks a rule (closed market, invalid price, not enough cash, ...)."""


@dataclass(frozen=True, slots=True)
class MarketQuote:
    last: Decimal
    bid: Decimal | None = None
    ask: Decimal | None = None
    minute_volume: int | None = None  # volume of the last completed minute (liquidity)


def touch(quote: MarketQuote) -> tuple[Decimal, Decimal]:
    """The (bid, ask) to trade against."""
    if quote.bid is not None and quote.ask is not None and quote.bid < quote.ask:
        return quote.bid, quote.ask
    bid = round_to_tick(quote.last, Rounding.DOWN)
    return bid, next_tick_up(bid)


class ExecutionEngine:
    def __init__(
        self,
        account: Account | None = None,
        brokerage: Brokerage | None = None,
        participation: float = PARTICIPATION,
        calendar: TradingCalendar | None = None,
        seed: int = 0,
    ) -> None:
        self.account = account or Account()
        self.brokerage = brokerage or Brokerage()
        self.participation = participation
        self.orders: dict[str, Order] = {}
        self.quotes: dict[str, MarketQuote] = {}
        self._calendar = calendar or asx_calendar()
        self._seed = seed
        self._schedules: dict[date, DaySchedule] = {}
        self._ids = itertools.count(1)

    # ------------------------------------------------------------------ helpers

    def schedule(self, day: date) -> DaySchedule:
        if day not in self._schedules:
            self._schedules[day] = day_schedule(day, self._seed, self._calendar)
        return self._schedules[day]

    def phase_at(self, moment: datetime) -> MarketPhase:
        local = moment.astimezone(SYDNEY)
        return self.schedule(local.date()).phase_at(local)

    def open_orders(self, symbol: str | None = None) -> list[Order]:
        return [
            o
            for o in self.orders.values()
            if o.status.is_open and (symbol is None or o.symbol == symbol)
        ]

    def _estimate_price(self, order_or_request: Order | OrderRequest) -> Decimal | None:
        if order_or_request.limit_price is not None:
            return order_or_request.limit_price
        quote = self.quotes.get(order_or_request.symbol)
        if quote is None:
            return None
        bid, ask = touch(quote)
        return ask if order_or_request.side is Side.BUY else bid

    def reserved_cash(self) -> Decimal:
        """Cash set aside for open buy orders (their remaining value plus brokerage)."""
        total = Decimal("0")
        for order in self.open_orders():
            if order.side is Side.BUY:
                price = self._estimate_price(order) or Decimal("0")
                value = price * order.remaining
                total += value + max(
                    self.brokerage.fee(value + price * order.filled) - order.fees, Decimal("0")
                )
        return total

    def buying_power(self) -> Decimal:
        return self.account.cash - self.reserved_cash()

    def reserved_shares(self, symbol: str) -> int:
        return sum(o.remaining for o in self.open_orders(symbol) if o.side is Side.SELL)

    # ------------------------------------------------------------------ orders

    def submit(self, request: OrderRequest, now: datetime) -> tuple[Order, list[Fill]]:
        """Place an order at delayed-market time `now` (raises OrderRejectedError)."""
        self._validate(request, now)
        phase = self.phase_at(now)
        local = now.astimezone(SYDNEY)
        session = local.date()
        auction: Auction | None = None
        status = OrderStatus.WORKING
        if phase is MarketPhase.PRE_OPEN:
            auction, status = Auction.OPEN, OrderStatus.QUEUED
        elif phase is MarketPhase.PRE_CSPA:
            auction, status = Auction.CLOSE, OrderStatus.QUEUED
        elif phase is MarketPhase.ADJUST_ON:
            auction, status = Auction.OPEN, OrderStatus.QUEUED
            session = self._calendar.next_trading_day(session)

        order = Order(
            id=f"O{next(self._ids):05d}",
            symbol=request.symbol,
            side=request.side,
            type=request.type,
            quantity=request.quantity,
            limit_price=request.limit_price,
            created_at=now,
            session=session,
            status=status,
            auction=auction,
        )
        self.orders[order.id] = order
        fills: list[Fill] = []
        if status is OrderStatus.WORKING:
            fills = self._execute_immediately(order, now)
        return order, fills

    def cancel(self, order_id: str, now: datetime) -> Order:
        order = self.orders.get(order_id)
        if order is None:
            raise OrderRejectedError(f"No order {order_id}")
        if not order.status.is_open:
            raise OrderRejectedError(f"Order {order_id} is already {order.status.value}")
        phase = self.phase_at(now)
        if not phase.allows_cancel:
            raise OrderRejectedError(
                f"Orders can't be cancelled during {phase.value.replace('_', ' ')}"
            )
        order.status = OrderStatus.CANCELLED
        order.message = "Cancelled by you"
        return order

    def _validate(self, request: OrderRequest, now: datetime) -> None:
        if not 0 < request.quantity <= MAX_QUANTITY:
            raise OrderRejectedError("Quantity must be a whole number of shares above zero")
        quote = self.quotes.get(request.symbol)
        if quote is None:
            raise OrderRejectedError(
                f"No price for {request.symbol} yet. Wait for the first live price."
            )
        if request.type is OrderType.LIMIT:
            price = request.limit_price
            if price is None or price <= 0:
                raise OrderRejectedError("A limit order needs a price")
            if not is_valid_price(price):
                lower = round_to_tick(price, Rounding.DOWN)
                upper = round_to_tick(price, Rounding.UP)
                raise OrderRejectedError(
                    f"${price} isn't a valid ASX price step. "
                    f"Nearest valid prices: ${lower} or ${upper}"
                )
        elif request.limit_price is not None:
            raise OrderRejectedError("Market orders don't take a price")

        phase = self.phase_at(now)
        if not phase.accepts_new_orders:
            clock = now.astimezone(SYDNEY).strftime("%H:%M")
            if phase.is_auction:
                raise OrderRejectedError(
                    "The auction is matching right now. Try again in a few seconds."
                )
            raise OrderRejectedError(
                f"The market isn't taking orders at {clock} (delayed market time). "
                "Orders open at 7:00am."
            )

        if request.side is Side.SELL:
            held = self.account.position(request.symbol).quantity
            available = held - self.reserved_shares(request.symbol)
            if request.quantity > available:
                extra = (
                    f" ({held - available} already in open sell orders)"
                    if held != available
                    else ""
                )
                raise OrderRejectedError(
                    f"You can sell at most {available} {request.symbol}: you hold {held}{extra}. "
                    "Short selling isn't enabled."
                )
            return

        price = self._estimate_price(request)
        assert price is not None  # a quote exists, checked above
        value = price * request.quantity
        if self.account.position(request.symbol).quantity == 0 and value < MIN_FIRST_PURCHASE:
            raise OrderRejectedError(
                f"A first purchase of {request.symbol} must be worth at least "
                f"${MIN_FIRST_PURCHASE} "
                f"(ASX minimum parcel); this is about ${value:.2f}"
            )
        cost = value + self.brokerage.fee(value)
        if cost > self.buying_power():
            raise OrderRejectedError(
                f"Not enough buying power: this needs about ${cost:,.2f} including brokerage, "
                f"you have ${self.buying_power():,.2f}"
            )

    # ------------------------------------------------------------------ filling

    def _fill(
        self, order: Order, quantity: int, price: Decimal, at: datetime, liquidity: str
    ) -> Fill:
        value_after = (order.average_price or Decimal("0")) * order.filled + price * quantity
        fee = self.brokerage.fee(value_after.quantize(Decimal("0.01"))) - order.fees
        fee = max(fee, Decimal("0"))
        fill = Fill(order.id, order.symbol, order.side, quantity, price, fee, at, liquidity)
        order.record_fill(quantity, price, fee)
        self.account.apply(fill)
        return fill

    def _execute_immediately(self, order: Order, now: datetime) -> list[Fill]:
        quote = self.quotes[order.symbol]
        bid, ask = touch(quote)
        price = ask if order.side is Side.BUY else bid
        marketable = order.type is OrderType.MARKET or (
            order.limit_price is not None
            and (
                price <= order.limit_price if order.side is Side.BUY else price >= order.limit_price
            )
        )
        if not marketable:
            return []
        if quote.minute_volume is None:
            capacity = order.remaining
        else:
            capacity = int(quote.minute_volume * self.participation)
        quantity = min(order.remaining, capacity)
        fills = [self._fill(order, quantity, price, now, "continuous")] if quantity > 0 else []
        if order.remaining and order.type is OrderType.MARKET:
            self._convert_to_limit(order, price)
        return fills

    def _convert_to_limit(self, order: Order, price: Decimal) -> None:
        order.type = OrderType.LIMIT
        order.limit_price = price
        order.message = f"Not enough volume to fill at once: the rest waits as a limit at ${price}"

    def on_tick(
        self,
        symbol: str,
        price: Decimal,
        at: datetime,
        volume: int,
        bid: Decimal | None = None,
        ask: Decimal | None = None,
        minute_volume: int | None = None,
    ) -> list[Fill]:
        """Process one trade in the market. Returns any of our orders that filled."""
        self.quotes[symbol] = MarketQuote(price, bid, ask, minute_volume)
        local = at.astimezone(SYDNEY)
        if not self._calendar.is_trading_day(local.date()):
            return []
        schedule = self.schedule(local.date())
        phase = schedule.phase_at(local)
        fills: list[Fill] = []

        orders = self.open_orders(symbol)
        if not orders:
            return fills

        # Opening auction: the first trade at or after the open sets the auction price.
        for order in orders:
            if (
                order.auction is Auction.OPEN
                and order.session == local.date()
                and local >= schedule.open_at
            ):
                fills += self._auction_fill(order, price, at, "opening auction")

        # Closing auction: everything still open for today takes part, then day orders expire.
        if local >= schedule.closing_auction_at:
            for order in self.open_orders(symbol):
                if order.session == local.date():
                    fills += self._auction_fill(order, price, at, "closing auction", close=True)
            return fills

        if phase is MarketPhase.OPEN:
            fills += self._continuous(symbol, price, at, volume, bid, ask)
        return fills

    def _auction_fill(
        self, order: Order, price: Decimal, at: datetime, liquidity: str, close: bool = False
    ) -> list[Fill]:
        crosses = order.limit_price is None or (
            price <= order.limit_price if order.side is Side.BUY else price >= order.limit_price
        )
        fills = [self._fill(order, order.remaining, price, at, liquidity)] if crosses else []
        if order.status.is_open:
            if close:
                order.status = OrderStatus.EXPIRED
                order.message = "Didn't fill by the close (day order)"
            else:
                order.status = OrderStatus.WORKING
                order.auction = None
                if order.type is OrderType.MARKET:
                    self._convert_to_limit(order, price)
        return fills

    def _continuous(
        self,
        symbol: str,
        price: Decimal,
        at: datetime,
        volume: int,
        bid: Decimal | None,
        ask: Decimal | None,
    ) -> list[Fill]:
        fills: list[Fill] = []
        capacity = int(volume * self.participation)
        for order in self.open_orders(symbol):  # oldest first: time priority
            if order.status is not OrderStatus.WORKING:
                continue
            if order.type is OrderType.MARKET:  # defensive: market remainders become limits
                fill_price = touch(MarketQuote(price, bid, ask))[1 if order.side is Side.BUY else 0]
            else:
                limit = order.limit_price
                assert limit is not None
                through = price < limit if order.side is Side.BUY else price > limit
                at_limit = price == limit
                if at_limit:
                    order.volume_at_limit += volume  # count the queue even if we can't fill now
                if not (through or (at_limit and order.volume_at_limit >= order.quantity)):
                    continue
                fill_price = limit
            quantity = min(order.remaining, capacity)
            if quantity <= 0:
                continue
            fills.append(self._fill(order, quantity, fill_price, at, "continuous"))
            capacity -= quantity
        return fills

    def expire(self, now: datetime) -> list[Order]:
        """Expire day orders whose session's closing auction has passed (e.g. no closing trade)."""
        local = now.astimezone(SYDNEY)
        today = local.date()
        expired = []
        for order in self.open_orders():
            if order.session > today:
                continue  # queued after the close for the next trading day
            past_session = order.session < today
            after_close = (
                order.session == today
                and self._calendar.is_trading_day(today)
                and local >= self.schedule(today).closing_auction_at + timedelta(minutes=1)
            )
            if past_session or after_close:
                order.status = OrderStatus.EXPIRED
                order.message = "Didn't fill by the close (day order)"
                expired.append(order)
        return expired

    # ------------------------------------------------------------------ persistence

    def to_json(self) -> dict[str, Any]:
        return {
            "account": self.account.to_json(),
            "brokerage": self.brokerage.to_json(),
            "orders": [o.to_json() for o in self.orders.values()],
        }

    @classmethod
    def from_json(
        cls, data: dict[str, Any], calendar: TradingCalendar | None = None
    ) -> ExecutionEngine:
        engine = cls(
            Account.from_json(data["account"]),
            Brokerage.from_json(data["brokerage"]),
            calendar=calendar,
        )
        orders: Iterable[Order] = (Order.from_json(o) for o in data["orders"])
        engine.orders = {o.id: o for o in orders}
        highest = max((int(o_id[1:]) for o_id in engine.orders), default=0)
        engine._ids = itertools.count(highest + 1)
        return engine
