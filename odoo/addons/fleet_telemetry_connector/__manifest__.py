{
    "name": "Fleet Telemetry Connector",
    "version": "17.0.1.0.0",
    "summary": "Display real-time fleet telemetry from L4 service",
    "category": "Fleet",
    "author": "Fleet Telemetry Platform",
    "license": "LGPL-3",
    "depends": ["base", "web"],
    "data": [
        "security/ir.model.access.csv",
        "views/fleet_vehicle_telemetry_views.xml",
        "views/res_config_settings_views.xml",
        "data/ir_cron.xml"
    ],
    "installable": True,
    "application": True,
}
