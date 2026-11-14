from datetime import UTC, datetime, timedelta

import pytest

from asxsim.engine.clock import ReplayClock

START = datetime(2026, 11, 12, 22, 50, tzinfo=UTC)


def clock(**kwargs: object) -> ReplayClock:
    return ReplayClock(now=START, end=START + timedelta(hours=7), **kwargs)  # type: ignore[arg-type]


def test_time_only_moves_while_playing() -> None:
    c = clock()
    c.advance(10)
    assert c.now == START

    c.play()
    c.advance(10)
    assert c.now == START + timedelta(seconds=10)


def test_speed_scales_real_time() -> None:
    c = clock(speed=60)
    c.play()
    c.advance(1.5)
    assert c.now == START + timedelta(minutes=1, seconds=30)


def test_stops_at_the_end() -> None:
    c = clock(speed=600)
    c.play()
    c.advance(10_000)

    assert c.finished
    assert not c.playing
    assert c.now == c.end
    c.play()
    assert not c.playing  # can't resume a finished replay


def test_no_rewind() -> None:
    c = clock()
    c.jump_to(START + timedelta(minutes=5))
    with pytest.raises(ValueError, match="No rewinding"):
        c.jump_to(START)
    with pytest.raises(ValueError, match="backwards"):
        c.advance(-1)


@pytest.mark.parametrize("speed", [0, -1, 601])
def test_rejects_silly_speeds(speed: float) -> None:
    with pytest.raises(ValueError, match="Speed"):
        clock(speed=speed)


def test_requires_timezone_aware_times() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        ReplayClock(now=datetime(2026, 11, 13, 10), end=datetime(2026, 11, 13, 16))
