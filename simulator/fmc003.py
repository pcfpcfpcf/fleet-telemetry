from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Any

from car import Car
from profile import DEFAULT_PROFILE


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
    profile: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        if self.profile is None:
            self.profile = DEFAULT_PROFILE
        self._last_ignition = self.car.ignition
        self._last_movement = self.car.speed > 1.0
        self._last_speed_bucket = int(self.car.speed // self._speed_bucket_size())

    def _speed_bucket_size(self) -> int:
        if self.profile is None:
            return 5
        events = self.profile.get("events", {})
        try:
            return max(1, int(events.get("speed_bucket_size", 5)))
        except (TypeError, ValueError):
            return 5

    def tx_interval(self) -> float:
        if not self.car.ignition:
            return self.ignition_off_interval_s
        if self.car.speed > 1.0:
            return self.moving_interval_s
        return self.idle_interval_s

    def _event_io_id(self, movement: bool, speed_int: int) -> int:
        events = self.profile.get("events", {}) if self.profile else {}
        speed_bucket = speed_int // self._speed_bucket_size()
        if self.car.ignition != self._last_ignition:
            event_id = int(events.get("ignition_change", 239))
        elif movement != self._last_movement:
            event_id = int(events.get("movement_change", 240))
        elif speed_bucket != self._last_speed_bucket:
            event_id = int(events.get("speed_bucket_change", 24))
        else:
            event_id = int(events.get("default", 0))

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
        odometer_m = int(self.odometer_km * 1000.0)
        metrics = {
            "ignition": 1 if self.car.ignition else 0,
            "movement": movement,
            "speed_kmh": speed_int,
            "battery_mv": self.battery_mv,
            "gsm_signal": self.gsm_signal,
            "odometer_m": odometer_m,
            "fuel_pct": self.fuel_level_pct,
            "rpm": rpm,
        }

        io_values: dict[int, int] = {}
        io_config = self.profile.get("io", {}) if self.profile else {}
        for io_id_str, conf in io_config.items():
            io_id = int(io_id_str)
            source = conf.get("source")
            if source not in metrics:
                continue

            raw = float(metrics[source])
            scale = float(conf.get("scale", 1.0))
            offset = float(conf.get("offset", 0.0))
            value = int(round(raw * scale + offset))

            min_value = conf.get("min")
            max_value = conf.get("max")
            if min_value is not None:
                value = max(int(min_value), value)
            if max_value is not None:
                value = min(int(max_value), value)

            io_values[io_id] = value

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
            int(io_id): int(conf.get("size", 1))
            for io_id, conf in self.profile.get("io", {}).items()
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
