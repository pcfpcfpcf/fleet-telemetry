#!/usr/bin/env python3
"""
Standalone FMC003 MQTT Simulator
Simulates a Teltonika FMC003 device sending telemetry via MQTT (no GTA/MTA required)
Single file, single command: python standalone_fmc.py --mqtt-host <host> --mqtt-port <port>
"""

import argparse
import json
import struct
import time
import hashlib
import sys
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List
import threading

try:
    import paho.mqtt.client as mqtt
    HAVE_PAHO = True
except ImportError:
    HAVE_PAHO = False
    print("[!] paho-mqtt not installed. Install with: pip install paho-mqtt", file=sys.stderr)


class SimplePhysics:
    """Simple vehicle physics simulation (no game required)"""
    
    def __init__(self, start_lat: float = 37.7749, start_lon: float = -122.4194):
        self.lat = start_lat
        self.lon = start_lon
        self.speed = 0  # km/h
        self.heading = 0  # degrees
        self.rpm = 800
        self.fuel_level = 85.0  # percent
        self.coolant_temp = 90  # celsius
        self.engine_load = 25  # percent
        self.odometer = 125430.5  # km
        self.runtime = 86400  # seconds
        
        self.ignition = True
        self.direction = 1  # 1 = forward in route, -1 = backward
        self.route_index = 0
        self.last_update = time.time()
        
        # Simple route (SF area loop)
        self.route = [
            (37.7749, -122.4194),   # Market St
            (37.7849, -122.4094),   # Moving northeast
            (37.7949, -122.3994),   # Continuing
            (37.7949, -122.3994),   # More northeast
            (37.7749, -122.3894),   # Turn around
            (37.7649, -122.3994),   # Southwest
            (37.7549, -122.4094),   # Continue
            (37.7549, -122.4194),   # Back to start
        ]
    
    def update(self, dt: float = 1.0):
        """Update position and telemetry"""
        now = time.time()
        dt = min(now - self.last_update, 1.0)
        self.last_update = now
        
        if not self.ignition:
            self.rpm = 0
            self.speed = 0
            self.engine_load = 0
            return
        
        # Simulate driving pattern
        cycle_time = time.time() % 120  # 2-minute cycle
        
        if cycle_time < 30:
            # Idle
            self.speed = 0
            self.rpm = max(800, 800 + int((cycle_time / 30) * 700))
        elif cycle_time < 60:
            # Accelerate
            progress = (cycle_time - 30) / 30
            self.speed = progress * 80
            self.rpm = 800 + int(progress * 4500)
        elif cycle_time < 90:
            # Cruise
            progress = (cycle_time - 60) / 30
            self.speed = 80 - (progress * 30)
            self.rpm = max(1500, 5300 - int(progress * 3000))
        else:
            # Decel and stop
            progress = (cycle_time - 90) / 30
            self.speed = max(0, 50 - (progress * 50))
            self.rpm = max(800, 2300 - int(progress * 1500))
        
        # Update position along route
        if self.speed > 0.1:
            lat1, lon1 = self.route[self.route_index]
            next_idx = (self.route_index + self.direction) % len(self.route)
            lat2, lon2 = self.route[next_idx]
            
            # Small step along route
            step = (self.speed / 1000.0) * dt / 60.0  # rough approximation
            if step > 0:
                self.lat = lat1 + (lat2 - lat1) * min(step, 1.0)
                self.lon = lon1 + (lon2 - lon1) * min(step, 1.0)
            
            # Update heading
            import math
            dy = lat2 - lat1
            dx = lon2 - lon1
            self.heading = math.degrees(math.atan2(dx, dy)) % 360
        
        # Fuel consumption
        if self.speed > 0.1 and self.ignition:
            fuel_rate = 6.0 / 100.0  # 6L/hour consumption
            self.fuel_level = max(5.0, self.fuel_level - (fuel_rate * dt / 3600.0))
        
        # Temp regulation
        target_temp = 95 if self.speed > 0.1 else 85
        self.coolant_temp += (target_temp - self.coolant_temp) * 0.1 * dt
        
        # Engine load
        if self.rpm > 0:
            self.engine_load = (self.rpm / 7000.0) * 100.0
        else:
            self.engine_load = 0
        
        # Odometer
        self.odometer += (self.speed / 3600.0) * dt
        self.runtime += dt


