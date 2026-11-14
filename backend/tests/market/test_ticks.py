from decimal import Decimal as D  # noqa: N817 - short alias keeps price tables readable

import pytest
from hypothesis import given
from hypothesis import strategies as st

from asxsim.market.ticks import (
    Rounding,
    clean_reported_price,
    is_valid_price,
    next_tick_down,
    next_tick_up,
    round_to_tick,
    tick_size,
    ticks_between,
    to_decimal,
)

# Any positive price with up to 4 decimal places, from 0.1c to $1,000.
prices = st.decimals(min_value=D("0.001"), max_value=D("1000"), places=4)
valid_prices = prices.map(round_to_tick)


@pytest.mark.parametrize(
    ("price", "step"),
    [
        ("0.001", "0.001"),
        ("0.099", "0.001"),
        ("0.10", "0.005"),  # Rule 9.4.1: "$0.10 and above" is the 0.5c band
        ("0.105", "0.005"),
        ("1.995", "0.005"),
        ("2.00", "0.01"),  # "$2.00 and above" is the 1c band
        ("2.01", "0.01"),
        ("59.26", "0.01"),
    ],
)
def test_tick_size_bands(price: str, step: str) -> None:
    assert tick_size(price) == D(step)


@pytest.mark.parametrize(
    ("price", "valid"),
    [
        ("0.012", True),
        ("0.0125", False),
        ("0.155", True),
        ("0.153", False),
        ("2.00", True),
        ("2.005", False),  # above $2 only whole cents trade
        ("45.67", True),
        ("45.675", False),
        ("0", False),
        ("-1", False),
        ("NaN", False),
    ],
)
def test_is_valid_price(price: str, valid: bool) -> None:
    assert is_valid_price(price) is valid


def test_boundary_neighbours_use_the_band_on_each_side() -> None:
    assert next_tick_up("2.00") == D("2.01")
    assert next_tick_down("2.00") == D("1.995")
    assert next_tick_up("0.10") == D("0.105")
    assert next_tick_down("0.10") == D("0.099")


def test_clean_reported_price_removes_float_noise_but_keeps_midpoint_trades() -> None:
    assert clean_reported_price(59.259998) == D("59.2600")
    # A midpoint trade between 19.69 and 19.70 is real and must survive cleaning.
    assert clean_reported_price(19.69499969482422) == D("19.6950")
    assert clean_reported_price(1.7875) == D("1.7875")
    assert to_decimal(0.1) == D("0.1")


def test_round_to_tick_snaps_onto_the_order_grid() -> None:
    assert round_to_tick(59.259998) == D("59.26")
    assert round_to_tick(1.2350001) == D("1.235")


def test_rounding_direction_matters_for_orders() -> None:
    assert round_to_tick("45.673", Rounding.DOWN) == D("45.67")
    assert round_to_tick("45.671", Rounding.UP) == D("45.68")
    assert round_to_tick("0.1002", Rounding.UP) == D("0.105")


def test_never_rounds_below_the_minimum_price() -> None:
    assert round_to_tick("0.0004", Rounding.DOWN) == D("0.001")


def test_no_price_below_minimum() -> None:
    with pytest.raises(ValueError, match="no valid price below"):
        next_tick_down("0.001")


def test_neighbours_reject_off_grid_prices() -> None:
    with pytest.raises(ValueError, match="not on the ASX tick grid"):
        next_tick_up("2.005")


@pytest.mark.parametrize(
    ("low", "high", "ticks"),
    [("59.25", "59.26", 1), ("1.995", "2.01", 2), ("0.098", "0.11", 4), ("5.00", "5.00", 0)],
)
def test_ticks_between(low: str, high: str, ticks: int) -> None:
    assert ticks_between(low, high) == ticks
    assert ticks_between(high, low) == ticks


# ---------- properties: hypothesis tries thousands of random prices ----------


@given(prices, st.sampled_from(Rounding))
def test_rounding_always_lands_on_the_grid(price: D, mode: Rounding) -> None:
    assert is_valid_price(round_to_tick(price, mode))


@given(prices)
def test_nearest_is_within_half_a_tick(price: D) -> None:
    snapped = round_to_tick(price)
    assert abs(snapped - price) <= max(tick_size(price), tick_size(snapped)) / 2


@given(prices)
def test_up_and_down_bracket_the_price(price: D) -> None:
    assert round_to_tick(price, Rounding.DOWN) <= price <= round_to_tick(price, Rounding.UP) or (
        price < D("0.001")
    )


@given(valid_prices)
def test_rounding_a_valid_price_changes_nothing(price: D) -> None:
    for mode in Rounding:
        assert round_to_tick(price, mode) == price


@given(valid_prices.filter(lambda p: p > D("0.001")))
def test_up_and_down_are_inverses(price: D) -> None:
    assert next_tick_up(next_tick_down(price)) == price
    assert next_tick_down(next_tick_up(price)) == price


@given(valid_prices.filter(lambda p: p < D("50")))
def test_next_tick_up_skips_no_valid_price(price: D) -> None:
    up = next_tick_up(price)
    candidate = price + D("0.001")
    while candidate < up:  # every 0.1c point strictly between must be invalid
        assert not is_valid_price(candidate)
        candidate += D("0.001")
    assert ticks_between(price, up) == 1
