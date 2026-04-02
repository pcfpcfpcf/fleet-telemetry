import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function writeTelemetry(event) {
  const sql = `
    INSERT INTO telemetry (
      event_id, device_id, timestamp, received_at,
      lat, lng, altitude, accuracy, bearing, speed,
      ignition, fuel_level, odometer, rpm, engine_load,
      buffered, payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (event_id, timestamp) DO NOTHING
  `;
  const vals = [
    event.event_id, event.device_id, event.timestamp,
    event.received_at || new Date().toISOString(),
    event.position?.lat ?? null, event.position?.lng ?? null,
    event.position?.altitude ?? null, event.position?.accuracy ?? null,
    event.position?.bearing ?? null, event.position?.speed ?? null,
    event.telemetry?.ignition ?? null, event.telemetry?.fuel_level ?? null,
    event.telemetry?.odometer ?? null, event.telemetry?.rpm ?? null,
    event.telemetry?.engine_load ?? null,
    event.buffered ?? false, JSON.stringify(event),
  ];
  await pool.query(sql, vals);
}

export async function writeAlert(deviceId, type, payload, severity = 'WARNING') {
  const sql = `INSERT INTO alerts (device_id, timestamp, alert_type, severity, message, metadata) VALUES ($1, NOW(), $2, $3, $4, $5)`;
  await pool.query(sql, [deviceId, type, severity, `${type} triggered for ${deviceId}`, JSON.stringify(payload)]);
}

// ─── Audit logging ────────────────────────────────────────────────────────────
// Writes security-relevant events to the audit_log table.
// Never throws — audit logging must never crash the main flow.
export async function writeAuditLog(action, entityType, entityId, details, ipAddress) {
  try {
    await pool.query(
      `INSERT INTO audit_log (action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5::inet)`,
      [action, entityType, entityId || null, JSON.stringify(details || {}), ipAddress || null]
    );
  } catch (err) {
    console.error('[AUDIT] Failed to write audit log:', err.message);
  }
}