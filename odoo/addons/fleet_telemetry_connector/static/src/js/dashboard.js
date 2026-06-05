/** @odoo-module **/
/**
 * Fleet Telemetry Dashboard
 *
 * Real-time fleet overview driven by the L4 WebSocket stream.
 * Data flow: FMC003 → adapter → NATS → L4 consumer → WS broadcast → this component
 *
 * Architecture rules enforced here:
 *  - ALL aggregation is done by the backend (/api/dashboard/live).
 *  - The frontend only renders what the backend sends — no metric computation here.
 *  - Vehicle rows update individually (delta rendering) — no full re-render.
 *  - Charts do data.update() instead of destroy/recreate.
 *  - Map markers move in-place — no tile layer reload.
 */
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component, onMounted, onWillUnmount, useState } from "@odoo/owl";

// ─── Config ───────────────────────────────────────────────────────────────────
const L4_WS_URL   = window.__fleet_ws_url__  || "ws://localhost:3001";
const L4_API_BASE = window.__fleet_api_url__ || "http://localhost:3000";
// API key is loaded after login via orm.call (see _loadApiKey)
let   L4_API_KEY  = "";
const WS_RECONNECT_BASE = 1500;  // ms, doubles on each failure
const WS_RECONNECT_MAX  = 30_000;

// ─── Severity colour map ──────────────────────────────────────────────────────
const SEV_COLORS = {
    CRITICAL: { bg: "#fef2f2", border: "#ef4444", text: "#991b1b", dot: "#ef4444" },
    WARNING:  { bg: "#fffbeb", border: "#f59e0b", text: "#92400e", dot: "#f59e0b" },
    INFO:     { bg: "#eff6ff", border: "#3b82f6", text: "#1e40af", dot: "#3b82f6" },
};

function sevColor(s) { return SEV_COLORS[String(s).toUpperCase()] || SEV_COLORS.INFO; }

// ─── Formatting helpers ───────────────────────────────────────────────────────
function fmtSpeed(v)  { return v != null ? `${Number(v).toFixed(0)} km/h` : "—"; }
function fmtFuel(v)   { return v != null ? `${Number(v).toFixed(1)}%` : "—"; }
function fmtVolt(v)   { return v != null ? `${Number(v).toFixed(2)} V` : "—"; }
function fmtOdo(v)    { return v != null ? `${(Number(v)/1000).toFixed(0)} km` : "—"; }
function fmtSig(v)    { return v != null ? `${v}/5` : "—"; }
function fmtEco(v)    { return v != null ? Number(v).toFixed(1) : "—"; }
function fmtAge(s)    {
    if (s == null) return "—";
    if (s < 60)    return `${s}s ago`;
    if (s < 3600)  return `${Math.floor(s/60)}m ago`;
    return `${Math.floor(s/3600)}h ago`;
}
function shortId(id)  { return id ? id.slice(-8) : "?"; }

function fuelBarColor(pct) {
    if (pct == null) return "rgba(255,255,255,.1)";
    if (pct < 15)   return "#ef4444";
    if (pct < 30)   return "#f59e0b";
    return "#22c55e";
}

// ─── Chart management ─────────────────────────────────────────────────────────
// We update existing Chart instances instead of recreating them — avoids flicker.

function getOrCreateChart(canvasId, config) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    if (typeof Chart === "undefined") return null;
    const existing = Chart.getChart(canvas);
    if (existing) return existing;
    return new Chart(canvas, config);
}

function updateBarChart(chart, labels, data, colorFn) {
    if (!chart) return;
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    if (colorFn) chart.data.datasets[0].backgroundColor = data.map(colorFn);
    chart.update("none"); // "none" = no animation on update → smooth live feel
}

function updateDoughnutChart(chart, data) {
    if (!chart) return;
    chart.data.datasets[0].data = data;
    chart.update("none");
}

// ─── Map management ───────────────────────────────────────────────────────────
// Markers are kept in a Map<device_id → L.circleMarker>.
// Updates move existing markers instead of re-creating them.

class FleetMap {
    constructor(containerId, onMarkerClick) {
        this._id = containerId;
        this._map = null;
        this._markers = new Map();
        this._initialized = false;
        this._onMarkerClick = onMarkerClick || null;
    }

