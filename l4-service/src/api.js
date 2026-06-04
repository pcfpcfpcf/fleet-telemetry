import express from 'express';
import { WebSocketServer } from 'ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pool, writeAuditLog } from './db.js';
import { createTelemetryRepository } from './telemetry-repository.js';
import { createTelemetryService } from './telemetry-service.js';
import { buildLiveSummary, cacheAll, cacheSubscribe } from './live-cache.js';
import { getUnacknowledgedAlertCount, decrementUnacknowledgedAlertCount } from './alerts.js';

const API_KEY = process.env.API_KEY || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:8069,http://localhost:3000')
  .split(',').map(o => o.trim()).filter(Boolean);
const VEHICLE_ACTIVE_WINDOW_MINUTES = Math.max(
  1, parseInt(process.env.VEHICLE_ACTIVE_WINDOW_MINUTES || '15', 10) || 15
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidDeviceId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[a-zA-Z0-9_\-]+$/.test(id);
}

function parseIntParam(value, name, min = 1, max = 5000) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw Object.assign(new Error(`${name} must be an integer between ${min} and ${max}`), { status: 400 });
  }
  return n;
}

function parseIsoParam(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) {
    throw Object.assign(new Error(`${name} must be a valid ISO 8601 timestamp`), { status: 400 });
  }
  return d.toISOString();
}

function parseBoolParam(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).toLowerCase() === 'true';
}

function internalError(res) { res.status(500).json({ error: 'internal server error' }); }

function handleRouteError(res, err, path) {
  if (err.status === 400) return res.status(400).json({ error: err.message });
  auditLog('route_error', { path, error: err.message });
  internalError(res);
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || null;
}

function auditLog(event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'l4-api', event, ...extra }));
}

// ─── Middleware ───────────────────────────────────────────────────────────────

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    // Skip health and SSE keep-alives from access log to reduce noise
    if (req.path === '/health') return;
    auditLog('request', {
      method: req.method, path: req.path,
      status: res.statusCode, ip: getClientIp(req),
      ms: Date.now() - start,
    });
  });
  next();
}

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    if (process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'service not configured' });
    return next();
  }
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== API_KEY) {
    const ip = getClientIp(req);
    auditLog('auth_failure', { path: req.path, ip });
    writeAuditLog('AUTH_FAILURE', 'api', ip, { path: req.path }, ip);
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many requests' },
  handler: (req, res, _next, options) => {
    writeAuditLog('RATE_LIMITED', 'api', getClientIp(req), { path: req.path }, getClientIp(req));
    res.status(options.statusCode).json(options.message);
  },
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many requests' },
});

function deviceIdGuard(req, res, next) {
  if (!isValidDeviceId(req.params.deviceId)) {
    return res.status(400).json({ error: 'invalid device id' });
  }
  next();
}

// ─── SSE helper ───────────────────────────────────────────────────────────────

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: disable buffering
  res.flushHeaders();
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── App factory ─────────────────────────────────────────────────────────────

