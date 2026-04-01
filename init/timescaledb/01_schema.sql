-- Fleet Telemetry Platform: TimescaleDB Schema Initialization
-- Runs automatically on first container start
-- Creates hypertables, indexes, and related tables

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Skipping pg_stat_statements: %', SQLERRM;
END
$$;

-- Create telemetry hypertable (primary table for all position data)
CREATE TABLE IF NOT EXISTS telemetry (
  event_id UUID NOT NULL DEFAULT gen_random_uuid(),
  device_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Position data
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  altitude FLOAT,
  accuracy FLOAT,
  bearing FLOAT,
  speed FLOAT,
  
  -- Telemetry data
  ignition BOOLEAN,
  fuel_level FLOAT,
  odometer FLOAT,
  rpm INTEGER,
  engine_load FLOAT,
  
  -- Metadata
  buffered BOOLEAN DEFAULT FALSE,
  payload JSONB,
  
  -- Indexing hints
  CONSTRAINT positive_speed CHECK (speed >= 0),
  CONSTRAINT valid_fuel CHECK (fuel_level >= 0 AND fuel_level <= 100),
  CONSTRAINT valid_engine_load CHECK (engine_load >= 0 AND engine_load <= 100),
  CONSTRAINT valid_lat CHECK (lat >= -90 AND lat <= 90),
  CONSTRAINT valid_lng CHECK (lng >= -180 AND lng <= 180),
  PRIMARY KEY (event_id, timestamp)
);

-- Convert telemetry to a hypertable with time partitioning
SELECT create_hypertable(
  'telemetry',
  'timestamp',
  if_not_exists => TRUE,
  chunk_time_interval => INTERVAL '1 day'
);

-- Create indexes for query performance
CREATE INDEX IF NOT EXISTS idx_telemetry_device_timestamp 
  ON telemetry (device_id, timestamp DESC);
  
CREATE INDEX IF NOT EXISTS idx_telemetry_device_ignition 
  ON telemetry (device_id, ignition) 
  WHERE ignition IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telemetry_speed 
  ON telemetry (speed) 
  WHERE speed >= 80;

CREATE INDEX IF NOT EXISTS idx_telemetry_fuel_low 
  ON telemetry (device_id, fuel_level) 
  WHERE fuel_level < 25;

CREATE INDEX IF NOT EXISTS idx_telemetry_received_at 
  ON telemetry (received_at);

-- Create alerts table (for triggered alerts)
CREATE TABLE IF NOT EXISTS alerts (
  alert_id UUID NOT NULL DEFAULT gen_random_uuid(),
  device_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  alert_type TEXT NOT NULL, -- 'SPEED_EXCEEDED', 'GEOFENCE', 'FUEL_LOW', 'IGNITION_OFF', etc.
  severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  message TEXT,
  position_lat DOUBLE PRECISION,
  position_lng DOUBLE PRECISION,
  event_id UUID,
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_at TIMESTAMPTZ,
  metadata JSONB,
  PRIMARY KEY (alert_id, timestamp)
);

-- Convert alerts to hypertable for time-series queries
SELECT create_hypertable(
  'alerts',
  'timestamp',
  if_not_exists => TRUE,
  chunk_time_interval => INTERVAL '1 day'
);

-- Create indexes on alerts table
CREATE INDEX IF NOT EXISTS idx_alerts_device_timestamp 
  ON alerts (device_id, timestamp DESC);
  
CREATE INDEX IF NOT EXISTS idx_alerts_severity 
  ON alerts (severity);

CREATE INDEX IF NOT EXISTS idx_alerts_unacknowledged 
  ON alerts (device_id) 
  WHERE acknowledged = FALSE;

-- Create audit log table
CREATE TABLE IF NOT EXISTS audit_log (
  log_id UUID NOT NULL DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE', 'ALERT_TRIGGERED', etc.
  entity_type TEXT, -- 'telemetry', 'alert', 'device', etc.
  entity_id TEXT,
  details JSONB,
  user_id TEXT,
  ip_address INET,
  PRIMARY KEY (log_id, timestamp)
);

-- Convert audit log to hypertable
SELECT create_hypertable(
  'audit_log',
  'timestamp',
  if_not_exists => TRUE,
  chunk_time_interval => INTERVAL '1 day'
);

-- Create index on audit log
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp 
  ON audit_log (timestamp DESC);
  
