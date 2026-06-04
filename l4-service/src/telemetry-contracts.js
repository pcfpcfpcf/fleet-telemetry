// ─── JSDoc @typedef Response Shape Definitions ───────────────────────────────
// These are the canonical response shapes for all L4-Service REST endpoints.
// Field names are taken directly from .azure/telemetry-api-contracts.md.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single telemetry event as returned by history / latest endpoints.
 * Covers the core FMC003 fields plus all 18 extended IO columns added in v2 schema.
 *
 * @typedef {object} TelemetryEvent
 * @property {string}       device_id      - IMEI-based device identifier
 * @property {string}       event_id       - UUID of the event (deduplication key)
 * @property {string}       timestamp      - ISO 8601 event timestamp
 * @property {string}       received_at    - ISO 8601 server receipt timestamp
 * @property {number|null}  lat            - Latitude in decimal degrees
 * @property {number|null}  lng            - Longitude in decimal degrees
 * @property {number|null}  altitude       - Altitude in metres
 * @property {number|null}  accuracy       - GPS accuracy in metres (null if not available)
 * @property {number|null}  bearing        - Heading in degrees (0–360)
 * @property {number|null}  speed          - Speed in km/h
 * @property {boolean|null} ignition       - Ignition on/off state
 * @property {number|null}  fuel_level     - Fuel level percentage (0–100)
 * @property {number|null}  odometer       - Total odometer reading in km
 * @property {number|null}  rpm            - Engine RPM
 * @property {number|null}  engine_load    - Engine load percentage
 * @property {boolean}      buffered       - Whether the event was buffered offline
 * @property {number|null}  ext_voltage    - External (vehicle) voltage in V (IO 67)
 * @property {number|null}  bat_voltage    - Internal battery voltage in V (IO 66)
 * @property {number|null}  bat_level      - Battery charge level percentage (IO 113)
 * @property {number|null}  bat_current    - Battery current in mA (IO 68)
 * @property {number|null}  gnss_status    - GNSS fix status code (IO 69)
 * @property {number|null}  gnss_hdop      - Horizontal dilution of precision (IO 182)
 * @property {number|null}  gnss_pdop      - Position dilution of precision (IO 181)
 * @property {boolean|null} movement       - Device movement state (IO 240)
 * @property {number|null}  gsm_signal     - GSM signal strength (IO 21)
 * @property {number|null}  network_type   - Mobile network type code (IO 237)
 * @property {number|null}  axis_x         - Accelerometer X axis in mg (IO 17)
 * @property {number|null}  axis_y         - Accelerometer Y axis in mg (IO 18)
 * @property {number|null}  axis_z         - Accelerometer Z axis in mg (IO 19)
 * @property {number|null}  trip_odometer  - Trip distance counter in m (IO 199)
 * @property {number|null}  eco_score      - Eco driving score (IO 15)
 * @property {number|null}  fuel_rate_gps  - GPS-based fuel consumption rate L/100km (IO 13)
 * @property {number|null}  fuel_used_gps  - Cumulative GPS-based fuel used in L (IO 12)
 * @property {number|null}  sleep_mode     - Device sleep mode state (IO 200)
 * @property {object|null}  payload        - Raw JSONB payload for unstructured fields
 */

/**
 * A completed or active trip record.
 *
 * @typedef {object} TripRecord
 * @property {string}       trip_id               - UUID of the trip
 * @property {string}       device_id             - Device (vehicle) identifier
 * @property {string|null}  driver_id             - UUID of the assigned driver, or null
 * @property {string}       started_at            - ISO 8601 trip start timestamp
 * @property {string|null}  ended_at              - ISO 8601 trip end timestamp (null if active)
 * @property {number|null}  start_lat             - Starting latitude
 * @property {number|null}  start_lng             - Starting longitude
 * @property {number|null}  end_lat               - Ending latitude
 * @property {number|null}  end_lng               - Ending longitude
 * @property {number|null}  distance_meters       - Total trip distance in metres
 * @property {number|null}  duration_seconds      - Total trip duration in seconds
 * @property {number|null}  fuel_consumed_liters  - Fuel consumed during trip in litres
 * @property {number|null}  max_speed_kmh         - Maximum speed in km/h during trip
 * @property {number|null}  avg_speed_kmh         - Average speed in km/h during trip
 * @property {number|null}  idle_seconds          - Total idle time in seconds
 * @property {number|null}  eco_score             - Average eco driving score for the trip
 * @property {'active'|'completed'} status        - Trip status
 */

