"""Shared FastAPI dependencies (overridable in tests via app.dependency_overrides)."""

from __future__ import annotations

from functools import cache

from asxsim.data.store import LocalBarStore
from asxsim.settings import bars_1m_dir


@cache
def get_store() -> LocalBarStore:
    return LocalBarStore(bars_1m_dir())
