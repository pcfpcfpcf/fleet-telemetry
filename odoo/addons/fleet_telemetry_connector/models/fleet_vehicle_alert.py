from odoo import models, fields, api

class FleetVehicleAlert(models.Model):
    _name = 'fleet.vehicle.alert'
    _description = 'Fleet Vehicle Alert'
    _order = 'timestamp desc'

    device_id = fields.Char(string='Device ID', required=True)
    alert_type = fields.Char(string='Alert Type')
    severity = fields.Selection([
        ('low', 'Low'),
        ('medium', 'Medium'),
        ('high', 'High'),
        ('critical', 'Critical')
    ], string='Severity', default='medium')
    message = fields.Text(string='Message')
    timestamp = fields.Datetime(string='Timestamp', default=fields.Datetime.now)