from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import sys
import threading
import time
import random
from typing import Any
import zlib

from car import Car
from encoder import build_codec8_packet
from fmc003 import FMC003
from network import TeltonikaTCPClient


# Debug file for logging (since stdout/stderr might be suppressed by HTTPServer)
_debug_file = None

def debug_log(msg: str) -> None:
    global _debug_file
    if _debug_file is None:
        return
    try:
        _debug_file.write(f"{msg}\n")
        _debug_file.flush()
    except Exception:
        pass


# Error history for debugging (accessible via /status endpoint)
_error_history: list[str] = []

def log_error(msg: str) -> None:
    global _error_history
    _error_history.append(msg)
    # Keep only last 100 errors
    if len(_error_history) > 100:
        _error_history.pop(0)


@dataclass
class DeviceSession:
    player_id: str
    imei: str
    car: Car
    fmc: FMC003
    client: TeltonikaTCPClient
    last_update: float
    connected: bool = False


class BridgeState:
    def __init__(self, target_host: str, target_port: int, imei_base: int) -> None:
        self.target_host = target_host
        self.target_port = target_port
        self.imei_base = imei_base
        self.sessions: dict[str, DeviceSession] = {}
        self.lock = threading.Lock()
        self.rx_count = 0
        self.ok_count = 0
        self.fail_count = 0
        self.last_player = "-"
        self.started_at = time.time()
        self.last_rx_at = 0.0
        self.instance_id = f"bridge-{os.getpid()}-{int(self.started_at)}"
        # Fallback inverse projection matching client.lua defaults.
        self.origin_lat = 36.8065
        self.origin_lon = 10.1815
        self.world_scale = 0.00001
        self._rng = random.Random(self.imei_base)

    def _imei_for_player(self, player_id: str) -> str:
        suffix = zlib.crc32(player_id.encode("utf-8")) % 100000
        imei_num = self.imei_base + suffix
        return f"{imei_num:015d}"[-15:]

    def get_or_create_session(self, player_id: str, lat: float, lon: float) -> DeviceSession:
        session = self.sessions.get(player_id)
        if session is not None:
            return session

        imei = self._imei_for_player(player_id)
        speed = 25.0 + (zlib.crc32(player_id.encode("utf-8")) % 35)
        car = Car(latitude=lat, longitude=lon, speed=speed, angle=self._rng.uniform(0.0, 360.0), ignition=True)
        fmc = FMC003(imei=imei, car=car)
        client = TeltonikaTCPClient(host=self.target_host, port=self.target_port)
        session = DeviceSession(
            player_id=player_id,
            imei=imei,
            car=car,
            fmc=fmc,
            client=client,
            last_update=time.time(),
            connected=False,
        )
        self.sessions[player_id] = session
        return session

    def ingest(self, payload: Any, debug: bool = False) -> tuple[int, str]:
        # Handle case where payload is a list (MTA serialization quirk)
        if isinstance(payload, list):
            if len(payload) == 0:
                return 400, "empty payload array"
            if isinstance(payload[0], dict):
                payload = payload[0]
            else:
                return 400, f"unexpected payload list: {type(payload[0])}"
        
        if not isinstance(payload, dict):
            return 400, f"payload must be dict or list, got {type(payload).__name__}"

        player_id = str(payload.get("playerId", "")).strip()
        if not player_id:
            return 400, "playerId is required"

        try:
            lat = float(payload["latitude"])
            lon = float(payload["longitude"])
            world_x = float(payload.get("worldX")) if payload.get("worldX") is not None else None
            world_y = float(payload.get("worldY")) if payload.get("worldY") is not None else None
            zone_name = str(payload.get("zoneName", "")).strip()
            city_name = str(payload.get("cityName", "")).strip()
            speed = float(payload.get("speedKmh", 0.0))
            angle = float(payload.get("angleDeg", 0.0))
            ignition = bool(payload.get("ignition", True))
        except (KeyError, TypeError, ValueError) as e:
            return 400, f"invalid telemetry payload: {e}"

        extended_metric_keys = {
            "rpm",
            "engine_rpm",
            "speed_kmh",
            "vehicle_speed",
            "engine_temp_c",
            "coolant_temp_c",
            "engine_oil_temp_c",
            "engine_load_pct",
            "abs_load_pct",
            "throttle_pct",
            "stft_b1_pct",
            "ltft_b1_pct",
            "fuel_pressure_kpa",
            "intake_map_kpa",
            "timing_advance_deg",
            "intake_air_temp_c",
            "maf_gps",
            "runtime_since_engine_start_s",
            "fuel_rail_pressure_rel_kpa",
            "fuel_rail_pressure_direct_kpa",
            "abs_fuel_rail_pressure_kpa",
            "commanded_egr_pct",
            "egr_error_pct",
            "fuel_level",
            "fuel_pct",
            "mileage_km",
            "distance_since_codes_cleared_km",
            "barometric_pressure_kpa",
            "control_module_voltage_v",
            "ambient_air_temp_c",
            "time_since_codes_cleared_s",
            "hybrid_battery_remaining_pct",
            "fuel_injector_timing_deg",
            "fuel_rate_lph",
            "dtc_count",
            "dtc_value",
            "mil_on",
            "distance_since_mil_on_km",
            "time_since_mil_on_s",
            "vin_hash",
            "accel_kmh_s",
        }

        external_metrics: dict[str, Any] = {}
        for key in extended_metric_keys:
            if key in payload:
                external_metrics[key] = payload.get(key)

        now = time.time()

        # Fallback for clients/resources that do not send world coordinates yet.
        if world_x is None:
            world_x = (lon - self.origin_lon) / self.world_scale
        if world_y is None:
            world_y = (lat - self.origin_lat) / self.world_scale

        with self.lock:
            session = self.get_or_create_session(player_id, lat, lon)
            dt = max(0.01, now - session.last_update)
            session.last_update = now

            session.car.latitude = lat
            session.car.longitude = lon
            session.car.speed = max(0.0, min(120.0, speed))
            session.car.angle = angle % 360.0
            session.car.ignition = ignition
            session.fmc.set_world_position(world_x, world_y)
            session.fmc.set_location_names(zone_name, city_name)
            session.fmc.set_external_metrics(external_metrics)

            record = session.fmc.build_record(add_gps_noise=False, dt_seconds=dt)
            packet = build_codec8_packet([record])

            try:
                if not session.connected:
                    if debug:
                        print(f"[bridge] connecting {player_id} ({session.imei}) to {self.target_host}:{self.target_port}...")
                    try:
                        session.client.connect_and_login(session.imei, retries=1)
                        session.connected = True
                        if debug:
                            print(f"[bridge] connected {player_id} ({session.imei})")
                    except Exception as conn_exc:
                        if debug:
                            print(f"[bridge] connection failed for {player_id}: {type(conn_exc).__name__}: {conn_exc}")
                        raise
                
                ack = session.client.send_avl_packet(packet, records_sent=1)
                session.fmc.note_uplink_result(success=True)
                if debug:
                    print(
                        f"[bridge] player={player_id} imei={session.imei} "
                        f"lat={lat:.6f} lon={lon:.6f} speed={speed:.1f} ack={ack}"
                    )
                return 200, "ok"
            except (OSError, TimeoutError, ConnectionError) as exc:
                session.connected = False
                session.client.close()
                session.fmc.note_uplink_result(success=False)
                print(f"[bridge] ERROR send failed for {player_id}: {type(exc).__name__}: {exc}", flush=True)
                return 502, f"upstream send failed: {exc}"


