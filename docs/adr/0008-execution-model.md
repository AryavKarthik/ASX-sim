# 8. How simulated orders fill

- **Status:** accepted
- **Date:** 2026-11-14

## Context

ASX-sim fills orders against the live delayed price stream (ADR 0007). The project owner
chose that **orders fill at the delayed prices shown, as if they were live**. We see each
trade's price and volume, but not the order book, so fills have to be *modelled*.

The goal is that practice is honest. It should never be easier than the real market, but
it shouldn't be absurdly harsh either.

## Decision

- **Bid and ask.** Use the feed's bid and ask when it provides them. Otherwise assume a
  one-tick spread around the last trade: bid = last trade rounded down to the tick grid,
  ask = one tick above that. A midpoint print of $19.695 implies a 19.69 / 19.70 market.
  A round trip therefore costs about one tick, like a liquid ASX 200 stock.
- **Liquidity cap.** Our fills can be at most 25% of the volume that actually trades. For a
  market order the estimate is the busier of the last completed minute and the current
  minute so far. Big orders fill partly.
- **Market orders** buy at the ask and sell at the bid. An unfilled remainder becomes a limit
  order at the last fill price, as ASX market-to-limit orders do.
- **Limit orders** that cross the market fill straight away at the touch (which can be better
  than the limit). Resting limits fill when trades go *through* the price, or trade *at*
  the price after as much volume as our order has traded there (a stand-in for the queue
  ahead of us). They fill at the limit, never better.
- **Auctions.** Orders placed in pre-open wait for the opening auction. Orders placed
  16:00-16:10 wait for the closing auction. They fill at the auction price, taken as the
  first trade at or after the auction, with no volume cap (ASX 200 auctions are deep).
  Orders still open take part in the close. Orders placed after the close are for the next
  trading day.
- **Day orders** expire after the closing auction.
- **ASX and broker rules:**
  - valid price steps (ADR 0005),
  - a $500 minimum for a first purchase of a stock,
  - no short selling,
  - buying power = cash minus what open buy orders could cost, including brokerage.
- **Brokerage** is charged per order: a flat fee, a percentage, or a percentage with a
  minimum (default $10 flat). Partial fills of one order share one fee.
- **Stale prices never fill orders.** A snapshot of an old price (e.g. Friday's close sent on
  a weekend subscribe) updates price estimates but can't trigger a fill.
- **State.** The live account (cash, holdings, orders, fills) is saved to
  `~/.asxsim/live_account.json` after every change, written atomically, and kept outside
  the repository. A demo uses its own throwaway account.

## Consequences

- Results include realistic frictions: spread, brokerage, partial fills and missed limit fills.
- With no order-book data, queue position and market impact are estimates. They are
  centralised in `asxsim.trading.engine`, so they can be calibrated later. For example, real
  ASX bid/ask spreads could be measured from the live feed on Monday.
- Not yet modelled: stop, stop-limit and trailing-stop orders, good-till-cancelled orders,
  T+2 settlement, trading halts and short selling (planned, see README roadmap).
