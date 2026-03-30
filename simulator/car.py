from __future__ import annotations

from dataclasses import dataclass
import math
import random


@dataclass
class Car:
    latitude: float
    longitude: float
    speed: float = 0.0
    angle: float = 0.0
    ignition: bool = True

    def accelerate(self, amount: float = 8.0) -> None:
        self.speed = min(120.0, self.speed + amount)

    def brake(self, amount: float = 12.0) -> None:
        self.speed = max(0.0, self.speed - amount)

    def turn_left(self, degrees: float = 10.0) -> None:
        self.angle = (self.angle - degrees) % 360.0

    def turn_right(self, degrees: float = 10.0) -> None:
        self.angle = (self.angle + degrees) % 360.0

    def update(self, factor: float = 0.00001) -> None:
        radians = math.radians(self.angle)
        self.latitude += math.cos(radians) * self.speed * factor
        self.longitude += math.sin(radians) * self.speed * factor
        self.speed *= 0.95
        if self.speed < 0.05:
            self.speed = 0.0
        self.speed = max(0.0, min(120.0, self.speed))

    def noisy_position(self, sigma: float = 0.000002) -> tuple[float, float]:
        return (
            self.latitude + random.uniform(-sigma, sigma),
            self.longitude + random.uniform(-sigma, sigma),
        )
