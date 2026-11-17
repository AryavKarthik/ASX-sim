# 9. Trading halts are inferred from the price feed

- **Status:** accepted
- **Date:** 2026-11-17

## Context

The ASX halts trading in a stock ahead of price-sensitive announcements. During a halt
orders can still be entered, changed and cancelled, but nothing matches; trading resumes
with an auction, often at a price far from the last trade.

Yahoo's feed has no halt flag. Before this decision a halted stock simply stopped printing,
and the simulator would have filled a market order instantly at the last (stale) price:
easier than the real market, which ADR 0008 forbids.

## Decision

**Detect halts from the trades themselves.** A stock is treated as halted when, during
continuous trading:

- it has gone silent for at least 15 minutes, **and**
- that silence is implausible for the stock's own rhythm today. If it has traded in a share
  `p` of minutes, `n` silent minutes in a row happen by chance with probability `(1 - p)^n`;
  the gap must push that below 1 in 100 million. A stock trading 90% of minutes needs only
  the 15-minute minimum; one trading half the time needs 27 minutes. Stocks trading in under
  30% of minutes, or with under 15 minutes of history today, are never flagged.

"Now" is the latest trade in *any* watched symbol, not the wall clock. A feed outage, where
nothing trades anywhere, therefore never looks like a halt, and demos behave the same at any
replay speed. Indexes are never flagged.

**While a stock is halted** the engine follows the ASX rules:

- new orders are accepted but queued for the reopening auction,
- resting orders don't match and stops don't trigger (there are no trades),
- orders can be cancelled.

**The first trade after the halt is the reopening auction.** Queued orders, and resting
orders that cross, fill in full at that single price. Stops are checked after it, so a stop
sells *after* the gap, at the reopened price, not at its trigger. That is the real risk of
holding through a halt, and the simulator shows it.

## Consequences

- The label is honest: the UI says "looks halted" and explains that it is inferred.
- Run over 20 recorded days (about 196 stocks each), the rule flagged 3 stock-days, each for
  a few minutes. A fixed 10-minute rule flagged about 60. Occasional false positives delay a
  fill until the next trade, which is harmless; missing a real halt would let an order fill
  at a stale price, which is not.
- A halt is noticed 15 or more minutes after it starts. Orders placed in that window against
  a stock that has just been halted can still fill at the last price. A paid feed with a real
  halt flag would close this gap.
- Multi-day suspensions look like "no price today" rather than a halt, since detection needs
  today's trading history.
