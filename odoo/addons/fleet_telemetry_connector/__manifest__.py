{
    "name": "Fleet Telemetry Connector",
    "version": "17.0.1.0.3",
    "summary": "Display real-time fleet telemetry from L4 service",
    "category": "Fleet",
    "author": "Fleet Telemetry Platform",
    "license": "LGPL-3",
    "depends": ["base", "web", "fleet"],
    "data": [
        "security/ir.model.access.csv",
        "views/fleet_vehicle_telemetry_views.xml",
        "views/res_config_settings_views.xml",
        "data/ir_cron.xml",
        "views/fleet_vehicle_alert_views.xml"
    ],
    "assets": {
        "web.assets_backend": [
            "fleet_telemetry_connector/static/src/xml/dashboard.xml",
            "fleet_telemetry_connector/static/src/js/dashboard.js",
            "fleet_telemetry_connector/static/src/scss/dashboard.scss",
            "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js",
            "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
            "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
        ],
    },
    "installable": True,
    "application": True,
}
