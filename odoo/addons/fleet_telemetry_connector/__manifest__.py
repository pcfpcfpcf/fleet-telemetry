{
    "name": "Fleet Telemetry Connector",
    "version": "17.0.3.0.0",
    "summary": "FMC003 real-time telemetry cockpit — WebSocket live dashboard, full field extraction",
    "description": """
        Real-time fleet telemetry powered by the L4 WebSocket stream.
        - Live dashboard with <2s latency, delta rendering, no page refresh
        - All FMC003 fields: speed, fuel, ignition, odometer, voltage, GSM signal, eco score, GNSS
        - Backend aggregation: all KPIs computed server-side
        - Asset Detail, diagnostics, alerts, history
    """,
    "category": "Fleet",
    "author": "Fleet Telemetry Platform",
    "license": "LGPL-3",
    "depends": ["base", "web", "mail", "fleet"],
    "data": [
        "security/ir.model.access.csv",
        "views/fleet_vehicle_telemetry_views.xml",
        "views/fleet_vehicle_alert_views.xml",
        "views/fleet_vehicle_diagnostics_views.xml",
        "views/res_config_settings_views.xml",
        "data/ir_cron.xml",
    ],
    "assets": {
        "web.assets_backend": [
            # L4 connection config — must load before dashboard.js
            "/fleet_telemetry/config.js",
            # Owl components
            "fleet_telemetry_connector/static/src/xml/dashboard.xml",
            "fleet_telemetry_connector/static/src/js/dashboard.js",
            "fleet_telemetry_connector/static/src/xml/asset_detail.xml",
            "fleet_telemetry_connector/static/src/js/asset_detail.js",
            # Styles
            "fleet_telemetry_connector/static/src/scss/dashboard.scss",
            # External libs (pinned versions)
            "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js",
            "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
            "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
        ],
    },
    "installable": True,
    "application": True,
    "auto_install": False,
}
