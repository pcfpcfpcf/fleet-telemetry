from __future__ import annotations

from dataclasses import dataclass
import time

from car import Car


@dataclass
class FMC003:
    imei: str
    car: Car
    battery_mv: int = 12000
    altitude_m: int = 120
    satellites: int = 11
    priority: int = 0

    def build_io_elements(self) -> dict[int, int]:
        speed_int = int(round(self.car.speed))
        movement = 1 if self.car.speed > 1.0 else 0
        return {
            239: 1 if self.car.ignition else 0,
            240: movement,
            24: speed_int,
            66: self.battery_mv,
        }

    def build_record(self, add_gps_noise: bool = True, gps_noise_sigma: float = 0.000002) -> dict:
        if add_gps_noise:
            latitude, longitude = self.car.noisy_position(gps_noise_sigma)
        else:
            latitude, longitude = self.car.latitude, self.car.longitude

        return {
            "timestamp_ms": int(time.time() * 1000),
            "priority": self.priority,
            "longitude": longitude,
            "latitude": latitude,
            "altitude": max(0, int(self.altitude_m)),
            "angle": int(round(self.car.angle)) % 360,
            "satellites": max(0, min(255, int(self.satellites))),
            "speed": max(0, min(120, int(round(self.car.speed)))),
            "event_io_id": 239,
            "io_elements": self.build_io_elements(),
        }
