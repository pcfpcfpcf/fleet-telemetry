import express from 'express';
import { WebSocketServer } from 'ws';
import { pool } from './db.js';

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
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/vehicles/:id/telemetry', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `
        SELECT event_id, timestamp, lat, lng, speed, fuel_level, odometer, ignition
        FROM telemetry
        WHERE device_id = $1
        ORDER BY timestamp DESC
        LIMIT 500
      `,
        [req.params.id]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
    ws.on('close', () => clients.delete(ws));
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