class FMC003Generator:
    """Builds Teltonika Codec8 packets (FMC003-style)"""
    
    def __init__(self, imei: str = "352093114305816"):
        self.imei = imei
        self.packet_count = 0
    
    def build_packet(self, physics: SimplePhysics, timestamp: Optional[int] = None) -> bytes:
        """Build a Codec8 AVL packet"""
        if timestamp is None:
            timestamp = int(time.time() * 1000)
        
        self.packet_count += 1
        
        # Codec8 Format:
        # [2B: 0000] [1B: codec] [1B: num_records] [records...] [1B: num_records] [4B: crc32]
        
        # Single AVL record
        record = self._build_avl_record(physics, timestamp)
        
        # Build packet
        preamble = bytes([0, 0])  # 2-byte preamble
        codec = bytes([8])  # Codec 8
        num_records = bytes([1])  # 1 record
        
        payload = preamble + codec + num_records + record + num_records
        crc = self._crc32(payload)
        
        return payload + crc
    
    def _build_avl_record(self, physics: SimplePhysics, timestamp: int) -> bytes:
        """Build a single Codec8 AVL record"""
        record = b''
        
        # Timestamp (8 bytes, big-endian)
        record += struct.pack('>Q', timestamp)
        
        # Priority (1 byte): 0=low, 1=high, 2=panic
        record += bytes([1])
        
        # GPS data (15 bytes)
        lat = int(physics.lat * 10000000)  # Fixed-point
        lon = int(physics.lon * 10000000)
        alt = 42  # meters above sea level
        angle = int(physics.heading)
        speed = int(physics.speed * 1000 / 3.6)  # convert to m/s, stored as km/h increments
        num_sats = 12
        
        record += struct.pack('>ii', lat, lon)  # lat, lon (4+4 bytes)
        record += struct.pack('>H', alt)  # altitude (2 bytes)
        record += struct.pack('>H', angle)  # angle (2 bytes)
        record += struct.pack('>H', speed)  # speed (2 bytes)
        record += bytes([num_sats])  # num satellites (1 byte)
        
        # IO Elements
        # Count of 1-byte IOs, 2-byte IOs, 4-byte IOs, 8-byte IOs
        ios = self._build_io_elements(physics)
        
        # 1-byte IO count
        one_byte_count = sum(1 for _, size in ios.items() if size == 1)
        record += bytes([one_byte_count])
        
        # 1-byte IOs
        for io_id, value in sorted([(k, v) for k, v in ios.items() if len(struct.pack('B', v if isinstance(v, int) else 0)) == 1]):
            if isinstance(value, int) and value <= 255:
                record += struct.pack('>BH', io_id if isinstance(io_id, int) else 0, value)
        
        # 2-byte IO count (ignition state, engine hours, etc.)
        two_byte_ios = {
            240: int(physics.ignition),  # Ignition
            69: int(physics.rpm),  # RPM (0-8000)
            72: int(physics.fuel_level * 100),  # Fuel level (percent * 100)
            87: int(physics.coolant_temp * 10),  # Coolant temp
            105: int(physics.engine_load),  # Engine load
        }
        record += bytes([len(two_byte_ios)])
        
        for io_id, value in sorted(two_byte_ios.items()):
            record += struct.pack('>HH', io_id, value & 0xFFFF)
        
        # 4-byte IO count
        four_byte_ios = {
            199: int(physics.odometer * 1000),  # Odometer (km * 1000)
            200: int(physics.runtime),  # Engine runtime (seconds)
        }
        record += bytes([len(four_byte_ios)])
        
        for io_id, value in sorted(four_byte_ios.items()):
            record += struct.pack('>HI', io_id, value & 0xFFFFFFFF)
        
        # 8-byte IO count
        record += bytes([0])  # No 8-byte IOs for now
        
        return record
    
    def _build_io_elements(self, physics: SimplePhysics) -> Dict[int, int]:
        """Build IO element dictionary"""
        return {
            # Digital inputs
            240: int(physics.ignition),  # Ignition (DIN1)
            241: 1,  # DIN2
            242: 0,  # DIN3
            243: 0,  # DIN4
        }
    
    def _crc32(self, data: bytes) -> bytes:
        """Calculate CRC32 for Codec8"""
        crc = 0xFFFFFFFF
        for byte in data:
            crc ^= byte
            for _ in range(8):
                if crc & 1:
                    crc = (crc >> 1) ^ 0xEDB88320
                else:
                    crc >>= 1
        return struct.pack('>I', crc ^ 0xFFFFFFFF)


