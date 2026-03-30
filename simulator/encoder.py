from __future__ import annotations

import struct
from typing import Dict, Iterable, List, Tuple


DEFAULT_IO_SIZES = {
    239: 1,
    240: 1,
    24: 2,
    66: 2,
}


def crc16_ibm(data: bytes) -> int:
    crc = 0x0000
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc & 0xFFFF


def _io_size(io_id: int, value: int, io_sizes: Dict[int, int]) -> int:
    if io_id in io_sizes:
        return io_sizes[io_id]
    if 0 <= value <= 0xFF:
        return 1
    if 0 <= value <= 0xFFFF:
        return 2
    if 0 <= value <= 0xFFFFFFFF:
        return 4
    return 8


def group_io_elements(
    io_elements: Dict[int, int],
    io_sizes: Dict[int, int] | None = None,
) -> Tuple[List[Tuple[int, int]], List[Tuple[int, int]], List[Tuple[int, int]], List[Tuple[int, int]]]:
    sizes = DEFAULT_IO_SIZES.copy()
    if io_sizes:
        sizes.update(io_sizes)

    n1: List[Tuple[int, int]] = []
    n2: List[Tuple[int, int]] = []
    n4: List[Tuple[int, int]] = []
    n8: List[Tuple[int, int]] = []

    for io_id, value in sorted(io_elements.items()):
        size = _io_size(io_id, value, sizes)
        if size == 1:
            n1.append((io_id, value & 0xFF))
        elif size == 2:
            n2.append((io_id, value & 0xFFFF))
        elif size == 4:
            n4.append((io_id, value & 0xFFFFFFFF))
        elif size == 8:
            n8.append((io_id, value & 0xFFFFFFFFFFFFFFFF))
        else:
            raise ValueError(f"Unsupported IO size for id={io_id}: {size}")

    return n1, n2, n4, n8


def encode_avl_record(record: Dict) -> bytes:
    longitude = int(round(float(record["longitude"]) * 10000000))
    latitude = int(round(float(record["latitude"]) * 10000000))

    gps = struct.pack(
        ">QBiihHBH",
        int(record["timestamp_ms"]),
        int(record.get("priority", 0)) & 0xFF,
        longitude,
        latitude,
        int(record.get("altitude", 0)) & 0xFFFF,
        int(record.get("angle", 0)) & 0xFFFF,
        int(record.get("satellites", 0)) & 0xFF,
        int(record.get("speed", 0)) & 0xFFFF,
    )

    io_elements = dict(record.get("io_elements", {}))
    n1, n2, n4, n8 = group_io_elements(io_elements)
    total_io = len(n1) + len(n2) + len(n4) + len(n8)

    io_bytes = bytearray()
    io_bytes += struct.pack(
        ">BB",
        int(record.get("event_io_id", 0)) & 0xFF,
        total_io & 0xFF,
    )

    io_bytes += struct.pack(">B", len(n1) & 0xFF)
    for io_id, value in n1:
        io_bytes += struct.pack(">BB", io_id & 0xFF, value & 0xFF)

    io_bytes += struct.pack(">B", len(n2) & 0xFF)
    for io_id, value in n2:
        io_bytes += struct.pack(">BH", io_id & 0xFF, value & 0xFFFF)

    io_bytes += struct.pack(">B", len(n4) & 0xFF)
    for io_id, value in n4:
        io_bytes += struct.pack(">BI", io_id & 0xFF, value & 0xFFFFFFFF)

    io_bytes += struct.pack(">B", len(n8) & 0xFF)
    for io_id, value in n8:
        io_bytes += struct.pack(">BQ", io_id & 0xFF, value & 0xFFFFFFFFFFFFFFFF)

    return gps + bytes(io_bytes)


def build_codec8_packet(records: Iterable[Dict]) -> bytes:
    record_list = list(records)
    if not record_list:
        raise ValueError("At least one AVL record is required")

    encoded_records = b"".join(encode_avl_record(record) for record in record_list)
    record_count = len(record_list)

    data_field = bytearray()
    data_field += struct.pack(">B", 0x08)
    data_field += struct.pack(">B", record_count & 0xFF)
    data_field += encoded_records
    data_field += struct.pack(">B", record_count & 0xFF)

    packet = bytearray()
    packet += b"\x00\x00\x00\x00"
    packet += struct.pack(">I", len(data_field))
    packet += data_field
    packet += struct.pack(">I", crc16_ibm(bytes(data_field)))

    return bytes(packet)


def validate_crc_self_test() -> bool:
    return crc16_ibm(b"123456789") == 0xBB3D
