from . import models


def _start_telemetry_poller(env):
    """post_init_hook: start the 15-second background poller."""
    from .models.telemetry_poller import start_poller
    start_poller(env.cr.dbname)
