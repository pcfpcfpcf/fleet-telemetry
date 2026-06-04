"""
Telemetry API client.

All communication with the L4 service goes through this module.
Odoo must never query TimescaleDB directly.
"""
import json
import logging
import os
from urllib import error, request

_logger = logging.getLogger(__name__)

# Hard timeout for every outbound request to the L4 service.
_REQUEST_TIMEOUT = 10


def _build_request(url, api_key):
    """Return a urllib.request.Request with the correct auth headers."""
    headers = {"Accept": "application/json"}
    if api_key:
        headers["X-API-Key"] = api_key
    return request.Request(url, method="GET", headers=headers)


def _execute(req):
    """
    Execute *req* and return the parsed JSON body.

    Returns None on network error.
    Returns None on non-200 HTTP status (logged as warning).
    Raises json.JSONDecodeError if the body is not valid JSON.
    """
    try:
        with request.urlopen(req, timeout=_REQUEST_TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except error.HTTPError as exc:
        _logger.warning(
            "L4 HTTP %s for %s: %s", exc.code, req.full_url, exc.reason
        )
        return None
    except error.URLError as exc:
        _logger.error("L4 unreachable %s: %s", req.full_url, exc.reason)
        return None


class TelemetryApiClient:
    """
    Thin HTTP client for the L4 telemetry service.

    Instantiate with the base URL and API key obtained from Odoo config
    parameters — do not hard-code these.

    All methods return parsed Python objects or None on failure.
    """

    def __init__(self, base_url, api_key):
        self._base = base_url.rstrip("/")
        self._api_key = api_key

    # ── Fleet ─────────────────────────────────────────────────────────────────

    def get_fleet_summary(self, active_window_minutes=None):
        """GET /api/fleet/summary"""
        url = f"{self._base}/api/fleet/summary"
        if active_window_minutes is not None:
            url += f"?active_window_minutes={int(active_window_minutes)}"
        return _execute(_build_request(url, self._api_key))

    # ── Vehicle ───────────────────────────────────────────────────────────────

    def get_latest(self, device_id):
        """GET /api/vehicles/:deviceId/latest"""
        url = f"{self._base}/api/vehicles/{device_id}/latest"
        return _execute(_build_request(url, self._api_key))

    def get_history(self, device_id, from_ts=None, to_ts=None, limit=None):
        """GET /api/vehicles/:deviceId/history"""
        url = f"{self._base}/api/vehicles/{device_id}/history"
        params = {}
        if from_ts:
            params["from"] = from_ts
        if to_ts:
            params["to"] = to_ts
        if limit is not None:
            params["limit"] = int(limit)
        if params:
            url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
        return _execute(_build_request(url, self._api_key))

    def get_timeline(self, device_id, from_ts=None, to_ts=None, limit=None):
        """GET /api/vehicles/:deviceId/timeline"""
        url = f"{self._base}/api/vehicles/{device_id}/timeline"
        params = {}
        if from_ts:
            params["from"] = from_ts
        if to_ts:
            params["to"] = to_ts
        if limit is not None:
            params["limit"] = int(limit)
        if params:
            url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
        return _execute(_build_request(url, self._api_key))

    def get_alerts(self, device_id, severity=None, alert_type=None,
                   acknowledged=None, from_ts=None, to_ts=None, limit=None):
        """GET /api/vehicles/:deviceId/alerts"""
        url = f"{self._base}/api/vehicles/{device_id}/alerts"
        params = {}
        if severity:
            params["severity"] = severity
        if alert_type:
            params["alert_type"] = alert_type
        if acknowledged is not None:
            params["acknowledged"] = "true" if acknowledged else "false"
        if from_ts:
            params["from"] = from_ts
        if to_ts:
            params["to"] = to_ts
        if limit is not None:
            params["limit"] = int(limit)
        if params:
            url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
        return _execute(_build_request(url, self._api_key))

    def get_diagnostics(self, device_id, from_ts=None, to_ts=None, limit=None, version=None):
        """GET /api/vehicles/:deviceId/diagnostics"""
        url = f"{self._base}/api/vehicles/{device_id}/diagnostics"
        params = {}
        if from_ts:
            params["from"] = from_ts
        if to_ts:
            params["to"] = to_ts
        if limit is not None:
            params["limit"] = int(limit)
        if version:
            params["version"] = version
        if params:
            url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
        return _execute(_build_request(url, self._api_key))

    # ── Legacy (deprecated, used only by the old sync_from_l4 cron) ──────────

    def get_vehicles_legacy(self):
        """GET /vehicles — deprecated endpoint kept for backward compat."""
        url = f"{self._base}/vehicles"
        return _execute(_build_request(url, self._api_key))
