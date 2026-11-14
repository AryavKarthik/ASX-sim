# 4. Code is public; market data stays private

- **Status:** accepted
- **Date:** 2026-11-14

## Context

ASX market data is owned and licensed by the ASX. Yahoo Finance shows it under licence,
and its terms allow personal, non-commercial use but not redistribution. `yfinance` is an
unofficial client and is not affiliated with Yahoo. This repository is public, and a public
website showing ASX prices would count as redistribution.

Yahoo also only serves about 30 days of 1-minute history. Charts showing earlier days'
intraday moves, and the secondary past-day replay feature, need that history recorded
continuously. (Live trading itself streams delayed prices directly; see ADR 0007.)

## Decision

1. **No market data in this repository.** `data/` and `*.parquet` are gitignored.
2. **Recording runs privately.** A scheduled GitHub Actions workflow in a separate *private*
   repository (`ASX-sim-data`) checks out this code, runs `asxsim.data.recorder` after each
   trading day, and commits the Parquet files into the private repository. Its logs stay
   private too.
3. **Local use reads real data** from a local clone of the private repository.
4. **Public demos and automated tests use synthetic data:** generated prices on fictional
   tickers. Whether a public demo is offered at all will be decided before v1.0.

## Consequences

- The project is safe to publish and share.
- Anyone else running ASX-sim records their own data for their own use.
- Real-time or paid providers can be added later through the data-provider interface,
  under their own licence terms.

*This reflects a reasonable reading of the terms. It is not legal advice.*
