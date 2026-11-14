# 7. Live trading on delayed data is the core; past-day replay is secondary

- **Status:** accepted (narrows the scope of [ADR 0006](0006-replay-clock-and-time-gate.md))
- **Date:** 2026-11-14

## Context

The original plan treated free ASX data, delayed by about 20 minutes, as unusable for day
trading. It made *intraday replay of past days* the main way to practise. The first
clickable app (Day 3) is a past-day replay viewer.

That isn't how the project owner wants to learn. The goal is to day trade **during the
actual trading day**. A 20-minute delay is acceptable as long as prices update as often as
the real market does, and as long as ASX-sim is the only place the trader watches prices.

## Decision

1. **The core product is a live trading session on delayed data.** The simulator's market is
   the real ASX shifted by the data delay (about 20 minutes):
   - The **market clock** is wall-clock time minus the measured delay. Trading phases
     (pre-open, opening auction, continuous trading, closing auction) follow that clock.
   - **Prices stream in as Yahoo publishes them,** using Yahoo's streaming endpoint
     (`yfinance.WebSocket`), not once-a-minute polling. If the stream drops, the app falls
     back to polling 1-minute bars and says so on screen.
   - **Orders are matched against prices in the order they arrive.** A trader can't act on a
     price before the delayed market reaches it, so there's no look-ahead.
   - The UI labels the feed as delayed and shows the measured delay.
2. **The data layer stays swappable,** so a paid real-time feed can replace Yahoo later and
   remove the delay without touching the engine.
3. **Past-day replay remains as a secondary feature** for reviewing days and practising
   outside market hours. The daily recorder keeps running, because it feeds charts (earlier
   days' 1-minute history) and past-day review.
4. **Priority order is now:**
   1. the live delayed feed and live chart,
   2. trading against it (order ticket, fills, account),
   3. journal, analytics and the AI coach.

## Consequences

- Practice happens during real market hours (about 10:20am to 4:30pm Sydney time with the
  delay). Outside those hours the app offers past-day replay.
- Update frequency depends on Yahoo's stream. It must be measured on a live trading day,
  not assumed.
- The fill engine is built once and fed by either source: live ticks, or bars released by the
  replay time gate.
- The market rules (ADR 0005) and the trading-phase schedule apply unchanged. They are
  simply evaluated against the delayed clock.
