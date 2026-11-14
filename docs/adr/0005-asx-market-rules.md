# 5. ASX market rules: tick sizes, trading phases and the calendar

- **Status:** accepted
- **Date:** 2026-11-14

## Context

The simulator has to accept and fill orders the way the ASX does. Three rules come first:
1. which prices an order may use,
2. what happens at each time of the trading day,
3. which days the market is open.

We checked each one against an official source **and** against our own recorded data
(1.2M real 1-minute bars, 19 Oct to 13 Nov 2026). Both checks changed the design.

## Decision

### Tick sizes (`asxsim.market.ticks`)

Orders follow ASIC Market Integrity Rules (Securities Markets) 2017, Rule 9.4.1:

| Price | Minimum step |
|---|---|
| below $0.10 | $0.001 |
| $0.10 to below $2.00 | $0.005 |
| $2.00 and above | $0.01 |

**What the data showed:** about 28% of recorded 1-minute closes sit *between* those
ticks, for example $19.695. These are midpoint trades (e.g. ASX Centre Point), which are
matched halfway between the best bid and ask and are not bound by the order-book grid.
Yahoo also reports prices as float32 rounded to 3 decimals.

So we use two separate functions:
- `is_valid_price` / `round_to_tick` validate and build **order** prices.
- `clean_reported_price` cleans **market data**. It only removes float noise and never
  forces a midpoint trade onto the grid.

For the fill engine, a half-tick print is evidence that the bid-ask spread was one tick
at that moment.

### Trading phases (`asxsim.market.phases`)

From the ASX "Equity market phases (Sydney times)" page, read 2026-11-14:

| Phase | Starts |
|---|---|
| Pre-open | 07:00 |
| Opening single price auction | 09:59:00 + random 0-15 s |
| Normal trading | 09:59:45 + random 0-15 s |
| Pre-CSPA | 16:00 |
| Closing single price auction | 16:10:00 + random 0-30 s |
| Post close, Adjust, Adjust On, Purge orders | 16:11, 16:21:30, 16:42, 18:50 |

**Correction to the original plan:** the ASX no longer staggers the open by alphabetical
group. Every stock opens in one auction. The ASX working group FAQ links to a notice on
the "removal of staggered opening rotation", and our data agrees: every alphabetical
group's first trade falls in the same minute. The closing auction is clearly visible in
the data, with most end-of-day volume printing in the 16:10 bar.

Random auction times come from a generator seeded by `(date, seed)`, so a replayed day has
a stable timetable.

### Calendar (`asxsim.market.calendar`)

We wrap the `exchange_calendars` "XASX" calendar behind our own `TradingCalendar`. It
handles weekends, public holidays (e.g. Boxing Day 2026 is observed on Monday 28 Dec),
and the 14:10 early closes on Christmas Eve and New Year's Eve.

## Assumptions to revisit

- **Early-close afternoons:** we assume continuous trading ends 10 minutes before the 14:10
  auction, and that post-close phases shift by the same two hours. ADJUST_ON and later
  keep their normal times.
- **Recorded bars:** Yahoo labels the first bar 10:00. Opening-auction volume appears to
  fall in the 10:00-10:01 bars rather than a 09:59 bar. The fill engine will treat the
  first bar of the day as the opening auction.

## Consequences

- Order validation is strict and matches the real rule. Market data keeps its genuine
  sub-tick detail.
- These rules are pure functions with property-based tests, so they can be trusted by the
  fill engine.
