"""A simulated clock for replaying past trading days.

Real time and replay time are separate. The clock only moves when the engine tells it how
much real time has passed, and it moves `speed` times faster: at 60x, one real second is
one market minute.

Like the real market there is no rewind. Once you've seen a price, you can't go back and
trade before it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

MAX_SPEED = 600.0  # 10 market minutes per real second


@dataclass
class ReplayClock:
    now: datetime
    end: datetime
    speed: float = 1.0
    playing: bool = False

    def __post_init__(self) -> None:
        if self.now.tzinfo is None or self.end.tzinfo is None:
            raise ValueError("ReplayClock needs timezone-aware datetimes")
        if self.end < self.now:
            raise ValueError("Replay end is before its start")
        self.set_speed(self.speed)

    @property
    def finished(self) -> bool:
        return self.now >= self.end

    def play(self) -> None:
        if not self.finished:
            self.playing = True

    def pause(self) -> None:
        self.playing = False

    def set_speed(self, speed: float) -> None:
        if not 0 < speed <= MAX_SPEED:
            raise ValueError(f"Speed must be between 0 and {MAX_SPEED:g}x, got {speed}")
        self.speed = float(speed)

    def advance(self, real_seconds: float) -> None:
        """Move forward by `real_seconds` of wall-clock time (scaled by speed), if playing."""
        if real_seconds < 0:
            raise ValueError("Time can't run backwards")
        if self.playing:
            self._move_to(self.now + timedelta(seconds=real_seconds * self.speed))

    def jump_to(self, moment: datetime) -> None:
        """Skip forward to `moment` (capped at the end). Going back is not allowed."""
        if moment < self.now:
            raise ValueError("No rewinding: replay time only moves forward")
        self._move_to(moment)

    def _move_to(self, moment: datetime) -> None:
        self.now = min(moment, self.end)
        if self.finished:
            self.playing = False
