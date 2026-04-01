from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import struct
from typing import Any

from encoder import build_codec8_packet, crc16_ibm


def _load_packet(path: str | None, hex_str: str | None) -> bytes:
    if path:
        data = Path(path).read_bytes()
        return data
    if hex_str:
        cleaned = "".join(hex_str.split())
        return bytes.fromhex(cleaned)
    raise ValueError("One source is required (path or hex)")


def _format_timestamp(timestamp_ms: int) -> str:
    dt = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _parse_io_elements(payload: bytes, offset: int) -> tuple[int, int, dict[int, int]]:
    event_io_id = payload[offset]
    offset += 1
    _total_io_count = payload[offset]
    offset += 1

    io_values: dict[int, int] = {}

    n1 = payload[offset]
    offset += 1
    for _ in range(n1):
        io_id = payload[offset]
        value = payload[offset + 1]
        io_values[io_id] = value
        offset += 2

    n2 = payload[offset]
    offset += 1
    for _ in range(n2):
        io_id = payload[offset]
        value = struct.unpack(">H", payload[offset + 1: offset + 3])[0]
        io_values[io_id] = value
        offset += 3

    n4 = payload[offset]
    offset += 1
    for _ in range(n4):
        io_id = payload[offset]
        value = struct.unpack(">I", payload[offset + 1: offset + 5])[0]
        io_values[io_id] = value
        offset += 5

    n8 = payload[offset]
    offset += 1
    for _ in range(n8):
        io_id = payload[offset]
        value = struct.unpack(">Q", payload[offset + 1: offset + 9])[0]
        io_values[io_id] = value
        offset += 9

    return offset, event_io_id, io_values


def parse_codec8_packet(packet: bytes) -> dict[str, Any]:
    if len(packet) < 12:
        raise ValueError("Packet too short")

    preamble = packet[:4]
    if preamble != b"\x00\x00\x00\x00":
        raise ValueError(f"Invalid preamble: {preamble.hex()}")

    data_len = struct.unpack(">I", packet[4:8])[0]
    data = packet[8: 8 + data_len]
    crc_recv32 = struct.unpack(">I", packet[8 + data_len: 12 + data_len])[0]
    crc_calc = crc16_ibm(data)

    if len(data) < 3:
        raise ValueError("Data payload too short")

    codec = data[0]
    record_count = data[1]
    count2 = data[-1]

    records: list[dict[str, Any]] = []
    offset = 2
    for _ in range(record_count):
        timestamp_ms = struct.unpack(">Q", data[offset: offset + 8])[0]
        offset += 8
        priority = data[offset]
        offset += 1
        longitude_raw = struct.unpack(">i", data[offset: offset + 4])[0]
        offset += 4
        latitude_raw = struct.unpack(">i", data[offset: offset + 4])[0]
        offset += 4
        altitude = struct.unpack(">H", data[offset: offset + 2])[0]
        offset += 2
        angle = struct.unpack(">H", data[offset: offset + 2])[0]
        offset += 2
        satellites = data[offset]
        offset += 1
        speed = struct.unpack(">H", data[offset: offset + 2])[0]
        offset += 2

        offset, event_io_id, io_values = _parse_io_elements(data, offset)

        records.append(
            {
                "timestamp_ms": timestamp_ms,
                "timestamp": _format_timestamp(timestamp_ms),
                "priority": priority,
                "longitude": longitude_raw / 10000000.0,
                "latitude": latitude_raw / 10000000.0,
                "altitude": altitude,
                "angle": angle,
                "satellites": satellites,
                "speed": speed,
                "event_io_id": event_io_id,
                "io_values": io_values,
            }
        )

    return {
        "preamble": preamble.hex(),
        "data_len": data_len,
        "codec": codec,
        "record_count": record_count,
        "record_count_2": count2,
        "crc_recv32": crc_recv32,
        "crc_calc": crc_calc,
        "crc_ok": (crc_recv32 & 0xFFFF) == crc_calc,
        "records": records,
        "payload_offset_ok": offset == len(data) - 1,
    }


