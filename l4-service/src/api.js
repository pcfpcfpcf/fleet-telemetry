import express from 'express';
import { WebSocketServer } from 'ws';
import { pool } from './db.js';

// ─── FIX 1: device_id validation helper ──────────────────────────────────────
// Accepts only alphanumeric, underscore, hyphen — matches adapter sanitization.
// Max 64 chars to prevent oversized DB queries.
function isValidDeviceId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[a-zA-Z0-9_\-]+$/.test(id);
}

// ─── FIX 2: safe error response — never leak internal error details ───────────
function internalError(res) {
  res.status(500).json({ error: 'internal server error' });
}

export function startApi() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/vehicles', async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (device_id)
          device_id, lat, lng, speed, fuel_level, ignition, timestamp
        FROM telemetry
        ORDER BY device_id, timestamp DESC
      `);
      res.json(rows);
    } catch (e) {
      // ─── FIX 2 applied: log internally, never send e.message to client ──────
      console.error('[L4] GET /vehicles error:', e.message);
      internalError(res);
    }
  });

  app.get('/vehicles/:id/telemetry', async (req, res) => {
    // ─── FIX 1 applied: validate device_id before using it ───────────────────
    const deviceId = req.params.id;
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: 'invalid device id' });
    }

    try {
      const { rows } = await pool.query(
        `
        SELECT event_id, timestamp, lat, lng, speed, fuel_level, odometer, ignition
        FROM telemetry
        WHERE device_id = $1
        ORDER BY timestamp DESC
        LIMIT 500
      `,
        [deviceId]
      );
      res.json(rows);
    } catch (e) {
      console.error('[L4] GET /vehicles/:id/telemetry error:', e.message);
      internalError(res);
    }
  });

  app.get('/alerts', async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT alert_id, device_id, alert_type, severity, message, metadata, timestamp AS created_at
        FROM alerts
        ORDER BY timestamp DESC
        LIMIT 100
      `);
      res.json(rows);
    } catch (e) {
      console.error('[L4] GET /alerts error:', e.message);
      internalError(res);
    }
  });

  app.listen(process.env.PORT || 3000, () => {
    console.log('[L4] REST API listening on :' + (process.env.PORT || 3000));
  });

  const wss = new WebSocketServer({ port: process.env.WS_PORT || 3001 });
  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('[L4] WebSocket client connected, total:', clients.size);

    // ─── FIX 3: handle and validate incoming WebSocket messages ──────────────
    // Previously the server accepted connections with zero message handling.
    // Now incoming messages are parsed and validated — unknown types are ignored.
    ws.on('message', (data) => {
      try {
        // Reject oversized messages (16 KB limit)
        if (data.length > 16 * 1024) {
          console.warn('[L4] WebSocket message too large, ignoring');
          return;
        }
        const msg = JSON.parse(data.toString());
        // Only act on known message types from clients.
        // Currently clients are read-only consumers — no valid incoming types.
        // This block is here to safely handle future client→server messages
        // and to prevent unhandled data from causing errors.
        if (msg && typeof msg.type === 'string') {
          console.log('[L4] WebSocket message received, type:', msg.type);
          // Future: handle 'subscribe', 'ping', etc. here
        }
      } catch {
        // Silently drop malformed messages — don't crash or log sensitive content
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log('[L4] WebSocket client disconnected, total:', clients.size);
    });

    ws.on('error', (err) => {
      console.error('[L4] WebSocket client error:', err.message);
      clients.delete(ws);
    });
  });

  function broadcastToClients(data) {
    const msg = JSON.stringify(data);
    for (const client of clients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }

  console.log('[L4] WebSocket server listening on :' + (process.env.WS_PORT || 3001));
  return broadcastToClients;
}