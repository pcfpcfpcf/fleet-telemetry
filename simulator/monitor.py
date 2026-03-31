from __future__ import annotations

import argparse
from collections import deque
import json
import math
import os
import shutil
import time
import urllib.error
import urllib.request
from typing import Any


ANSI_RESET = "\x1b[0m"
ANSI_BOLD = "\x1b[1m"
ANSI_DIM = "\x1b[2m"
ANSI_GREEN = "\x1b[32m"
ANSI_YELLOW = "\x1b[33m"
ANSI_RED = "\x1b[31m"
ANSI_CYAN = "\x1b[36m"


class MonitorState:
    def __init__(self, history: int, max_events: int = 16) -> None:
        self.speed_history: dict[str, deque[float]] = {}
        self.pos_history: dict[str, deque[tuple[float, float]]] = {}
        self.last_event_key: dict[str, tuple[int, str]] = {}
        self.last_geofence: dict[str, str] = {}
        self.event_feed: deque[str] = deque(maxlen=max_events)
        self.history = history
        self.started_at = time.time()

    def update(self, status: dict[str, Any]) -> None:
        players = status.get("players", {})
        if not isinstance(players, dict):
            return

        live_players = set(players.keys())
        for pid in list(self.speed_history.keys()):
            if pid not in live_players:
                self.speed_history.pop(pid, None)
                self.pos_history.pop(pid, None)
                self.last_event_key.pop(pid, None)
                self.last_geofence.pop(pid, None)

        now_str = time.strftime("%H:%M:%S")
        for player_id, data in players.items():
            speed = _speed_from(data)
            lat = _f(data.get("lat", 0.0))
            lon = _f(data.get("lon", 0.0))

            self.speed_history.setdefault(player_id, deque(maxlen=self.history)).append(speed)
            self.pos_history.setdefault(player_id, deque(maxlen=self.history)).append((lat, lon))

            evt = int(data.get("last_event_io_id", 0))
            reason = str(data.get("last_event_reason", "default"))
            current_key = (evt, reason)
            prev_key = self.last_event_key.get(player_id)
            if prev_key != current_key:
                if prev_key is not None:
                    self.event_feed.appendleft(f"{now_str} {player_id}: event={evt} reason={reason}")
                elif evt != 0 or reason != "default":
                    self.event_feed.appendleft(f"{now_str} {player_id}: event={evt} reason={reason}")
            self.last_event_key[player_id] = current_key

            geofence = str(data.get("active_geofence", "")).strip()
            prev_geofence = self.last_geofence.get(player_id, "")
            if geofence != prev_geofence:
                if geofence:
                    self.event_feed.appendleft(f"{now_str} {player_id}: geofence_enter:{geofence}")
                elif prev_geofence:
                    self.event_feed.appendleft(f"{now_str} {player_id}: geofence_exit:{prev_geofence}")
            self.last_geofence[player_id] = geofence


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Live CLI monitor for bridge-connected devices")
    parser.add_argument("--host", default="127.0.0.1", help="Bridge host")
    parser.add_argument("--port", type=int, default=8765, help="Bridge port")
    parser.add_argument("--interval", type=float, default=1.0, help="Refresh interval seconds")
    parser.add_argument("--width", type=int, default=88, help="Map width")
    parser.add_argument("--height", type=int, default=22, help="Map height")
    parser.add_argument("--history", type=int, default=24, help="History samples per device")
    parser.add_argument("--top", type=int, default=10, help="Maximum devices to show in table")
    parser.add_argument("--sort", choices=["speed", "name", "signal"], default="speed", help="Table sort")
    parser.add_argument("--no-color", action="store_true", help="Disable ANSI colors")
    return parser.parse_args()


