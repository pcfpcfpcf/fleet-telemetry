#!/usr/bin/env bash
set -u

for attempt in $(seq 1 30); do
  echo "Installing Odoo connector module (attempt ${attempt})..."
  if odoo -d "${ODOO_DB:-odoo}" \
    -i fleet_telemetry_connector \
    -u fleet_telemetry_connector \
    --without-demo=all \
    --stop-after-init; then
    exit 0
  fi
  echo "Odoo module init failed, retrying in 5 seconds..."
  sleep 5
done

echo "Odoo module init failed after retries."
exit 1