export function startApi(service = createTelemetryService(createTelemetryRepository(pool))) {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(corsMiddleware);
  app.use(express.json({ limit: '100kb' }));
  app.use(requestLogger);
  app.use(generalLimiter);

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

  // ══════════════════════════════════════════════════════════════════════════
  // LIVE ENDPOINTS  (served from in-process cache — no DB query)
  // ══════════════════════════════════════════════════════════════════════════

  // ── GET /api/dashboard/live ────────────────────────────────────────────────
  // Fleet-wide aggregated summary from the live cache.
  // All aggregation is done here on the backend — the frontend gets numbers.
  //
  // Response includes: totals, averages, per-vehicle list with all FMC003 fields.
  app.get('/api/dashboard/live', requireApiKey, (req, res) => {
    try {
      const staleMs = (parseIntParam(req.query.stale_minutes, 'stale_minutes', 1, 1440) ?? 15) * 60_000;
      res.json(buildLiveSummary(staleMs, 600_000, getUnacknowledgedAlertCount()));
    } catch (e) {
      handleRouteError(res, e, '/api/dashboard/live');
    }
  });

  // ── GET /api/vehicles/live ─────────────────────────────────────────────────
  // All vehicles from live cache, newest telemetry fields included.
  app.get('/api/vehicles/live', requireApiKey, (_req, res) => {
    const vehicles = cacheAll();
    res.json({
      as_of: new Date().toISOString(),
      count: vehicles.length,
      vehicles,
    });
  });

  // ── GET /api/stream/dashboard ─────────────────────────────────────────────
  // Server-Sent Events stream. Pushes a 'summary' event whenever any vehicle
  // updates, throttled to max 1 push per 500ms per connection.
  // Also sends a heartbeat every 15s to keep the connection alive.
  //
  // The client subscribes to this endpoint with EventSource; no polling needed.
  app.get('/api/stream/dashboard', requireApiKey, (req, res) => {
    sseHeaders(res);

    // Send initial snapshot immediately
    sseSend(res, 'summary', buildLiveSummary(15 * 60_000, 600_000, getUnacknowledgedAlertCount()));

    let dirty = false;
    let lastSent = Date.now();
    const MIN_INTERVAL = 500; // ms — max 2 pushes/sec

    const unsubscribe = cacheSubscribe(() => {
      dirty = true;
      const now = Date.now();
      if (now - lastSent >= MIN_INTERVAL) {
        dirty = false;
        lastSent = now;
        sseSend(res, 'summary', buildLiveSummary(15 * 60_000, 600_000, getUnacknowledgedAlertCount()));
      }
    });

    // Flush any pending dirty state and send heartbeat every 15s
    const heartbeat = setInterval(() => {
      if (dirty) {
        dirty = false;
        lastSent = Date.now();
        sseSend(res, 'summary', buildLiveSummary(15 * 60_000, 600_000, getUnacknowledgedAlertCount()));
      } else {
        res.write(': heartbeat\n\n');
      }
    }, 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // REST ENDPOINTS  (served from TimescaleDB via service layer)
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/api/fleet/summary', requireApiKey, async (req, res) => {
    try {
      const activeWindowMinutes = parseIntParam(
        req.query.active_window_minutes ?? VEHICLE_ACTIVE_WINDOW_MINUTES,
        'active_window_minutes', 1, 1440
      ) ?? VEHICLE_ACTIVE_WINDOW_MINUTES;
      res.json(await service.getFleetSummary({ active_window_minutes: activeWindowMinutes }));
    } catch (e) { handleRouteError(res, e, '/api/fleet/summary'); }
  });

  app.get('/api/vehicles/:deviceId/latest', requireApiKey, deviceIdGuard, async (req, res) => {
    try {
      const state = await service.getLatestVehicleState(req.params.deviceId);
      if (!state) return res.status(404).json({ error: 'device not found' });
      res.json(state);
    } catch (e) { handleRouteError(res, e, '/api/vehicles/:deviceId/latest'); }
  });

  app.get('/api/vehicles/:deviceId/history', requireApiKey, strictLimiter, deviceIdGuard, async (req, res) => {
    try {
      const from  = parseIsoParam(req.query.from, 'from');
      const to    = parseIsoParam(req.query.to, 'to');
      const limit = parseIntParam(req.query.limit, 'limit', 1, 5000) ?? 500;
      res.json(await service.getVehicleHistory(req.params.deviceId, { from, to, limit }));
    } catch (e) { handleRouteError(res, e, '/api/vehicles/:deviceId/history'); }
  });

  app.get('/api/vehicles/:deviceId/timeline', requireApiKey, strictLimiter, deviceIdGuard, async (req, res) => {
    try {
      const from  = parseIsoParam(req.query.from, 'from');
      const to    = parseIsoParam(req.query.to, 'to');
      const limit = parseIntParam(req.query.limit, 'limit', 1, 5000) ?? 500;
      res.json(await service.getVehicleTimeline(req.params.deviceId, { from, to, limit }));
    } catch (e) { handleRouteError(res, e, '/api/vehicles/:deviceId/timeline'); }
  });

  app.get('/api/vehicles/:deviceId/alerts', requireApiKey, deviceIdGuard, async (req, res) => {
    try {
      const from         = parseIsoParam(req.query.from, 'from');
      const to           = parseIsoParam(req.query.to, 'to');
      const limit        = parseIntParam(req.query.limit, 'limit', 1, 5000) ?? 100;
      const acknowledged = parseBoolParam(req.query.acknowledged);
      res.json(await service.getVehicleAlerts({
        device_id: req.params.deviceId, from, to, limit, acknowledged,
        severity: req.query.severity || null,
        alert_type: req.query.alert_type || null,
      }));
    } catch (e) { handleRouteError(res, e, '/api/vehicles/:deviceId/alerts'); }
  });

  app.get('/api/vehicles/:deviceId/diagnostics', requireApiKey, strictLimiter, deviceIdGuard, async (req, res) => {
    try {
      const from    = parseIsoParam(req.query.from, 'from');
      const to      = parseIsoParam(req.query.to, 'to');
      const limit   = parseIntParam(req.query.limit, 'limit', 1, 5000) ?? 500;
      const version = req.query.version ? String(req.query.version) : '1';
      const result  = await service.getVehicleDiagnostics(req.params.deviceId, { from, to, limit, version });
      if (!result || !result.latest) return res.status(404).json({ error: 'device not found' });
      res.json(result);
    } catch (e) { handleRouteError(res, e, '/api/vehicles/:deviceId/diagnostics'); }
  });

  // ── Legacy routes ──────────────────────────────────────────────────────────
  app.get('/vehicles', requireApiKey, async (_req, res) => {
    try {
      const rows = await service.getLatestVehicleStates({
        active_window_minutes: VEHICLE_ACTIVE_WINDOW_MINUTES, includeAll: false,
      });
      res.json(rows.map(r => ({
        device_id: r.device_id, lat: r.lat, lng: r.lng,
        speed: r.speed, fuel_level: r.fuel_level, ignition: r.ignition, timestamp: r.timestamp,
      })));
    } catch (e) { internalError(res); }
  });

  app.get('/vehicles/:id/telemetry', requireApiKey, strictLimiter, async (req, res) => {
    if (!isValidDeviceId(req.params.id)) return res.status(400).json({ error: 'invalid device id' });
    try {
      const result = await service.getVehicleHistory(req.params.id, { limit: 500 });
      res.json(result.records);
    } catch (e) { internalError(res); }
  });

  app.get('/alerts', requireApiKey, async (_req, res) => {
    try {
      const result = await service.getVehicleAlerts({ limit: 100 });
      res.json(result.records);
    } catch (e) { internalError(res); }
  });

  app.listen(process.env.PORT || 3000, () =>
    auditLog('server_started', { port: process.env.PORT || 3000 })
  );

  // ── WebSocket server ───────────────────────────────────────────────────────
  // Pushes real-time telemetry and alert events to every connected client.
  // Odoo dashboard subscribes here for instant updates.
  const wss = new WebSocketServer({
    port: process.env.WS_PORT || 3001,
    verifyClient: ({ origin }, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(true);
      writeAuditLog('WS_ORIGIN_REJECTED', 'websocket', origin, { origin }, null);
      callback(false, 403, 'Forbidden');
    },
  });

  const clients = new Set();

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    const ip = getClientIp(req);
    writeAuditLog('WS_CONNECTED', 'websocket', ip, { total: clients.size }, ip);

    // Send initial state snapshot on connect
    try {
      ws.send(JSON.stringify({ type: 'snapshot', data: buildLiveSummary(15 * 60_000, 600_000, getUnacknowledgedAlertCount()) }));
    } catch { /* client may have closed before send */ }

    ws.on('close', () => {
      clients.delete(ws);
    });
    ws.on('error', () => clients.delete(ws));
    ws.on('message', (data) => {
      try {
        if (data.length > 4096) return;
        const msg = JSON.parse(data.toString());
        // ping/pong keepalive
        if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch { /* ignore bad messages */ }
    });
  });

  function broadcastToClients(data) {
    if (clients.size === 0) return;
    const msg = JSON.stringify(data);
    for (const client of clients) {
      if (client.readyState === 1) {
        try { client.send(msg); } catch { clients.delete(client); }
      }
    }
  }

  auditLog('ws_started', { port: process.env.WS_PORT || 3001 });
  return broadcastToClients;
}
