"""Live trading on the delayed market: price feeds, live candles and the delayed market clock.

The simulator's market is the real ASX shifted by the data delay (about 20 minutes on
Yahoo). Prices are streamed as they're published, and everything downstream (chart, phase,
and soon order fills) runs off them in arrival order. See ADR 0007.
"""
