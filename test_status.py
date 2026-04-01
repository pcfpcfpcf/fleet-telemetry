#!/usr/bin/env python3
import socket
import json


request = """GET /status HTTP/1.1\r
Host: 127.0.0.1:8765\r
Connection: close\r
\r
"""

print("[client] Getting status...")
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.connect(("127.0.0.1", 8765))
sock.sendall(request.encode())

response = sock.recv(4096).decode()
print(response)
sock.close()
