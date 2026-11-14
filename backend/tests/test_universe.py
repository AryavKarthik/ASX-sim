import re

import pytest

from asxsim.data.universe import BENCHMARKS, load_asx200, recording_universe, yahoo_symbol


def test_asx200_snapshot_has_200_unique_valid_codes() -> None:
    securities = load_asx200()
    codes = [s.code for s in securities]

    assert len(securities) == 200
    assert len(set(codes)) == 200
    assert all(re.fullmatch(r"[A-Z0-9]{3}", c) for c in codes)
    assert all(s.name and s.sector for s in securities)


def test_asx200_contains_known_names() -> None:
    by_code = {s.code: s for s in load_asx200()}

    assert by_code["BHP"].sector == "Materials"
    assert by_code["CBA"].name == "Commonwealth Bank"
    assert by_code["XYX"].name == "Block, Inc."  # quoted comma survives CSV parsing


@pytest.mark.parametrize(
    ("code", "expected"),
    [("BHP", "BHP.AX"), ("360", "360.AX"), ("4DX", "4DX.AX"), ("XJO", "^AXJO")],
)
def test_yahoo_symbol(code: str, expected: str) -> None:
    assert yahoo_symbol(code) == expected


@pytest.mark.parametrize("bad", ["", "bhp", "BHPX", "BHP.AX"])
def test_yahoo_symbol_rejects_invalid_codes(bad: str) -> None:
    with pytest.raises(ValueError, match="Not a valid ASX code"):
        yahoo_symbol(bad)


def test_recording_universe_includes_benchmarks() -> None:
    universe = recording_universe()

    assert len(universe) == 200 + len(BENCHMARKS)
    assert universe["XJO"] == "^AXJO"
    assert universe["BHP"] == "BHP.AX"
