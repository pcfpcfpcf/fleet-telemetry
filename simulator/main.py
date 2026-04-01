from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import threading
import time
from typing import Any
from uuid import uuid4

from car import Car
from encoder import build_codec8_packet, validate_crc_self_test
from fmc003 import FMC003
from network import TeltonikaTCPClient
from profile import load_profile
from replay import codec8_record_count, load_hex_packets

try:
    import paho.mqtt.client as paho_mqtt
except ImportError:
    paho_mqtt = None

try:
    from pynput import keyboard
except ImportError as exc:
    keyboard = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


class ControlState:
    def __init__(self) -> None:
        self.up = False
        self.down = False
        self.left = False
        self.right = False
        self._toggle_ignition = False
        self._lock = threading.Lock()

    def set_key(self, key_name: str, pressed: bool) -> None:
        with self._lock:
            setattr(self, key_name, pressed)

    def request_toggle_ignition(self) -> None:
        with self._lock:
            self._toggle_ignition = True

    def consume_toggle_ignition(self) -> bool:
        with self._lock:
            requested = self._toggle_ignition
            self._toggle_ignition = False
            return requested

    def snapshot(self) -> tuple[bool, bool, bool, bool]:
        with self._lock:
            return self.up, self.down, self.left, self.right


class KeyboardInputLayer:
    def __init__(self, controls: ControlState) -> None:
        self.controls = controls
        self.listener = None

    def _on_press(self, key) -> None:
        if key == keyboard.Key.up:
            self.controls.set_key("up", True)
        elif key == keyboard.Key.down:
            self.controls.set_key("down", True)
        elif key == keyboard.Key.left:
            self.controls.set_key("left", True)
        elif key == keyboard.Key.right:
            self.controls.set_key("right", True)
        else:
            key_char = getattr(key, "char", None)
            if key_char is None:
                return
            key_char = key_char.lower()
            if key_char == "w":
                self.controls.set_key("up", True)
            elif key_char == "s":
                self.controls.set_key("down", True)
            elif key_char == "a":
                self.controls.set_key("left", True)
            elif key_char == "d":
                self.controls.set_key("right", True)
            elif key_char == "i":
                self.controls.request_toggle_ignition()

    def _on_release(self, key) -> None:
        if key == keyboard.Key.up:
            self.controls.set_key("up", False)
        elif key == keyboard.Key.down:
            self.controls.set_key("down", False)
        elif key == keyboard.Key.left:
            self.controls.set_key("left", False)
        elif key == keyboard.Key.right:
            self.controls.set_key("right", False)
        else:
            key_char = getattr(key, "char", None)
            if key_char is None:
                return
            key_char = key_char.lower()
            if key_char == "w":
                self.controls.set_key("up", False)
            elif key_char == "s":
                self.controls.set_key("down", False)
            elif key_char == "a":
                self.controls.set_key("left", False)
            elif key_char == "d":
                self.controls.set_key("right", False)

    def start(self) -> None:
        if keyboard is None:
            raise RuntimeError(
                "pynput is required for arrow-key input. Install with: pip install pynput"
            ) from IMPORT_ERROR
        self.listener = keyboard.Listener(on_press=self._on_press, on_release=self._on_release)
        self.listener.start()

    def stop(self) -> None:
        if self.listener is not None:
            self.listener.stop()
            self.listener = None


