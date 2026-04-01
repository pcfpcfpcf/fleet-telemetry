/** @odoo-module **/
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component, onMounted, onWillUnmount, useState } from "@odoo/owl";

class FleetTelemetryDashboard extends Component {
    setup() {
        this.orm = useService("orm");
        this.state = useState({
            vehicles: [],
            loading: true,
        });
        this._refreshInterval = null;

        onMounted(async () => {
            // Always wipe any leftover Chart.js instances on the canvases
            // from a previous mount — this is what causes blank charts on
            // navigate-away/back. Chart.js stores state on the canvas element
            // itself and refuses to re-init if it thinks one already exists.
            this._destroyCharts();

            // Also wipe Leaflet — same issue: the map div retains its
            // _leafletMap reference from the previous mount so renderMap()
            // sees it as "already initialized" and skips tile layer setup.
            this._destroyMap();

            await this.loadData();
            this._refreshInterval = setInterval(() => this.loadData(), 30000);
        });

        onWillUnmount(() => {
            clearInterval(this._refreshInterval);
            this._destroyCharts();
            this._destroyMap();
        });
    }

    _destroyCharts() {
        ["speedChart", "fuelChart", "ignitionChart"].forEach(id => {
            const canvas = document.getElementById(id);
            if (!canvas) return;
            // Chart.js 3+: getChart returns existing instance for a canvas
            const existing = Chart.getChart(canvas);
            if (existing) existing.destroy();
        });
    }

    _destroyMap() {
        const mapEl = document.getElementById("fleetMap");
        if (mapEl && mapEl._leafletMap) {
            mapEl._leafletMap.remove();
            mapEl._leafletMap = null;
        }
    }

    async loadData() {
        const records = await this.orm.searchRead(
            "fleet.vehicle.telemetry",
            [],
            ["device_id", "speed", "fuel_level", "ignition", "latitude", "longitude", "timestamp"]
        );
        this.state.vehicles = records;
        this.state.loading = false;

        // Double rAF: waits for OWL to flush the t-if/t-else DOM swap
        // before we try to draw into the canvas/map elements.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this.renderCharts();
            });
        });
    }

    get totalVehicles() { return this.state.vehicles.length; }
    get activeVehicles() { return this.state.vehicles.filter(v => v.ignition).length; }

    get avgSpeed() {
        if (!this.state.vehicles.length) return 0;
        return (this.state.vehicles.reduce((s, v) => s + v.speed, 0) / this.state.vehicles.length).toFixed(1);
    }

    get avgFuel() {
        if (!this.state.vehicles.length) return 0;
        return (this.state.vehicles.reduce((s, v) => s + v.fuel_level, 0) / this.state.vehicles.length).toFixed(1);
    }

    renderCharts() {
        if (!this.state.vehicles.length) return;
        this.renderSpeedChart();
        this.renderFuelChart();
        this.renderIgnitionChart();
        this.renderMap();
    }

    renderSpeedChart() {
        const canvas = document.getElementById("speedChart");
        if (!canvas) return;
        // Use Chart.getChart() instead of a custom property — more reliable
        const existing = Chart.getChart(canvas);
        if (existing) existing.destroy();

        const labels = this.state.vehicles.map(v => v.device_id);
        const data = this.state.vehicles.map(v => v.speed);
        new Chart(canvas, {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    label: "Speed (km/h)",
                    data,
                    backgroundColor: "rgba(99, 102, 241, 0.8)",
                    borderRadius: 6,
                }]
            },
            options: {
                responsive: true,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true } }
            }
        });
    }

    renderFuelChart() {
        const canvas = document.getElementById("fuelChart");
        if (!canvas) return;
        const existing = Chart.getChart(canvas);
        if (existing) existing.destroy();

        const labels = this.state.vehicles.map(v => v.device_id);
        const data = this.state.vehicles.map(v => v.fuel_level);
        new Chart(canvas, {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    label: "Fuel Level (%)",
                    data,
                    backgroundColor: data.map(v =>
                        v < 20 ? "rgba(239,68,68,0.8)" :
                        v < 50 ? "rgba(245,158,11,0.8)" :
                                 "rgba(16,185,129,0.8)"
                    ),
                    borderRadius: 6,
                }]
            },
            options: {
                responsive: true,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true, max: 100 } }
            }
        });
    }

    renderIgnitionChart() {
        const canvas = document.getElementById("ignitionChart");
        if (!canvas) return;
        const existing = Chart.getChart(canvas);
        if (existing) existing.destroy();

        const on  = this.state.vehicles.filter(v => v.ignition).length;
        const off = this.state.vehicles.length - on;
        new Chart(canvas, {
            type: "doughnut",
            data: {
                labels: ["Ignition On", "Ignition Off"],
                datasets: [{
                    data: [on, off],
                    backgroundColor: ["rgba(16,185,129,0.8)", "rgba(239,68,68,0.8)"],
                }]
            },
            options: {
                responsive: true,
                plugins: { legend: { position: "bottom" } }
            }
        });
    }

    renderMap() {
        const mapEl = document.getElementById("fleetMap");
        if (!mapEl) return;
        if (typeof L === "undefined") { console.error("Leaflet not loaded"); return; }

        // Always start fresh — _destroyMap() in onMounted ensures this is
        // null on first render after navigation, so we always re-init cleanly.
        if (mapEl._leafletMap) {
            mapEl._leafletMap.remove();
            mapEl._leafletMap = null;
        }

        const validVehicles = this.state.vehicles.filter(v => v.latitude && v.longitude);
        if (!validVehicles.length) return;

        const avgLat = validVehicles.reduce((s, v) => s + v.latitude, 0) / validVehicles.length;
        const avgLng = validVehicles.reduce((s, v) => s + v.longitude, 0) / validVehicles.length;

        const map = L.map(mapEl).setView([avgLat, avgLng], 10);
        mapEl._leafletMap = map;

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: "© OpenStreetMap"
        }).addTo(map);

        const bounds = [];
        validVehicles.forEach(v => {
            const color = v.ignition ? "green" : "red";
            const marker = L.circleMarker([v.latitude, v.longitude], {
                radius: 10, color, fillColor: color, fillOpacity: 0.8
            }).addTo(map);
            marker.bindPopup(`
                <b>${v.device_id}</b><br>
                Speed: ${v.speed} km/h<br>
                Fuel: ${v.fuel_level}%<br>
                Ignition: ${v.ignition ? "ON" : "OFF"}
            `);
            bounds.push([v.latitude, v.longitude]);
        });

        if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
    }
}

FleetTelemetryDashboard.template = "fleet_telemetry_connector.Dashboard";
registry.category("actions").add("fleet_telemetry_dashboard", FleetTelemetryDashboard);