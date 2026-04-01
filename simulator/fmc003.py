from __future__ import annotations

from dataclasses import dataclass
import math
import random
import time
from typing import Any
import zlib

from car import Car
from profile import DEFAULT_PROFILE


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    earth_radius_m = 6371000.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2.0) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * (math.sin(d_lon / 2.0) ** 2)
    )
    return 2.0 * earth_radius_m * math.asin(min(1.0, math.sqrt(a)))


def _point_in_polygon_xy(x: float, y: float, polygon: list[tuple[float, float]]) -> bool:
    if len(polygon) < 3:
        return False
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        intersects = ((yi > y) != (yj > y)) and (
            x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def _distance_point_to_segment_xy(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    abx = bx - ax
    aby = by - ay
    apx = px - ax
    apy = py - ay
    denom = abx * abx + aby * aby
    if denom <= 1e-9:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, (apx * abx + apy * aby) / denom))
    cx = ax + abx * t
    cy = ay + aby * t
    return math.hypot(px - cx, py - cy)


def _distance_to_polygon_xy(px: float, py: float, polygon: list[tuple[float, float]]) -> float:
    if not polygon:
        return 0.0
    best = float("inf")
    for i in range(len(polygon)):
        ax, ay = polygon[i]
        bx, by = polygon[(i + 1) % len(polygon)]
        best = min(best, _distance_point_to_segment_xy(px, py, ax, ay, bx, by))
    return 0.0 if best == float("inf") else best


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
    engine_temp_c: float = 72.0
    last_event_io_id: int = 0
    last_event_reason: str = "default"
    event_counter: int = 0
    idle_seconds: float = 0.0
    active_geofence: str = ""
    nearest_geofence: str = ""
    nearest_geofence_distance_m: float = 0.0
    geofence_inside: bool = False
    geofence_inside_polygon: bool = False
    geofence_inside_circle: bool = False
    geofence_distance_polygon_m: float = 0.0
    geofence_distance_circle_m: float = 0.0
    geofence_radius_m: float = 0.0
    geofence_zone_match: bool = False
    geofence_city_match: bool = False
    last_accel_kmh_s: float = 0.0
    dtc_value: int = 0
    dtc_count: int = 0
    mil_on: bool = False
    pending_dtc_value: int = 0
    pending_dtc_seconds: float = 0.0
    healthy_run_seconds: float = 0.0
    distance_since_codes_cleared_km: float = 0.0
    time_since_codes_cleared_s: float = 0.0
    distance_since_mil_on_km: float = 0.0
    time_since_mil_on_s: float = 0.0
    runtime_since_engine_start_s: float = 0.0
    vin: str = ""
    last_metrics: dict[str, Any] | None = None
    external_metric_overrides: dict[str, float] | None = None
    device_temp_c: float = 28.0
    uptime_s: float = 0.0
    network_reconnects: int = 0
    queue_depth: int = 0
    queue_drops: int = 0
    max_queue_records: int = 2048
    flush_burst: int = 6
    last_rtt_ms: int = 65
    gnss_hdop: float = 0.9
    gnss_pdop: float = 1.5
    gnss_fix: int = 3
    gnss_jamming: int = 0
    gnss_spoofing: int = 0
    cell_id: int = 1001
    lac: int = 3101
    tac: int = 7201
    rsrp_dbm: int = -94
    rsrq_db: float = -11.0
    sinr_db: float = 11.0
    rssi_dbm: int = -79
    device_mode: str = "active"
    world_x: float | None = None
    world_y: float | None = None
    zone_name: str = ""
    city_name: str = ""

    def __post_init__(self) -> None:
        if self.profile is None:
            self.profile = DEFAULT_PROFILE
        if not self.vin:
            imei_tail = "".join(ch for ch in self.imei if ch.isdigit())[-8:].rjust(8, "0")
            self.vin = f"FMC003SIM{imei_tail}"
        self._last_ignition = self.car.ignition
        self._last_movement = self.car.speed > 1.0
        self._last_speed_bucket = int(self.car.speed // self._speed_bucket_size())
        self._last_speed = self.car.speed
        self._last_overspeed = False
        self._idling_alerted = False
        self._geofence_state: dict[str, bool] = {}
        self._geofence_pending_target: dict[str, bool] = {}
        self._geofence_pending_since: dict[str, float] = {}
        self._rng = random.Random(zlib.crc32(self.imei.encode("utf-8")) & 0xFFFFFFFF)
        self._gnss_dropout_until = 0.0
        self._next_network_reconnect_at = time.time() + self._rng.uniform(140.0, 360.0)

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

    def _event_io_id(self, movement: bool, speed_int: int, dt_seconds: float) -> int:
        events = self.profile.get("events", {}) if self.profile else {}
        speed_bucket = speed_int // self._speed_bucket_size()
        acceleration_kmh_s = 0.0
        if dt_seconds > 0:
            acceleration_kmh_s = (self.car.speed - self._last_speed) / dt_seconds
        self.last_accel_kmh_s = acceleration_kmh_s

        if self.car.ignition != self._last_ignition:
            event_id = int(events.get("ignition_change", 239))
            reason = "ignition_change"
        elif movement != self._last_movement:
            event_id = int(events.get("movement_change", 240))
            reason = "movement_change"
        elif speed_bucket != self._last_speed_bucket:
            event_id = int(events.get("speed_bucket_change", 24))
            reason = "speed_bucket_change"
        else:
            event_id = int(events.get("default", 0))
            reason = "default"

        geofence_event = self._geofence_event()
        if geofence_event is not None:
            event_id, reason = geofence_event

        overspeed_threshold = float(events.get("overspeed_threshold_kmh", 0.0) or 0.0)
        if overspeed_threshold > 0:
            overspeed_now = self.car.speed >= overspeed_threshold
            if overspeed_now and not self._last_overspeed:
                event_id = int(events.get("overspeed_enter", 250))
                reason = "overspeed_enter"
            elif (not overspeed_now) and self._last_overspeed:
                event_id = int(events.get("overspeed_exit", 251))
                reason = "overspeed_exit"
            self._last_overspeed = overspeed_now

        harsh_accel_threshold = float(events.get("harsh_accel_threshold_kmh_s", 0.0) or 0.0)
        harsh_brake_threshold = float(events.get("harsh_brake_threshold_kmh_s", 0.0) or 0.0)
        if harsh_accel_threshold > 0 and acceleration_kmh_s >= harsh_accel_threshold:
            event_id = int(events.get("harsh_accel", 253))
            reason = "harsh_accel"
        if harsh_brake_threshold > 0 and (-acceleration_kmh_s) >= harsh_brake_threshold:
            event_id = int(events.get("harsh_brake", 254))
            reason = "harsh_brake"

        if self.car.ignition and self.car.speed < 1.0:
            self.idle_seconds += max(0.0, dt_seconds)
        else:
            self.idle_seconds = 0.0
            self._idling_alerted = False

        idling_threshold = float(events.get("idling_seconds_threshold", 0.0) or 0.0)
        if idling_threshold > 0 and self.idle_seconds >= idling_threshold and not self._idling_alerted:
            event_id = int(events.get("idling_threshold", 255))
            reason = "idling_threshold"
            self._idling_alerted = True

        self._last_ignition = self.car.ignition
        self._last_movement = movement
        self._last_speed_bucket = speed_bucket
        self._last_speed = self.car.speed
        self.last_event_io_id = event_id
        self.last_event_reason = reason
        self.event_counter += 1
        return event_id

    def _geofence_event(self) -> tuple[int, str] | None:
        events = self.profile.get("events", {}) if self.profile else {}
        geofences = events.get("geofences", [])
        dwell_s = max(0.0, float(events.get("geofence_dwell_s", 0.0) or 0.0))
        exit_margin_m = max(0.0, float(events.get("geofence_exit_margin_m", 0.0) or 0.0))
        if not isinstance(geofences, list):
            self.nearest_geofence = ""
            self.nearest_geofence_distance_m = 0.0
            self.geofence_inside = False
            self.geofence_inside_polygon = False
            self.geofence_inside_circle = False
            self.geofence_distance_polygon_m = 0.0
            self.geofence_distance_circle_m = 0.0
            self.geofence_radius_m = 0.0
            return None

        nearest_name = ""
        nearest_distance = float("inf")
        inside_any = False
        transition: tuple[int, str] | None = None
        nearest_debug = {
            "inside_polygon": False,
            "inside_circle": False,
            "distance_polygon": float("inf"),
            "distance_circle": float("inf"),
            "radius_m": 0.0,
            "zone_match": False,
            "city_match": False,
        }

        for idx, geofence in enumerate(geofences):
            if not isinstance(geofence, dict):
                continue

            zone_name = str(geofence.get("name", f"zone_{idx + 1}"))
            zone_distance = float("inf")
            prev_inside = self._geofence_state.get(zone_name, False)

            # Optional native MTA location rules, matching what players see in map/Discord status.
            zone_names = geofence.get("zone_names", [])
            city_names = geofence.get("city_names", [])
            zone_match = False
            city_match = False
            if isinstance(zone_names, list) and self.zone_name:
                zone_match = any(str(v).strip().lower() == self.zone_name.strip().lower() for v in zone_names)
            if isinstance(city_names, list) and self.city_name:
                city_match = any(str(v).strip().lower() == self.city_name.strip().lower() for v in city_names)
            location_match = zone_match or city_match
            has_location_rules = (isinstance(zone_names, list) and len(zone_names) > 0) or (
                isinstance(city_names, list) and len(city_names) > 0
            )
            has_live_location = bool(self.zone_name or self.city_name)
            location_rule_applicable = has_location_rules and has_live_location

            # Prefer robustness: if both polygon (world XY) and circle (lat/lon) are present,
            # evaluate both and treat inside as either match.
            raw_inside_polygon = False
            distance_polygon = float("inf")
            radius_m_this = 0.0
            points_xy_raw = geofence.get("points_xy")
            if isinstance(points_xy_raw, list) and len(points_xy_raw) >= 3 and self.world_x is not None and self.world_y is not None:
                polygon: list[tuple[float, float]] = []
                for point in points_xy_raw:
                    if not isinstance(point, (list, tuple)) or len(point) < 2:
                        continue
                    try:
                        polygon.append((float(point[0]), float(point[1])))
                    except (TypeError, ValueError):
                        continue
                if len(polygon) >= 3:
                    raw_inside_polygon = _point_in_polygon_xy(self.world_x, self.world_y, polygon)
                    distance_polygon = _distance_to_polygon_xy(self.world_x, self.world_y, polygon)

            raw_inside_circle = False
            distance_circle = float("inf")
            try:
                lat = float(geofence["latitude"])
                lon = float(geofence["longitude"])
                radius_m_this = float(geofence["radius_m"])
                distance_circle = _haversine_m(self.car.latitude, self.car.longitude, lat, lon)
                raw_inside_circle = distance_circle <= max(1.0, radius_m_this)
            except (KeyError, TypeError, ValueError):
                pass

            # Hysteresis: once inside, stay inside until clearly out by exit margin.
            inside_polygon = raw_inside_polygon
            if prev_inside and not raw_inside_polygon and distance_polygon != float("inf"):
                inside_polygon = distance_polygon <= exit_margin_m

            inside_circle = raw_inside_circle
            if prev_inside and not raw_inside_circle and distance_circle != float("inf") and radius_m_this > 0:
                inside_circle = distance_circle <= (radius_m_this + exit_margin_m)

            if location_rule_applicable:
                # When MTA location names are available, trust map-native zone/city matching
                # to avoid false positives from synthetic lat/lon projection drift.
                candidate_inside = location_match
            else:
                candidate_inside = inside_polygon or inside_circle or location_match
            zone_distance = min(distance_polygon, distance_circle)
            if zone_distance == float("inf"):
                # Zone/city-only fences may have no geometric distance.
                if location_match:
                    zone_distance = 0.0
                else:
                    continue

            if zone_distance < nearest_distance:
                nearest_distance = zone_distance
                nearest_name = zone_name
                nearest_debug = {
                    "inside_polygon": inside_polygon,
                    "inside_circle": inside_circle,
                    "distance_polygon": distance_polygon,
                    "distance_circle": distance_circle,
                    "radius_m": radius_m_this,
                    "zone_match": zone_match,
                    "city_match": city_match,
                }

            stable_inside = prev_inside
            if candidate_inside != prev_inside:
                pending_target = self._geofence_pending_target.get(zone_name)
                pending_since = self._geofence_pending_since.get(zone_name)
                now = time.time()
                if pending_target != candidate_inside or pending_since is None:
                    self._geofence_pending_target[zone_name] = candidate_inside
                    self._geofence_pending_since[zone_name] = now
                elif (now - pending_since) >= dwell_s:
                    stable_inside = candidate_inside
                    self._geofence_state[zone_name] = stable_inside
                    self._geofence_pending_target.pop(zone_name, None)
                    self._geofence_pending_since.pop(zone_name, None)
            else:
                self._geofence_state[zone_name] = prev_inside
                self._geofence_pending_target.pop(zone_name, None)
                self._geofence_pending_since.pop(zone_name, None)

            if zone_name not in self._geofence_state:
                self._geofence_state[zone_name] = stable_inside

            inside = self._geofence_state.get(zone_name, stable_inside)
            inside_any = inside_any or inside

            if inside:
                self.active_geofence = zone_name
            elif self.active_geofence == zone_name:
                self.active_geofence = ""

            if inside and not prev_inside:
                transition = int(events.get("geofence_enter", 248)), f"geofence_enter:{zone_name}"
            elif (not inside) and prev_inside:
                transition = int(events.get("geofence_exit", 249)), f"geofence_exit:{zone_name}"

        self.nearest_geofence = nearest_name
        self.nearest_geofence_distance_m = 0.0 if nearest_distance == float("inf") else nearest_distance
        self.geofence_inside = inside_any
        self.geofence_inside_polygon = bool(nearest_debug["inside_polygon"])
        self.geofence_inside_circle = bool(nearest_debug["inside_circle"])
        self.geofence_distance_polygon_m = 0.0 if nearest_debug["distance_polygon"] == float("inf") else float(nearest_debug["distance_polygon"])
        self.geofence_distance_circle_m = 0.0 if nearest_debug["distance_circle"] == float("inf") else float(nearest_debug["distance_circle"])
        self.geofence_radius_m = float(nearest_debug["radius_m"])
        self.geofence_zone_match = bool(nearest_debug["zone_match"])
        self.geofence_city_match = bool(nearest_debug["city_match"])

        return transition

    def set_world_position(self, world_x: float | None, world_y: float | None) -> None:
        self.world_x = world_x
        self.world_y = world_y

    def set_location_names(self, zone_name: str | None, city_name: str | None) -> None:
        self.zone_name = str(zone_name or "").strip()
        self.city_name = str(city_name or "").strip()

    def _update_runtime_state(self, dt_seconds: float) -> None:
        dt_seconds = max(0.0, dt_seconds)
        now = time.time()
        self.uptime_s += dt_seconds
        traveled_km = max(0.0, self.car.speed) * (dt_seconds / 3600.0)
        self.odometer_km += traveled_km
        self.distance_since_codes_cleared_km += traveled_km
        self.time_since_codes_cleared_s += dt_seconds

        if self.car.ignition:
            burn = (0.0006 + (self.car.speed / 120.0) * 0.0014) * dt_seconds
            self.fuel_level_pct = max(0.0, self.fuel_level_pct - burn)
            self.battery_mv = min(12600, self.battery_mv + 1)
            target_temp = 90.0 + (self.car.speed / 120.0) * 8.0
            self.engine_temp_c = min(target_temp, self.engine_temp_c + dt_seconds * 1.2)
            self.runtime_since_engine_start_s += dt_seconds
        else:
            self.battery_mv = max(11600, self.battery_mv - 1)
            self.engine_temp_c = max(30.0, self.engine_temp_c - dt_seconds * 0.6)
            self.runtime_since_engine_start_s = 0.0

        self.satellites = 10 if self.car.speed > 1.0 else 7
        self.gsm_signal = 4 if self.car.speed > 1.0 else 5

        self._simulate_gnss_quality(now)
        self._simulate_network_diagnostics(now)
        self._update_device_mode()

        ambient_air_temp = max(5.0, min(45.0, 24.0 + math.sin(now / 1800.0) * 4.0))
        target_device_temp = ambient_air_temp + (6.0 if self.car.ignition else 2.0)
        if self.queue_depth > 0:
            target_device_temp += 1.5
        self.device_temp_c += (target_device_temp - self.device_temp_c) * min(1.0, dt_seconds * 0.15)

        # Simulated MIL/DTC logic with pending/confirm/clear lifecycle.
        overheat = self.engine_temp_c >= 108.0
        low_fuel = self.fuel_level_pct <= 5.0
        sustained_harsh = abs(self.last_accel_kmh_s) >= 14.0 and self.car.speed > 30.0
        dtc_candidate = 0
        if overheat:
            dtc_candidate = 0x0215
        elif low_fuel:
            dtc_candidate = 0x0087
        elif sustained_harsh:
            dtc_candidate = 0x0300

        events = self.profile.get("events", {}) if self.profile else {}
        confirm_seconds = max(1.0, float(events.get("dtc_confirm_seconds", 8.0) or 8.0))
        clear_seconds = max(1.0, float(events.get("dtc_clear_seconds", 45.0) or 45.0))

        if dtc_candidate != 0:
            self.healthy_run_seconds = 0.0
            if self.pending_dtc_value == dtc_candidate:
                self.pending_dtc_seconds += dt_seconds
            else:
                self.pending_dtc_value = dtc_candidate
                self.pending_dtc_seconds = dt_seconds

            if self.pending_dtc_seconds >= confirm_seconds:
                self.dtc_value = dtc_candidate
        else:
            self.pending_dtc_value = 0
            self.pending_dtc_seconds = 0.0
            if self.dtc_value != 0:
                self.healthy_run_seconds += dt_seconds
                if self.healthy_run_seconds >= clear_seconds:
                    self.dtc_value = 0
                    self.healthy_run_seconds = 0.0
            else:
                self.healthy_run_seconds = 0.0

        self.mil_on = self.dtc_value != 0
        self.dtc_count = 1 if self.mil_on else 0
        if self.mil_on:
            self.distance_since_mil_on_km += traveled_km
            self.time_since_mil_on_s += dt_seconds
        else:
            self.distance_since_mil_on_km = 0.0
            self.time_since_mil_on_s = 0.0

    def _simulate_gnss_quality(self, now: float) -> None:
        if now >= self._gnss_dropout_until and self._rng.random() < 0.0012:
            self._gnss_dropout_until = now + self._rng.uniform(5.0, 20.0)

        in_dropout = now < self._gnss_dropout_until
        if in_dropout:
            self.gnss_fix = 1
            self.satellites = max(0, min(self.satellites, 3))
            self.gnss_hdop = min(9.9, self.gnss_hdop + self._rng.uniform(0.2, 0.8))
            self.gnss_pdop = min(15.0, self.gnss_pdop + self._rng.uniform(0.4, 1.4))
            self.gnss_jamming = 1 if self._rng.random() < 0.22 else 0
            self.gnss_spoofing = 1 if self._rng.random() < 0.03 else 0
            return

        self.gnss_fix = 3 if self.car.speed >= 1.0 else 2
        base_sat = 11 if self.car.speed > 5.0 else 8
        self.satellites = max(5, min(15, int(round(base_sat + self._rng.uniform(-1.5, 1.5)))))
        self.gnss_hdop = max(0.6, min(2.8, 0.85 + (12 - self.satellites) * 0.13 + self._rng.uniform(-0.15, 0.15)))
        self.gnss_pdop = max(1.0, min(4.8, self.gnss_hdop + 0.7 + self._rng.uniform(-0.2, 0.3)))
        self.gnss_jamming = 1 if self._rng.random() < 0.002 else 0
        self.gnss_spoofing = 1 if self._rng.random() < 0.0008 else 0

    def _simulate_network_diagnostics(self, now: float) -> None:
        if now >= self._next_network_reconnect_at:
            self.network_reconnects += 1
            self._next_network_reconnect_at = now + self._rng.uniform(140.0, 380.0)
            self.last_rtt_ms = int(self._rng.uniform(180, 420))
        else:
            wave = math.sin(now / 23.0) * 6.0 + math.sin(now / 7.0) * 3.0
            self.rsrp_dbm = int(max(-122, min(-72, -94 + wave + self._rng.uniform(-2.0, 2.0))))
            self.rsrq_db = max(-19.5, min(-6.0, -11.0 + wave * 0.18 + self._rng.uniform(-0.7, 0.7)))
            self.sinr_db = max(-4.0, min(28.0, 11.0 + wave * 0.45 + self._rng.uniform(-1.2, 1.2)))
            self.rssi_dbm = int(max(-110, min(-61, self.rsrp_dbm + 14 + self._rng.uniform(-2.0, 2.0))))
            self.last_rtt_ms = int(max(28, min(220, 62 + abs(wave) * 3.5 + self._rng.uniform(-8.0, 10.0))))

        self.gsm_signal = max(1, min(5, int(round((self.rsrp_dbm + 122) / 10.0))))

    def _update_device_mode(self) -> None:
        if not self.car.ignition:
            self.device_mode = "sleep" if self.idle_seconds < 60 else "deep_sleep"
            return
        if self.car.speed > 1.0:
            self.device_mode = "active"
        else:
            self.device_mode = "idle"

    def note_record_generated(self) -> None:
        if self.queue_depth < self.max_queue_records:
            self.queue_depth += 1
            return
        self.queue_drops += 1

    def note_uplink_result(self, success: bool) -> None:
        if success:
            if self.queue_depth > 0:
                self.queue_depth = max(0, self.queue_depth - 1)
            return
        self.network_reconnects += 1

    def _build_metrics(self) -> dict[str, Any]:
        speed_int = int(round(self.car.speed))
        rpm = int(780 + (self.car.speed / 120.0) * 2800) if self.car.ignition else 0
        throttle_pct = max(0, min(100, int(round((self.car.speed / 120.0) * 100))))
        odometer_m = int(self.odometer_km * 1000.0)
        barometric_kpa = max(80.0, min(110.0, 101.3 - (self.altitude_m / 12000.0) * 12.0))
        intake_map_kpa = max(20.0, min(barometric_kpa, 25.0 + throttle_pct * 0.7))
        maf_gps = max(0.0, min(220.0, (rpm / 50.0) * (throttle_pct / 100.0) * 0.85))
        engine_load_pct = max(0.0, min(100.0, throttle_pct * 0.9 + (rpm / 7000.0) * 18.0))
        abs_load_pct = max(engine_load_pct, min(100.0, engine_load_pct * 1.1))
        coolant_temp_c = self.engine_temp_c
        intake_air_temp_c = max(15.0, min(70.0, 22.0 + throttle_pct * 0.12))
        ambient_air_temp_c = max(5.0, min(45.0, 24.0 + math.sin(time.time() / 1800.0) * 4.0))
        timing_advance_deg = max(-10.0, min(40.0, 6.0 + (rpm / 1000.0) * 2.2))
        fuel_pressure_kpa = max(220.0, min(500.0, 250.0 + throttle_pct * 2.1))
        fuel_rail_pressure_rel_kpa = max(3000.0, min(18000.0, 3500.0 + throttle_pct * 90.0))
        fuel_rail_pressure_direct_kpa = max(3500.0, min(21000.0, fuel_rail_pressure_rel_kpa + 2000.0))
        abs_fuel_rail_pressure_kpa = fuel_rail_pressure_direct_kpa
        commanded_egr_pct = max(0.0, min(60.0, 8.0 + speed_int * 0.25)) if self.car.ignition else 0.0
        egr_error_pct = max(0.0, min(20.0, abs(self.last_accel_kmh_s) * 1.4))
        stft_b1_pct = max(-25.0, min(25.0, (throttle_pct - 45.0) * 0.22))
        ltft_b1_pct = max(-20.0, min(20.0, stft_b1_pct * 0.4))
        control_module_voltage_v = self.battery_mv / 1000.0
        engine_oil_temp_c = max(30.0, min(140.0, self.engine_temp_c + 6.0))
        fuel_injector_timing_deg = max(0.0, min(50.0, 5.0 + throttle_pct * 0.32))
        fuel_rate_lph = max(0.0, min(40.0, 0.7 + throttle_pct * 0.12)) if self.car.ignition else 0.0
        hybrid_battery_remaining_pct = 0.0
        mode_code_map = {
            "active": 1,
            "idle": 2,
            "sleep": 3,
            "deep_sleep": 4,
        }

        metrics: dict[str, Any] = {
            "ignition": 1 if self.car.ignition else 0,
            "movement": 1 if self.car.speed > 1.0 else 0,
            "speed_kmh": speed_int,
            "vehicle_speed": speed_int,
            "battery_mv": self.battery_mv,
            "gsm_signal": self.gsm_signal,
            "odometer_m": odometer_m,
            "mileage_km": self.odometer_km,
            "fuel_pct": self.fuel_level_pct,
            "fuel_level": self.fuel_level_pct,
            "rpm": rpm,
            "engine_rpm": rpm,
            "engine_temp_c": self.engine_temp_c,
            "coolant_temp_c": coolant_temp_c,
            "throttle_pct": throttle_pct,
            "idle_seconds": self.idle_seconds,
            "overspeed": 1 if self._last_overspeed else 0,
            "accel_kmh_s": self.last_accel_kmh_s,
            "event_counter": self.event_counter,
            "dtc_count": self.dtc_count,
            "dtc_value": self.dtc_value,
            "mil_on": 1 if self.mil_on else 0,
            "engine_load_pct": engine_load_pct,
            "abs_load_pct": abs_load_pct,
            "stft_b1_pct": stft_b1_pct,
            "ltft_b1_pct": ltft_b1_pct,
            "fuel_pressure_kpa": fuel_pressure_kpa,
            "intake_map_kpa": intake_map_kpa,
            "timing_advance_deg": timing_advance_deg,
            "intake_air_temp_c": intake_air_temp_c,
            "ambient_air_temp_c": ambient_air_temp_c,
            "maf_gps": maf_gps,
            "runtime_since_engine_start_s": self.runtime_since_engine_start_s,
            "fuel_rail_pressure_rel_kpa": fuel_rail_pressure_rel_kpa,
            "fuel_rail_pressure_direct_kpa": fuel_rail_pressure_direct_kpa,
            "abs_fuel_rail_pressure_kpa": abs_fuel_rail_pressure_kpa,
            "commanded_egr_pct": commanded_egr_pct,
            "egr_error_pct": egr_error_pct,
            "distance_since_codes_cleared_km": self.distance_since_codes_cleared_km,
            "time_since_codes_cleared_s": self.time_since_codes_cleared_s,
            "distance_since_mil_on_km": self.distance_since_mil_on_km,
            "time_since_mil_on_s": self.time_since_mil_on_s,
            "barometric_pressure_kpa": barometric_kpa,
            "control_module_voltage_v": control_module_voltage_v,
            "hybrid_battery_remaining_pct": hybrid_battery_remaining_pct,
            "engine_oil_temp_c": engine_oil_temp_c,
            "fuel_injector_timing_deg": fuel_injector_timing_deg,
            "fuel_rate_lph": fuel_rate_lph,
            "vin_hash": zlib.crc32(self.vin.encode("utf-8")) & 0x7FFFFFFF,
            "gnss_hdop": self.gnss_hdop,
            "gnss_pdop": self.gnss_pdop,
            "gnss_fix": self.gnss_fix,
            "gnss_jamming": self.gnss_jamming,
            "gnss_spoofing": self.gnss_spoofing,
            "network_rsrp_dbm": self.rsrp_dbm,
            "network_rsrq_db": self.rsrq_db,
            "network_sinr_db": self.sinr_db,
            "network_rssi_dbm": self.rssi_dbm,
            "network_cell_id": self.cell_id,
            "network_lac": self.lac,
            "network_tac": self.tac,
            "network_reconnects": self.network_reconnects,
            "network_rtt_ms": self.last_rtt_ms,
            "device_temp_c": self.device_temp_c,
            "device_uptime_s": self.uptime_s,
            "queue_depth": self.queue_depth,
            "queue_drops": self.queue_drops,
            "device_mode_code": mode_code_map.get(self.device_mode, 0),
        }

        if self.external_metric_overrides:
            for key, value in self.external_metric_overrides.items():
                metrics[key] = value

        self.last_metrics = metrics
        return metrics

    def set_external_metrics(self, values: dict[str, Any] | None) -> None:
        if not isinstance(values, dict):
            self.external_metric_overrides = None
            return

        normalized: dict[str, float] = {}
        for key, value in values.items():
            try:
                normalized[str(key)] = float(value)
            except (TypeError, ValueError):
                continue

        self.external_metric_overrides = normalized if normalized else None

    def build_io_elements(self) -> dict[int, int]:
        metrics = self._build_metrics()

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
        self.note_record_generated()
        self._update_runtime_state(dt_seconds)

        speed_int = max(0, min(120, int(round(self.car.speed))))
        movement = self.car.speed > 1.0
        event_io_id = self._event_io_id(movement=movement, speed_int=speed_int, dt_seconds=dt_seconds)

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
