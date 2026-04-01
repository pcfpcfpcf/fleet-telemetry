import express from 'express';
import { WebSocketServer } from 'ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pool } from './db.js';

const API_KEY = process.env.API_KEY || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:8069,http://localhost:3000')
  .split(',').map(o => o.trim()).filter(Boolean);

function isValidDeviceId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[a-zA-Z0-9_\-]+$/.test(id);
}

function internalError(res) {
  res.status(500).json({ error: 'internal server error' });
}

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    if (process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'service not configured' });
    console.warn('[L4] WARNING: API_KEY not set, skipping auth (dev mode only)');
    return next();
  }
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
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

const generalLimiter = rateLimit({ windowMs: 15*60*1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'too many requests' } });
const strictLimiter  = rateLimit({ windowMs: 15*60*1000, max: 30,  standardHeaders: true, legacyHeaders: false, message: { error: 'too many requests' } });

export function startApi() {
  const app = express();
  app.use(helmet());
  app.use(corsMiddleware);
  app.use(express.json({ limit: '100kb' }));
  app.use(generalLimiter);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/vehicles', requireApiKey, async (_req, res) => {
    try {
      const { rows } = await pool.query(`SELECT DISTINCT ON (device_id) device_id, lat, lng, speed, fuel_level, ignition, timestamp FROM telemetry ORDER BY device_id, timestamp DESC`);
      res.json(rows);
    } catch (e) { console.error('[L4] GET /vehicles error:', e.message); internalError(res); }
  });

  app.get('/vehicles/:id/telemetry', requireApiKey, strictLimiter, async (req, res) => {
    const deviceId = req.params.id;
    if (!isValidDeviceId(deviceId)) return res.status(400).json({ error: 'invalid device id' });
    try {
      const { rows } = await pool.query(`SELECT event_id, timestamp, lat, lng, speed, fuel_level, odometer, ignition FROM telemetry WHERE device_id = $1 ORDER BY timestamp DESC LIMIT 500`, [deviceId]);
      res.json(rows);
    } catch (e) { console.error('[L4] GET /vehicles/:id/telemetry error:', e.message); internalError(res); }
  });

  app.get('/alerts', requireApiKey, async (_req, res) => {
    try {
      const { rows } = await pool.query(`SELECT alert_id, device_id, alert_type, severity, message, metadata, timestamp AS created_at FROM alerts ORDER BY timestamp DESC LIMIT 100`);
      res.json(rows);
    } catch (e) { console.error('[L4] GET /alerts error:', e.message); internalError(res); }
  });

  app.listen(process.env.PORT || 3000, () => console.log('[L4] REST API listening on :' + (process.env.PORT || 3000)));

  const wss = new WebSocketServer({
    port: process.env.WS_PORT || 3001,
    verifyClient: ({ origin }, callback) => {
      if (!origin) return callback(true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(true);
      console.warn('[L4] WebSocket rejected from origin:', origin);
      callback(false, 403, 'Forbidden');
    },
  });

  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('[L4] WebSocket client connected, total:', clients.size);
    ws.on('message', (data) => {
      try {
        if (data.length > 16 * 1024) { console.warn('[L4] WebSocket message too large'); return; }
        const msg = JSON.parse(data.toString());
        if (msg && typeof msg.type === 'string') console.log('[L4] WebSocket message received, type:', msg.type);
      } catch { }
    });
    ws.on('close', () => { clients.delete(ws); console.log('[L4] WebSocket client disconnected, total:', clients.size); });
    ws.on('error', (err) => { console.error('[L4] WebSocket client error:', err.message); clients.delete(ws); });
  });

  function broadcastToClients(data) {
    const msg = JSON.stringify(data);
    for (const client of clients) { if (client.readyState === 1) client.send(msg); }
  }

  console.log('[L4] WebSocket server listening on :' + (process.env.WS_PORT || 3001));
  return broadcastToClients;
}