def _byte_level_diff(a: bytes, b: bytes, max_diffs: int = 20) -> list[str]:
    diffs: list[str] = []
    max_len = max(len(a), len(b))
    for i in range(max_len):
        av = a[i] if i < len(a) else None
        bv = b[i] if i < len(b) else None
        if av != bv:
            if av is None:
                diffs.append(f"offset {i}: actual=<none> expected=0x{bv:02X}")
            elif bv is None:
                diffs.append(f"offset {i}: actual=0x{av:02X} expected=<none>")
            else:
                diffs.append(f"offset {i}: actual=0x{av:02X} expected=0x{bv:02X}")
            if len(diffs) >= max_diffs:
                break
    return diffs


def _decoded_diff(actual: dict[str, Any], expected: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    top_fields = ["codec", "record_count", "record_count_2", "data_len", "crc_ok"]
    for key in top_fields:
        if actual.get(key) != expected.get(key):
            issues.append(f"{key}: actual={actual.get(key)} expected={expected.get(key)}")

    rec_count = min(len(actual["records"]), len(expected["records"]))
    for i in range(rec_count):
        a = actual["records"][i]
        e = expected["records"][i]
        for key in ["priority", "latitude", "longitude", "altitude", "angle", "satellites", "speed", "event_io_id"]:
            if a.get(key) != e.get(key):
                issues.append(f"record[{i + 1}].{key}: actual={a.get(key)} expected={e.get(key)}")

        a_io = a.get("io_values", {})
        e_io = e.get("io_values", {})
        all_io_ids = sorted(set(a_io.keys()) | set(e_io.keys()))
        for io_id in all_io_ids:
            if a_io.get(io_id) != e_io.get(io_id):
                issues.append(
                    f"record[{i + 1}].io[{io_id}]: actual={a_io.get(io_id)} expected={e_io.get(io_id)}"
                )

    if len(actual["records"]) != len(expected["records"]):
        issues.append(
            f"record list size: actual={len(actual['records'])} expected={len(expected['records'])}"
        )

    return issues


def _build_packet_from_record_json(path: str) -> bytes:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Record JSON must be an object")

    records = payload.get("records")
    if records is None:
        records = [payload]
    if not isinstance(records, list) or not records:
        raise ValueError("Record JSON must contain a non-empty 'records' array or a single record object")
    return build_codec8_packet(records)


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare simulator packet against golden packet")
    parser.add_argument("--actual-file", help="Path to actual packet file (binary)")
    parser.add_argument("--actual-hex", help="Hex string of actual packet")
    parser.add_argument("--actual-record-json", help="Build actual packet from record JSON")
    parser.add_argument("--expected-file", help="Path to expected packet file (binary)")
    parser.add_argument("--expected-hex", help="Hex string of expected packet")
    parser.add_argument("--json", action="store_true", help="Print decoded structures as JSON")
    args = parser.parse_args()

    if args.actual_record_json:
        actual = _build_packet_from_record_json(args.actual_record_json)
    else:
        actual = _load_packet(args.actual_file, args.actual_hex)

    expected = _load_packet(args.expected_file, args.expected_hex)

    actual_decoded = parse_codec8_packet(actual)
    expected_decoded = parse_codec8_packet(expected)

    byte_diffs = _byte_level_diff(actual, expected)
    decoded_diffs = _decoded_diff(actual_decoded, expected_decoded)

    print("[golden-compare] summary")
    print(f"  byte_equal={actual == expected}")
    print(f"  byte_diff_count_shown={len(byte_diffs)}")
    print(f"  decoded_diff_count={len(decoded_diffs)}")

    if byte_diffs:
        print("\n[golden-compare] byte diffs (first 20):")
        for item in byte_diffs:
            print(f"  - {item}")

    if decoded_diffs:
        print("\n[golden-compare] decoded diffs:")
        for item in decoded_diffs[:80]:
            print(f"  - {item}")

    if args.json:
        print("\n[golden-compare] actual decoded JSON")
        print(json.dumps(actual_decoded, indent=2, sort_keys=True))
        print("\n[golden-compare] expected decoded JSON")
        print(json.dumps(expected_decoded, indent=2, sort_keys=True))

    return 1 if (byte_diffs or decoded_diffs) else 0


if __name__ == "__main__":
    raise SystemExit(main())
