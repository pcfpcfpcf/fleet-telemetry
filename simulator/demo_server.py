from __future__ import annotations

from datetime import datetime, timezone
import socket
import struct


def recv_exact(conn: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = conn.recv(size - len(data))
        if not chunk:
            raise ConnectionError("client disconnected")
        data.extend(chunk)
    return bytes(data)


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


def parse_io_elements(payload: bytes, offset: int) -> tuple[int, int, dict[int, int]]:
    event_io_id = payload[offset]
    offset += 1
    total_io_count = payload[offset]
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


def parse_record(payload: bytes, offset: int) -> tuple[int, dict]:
    timestamp_ms = struct.unpack(">Q", payload[offset: offset + 8])[0]
    offset += 8
    priority = payload[offset]
    offset += 1

    longitude_raw = struct.unpack(">i", payload[offset: offset + 4])[0]
    offset += 4
    latitude_raw = struct.unpack(">i", payload[offset: offset + 4])[0]
    offset += 4

    altitude = struct.unpack(">H", payload[offset: offset + 2])[0]
    offset += 2
    angle = struct.unpack(">H", payload[offset: offset + 2])[0]
    offset += 2
    satellites = payload[offset]
    offset += 1
    speed = struct.unpack(">H", payload[offset: offset + 2])[0]
    offset += 2

    offset, event_io_id, io_values = parse_io_elements(payload, offset)

    return offset, {
        "timestamp_ms": timestamp_ms,
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


def format_timestamp(timestamp_ms: int) -> str:
    dt = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def run(host: str = "127.0.0.1", port: int = 5055) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((host, port))
        server.listen(1)
        print(f"[demo-server] listening on {host}:{port}")

        conn, addr = server.accept()
        with conn:
            print(f"[demo-server] client connected from {addr}")

            imei_len = struct.unpack(">H", recv_exact(conn, 2))[0]
            imei = recv_exact(conn, imei_len).decode("ascii", errors="replace")
            print(f"[demo-server] IMEI={imei}")
            conn.sendall(b"\x01")

            packet_index = 0
            while True:
                packet_index += 1
                preamble = recv_exact(conn, 4)
                if preamble != b"\x00\x00\x00\x00":
                    raise ValueError(f"invalid preamble: {preamble.hex()}")

                data_len = struct.unpack(">I", recv_exact(conn, 4))[0]
                data = recv_exact(conn, data_len)
                crc_raw = recv_exact(conn, 4)
                crc_recv32 = struct.unpack(">I", crc_raw)[0]
                crc_calc = crc16_ibm(data)

                if len(data) < 3:
                    raise ValueError("AVL payload too short")

                codec = data[0]
                record_count = data[1]
                count2 = data[-1]

                if codec != 0x08:
                    print(f"[demo-server] WARN unexpected codec=0x{codec:02X}")

                print(
                    f"\n[demo-server] packet={packet_index} codec=0x{codec:02X} "
                    f"records={record_count} count2={count2} data_len={data_len} "
                    f"crc_recv=0x{crc_recv32:08X} crc_calc=0x{crc_calc:04X} "
                    f"crc_ok={((crc_recv32 & 0xFFFF) == crc_calc)}"
                )

                offset = 2
                for idx in range(record_count):
                    offset, rec = parse_record(data, offset)
                    print(
                        f"  record[{idx + 1}] ts={format_timestamp(rec['timestamp_ms'])} "
                        f"prio={rec['priority']} lat={rec['latitude']:.6f} "
                        f"lon={rec['longitude']:.6f} alt={rec['altitude']}m "
                        f"ang={rec['angle']} sat={rec['satellites']} spd={rec['speed']}"
                    )
                    io = rec["io_values"]
                    print(
                        "    io: "
                        f"event={rec['event_io_id']} total={len(io)} "
                        f"239(ign)={io.get(239)} 240(mov)={io.get(240)} "
                        f"24(speed)={io.get(24)} 66(batt)={io.get(66)} all={io}"
                    )

                if offset != len(data) - 1:
                    print(
                        f"[demo-server] WARN payload offset mismatch offset={offset} "
                        f"expected={len(data) - 1}"
                    )
                if record_count != count2:
                    print(
                        f"[demo-server] WARN record count mismatch first={record_count} "
                        f"second={count2}"
                    )

                conn.sendall(struct.pack(">I", record_count))


if __name__ == "__main__":
    run()
