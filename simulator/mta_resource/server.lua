local function getBridgeConfig()
    local host = tostring(get("fmc003_bridge.bridgeHost") or "127.0.0.1")
    local port = tonumber(get("fmc003_bridge.bridgePort") or 8765) or 8765
    return host, port
end

local obdStateByVehicle = {}

local function clamp(v, lo, hi)
    if v < lo then
        return lo
    end
    if v > hi then
        return hi
    end
    return v
end

local function getVehicleSpeedKmh(vehicle)
    local vx, vy, vz = getElementVelocity(vehicle)
    return math.sqrt(vx * vx + vy * vy + vz * vz) * 180.0
end

local function getVehicleState(vehicle)
    local id = tostring(vehicle)
    local now = getTickCount() / 1000.0
    local state = obdStateByVehicle[id]
    if not state then
        state = {
            lastTs = now,
            lastSpeed = 0.0,
            fuelPct = 78.0,
            runtime = 0.0,
            engineTemp = 72.0,
            coolantTemp = 70.0,
            oilTemp = 76.0,
            dtcCount = 0,
            dtcValue = 0,
            milOn = false,
            sinceCodesSec = 0.0,
            sinceCodesKm = 0.0,
            sinceMilSec = 0.0,
            sinceMilKm = 0.0,
            odometerKm = 0.0,
            vinHash = tonumber(id:match("%x+"), 16) or math.random(1000000, 9999999)
        }
        obdStateByVehicle[id] = state
    end
    return state, now
end

