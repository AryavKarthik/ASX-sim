"""ASX market rules: price steps, the trading calendar, and the phases of a trading day.

Everything in this package is pure: no network, no database, no clock. Functions take the
date or time they need as an argument, which makes them easy to test and safe to use in
replay (where "now" is a simulated time in the past).
"""
