from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    fleet_l4_base_url = fields.Char(
        string="Fleet L4 Base URL",
        config_parameter="fleet_telemetry_connector.l4_base_url",
        default="http://l4-service:3000",
    )
