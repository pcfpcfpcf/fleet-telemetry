"""
FleetVehicleTelemetry — per-device latest-state snapshot.

This model holds the most recently synced state for each device.
It is intentionally a snapshot, not a historical log.
History lives in TimescaleDB and is fetched on demand via the API client.

Architecture constraint: this model must never query TimescaleDB directly.
All data comes from the L4 service through TelemetryApiClient.
"""
import json
import logging
import os
from datetime import datetime

from odoo import api, fields, models

from .telemetry_api_client import TelemetryApiClient

_logger = logging.getLogger(__name__)


class FleetVehicleTelemetry(models.Model):
    _name = "fleet.vehicle.telemetry"
    _description = "Fleet Vehicle Telemetry (Latest State)"
    _rec_name = "device_id"

    # ── Identity ───────────────────────────────────────────────────────────────
    device_id = fields.Char(string="Device ID", required=True, index=True)

    # ── Timestamps ────────────────────────────────────────────────────────────
    event_id = fields.Char(string="Event ID")
    timestamp = fields.Datetime(string="Device Timestamp")
    received_at = fields.Datetime(string="Received At")

    # ── Position ──────────────────────────────────────────────────────────────
    latitude = fields.Float(string="Latitude", digits=(10, 6))
    longitude = fields.Float(string="Longitude", digits=(10, 6))
    altitude = fields.Float(string="Altitude (m)")
    accuracy = fields.Float(string="GPS Accuracy")
    bearing = fields.Float(string="Bearing (°)")

    # ── Core telemetry — validated FMC003 fields ───────────────────────────────
    speed = fields.Float(string="Speed (km/h)")
    ignition = fields.Boolean(string="Ignition")
    fuel_level = fields.Float(string="Fuel Level (%)")
    odometer = fields.Float(string="Odometer (km)")
    rpm = fields.Integer(string="RPM")
    engine_load = fields.Float(string="Engine Load (%)")

    # ── Flags ─────────────────────────────────────────────────────────────────
    buffered = fields.Boolean(string="Buffered", default=False)

    # ── Raw payload (full FMC003 record, JSON) ─────────────────────────────────
    payload = fields.Text(string="Raw Payload")

    _sql_constraints = [
        (
            "fleet_vehicle_telemetry_device_unique",
            "unique(device_id)",
            "Each device may have only one latest-state record.",
        ),
    ]

    # ── API client factory ────────────────────────────────────────────────────

    @api.model
    def _get_client(self):
        params = self.env["ir.config_parameter"].sudo()
        base_url = params.get_param(
            "fleet_telemetry_connector.l4_base_url", "http://l4-service:3000"
        ).rstrip("/")
        api_key = params.get_param(
            "fleet_telemetry_connector.l4_api_key",
            os.getenv("L4_API_KEY", os.getenv("API_KEY", "")),
        )
        return TelemetryApiClient(base_url, api_key)

    # ── Datetime helper ───────────────────────────────────────────────────────

    @api.model
    def _to_odoo_datetime(self, raw_ts):
        if not raw_ts:
            return False
        if isinstance(raw_ts, datetime):
            return fields.Datetime.to_string(raw_ts)
        try:
            normalized = str(raw_ts).replace("Z", "+00:00")
            parsed = datetime.fromisoformat(normalized)
            return fields.Datetime.to_string(parsed)
        except (TypeError, ValueError):
            _logger.warning("Invalid timestamp from L4: %s", raw_ts)
            return False

    # ── Sync from L4 — called by cron ─────────────────────────────────────────

    @api.model
    def sync_from_l4(self):
        """
        Fetch latest vehicle states from /vehicles (legacy) and upsert into
        this model. One record per device — update if exists, create if new.

        Called by ir.cron every minute.
        """
        client = self._get_client()
        vehicles = client.get_vehicles_legacy()
        if not isinstance(vehicles, list):
            _logger.warning("Unexpected /vehicles response: %s", type(vehicles))
            return 0

        upserted = 0
        for item in vehicles:
            if not isinstance(item, dict) or not item.get("device_id"):
                continue

            vals = {
                "device_id": item.get("device_id"),
                "latitude": item.get("lat"),
                "longitude": item.get("lng"),
                "speed": item.get("speed"),
                "fuel_level": item.get("fuel_level"),
                "ignition": bool(item.get("ignition")),
                "timestamp": self._to_odoo_datetime(item.get("timestamp")),
                "payload": json.dumps(item),
            }

            existing = self.search([("device_id", "=", item["device_id"])], limit=1)
            if existing:
                existing.write(vals)
            else:
                self.create(vals)
            upserted += 1

        _logger.info("Synced %s vehicles from L4", upserted)
        return upserted

    # ── On-demand fetch actions ───────────────────────────────────────────────

    def action_refresh_from_l4(self):
        """Fetch and update the latest state for this specific device."""
        self.ensure_one()
        client = self._get_client()
        data = client.get_latest(self.device_id)
        if not data:
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": "No data",
                    "message": f"No telemetry found for device {self.device_id}.",
                    "type": "warning",
                },
            }

        self.write({
            "event_id": data.get("event_id"),
            "timestamp": self._to_odoo_datetime(data.get("timestamp")),
            "received_at": self._to_odoo_datetime(data.get("received_at")),
            "latitude": data.get("lat"),
            "longitude": data.get("lng"),
            "altitude": data.get("altitude"),
            "accuracy": data.get("accuracy"),
            "bearing": data.get("bearing"),
            "speed": data.get("speed"),
            "ignition": bool(data.get("ignition")),
            "fuel_level": data.get("fuel_level"),
            "odometer": data.get("odometer"),
            "rpm": data.get("rpm"),
            "engine_load": data.get("engine_load"),
            "buffered": bool(data.get("buffered")),
            "payload": json.dumps(data.get("payload") or {}),
        })

        return {"type": "ir.actions.client", "tag": "reload"}

    def action_open_asset_detail(self):
        """Open the Asset Detail page for this device."""
        self.ensure_one()
        return {
            "type": "ir.actions.client",
            "tag": "fleet_telemetry_asset_detail",
            "name": f"Asset Detail — {self.device_id}",
            "params": {"device_id": self.device_id},
        }

    def action_sync_all(self):
        """Button action to trigger a full fleet sync."""
        self.sync_from_l4()
        return {"type": "ir.actions.client", "tag": "reload"}
