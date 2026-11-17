# 11. Swing practice steps through daily bars with next-day fills

- **Status:** accepted
- **Date:** 2026-11-17

## Context

Live trading (ADR 0007) teaches intraday skills, one real session at a time. Swing trading,
holding for days or weeks, would take months of calendar time to practise that way. Years of
daily history are available, so a learner can live through a whole bear market in an
evening, as long as they can't see what comes next.

## Decision

**A separate mode with its own small engine.** A session is one stock, a stretch of daily
bars and a cash account. The intraday execution engine (ADR 0008) models auctions, queues
and minute-by-minute liquidity, none of which exist on a daily bar, so it is not reused.

**You decide after the close; orders work on later days.**

| Order | Fills when | At |
|---|---|---|
| Market | the next trading day | that day's open |
| Limit | the day's range reaches the limit | the limit, or the open if the price gapped through it (the better price) |
| Stop | the day's range reaches the stop | the stop, or the open if the price gapped past it (the worse price) |

Orders stay open until they fill or are cancelled. A buy that can no longer be afforded
when it fills is rejected. Brokerage is the same flat fee as live trading. Long only.

**No peeking, enforced on the server.** A session holds the whole practice period, but every
response is built from bars up to the current day only. The browser never receives a later
bar, so there is nothing to find in the network tab.

**Blind practice.** Optionally the stock is drawn from a pool of large companies and the
start date is random, with the name and real dates hidden (the chart shows made-up dates)
until the session ends. Knowing "this is CBA in March 2020" is hindsight; blind mode removes
it. Prices are left as they are, so someone who recognises a price level could still guess.

**Measured against buy and hold.** The benchmark is all the starting cash in the same stock
from day one. Most active trading loses to it, and the result says so plainly.

**Saved locally.** Sessions (with their bars) are saved beside the simulated account, never
in the repository, and the ten most recent are kept.

## Consequences

- With one bar per day there is no way to know whether the high or the low came first. An
  order is judged against the day's range in the order it was placed, so a stop and a target
  that both sit inside one wide day are filled by placement order, not by what really
  happened. Using the open for gaps keeps the result on the pessimistic side for stops.
- No liquidity limits: a daily bar's volume isn't modelled, which flatters very large orders
  in small stocks. The surprise pool is large companies for that reason.
- Prices are split-adjusted but dividends are ignored, for the account and for buy and hold
  alike, so both understate real returns on dividend payers.
- Practice uses finished days only: today's bar is still forming and is left out.
