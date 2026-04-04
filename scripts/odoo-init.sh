#!/usr/bin/env bash
set -u

if [ ! -f /var/lib/odoo/.initialized ]; then
  for attempt in $(seq 1 30); do
    echo "Initializing Odoo database (attempt ${attempt})..."
    if odoo -d odoo --init=base --stop-after-init; then
      touch /var/lib/odoo/.initialized
      echo "Init complete."
      exit 0
    fi
    echo "Odoo init failed, retrying in 5 seconds..."
    sleep 5
  done

  echo "Odoo init failed after retries."
  exit 1
fi

echo "Already initialized, skipping."