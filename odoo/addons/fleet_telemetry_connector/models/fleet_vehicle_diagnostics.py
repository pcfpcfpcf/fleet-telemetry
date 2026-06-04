"""
FleetVehicleDiagnostics — latest diagnostics snapshot per device.

Populated by sync_diagnostics_from_l4() which is called from the cron.
The `raw_payload` field preserves the full FMC003 payload, enabling access
to any field not yet promoted to a typed column.

Version is stored for every record so consumers can detect schema changes.
"""
import json
import logging
import os

from odoo import api, fields, models

from .telemetry_api_client import TelemetryApiClient

_logger = logging.getLogger(__name__)


class FleetVehicleDiagnostics(models.Model):
    _name = "fleet.vehicle.diagnostics"
    _description = "Fleet Vehicle Diagnostics (Latest)"
    _rec_name = "device_id"

    # ── Identity ──────────────────────────────────────────────────────────────
    device_id = fields.Char(string="Device ID", required=True, index=True)
    contract_version = fields.Char(string="Contract Version", default="1")

    # ── Timestamps ────────────────────────────────────────────────────────────
    timestamp = fields.Datetime(string="Device Timestamp")
    received_at = fields.Datetime(string="Received At")

    # ── Engine / fuel diagnostics — validated FMC003 fields ───────────────────
    rpm = fields.Integer(string="RPM")
    engine_load = fields.Float(string="Engine Load (%)")
    fuel_level = fields.Float(string="Fuel Level (%)")
    odometer = fields.Float(string="Odometer (km)")

    # ── Flags ─────────────────────────────────────────────────────────────────
    buffered = fields.Boolean(string="Buffered", default=False)

    # ── Raw payload — full FMC003 record, never stripped ──────────────────────
    raw_payload = fields.Text(string="Raw Payload (JSON)")

    _sql_constraints = [
        (
            "fleet_vehicle_diagnostics_device_unique",
            "unique(device_id)",
            "Each device may have only one diagnostics record.",
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

    @api.model
    def _to_odoo_datetime(self, raw_ts):
        if not raw_ts:
            return False
        from datetime import datetime
        try:
            normalized = str(raw_ts).replace("Z", "+00:00")
            parsed = datetime.fromisoformat(normalized)
            return fields.Datetime.to_string(parsed)
        except (TypeError, ValueError):
            _logger.warning("Invalid timestamp from L4: %s", raw_ts)
            return False

    # ── Sync ──────────────────────────────────────────────────────────────────

    @api.model
    def sync_diagnostics_from_l4(self):
        """
        Iterate over all known devices and upsert their diagnostics snapshot.
        Called by ir.cron every 5 minutes.
        """
        client = self._get_client()
        device_ids = self.env["fleet.vehicle.telemetry"].search([]).mapped("device_id")
        upserted = 0

        for device_id in device_ids:
            data = client.get_diagnostics(device_id)
            if not data or not data.get("latest"):
                _logger.debug("No diagnostics for device %s", device_id)
                continue

            latest = data["latest"]
            vals = {
                "device_id": device_id,
                "contract_version": str(data.get("version", "1")),
                "timestamp": self._to_odoo_datetime(latest.get("timestamp")),
                "received_at": self._to_odoo_datetime(latest.get("received_at")),
                "rpm": latest.get("rpm") or 0,
                "engine_load": latest.get("engine_load") or 0.0,
                "fuel_level": latest.get("fuel_level") or 0.0,
                "odometer": latest.get("odometer") or 0.0,
                "buffered": bool(latest.get("buffered")),
                "raw_payload": json.dumps(data.get("raw_payload") or {}),
            }

            existing = self.search([("device_id", "=", device_id)], limit=1)
            if existing:
                existing.write(vals)
            else:
                self.create(vals)
            upserted += 1

        _logger.info("Synced diagnostics for %s devices", upserted)
        return upserted
