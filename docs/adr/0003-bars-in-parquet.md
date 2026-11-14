# 3. Store price bars in Parquet files, not the app database

- **Status:** accepted
- **Date:** 2026-11-14

## Context

The app holds two very different kinds of data:

| | App data (orders, fills, journal) | Market data (price bars) |
|---|---|---|
| Size | thousands of rows | millions of rows (200 stocks × ~370 bars × every trading day) |
| Writes | constant, small, transactional | once a day, in bulk, never edited |
| Reads | single records | long time ranges for one symbol, or one day for all symbols |

## Decision

- **Market data** goes in **Parquet**, a compressed columnar file format, with one file per
  Sydney trading date:
  - layout: `bars_1m/<YYYY>/<YYYY-MM-DD>.parquet`,
  - columns: `symbol, ts (UTC), open, high, low, close, volume`.
- Analytical queries use **DuckDB**, which runs SQL directly over Parquet files.
- **App data** stays in SQLite or Postgres.

## Consequences

- Very small storage: one trading day of the full ASX 200 is about 1 MB.
- Files are append-only and safe to re-record: the recorder merges new bars into each day's
  file and removes duplicates.
- Prices are stored as recorded, as float64. The engine rounds to valid ASX tick sizes and
  converts to `Decimal` before any money calculation.
- Two storage technologies to understand instead of one.
