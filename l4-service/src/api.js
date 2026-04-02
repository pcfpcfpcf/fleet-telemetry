import express from 'express';
import { WebSocketServer } from 'ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pool, writeAuditLog } from './db.js';

const API_KEY = process.env.API_KEY || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:8069,http://localhost:3000')
  .split(',').map(o => o.trim()).filter(Boolean);
const VEHICLE_ACTIVE_WINDOW_MINUTES = Math.max(
  1,
  parseInt(process.env.VEHICLE_ACTIVE_WINDOW_MINUTES || '15', 10) || 15
);

function isValidDeviceId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[a-zA-Z0-9_\-]+$/.test(id);
}
function internalError(res) { res.status(500).json({ error: 'internal server error' }); }
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || null;
}
function auditLog(event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'l4-api', event, ...extra }));
}

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => auditLog('api_request', {
    method: req.method, path: req.path,
    status: res.statusCode, ip: getClientIp(req),
    duration_ms: Date.now() - start,
  }));
  next();
}

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    if (process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'service not configured' });
    auditLog('no_api_key_configured');
    return next();
  }
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== API_KEY) {
    const ip = getClientIp(req);
    auditLog('auth_failure', { path: req.path, method: req.method, ip });
    writeAuditLog('AUTH_FAILURE', 'api', ip, { path: req.path, method: req.method, provided_key: provided ? '[redacted]' : null }, ip);
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
  windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many requests, please try again later' },
  handler: (req, res, next, options) => {
    const ip = getClientIp(req);
    auditLog('rate_limited', { path: req.path, ip });
    writeAuditLog('RATE_LIMITED', 'api', ip, { path: req.path, method: req.method }, ip);
    res.status(options.statusCode).json(options.message);
  },
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many requests, please try again later' },
});

export function startApi() {
  const app = express();
  app.use(helmet());
  app.use(corsMiddleware);
  app.use(express.json({ limit: '100kb' }));
  app.use(requestLogger);
  app.use(generalLimiter);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/vehicles', requireApiKey, async (_req, res) => {
    try {
      const includeAll = String(_req.query?.all || '').toLowerCase() === 'true';
      const sql = includeAll
        ? `SELECT DISTINCT ON (device_id)
             device_id, lat, lng, speed, fuel_level, ignition, timestamp
           FROM telemetry
           ORDER BY device_id, timestamp DESC`
        : `SELECT DISTINCT ON (device_id)
             device_id, lat, lng, speed, fuel_level, ignition, timestamp
           FROM telemetry
           WHERE timestamp >= NOW() - ($1::int * INTERVAL '1 minute')
           ORDER BY device_id, timestamp DESC`;
      const params = includeAll ? [] : [VEHICLE_ACTIVE_WINDOW_MINUTES];
      const { rows } = await pool.query(sql, params);
      res.json(rows);
    } catch (e) {
      auditLog('db_error', { path: '/vehicles', error: e.message });
      internalError(res);
    }
  });

  app.get('/vehicles/:id/telemetry', requireApiKey, strictLimiter, async (req, res) => {
    const deviceId = req.params.id;
    if (!isValidDeviceId(deviceId)) {
      auditLog('invalid_device_id', { device_id: deviceId, ip: getClientIp(req) });
      return res.status(400).json({ error: 'invalid device id' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT event_id, timestamp, lat, lng, speed, fuel_level, odometer, ignition FROM telemetry WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 500`,
        [deviceId]
      );
      res.json(rows);
    } catch (e) {
      auditLog('db_error', { path: '/vehicles/:id/telemetry', error: e.message });
      internalError(res);
    }
  });

  app.get('/alerts', requireApiKey, async (_req, res) => {
    try {
      const { rows } = await pool.query(`SELECT alert_id, device_id, alert_type, severity, message, metadata, timestamp AS created_at FROM alerts ORDER BY timestamp DESC LIMIT 100`);
      res.json(rows);
    } catch (e) {
      auditLog('db_error', { path: '/alerts', error: e.message });
      internalError(res);
    }
  });

  app.listen(process.env.PORT || 3000, () => auditLog('server_started', { port: process.env.PORT || 3000 }));

  const wss = new WebSocketServer({
    port: process.env.WS_PORT || 3001,
    verifyClient: ({ origin }, callback) => {
      if (!origin) return callback(true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(true);
      console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'l4-ws', event: 'ws_origin_rejected', origin }));
      writeAuditLog('WS_ORIGIN_REJECTED', 'websocket', origin, { origin }, null);
      callback(false, 403, 'Forbidden');
    },
  });

  const clients = new Set();

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    const ip = getClientIp(req);
    console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'l4-ws', event: 'ws_connected', ip, total_clients: clients.size }));
    writeAuditLog('WS_CONNECTED', 'websocket', ip, { total_clients: clients.size }, ip);

    ws.on('message', (data) => {
      try {
        if (data.length > 16 * 1024) {
          console.warn(JSON.stringify({ ts: new Date().toISOString(), service: 'l4-ws', event: 'ws_message_too_large', size: data.length, ip }));
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg && typeof msg.type === 'string') {
          console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'l4-ws', event: 'ws_message', type: msg.type, ip }));
        }
      } catch { }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'l4-ws', event: 'ws_disconnected', ip, total_clients: clients.size }));
    });

    ws.on('error', (err) => {
      console.error(JSON.stringify({ ts: new Date().toISOString(), service: 'l4-ws', event: 'ws_error', error: err.message, ip }));
      clients.delete(ws);
    });
  });

  function broadcastToClients(data) {
    const msg = JSON.stringify(data);
    for (const client of clients) { if (client.readyState === 1) client.send(msg); }
  }

  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'l4-ws', event: 'server_started', port: process.env.WS_PORT || 3001 }));
  return broadcastToClients;
}