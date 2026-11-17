"""Runtime settings, read from environment variables (see `.env.example`)."""

from __future__ import annotations

import os
from pathlib import Path

# backend/src/asxsim/settings.py -> parents[3] is the repository root.
REPO_ROOT = Path(__file__).resolve().parents[3]


def data_dir() -> Path:
    """Where recorded market data lives: a local clone of the private ASX-sim-data repo.

    Set ASXSIM_DATA_DIR to override. Relative paths are resolved from the repository root.
    Defaults to a folder called ASX-sim-data next to this repository.
    """
    configured = os.environ.get("ASXSIM_DATA_DIR")
    path = Path(configured) if configured else REPO_ROOT.parent / "ASX-sim-data"
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path.resolve()


def bars_1m_dir() -> Path:
    return data_dir() / "bars_1m"


def state_dir() -> Path:
    """Where your simulated account is saved. Kept outside the repo so it's never committed.

    Set ASXSIM_STATE_DIR to override; defaults to ~/.asxsim.
    """
    configured = os.environ.get("ASXSIM_STATE_DIR")
    return Path(configured).expanduser().resolve() if configured else Path.home() / ".asxsim"


def load_env(path: Path | None = None) -> None:
    """Read `KEY=value` lines from the repository's `.env` into the environment.

    Variables already set in the real environment win, so a key exported in your shell
    overrides the file. Blank values are skipped. The file's contents are never logged.
    """
    env_file = path or REPO_ROOT / ".env"
    if not env_file.is_file():
        return
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip("'\"")
        if key.strip() and value:
            os.environ.setdefault(key.strip(), value)