local function buildObdSnapshot(vehicle)
    local state, now = getVehicleState(vehicle)
    local dt = math.max(0.05, now - state.lastTs)
    state.lastTs = now

    local speed = getVehicleSpeedKmh(vehicle)
    local ignition = getVehicleEngineState(vehicle)
    local accel = (speed - state.lastSpeed) / dt
    state.lastSpeed = speed

    local traveledKm = math.max(0.0, speed) * (dt / 3600.0)
    state.odometerKm = state.odometerKm + traveledKm
    state.sinceCodesKm = state.sinceCodesKm + traveledKm
    state.sinceCodesSec = state.sinceCodesSec + dt

    local throttlePct = clamp(speed * 1.2 + math.max(0.0, accel) * 3.0, 0.0, 100.0)
    local rpm = ignition and clamp(780.0 + throttlePct * 28.0, 700.0, 4500.0) or 0.0
    local engineLoad = clamp(throttlePct * 0.88, 0.0, 100.0)
    local absLoad = clamp(engineLoad * 1.08, 0.0, 100.0)

    if ignition then
        state.runtime = state.runtime + dt
        state.fuelPct = clamp(state.fuelPct - (0.00035 + throttlePct * 0.00002) * dt, 0.0, 100.0)
        local tgtTemp = 87.0 + throttlePct * 0.05
        state.engineTemp = state.engineTemp + (tgtTemp - state.engineTemp) * math.min(1.0, dt * 0.25)
        state.coolantTemp = state.coolantTemp + (state.engineTemp - state.coolantTemp) * math.min(1.0, dt * 0.22)
        state.oilTemp = state.oilTemp + ((state.engineTemp + 6.0) - state.oilTemp) * math.min(1.0, dt * 0.14)
    else
        state.runtime = 0.0
        state.engineTemp = state.engineTemp - dt * 0.4
        state.coolantTemp = state.coolantTemp - dt * 0.35
        state.oilTemp = state.oilTemp - dt * 0.3
    end

    if state.engineTemp > 108.0 then
        state.dtcCount = 1
        state.dtcValue = 0x0215
        state.milOn = true
    elseif state.fuelPct < 4.0 then
        state.dtcCount = 1
        state.dtcValue = 0x0087
        state.milOn = true
    elseif math.abs(accel) > 14.0 and speed > 45.0 then
        state.dtcCount = 1
        state.dtcValue = 0x0300
        state.milOn = true
    else
        state.dtcCount = 0
        state.dtcValue = 0
        state.milOn = false
    end

    if state.milOn then
        state.sinceMilSec = state.sinceMilSec + dt
        state.sinceMilKm = state.sinceMilKm + traveledKm
    else
        state.sinceMilSec = 0.0
        state.sinceMilKm = 0.0
    end

    local baro = clamp(101.0 - (math.random() * 1.2), 94.0, 103.0)
    local intakeMap = clamp(25.0 + throttlePct * 0.72, 20.0, baro)
    local maf = clamp((rpm / 60.0) * (throttlePct / 100.0) * 0.95, 0.0, 220.0)
    local railRel = clamp(3600.0 + throttlePct * 92.0, 3000.0, 18000.0)
    local railDir = clamp(railRel + 2200.0, 3500.0, 21000.0)

    return {
        rpm = math.floor(rpm + 0.5),
        engine_rpm = math.floor(rpm + 0.5),
        speed_kmh = speed,
        vehicle_speed = speed,
        engine_temp_c = state.engineTemp,
        coolant_temp_c = state.coolantTemp,
        engine_oil_temp_c = state.oilTemp,
        engine_load_pct = engineLoad,
        abs_load_pct = absLoad,
        throttle_pct = throttlePct,
        stft_b1_pct = clamp((throttlePct - 48.0) * 0.18, -25.0, 25.0),
        ltft_b1_pct = clamp((throttlePct - 48.0) * 0.07, -20.0, 20.0),
        fuel_pressure_kpa = clamp(250.0 + throttlePct * 2.3, 220.0, 500.0),
        intake_map_kpa = intakeMap,
        timing_advance_deg = clamp(8.0 + rpm / 1000.0 * 2.0, -10.0, 40.0),
        intake_air_temp_c = clamp(22.0 + throttlePct * 0.11, 15.0, 70.0),
        maf_gps = maf,
        runtime_since_engine_start_s = state.runtime,
        fuel_rail_pressure_rel_kpa = railRel,
        fuel_rail_pressure_direct_kpa = railDir,
        abs_fuel_rail_pressure_kpa = railDir,
        commanded_egr_pct = ignition and clamp(9.0 + speed * 0.22, 0.0, 60.0) or 0.0,
        egr_error_pct = clamp(math.abs(accel) * 1.3, 0.0, 20.0),
        fuel_level = state.fuelPct,
        fuel_pct = state.fuelPct,
        mileage_km = state.odometerKm,
        distance_since_codes_cleared_km = state.sinceCodesKm,
        barometric_pressure_kpa = baro,
        control_module_voltage_v = ignition and 12.6 or 12.1,
        ambient_air_temp_c = clamp(24.0 + math.sin(now / 500.0) * 3.0, 8.0, 45.0),
        time_since_codes_cleared_s = state.sinceCodesSec,
        hybrid_battery_remaining_pct = 0.0,
        fuel_injector_timing_deg = clamp(4.0 + throttlePct * 0.33, 0.0, 50.0),
        fuel_rate_lph = ignition and clamp(0.8 + throttlePct * 0.12, 0.0, 40.0) or 0.0,
        dtc_count = state.dtcCount,
        dtc_value = state.dtcValue,
        mil_on = state.milOn and 1 or 0,
        distance_since_mil_on_km = state.sinceMilKm,
        time_since_mil_on_s = state.sinceMilSec,
        vin_hash = state.vinHash,
        accel_kmh_s = accel
    }
end

addEvent("fmc003_bridge:requestConfig", true)
addEventHandler("fmc003_bridge:requestConfig", resourceRoot, function()
    local host, port = getBridgeConfig()
    triggerClientEvent(client, "fmc003_bridge:config", resourceRoot, host, port)
end)

addEvent("fmc003_bridge:requestObd", true)
addEventHandler("fmc003_bridge:requestObd", resourceRoot, function()
    local player = client
    if not isElement(player) then
        return
    end

    local vehicle = getPedOccupiedVehicle(player)
    if not isElement(vehicle) then
        return
    end

    local snapshot = buildObdSnapshot(vehicle)
    triggerClientEvent(player, "fmc003_bridge:obd", resourceRoot, snapshot)
end)

addEventHandler("onResourceStart", resourceRoot, function()
    local host, port = getBridgeConfig()
    outputServerLog("[fmc003_bridge] server config bridge=" .. host .. ":" .. tostring(port))

    for _, player in ipairs(getElementsByType("player")) do
        triggerClientEvent(player, "fmc003_bridge:config", resourceRoot, host, port)
    end

    setTimer(function()
        for _, player in ipairs(getElementsByType("player")) do
            local vehicle = getPedOccupiedVehicle(player)
            if isElement(vehicle) then
                local snapshot = buildObdSnapshot(vehicle)
                triggerClientEvent(player, "fmc003_bridge:obd", resourceRoot, snapshot)
            end
        end
    end, 300, 0)
end)
