import json
import logging
from datetime import datetime
from urllib import error, request

from odoo import api, fields, models

_logger = logging.getLogger(__name__)



class FleetVehicleTelemetry(models.Model):
    _name = "fleet.vehicle.telemetry"
    _description = "Fleet Vehicle Telemetry"
    _rec_name = "device_id"

    def _check_alerts(self):
        Alert = self.env["fleet.vehicle.alert"]
        for rec in self:
            # Overspeed
            if rec.speed and rec.speed > 120:
                Alert.create({
                    "device_id": rec.device_id,
                    "alert_type": "overspeed",
                    "message": f"Overspeed detected: {rec.speed} km/h",
                    "severity": "high",
                })
            # Low fuel
            if rec.fuel_level is not None and rec.fuel_level < 15:
                Alert.create({
                    "device_id": rec.device_id,
                    "alert_type": "low_fuel",
                    "message": f"Low fuel: {rec.fuel_level}%",
                    "severity": "medium",
                })
            # Engine idle
            if rec.ignition and rec.speed is not None and rec.speed < 5:
                Alert.create({
                    "device_id": rec.device_id,
                    "alert_type": "idle_engine",
                    "message": "Engine ON but vehicle not moving",
                    "severity": "low",
                })
            # Invalid GPS
            if not rec.latitude or not rec.longitude:
                Alert.create({
                    "device_id": rec.device_id,
                    "alert_type": "invalid_gps",
                    "message": "Invalid GPS coordinates",
                    "severity": "high",
                })

    @api.model
    def create(self, vals):
        record = super().create(vals)
        record._check_alerts()
        return record

    device_id = fields.Char(required=True, index=True)
    latitude = fields.Float(digits=(10, 6))
    longitude = fields.Float(digits=(10, 6))
    speed = fields.Float()
    fuel_level = fields.Float()
    ignition = fields.Boolean()
    timestamp = fields.Datetime()
    payload = fields.Text()

    _sql_constraints = [
        ("fleet_vehicle_telemetry_device_unique", "unique(device_id)", "Device must be unique."),
    ]

    device_id = fields.Char(required=True, index=True)
    latitude = fields.Float(digits=(10, 6))
    longitude = fields.Float(digits=(10, 6))
    speed = fields.Float()
    fuel_level = fields.Float()
    ignition = fields.Boolean()
    timestamp = fields.Datetime()
    payload = fields.Text()

    _sql_constraints = [
        ("fleet_vehicle_telemetry_device_unique", "unique(device_id)", "Device must be unique."),
    ]

    @api.model
    def _l4_base_url(self):
        return (
            self.env["ir.config_parameter"].sudo().get_param(
                "fleet_telemetry_connector.l4_base_url", "http://l4-service:3000"
            )
        ).rstrip("/")

    @api.model
    def _fetch_vehicles(self):
        url = f"{self._l4_base_url()}/vehicles"
        req = request.Request(url, method="GET")
        try:
            with request.urlopen(req, timeout=10) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body)
        except error.URLError as exc:
            _logger.error("Failed to call L4 vehicles endpoint %s: %s", url, exc)
            return []
        except json.JSONDecodeError as exc:
            _logger.error("Invalid JSON from L4 vehicles endpoint %s: %s", url, exc)
            return []

    @api.model
    def sync_from_l4(self):
        vehicles = self._fetch_vehicles()
        if not isinstance(vehicles, list):
            _logger.warning("Unexpected /vehicles response type: %s", type(vehicles))
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
                "ignition": item.get("ignition") if item.get("ignition") is not None else False,
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

    def action_refresh_from_l4(self):
        self.sync_from_l4()
        return {
            "type": "ir.actions.client",
            "tag": "reload",
        }
        