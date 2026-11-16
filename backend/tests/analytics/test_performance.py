from datetime import UTC, datetime, timedelta
from decimal import Decimal as D  # noqa: N817 - short alias keeps money tables readable

import pytest

from asxsim.analytics.performance import (
    CurvePoint,
    benchmark_curve,
    equity_curve,
    max_drawdown,
    performance,
    sharpe_ratio,
)
from asxsim.journal.journal import JournalEntry
from asxsim.journal.trades import Trade, build_trades
from asxsim.trading.orders import Fill, Side

T0 = datetime(2026, 11, 16, 23, 30, tzinfo=UTC)  # 10:30 Sydney, Tue 17 Nov
START = D("10000")


def round_trip(n: int, buy: str, sell: str, minutes: int, symbol: str = "BHP") -> list[Fill]:
    opened = T0 + timedelta(minutes=minutes)
    return [
        Fill(f"B{n}", symbol, Side.BUY, 100, D(buy), D("10.00"), opened, "continuous"),
        Fill(
            f"S{n}",
            symbol,
            Side.SELL,
            100,
            D(sell),
            D("10.00"),
            opened + timedelta(minutes=5),
            "continuous",
        ),
    ]


# Three closed trades: +$80, -$70, +$180 net (each pays $20 brokerage).
FILLS = [
    *round_trip(1, "10.00", "11.00", 0),
    *round_trip(2, "10.00", "9.50", 30),
    *round_trip(3, "10.00", "12.00", 60, symbol="CBA"),
]
TRADES = build_trades(FILLS)
PLANS = {
    "BHP-B1": JournalEntry(setup="Breakout", planned_stop=D("9.50"), followed_plan=True),
    "BHP-B2": JournalEntry(setup="Breakout", planned_stop=D("9.50"), followed_plan=False),
    "CBA-B3": JournalEntry(setup="Pullback"),
}


def entry_for(trade: Trade) -> JournalEntry:
    return PLANS.get(trade.id, JournalEntry())


def report() -> dict:  # type: ignore[type-arg]
    now = T0 + timedelta(hours=3)
    return performance(START, START + D("190"), D("190"), D("0"), D("60"), TRADES, entry_for, now)


def test_trade_statistics() -> None:
    stats = report()["trades"]

    assert (stats["closed"], stats["wins"], stats["losses"]) == (3, 2, 1)
    assert stats["win_rate"] == 66.7
    assert stats["average_win"] == 130.0
    assert stats["average_loss"] == 70.0
    assert stats["payoff_ratio"] == 1.86
    assert stats["profit_factor"] == 3.71  # 260 won / 70 lost
    assert stats["expectancy"] == 63.33
    assert stats["average_r"] == pytest.approx(0.1, abs=0.01)  # (+1.6R, -1.4R) / 2
    assert (stats["best"], stats["worst"]) == (180.0, -70.0)
    assert stats["average_holding_minutes"] == 5


def test_summary_and_fees() -> None:
    summary = report()["summary"]

    assert summary["total_return_pct"] == 1.9
    assert summary["fees"] == 60.0
    assert summary["fees_pct_of_gross_profit"] == 20.0  # $60 of $300 gross profit


def test_breakdowns_and_discipline() -> None:
    data = report()

    by_setup = {row["label"]: row for row in data["by_setup"]}
    assert by_setup["Pullback"]["net_pnl"] == 180.0
    assert by_setup["Breakout"]["win_rate"] == 50.0
    assert [row["label"] for row in data["by_time"]] == ["10:00-11:00", "11:00-12:00"]
    assert data["discipline"]["planned_pct"] == 66.7
    assert data["discipline"]["followed"]["net_pnl"] == 80.0
    assert data["discipline"]["broke"]["net_pnl"] == -70.0


def test_equity_curve_steps_at_each_close_and_ends_live() -> None:
    now = T0 + timedelta(hours=3)
    curve = equity_curve(START, TRADES, now, START + D("250"))

    assert [p.equity for p in curve] == [D("10000"), D("10080"), D("10010"), D("10190"), D("10250")]
    assert curve[-1].time == now


def test_max_drawdown() -> None:
    points = [CurvePoint(T0, D(v)) for v in ("100", "120", "90", "110", "80", "130")]
    assert max_drawdown(points) == (D("40"), D("40") / D("120") * 100)
    assert max_drawdown([CurvePoint(T0, D("100"))]) == (D("0"), D("0"))


def test_sharpe_needs_enough_days() -> None:
    few = [CurvePoint(T0 + timedelta(days=i), D(10000 + i)) for i in range(3)]
    assert sharpe_ratio(few) is None

    values = [10000, 10050, 10020, 10100, 10080, 10150, 10200]
    many = [CurvePoint(T0 + timedelta(days=i), D(v)) for i, v in enumerate(values)]
    sharpe = sharpe_ratio(many)
    assert sharpe is not None
    assert sharpe > 0


def test_benchmark_is_rescaled_to_your_starting_cash() -> None:
    curve = [CurvePoint(T0, START), CurvePoint(T0 + timedelta(hours=2), D("10100"))]
    index = [
        (T0 - timedelta(minutes=1), 8000.0),  # level just before you started: the base
        (T0 + timedelta(hours=1), 8080.0),
        (T0 + timedelta(hours=2), 7960.0),
    ]

    points, change = benchmark_curve(index, curve, START)

    assert [p["equity"] for p in points] == [10000.0, 10100.0, 9950.0]
    assert change == -0.5


def test_empty_account_has_no_curve_or_stats() -> None:
    data = performance(START, START, D("0"), D("0"), D("0"), [], entry_for, T0)

    assert data["curve"] == []
    assert data["trades"]["win_rate"] is None
    assert data["risk"]["sharpe"] is None