/**
 * A single alert record as stored in the `alerts` table.
 *
 * @typedef {object} AlertRecord
 * @property {string}         alert_id        - UUID of the alert
 * @property {string}         device_id       - Device that triggered the alert
 * @property {string}         timestamp       - ISO 8601 timestamp when alert was fired
 * @property {string}         alert_type      - Alert type identifier (e.g. 'overspeed', 'battery_low')
 * @property {'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'} severity - Alert severity level
 * @property {string|null}    message         - Human-readable alert message
 * @property {object|null}    metadata        - Arbitrary metadata (e.g. { ack_note: string })
 * @property {boolean}        acknowledged    - Whether the alert has been acknowledged
 * @property {string|null}    acknowledged_at - ISO 8601 timestamp of acknowledgement
 * @property {number|null}    position_lat    - Vehicle latitude at alert time
 * @property {number|null}    position_lng    - Vehicle longitude at alert time
 * @property {string|null}    event_id        - UUID of the triggering telemetry event
 */

/**
 * A device (vehicle tracker) record from the `devices` table.
 *
 * @typedef {object} DeviceRecord
 * @property {string}       device_id             - IMEI-based device identifier (primary key)
 * @property {string}       imei                  - 15-digit IMEI of the FMC003 device
 * @property {string|null}  name                  - Human-readable device label
 * @property {string|null}  vin                   - Vehicle Identification Number
 * @property {string|null}  iccid                 - SIM card ICCID (19–22 digits)
 * @property {string|null}  serial_number         - Device serial number
 * @property {string|null}  registration_number   - Vehicle registration plate
 * @property {string|null}  make                  - Vehicle manufacturer
 * @property {string|null}  model                 - Vehicle model
 * @property {number|null}  year                  - Vehicle model year
 * @property {string|null}  fuel_type             - Fuel type (e.g. 'diesel', 'petrol', 'electric')
 * @property {string|null}  driver_id             - UUID of currently assigned driver
 * @property {string|null}  last_seen             - ISO 8601 timestamp of last received event
 * @property {string}       created_at            - ISO 8601 creation timestamp
 */

/**
 * A driver record from the `drivers` table.
 *
 * @typedef {object} DriverRecord
 * @property {string}          driver_id       - UUID of the driver (primary key)
 * @property {string}          name            - Full name
 * @property {string|null}     employee_id     - Company employee identifier
 * @property {string|null}     license_number  - Driving licence number
 * @property {string|null}     phone           - Contact phone number
 * @property {string|null}     tag_id          - RFID / NFC tag identifier for driver recognition
 * @property {'active'|'inactive'} status      - Driver status
 * @property {string}          created_at      - ISO 8601 creation timestamp
 * @property {string}          updated_at      - ISO 8601 last-updated timestamp
 */

/**
 * A named geofence boundary record from the `geofences` table.
 *
 * @typedef {object} GeofenceRecord
 * @property {string}       geofence_id   - UUID of the geofence
 * @property {string}       name          - Human-readable geofence name
 * @property {string}       polygon       - GeoJSON Polygon or MultiPolygon as a JSON string
 * @property {string}       created_at    - ISO 8601 creation timestamp
 */

/**
 * A Diagnostic Trouble Code event from the `dtc_events` table.
 *
 * @typedef {object} DtcEvent
 * @property {string}       dtc_id        - UUID of the DTC event record
 * @property {string}       device_id     - Device that reported the DTC
 * @property {string}       timestamp     - ISO 8601 timestamp when the code was detected
 * @property {string}       dtc_code      - Standardised fault code (e.g. 'P0300')
 * @property {string|null}  description   - Human-readable description of the fault
 * @property {number|null}  raw_value     - Raw integer IO value from the device
 * @property {string|null}  resolved_at   - ISO 8601 timestamp when the code cleared
 * @property {string|null}  event_id      - UUID of the telemetry event that triggered detection
 */