def create_handler(state: BridgeState, debug: bool):
    print(f"[bridge] create_handler called with debug={debug}", flush=True)
    class TelemetryHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.path != "/telemetry":
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"not found")
                return

            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)

            try:
                payload = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError as e:
                debug_log(f"[bridge] JSON decode error: {e}")
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"invalid json")
                return

            player_hint = "unknown"
            if isinstance(payload, dict):
                player_hint = str(payload.get("playerId", "unknown"))
            elif isinstance(payload, list) and payload and isinstance(payload[0], dict):
                player_hint = str(payload[0].get("playerId", "unknown"))
            with state.lock:
                state.rx_count += 1
                state.last_player = player_hint
                state.last_rx_at = time.time()
            print(f"[bridge] RX path={self.path} player={player_hint}", flush=True)

            debug_log(f"[bridge] received payload type={type(payload).__name__}")
            
            try:
                code, message = state.ingest(payload, debug=debug)
            except Exception as exc:
                # Write detailed error info to file version, and also to the response
                err_msg = f"{type(exc).__name__}: {str(exc)}\n"
                with open("bridge_errors.txt", "a") as f:
                    import traceback
                    f.write(f"\n=== Exception at {time.time()} ===\n")
                    f.write(err_msg)
                    traceback.print_exc(file=f)
                    f.write("\n")
                
                log_error(err_msg)
                self.send_response(502)
                self.end_headers()
                # Send the error message so user can see it
                self.wfile.write(err_msg.encode("utf-8"))
                return
            
            self.send_response(code)
            self.end_headers()
            self.wfile.write(message.encode("utf-8"))
            with state.lock:
                if code == 200:
                    state.ok_count += 1
                else:
                    state.fail_count += 1
            print(f"[bridge] response={code} message={message}", flush=True)

        def do_GET(self) -> None:
            if self.path == "/health":
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ok")
                return
            elif self.path == "/status":
                # Status endpoint showing connected sessions and errors
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                with state.lock:
                    status = {
                        "target": f"{state.target_host}:{state.target_port}",
                        "bridge_instance_id": state.instance_id,
                        "bridge_pid": os.getpid(),
                        "uptime_s": int(time.time() - state.started_at),
                        "last_rx_age_s": (None if state.last_rx_at == 0.0 else round(time.time() - state.last_rx_at, 2)),
                        "sessions": len(state.sessions),
                        "recent_errors": _error_history[-10:] if _error_history else [],
                        "players": {}
                    }
                    for player_id, session in state.sessions.items():
                        status["players"][player_id] = {
                            "imei": session.imei,
                            "connected": session.connected,
                            "lat": session.car.latitude,
                            "lon": session.car.longitude,
                            "world_x": session.fmc.world_x,
                            "world_y": session.fmc.world_y,
                            "zone_name": session.fmc.zone_name,
                            "city_name": session.fmc.city_name,
                            "speed": session.car.speed,
                            "angle": session.car.angle,
                            "ignition": session.car.ignition,
                            "last_event_io_id": session.fmc.last_event_io_id,
                            "last_event_reason": session.fmc.last_event_reason,
                            "active_geofence": session.fmc.active_geofence,
                            "geofence_inside": session.fmc.geofence_inside,
                            "nearest_geofence": session.fmc.nearest_geofence,
                            "nearest_geofence_distance_m": session.fmc.nearest_geofence_distance_m,
                            "geofence_inside_polygon": session.fmc.geofence_inside_polygon,
                            "geofence_inside_circle": session.fmc.geofence_inside_circle,
                            "geofence_distance_polygon_m": session.fmc.geofence_distance_polygon_m,
                            "geofence_distance_circle_m": session.fmc.geofence_distance_circle_m,
                            "geofence_radius_m": session.fmc.geofence_radius_m,
                            "geofence_zone_match": session.fmc.geofence_zone_match,
                            "geofence_city_match": session.fmc.geofence_city_match,
                            "idle_seconds": session.fmc.idle_seconds,
                            "engine_temp_c": session.fmc.engine_temp_c,
                            "accel_kmh_s": session.fmc.last_accel_kmh_s,
                            "dtc_value": session.fmc.dtc_value,
                            "vin": session.fmc.vin,
                            "device_mode": session.fmc.device_mode,
                            "queue_depth": session.fmc.queue_depth,
                            "network_rsrp_dbm": session.fmc.rsrp_dbm,
                            "gnss_fix": session.fmc.gnss_fix,
                            "obd_metrics": session.fmc.last_metrics or {},
                        }
                self.wfile.write(json.dumps(status, indent=2).encode("utf-8"))
                return
            elif self.path == "/debug":
                # Endpoint to test JSON payload format
                self.send_response(200)
                self.end_headers()
                test_payload = {
                    "playerId": "test_player",
                    "latitude": 36.8065,
                    "longitude": 10.1815,
                    "speedKmh": 50.0,
                    "angleDeg": 90.0,
                    "ignition": True
                }
                self.wfile.write(json.dumps(test_payload).encode("utf-8"))
                return
            self.send_response(404)
            self.end_headers()

        def log_message(self, format_str: str, *args) -> None:
            if debug:
                super().log_message(format_str, *args)

    return TelemetryHandler


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MTA telemetry bridge to Teltonika Codec 8")
    parser.add_argument("--listen-host", default="0.0.0.0", help="HTTP listen host")
    parser.add_argument("--listen-port", type=int, default=8765, help="HTTP listen port")
    parser.add_argument("--target-host", default="127.0.0.1", help="Traccar or TCP backend host")
    parser.add_argument("--target-port", type=int, default=5055, help="Traccar or TCP backend port")
    parser.add_argument("--imei-base", type=int, default=352093114300000, help="Base IMEI prefix seed")
    parser.add_argument("--debug", action="store_true", help="Enable debug logs")
    return parser.parse_args()