def fetch_status(host: str, port: int, timeout: float = 1.5) -> dict[str, Any]:
    url = f"http://{host}:{port}/status"
    req = urllib.request.Request(url=url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("status payload must be an object")
    return payload


def _f(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _i(v: Any, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _speed_from(data: dict[str, Any]) -> float:
    obd = data.get("obd_metrics", {}) if isinstance(data.get("obd_metrics", {}), dict) else {}
    return _f(
        data.get(
            "speed",
            data.get(
                "speedKmh",
                obd.get("speed_kmh", obd.get("vehicle_speed", 0.0)),
            ),
        )
    )


def _term_width() -> int:
    return shutil.get_terminal_size((140, 40)).columns


def _color(text: str, ansi: str, enabled: bool) -> str:
    if not enabled:
        return text
    return f"{ansi}{text}{ANSI_RESET}"


def _sparkline(values: list[float], lo: float = 0.0, hi: float = 120.0) -> str:
    chars = " .:-=+*#%@"
    if not values:
        return ""
    out: list[str] = []
    spread = max(1e-9, hi - lo)
    for v in values:
        ratio = (v - lo) / spread
        idx = int(max(0, min(len(chars) - 1, round(ratio * (len(chars) - 1)))))
        out.append(chars[idx])
    return "".join(out)


def _bar(value: float, lo: float, hi: float, width: int = 12) -> str:
    ratio = (value - lo) / max(1e-9, (hi - lo))
    ratio = max(0.0, min(1.0, ratio))
    filled = int(round(ratio * width))
    return "[" + ("#" * filled) + ("-" * (width - filled)) + "]"


def _bounds(players: dict[str, dict[str, Any]]) -> tuple[float, float, float, float]:
    lats = [_f(p.get("lat", 0.0)) for p in players.values()]
    lons = [_f(p.get("lon", 0.0)) for p in players.values()]

    min_lat, max_lat = min(lats), max(lats)
    min_lon, max_lon = min(lons), max(lons)

    if math.isclose(min_lat, max_lat, rel_tol=0.0, abs_tol=1e-9):
        min_lat -= 0.0005
        max_lat += 0.0005
    if math.isclose(min_lon, max_lon, rel_tol=0.0, abs_tol=1e-9):
        min_lon -= 0.0005
        max_lon += 0.0005

    lat_pad = max(0.0001, (max_lat - min_lat) * 0.12)
    lon_pad = max(0.0001, (max_lon - min_lon) * 0.12)
    return min_lat - lat_pad, max_lat + lat_pad, min_lon - lon_pad, max_lon + lon_pad


def _to_grid(
    lat: float,
    lon: float,
    min_lat: float,
    max_lat: float,
    min_lon: float,
    max_lon: float,
    width: int,
    height: int,
) -> tuple[int, int]:
    x_ratio = (lon - min_lon) / max(1e-12, (max_lon - min_lon))
    y_ratio = (lat - min_lat) / max(1e-12, (max_lat - min_lat))

    x = max(0, min(width - 1, int(round(x_ratio * (width - 1)))))
    y = max(0, min(height - 1, int(round((1.0 - y_ratio) * (height - 1)))))
    return x, y


def render_map(status: dict[str, Any], width: int, height: int) -> str:
    players = status.get("players", {})
    if not isinstance(players, dict) or not players:
        return "No devices connected yet."

    min_lat, max_lat, min_lon, max_lon = _bounds(players)
    grid = [["." for _ in range(width)] for _ in range(height)]

    legend: list[str] = []
    markers = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    for idx, (player_id, data) in enumerate(sorted(players.items(), key=lambda kv: kv[0])):
        lat = _f(data.get("lat", 0.0))
        lon = _f(data.get("lon", 0.0))
        obd = data.get("obd_metrics", {}) if isinstance(data.get("obd_metrics", {}), dict) else {}
        speed = _speed_from(data)
        connected = bool(data.get("connected", False))
        rpm = _i(obd.get("rpm", 0))
        fuel_pct = _f(obd.get("fuel_level", obd.get("fuel_pct", 0.0)))
        coolant = _f(obd.get("coolant_temp_c", data.get("engine_temp_c", 0.0)))
        dtc = _i(obd.get("dtc_value", data.get("dtc_value", 0)))
        gnss_fix = _i(obd.get("gnss_fix", data.get("gnss_fix", 0)))
        hdop = _f(obd.get("gnss_hdop", 0.0))
        rsrp = _i(obd.get("network_rsrp_dbm", data.get("network_rsrp_dbm", -120)))
        queue_depth = _i(obd.get("queue_depth", data.get("queue_depth", 0)))
        mode_code = _i(obd.get("device_mode_code", 0))
        mode_label = {1: "act", 2: "idl", 3: "slp", 4: "dsp"}.get(mode_code, "unk")
        geofence = str(data.get("active_geofence", "")).strip() or "-"

        marker = markers[idx % len(markers)]
        x, y = _to_grid(lat, lon, min_lat, max_lat, min_lon, max_lon, width, height)
        grid[y][x] = marker

        legend.append(
            f" {marker} {player_id:14.14s} spd={speed:6.1f} km/h "
            f"conn={'Y' if connected else 'N'} ev={data.get('last_event_io_id', 0)} "
            f"rpm={rpm:4d} tmp={coolant:5.1f}C fuel={fuel_pct:5.1f}% "
            f"dtc=0x{dtc:04X} fix={gnss_fix} hdop={hdop:3.1f} "
            f"rsrp={rsrp:4d} q={queue_depth:4d} mode={mode_label} "
            f"gf={geofence:12.12s} {str(data.get('last_event_reason', 'default')):16.16s}"
        )

    lines: list[str] = []
    lines.append(f"lat[{min_lat:.6f}, {max_lat:.6f}] lon[{min_lon:.6f}, {max_lon:.6f}]")
    lines.append("+" + "-" * width + "+")
    for row in grid:
        lines.append("|" + "".join(row) + "|")
    lines.append("+" + "-" * width + "+")
    lines.extend(legend)
    return "\n".join(lines)


def _sorted_players(players: dict[str, dict[str, Any]], sort_by: str) -> list[tuple[str, dict[str, Any]]]:
    if sort_by == "name":
        return sorted(players.items(), key=lambda kv: kv[0].lower())
    if sort_by == "signal":
        return sorted(
            players.items(),
            key=lambda kv: _i((kv[1].get("obd_metrics") or {}).get("network_rsrp_dbm", kv[1].get("network_rsrp_dbm", -200))),
            reverse=True,
        )
    return sorted(players.items(), key=lambda kv: _speed_from(kv[1]), reverse=True)


def _render_table(
    players: dict[str, dict[str, Any]],
    state: MonitorState,
    top: int,
    sort_by: str,
    colors: bool,
) -> list[str]:
    rows = _sorted_players(players, sort_by)[:top]
    lines = [
        "DEVICE TABLE",
        "name         conn  spd   rpm  fuel  temp  fix hdop  rsrp   q   evt geofence      reason           speed-trend",
    ]
    if not rows:
        lines.append("(no devices)")
        return lines

    for player_id, data in rows:
        obd = data.get("obd_metrics", {}) if isinstance(data.get("obd_metrics", {}), dict) else {}
        speed = _speed_from(data)
        rpm = _i(obd.get("rpm", 0))
        fuel = _f(obd.get("fuel_level", obd.get("fuel_pct", 0.0)))
        temp = _f(obd.get("coolant_temp_c", data.get("engine_temp_c", 0.0)))
        fix = _i(obd.get("gnss_fix", data.get("gnss_fix", 0)))
        hdop = _f(obd.get("gnss_hdop", 0.0))
        rsrp = _i(obd.get("network_rsrp_dbm", data.get("network_rsrp_dbm", -120)))
        queue_depth = _i(obd.get("queue_depth", data.get("queue_depth", 0)))
        evt = _i(data.get("last_event_io_id", 0))
        geofence = str(data.get("active_geofence", "")).strip() or "-"
        reason = str(data.get("last_event_reason", "default"))[:15]
        conn = bool(data.get("connected", False))
        trend = _sparkline(list(state.speed_history.get(player_id, [])), lo=0.0, hi=120.0)

        conn_txt = _color("Y", ANSI_GREEN, colors) if conn else _color("N", ANSI_RED, colors)
        rsrp_txt = f"{rsrp:4d}"
        if rsrp < -110:
            rsrp_txt = _color(rsrp_txt, ANSI_RED, colors)
        elif rsrp < -95:
            rsrp_txt = _color(rsrp_txt, ANSI_YELLOW, colors)
        else:
            rsrp_txt = _color(rsrp_txt, ANSI_GREEN, colors)

        lines.append(
            f"{player_id[:12]:12s}  {conn_txt}  {speed:5.1f} {rpm:5d} {fuel:5.1f}% {temp:5.1f}C "
            f" {fix:2d} {hdop:4.1f} {rsrp_txt} {queue_depth:4d} {evt:4d} {geofence[:12]:12s} {reason:15s} {trend}"
        )
    return lines


def _render_geofence_summary(players: dict[str, dict[str, Any]], colors: bool) -> list[str]:
    inside: list[str] = []
    outside: list[str] = []
    for player_id, data in players.items():
        geofence = str(data.get("active_geofence", "")).strip()
        if geofence:
            inside.append(f"{player_id}:{geofence}")
        else:
            nearest = str(data.get("nearest_geofence", "")).strip() or "-"
            dist_m = _f(data.get("nearest_geofence_distance_m", 0.0))
            outside.append(f"{player_id}:{nearest}@{dist_m:.0f}m")

    lines = ["GEOFENCE STATUS"]
    if inside:
        inside_txt = ", ".join(inside[:6])
        lines.append(" inside: " + _color(inside_txt, ANSI_GREEN, colors))
    else:
        lines.append(" inside: none")
    if outside:
        outside_txt = ", ".join(outside[:6])
        lines.append(" outside: " + _color(outside_txt, ANSI_RED, colors))
    else:
        lines.append(" outside: none")
    return lines


def _render_coords(players: dict[str, dict[str, Any]]) -> list[str]:
    lines = [
        "PLAYER COORDINATES",
        "name         zone/city                  world_x    world_y     lat         lon         nearest_gf    dist_m  in_poly in_circ  d_poly  d_circ  radius",
    ]
    for player_id, data in sorted(players.items(), key=lambda kv: kv[0].lower()):
        world_x = data.get("world_x")
        world_y = data.get("world_y")
        lat = _f(data.get("lat", 0.0))
        lon = _f(data.get("lon", 0.0))
        nearest = str(data.get("nearest_geofence", "")).strip() or "-"
        zone_name = str(data.get("zone_name", "")).strip() or "-"
        city_name = str(data.get("city_name", "")).strip() or "-"
        zone_city = f"{zone_name}/{city_name}"
        dist_m = _f(data.get("nearest_geofence_distance_m", 0.0))
        in_poly = bool(data.get("geofence_inside_polygon", False))
        in_circ = bool(data.get("geofence_inside_circle", False))
        d_poly = _f(data.get("geofence_distance_polygon_m", 0.0))
        d_circ = _f(data.get("geofence_distance_circle_m", 0.0))
        radius_m = _f(data.get("geofence_radius_m", 0.0))
        wx_txt = "-" if world_x is None else f"{_f(world_x):8.1f}"
        wy_txt = "-" if world_y is None else f"{_f(world_y):8.1f}"
        lines.append(
            f"{player_id[:12]:12s} {zone_city[:26]:26s} {wx_txt:>8s} {wy_txt:>9s} "
            f"{lat:10.6f} {lon:11.6f} {nearest[:12]:12s} {dist_m:7.1f} "
            f"{('Y' if in_poly else 'N'):>7s} {('Y' if in_circ else 'N'):>7s} "
            f"{d_poly:7.1f} {d_circ:7.1f} {radius_m:7.1f}"
        )
    if len(lines) == 2:
        lines.append("(no devices)")
    return lines


def _render_kpis(status: dict[str, Any], players: dict[str, dict[str, Any]], uptime_s: float) -> list[str]:
    bridge_uptime = _i(status.get("uptime_s", int(uptime_s)))
    last_rx_age = status.get("last_rx_age_s")
    rx_age_txt = "-" if last_rx_age is None else f"{_f(last_rx_age):.1f}s"
    connected = sum(1 for p in players.values() if bool(p.get("connected", False)))
    speeds = []
    for p in players.values():
        speeds.append(_speed_from(p))
    avg_speed = sum(speeds) / len(speeds) if speeds else 0.0
    max_speed = max(speeds) if speeds else 0.0
    rsrps = []
    for p in players.values():
        obd = p.get("obd_metrics", {}) if isinstance(p.get("obd_metrics", {}), dict) else {}
        rsrps.append(_i(obd.get("network_rsrp_dbm", p.get("network_rsrp_dbm", -120))))
    avg_rsrp = sum(rsrps) / len(rsrps) if rsrps else -120.0
    queues = []
    for p in players.values():
        obd = p.get("obd_metrics", {}) if isinstance(p.get("obd_metrics", {}), dict) else {}
        queues.append(_i(obd.get("queue_depth", p.get("queue_depth", 0))))
    queue_total = sum(queues)

    return [
        f"Sessions={status.get('sessions', 0)} Connected={connected} Errors={len(status.get('recent_errors', []))} Uptime={bridge_uptime}s LastRxAge={rx_age_txt}",
        f"AvgSpeed={avg_speed:5.1f} km/h  MaxSpeed={max_speed:5.1f} km/h  AvgRSRP={avg_rsrp:6.1f} dBm  QueueTotal={queue_total}",
        f"Signal {_bar(avg_rsrp, -125, -80)}  Queue {_bar(float(queue_total), 0, max(20.0, float(queue_total + 1)))}",
    ]


def render_dashboard(
    status: dict[str, Any],
    width: int,
    height: int,
    host: str,
    port: int,
    state: MonitorState,
    sort_by: str,
    top: int,
    no_color: bool,
) -> None:
    term_width = _term_width()
    colors = (not no_color) and os.isatty(1)
    players = status.get("players", {}) if isinstance(status.get("players", {}), dict) else {}

    print("\x1b[2J\x1b[H", end="")
    title = "FMC003 INSANE LIVE MONITOR"
    pad = max(0, term_width - len(title) - 4)
    print("+" + "-" * (term_width - 2) + "+")
    print("| " + _color(title, ANSI_BOLD + ANSI_CYAN, colors) + " " + " " * max(0, pad - 2) + "|")
    print("+" + "-" * (term_width - 2) + "+")
    print(f" Bridge: http://{host}:{port}   Target: {status.get('target', '-')}")
    print(f" Instance: {status.get('bridge_instance_id', '-')}")
    for line in _render_kpis(status, players, time.time() - state.started_at):
        print(" " + line)
    print("")
    print(render_map(status, width=width, height=height))
    print("")
    for line in _render_table(players, state, top=top, sort_by=sort_by, colors=colors):
        print(line)
    print("")

    for line in _render_geofence_summary(players, colors=colors):
        print(line)
    print("")

    for line in _render_coords(players):
        print(line)
    print("")

    print("EVENT FEED")
    if state.event_feed:
        for line in list(state.event_feed)[:10]:
            print(" " + line)
    else:
        print(" (no recent event changes)")

    recent_errors = status.get("recent_errors", [])
    if isinstance(recent_errors, list) and recent_errors:
        print("")
        print(_color("RECENT ERRORS", ANSI_RED + ANSI_BOLD, colors))
        for e in recent_errors[-5:]:
            print(" " + str(e)[: min(200, term_width - 2)])

    print("")
    print(_color("Ctrl+C to stop", ANSI_DIM, colors))


def main() -> int:
    args = parse_args()
    if args.interval <= 0:
        raise ValueError("--interval must be > 0")
    if args.width < 20:
        raise ValueError("--width must be >= 20")
    if args.height < 8:
        raise ValueError("--height must be >= 8")
    if args.history < 4:
        raise ValueError("--history must be >= 4")
    if args.top < 1:
        raise ValueError("--top must be >= 1")

    state = MonitorState(history=args.history)

    try:
        while True:
            try:
                status = fetch_status(args.host, args.port)
                state.update(status)
                render_dashboard(
                    status,
                    args.width,
                    args.height,
                    args.host,
                    args.port,
                    state,
                    sort_by=args.sort,
                    top=args.top,
                    no_color=args.no_color,
                )
            except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
                print("\x1b[2J\x1b[H", end="")
                print("+------------------------------------------------------------------+")
                print("|                  FMC003 MULTI-DEVICE LIVE MONITOR               |")
                print("+------------------------------------------------------------------+")
                print(f" Bridge unreachable: http://{args.host}:{args.port}/status")
                print(f" Error: {type(exc).__name__}: {exc}")
                print("")
                print(" Retrying...")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[monitor] stopping")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
