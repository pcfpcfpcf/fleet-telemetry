## Bridge → Server Issue Summary

**Problem:** Bridge receives HTTP telemetry but demo_server doesn't receive TCP packets.

**Current Behavior:**
1. GET /health → 200 OK (handler IS being called)
2. POST /telemetry → 502 Bad Gateway (exception in state.ingest())
3. GET /status → 404 Not Found (indicates exception in do_GET too)

**Root Cause:** The ingest() method is catching an exception and returning 502.

**Next Steps to Diagnose:**

1. Look at the actual exception message in the 502 response
2. Check if TeltonikaTCPClient.connect_and_login() is failing
3. Verify demo_server is actually accepting connections on 127.0.0.1:5055
4. Check if there's a socket permission issue or firewall blocking

**Critical Files:**
- simulator/game_bridge.py (ingest() method, line ~100-145)
- simulator/network.py (TeltonikaTCPClient class)  
- Demo_server.py (listening on 5055)

**Immediate Fix:** Make the 502 response include the actual exception details so we can see what's failing in ingest().