class MqttMirror:
    def __init__(self, args: argparse.Namespace) -> None:
        if paho_mqtt is None:
            raise RuntimeError(
                "MQTT mirror requested but paho-mqtt is not installed. Install with: pip install paho-mqtt"
            )

        self.args = args

        # Ensure unique client IDs to prevent MQTT broker from kicking older sessions
        default_client_id = f"fmc003-{args.imei}-{uuid4().hex[:8]}"
        callback_api = getattr(paho_mqtt, "CallbackAPIVersion", None)
        if callback_api is not None:
            self.client = paho_mqtt.Client(
                callback_api_version=callback_api.VERSION2,
                client_id=args.mqtt_client_id or default_client_id,
            )
        else:
            self.client = paho_mqtt.Client(client_id=args.mqtt_client_id or default_client_id)
        if args.mqtt_username:
            self.client.username_pw_set(args.mqtt_username, args.mqtt_password)

    def connect(self) -> None:
        try:
            self.client.connect(self.args.mqtt_host, self.args.mqtt_port, keepalive=60)
            self.client.loop_start()
        except OSError as exc:
            raise RuntimeError(
                f"MQTT broker connection failed to {self.args.mqtt_host}:{self.args.mqtt_port}. "
                "Start EMQX first (e.g. docker compose --env-file .env.example up -d emqx)."
            ) from exc

    def publish_raw(self, packet: bytes) -> None:
        topic = self.args.mqtt_raw_topic.format(imei=self.args.imei)
        info = self.client.publish(topic, packet, qos=self.args.mqtt_qos, retain=False)
        info.wait_for_publish(timeout=2.0)

    def publish_compat_event(self, record: dict[str, Any], buffered: bool) -> None:
        if not self.args.mqtt_compat_topic:
            return

        ts_ms = int(record.get("timestamp_ms", int(time.time() * 1000)))
        timestamp = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        event = {
            "event_id": str(uuid4()),
            "device_id": self.args.imei,
            "timestamp": timestamp,
            "received_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "position": {
                "lat": float(record.get("latitude", 0.0)),
                "lng": float(record.get("longitude", 0.0)),
                "altitude": float(record.get("altitude", 0.0)),
                "accuracy": 5.0,
                "bearing": float(record.get("angle", 0.0)),
                "speed": float(record.get("speed", 0.0)),
            },
            "telemetry": {
                "ignition": bool(record.get("io_elements", {}).get(239, 0)),
                "fuel_level": float(record.get("io_elements", {}).get(13, 0.0)) / 10.0,
                "odometer": float(record.get("io_elements", {}).get(16, 0.0)),
                "rpm": int(record.get("io_elements", {}).get(12, 0)),
                "engine_load": float(record.get("io_elements", {}).get(21, 0.0)),
            },
            "io_events": [],
            "buffered": buffered,
        }
        topic = self.args.mqtt_compat_topic.format(imei=self.args.imei)
        payload = json.dumps(event, separators=(",", ":"))
        info = self.client.publish(topic, payload, qos=self.args.mqtt_qos, retain=False)
        info.wait_for_publish(timeout=2.0)

    def close(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()


def _on_off(value: bool) -> str:
    return "ON " if value else "OFF"


def render_dashboard(
    record: dict[str, Any] | None,
    car: Car,
    controls: ControlState,
    ack: int,
    packet_size: int,
    host: str,
    port: int,
    imei: str,
    connected: bool,
    buffered_records: int,
    next_interval_s: float,
) -> None:
    up, down, left, right = controls.snapshot()
    speed = max(0.0, min(120.0, float(car.speed)))
    width = 36
    filled = int((speed / 120.0) * width)
    bar = "#" * filled + "-" * (width - filled)

    io = record.get("io_elements", {}) if record else {}

    print("\x1b[2J\x1b[H", end="")
    print("+----------------------------------------------------------------+")
    print("|                   TELTONIKA FMC003 EMULATOR                    |")
    print("+----------------------------------------------------------------+")
    print(f" Target: {host}:{port}   IMEI: {imei}")
    print(
        f" Link: {'CONNECTED' if connected else 'OFFLINE  '}  "
        f"Buffered: {buffered_records:4d}  Next Tx Interval: {next_interval_s:4.1f}s"
    )
    print(" Controls: Arrow keys or WASD, press I to toggle ignition")
    print(
        " Input State: "
        f"UP[{_on_off(up)}] DOWN[{_on_off(down)}] "
        f"LEFT[{_on_off(left)}] RIGHT[{_on_off(right)}]"
    )
    print("")
    print(f" Speedometer [{bar}] {speed:6.2f} km/h")
    print(f" Heading: {car.angle:6.2f} deg    Ignition: {_on_off(car.ignition)}")

    if record:
        print(
            f" Position: lat={record['latitude']:.6f} lon={record['longitude']:.6f} "
            f"alt={record['altitude']}m sat={record['satellites']}"
        )
        print(
            f" IO: ign={io.get(239)} mov={io.get(240)} spd={io.get(24)} batt={io.get(66)} "
            f"rpm={io.get(12)} fuel(0.1%)={io.get(13)} odo(m)={io.get(16)} gsm={io.get(21)}"
        )
    else:
        print(" Position: n/a")
        print(" IO: n/a")

    print(f" Last packet size: {packet_size} bytes   Last ACK: {ack}")
    print("+----------------------------------------------------------------+")
    print(" Press Ctrl+C to stop")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Teltonika FMC003 high-fidelity emulator")
    parser.add_argument("--host", default="127.0.0.1", help="TCP server host")
    parser.add_argument("--no-tcp", action="store_true", help="Disable TCP uplink (MQTT-only mode)")
    parser.add_argument("--port", type=int, default=5055, help="TCP server port")
    parser.add_argument("--imei", default="352093114305816", help="15-digit device IMEI")
    parser.add_argument("--latitude", type=float, default=36.8065, help="Initial latitude")
    parser.add_argument("--longitude", type=float, default=10.1815, help="Initial longitude")
    parser.add_argument("--no-gps-noise", action="store_true", help="Disable GPS noise")
    parser.add_argument("--debug", action="store_true", help="Print periodic telemetry debug logs")
    parser.add_argument("--no-ui", action="store_true", help="Disable dashboard and print debug lines only")
    parser.add_argument("--physics-step", type=float, default=0.1, help="Physics step in seconds")
    parser.add_argument("--moving-interval", type=float, default=1.0, help="AVL interval while moving")
    parser.add_argument("--idle-interval", type=float, default=5.0, help="AVL interval while idle")
    parser.add_argument("--ignition-off-interval", type=float, default=10.0, help="AVL interval while ignition is off")
    parser.add_argument("--burst-size", type=int, default=5, help="Max buffered records to send per packet")
    parser.add_argument("--max-buffer", type=int, default=1000, help="Max buffered records kept while offline")
    parser.add_argument("--profile", default=None, help="Path to JSON profile for IO IDs/sizes/scaling")
    parser.add_argument(
        "--replay-hex-file",
        default=None,
        help="Path to text file with one full Codec8 packet hex string per line (sent byte-for-byte)",
    )
    parser.add_argument("--replay-loop", action="store_true", help="Loop replay packet sequence indefinitely")
    parser.add_argument("--replay-interval", type=float, default=1.0, help="Delay between replay packets in seconds")
    parser.add_argument("--mqtt-host", default=None, help="Optional MQTT broker host to mirror sent data")
    parser.add_argument("--mqtt-port", type=int, default=1883, help="MQTT broker port")
    parser.add_argument("--mqtt-username", default=None, help="MQTT username")
    parser.add_argument("--mqtt-password", default=None, help="MQTT password")
    parser.add_argument("--mqtt-client-id", default=None, help="MQTT client ID")
    parser.add_argument("--mqtt-qos", type=int, default=1, help="MQTT QoS for mirror publish")
    parser.add_argument(
        "--mqtt-raw-topic",
        default="teltonika/{imei}/codec8/raw",
        help="MQTT topic template for raw Codec8 bytes (supports {imei})",
    )
    parser.add_argument(
        "--mqtt-compat-topic",
        default="telemetry/{imei}/raw",
        help="Optional adapter-compatible JSON topic template (supports {imei}); empty disables",
    )
    return parser.parse_args()


def apply_controls(car: Car, controls: ControlState, dt_seconds: float) -> None:
    if controls.consume_toggle_ignition():
        car.toggle_ignition()

    up, down, left, right = controls.snapshot()
    if up and car.ignition:
        car.accelerate(amount=18.0 * dt_seconds)
    if down:
        car.brake(amount=26.0 * dt_seconds)
    if left:
        car.turn_left(degrees=70.0 * dt_seconds)
    if right:
        car.turn_right(degrees=70.0 * dt_seconds)


def main() -> int:
    args = parse_args()

    if len(args.imei) != 15 or not args.imei.isdigit():
        raise ValueError("IMEI must be a 15-digit numeric string")
    if args.physics_step <= 0:
        raise ValueError("physics-step must be > 0")
    if args.burst_size <= 0:
        raise ValueError("burst-size must be > 0")
    if args.max_buffer <= 0:
        raise ValueError("max-buffer must be > 0")
    if args.replay_interval <= 0:
        raise ValueError("replay-interval must be > 0")
    if args.mqtt_qos < 0 or args.mqtt_qos > 2:
        raise ValueError("mqtt-qos must be 0, 1, or 2")
    if not validate_crc_self_test():
        raise RuntimeError("CRC-16/IBM self-test failed")

    mqtt_mirror: MqttMirror | None = None
    if args.mqtt_host:
        mqtt_mirror = MqttMirror(args)
        mqtt_mirror.connect()
        raw_topic = args.mqtt_raw_topic.format(imei=args.imei)
        compat_topic = args.mqtt_compat_topic.format(imei=args.imei) if args.mqtt_compat_topic else "disabled"
        print(
            f"[sim] MQTT mirror enabled -> {args.mqtt_host}:{args.mqtt_port} "
            f"raw={raw_topic} compat={compat_topic}"
        )

    if args.replay_hex_file:
        replay_packets = load_hex_packets(args.replay_hex_file)
        client = TeltonikaTCPClient(host=args.host, port=args.port)
        print(
            f"[sim] Strict replay mode. Sending byte-for-byte packets from {args.replay_hex_file} "
            f"to {args.host}:{args.port} IMEI={args.imei}"
        )

        try:
            client.connect_and_login(args.imei)
            print("[sim] Connected and authenticated")

            while True:
                for idx, packet in enumerate(replay_packets, start=1):
                    records = codec8_record_count(packet)
                    try:
                        ack = client.send_avl_packet(packet, records_sent=records)
                    except (OSError, TimeoutError, ConnectionError) as exc:
                        print(f"[sim] Replay link issue ({exc}), reconnecting...")
                        client.connect_and_login(args.imei)
                        ack = client.send_avl_packet(packet, records_sent=records)

                    if mqtt_mirror is not None:
                        mqtt_mirror.publish_raw(packet)

                    if args.debug:
                        print(
                            f"[sim] replay packet={idx}/{len(replay_packets)} "
                            f"size={len(packet)} records={records} ack={ack}"
                        )
                    time.sleep(args.replay_interval)

                if not args.replay_loop:
                    break

        except KeyboardInterrupt:
            print("\n[sim] Stopping replay")
        finally:
            client.close()
            if mqtt_mirror is not None:
                mqtt_mirror.close()

        return 0

    profile = load_profile(args.profile)

    car = Car(latitude=args.latitude, longitude=args.longitude, speed=0.0, angle=0.0, ignition=True)
    device = FMC003(
        imei=args.imei,
        car=car,
        moving_interval_s=args.moving_interval,
        idle_interval_s=args.idle_interval,
        ignition_off_interval_s=args.ignition_off_interval,
        profile=profile,
    )

    controls = ControlState()
    keyboard_input = KeyboardInputLayer(controls)
    client = TeltonikaTCPClient(host=args.host, port=args.port) if not args.no_tcp else None

    pending_records: list[dict[str, Any]] = []
    last_record: dict[str, Any] | None = None
    connected = False
    last_ack = 0
    last_packet_size = 0

    last_tick = time.time()
    last_record_at = last_tick
    next_send_at = last_tick
    next_ui_refresh = last_tick

    if not args.no_ui:
        keyboard_input.start()
    print(
        "[sim] Input active. Arrow keys/WASD to drive, I to toggle ignition. "
        f"Target={args.mqtt_host}:{args.mqtt_port} IMEI={args.imei}"
    )

    try:
        while True:
            loop_start = time.time()
            dt = max(0.01, loop_start - last_tick)
            last_tick = loop_start

            apply_controls(car, controls, dt_seconds=dt)
            car.update(dt_seconds=dt)

            if loop_start >= next_send_at:
                rec_dt = max(0.01, loop_start - last_record_at)
                last_record = device.build_record(
                    add_gps_noise=not args.no_gps_noise,
                    dt_seconds=rec_dt,
                )
                last_record_at = loop_start
                pending_records.append(last_record)
                if len(pending_records) > args.max_buffer:
                    pending_records = pending_records[-args.max_buffer:]
                next_send_at = loop_start + device.tx_interval()

            if pending_records:
                send_count = min(args.burst_size, len(pending_records))
                to_send = pending_records[:send_count]
                packet = build_codec8_packet(to_send)
                last_packet_size = len(packet)

                if client is not None:
                    try:
                        if not connected:
                            client.connect_and_login(args.imei, retries=1)
                            connected = True
                            if args.debug:
                                print("[sim] Connected and authenticated")

                        ack = client.send_avl_packet(packet, records_sent=send_count)
                        last_ack = ack
                        del pending_records[:ack]
                    except (OSError, TimeoutError, ConnectionError) as exc:
                        if connected or args.debug:
                            print(f"[sim] Link issue ({exc}). Keeping {len(pending_records)} buffered records.")
                        connected = False
                        client.close()

                if mqtt_mirror is not None and last_record is not None:
                    mqtt_mirror.publish_raw(packet)
                    mqtt_mirror.publish_compat_event(last_record, buffered=len(pending_records) > 0)
                    if args.no_tcp:
                        del pending_records[:send_count]

                if args.no_ui and args.debug and last_record is not None:
                    print(
                        "[sim] "
                        f"lat={last_record['latitude']:.6f} "
                        f"lon={last_record['longitude']:.6f} "
                        f"speed={last_record['speed']:3d} "
                        f"angle={last_record['angle']:3d} "
                        f"buffer={len(pending_records)}"
                    )

            if not args.no_ui and loop_start >= next_ui_refresh:
                render_dashboard(
                    record=last_record,
                    car=car,
                    controls=controls,
                    ack=last_ack,
                    packet_size=last_packet_size,
                    host=args.host,
                    port=args.port,
                    imei=args.imei,
                    connected=connected,
                    buffered_records=len(pending_records),
                    next_interval_s=device.tx_interval(),
                )
                next_ui_refresh = loop_start + 0.2

            sleep_for = args.physics_step - (time.time() - loop_start)
            if sleep_for > 0:
                time.sleep(sleep_for)

    except KeyboardInterrupt:
        print("\n[sim] Stopping simulator")
    finally:
        keyboard_input.stop()
        if client is not None:
            client.close()
        if mqtt_mirror is not None:
            mqtt_mirror.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