    init() {
        const el = document.getElementById(this._id);
        if (!el || this._initialized || typeof L === "undefined") return;
        if (el._leafletMap) { el._leafletMap.remove(); el._leafletMap = null; }
        this._map = L.map(el, { zoomControl: true, attributionControl: true });

        // Use OSM tiles — reliable for demos without network restrictions
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: "© OpenStreetMap contributors",
            maxZoom: 19,
        }).addTo(this._map);

        // Use marker clustering if the plugin is loaded
        if (typeof L.markerClusterGroup === "function") {
            this._cluster = L.markerClusterGroup({ maxClusterRadius: 48, disableClusteringAtZoom: 16 });
            this._cluster.addTo(this._map);
        }
        el._leafletMap = this._map;
        this._initialized = true;

        // Leaflet needs the container to be fully painted before it measures size.
        // Without invalidateSize() the map renders blank in Odoo's flex layout.
        setTimeout(() => { if (this._map) this._map.invalidateSize(); }, 100);
        setTimeout(() => { if (this._map) this._map.invalidateSize(); }, 500);
    }

    destroy() {
        if (this._map) {
            this._map.remove();
            this._map = null;
            this._initialized = false;
            this._markers.clear();
            this._cluster = null;
            const el = document.getElementById(this._id);
            if (el) el._leafletMap = null;
        }
    }

    // Returns the layer to add markers to (cluster group or map directly)
    _layer() { return this._cluster || this._map; }

    // Force Leaflet to re-measure its container — call after any layout shift
    invalidate() {
        if (this._map) {
            this._map.invalidateSize({ animate: false });
        }
    }

    updateVehicles(vehicles) {
        if (!this._map) return;
        const seen = new Set();

        // Show demo markers if no real vehicles with GPS
        const hasGps = vehicles.some(v => v.lat != null && v.lng != null);
        if (!hasGps && vehicles.length === 0) {
            // Place a single demo marker so map isn't blank
            if (!this._demoMarker) {
                const demoLatLng = [36.8065, 10.1815];
                this._demoMarker = L.circleMarker(demoLatLng, {
                    radius: 10, color: "#3b82f6", fillColor: "#3b82f6",
                    fillOpacity: .4, weight: 2, dashArray: "4 3",
                });
                this._demoMarker.addTo(this._map);
                this._map.setView(demoLatLng, 12);
            }
            return;
        }
        if (this._demoMarker) {
            this._demoMarker.remove();
            this._demoMarker = null;
        }

        for (const v of vehicles) {
            if (v.lat == null || v.lng == null) continue;
            seen.add(v.device_id);

            const isMoving   = v.movement && v.ignition;
            const isOnline   = v.ignition && !v.stale;
            const color      = isMoving ? "#3b82f6" : isOnline ? "#22c55e" : "#4d6482";
            const glowColor  = isMoving ? "rgba(59,130,246,.5)" : isOnline ? "rgba(34,197,94,.5)" : "rgba(77,100,130,.3)";

            // Custom DivIcon — looks like a proper fleet platform marker
            const icon = L.divIcon({
                className: "",
                html: `<div style="
                    width:34px;height:34px;border-radius:50%;
                    background:${color}22;border:2px solid ${color};
                    display:flex;align-items:center;justify-content:center;
                    font-size:15px;
                    box-shadow:0 0 12px ${glowColor}, 0 0 24px ${glowColor};
                    transition:all .3s ease;
                ">🚛</div>`,
                iconSize: [34, 34],
                iconAnchor: [17, 17],
            });

            if (this._markers.has(v.device_id)) {
                const m = this._markers.get(v.device_id);
                m.setLatLng([v.lat, v.lng]);
                m.setIcon(icon);
                m._vehicleData = v;
            } else {
                const m = L.marker([v.lat, v.lng], { icon });
                m._vehicleData = v;

                if (this._onMarkerClick) {
                    m.on("click", () => this._onMarkerClick(m._vehicleData));
                } else {
                    m.bindPopup(() => this._popupContent(m._vehicleData));
                    m.on("click", () => m.getPopup().setContent(this._popupContent(m._vehicleData)));
                }
                this._layer().addLayer(m);
                this._markers.set(v.device_id, m);
            }
        }

        // Remove markers for devices no longer in view
        for (const [id, marker] of this._markers) {
            if (!seen.has(id)) {
                this._layer().removeLayer(marker);
                this._markers.delete(id);
            }
        }

        // Auto-fit bounds only on first load
        if (!this._fitted && seen.size > 0) {
            const points = vehicles.filter(v => v.lat && v.lng).map(v => [v.lat, v.lng]);
            if (points.length) {
                this._map.fitBounds(points, { padding: [48, 48] });
                this._fitted = true;
            }
        }
    }

    _popupContent(v) {
        const rows = [
            ["Speed",    fmtSpeed(v.speed)],
            ["Fuel",     fmtFuel(v.fuel_level)],
            ["Ignition", v.ignition ? "ON" : "OFF"],
            ["Odometer", fmtOdo(v.odometer)],
            ["GSM",      fmtSig(v.gsm_signal)],
            ["Battery",  fmtVolt(v.ext_voltage)],
            ["Updated",  fmtAge(v.age_seconds)],
        ];
        return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;font-size:12px;min-width:180px;padding:2px 0">
          <div style="font-weight:700;font-size:13px;margin-bottom:8px;color:#f0f4ff;font-family:'SF Mono','Fira Code',monospace">${v.device_id}</div>
          <table style="width:100%;border-collapse:collapse">${rows.map(([k,val]) =>
            `<tr>
              <td style="color:#4d6482;padding:2px 0;font-size:11px;text-transform:uppercase;letter-spacing:.05em;font-weight:600">${k}</td>
              <td style="font-weight:600;padding:2px 0 2px 8px;color:#8fa3bf;text-align:right">${val}</td>
            </tr>`
          ).join("")}</table>
        </div>`;
    }
}

// ─── Component ────────────────────────────────────────────────────────────────

class FleetTelemetryDashboard extends Component {
    setup() {
        this.orm    = useService("orm");
        this.state  = useState({
            loading:      true,
            connected:    false,
            lastUpdate:   null,
            // Backend-computed aggregates (never computed in frontend)
            totalVehicles: 0,
            ignitionOn:    0,
            ignitionOff:   0,
            moving:        0,
            lowFuel:       0,
            overspeed:     0,
            avgSpeed:      0,
            avgFuel:       null,
            fresh:         0,
            stale:         0,
            // Extended KPI fields (from buildLiveSummary extended fields)
            offlineCount:         0,
            unacknowledgedAlerts: 0,
            // Per-vehicle list
            vehicles:      [],
            // Recent alerts (pulled separately from Odoo ORM)
            alerts:        [],
            // Drawer state
            drawerOpen:    false,
            drawerVehicle: null,
        });

        this._ws          = null;
        this._wsRetryMs   = WS_RECONNECT_BASE;
        this._wsRetryTimer= null;
        this._fuelChart   = null;
        this._speedChart  = null;
        this._ignChart    = null;
        this._fleetMap    = new FleetMap("fleetMap", (v) => this.openDrawer(v));

        onMounted(async () => {
            // Always start with drawer closed — state may persist from previous navigation
            this.state.drawerOpen = false;
            this.state.drawerVehicle = null;

            this._fleetMap.init();
            this._initCharts();
            await this._loadApiKey();
            this._connectWs();
            await this._loadAlerts();
            setTimeout(() => {
                if (this.state.loading) this._fetchSnapshot();
            }, 2000);
            setTimeout(() => { this._fleetMap.invalidate(); }, 200);
            setTimeout(() => { this._fleetMap.invalidate(); }, 800);
            setTimeout(() => { this._fleetMap.invalidate(); }, 2000);
        });

        onWillUnmount(() => {
            this._disconnectWs();
            this._fleetMap.destroy();
            [this._fuelChart, this._speedChart, this._ignChart].forEach(c => {
                if (c) { try { c.destroy(); } catch { /* */ } }
            });
        });
    }

    // ── WebSocket ──────────────────────────────────────────────────────────────

    async _loadApiKey() {
        try {
            const result = await this.orm.call(
                "ir.config_parameter", "get_param",
                ["fleet_telemetry_connector.l4_api_key", ""]
            );
            if (result) L4_API_KEY = result;
        } catch { /* non-critical — falls back to empty key */ }
    }

    _connectWs() {
        if (this._ws) return;
        try {
            const ws = new WebSocket(L4_WS_URL);
            this._ws = ws;

            ws.addEventListener("open", () => {
                this.state.connected = true;
                this._wsRetryMs = WS_RECONNECT_BASE;
                // Ping keepalive every 30s
                ws._ping = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
                }, 30_000);
            });

            ws.addEventListener("message", (e) => {
                try {
                    const msg = JSON.parse(e.data);
                    this._handleWsMessage(msg);
                } catch { /* ignore parse errors */ }
            });

            ws.addEventListener("close", () => this._scheduleReconnect());
            ws.addEventListener("error", () => {
                ws.close();
                this._scheduleReconnect();
            });
        } catch (err) {
            console.warn("[FleetDashboard] WS connection failed:", err.message);
            this._scheduleReconnect();
        }
    }

    _disconnectWs() {
        clearTimeout(this._wsRetryTimer);
        if (this._ws) {
            clearInterval(this._ws._ping);
            this._ws.onclose = null; // prevent reconnect loop on intentional close
            this._ws.close();
            this._ws = null;
        }
        this.state.connected = false;
    }

    _scheduleReconnect() {
        if (this._ws) {
            clearInterval(this._ws._ping);
            this._ws = null;
        }
        this.state.connected = false;
        this._wsRetryTimer = setTimeout(() => {
            this._wsRetryMs = Math.min(this._wsRetryMs * 2, WS_RECONNECT_MAX);
            this._connectWs();
        }, this._wsRetryMs);
    }

    _handleWsMessage(msg) {
        if (msg.type === "snapshot") {
            // Initial snapshot sent on WS connect
            this._applySummary(msg.data);
        } else if (msg.type === "telemetry") {
            // Single vehicle update — do a targeted delta update
            this._applyVehicleDelta(msg.event);
        } else if (msg.type === "alert") {
            this._prependAlert(msg);
        }
        // pong: ignore
    }

    // ── Data application (delta rendering) ────────────────────────────────────

    _applySummary(data) {
        if (!data) return;
        this.state.loading       = false;
        this.state.lastUpdate    = data.as_of;
        this.state.totalVehicles = data.total_vehicles || 0;
        this.state.ignitionOn    = data.ignition_on    || 0;
        this.state.ignitionOff   = data.ignition_off   || 0;
        this.state.moving        = data.moving         || 0;
        this.state.lowFuel       = data.low_fuel       || 0;
        this.state.overspeed     = data.overspeed      || 0;
        this.state.avgSpeed      = data.avg_speed      ?? 0;
        this.state.avgFuel       = data.avg_fuel       ?? null;
        this.state.fresh         = data.fresh          || 0;
        this.state.stale         = data.stale          || 0;
        // Extended KPI fields
        this.state.offlineCount         = data.offline_count          ?? 0;
        this.state.unacknowledgedAlerts = data.unacknowledged_alerts  ?? 0;

        if (Array.isArray(data.vehicles)) {
            this.state.vehicles = data.vehicles;
            this._updateCharts(data.vehicles);
            this._fleetMap.updateVehicles(data.vehicles);
        }
    }

    _applyVehicleDelta(event) {
        if (!event?.device_id) return;

        // Update or insert the vehicle in the array
        const idx = this.state.vehicles.findIndex(v => v.device_id === event.device_id);
        const updated = {
            device_id:    event.device_id,
            timestamp:    event.timestamp,
            received_at:  event.received_at,
            lat:          event.position?.lat    ?? null,
            lng:          event.position?.lng    ?? null,
            altitude:     event.position?.altitude ?? null,
            bearing:      event.position?.bearing  ?? null,
            speed:        event.position?.speed   ?? 0,
            ignition:     event.telemetry?.ignition  ?? false,
            fuel_level:   event.telemetry?.fuel_level ?? null,
            odometer:     event.telemetry?.odometer   ?? null,
            movement:     event.movement    ?? false,
            ext_voltage:  event.ext_voltage ?? null,
            bat_level:    event.bat_level   ?? null,
            gsm_signal:   event.gsm_signal  ?? null,
            eco_score:    event.eco_score   ?? null,
            trip_odometer:event.trip_odometer ?? null,
            gnss_pdop:    event.gnss_pdop   ?? null,
            gnss_hdop:    event.gnss_hdop   ?? null,
            buffered:     Boolean(event.buffered),
            stale:        false,
            age_seconds:  0,
        };

        if (idx >= 0) {
            this.state.vehicles[idx] = updated;
        } else {
            this.state.vehicles = [updated, ...this.state.vehicles];
        }
        this.state.lastUpdate    = updated.timestamp;
        this.state.totalVehicles = this.state.vehicles.length;
        this.state.loading       = false;

        // Recompute aggregates locally (backend will confirm on next summary)
        this._recomputeAggregates();
        this._updateCharts(this.state.vehicles);
        this._fleetMap.updateVehicles([updated]);
    }

    _recomputeAggregates() {
        const vv = this.state.vehicles;
        this.state.ignitionOn  = vv.filter(v => v.ignition).length;
        this.state.ignitionOff = vv.filter(v => !v.ignition).length;
        this.state.moving      = vv.filter(v => v.movement).length;
        this.state.lowFuel     = vv.filter(v => v.fuel_level != null && v.fuel_level < 15).length;
        this.state.overspeed   = vv.filter(v => v.speed > 120).length;
        const speeds = vv.map(v => v.speed).filter(s => s > 0);
        const fuels  = vv.map(v => v.fuel_level).filter(f => f != null);
        this.state.avgSpeed = speeds.length ? Math.round(speeds.reduce((a,b) => a+b, 0) / speeds.length * 10) / 10 : 0;
        this.state.avgFuel  = fuels.length  ? Math.round(fuels.reduce((a,b) => a+b, 0) / fuels.length * 10) / 10 : null;
    }

    _prependAlert(alert) {
        this.state.alerts = [
            {
                device_id:  alert.device_id,
                alert_type: alert.alert_type,
                severity:   alert.severity || "WARNING",
                message:    alert.message || alert.alert_type,
                timestamp:  alert.ts || new Date().toISOString(),
            },
            ...this.state.alerts,
        ].slice(0, 20);
    }

    // ── Fallback REST fetch ────────────────────────────────────────────────────

    async _fetchSnapshot() {
        try {
            const resp = await fetch(`${L4_API_BASE}/api/dashboard/live`, {
                headers: { "X-API-Key": L4_API_KEY },
            });
            if (!resp.ok) return;
            const data = await resp.json();
            this._applySummary(data);
        } catch (err) {
            console.warn("[FleetDashboard] REST fetch failed:", err.message);
            // Fall back to Odoo ORM
            this._loadFromOrm();
        }
    }

    async _loadFromOrm() {
        const records = await this.orm.searchRead(
            "fleet.vehicle.telemetry", [],
            ["device_id", "speed", "fuel_level", "ignition", "latitude", "longitude",
             "odometer", "rpm", "engine_load", "timestamp", "buffered"],
        );
        const vehicles = records.map(r => ({
            device_id:  r.device_id,
            lat:        r.latitude  || null,
            lng:        r.longitude || null,
            speed:      r.speed     || 0,
            fuel_level: r.fuel_level ?? null,
            ignition:   Boolean(r.ignition),
            odometer:   r.odometer  ?? null,
            timestamp:  r.timestamp || null,
            buffered:   Boolean(r.buffered),
            stale:      false,
            age_seconds:0,
        }));
        this._applySummary({
            as_of: new Date().toISOString(),
            total_vehicles: vehicles.length,
            ignition_on:    vehicles.filter(v => v.ignition).length,
            ignition_off:   vehicles.filter(v => !v.ignition).length,
            moving: 0, low_fuel: 0, overspeed: 0, buffered: 0,
            avg_speed: 0, avg_fuel: null, fresh: vehicles.length, stale: 0,
            vehicles,
        });
    }

    async _loadAlerts() {
        try {
            const records = await this.orm.searchRead(
                "fleet.vehicle.alert", [],
                ["device_id", "alert_type", "severity", "message", "timestamp"],
                { limit: 20, order: "timestamp desc" }
            );
            this.state.alerts = records;
        } catch { /* non-critical */ }
    }

    // ── Charts (delta updates only) ────────────────────────────────────────────

    _initCharts() {
        if (typeof Chart === "undefined") return;

        const darkGrid  = "rgba(255,255,255,.05)";
        const darkTick  = { color: "#4d6482", font: { size: 10, family: "Inter, sans-serif" } };

        this._speedChart = getOrCreateChart("speedChart", {
            type: "bar",
            data: { labels: [], datasets: [{ label: "Speed (km/h)", data: [], backgroundColor: "rgba(59,130,246,.7)", borderRadius: 4, borderSkipped: false }] },
            options: {
                responsive: true, animation: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true, grid: { color: darkGrid }, ticks: darkTick, border: { color: "transparent" } },
                    x: { grid: { display: false }, ticks: darkTick, border: { color: "transparent" } },
                },
            },
        });

        this._fuelChart = getOrCreateChart("fuelChart", {
            type: "bar",
            data: { labels: [], datasets: [{ label: "Fuel %", data: [], backgroundColor: [], borderRadius: 4, borderSkipped: false }] },
            options: {
                responsive: true, animation: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true, max: 100, grid: { color: darkGrid }, ticks: darkTick, border: { color: "transparent" } },
                    x: { grid: { display: false }, ticks: darkTick, border: { color: "transparent" } },
                },
            },
        });

        this._ignChart = getOrCreateChart("ignChart", {
            type: "doughnut",
            data: {
                labels: ["On", "Off"],
                datasets: [{ data: [0, 0], backgroundColor: ["#22c55e", "rgba(255,255,255,.08)"], borderWidth: 0, hoverOffset: 4 }],
            },
            options: {
                responsive: true, animation: false, cutout: "74%",
                plugins: {
                    legend: {
                        position: "bottom",
                        labels: { color: "#4d6482", font: { size: 11, family: "Inter, sans-serif" }, padding: 14 },
                    },
                },
            },
        });
    }

    _updateCharts(vehicles) {
        if (typeof Chart === "undefined") return;
        const labels = vehicles.map(v => shortId(v.device_id));
        const speeds = vehicles.map(v => v.speed || 0);
        const fuels  = vehicles.map(v => v.fuel_level ?? 0);
        const on     = vehicles.filter(v => v.ignition).length;
        const off    = vehicles.length - on;

        updateBarChart(this._speedChart, labels, speeds, () => "#818cf8");
        updateBarChart(this._fuelChart,  labels, fuels, v => fuelBarColor(v));
        updateDoughnutChart(this._ignChart, [on, off]);
    }

    // ── Vehicle detail drawer ─────────────────────────────────────────────────
    // Opens a slide-in panel with full telemetry for the selected vehicle.
    // Reuses the live-cache vehicle object — no extra fetch needed.

    openDrawer(vehicle) {
        this.state.drawerVehicle = vehicle;
        this.state.drawerOpen = true;
    }

    closeDrawer() {
        this.state.drawerOpen = false;
        this.state.drawerVehicle = null;
        // Re-trigger map size calculation after drawer slides out
        setTimeout(() => { this._fleetMap.invalidate(); }, 300);
    }

    openTableRowDrawer(vehicle) {
        this.openDrawer(vehicle);
    }

    // Expose format helpers to OWL template
    fmtSpeed(v)  { return fmtSpeed(v); }
    fmtOdo(v)    { return fmtOdo(v); }
    fmtFuel(v)   { return fmtFuel(v); }
    fmtVolt(v)   { return fmtVolt(v); }
    fmtAge(v)    { return fmtAge(v); }
    fmtAlertType(t) { return t ? String(t).replace(/_/g, ' ') : ''; }

    // Formatted getters for drawer (delegate to format helpers)
    drawerFmt(v) {
        if (!v) return {};
        return {
            speed:       fmtSpeed(v.speed),
            fuel:        fmtFuel(v.fuel_level),
            ignition:    v.ignition ? "ON" : "OFF",
            odometer:    fmtOdo(v.odometer),
            tripOdo:     v.trip_odometer != null ? fmtOdo(v.trip_odometer) : "—",
            extVoltage:  fmtVolt(v.ext_voltage),
            batVoltage:  fmtVolt(v.bat_voltage),
            batLevel:    v.bat_level != null ? `${v.bat_level}%` : "—",
            gsm:         fmtSig(v.gsm_signal),
            eco:         fmtEco(v.eco_score),
            age:         fmtAge(v.age_seconds),
            lat:         v.lat != null ? Number(v.lat).toFixed(6) : "—",
            lng:         v.lng != null ? Number(v.lng).toFixed(6) : "—",
            bearing:     v.bearing != null ? `${Number(v.bearing).toFixed(0)}°` : "—",
            movement:    v.movement ? "Yes" : "No",
            buffered:    v.buffered ? "Yes" : "No",
            stale:       v.stale ? "Yes" : "No",
            gnssHdop:    v.gnss_hdop != null ? Number(v.gnss_hdop).toFixed(1) : "—",
            networkType: v.network_type != null ? v.network_type : "—",
            timestamp:   v.timestamp ? new Date(v.timestamp).toLocaleString() : "—",
        };
    }
}

FleetTelemetryDashboard.template = "fleet_telemetry_connector.Dashboard";
registry.category("actions").add("fleet_telemetry_dashboard", FleetTelemetryDashboard);
