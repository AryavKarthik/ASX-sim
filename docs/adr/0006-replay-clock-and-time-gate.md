# 6. A replay clock and a single time gate prevent look-ahead

- **Status:** accepted. Scope narrowed by [ADR 0007](0007-live-delayed-trading-is-the-core.md):
  replay is now the secondary past-day feature, and live delayed trading is the core.
- **Date:** 2026-11-14

## Context

Intraday replay is only useful for practice if you can't see the future. "Look-ahead" is
the classic backtesting bug: the strategy, the chart or the person uses information that
wasn't available yet. It usually creeps in through many small places, like a chart that
loads the whole day or an indicator that peeks one bar ahead. The AI coach (week 3) makes
it worse, because it will fetch data on its own.

## Decision

- **`ReplayClock`** holds the simulated time. It moves only when the engine reports how much
  real time has passed (scaled by speed), or when it's told to jump forward. It can never
  move backwards: no rewinding, like the real market.
- **`TimeGate`** is the *only* path from recorded bars to anything that displays or acts on
  them. A 1-minute bar labelled 10:30 is released when the clock reaches 10:31:00, because
  its high, low and close aren't known until then.
- **The browser never receives bars it shouldn't.** The server streams bars over a WebSocket
  as the gate releases them, so the page source and network traffic contain only the past.
- **The gate is property-tested** (Hypothesis, thousands of random clock times): a released
  bar has always finished, and every finished bar is released.

## A bug this caught

pandas 3 stores timestamps built from Python datetimes in **microseconds**, while
`Timestamp.value` is **nanoseconds**. The first version of the gate compared the two, which
made every bar look finished and showed the whole day at 09:50. The tests caught it before
it shipped. The gate now converts both sides to nanoseconds explicitly.

## Consequences

- Look-ahead safety lives in one small, well-tested class instead of being every feature's
  job.
- Future data consumers (order matching, indicators, the AI coach's tools) must take a gate,
  not raw bars.
