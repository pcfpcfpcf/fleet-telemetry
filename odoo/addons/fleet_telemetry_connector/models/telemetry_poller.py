"""
Background poller that calls sync_from_l4() every 15 seconds.

Odoo's ir.cron has a hard minimum interval of 1 minute.
This module spawns a daemon thread at server startup that
runs the sync in its own cursor/environment, independent
of the cron scheduler.
"""

import logging
import threading
import time

import odoo
from odoo import api

_logger = logging.getLogger(__name__)

POLL_INTERVAL = 15  # seconds


class TelemetryPoller(threading.Thread):
    daemon = True  # killed when Odoo shuts down

    def __init__(self, db_name):
        super().__init__(name="telemetry-poller")
        self.db_name = db_name

    def run(self):
        _logger.info(
            "Telemetry poller started — syncing every %s seconds (db=%s)",
            POLL_INTERVAL, self.db_name,
        )
        # Give Odoo a moment to finish booting
        time.sleep(10)

        while True:
            try:
                registry = odoo.registry(self.db_name)
                with registry.cursor() as cr:
                    env = api.Environment(cr, odoo.SUPERUSER_ID, {})
                    env["fleet.vehicle.telemetry"].sync_from_l4()
                    cr.commit()
            except Exception:
                _logger.exception("Telemetry poller error")
            time.sleep(POLL_INTERVAL)


_poller_started = False
_poller_lock = threading.Lock()


def start_poller(db_name):
    """Start the poller exactly once per process."""
    global _poller_started
    with _poller_lock:
        if _poller_started:
            return
        _poller_started = True
    poller = TelemetryPoller(db_name)
    poller.start()
