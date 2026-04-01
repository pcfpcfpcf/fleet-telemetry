from __future__ import annotations

from pathlib import Path
import struct


def load_hex_packets(path: str) -> list[bytes]:
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    packets: list[bytes] = []

    for line_no, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "#" in line:
            line = line.split("#", 1)[0].strip()
        cleaned = "".join(line.split())
        try:
            packet = bytes.fromhex(cleaned)
        except ValueError as exc:
            raise ValueError(f"Invalid hex in {path}:{line_no}") from exc

        validate_codec8_packet(packet)
        packets.append(packet)

    if not packets:
        raise ValueError(f"No valid packets found in {path}")
    return packets


def validate_codec8_packet(packet: bytes) -> None:
    if len(packet) < 12:
        raise ValueError("Packet too short")
    if packet[:4] != b"\x00\x00\x00\x00":
        raise ValueError("Invalid preamble")

    data_len = struct.unpack(">I", packet[4:8])[0]
    expected_size = 8 + data_len + 4
    if len(packet) != expected_size:
        raise ValueError(
            f"Packet length mismatch: got={len(packet)} expected={expected_size}"
        )

    data = packet[8:8 + data_len]
    if len(data) < 3:
        raise ValueError("Data section too short")
    if data[0] != 0x08:
        raise ValueError(f"Expected codec 0x08, got 0x{data[0]:02X}")


def codec8_record_count(packet: bytes) -> int:
    validate_codec8_packet(packet)
    data_len = struct.unpack(">I", packet[4:8])[0]
    data = packet[8:8 + data_len]
    return int(data[1])