/**
 * Fleet-level summary as returned by GET /api/fleet/summary and SSE summary events.
 *
 * @typedef {object} FleetSummary
 * @property {string}  as_of                  - ISO 8601 timestamp when the summary was computed
 * @property {number}  active_window_minutes  - Lookback window used for active vehicle count
 * @property {FleetSummaryTotals}  totals     - Vehicle-level counters
 * @property {FleetSummaryQuality} quality    - GPS and device health metrics
 * @property {FleetSummaryAlerts}  alerts     - Alert counts by severity and type
 * @property {FleetSummaryDevices} devices    - Freshness breakdown
 */

/**
 * @typedef {object} FleetSummaryTotals
 * @property {number} total_vehicles          - Total known devices
 * @property {number} active_vehicles         - Vehicles with ignition on
 * @property {number} ignition_on             - Vehicles with ignition on
 * @property {number} ignition_off            - Vehicles with ignition off
 * @property {number} low_fuel                - Vehicles with fuel level < 15%
 * @property {number} overspeed               - Vehicles exceeding speed threshold
 * @property {number} buffered                - Vehicles with buffered (offline) events
 * @property {number} [avg_bat_voltage]       - Mean battery voltage across all cached vehicles
 * @property {number} [low_battery_count]     - Vehicles with bat_voltage < 3.0 V
 * @property {number} [offline_count]         - Vehicles with no event in last 600 s
 * @property {number} [unacknowledged_alerts] - Count of open unacknowledged alerts
 */

/**
 * @typedef {object} FleetSummaryQuality
 * @property {number}       gps_valid
 * @property {number}       gps_invalid
 * @property {number}       gps_coverage_ratio
 * @property {boolean}      signal_quality_supported
 * @property {number|null}  signal_quality
 * @property {string|null}  signal_quality_reason
 * @property {boolean}      device_health_supported
 * @property {number|null}  device_health
 * @property {string|null}  device_health_reason
 */

/**
 * @typedef {object} FleetSummaryAlerts
 * @property {number} open_alerts
 * @property {object} alert_count_by_severity  - e.g. { LOW: 2, MEDIUM: 3, HIGH: 2, CRITICAL: 0 }
 * @property {object} alert_count_by_type      - e.g. { overspeed: 2, battery_low: 3 }
 */

/**
 * @typedef {object} FleetSummaryDevices
 * @property {number} fresh                   - Devices seen within stale_threshold_minutes
 * @property {number} stale                   - Devices not seen within stale_threshold_minutes
 * @property {number} stale_threshold_minutes - Threshold used for fresh/stale classification
 */

/**
 * Generic paginated response envelope used by all history / list endpoints.
 *
 * @template T
 * @typedef {object} PaginatedResponse
 * @property {string|null}  device_id    - Scoped device ID, or null for fleet-scoped queries
 * @property {string|null}  from         - ISO 8601 lower bound of the time window
 * @property {string|null}  to           - ISO 8601 upper bound of the time window
 * @property {number}       limit        - Maximum records requested (1–5000)
 * @property {string|null}  next_cursor  - Opaque base64url cursor for the next page, or null on last page
 * @property {T[]}          records      - Array of result records for this page
 */

// ─── JSON Schema Objects (for runtime validation) ─────────────────────────────

