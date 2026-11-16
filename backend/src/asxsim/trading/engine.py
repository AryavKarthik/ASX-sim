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
    GTC_MAX_DAYS,
    Auction,
    Fill,
    Order,
    OrderRequest,
    OrderStatus,
    OrderType,
    Side,
    TimeInForce,
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
        self._closed: set[tuple[str, date]] = set()  # (symbol, day) whose close auction ran
        self._changed = False  # an open order changed without filling (e.g. a trail moved)
        self._ids = itertools.count(1)

    def take_changes(self) -> bool:
        """True (once) if an open order changed without a fill since the last call."""
        changed, self._changed = self._changed, False
        return changed

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
        if order_or_request.trigger_price is not None:
            return order_or_request.trigger_price
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
        if phase is MarketPhase.ADJUST_ON:
            session = self._calendar.next_trading_day(session)
        if request.type.is_conditional:
            status = OrderStatus.PENDING  # waits for its trigger, whatever the phase
        elif phase in (MarketPhase.PRE_OPEN, MarketPhase.ADJUST_ON):
            auction, status = Auction.OPEN, OrderStatus.QUEUED
        elif phase is MarketPhase.PRE_CSPA:
            auction, status = Auction.CLOSE, OrderStatus.QUEUED

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
            time_in_force=request.time_in_force,
            expires_on=session + timedelta(days=GTC_MAX_DAYS)
            if request.time_in_force is TimeInForce.GTC
            else None,
            trigger_price=request.trigger_price,
            trail_amount=request.trail_amount,
            trail_percent=request.trail_percent,
        )
        if order.type is OrderType.TRAILING_STOP:
            self._update_trail(order, self.quotes[order.symbol].last)
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
        kind = request.type
        if kind in (OrderType.LIMIT, OrderType.STOP_LIMIT):
            self._check_price("limit", request.limit_price)
        elif request.limit_price is not None:
            raise OrderRejectedError("Only limit and stop-limit orders take a limit price")

        if kind in (OrderType.STOP, OrderType.STOP_LIMIT):
            trigger = self._check_price("trigger", request.trigger_price)
            last = quote.last
            if request.side is Side.SELL and trigger >= last:
                raise OrderRejectedError(
                    f"A sell stop's trigger must be below the current price (${last}). "
                    "It sells if the price falls to the trigger."
                )
            if request.side is Side.BUY and trigger <= last:
                raise OrderRejectedError(
                    f"A buy stop's trigger must be above the current price (${last}). "
                    "It buys if the price rises to the trigger."
                )
        elif request.trigger_price is not None:
            raise OrderRejectedError("Only stop and stop-limit orders take a trigger price")

        if kind is OrderType.TRAILING_STOP:
            amount, percent = request.trail_amount, request.trail_percent
            if (amount is None) == (percent is None):
                raise OrderRejectedError("Set the trail as either a dollar amount or a percentage")
            if amount is not None and amount <= 0:
                raise OrderRejectedError("The trail amount must be above zero")
            if percent is not None and not 0 < percent <= 50:
                raise OrderRejectedError("The trail percentage must be between 0% and 50%")
        elif request.trail_amount is not None or request.trail_percent is not None:
            raise OrderRejectedError("Only trailing stops take a trail")

        if request.time_in_force is TimeInForce.GTC and kind is OrderType.MARKET:
            raise OrderRejectedError("Market orders can only be day orders")

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

    @staticmethod
    def _check_price(label: str, price: Decimal | None) -> Decimal:
        if price is None or price <= 0:
            raise OrderRejectedError(f"Enter a {label} price")
        if not is_valid_price(price):
            lower = round_to_tick(price, Rounding.DOWN)
            upper = round_to_tick(price, Rounding.UP)
            raise OrderRejectedError(
                f"${price} isn't a valid ASX price step. Nearest valid prices: ${lower} or ${upper}"
            )
        return price

    # ------------------------------------------------------------------ conditional orders

    @staticmethod
    def _trail_trigger(order: Order, extreme: Decimal) -> Decimal:
        distance = (
            order.trail_amount
            if order.trail_amount is not None
            else extreme * (order.trail_percent or Decimal("0")) / 100
        )
        if order.side is Side.SELL:
            return round_to_tick(max(extreme - distance, Decimal("0.001")), Rounding.DOWN)
        return round_to_tick(extreme + distance, Rounding.UP)

    def _update_trail(self, order: Order, price: Decimal) -> None:
        """Move a trailing stop's trigger with the best price since it was placed."""
        extreme = order.trail_extreme if order.trail_extreme is not None else price
        extreme = max(extreme, price) if order.side is Side.SELL else min(extreme, price)
        order.trail_extreme = extreme
        trigger = self._trail_trigger(order, extreme)
        if trigger != order.trigger_price:
            self._changed = True
        order.trigger_price = trigger

    def _check_triggers(
        self, symbol: str, price: Decimal, at: datetime
    ) -> tuple[set[str], list[Fill]]:
        """Trigger conditional orders on a trade in continuous trading."""
        triggered: set[str] = set()
        fills: list[Fill] = []
        for order in self.open_orders(symbol):
            if order.status is not OrderStatus.PENDING:
                continue
            if order.type is OrderType.TRAILING_STOP:
                self._update_trail(order, price)
            trigger = order.trigger_price
            assert trigger is not None
            hit = price <= trigger if order.side is Side.SELL else price >= trigger
            if not hit:
                continue
            order.conditional = order.type
            order.type = OrderType.LIMIT if order.type is OrderType.STOP_LIMIT else OrderType.MARKET
            order.status = OrderStatus.WORKING
            order.triggered_at = at
            order.message = f"Triggered: traded at ${price} (trigger ${trigger})"
            triggered.add(order.id)
            fills += self._execute_immediately(order, at)
        return triggered, fills

    # ------------------------------------------------------------------ filling

    def settlement_day(self, trade_day: date) -> date:
        """T+2: trades settle two ASX trading days after the trade."""
        return self._calendar.next_trading_day(self._calendar.next_trading_day(trade_day))

    def _fill(
        self, order: Order, quantity: int, price: Decimal, at: datetime, liquidity: str
    ) -> Fill:
        value_after = (order.average_price or Decimal("0")) * order.filled + price * quantity
        fee = self.brokerage.fee(value_after.quantize(Decimal("0.01"))) - order.fees
        fee = max(fee, Decimal("0"))
        settles = self.settlement_day(at.astimezone(SYDNEY).date())
        fill = Fill(
            order.id, order.symbol, order.side, quantity, price, fee, at, liquidity, settles
        )
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

        # Closing auction: orders live in the book take part; then day orders expire and
        # good-till-cancelled ones wait for tomorrow. (Untriggered stops don't take part.)
        if local >= schedule.closing_auction_at:
            key = (symbol, local.date())
            if key in self._closed:
                return fills  # the closing auction already ran; later prints don't rerun it
            self._closed.add(key)
            for order in self.open_orders(symbol):
                if order.session == local.date() and order.status is not OrderStatus.PENDING:
                    fills += self._auction_fill(order, price, at, "closing auction", close=True)
            return fills

        if phase is MarketPhase.OPEN:
            triggered, trigger_fills = self._check_triggers(symbol, price, at)
            fills += trigger_fills
            fills += self._continuous(symbol, price, at, volume, bid, ask, skip=triggered)
        return fills

    def _auction_fill(
        self, order: Order, price: Decimal, at: datetime, liquidity: str, close: bool = False
    ) -> list[Fill]:
        crosses = order.limit_price is None or (
            price <= order.limit_price if order.side is Side.BUY else price >= order.limit_price
        )
        fills = [self._fill(order, order.remaining, price, at, liquidity)] if crosses else []
        if order.status.is_open:
            if close and order.time_in_force is TimeInForce.GTC:
                order.status = OrderStatus.WORKING  # stays open for the next trading day
                order.auction = None
            elif close:
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
        skip: set[str] | None = None,
    ) -> list[Fill]:
        fills: list[Fill] = []
        capacity = int(volume * self.participation)
        for order in self.open_orders(symbol):  # oldest first: time priority
            if order.status is not OrderStatus.WORKING or (skip and order.id in skip):
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
        """End-of-day housekeeping, run often: returns orders that changed.

        - Day orders expire once their session's closing auction has passed.
        - Good-till-cancelled orders roll onto each new trading day (rejoining the opening
          auction if it hasn't happened yet) and expire after GTC_MAX_DAYS.
        """
        local = now.astimezone(SYDNEY)
        today = local.date()
        trading_today = self._calendar.is_trading_day(today)
        changed = []
        for order in self.open_orders():
            if order.session > today:
                continue  # queued after the close for the next trading day
            if order.time_in_force is TimeInForce.GTC:
                if order.expires_on is not None and today > order.expires_on:
                    order.status = OrderStatus.EXPIRED
                    order.message = f"Reached the {GTC_MAX_DAYS}-day limit for good-till-cancelled"
                    changed.append(order)
                elif order.session < today and trading_today:
                    order.session = today
                    before_open = local < self.schedule(today).open_at
                    if order.status is OrderStatus.WORKING and before_open:
                        order.status, order.auction = OrderStatus.QUEUED, Auction.OPEN
                    changed.append(order)
                continue
            past_session = order.session < today
            after_close = (
                order.session == today
                and trading_today
                and local >= self.schedule(today).closing_auction_at + timedelta(minutes=1)
            )
            if past_session or after_close:
                pending = order.status is OrderStatus.PENDING
                order.status = OrderStatus.EXPIRED
                order.message = (
                    "Didn't trigger by the close (day order)"
                    if pending
                    else "Didn't fill by the close (day order)"
                )
                changed.append(order)
        return changed

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
