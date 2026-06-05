{
    "name": "Fleet Telemetry Connector",
    "version": "17.0.4.0.0",
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
            # External libs MUST load before dashboard.js so L and Chart are defined
            "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js",
            "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
            "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
            "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css",
            "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css",
            "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js",
            # L4 connection config
            "fleet_telemetry_connector/static/src/js/fleet_config.js",
            # Owl components
            "fleet_telemetry_connector/static/src/xml/dashboard.xml",
            "fleet_telemetry_connector/static/src/js/dashboard.js",
            "fleet_telemetry_connector/static/src/xml/asset_detail.xml",
            "fleet_telemetry_connector/static/src/js/asset_detail.js",
            # Styles
            "fleet_telemetry_connector/static/src/scss/dashboard.scss",
        ],
    },
    "installable": True,
    "application": True,
    "auto_install": False,
}
