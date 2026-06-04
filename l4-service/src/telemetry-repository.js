/**
 * Encode a cursor from a timestamp and event ID.
 * The cursor is a base64url-encoded JSON string containing { t, id }.
 *
 * @param {string|Date} timestamp - ISO 8601 timestamp or Date of the last record
 * @param {string} eventId - UUID of the last record
 * @returns {string} opaque base64url cursor string
 */
export function encodeCursor(timestamp, eventId) {
  return Buffer.from(JSON.stringify({ t: timestamp, id: eventId })).toString('base64url');
}

/**
 * Decode a cursor back into its constituent timestamp and event ID.
 *
 * @param {string} cursor - opaque base64url cursor string produced by encodeCursor
 * @returns {{ timestamp: string, eventId: string }} decoded cursor fields
 * @throws {Error} if the cursor is malformed or cannot be decoded
 */
export function decodeCursor(cursor) {
  const { t, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  return { timestamp: t, eventId: id };
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeTelemetryRow(row) {
  if (!row) return null;
  return {
    device_id: row.device_id,
    event_id: row.event_id,
    timestamp: toIsoOrNull(row.timestamp),
    received_at: toIsoOrNull(row.received_at),
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    altitude: row.altitude ?? null,
    accuracy: row.accuracy ?? null,
    bearing: row.bearing ?? null,
    speed: row.speed ?? null,
    ignition: row.ignition ?? null,
    fuel_level: row.fuel_level ?? null,
    odometer: row.odometer ?? null,
    rpm: row.rpm ?? null,
    engine_load: row.engine_load ?? null,
    buffered: Boolean(row.buffered),
    payload: row.payload ?? null,
  };
}

function normalizeAlertRow(row) {
  if (!row) return null;
  return {
    alert_id: row.alert_id,
    device_id: row.device_id,
    timestamp: toIsoOrNull(row.timestamp),
    alert_type: row.alert_type,
    severity: row.severity,
    message: row.message ?? null,
    metadata: row.metadata ?? null,
    acknowledged: Boolean(row.acknowledged),
    acknowledged_at: toIsoOrNull(row.acknowledged_at),
    position_lat: row.position_lat ?? null,
    position_lng: row.position_lng ?? null,
    event_id: row.event_id ?? null,
  };
}

function normalizeTripRow(row) {
  if (!row) return null;
  return {
    trip_id: row.trip_id,
    device_id: row.device_id,
    driver_id: row.driver_id ?? null,
    started_at: toIsoOrNull(row.started_at),
    ended_at: toIsoOrNull(row.ended_at),
    start_lat: row.start_lat ?? null,
    start_lng: row.start_lng ?? null,
    end_lat: row.end_lat ?? null,
    end_lng: row.end_lng ?? null,
    distance_meters: row.distance_meters ?? null,
    duration_seconds: row.duration_seconds ?? null,
    fuel_consumed_liters: row.fuel_consumed_liters ?? null,
    max_speed_kmh: row.max_speed_kmh ?? null,
    avg_speed_kmh: row.avg_speed_kmh ?? null,
    idle_seconds: row.idle_seconds ?? null,
    eco_score: row.eco_score ?? null,
    status: row.status ?? 'active',
  };
}

function normalizeDtcRow(row) {
  if (!row) return null;
  return {
    dtc_id: row.dtc_id,
    device_id: row.device_id,
    timestamp: toIsoOrNull(row.timestamp),
    dtc_code: row.dtc_code,
    description: row.description ?? null,
    raw_value: row.raw_value ?? null,
    resolved_at: toIsoOrNull(row.resolved_at),
    event_id: row.event_id ?? null,
  };
}

export function createTelemetryRepository(pool) {
  return {
    async getLatestState(deviceId) {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (device_id)
           event_id, device_id, timestamp, received_at, lat, lng, altitude, accuracy, bearing, speed,
           ignition, fuel_level, odometer, rpm, engine_load, buffered, payload
         FROM telemetry
         WHERE device_id = $1
         ORDER BY device_id, timestamp DESC`,
        [deviceId]
      );
      return normalizeTelemetryRow(rows[0]);
    },

    async listLatestStates({ activeWindowMinutes, includeAll = false } = {}) {
      const query = includeAll
        ? `SELECT DISTINCT ON (device_id)
             event_id, device_id, timestamp, received_at, lat, lng, altitude, accuracy, bearing, speed,
             ignition, fuel_level, odometer, rpm, engine_load, buffered, payload
           FROM telemetry
           ORDER BY device_id, timestamp DESC`
        : `SELECT DISTINCT ON (device_id)
             event_id, device_id, timestamp, received_at, lat, lng, altitude, accuracy, bearing, speed,
             ignition, fuel_level, odometer, rpm, engine_load, buffered, payload
           FROM telemetry
           WHERE timestamp >= NOW() - ($1::int * INTERVAL '1 minute')
           ORDER BY device_id, timestamp DESC`;
      const params = includeAll ? [] : [activeWindowMinutes];
      const { rows } = await pool.query(query, params);
      return rows.map(normalizeTelemetryRow).filter(Boolean);
    },

    async listHistory(deviceId, { from, to, limit = 500 } = {}) {
      const params = [deviceId];
      const clauses = ['device_id = $1'];
      if (from) {
        params.push(from);
        clauses.push(`timestamp >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        clauses.push(`timestamp <= $${params.length}`);
      }
      params.push(limit);
      const sql = `SELECT event_id, device_id, timestamp, received_at, lat, lng, altitude, accuracy, bearing, speed,
          ignition, fuel_level, odometer, rpm, engine_load, buffered, payload
        FROM telemetry
        WHERE ${clauses.join(' AND ')}
        ORDER BY timestamp DESC
        LIMIT $${params.length}`;
      const { rows } = await pool.query(sql, params);
      return rows.map(normalizeTelemetryRow).filter(Boolean);
    },

    async listAlerts({ deviceId = null, from = null, to = null, severity = null, alertType = null, acknowledged = null, limit = 500 } = {}) {
      const params = [];
      const clauses = [];
      if (deviceId) {
        params.push(deviceId);
        clauses.push(`device_id = $${params.length}`);
      }
      if (from) {
        params.push(from);
        clauses.push(`timestamp >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        clauses.push(`timestamp <= $${params.length}`);
      }
      if (severity) {
        params.push(severity);
        clauses.push(`severity = $${params.length}`);
      }
      if (alertType) {
        params.push(alertType);
        clauses.push(`alert_type = $${params.length}`);
      }
      if (acknowledged !== null && acknowledged !== undefined) {
        params.push(Boolean(acknowledged));
        clauses.push(`acknowledged = $${params.length}`);
      }
      params.push(limit);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { rows } = await pool.query(
        `SELECT alert_id, device_id, timestamp, alert_type, severity, message, metadata, acknowledged, acknowledged_at, position_lat, position_lng, event_id
         FROM alerts
         ${where}
         ORDER BY timestamp DESC
         LIMIT $${params.length}`,
        params
      );
      return rows.map(normalizeAlertRow).filter(Boolean);
    },

    async listTimeline(deviceId, { from, to, limit = 500 } = {}) {
      const telemetryRows = await this.listHistory(deviceId, { from, to, limit });
      const alertRows = await this.listAlerts({ deviceId, from, to, limit });
      const records = [
        ...telemetryRows.map((row, index) => ({ kind: 'telemetry', source: 'telemetry', sequence: index + 1, ...row })),
        ...alertRows.map((row, index) => ({ kind: 'alert', source: 'alert', sequence: index + 1, ...row })),
      ].sort((left, right) => (left.timestamp || '').localeCompare(right.timestamp || ''));
      return records;
    },

    async getFleetSummary({ activeWindowMinutes = 15 } = {}) {
      const latest = await this.listLatestStates({ activeWindowMinutes, includeAll: true });
      const alerts = await this.listAlerts({ limit: 1000 });
      const asOf = new Date().toISOString();
      const totalVehicles = latest.length;
      const activeVehicles = latest.filter((row) => row.ignition === true).length;
      const ignitionOn = activeVehicles;
      const ignitionOff = latest.filter((row) => row.ignition === false).length;
      const lowFuel = latest.filter((row) => row.fuel_level != null && row.fuel_level < 15).length;
      const overspeed = latest.filter((row) => row.speed != null && row.speed > 120).length;
      const buffered = latest.filter((row) => row.buffered).length;
      const gpsValid = latest.filter((row) => row.lat != null && row.lng != null).length;
      const gpsInvalid = totalVehicles - gpsValid;
      const openAlerts = alerts.filter((row) => row.acknowledged === false).length;
      const bySeverity = alerts.reduce((acc, row) => {
        acc[row.severity] = (acc[row.severity] || 0) + 1;
        return acc;
      }, {});
      const byType = alerts.reduce((acc, row) => {
        acc[row.alert_type] = (acc[row.alert_type] || 0) + 1;
        return acc;
      }, {});
      return {
        as_of: asOf,
        active_window_minutes: activeWindowMinutes,
        totals: {
          total_vehicles: totalVehicles,
          active_vehicles: activeVehicles,
          ignition_on: ignitionOn,
          ignition_off: ignitionOff,
          low_fuel: lowFuel,
          overspeed: overspeed,
          buffered: buffered,
        },
        quality: {
          gps_valid: gpsValid,
          gps_invalid: gpsInvalid,
          gps_coverage_ratio: totalVehicles > 0 ? gpsValid / totalVehicles : 0,
          signal_quality_supported: false,
          signal_quality: null,
          signal_quality_reason: 'validated ingestion path does not expose a stable signal quality field',
          device_health_supported: true,
          device_health: totalVehicles > 0 ? (totalVehicles - gpsInvalid) / totalVehicles : 0,
          device_health_reason: 'freshness and completeness ratio from validated fields',
        },
        alerts: {
          open_alerts: openAlerts,
          alert_count_by_severity: bySeverity,
          alert_count_by_type: byType,
        },
        devices: {
          fresh: latest.filter((row) => row.timestamp && (Date.now() - Date.parse(row.timestamp)) <= activeWindowMinutes * 60 * 1000).length,
          stale: latest.filter((row) => row.timestamp && (Date.now() - Date.parse(row.timestamp)) > activeWindowMinutes * 60 * 1000).length,
          stale_threshold_minutes: activeWindowMinutes,
        },
      };
    },

    async getDiagnostics(deviceId, { from = null, to = null, limit = 500, version = '1' } = {}) {
      const history = await this.listHistory(deviceId, { from, to, limit });
      const latest = history[0] || await this.getLatestState(deviceId);
      const rawPayload = latest?.payload && typeof latest.payload === 'object' ? latest.payload : {};
      return {
        version: String(version),
        device_id: deviceId,
        latest: latest
          ? {
              device_id: latest.device_id,
              timestamp: latest.timestamp,
              received_at: latest.received_at,
              rpm: latest.rpm ?? null,
              engine_load: latest.engine_load ?? null,
              fuel_level: latest.fuel_level ?? null,
              odometer: latest.odometer ?? null,
              buffered: latest.buffered,
              payload: latest.payload ?? null,
            }
          : null,
        history,
        raw_payload: rawPayload,
      };
    },

    // ─── Keyset-paginated query functions (Requirements 12.1, 12.3, 12.4) ───────
    //
    // All paginated queries use a two-column keyset condition:
    //   WHERE (timestamp, event_id) < ($cursorTs, $cursorId)
    // combined with ORDER BY timestamp DESC, event_id DESC
    // This guarantees stable sort order when multiple events share the same
    // millisecond timestamp, preventing duplicates and gaps (Property 10).

    /**
     * Query paginated telemetry history for a device with keyset cursor support.
     *
     * @param {string} deviceId
     * @param {string|null} from - ISO 8601 lower bound (inclusive)
     * @param {string|null} to   - ISO 8601 upper bound (inclusive)
     * @param {number} limit     - Maximum records to return (1–5000)
     * @param {string|null} cursor - Opaque cursor from previous response
     * @returns {Promise<{ records: object[], nextCursor: string|null }>}
     */
    async queryTelemetryHistory(deviceId, from, to, limit = 500, cursor = null) {
      const params = [deviceId];
      const clauses = ['device_id = $1'];

      if (from) {
        params.push(from);
        clauses.push(`timestamp >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        clauses.push(`timestamp <= $${params.length}`);
      }

      if (cursor) {
        const { timestamp: cursorTs, eventId: cursorId } = decodeCursor(cursor);
        params.push(cursorTs, cursorId);
        // Two-column keyset: strictly before (cursorTs, cursorId) in DESC order
        clauses.push(`(timestamp, event_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }

      // Fetch limit + 1 to determine if there is a next page
      params.push(limit + 1);
      const sql = `
        SELECT event_id, device_id, timestamp, received_at, lat, lng, altitude, accuracy, bearing, speed,
               ignition, fuel_level, odometer, rpm, engine_load, buffered, payload,
               ext_voltage, bat_voltage, bat_level, bat_current, gnss_status, gnss_hdop, gnss_pdop,
               movement, gsm_signal, network_type, axis_x, axis_y, axis_z,
               trip_odometer, eco_score, fuel_rate_gps, fuel_used_gps, sleep_mode
        FROM telemetry
        WHERE ${clauses.join(' AND ')}
        ORDER BY timestamp DESC, event_id DESC
        LIMIT $${params.length}`;

      const { rows } = await pool.query(sql, params);

      const hasMore = rows.length > limit;
      const records = rows.slice(0, limit).map(normalizeTelemetryRow).filter(Boolean);
      const lastRow = records[records.length - 1];
      const nextCursor = hasMore && lastRow
        ? encodeCursor(lastRow.timestamp, lastRow.event_id)
        : null;

      return { records, nextCursor };
    },

    /**
     * Query paginated trip list for a device with keyset cursor support.
     *
     * @param {string} deviceId
     * @param {string|null} from - ISO 8601 lower bound on started_at (inclusive)
     * @param {string|null} to   - ISO 8601 upper bound on started_at (inclusive)
     * @param {number} limit
     * @param {string|null} cursor - Opaque cursor from previous response
     * @returns {Promise<{ records: object[], nextCursor: string|null }>}
     */
    async queryTripList(deviceId, from, to, limit = 500, cursor = null) {
      const params = [deviceId];
      const clauses = ['device_id = $1'];

      if (from) {
        params.push(from);
        clauses.push(`started_at >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        clauses.push(`started_at <= $${params.length}`);
      }

      if (cursor) {
        const { timestamp: cursorTs, eventId: cursorId } = decodeCursor(cursor);
        params.push(cursorTs, cursorId);
        clauses.push(`(started_at, trip_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }

      params.push(limit + 1);
      const sql = `
        SELECT trip_id, device_id, driver_id, started_at, ended_at,
               start_lat, start_lng, end_lat, end_lng,
               distance_meters, duration_seconds, fuel_consumed_liters,
               max_speed_kmh, avg_speed_kmh, idle_seconds, eco_score, status
        FROM trips
        WHERE ${clauses.join(' AND ')}
        ORDER BY started_at DESC, trip_id DESC
        LIMIT $${params.length}`;

      const { rows } = await pool.query(sql, params);

      const hasMore = rows.length > limit;
      const records = rows.slice(0, limit).map(normalizeTripRow).filter(Boolean);
      const lastRow = records[records.length - 1];
      const nextCursor = hasMore && lastRow
        ? encodeCursor(lastRow.started_at, lastRow.trip_id)
        : null;

      return { records, nextCursor };
    },

    /**
     * Query paginated fleet-scoped alert list with keyset cursor support.
     *
     * @param {object} filters - { deviceId, severity, alertType, acknowledged, from, to }
     * @param {number} limit
     * @param {string|null} cursor - Opaque cursor from previous response
     * @returns {Promise<{ records: object[], nextCursor: string|null }>}
     */
    async queryAlertList(filters = {}, limit = 500, cursor = null) {
      const { deviceId = null, severity = null, alertType = null, acknowledged = null, from = null, to = null } = filters;
      const params = [];
      const clauses = [];

      if (deviceId) {
        params.push(deviceId);
        clauses.push(`device_id = $${params.length}`);
      }
      if (from) {
        params.push(from);
        clauses.push(`timestamp >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        clauses.push(`timestamp <= $${params.length}`);
      }
      if (severity) {
        params.push(severity);
        clauses.push(`severity = $${params.length}`);
      }
      if (alertType) {
        params.push(alertType);
        clauses.push(`alert_type = $${params.length}`);
      }
      if (acknowledged !== null && acknowledged !== undefined) {
        params.push(Boolean(acknowledged));
        clauses.push(`acknowledged = $${params.length}`);
      }

      if (cursor) {
        const { timestamp: cursorTs, eventId: cursorId } = decodeCursor(cursor);
        params.push(cursorTs, cursorId);
        clauses.push(`(timestamp, alert_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(limit + 1);
      const sql = `
        SELECT alert_id, device_id, timestamp, alert_type, severity, message, metadata,
               acknowledged, acknowledged_at, position_lat, position_lng, event_id
        FROM alerts
        ${where}
        ORDER BY timestamp DESC, alert_id DESC
        LIMIT $${params.length}`;

      const { rows } = await pool.query(sql, params);

      const hasMore = rows.length > limit;
      const records = rows.slice(0, limit).map(normalizeAlertRow).filter(Boolean);
      const lastRow = records[records.length - 1];
      const nextCursor = hasMore && lastRow
        ? encodeCursor(lastRow.timestamp, lastRow.alert_id)
        : null;

      return { records, nextCursor };
    },

    /**
     * Query paginated DTC event list for a device with keyset cursor support.
     *
     * @param {string} deviceId
     * @param {number} limit
     * @param {string|null} cursor - Opaque cursor from previous response
     * @returns {Promise<{ records: object[], nextCursor: string|null }>}
     */
    async queryDtcList(deviceId, limit = 500, cursor = null) {
      const params = [deviceId];
      const clauses = ['device_id = $1'];

      if (cursor) {
        const { timestamp: cursorTs, eventId: cursorId } = decodeCursor(cursor);
        params.push(cursorTs, cursorId);
        clauses.push(`(timestamp, dtc_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }

      params.push(limit + 1);
      const sql = `
        SELECT dtc_id, device_id, timestamp, dtc_code, description, raw_value, resolved_at, event_id
        FROM dtc_events
        WHERE ${clauses.join(' AND ')}
        ORDER BY timestamp DESC, dtc_id DESC
        LIMIT $${params.length}`;

      const { rows } = await pool.query(sql, params);

      const hasMore = rows.length > limit;
      const records = rows.slice(0, limit).map(normalizeDtcRow).filter(Boolean);
      const lastRow = records[records.length - 1];
      const nextCursor = hasMore && lastRow
        ? encodeCursor(lastRow.timestamp, lastRow.dtc_id)
        : null;

      return { records, nextCursor };
    },

    normalizeTelemetryRow,
    normalizeAlertRow,
  };
}
