"""Simulated trading: orders, fills, brokerage, the account ledger and the execution engine.

Pure Python with Decimal money. The engine is fed prices in the order they happen (live
delayed ticks or a demo day), so a trade can never use a price the market hadn't reached.
"""
