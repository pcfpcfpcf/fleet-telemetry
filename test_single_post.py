#!/usr/bin/env python3
import json
import socket

payload = {
    "playerId": "test_driver",
    "latitude": 36.8065,
    "longitude": 10.1815,
    "speedKmh": 50.0,
    "angleDeg": 90.0,
    "ignition": True,
    "source": "test"
}

body = json.dumps(payload)
request = f"""POST /telemetry HTTP/1.1\r
Host: 127.0.0.1:8765\r
Content-Type: application/json\r
Content-Length: {len(body)}\r
Connection: close\r
\r
{body}"""

print("[client] Connecting to bridge...")
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.connect(("127.0.0.1", 8765))
print("[client] Sending telemetry...")
sock.sendall(request.encode())

print("[client] Receiving response...")
response = b""
while True:
    chunk = sock.recv(4096)
    if not chunk:
        break
    response += chunk
sock.close()

# Split headers and body
parts = response.split(b"\r\n\r\n", 1)
print(parts[0].decode())
if len(parts) > 1:
    body = parts[1].decode()
    print(f"[BODY] {body}")
print("[client] Done")

