from __future__ import annotations

import socket
import struct
import time


class TeltonikaTCPClient:
    def __init__(self, host: str, port: int, timeout: float = 5.0, reconnect_delay: float = 2.0) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout
        self.reconnect_delay = reconnect_delay
        self.sock: socket.socket | None = None

    def connect(self) -> None:
        self.close()
        sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        sock.settimeout(self.timeout)
        self.sock = sock

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            finally:
                self.sock = None

    def _ensure_socket(self) -> socket.socket:
        if self.sock is None:
            raise ConnectionError("Not connected")
        return self.sock

    def _recv_exact(self, size: int) -> bytes:
        sock = self._ensure_socket()
        data = bytearray()
        while len(data) < size:
            chunk = sock.recv(size - len(data))
            if not chunk:
                raise ConnectionError("Remote closed the connection")
            data.extend(chunk)
        return bytes(data)

    def login_with_imei(self, imei: str) -> bool:
        imei_bytes = imei.encode("ascii")
        payload = struct.pack(">H", len(imei_bytes)) + imei_bytes
        self._ensure_socket().sendall(payload)
        response = self._recv_exact(1)
        return response == b"\x01"

    def connect_and_login(self, imei: str, retries: int = 0) -> None:
        attempts = 0
        while True:
            attempts += 1
            try:
                self.connect()
                if not self.login_with_imei(imei):
                    raise ConnectionError("IMEI rejected by server")
                return
            except (OSError, TimeoutError, ConnectionError):
                self.close()
                if retries and attempts >= retries:
                    raise
                time.sleep(self.reconnect_delay)

    def send_avl_packet(self, packet: bytes, records_sent: int) -> int:
        sock = self._ensure_socket()
        sock.sendall(packet)
        ack_raw = self._recv_exact(4)
        ack_records = struct.unpack(">I", ack_raw)[0]
        if ack_records != records_sent:
            raise ConnectionError(
                f"ACK mismatch: expected={records_sent}, received={ack_records}"
            )
        return ack_records
