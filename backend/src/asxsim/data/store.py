"""Read recorded 1-minute bars from disk (the layout the recorder writes)."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pandas as pd

from asxsim.data.recorder import BAR_COLUMNS


class NoDataError(LookupError):
    """Raised when there is no recorded data for a requested day or symbol."""


class LocalBarStore:
    """Recorded 1-minute bars stored as `<root>/<YYYY>/<YYYY-MM-DD>.parquet`."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._cache: dict[date, pd.DataFrame] = {}

    def available_days(self) -> list[date]:
        """Every day with recorded data, oldest first."""
        days = []
        for path in self.root.glob("*/*.parquet"):
            try:
                days.append(date.fromisoformat(path.stem))
            except ValueError:
                continue  # ignore stray files
        return sorted(days)

    def load_day(self, day: date) -> pd.DataFrame:
        """All symbols' bars for one day (cached after the first read)."""
        if day not in self._cache:
            path = self.root / f"{day.year:04d}" / f"{day.isoformat()}.parquet"
            if not path.exists():
                raise NoDataError(f"No recorded data for {day}")
            self._cache[day] = pd.read_parquet(path, columns=BAR_COLUMNS)
        return self._cache[day]

    def symbols(self, day: date) -> list[str]:
        return sorted(self.load_day(day)["symbol"].unique().tolist())

    def bars(self, day: date, symbol: str) -> pd.DataFrame:
        """One symbol's bars for one day, oldest first, with a fresh index."""
        frame = self.load_day(day)
        rows = frame[frame["symbol"] == symbol]
        if rows.empty:
            raise NoDataError(f"No recorded data for {symbol} on {day}")
        return rows.drop(columns="symbol").sort_values("ts", ignore_index=True)
