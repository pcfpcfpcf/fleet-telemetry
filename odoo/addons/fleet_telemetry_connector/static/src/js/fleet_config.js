/**
 * fleet_config.js
 *
 * Exposes L4 service connection URLs as browser globals so dashboard.js
 * can connect without hard-coded values.
 *
 * Override these at deployment time by injecting a different config.js
 * via a reverse proxy or environment-specific build step.
 *
 * Defaults work for local `docker compose up` where:
 *   - Odoo is reached at http://localhost:8069
 *   - L4 service API is at http://localhost:3000
 *   - L4 service WebSocket is at ws://localhost:3001
 */
window.__fleet_api_url__ = window.__fleet_api_url__ || "http://localhost:3000";
window.__fleet_ws_url__  = window.__fleet_ws_url__  || "ws://localhost:3001";
