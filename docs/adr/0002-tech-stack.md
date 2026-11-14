# 2. Python (FastAPI) backend, React + TypeScript frontend

- **Status:** accepted
- **Date:** 2026-11-14

## Context

The simulator needs three things:
1. a matching engine and analytics (numerical, data-heavy),
2. a responsive trading UI with professional charts and live updates,
3. an LLM integration.

The author knows Python and R well and is new to web development.

## Decision

- **Backend:** Python 3.12 with FastAPI and Pydantic.
  - Tooling: uv (packages), ruff (lint and format), mypy in strict mode, pytest.
- **Core design:** the domain core (market rules, fill engine, ledger) is plain Python with
  no web or database imports. FastAPI is a thin layer on top ("ports and adapters").
- **Frontend:** React and TypeScript, built with Vite.
  - Charts use TradingView Lightweight Charts.
- **Live updates:** WebSockets push replay ticks to the browser.
- **App database:** SQLite through SQLAlchemy 2.0 and Alembic, so moving to Postgres later is
  a configuration change.

## Alternatives considered

- **Streamlit or Dash:** fastest to start for a Python developer, but they can't deliver a
  trading-platform UI (real-time order ticket, dense layouts, WebSocket-driven charts).
- **Next.js:** solves server rendering and SEO, which a single-user app doesn't need. Vite
  is simpler.

## Consequences

- Two languages and two toolchains, with CI covering both.
- The pure core can be tested quickly and thoroughly without starting a server.
