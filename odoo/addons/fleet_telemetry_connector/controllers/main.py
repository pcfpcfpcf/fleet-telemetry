"""
Fleet Telemetry — web controller.

Exposes L4 connection URLs as a JS config file loaded by the dashboard.
auth=none so Odoo asset bundling works before login.
The API key is NOT exposed here — the dashboard fetches it after login via ORM.
"""
from odoo import http
from odoo.http import request


class FleetTelemetryController(http.Controller):

    @http.route("/fleet_telemetry/config.js", type="http", auth="none", methods=["GET"])
    def l4_config(self, **_kwargs):
        params = request.env["ir.config_parameter"].sudo()
        base_url = params.get_param(
            "fleet_telemetry_connector.l4_base_url", "http://localhost:3000"
        ).rstrip("/")
        ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://")
        ws_url = ws_url.replace(":3000", ":3001")
        js = (
            f"window.__fleet_api_url__ = {repr(base_url)};\n"
            f"window.__fleet_ws_url__  = {repr(ws_url)};\n"
        )
        return request.make_response(
            js,
            headers=[
                ("Content-Type", "application/javascript; charset=utf-8"),
                ("Cache-Control", "no-cache, no-store"),
            ],
        )
