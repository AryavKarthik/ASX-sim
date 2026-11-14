"""ASX price steps ("tick sizes").

Orders on an ASX order book can only be priced on a grid that gets coarser as the price
rises (ASIC Market Integrity Rules (Securities Markets) 2017, Rule 9.4.1):

    below $0.10               -> steps of 0.1c   ($0.001)
    $0.10 up to below $2.00   -> steps of 0.5c   ($0.005)
    $2.00 and above           -> steps of 1c     ($0.01)

The boundary prices ($0.10 and $2.00) sit on both neighbouring grids, so the step *above*
a boundary differs from the step *below* it: one tick above $2.00 is $2.01, and one tick
below is $1.995.

Important: *reported trade prices* are not always on this grid. Midpoint trades (e.g. ASX
Centre Point, matched halfway between the best bid and ask) can print at half a tick, and
in our recorded data roughly 28% of 1-minute closes do. So order prices are validated with
`is_valid_price`, but market data is cleaned with `clean_reported_price`, which only removes
floating-point noise. See ADR 0005.

All prices are `Decimal`. Binary floats can't represent most cent values exactly
(0.1 + 0.2 != 0.3), which turns into rounding errors in money.
"""

from __future__ import annotations

from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, Decimal
from enum import StrEnum

TEN_CENTS = Decimal("0.10")
TWO_DOLLARS = Decimal("2.00")
MIN_PRICE = Decimal("0.001")

_STEP_SMALL = Decimal("0.001")
_STEP_MID = Decimal("0.005")
_STEP_LARGE = Decimal("0.01")

PriceLike = Decimal | float | int | str


class Rounding(StrEnum):
    NEAREST = "nearest"
    UP = "up"
    DOWN = "down"


_DECIMAL_ROUNDING = {
    Rounding.NEAREST: ROUND_HALF_EVEN,
    Rounding.UP: ROUND_CEILING,
    Rounding.DOWN: ROUND_FLOOR,
}


def to_decimal(value: PriceLike) -> Decimal:
    """Convert to Decimal without float artefacts (0.1 becomes 0.1, not 0.1000000000000000055)."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        return Decimal(repr(value))
    return Decimal(value)


def _positive(value: PriceLike) -> Decimal:
    price = to_decimal(value)
    if not price.is_finite() or price <= 0:
        raise ValueError(f"Price must be a positive number, got {value!r}")
    return price


def tick_size(price: PriceLike) -> Decimal:
    """The minimum price step for the band that `price` falls in (Rule 9.4.1)."""
    p = _positive(price)
    if p < TEN_CENTS:
        return _STEP_SMALL
    if p < TWO_DOLLARS:
        return _STEP_MID
    return _STEP_LARGE


def _step_below(p: Decimal) -> Decimal:
    """The step down from `p`: at a band boundary this is the smaller band's step."""
    if p <= TEN_CENTS:
        return _STEP_SMALL
    if p <= TWO_DOLLARS:
        return _STEP_MID
    return _STEP_LARGE


def clean_reported_price(price: PriceLike) -> Decimal:
    """Turn a reported trade price (e.g. Yahoo's float32 59.259998) into a clean Decimal.

    Rounds to 0.01c, which removes float noise without forcing midpoint trades (which can
    sit between ticks) onto the order-book grid.
    """
    return _positive(price).quantize(Decimal("0.0001"), rounding=ROUND_HALF_EVEN)


def is_valid_price(price: PriceLike) -> bool:
    """True if `price` is a price the ASX would accept for an order (positive, on the grid)."""
    try:
        p = _positive(price)
    except (ValueError, ArithmeticError):
        return False
    return p % tick_size(p) == 0


def round_to_tick(price: PriceLike, mode: Rounding = Rounding.NEAREST) -> Decimal:
    """Snap a price onto the ASX order-book grid.

    For order logic: a buy limit derived from a calculation should round DOWN so it never
    pays more than intended; a sell limit rounds UP. (To clean reported market data, use
    `clean_reported_price` instead, since midpoint trades are legitimately off-grid.)
    """
    p = _positive(price)
    step = tick_size(p)
    snapped = (p / step).quantize(Decimal(1), rounding=_DECIMAL_ROUNDING[mode]) * step
    snapped = snapped.quantize(step)
    return snapped if snapped >= MIN_PRICE else MIN_PRICE


def next_tick_up(price: PriceLike) -> Decimal:
    """The next valid price above a valid price."""
    p = _require_valid(price)
    step = tick_size(p)
    return (p + step).quantize(step)


def next_tick_down(price: PriceLike) -> Decimal:
    """The next valid price below a valid price. There is nothing below 0.1c."""
    p = _require_valid(price)
    if p <= MIN_PRICE:
        raise ValueError("There is no valid price below $0.001")
    step = _step_below(p)
    return (p - step).quantize(step)


def ticks_between(low: PriceLike, high: PriceLike) -> int:
    """How many tick steps separate two valid prices (e.g. a spread of 1.995/2.01 is 2 ticks)."""
    lo, hi = _require_valid(low), _require_valid(high)
    if lo > hi:
        lo, hi = hi, lo
    count = 0
    # Walk band by band: at most three bands, so this is a handful of arithmetic steps.
    for band_top, step in ((TEN_CENTS, _STEP_SMALL), (TWO_DOLLARS, _STEP_MID), (None, _STEP_LARGE)):
        if band_top is not None and lo >= band_top:
            continue
        upper = hi if band_top is None else min(hi, band_top)
        count += int((upper - lo) / step)
        if band_top is None or hi <= band_top:
            break
        lo = band_top
    return count


def _require_valid(price: PriceLike) -> Decimal:
    p = _positive(price)
    if p % tick_size(p) != 0:
        raise ValueError(f"{p} is not on the ASX tick grid (step {tick_size(p)})")
    return p
