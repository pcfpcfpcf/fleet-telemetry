#!/bin/bash
# Odoo module initialisation script.
# Runs inside the odoo-module-init container.
# 1. Installs / upgrades fleet_telemetry_connector (and all dependencies).
# 2. Sets web.base.url so login redirects work from the host browser.
set -e

DB="${ODOO_DB:-odoo}"
ODOO_PG_HOST="${HOST:-odoo-db}"
ODOO_PG_PORT="${PORT:-5432}"
ODOO_PG_USER="${USER:-odoo}"
ODOO_PG_PASS="${PASSWORD:-odoo}"

echo "[module-init] Installing fleet_telemetry_connector into database: $DB"
odoo --config=/etc/odoo/odoo.conf \
     -d "$DB" \
     -i fleet_telemetry_connector \
     --without-demo=all \
     --stop-after-init

echo "[module-init] Setting web.base.url..."
python3 - <<PYEOF
import psycopg2, os

conn = psycopg2.connect(
    host="${ODOO_PG_HOST}",
    port=${ODOO_PG_PORT},
    dbname="${DB}",
    user="${ODOO_PG_USER}",
    password="${ODOO_PG_PASS}",
)
cur = conn.cursor()
cur.execute("""
    INSERT INTO ir_config_parameter (key, value)
    VALUES ('web.base.url', 'http://localhost:8069')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
""")
conn.commit()
cur.close()
conn.close()
print("[module-init] web.base.url = http://localhost:8069")
PYEOF

echo "[module-init] All done."