def main() -> int:
    global _debug_file
    args = parse_args()

    # Ensure live logs in terminals on Windows and piped runs.
    try:
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except Exception:
        pass
    
    # Open debug file if debug is enabled
    if args.debug:
        _debug_file = open("bridge_debug.log", "a", buffering=1)
        debug_log(f"\n=== Bridge started with debug=True ===")
    
    print(f"[bridge] args: debug={args.debug}", flush=True)

    state = BridgeState(
        target_host=args.target_host,
        target_port=args.target_port,
        imei_base=args.imei_base,
    )

    def heartbeat() -> None:
        while True:
            time.sleep(5)
            with state.lock:
                connected_count = sum(1 for s in state.sessions.values() if s.connected)
                print(
                    f"[bridge] heartbeat id={state.instance_id} rx={state.rx_count} ok={state.ok_count} "
                    f"fail={state.fail_count} sessions={len(state.sessions)} "
                    f"connected={connected_count} last_player={state.last_player}",
                    flush=True,
                )

    threading.Thread(target=heartbeat, daemon=True).start()
    handler = create_handler(state, debug=args.debug)

    server = ThreadingHTTPServer((args.listen_host, args.listen_port), handler)
    print(
        f"[bridge] listening http://{args.listen_host}:{args.listen_port} "
        f"-> tcp://{args.target_host}:{args.target_port}"
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[bridge] stopping")
    finally:
        server.shutdown()
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
