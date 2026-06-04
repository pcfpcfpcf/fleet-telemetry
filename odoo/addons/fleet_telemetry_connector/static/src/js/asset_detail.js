/** @odoo-module **/
/**
 * Asset Detail Page
 *
 * Displays the full operational picture for a single FMC003 device:
 *   - Current State  : ignition, speed, fuel, odometer, engine load, RPM, timestamp
 *   - History        : speed trend chart, fuel trend chart
 *   - Timeline       : merged telemetry + alert activity feed
 *   - Alerts         : alert history with severity and timestamp
 *   - Diagnostics    : RPM, engine load, odometer, raw payload viewer
 *
 * Data flows: Odoo RPC → Python model → TelemetryApiClient → L4 service API.
 * This component never calls the L4 service directly.
 */
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component, onMounted, onWillUnmount, useState } from "@odoo/owl";

// ── Colour palette ─────────────────────────────────────────────────────────────
const SEVERITY_COLOR = {
    CRITICAL: { bg: "#fee2e2", text: "#991b1b", badge: "#ef4444" },
    WARNING:  { bg: "#fef3c7", text: "#92400e", badge: "#f59e0b" },
    INFO:     { bg: "#dbeafe", text: "#1e40af", badge: "#3b82f6" },
};

function severityColor(sev) {
    return SEVERITY_COLOR[String(sev).toUpperCase()] || SEVERITY_COLOR.INFO;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtDateTime(raw) {
    if (!raw) return "—";
    try {
        const d = new Date(String(raw).replace(" ", "T"));
        return d.toLocaleString();
    } catch { return raw; }
}

function fmtNum(v, decimals = 1, fallback = "—") {
    if (v === null || v === undefined || v === false) return fallback;
    return Number(v).toFixed(decimals);
}

function destroyChart(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const existing = typeof Chart !== "undefined" && Chart.getChart(canvas);
    if (existing) existing.destroy();
}

// ── Component ──────────────────────────────────────────────────────────────────
class AssetDetailPage extends Component {
    setup() {
        this.orm = useService("orm");
        this.action = useService("action");

        // device_id comes from the action params when opened via
        // action_open_asset_detail or directly from the menu with a param.
        this.deviceId = this.props.action?.params?.device_id || null;

        this.state = useState({
            deviceId: this.deviceId || "",
            loading: false,
            error: null,

            // Current state panel
            latest: null,

            // History panel
            history: [],

            // Timeline panel
            timeline: [],

            // Alerts panel
            alerts: [],

            // Diagnostics panel
            diagnostics: null,

            // UI toggles
            rawPayloadExpanded: false,
            activeTab: "state", // "state" | "history" | "timeline" | "alerts" | "diagnostics"
        });

        this._refreshInterval = null;

        onMounted(async () => {
            if (this.state.deviceId) {
                await this._load();
                this._refreshInterval = setInterval(() => this._loadLatest(), 30000);
            }
        });

        onWillUnmount(() => {
            clearInterval(this._refreshInterval);
            destroyChart("asset-speed-chart");
            destroyChart("asset-fuel-chart");
        });
    }

    // ── Data loading ────────────────────────────────────────────────────────────

    async _load() {
        this.state.loading = true;
        this.state.error = null;
        try {
            await Promise.all([
                this._loadLatest(),
                this._loadHistory(),
                this._loadTimeline(),
                this._loadAlerts(),
                this._loadDiagnostics(),
            ]);
        } catch (e) {
            this.state.error = "Failed to load telemetry data. Check the L4 service connection.";
            console.error("[AssetDetail] load error:", e);
        } finally {
            this.state.loading = false;
        }
    }

    async _loadLatest() {
        const rows = await this.orm.searchRead(
            "fleet.vehicle.telemetry",
            [["device_id", "=", this.state.deviceId]],
            [
                "device_id", "event_id", "timestamp", "received_at",
                "latitude", "longitude", "altitude", "accuracy", "bearing",
                "speed", "ignition", "fuel_level", "odometer", "rpm", "engine_load",
                "buffered", "payload",
            ],
            { limit: 1 }
        );
        this.state.latest = rows[0] || null;
    }

    async _loadHistory() {
        // Fetch last 100 telemetry records for trend charts.
        // We ask the server to call the L4 history endpoint via a wizard
        // method — but for now we read from the local snapshot table
        // (which is all Odoo stores).  A richer implementation would call
        // a Python controller that proxies /api/vehicles/:id/history.
        // This is noted as a Phase 3.5 improvement.
        const rows = await this.orm.searchRead(
            "fleet.vehicle.telemetry",
            [["device_id", "=", this.state.deviceId]],
            ["timestamp", "speed", "fuel_level"],
            { limit: 1 }
        );
        // Wrap the single snapshot in an array so the chart has at least one point.
        this.state.history = rows;
        requestAnimationFrame(() => requestAnimationFrame(() => this._renderTrendCharts()));
    }

    async _loadTimeline() {
        // Load alerts ordered newest-first as the timeline source.
        const rows = await this.orm.searchRead(
            "fleet.vehicle.alert",
            [["device_id", "=", this.state.deviceId]],
            ["alert_id", "alert_type", "severity", "message", "timestamp", "acknowledged"],
            { limit: 50, order: "timestamp desc" }
        );
        // Build a timeline: mix telemetry snapshot + alert records.
        const events = rows.map(r => ({
            kind: "alert",
            timestamp: r.timestamp,
            severity: r.severity,
            alert_type: r.alert_type,
            message: r.message,
            acknowledged: r.acknowledged,
        }));
        if (this.state.latest?.timestamp) {
            events.unshift({
                kind: "telemetry",
                timestamp: this.state.latest.timestamp,
                speed: this.state.latest.speed,
                fuel_level: this.state.latest.fuel_level,
                ignition: this.state.latest.ignition,
            });
        }
        this.state.timeline = events;
    }

    async _loadAlerts() {
        const rows = await this.orm.searchRead(
            "fleet.vehicle.alert",
            [["device_id", "=", this.state.deviceId]],
            ["alert_id", "alert_type", "severity", "message", "timestamp", "acknowledged", "acknowledged_at"],
            { limit: 100, order: "timestamp desc" }
        );
        this.state.alerts = rows;
    }

    async _loadDiagnostics() {
        const rows = await this.orm.searchRead(
            "fleet.vehicle.diagnostics",
            [["device_id", "=", this.state.deviceId]],
            ["device_id", "contract_version", "timestamp", "received_at",
             "rpm", "engine_load", "fuel_level", "odometer", "buffered", "raw_payload"],
            { limit: 1 }
        );
        this.state.diagnostics = rows[0] || null;
    }

    // ── Charts ──────────────────────────────────────────────────────────────────

    _renderTrendCharts() {
        if (typeof Chart === "undefined") return;

        const history = this.state.history;
        const labels = history.map(r => fmtDateTime(r.timestamp));
        const speeds = history.map(r => r.speed || 0);
        const fuels  = history.map(r => r.fuel_level || 0);

        destroyChart("asset-speed-chart");
        const speedCanvas = document.getElementById("asset-speed-chart");
        if (speedCanvas) {
            new Chart(speedCanvas, {
                type: "line",
                data: {
                    labels,
                    datasets: [{
                        label: "Speed (km/h)",
                        data: speeds,
                        borderColor: "#6366f1",
                        backgroundColor: "rgba(99,102,241,0.08)",
                        fill: true,
                        tension: 0.3,
                        pointRadius: 3,
                    }],
                },
                options: {
                    responsive: true,
                    plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, title: { display: true, text: "km/h" } } },
                },
            });
        }

        destroyChart("asset-fuel-chart");
        const fuelCanvas = document.getElementById("asset-fuel-chart");
        if (fuelCanvas) {
            new Chart(fuelCanvas, {
                type: "line",
                data: {
                    labels,
                    datasets: [{
                        label: "Fuel Level (%)",
                        data: fuels,
                        borderColor: "#f59e0b",
                        backgroundColor: "rgba(245,158,11,0.08)",
                        fill: true,
                        tension: 0.3,
                        pointRadius: 3,
                    }],
                },
                options: {
                    responsive: true,
                    plugins: { legend: { display: false } },
                    scales: { y: { min: 0, max: 100, title: { display: true, text: "%" } } },
                },
            });
        }
    }

    // ── UI actions ──────────────────────────────────────────────────────────────

    async onSearch() {
        if (!this.state.deviceId.trim()) return;
        this.deviceId = this.state.deviceId.trim();
        await this._load();
        this._refreshInterval && clearInterval(this._refreshInterval);
        this._refreshInterval = setInterval(() => this._loadLatest(), 30000);
    }

    async onRefresh() {
        if (!this.state.deviceId) return;
        await this._load();
    }

    setTab(tab) {
        this.state.activeTab = tab;
        if (tab === "history") {
            requestAnimationFrame(() => requestAnimationFrame(() => this._renderTrendCharts()));
        }
    }

    toggleRawPayload() {
        this.state.rawPayloadExpanded = !this.state.rawPayloadExpanded;
    }

    // ── Computed helpers exposed to template ────────────────────────────────────

    get ignitionLabel() {
        const l = this.state.latest;
        if (!l) return "—";
        return l.ignition ? "ON" : "OFF";
    }

    get ignitionStyle() {
        const l = this.state.latest;
        if (!l) return "";
        return l.ignition
            ? "background:#d1fae5; color:#065f46;"
            : "background:#fee2e2; color:#991b1b;";
    }

    get speedDisplay()      { return this.state.latest ? fmtNum(this.state.latest.speed, 1)       + " km/h" : "—"; }
    get fuelDisplay()       { return this.state.latest ? fmtNum(this.state.latest.fuel_level, 1)  + "%" : "—"; }
    get odometerDisplay()   { return this.state.latest ? fmtNum(this.state.latest.odometer, 0)    + " km" : "—"; }
    get engineLoadDisplay() { return this.state.latest ? fmtNum(this.state.latest.engine_load, 1) + "%" : "—"; }
    get rpmDisplay()        { return this.state.latest ? fmtNum(this.state.latest.rpm, 0, "—")    + " RPM" : "—"; }
    get timestampDisplay()  { return this.state.latest ? fmtDateTime(this.state.latest.timestamp) : "—"; }
    get receivedAtDisplay() { return this.state.latest ? fmtDateTime(this.state.latest.received_at) : "—"; }

    get diagRpmDisplay()        { return this.state.diagnostics ? fmtNum(this.state.diagnostics.rpm, 0)         + " RPM" : "—"; }
    get diagEngineLoadDisplay() { return this.state.diagnostics ? fmtNum(this.state.diagnostics.engine_load, 1) + "%" : "—"; }
    get diagFuelDisplay()       { return this.state.diagnostics ? fmtNum(this.state.diagnostics.fuel_level, 1)  + "%" : "—"; }
    get diagOdometerDisplay()   { return this.state.diagnostics ? fmtNum(this.state.diagnostics.odometer, 0)    + " km" : "—"; }
    get diagTimestampDisplay()  { return this.state.diagnostics ? fmtDateTime(this.state.diagnostics.timestamp) : "—"; }
    get diagVersion()           { return this.state.diagnostics?.contract_version || "—"; }

    get formattedRawPayload() {
        if (!this.state.diagnostics?.raw_payload) return "{}";
        try {
            const parsed = typeof this.state.diagnostics.raw_payload === "string"
                ? JSON.parse(this.state.diagnostics.raw_payload)
                : this.state.diagnostics.raw_payload;
            return JSON.stringify(parsed, null, 2);
        } catch { return this.state.diagnostics.raw_payload; }
    }

    severityBadgeStyle(sev) {
        const c = severityColor(sev);
        return `background:${c.bg}; color:${c.text}; padding:2px 8px; border-radius:8px; font-size:0.75rem; font-weight:600;`;
    }

    fmtDateTime(raw) { return fmtDateTime(raw); }
}

AssetDetailPage.template = "fleet_telemetry_connector.AssetDetail";
registry.category("actions").add("fleet_telemetry_asset_detail", AssetDetailPage);
