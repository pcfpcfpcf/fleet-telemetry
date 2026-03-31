#!/usr/bin/env python3
"""Test script for game bridge HTTP endpoint."""

import json
import requests
import time

def test_bridge(bridge_url="http://127.0.0.1:8765"):
    """Test the bridge endpoints."""
    
    print(f"Testing bridge at {bridge_url}")
    print("-" * 60)
    
    # Test 1: Health check
    print("\n1. Testing /health endpoint...")
    try:
        resp = requests.get(f"{bridge_url}/health", timeout=2)
        print(f"   Status: {resp.status_code}")
        print(f"   Response: {resp.text}")
    except Exception as e:
        print(f"   ERROR: {e}")
        return False
    
    # Test 2: Debug endpoint
    print("\n2. Testing /debug endpoint (get example payload)...")
    try:
        resp = requests.get(f"{bridge_url}/debug", timeout=2)
        print(f"   Status: {resp.status_code}")
        payload = resp.json()
        print(f"   Response: {json.dumps(payload, indent=2)}")
    except Exception as e:
        print(f"   ERROR: {e}")
    
    # Test 3: Send valid telemetry
    print("\n3. Testing /telemetry with valid payload...")
    valid_payload = {
        "playerId": "test_player",
        "latitude": 36.8065,
        "longitude": 10.1815,
        "speedKmh": 50.0,
        "angleDeg": 90.0,
        "ignition": True,
        "source": "test"
    }
    try:
        resp = requests.post(
            f"{bridge_url}/telemetry",
            json=valid_payload,
            headers={"Content-Type": "application/json"},
            timeout=5
        )
        print(f"   Status: {resp.status_code}")
        print(f"   Response: {resp.text}")
    except Exception as e:
        print(f"   ERROR: {e}")
    
    # Test 4: Send list-wrapped payload (for debugging MTA serialization)
    print("\n4. Testing /telemetry with list-wrapped payload (MTA quirk)...")
    list_payload = [valid_payload]
    try:
        resp = requests.post(
            f"{bridge_url}/telemetry",
            json=list_payload,
            headers={"Content-Type": "application/json"},
            timeout=5
        )
        print(f"   Status: {resp.status_code}")
        print(f"   Response: {resp.text}")
    except Exception as e:
        print(f"   ERROR: {e}")
    
    # Test 5: Multiple updates from same player
    print("\n5. Testing multiple updates (simulating vehicle movement)...")
    for i in range(3):
        payload = {
            "playerId": "test_player",
            "latitude": 36.8065 + (i * 0.0001),
            "longitude": 10.1815 + (i * 0.0001),
            "speedKmh": 20.0 + (i * 10.0),
            "angleDeg": (i * 30.0) % 360,
            "ignition": True,
            "source": "test"
        }
        try:
            resp = requests.post(
                f"{bridge_url}/telemetry",
                json=payload,
                timeout=5
            )
            status_icon = "✓" if resp.status_code == 200 else "✗"
            print(f"   {status_icon} Update {i+1}: {resp.status_code} - {resp.text}")
        except Exception as e:
            print(f"   ✗ Update {i+1}: ERROR - {e}")
        time.sleep(0.5)
    
    print("\n" + "-" * 60)
    print("Bridge test completed. All endpoints responded.")
    return True

if __name__ == "__main__":
    import sys
    bridge_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
    test_bridge(bridge_url)
