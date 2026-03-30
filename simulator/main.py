from __future__ import annotations

import argparse
import threading
import time

from car import Car
from encoder import build_codec8_packet, validate_crc_self_test
from fmc003 import FMC003
from network import TeltonikaTCPClient

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
        self._lock = threading.Lock()

    def set_key(self, key_name: str, pressed: bool) -> None:
        with self._lock:
            setattr(self, key_name, pressed)

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

    def _on_release(self, key) -> None:
        if key == keyboard.Key.up:
            self.controls.set_key("up", False)
        elif key == keyboard.Key.down:
            self.controls.set_key("down", False)
        elif key == keyboard.Key.left:
            self.controls.set_key("left", False)
        elif key == keyboard.Key.right:
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Teltonika FMC003 Codec8 TCP simulator")
    parser.add_argument("--host", default="127.0.0.1", help="TCP server host")
    parser.add_argument("--port", type=int, default=5055, help="TCP server port")
    parser.add_argument("--imei", default="352093114305816", help="15-digit device IMEI")
    parser.add_argument("--interval", type=float, default=1.0, help="Send interval in seconds")
    parser.add_argument("--latitude", type=float, default=36.8065, help="Initial latitude")
    parser.add_argument("--longitude", type=float, default=10.1815, help="Initial longitude")
    parser.add_argument("--no-gps-noise", action="store_true", help="Disable GPS noise")
    parser.add_argument("--debug", action="store_true", help="Print periodic telemetry debug logs")
    return parser.parse_args()


def apply_controls(car: Car, controls: ControlState) -> None:
    up, down, left, right = controls.snapshot()
    if up:
        car.accelerate()
    if down:
        car.brake()
    if left:
        car.turn_left()
    if right:
        car.turn_right()


def main() -> int:
    args = parse_args()

    if len(args.imei) != 15 or not args.imei.isdigit():
        raise ValueError("IMEI must be a 15-digit numeric string")
    if not validate_crc_self_test():
        raise RuntimeError("CRC-16/IBM self-test failed")

    car = Car(latitude=args.latitude, longitude=args.longitude, speed=0.0, angle=0.0, ignition=True)
    device = FMC003(imei=args.imei, car=car)

    controls = ControlState()
    keyboard_input = KeyboardInputLayer(controls)
    client = TeltonikaTCPClient(host=args.host, port=args.port)

    keyboard_input.start()
    print(f"[sim] Keyboard active. Use arrow keys to drive. Target={args.host}:{args.port} IMEI={args.imei}")

    try:
        client.connect_and_login(args.imei)
        print("[sim] IMEI accepted by server")

        while True:
            tick_start = time.time()

            apply_controls(car, controls)
            car.update()

            record = device.build_record(add_gps_noise=not args.no_gps_noise)
            packet = build_codec8_packet([record])

            try:
                ack = client.send_avl_packet(packet, records_sent=1)
            except (OSError, TimeoutError, ConnectionError) as exc:
                print(f"[sim] Network issue ({exc}), reconnecting...")
                client.connect_and_login(args.imei)
                ack = client.send_avl_packet(packet, records_sent=1)

            if args.debug:
                print(
                    "[sim] "
                    f"lat={record['latitude']:.6f} "
                    f"lon={record['longitude']:.6f} "
                    f"speed={record['speed']:3d} "
                    f"angle={record['angle']:3d} "
                    f"ack={ack}"
                )

            elapsed = time.time() - tick_start
            time.sleep(max(0.0, args.interval - elapsed))

    except KeyboardInterrupt:
        print("\n[sim] Stopping simulator")
    finally:
        keyboard_input.stop()
        client.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