export const telemetryContracts = {
  LatestVehicleState: {
    title: 'LatestVehicleState',
    type: 'object',
    additionalProperties: false,
    required: ['device_id', 'event_id', 'timestamp', 'received_at', 'buffered'],
    properties: {
      device_id: { type: 'string', minLength: 1 },
      event_id: { type: 'string', minLength: 1 },
      timestamp: { type: 'string', format: 'date-time' },
      received_at: { type: 'string', format: 'date-time' },
      lat: { type: ['number', 'null'] },
      lng: { type: ['number', 'null'] },
      altitude: { type: ['number', 'null'] },
      accuracy: { type: ['number', 'null'] },
      bearing: { type: ['number', 'null'] },
      speed: { type: ['number', 'null'] },
      ignition: { type: ['boolean', 'null'] },
      fuel_level: { type: ['number', 'null'] },
      odometer: { type: ['number', 'null'] },
      rpm: { type: ['integer', 'null'] },
      engine_load: { type: ['number', 'null'] },
      buffered: { type: 'boolean' },
      payload: { type: ['object', 'null'] }
    }
  },
  Alert: {
    title: 'Alert',
    type: 'object',
    additionalProperties: false,
    required: ['alert_id', 'device_id', 'timestamp', 'alert_type', 'severity', 'acknowledged'],
    properties: {
      alert_id: { type: 'string', minLength: 1 },
      device_id: { type: 'string', minLength: 1 },
      timestamp: { type: 'string', format: 'date-time' },
      alert_type: { type: 'string', minLength: 1 },
      severity: { type: 'string', minLength: 1 },
      message: { type: ['string', 'null'] },
      metadata: { type: ['object', 'null'] },
      acknowledged: { type: 'boolean' },
      acknowledged_at: { type: ['string', 'null'], format: 'date-time' },
      position_lat: { type: ['number', 'null'] },
      position_lng: { type: ['number', 'null'] },
      event_id: { type: ['string', 'null'] }
    }
  },
  VehicleHistory: {
    title: 'VehicleHistory',
    type: 'object',
    additionalProperties: false,
    required: ['device_id', 'records'],
    properties: {
      device_id: { type: 'string', minLength: 1 },
      from: { type: ['string', 'null'], format: 'date-time' },
      to: { type: ['string', 'null'], format: 'date-time' },
      limit: { type: 'integer', minimum: 1, maximum: 5000 },
      next_cursor: { type: ['string', 'null'] },
      records: {
        type: 'array',
        items: { $ref: '#/LatestVehicleState' }
      }
    }
  },
  VehicleTimeline: {
    title: 'VehicleTimeline',
    type: 'object',
    additionalProperties: false,
    required: ['device_id', 'records'],
    properties: {
      device_id: { type: 'string', minLength: 1 },
      from: { type: ['string', 'null'], format: 'date-time' },
      to: { type: ['string', 'null'], format: 'date-time' },
      limit: { type: 'integer', minimum: 1, maximum: 5000 },
      next_cursor: { type: ['string', 'null'] },
      records: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'source'],
              properties: {
                kind: { const: 'telemetry' },
                source: { const: 'telemetry' },
                sequence: { type: ['integer', 'null'] }
              }
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'source', 'alert_id', 'device_id', 'timestamp', 'alert_type', 'severity', 'acknowledged'],
              properties: {
                kind: { const: 'alert' },
                source: { const: 'alert' },
                sequence: { type: ['integer', 'null'] },
                alert_id: { type: 'string', minLength: 1 },
                device_id: { type: 'string', minLength: 1 },
                timestamp: { type: 'string', format: 'date-time' },
                alert_type: { type: 'string', minLength: 1 },
                severity: { type: 'string', minLength: 1 },
                message: { type: ['string', 'null'] },
                metadata: { type: ['object', 'null'] },
                acknowledged: { type: 'boolean' },
                acknowledged_at: { type: ['string', 'null'], format: 'date-time' },
                position_lat: { type: ['number', 'null'] },
                position_lng: { type: ['number', 'null'] },
                event_id: { type: ['string', 'null'] }
              }
            }
          ]
        }
      }
    }
  },
  VehicleAlerts: {
    title: 'VehicleAlerts',
    type: 'object',
    additionalProperties: false,
    required: ['records'],
    properties: {
      device_id: { type: ['string', 'null'] },
      from: { type: ['string', 'null'], format: 'date-time' },
      to: { type: ['string', 'null'], format: 'date-time' },
      severity: { type: ['string', 'null'] },
      alert_type: { type: ['string', 'null'] },
      acknowledged: { type: ['boolean', 'null'] },
      limit: { type: 'integer', minimum: 1, maximum: 5000 },
      next_cursor: { type: ['string', 'null'] },
      records: {
        type: 'array',
        items: { $ref: '#/Alert' }
      }
    }
  },
  VehicleDiagnostics: {
    title: 'VehicleDiagnostics',
    type: 'object',
    additionalProperties: false,
    required: ['version', 'device_id', 'latest', 'raw_payload'],
    properties: {
      version: { type: 'string', minLength: 1 },
      device_id: { type: 'string', minLength: 1 },
      latest: {
        type: 'object',
        additionalProperties: false,
        required: ['device_id', 'timestamp', 'received_at', 'buffered'],
        properties: {
          device_id: { type: 'string', minLength: 1 },
          timestamp: { type: 'string', format: 'date-time' },
          received_at: { type: 'string', format: 'date-time' },
          rpm: { type: ['integer', 'null'] },
          engine_load: { type: ['number', 'null'] },
          fuel_level: { type: ['number', 'null'] },
          odometer: { type: ['number', 'null'] },
          buffered: { type: 'boolean' },
          payload: { type: ['object', 'null'] }
        }
      },
      history: { type: ['array', 'null'], items: { $ref: '#/LatestVehicleState' } },
      raw_payload: { type: 'object' }
    }
  },
  FleetSummary: {
    title: 'FleetSummary',
    type: 'object',
    additionalProperties: false,
    required: ['as_of', 'active_window_minutes', 'totals', 'quality', 'alerts', 'devices'],
    properties: {
      as_of: { type: 'string', format: 'date-time' },
      active_window_minutes: { type: 'integer', minimum: 1 },
      totals: {
        type: 'object',
        additionalProperties: false,
        required: ['total_vehicles', 'active_vehicles', 'ignition_on', 'ignition_off', 'low_fuel', 'overspeed', 'buffered'],
        properties: {
          total_vehicles: { type: 'integer', minimum: 0 },
          active_vehicles: { type: 'integer', minimum: 0 },
          ignition_on: { type: 'integer', minimum: 0 },
          ignition_off: { type: 'integer', minimum: 0 },
          low_fuel: { type: 'integer', minimum: 0 },
          overspeed: { type: 'integer', minimum: 0 },
          buffered: { type: 'integer', minimum: 0 }
        }
      },
      quality: {
        type: 'object',
        additionalProperties: false,
        required: ['gps_valid', 'gps_invalid', 'gps_coverage_ratio', 'signal_quality_supported', 'device_health_supported'],
        properties: {
          gps_valid: { type: 'integer', minimum: 0 },
          gps_invalid: { type: 'integer', minimum: 0 },
          gps_coverage_ratio: { type: 'number', minimum: 0, maximum: 1 },
          signal_quality_supported: { type: 'boolean' },
          signal_quality: { type: ['number', 'null'] },
          signal_quality_reason: { type: ['string', 'null'] },
          device_health_supported: { type: 'boolean' },
          device_health: { type: ['number', 'null'], minimum: 0, maximum: 1 },
          device_health_reason: { type: ['string', 'null'] }
        }
      },
      alerts: {
        type: 'object',
        additionalProperties: false,
        required: ['open_alerts', 'alert_count_by_severity', 'alert_count_by_type'],
        properties: {
          open_alerts: { type: 'integer', minimum: 0 },
          alert_count_by_severity: { type: 'object' },
          alert_count_by_type: { type: 'object' }
        }
      },
      devices: {
        type: 'object',
        additionalProperties: false,
        required: ['fresh', 'stale', 'stale_threshold_minutes'],
        properties: {
          fresh: { type: 'integer', minimum: 0 },
          stale: { type: 'integer', minimum: 0 },
          stale_threshold_minutes: { type: 'integer', minimum: 1 }
        }
      }
    }
  }
};

export const telemetryContractNames = Object.freeze(Object.keys(telemetryContracts));
