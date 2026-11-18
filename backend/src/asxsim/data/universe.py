"""The set of securities the simulator knows about.

For v1 this is the S&P/ASX 200 plus a few benchmarks. The constituent list is a snapshot
(index membership changes each quarter), so it is stored as a CSV with an "as of" date and
refreshed by hand.

Checked against Yahoo on 18 Nov 2026: four members of the April snapshot no longer trade
(no prices for a month, consistent with being delisted) and were removed, so the list
holds 196 stocks; Block's code was corrected from XYX to XYZ. Their index replacements
aren't added until a current constituent list can be confirmed.
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass
from datetime import date
from importlib import resources

ASX200_AS_OF = date(2026, 4, 5)
ASX200_SOURCE = "https://en.wikipedia.org/wiki/S%26P/ASX_200 (constituents table)"
# In the snapshot but no longer trading (checked 2026-11-18), so left out of the CSV.
ASX200_DELISTED = ("ASK", "IFL", "NSR", "QUB")

# ASX codes are 3 characters of letters/digits (e.g. BHP, S32, 360, 4DX).
_ASX_CODE = re.compile(r"^[A-Z0-9]{3}$")

# Benchmarks recorded alongside the index members, keyed by the code used inside the app.
BENCHMARKS: dict[str, str] = {
    "XJO": "^AXJO",  # S&P/ASX 200 index
    "VAS": "VAS.AX",  # Vanguard Australian Shares ETF
    "STW": "STW.AX",  # SPDR S&P/ASX 200 ETF
}


@dataclass(frozen=True, slots=True)
class Security:
    """A listed security, identified by its ASX code."""

    code: str
    name: str
    sector: str

    @property
    def yahoo_symbol(self) -> str:
        return yahoo_symbol(self.code)


def yahoo_symbol(code: str) -> str:
    """Translate an ASX code into Yahoo Finance's ticker format (BHP -> BHP.AX)."""
    if code in BENCHMARKS:
        return BENCHMARKS[code]
    if not _ASX_CODE.match(code):
        raise ValueError(f"Not a valid ASX code: {code!r}")
    return f"{code}.AX"


def load_asx200() -> list[Security]:
    """Load the bundled S&P/ASX 200 constituent snapshot."""
    text = resources.files("asxsim.data").joinpath("asx200.csv").read_text(encoding="utf-8")
    rows = csv.DictReader(text.splitlines())
    return [Security(code=r["code"], name=r["name"], sector=r["sector"]) for r in rows]


_BENCHMARK_NAMES = {
    "XJO": "S&P/ASX 200 Index",
    "VAS": "Vanguard Australian Shares ETF",
    "STW": "SPDR S&P/ASX 200 ETF",
}


def security_names() -> dict[str, str]:
    """Display names for every code we know: ASX 200 members plus benchmarks."""
    return {s.code: s.name for s in load_asx200()} | _BENCHMARK_NAMES


def recording_universe() -> dict[str, str]:
    """Map every app code we record to its Yahoo symbol: the ASX 200 plus benchmarks."""
    universe = {s.code: s.yahoo_symbol for s in load_asx200()}
    universe.update(BENCHMARKS)
    return universe