class MQTTPublisher:
    """MQTT client for publishing telemetry"""
    
    def __init__(self, host: str, port: int, imei: str):
        self.host = host
        self.port = port
        self.imei = imei
        self.client = None
        self.connected = False
        self.last_error = None
    
    def connect(self) -> bool:
        """Connect to MQTT broker"""
        try:
            # Create MQTT client
            api_version = getattr(mqtt, 'CallbackAPIVersion', None)
            if api_version:
                self.client = mqtt.Client(callback_api_version=api_version.VERSION2)
            else:
                self.client = mqtt.Client()
            
            # Set callbacks
            self.client.on_connect = self._on_connect
            self.client.on_disconnect = self._on_disconnect
            self.client.on_publish = self._on_publish
            
            # Connect
            self.client.connect(self.host, self.port, keepalive=60)
            self.client.loop_start()
            
            # Wait for connection
            for _ in range(50):
                if self.connected:
                    print(f"[MQTT] Connected to {self.host}:{self.port}")
                    return True
                time.sleep(0.1)
            
            print(f"[MQTT] Connection timeout after 5s")
            return False
        
        except Exception as e:
            self.last_error = str(e)
            print(f"[MQTT] Connection failed: {e}")
            return False
    
    def _on_connect(self, client, userdata, connect_flags, rc, properties=None):
        if rc == 0:
            self.connected = True
        else:
            print(f"[MQTT] Connect failed with code {rc}")
    
    def _on_disconnect(self, client, userdata, disconnect_flags, rc, properties=None):
        self.connected = False
        if rc != 0:
            print(f"[MQTT] Disconnected with code {rc}")
    
    def _on_publish(self, client, userdata, mid, reason_codes=None, properties=None):
        pass  # Publish acknowledged
    
    def publish_codec8(self, packet: bytes, topic: Optional[str] = None):
        """Publish raw Codec8 packet"""
        if not self.connected:
            return False
        
        if topic is None:
            topic = f"teltonika/{self.imei}/codec8/raw"
        
        try:
            self.client.publish(topic, packet, qos=1, retain=False)
            return True
        except Exception as e:
            print(f"[MQTT] Publish failed: {e}")
            return False
    
    def publish_json(self, data: Dict[str, Any], topic: Optional[str] = None):
        """Publish JSON event"""
        if not self.connected:
            return False
        
        if topic is None:
            topic = f"telemetry/{self.imei}/raw"
        
        try:
            payload = json.dumps(data)
            self.client.publish(topic, payload, qos=1, retain=False)
            return True
        except Exception as e:
            print(f"[MQTT] JSON publish failed: {e}")
            return False
    
    def disconnect(self):
        """Disconnect from broker"""
        if self.client:
            self.client.loop_stop()
            self.client.disconnect()
            self.connected = False


def build_json_event(imei: str, physics: SimplePhysics, timestamp: int) -> Dict[str, Any]:
    """Build adapter-compatible JSON event"""
    return {
        "imei": imei,
        "timestamp": timestamp,
        "position": {
            "latitude": physics.lat,
            "longitude": physics.lon,
            "altitude": 42,
            "accuracy": 5,
            "heading": physics.heading,
            "speed": physics.speed,
        },
        "telemetry": {
            "ignition": physics.ignition,
            "rpm": physics.rpm,
            "fuel_level": physics.fuel_level,
            "coolant_temperature": physics.coolant_temp,
            "engine_load": physics.engine_load,
            "odometer": physics.odometer,
            "engine_runtime": physics.runtime,
        },
        "status": {
            "satellites": 12,
            "fix_type": 3,
            "rsrp": -95,
            "queue_depth": 0,
        }
    }


