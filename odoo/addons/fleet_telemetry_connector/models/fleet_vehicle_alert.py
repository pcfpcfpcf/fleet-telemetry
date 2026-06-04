"""
FleetVehicleAlert — alert records synced from the L4 service.

Alerts are read from /api/vehicles/:deviceId/alerts.
This model is append-only from the sync perspective;
acknowledgement is managed in TimescaleDB and reflected here on the next sync.
"""
from odoo import models, fields


class FleetVehicleAlert(models.Model):
    _name = "fleet.vehicle.alert"
    _description = "Fleet Vehicle Alert"
    _order = "timestamp desc"

    # ── Identity ──────────────────────────────────────────────────────────────
    alert_id = fields.Char(string="Alert ID (L4)", index=True)
    device_id = fields.Char(string="Device ID", required=True, index=True)

    # ── Classification ────────────────────────────────────────────────────────
    alert_type = fields.Char(string="Alert Type")
    severity = fields.Selection(
        [
            ("INFO", "Info"),
            ("WARNING", "Warning"),
            ("CRITICAL", "Critical"),
        ],
        string="Severity",
        default="WARNING",
    )
    message = fields.Text(string="Message")

    # ── Timing ────────────────────────────────────────────────────────────────
    timestamp = fields.Datetime(string="Triggered At", default=fields.Datetime.now)

    # ── Acknowledgement ───────────────────────────────────────────────────────
    acknowledged = fields.Boolean(string="Acknowledged", default=False)
    acknowledged_at = fields.Datetime(string="Acknowledged At")

    # ── Position at time of alert ─────────────────────────────────────────────
    position_lat = fields.Float(string="Latitude", digits=(10, 6))
    position_lng = fields.Float(string="Longitude", digits=(10, 6))

    # ── Linked telemetry event ────────────────────────────────────────────────
    event_id = fields.Char(string="Telemetry Event ID")

    # ── Arbitrary extra context from TimescaleDB ───────────────────────────────
    metadata = fields.Text(string="Metadata (JSON)")
