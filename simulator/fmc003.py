from __future__ import annotations

from dataclasses import dataclass
import time

from car import Car


@dataclass
class FMC003:
    imei: str
    car: Car
    battery_mv: int = 12000
    fuel_level_pct: float = 75.0
    odometer_km: float = 0.0
    gsm_signal: int = 4
    altitude_m: int = 120
    satellites: int = 11
    priority: int = 0
    moving_interval_s: float = 1.0
    idle_interval_s: float = 5.0
    ignition_off_interval_s: float = 10.0

    def __post_init__(self) -> None:
        self._last_ignition = self.car.ignition
        self._last_movement = self.car.speed > 1.0
        self._last_speed_bucket = int(self.car.speed // 5)

    def tx_interval(self) -> float:
        if not self.car.ignition:
            return self.ignition_off_interval_s
        if self.car.speed > 1.0:
            return self.moving_interval_s
        return self.idle_interval_s

    def _event_io_id(self, movement: bool, speed_int: int) -> int:
        speed_bucket = speed_int // 5
        if self.car.ignition != self._last_ignition:
            event_id = 239
        elif movement != self._last_movement:
            event_id = 240
        elif speed_bucket != self._last_speed_bucket:
            event_id = 24
        else:
            event_id = 0

        self._last_ignition = self.car.ignition
        self._last_movement = movement
        self._last_speed_bucket = speed_bucket
        return event_id

    def _update_runtime_state(self, dt_seconds: float) -> None:
        dt_seconds = max(0.0, dt_seconds)
        self.odometer_km += max(0.0, self.car.speed) * (dt_seconds / 3600.0)

        if self.car.ignition:
            burn = (0.0006 + (self.car.speed / 120.0) * 0.0014) * dt_seconds
            self.fuel_level_pct = max(0.0, self.fuel_level_pct - burn)
            self.battery_mv = min(12600, self.battery_mv + 1)
        else:
            self.battery_mv = max(11600, self.battery_mv - 1)

        self.satellites = 10 if self.car.speed > 1.0 else 7
        self.gsm_signal = 4 if self.car.speed > 1.0 else 5

    def build_io_elements(self) -> dict[int, int]:
        speed_int = int(round(self.car.speed))
        movement = 1 if self.car.speed > 1.0 else 0
        rpm = int(650 + (self.car.speed / 120.0) * 2600) if self.car.ignition else 0
        fuel_permille = int(round(self.fuel_level_pct * 10.0))
        odometer_m = int(self.odometer_km * 1000.0)

        io_values = {
            239: 1 if self.car.ignition else 0,
            240: movement,
            24: speed_int,
            66: self.battery_mv,
            21: self.gsm_signal,
            16: odometer_m,
            13: fuel_permille,
            12: rpm,
        }
        return io_values

    def build_record(
        self,
        add_gps_noise: bool = True,
        gps_noise_sigma: float = 0.000002,
        dt_seconds: float = 1.0,
    ) -> dict:
        self._update_runtime_state(dt_seconds)

        speed_int = max(0, min(120, int(round(self.car.speed))))
        movement = self.car.speed > 1.0
        event_io_id = self._event_io_id(movement=movement, speed_int=speed_int)

        io_sizes = {
            239: 1,
            240: 1,
            24: 2,
            66: 2,
            21: 1,
            16: 4,
            13: 2,
            12: 2,
        }

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
            "speed": speed_int,
            "event_io_id": event_io_id,
            "io_elements": self.build_io_elements(),
            "io_sizes": io_sizes,
        }
