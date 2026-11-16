"""Performance statistics for a trading account.

Everything is computed from closed round-trip trades (net of brokerage) and the account,
so the numbers always reconcile with what you see elsewhere in the app.

    win rate        share of closed trades with a positive net P&L
    payoff ratio    average win / average loss (both as positive numbers)
    profit factor   total won / total lost; above 1 means you make more than you lose
    expectancy      average net P&L per trade: what each new trade is worth, on average
    average R       average R-multiple, for trades with a planned stop
    max drawdown    biggest fall in equity from a previous high, in $ and %
    Sharpe ratio    annualised mean / standard deviation of daily returns (needs 5+ days);
                    measured against 0%, i.e. no risk-free rate is subtracted
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from itertools import pairwise
from typing import Any

from asxsim.journal.journal import JournalEntry, r_multiple
from asxsim.journal.trades import Trade
from asxsim.live.candles import sydney_epoch
from asxsim.market.calendar import SYDNEY

ZERO = Decimal("0")
MIN_DAYS_FOR_SHARPE = 5
TRADING_DAYS_PER_YEAR = 252

EntryLookup = Callable[[Trade], JournalEntry]


@dataclass(frozen=True, slots=True)
class CurvePoint:
    time: datetime
    equity: Decimal


def _f(value: Decimal | None, places: int = 2) -> float | None:
    return None if value is None else round(float(value), places)


def equity_curve(
    starting_cash: Decimal, closed: Sequence[Trade], now: datetime, current_equity: Decimal
) -> list[CurvePoint]:
    """Equity after each closed trade, plus today's equity including open positions.

    Between trades your equity only changes through open positions, which aren't recorded
    over time, so the curve steps at each close and ends at the live value.
    """
    if not closed:
        return [CurvePoint(now, current_equity)] if current_equity != starting_cash else []
    points = [CurvePoint(min(t.opened_at for t in closed), starting_cash)]
    running = starting_cash
    for trade in sorted(closed, key=lambda t: t.closed_at or now):
        running += trade.net_pnl
        points.append(CurvePoint(trade.closed_at or now, running))
    if now > points[-1].time:
        points.append(CurvePoint(now, current_equity))
    return points


def max_drawdown(points: Sequence[CurvePoint]) -> tuple[Decimal, Decimal]:
    """Largest peak-to-trough fall: ($ amount, % of the peak). Both zero if equity never fell."""
    peak = None
    worst_dollars, worst_pct = ZERO, ZERO
    for point in points:
        if peak is None or point.equity > peak:
            peak = point.equity
        drop = peak - point.equity
        if drop > worst_dollars:
            worst_dollars = drop
            worst_pct = drop / peak * 100 if peak else ZERO
    return worst_dollars, worst_pct


def sharpe_ratio(points: Sequence[CurvePoint]) -> float | None:
    """Annualised Sharpe from end-of-day equity. None with fewer than MIN_DAYS_FOR_SHARPE days."""
    by_day: dict[date, Decimal] = {}
    for point in sorted(points, key=lambda p: p.time):
        by_day[point.time.astimezone(SYDNEY).date()] = point.equity  # last value of each day
    closes = [float(v) for _, v in sorted(by_day.items())]
    if len(closes) < MIN_DAYS_FOR_SHARPE + 1:
        return None
    returns = [b / a - 1 for a, b in pairwise(closes) if a]
    if len(returns) < MIN_DAYS_FOR_SHARPE:
        return None
    spread = statistics.stdev(returns)
    if spread == 0:
        return None
    return round(statistics.mean(returns) / spread * math.sqrt(TRADING_DAYS_PER_YEAR), 2)


def benchmark_curve(
    benchmark: Sequence[tuple[datetime, float]],
    curve: Sequence[CurvePoint],
    starting_cash: Decimal,
) -> tuple[list[dict[str, float]], float | None]:
    """The index rescaled so it starts at your starting cash when you started trading.

    That puts both lines in dollars on one axis: "what if I'd just bought the ASX 200?".
    The base is the index level at (or just before) your first trade.
    """
    if not curve or len(benchmark) < 2:
        return [], None
    start = curve[0].time
    ordered = sorted(benchmark)
    before = [p for p in ordered if p[0] <= start]
    after = [p for p in ordered if p[0] > start]
    base_point = before[-1] if before else ordered[0]
    series = [base_point, *[p for p in after if p is not base_point]]
    base = base_point[1]
    if base <= 0 or len(series) < 2:
        return [], None
    points = [
        {"time": sydney_epoch(max(t, start)), "equity": round(float(starting_cash) * v / base, 2)}
        for t, v in series
    ]
    return points, round(100 * (series[-1][1] / base - 1), 2)


def _group_stats(trades: Iterable[Trade], entry_for: EntryLookup) -> dict[str, Any]:
    trades = list(trades)
    wins = [t for t in trades if t.net_pnl > 0]
    rs = [r for t in trades if (r := r_multiple(t, entry_for(t))) is not None]
    return {
        "trades": len(trades),
        "win_rate": round(100 * len(wins) / len(trades), 1) if trades else None,
        "net_pnl": _f(sum((t.net_pnl for t in trades), ZERO)),
        "average_r": _f(sum(rs, ZERO) / len(rs)) if rs else None,
    }


def breakdown(
    trades: Sequence[Trade], entry_for: EntryLookup, key: Callable[[Trade], str]
) -> list[dict[str, Any]]:
    groups: dict[str, list[Trade]] = defaultdict(list)
    for trade in trades:
        groups[key(trade)].append(trade)
    rows = [{"label": label, **_group_stats(ts, entry_for)} for label, ts in groups.items()]
    return sorted(rows, key=lambda r: -(r["net_pnl"] or 0))


def time_of_day(trade: Trade) -> str:
    hour = trade.opened_at.astimezone(SYDNEY).hour
    return f"{hour:02d}:00-{hour + 1:02d}:00"


def performance(
    starting_cash: Decimal,
    equity: Decimal,
    realised: Decimal,
    unrealised: Decimal,
    fees: Decimal,
    trades: Sequence[Trade],
    entry_for: EntryLookup,
    now: datetime,
    benchmark: Sequence[tuple[datetime, float]] = (),
) -> dict[str, Any]:
    """Everything the Performance view shows, as plain JSON-ready values."""
    closed = [t for t in trades if not t.is_open]
    wins = [t for t in closed if t.net_pnl > 0]
    losses = [t for t in closed if t.net_pnl <= 0]
    won = sum((t.net_pnl for t in wins), ZERO)
    lost = -sum((t.net_pnl for t in losses), ZERO)
    average_win = won / len(wins) if wins else None
    average_loss = lost / len(losses) if losses else None
    rs = [r for t in closed if (r := r_multiple(t, entry_for(t))) is not None]
    gross_profit = sum((t.gross_pnl for t in closed if t.gross_pnl > 0), ZERO)

    curve = equity_curve(starting_cash, closed, now, equity)
    drawdown, drawdown_pct = max_drawdown(curve)

    bench_points, bench_return = benchmark_curve(benchmark, curve, starting_cash)

    entries = [entry_for(t) for t in closed]
    planned = [e for e in entries if e.planned_stop is not None or e.thesis]
    followed = [t for t, e in zip(closed, entries, strict=True) if e.followed_plan is True]
    broke = [t for t, e in zip(closed, entries, strict=True) if e.followed_plan is False]

    return {
        "summary": {
            "starting_cash": _f(starting_cash),
            "equity": _f(equity),
            "net_pnl": _f(equity - starting_cash),
            "total_return_pct": _f((equity / starting_cash - 1) * 100) if starting_cash else None,
            "realised": _f(realised),
            "unrealised": _f(unrealised),
            "fees": _f(fees),
            "fees_pct_of_gross_profit": _f(fees / gross_profit * 100, 1) if gross_profit else None,
            "benchmark_return_pct": bench_return,
        },
        "trades": {
            "closed": len(closed),
            "open": len(trades) - len(closed),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": round(100 * len(wins) / len(closed), 1) if closed else None,
            "average_win": _f(average_win),
            "average_loss": _f(average_loss),
            "payoff_ratio": _f(average_win / average_loss)
            if average_win and average_loss
            else None,
            "profit_factor": _f(won / lost) if lost else None,
            "expectancy": _f(sum((t.net_pnl for t in closed), ZERO) / len(closed))
            if closed
            else None,
            "average_r": _f(sum(rs, ZERO) / len(rs)) if rs else None,
            "best": _f(max((t.net_pnl for t in closed), default=None)),
            "worst": _f(min((t.net_pnl for t in closed), default=None)),
            "average_holding_minutes": round(
                statistics.mean(
                    ((t.closed_at or now) - t.opened_at).total_seconds() / 60 for t in closed
                )
            )
            if closed
            else None,
        },
        "risk": {
            "max_drawdown": _f(drawdown),
            "max_drawdown_pct": _f(drawdown_pct),
            "sharpe": sharpe_ratio(curve),
            "sharpe_days_needed": MIN_DAYS_FOR_SHARPE,
        },
        "curve": [{"time": sydney_epoch(p.time), "equity": _f(p.equity)} for p in curve],
        "benchmark": bench_points,
        "by_setup": breakdown(closed, entry_for, lambda t: entry_for(t).setup or "No setup"),
        "by_time": sorted(breakdown(closed, entry_for, time_of_day), key=lambda r: r["label"]),
        "by_symbol": breakdown(closed, entry_for, lambda t: t.symbol),
        "discipline": {
            "planned_pct": round(100 * len(planned) / len(closed), 1) if closed else None,
            "reviewed": sum(1 for e in entries if e.followed_plan is not None or e.rating),
            "followed": _group_stats(followed, entry_for),
            "broke": _group_stats(broke, entry_for),
        },
    }