CREATE INDEX IF NOT EXISTS idx_audit_log_action 
  ON audit_log (action);

-- Create device registry table
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  imei TEXT UNIQUE NOT NULL,
  name TEXT,
  vehicle_type TEXT, -- 'truck', 'van', 'car', etc.
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ,
  metadata JSONB
);

-- Create index on devices
CREATE INDEX IF NOT EXISTS idx_devices_status 
  ON devices (status);

-- Create geofences table
CREATE TABLE IF NOT EXISTS geofences (
  geofence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  polygon TEXT NOT NULL, -- GeoJSON polygon as JSON string
  radius_meters FLOAT, -- For circular geofences
  center_lat DOUBLE PRECISION,
  center_lng DOUBLE PRECISION,
  alert_on_enter BOOLEAN DEFAULT TRUE,
  alert_on_exit BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create device-geofence assignments
CREATE TABLE IF NOT EXISTS geofence_assignments (
  assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id TEXT REFERENCES devices(device_id) ON DELETE CASCADE,
  geofence_id UUID REFERENCES geofences(geofence_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(device_id, geofence_id)
);

-- Create continuous aggregates for hourly summaries (90 day retention)
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_hourly_summary 
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', timestamp) AS hour,
  device_id,
  AVG(speed) AS avg_speed,
  MAX(speed) AS max_speed,
  AVG(fuel_level) AS avg_fuel,
  COUNT(*) AS event_count,
  ARRAY_AGG(DISTINCT(ignition)) AS ignition_states
FROM telemetry
GROUP BY hour, device_id
WITH DATA;

-- Add retention policy: raw data 90 days, aggregated 2 years
SELECT add_retention_policy('telemetry', INTERVAL '90 days', if_not_exists => TRUE);
SELECT add_retention_policy('alerts', INTERVAL '180 days', if_not_exists => TRUE);
SELECT add_retention_policy('audit_log', INTERVAL '365 days', if_not_exists => TRUE);

-- Refresh policy for materialized views
SELECT add_continuous_aggregate_policy('telemetry_hourly_summary',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- Grant permissions
GRANT USAGE ON SCHEMA public TO fleet;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO fleet;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fleet;

-- Create helper function to insert events from normalized schema
CREATE OR REPLACE FUNCTION insert_telemetry_event(
  p_event_id UUID,
  p_device_id TEXT,
  p_timestamp TIMESTAMPTZ,
  p_received_at TIMESTAMPTZ,
  p_position JSONB,
  p_telemetry JSONB,
  p_io_events JSONB,
  p_buffered BOOLEAN,
  p_payload JSONB
) RETURNS UUID AS $$
BEGIN
  INSERT INTO telemetry (
    event_id, device_id, timestamp, received_at,
    lat, lng, altitude, accuracy, bearing, speed,
    ignition, fuel_level, odometer, rpm, engine_load,
    buffered, payload
  ) VALUES (
    p_event_id, p_device_id, p_timestamp, p_received_at,
    (p_position->>'lat')::DOUBLE PRECISION,
    (p_position->>'lng')::DOUBLE PRECISION,
    (p_position->>'altitude')::FLOAT,
    (p_position->>'accuracy')::FLOAT,
    (p_position->>'bearing')::FLOAT,
    (p_position->>'speed')::FLOAT,
    (p_telemetry->>'ignition')::BOOLEAN,
    (p_telemetry->>'fuel_level')::FLOAT,
    (p_telemetry->>'odometer')::FLOAT,
    (p_telemetry->>'rpm')::INTEGER,
    (p_telemetry->>'engine_load')::FLOAT,
    p_buffered,
    p_payload
  );
  
  RETURN p_event_id;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO audit_log (action, entity_type, entity_id, details)
  VALUES ('ERROR_INSERT', 'telemetry', p_device_id, 
    jsonb_build_object('error', SQLERRM, 'event_id', p_event_id));
  RAISE;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION insert_telemetry_event TO fleet;

-- Log schema initialization
INSERT INTO audit_log (action, entity_type, details)
VALUES ('SCHEMA_INITIALIZED', 'database', jsonb_build_object(
  'version', '1.0',
  'tables', ARRAY['telemetry', 'alerts', 'audit_log', 'devices', 'geofences'],
  'timestamp', NOW()
));
