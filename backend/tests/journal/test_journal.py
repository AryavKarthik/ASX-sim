from datetime import UTC, datetime, timedelta
from decimal import Decimal as D  # noqa: N817 - short alias keeps money tables readable
from pathlib import Path

import pytest

from asxsim.journal.journal import Journal, JournalEntry, JournalError, r_multiple
from asxsim.journal.trades import build_trades
from asxsim.trading.orders import Fill, Side

T0 = datetime(2026, 11, 17, 0, 0, tzinfo=UTC)


def fill(order: str, side: Side, qty: int, price: str, minutes: int, symbol: str = "BHP") -> Fill:
    return Fill(
        order,
        symbol,
        side,
        qty,
        D(price),
        D("10.00"),
        T0 + timedelta(minutes=minutes),
        "continuous",
    )


# ---------- trades ----------


def test_a_round_trip_is_one_trade_even_with_scaling_in_and_out() -> None:
    fills = [
        fill("O1", Side.BUY, 100, "10.00", 0),
        fill("O2", Side.BUY, 100, "11.00", 5),  # add
        fill("O3", Side.SELL, 50, "12.00", 10),  # trim
        fill("O4", Side.SELL, 150, "12.00", 20),  # close
        fill("O5", Side.BUY, 10, "60.00", 30, symbol="CBA"),
    ]

    bhp, cba = build_trades(fills)

    assert bhp.id == "BHP-O1"
    assert not bhp.is_open
    assert bhp.closed_at == T0 + timedelta(minutes=20)
    assert (bhp.entry_quantity, bhp.exit_quantity) == (200, 200)
    assert bhp.average_entry == D("10.50")
    assert bhp.average_exit == D("12.00")
    assert bhp.gross_pnl == D("300.00")  # 200 x (12.00 - 10.50)
    assert bhp.fees == D("40.00")
    assert bhp.net_pnl == D("260.00")
    assert bhp.order_ids == ["O1", "O2", "O3", "O4"]
    assert cba.is_open
    assert cba.unrealised(D("61.00")) == D("10.00")


def test_buying_again_after_closing_starts_a_new_trade() -> None:
    fills = [
        fill("O1", Side.BUY, 100, "10.00", 0),
        fill("O2", Side.SELL, 100, "9.50", 5),
        fill("O3", Side.BUY, 100, "9.00", 10),
    ]

    first, second = build_trades(fills)

    assert first.net_pnl == D("-70.00")  # -50 gross, -20 fees
    assert second.id == "BHP-O3"
    assert second.is_open


# ---------- R-multiple ----------


def test_r_multiple_measures_pnl_in_units_of_planned_risk() -> None:
    (trade,) = build_trades(
        [fill("O1", Side.BUY, 100, "10.00", 0), fill("O2", Side.SELL, 100, "11.00", 5)]
    )

    assert r_multiple(trade, JournalEntry(planned_stop=D("9.50"))) == D("1.6")  # $80 net / $50 risk
    assert r_multiple(trade, JournalEntry()) is None  # no planned stop
    assert r_multiple(trade, JournalEntry(planned_stop=D("10.50"))) is None  # stop above entry


# ---------- journal ----------


def test_plan_written_on_the_ticket_becomes_the_trades_entry(tmp_path: Path) -> None:
    journal = Journal(tmp_path / "journal.json")
    journal.attach_plan(
        "O1", {"setup": "Breakout", "thesis": "Cleared resistance", "planned_stop": "9.50"}
    )
    (trade,) = build_trades([fill("O1", Side.BUY, 100, "10.00", 0)])

    entry = journal.entry_for(trade)

    assert entry.setup == "Breakout"
    assert entry.planned_stop == D("9.50")


def test_review_updates_merge_and_persist(tmp_path: Path) -> None:
    path = tmp_path / "journal.json"
    journal = Journal(path)
    journal.attach_plan("O1", {"thesis": "Cleared resistance", "planned_stop": "9.50"})
    (trade,) = build_trades(
        [fill("O1", Side.BUY, 100, "10.00", 0), fill("O2", Side.SELL, 100, "11.00", 5)]
    )

    journal.update(
        trade, {"followed_plan": True, "rating": 4, "emotions": ["Calm"], "went_well": "Waited"}
    )

    reloaded = Journal(path).entry_for(trade)
    assert reloaded.thesis == "Cleared resistance"  # the plan is kept
    assert reloaded.followed_plan is True
    assert reloaded.rating == 4
    assert reloaded.emotions == ["Calm"]
    assert reloaded.updated_at is not None


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        ({"planned_stop": "-1"}, "above zero"),
        ({"planned_stop": "abc"}, "must be a price"),
        ({"confidence": 6}, "1 to 5"),
        ({"rating": "4"}, "1 to 5"),
        ({"emotions": ["a", "b", "c", "d", "e", "f"]}, "up to 5"),
        ({"thesis": "x" * 2001}, "too long"),
        ({"followed_plan": "yes"}, "yes, no or blank"),
    ],
)
def test_entries_are_validated(fields: dict[str, object], message: str, tmp_path: Path) -> None:
    (trade,) = build_trades([fill("O1", Side.BUY, 100, "10.00", 0)])
    with pytest.raises(JournalError, match=message):
        Journal(tmp_path / "j.json").update(trade, fields)


def test_clear_and_corrupt_file_recovery(tmp_path: Path) -> None:
    path = tmp_path / "journal.json"
    journal = Journal(path)
    journal.attach_plan("O1", {"thesis": "x"})
    journal.clear()
    assert Journal(path).plans == {}

    path.write_text("{broken", encoding="utf-8")
    assert Journal(path).entries == {}
    assert len(list(tmp_path.glob("journal.corrupt-*.json"))) == 1