def main():
    parser = argparse.ArgumentParser(
        description="Standalone FMC003 MQTT Simulator",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument('--mqtt-host', default='127.0.0.1', help='MQTT broker host')
    parser.add_argument('--mqtt-port', type=int, default=1883, help='MQTT broker port')
    parser.add_argument('--imei', default='352093114305816', help='Device IMEI')
    parser.add_argument('--interval', type=float, default=5.0, help='Send interval (seconds)')
    parser.add_argument('--duration', type=int, default=None, help='Run duration (seconds), None=infinite')
    parser.add_argument('--raw-topic', default='teltonika/{imei}/codec8/raw', help='Raw Codec8 MQTT topic')
    parser.add_argument('--json-topic', default='telemetry/{imei}/raw', help='JSON MQTT topic')
    parser.add_argument('--quiet', action='store_true', help='Disable raw output (MQTT only)')
    parser.add_argument('--no-mqtt', action='store_true', help='Skip MQTT (test mode)')
    
    args = parser.parse_args()
    
    # Validate
    if not HAVE_PAHO and not args.no_mqtt:
        print("[!] paho-mqtt required. Install with: pip install paho-mqtt", file=sys.stderr)
        return 1
    
    print(f"[FMC] Standalone FMC003 MQTT Simulator")
    print(f"[FMC] IMEI: {args.imei}")
    print(f"[FMC] MQTT: {args.mqtt_host}:{args.mqtt_port}")
    print(f"[FMC] Interval: {args.interval}s")
    
    # Initialize components
    physics = SimplePhysics()
    generator = FMC003Generator(imei=args.imei)
    publisher = None
    
    # Connect to MQTT
    if not args.no_mqtt:
        publisher = MQTTPublisher(args.mqtt_host, args.mqtt_port, args.imei)
        if not publisher.connect():
            print("[!] Failed to connect to MQTT broker")
            return 1
        print(f"[FMC] MQTT connected")
    
    # Main loop
    print(f"[FMC] Starting simulation... (Press Ctrl+C to stop)")
    try:
        start_time = time.time()
        packet_count = 0
        
        while True:
            # Check duration
            if args.duration and (time.time() - start_time) > args.duration:
                print(f"[FMC] Duration limit reached ({args.duration}s)")
                break
            
            # Update physics
            physics.update()
            
            # Generate Codec8 packet
            timestamp = int(time.time() * 1000)
            packet = generator.build_packet(physics, timestamp)
            packet_count += 1
            
            # Publish to MQTT
            if publisher:
                raw_topic = args.raw_topic.replace('{imei}', args.imei)
                json_topic = args.json_topic.replace('{imei}', args.imei)
                
                publisher.publish_codec8(packet, raw_topic)
                event = build_json_event(args.imei, physics, timestamp)
                publisher.publish_json(event, json_topic)
            
            # Print raw output
            if not args.quiet:
                print(f"[CODEC8] #{packet_count} HEX: {packet.hex().upper()}")
                print(f"[DATA] lat={physics.lat:.6f} lon={physics.lon:.6f} "
                      f"spd={physics.speed:.1f}km/h rpm={physics.rpm} fuel={physics.fuel_level:.1f}% "
                      f"temp={physics.coolant_temp:.1f}°C odo={physics.odometer:.1f}km")
                print()
            
            # Wait for next send
            time.sleep(args.interval)
    
    except KeyboardInterrupt:
        print(f"\n[FMC] Stopping... ({packet_count} packets sent)")
    
    except Exception as e:
        print(f"[!] Error: {e}", file=sys.stderr)
        if not args.quiet:
            import traceback
            traceback.print_exc()
        return 1
    
    finally:
        if publisher:
            publisher.disconnect()
    
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
