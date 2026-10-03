"""An index-based decimal-rational capture clock, independent of playback."""
from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
import math


def seconds(value: float, name: str) -> Fraction:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'{name} must be finite seconds')
    return Fraction(str(value))


def rational(value: Fraction) -> dict:
    return {'numerator': value.numerator, 'denominator': value.denominator}


@dataclass(frozen=True)
class FrameSchedule:
    start: Fraction
    end: Fraction
    fps: int

    @classmethod
    def create(cls, start: float, duration: float | None, scene_duration: float, fps: int):
        if isinstance(fps, bool) or not isinstance(fps, int) or not 1 <= fps <= 120:
            raise ValueError('fps must be an integer between 1 and 120')
        first = seconds(start, 'start')
        limit = seconds(scene_duration, 'scene duration')
        span = limit - first if duration is None else seconds(duration, 'duration')
        if first < 0 or span <= 0 or first + span > limit:
            raise ValueError('capture interval must satisfy 0 <= start < start + duration <= scene duration')
        schedule = cls(first, first + span, fps)
        if schedule.frames > 1_000_000:
            raise ValueError('at most 1000000 capture frames are supported')
        # A valid rational schedule must also be distinguishable by the JS
        # double clock at the rendering boundary.
        last = first + Fraction(schedule.frames - 1, fps)
        if schedule.frames > 1 and math.ulp(float(schedule.end)) > 1 / fps:
            raise ValueError('frame clock cannot represent this interval at the requested fps')
        if float(first + span) <= float(first):
            raise ValueError('capture interval is not representable by the renderer clock')
        if float(last) >= float(schedule.end):
            raise ValueError('last frame is not representable inside the half-open interval')
        return schedule

    @property
    def frames(self):
        return math.ceil((self.end - self.start) * self.fps)

    def sample(self, index: int) -> dict:
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < self.frames:
            raise ValueError('frame index is outside the capture interval')
        instant = self.start + Fraction(index, self.fps)
        return {'frameIndex': index, 'sourceTime': float(instant), 'exactTime': rational(instant)}

    def manifest(self) -> dict:
        return {'timeSelection': 'sourceTime = start + frameIndex / fps',
                'interval': '[start, end)', 'start': float(self.start), 'end': float(self.end),
                'exactStart': rational(self.start), 'exactEnd': rational(self.end),
                'fps': self.fps, 'frames': self.frames,
                'requestedDuration': float(self.end - self.start),
                'duration': self.frames / self.fps,
                'exactEncodedDuration': rational(Fraction(self.frames, self.fps)),
                'paddingDuration': float(Fraction(self.frames, self.fps) - (self.end - self.start))}
