-- Set to "auto" so each client resolves to the game server IP dynamically.
-- You can still force a specific host from server settings if needed.
local bridgeHost = "auto"
local bridgePort = 8765
local bridgeUrl = "http://" .. bridgeHost .. ":" .. tostring(bridgePort) .. "/telemetry"
local sendIntervalMs = 250
local originLat = 36.8065
local originLon = 10.1815
local worldScale = 0.00001
local debugEveryN = 20
local chatEveryN = 20

local sentCount = 0
local okCount = 0
local errCount = 0
local waitingTick = 0
local lastChatTick = 0
local configApplied = false
local lastObd = {}

local obdFields = {
    "rpm",
    "engine_rpm",
    "speed_kmh",
    "vehicle_speed",
    "engine_temp_c",
    "coolant_temp_c",
    "engine_oil_temp_c",
    "engine_load_pct",
    "abs_load_pct",
    "throttle_pct",
    "stft_b1_pct",
    "ltft_b1_pct",
    "fuel_pressure_kpa",
    "intake_map_kpa",
    "timing_advance_deg",
    "intake_air_temp_c",
    "maf_gps",
    "runtime_since_engine_start_s",
    "fuel_rail_pressure_rel_kpa",
    "fuel_rail_pressure_direct_kpa",
    "abs_fuel_rail_pressure_kpa",
    "commanded_egr_pct",
    "egr_error_pct",
    "fuel_level",
    "fuel_pct",
    "mileage_km",
    "distance_since_codes_cleared_km",
    "barometric_pressure_kpa",
    "control_module_voltage_v",
    "ambient_air_temp_c",
    "time_since_codes_cleared_s",
    "hybrid_battery_remaining_pct",
    "fuel_injector_timing_deg",
    "fuel_rate_lph",
    "dtc_count",
    "dtc_value",
    "mil_on",
    "distance_since_mil_on_km",
    "time_since_mil_on_s",
    "vin_hash",
    "accel_kmh_s"
}

local function getClientServerIp()
    local ip = nil
    if type(getServerIp) == "function" then
        ip = getServerIp()
    elseif type(getServerIP) == "function" then
        ip = getServerIP()
    end

    if type(ip) ~= "string" then
        return nil
    end

    ip = ip:gsub("^%s+", ""):gsub("%s+$", "")
    if ip == "" then
        return nil
    end
    return ip
end

local function normalizeBridgeHost(host)
    local h = tostring(host or ""):gsub("^%s+", ""):gsub("%s+$", "")
    if h == "" then
        h = "auto"
    end

    local lower = h:lower()
    if lower == "auto" or lower == "0.0.0.0" or lower == "localhost" or lower == "127.0.0.1" then
        local serverIp = getClientServerIp()
        if serverIp and serverIp ~= "" then
            return serverIp
        end
    end

    return h
end

local function rebuildBridgeUrl()
    bridgeUrl = "http://" .. bridgeHost .. ":" .. tostring(bridgePort) .. "/telemetry"
end

local function parseFetchResult(arg2)
    if type(arg2) == "number" then
        return arg2, nil, nil
    end

    if type(arg2) == "table" then
        local errorCode = tonumber(arg2.errorCode or arg2.err or arg2.code or -1) or -1
        local statusCode = tonumber(arg2.statusCode or arg2.status or arg2.httpStatus or -1) or -1
        local success = arg2.success
        if type(success) ~= "boolean" then
            success = nil
        end
        return errorCode, statusCode, success
    end

    return -1, nil, nil
end

local function isFetchOk(errorCode, statusCode, success)
    if type(success) == "boolean" then
        return success
    end
    if statusCode ~= nil and statusCode >= 200 and statusCode < 300 then
        return true
    end
    return errorCode == 0
end

local function bridgeHealthUrl()
    return bridgeUrl:gsub("/telemetry$", "/health")
end

local function setBridgeConfig(host, port)
    local hostStr = normalizeBridgeHost(host)
    if hostStr == "" then
        return
    end

    local portNum = tonumber(port or bridgePort) or bridgePort
    bridgeHost = hostStr
    bridgePort = portNum
    rebuildBridgeUrl()
    configApplied = true

    outputDebugString("[fmc003_bridge] bridge config from server: " .. bridgeHost .. ":" .. tostring(bridgePort))
    outputChatBox("[fmc003_bridge] endpoint: " .. bridgeUrl, 180, 220, 255)
end

local function checkBridgeHealth()
    fetchRemote(
        bridgeHealthUrl(),
        {
            method = "GET",
            queueName = "fmc003-health",
            connectionAttempts = 1,
            connectTimeout = 1000
        },
        function(responseData, arg2)
            local errorCode, statusCode, success = parseFetchResult(arg2)
            if isFetchOk(errorCode, statusCode, success) then
                outputDebugString("[fmc003_bridge] bridge health ok: " .. tostring(responseData))
                outputChatBox(
                    "[fmc003_bridge] bridge health ok (status=" .. tostring(statusCode) .. ")",
                    120,
                    255,
                    120
                )
            else
                outputDebugString(
                    "[fmc003_bridge] bridge health failed err=" .. tostring(errorCode) ..
                    " status=" .. tostring(statusCode) ..
                    " success=" .. tostring(success),
                    2
                )
                outputChatBox(
                    "[fmc003_bridge] bridge health failed err=" .. tostring(errorCode) ..
                    " status=" .. tostring(statusCode),
                    255,
                    80,
                    80
                )
            end
        end
    )
end

addEvent("fmc003_bridge:config", true)
addEventHandler("fmc003_bridge:config", resourceRoot, function(host, port)
    setBridgeConfig(host, port)
    checkBridgeHealth()
end)

addEvent("fmc003_bridge:obd", true)
addEventHandler("fmc003_bridge:obd", resourceRoot, function(snapshot)
    if type(snapshot) ~= "table" then
        return
    end
    lastObd = snapshot
end)

local function toLatLon(x, y)
    local lat = originLat + (y * worldScale)
    local lon = originLon + (x * worldScale)
    return lat, lon
end

local function getVehicleSpeedKmh(vehicle)
    local vx, vy, vz = getElementVelocity(vehicle)
    local speed = math.sqrt(vx * vx + vy * vy + vz * vz) * 180.0
    return speed
end

local function tableToJson(tbl)
    -- Manually build JSON object string to ensure proper format
    local parts = {}
    table.insert(parts, "{")
    local first = true
    for k, v in pairs(tbl) do
        if not first then
            table.insert(parts, ",")
        end
        first = false
        
        -- Key with quotes
        table.insert(parts, '"' .. tostring(k) .. '"')
        table.insert(parts, ":")
        
        -- Value based on type
        local valType = type(v)
        if valType == "string" then
            table.insert(parts, '"' .. tostring(v) .. '"')
        elseif valType == "number" then
            table.insert(parts, tostring(v))
        elseif valType == "boolean" then
            table.insert(parts, v and "true" or "false")
        else
            table.insert(parts, "null")
        end
    end
    table.insert(parts, "}")
    return table.concat(parts)
end

local function sendTelemetry()
    if not isElement(localPlayer) then
        return
    end

    local vehicle = getPedOccupiedVehicle(localPlayer)
    if not vehicle then
        waitingTick = waitingTick + 1
        if waitingTick >= 20 then
            waitingTick = 0
            outputDebugString("[fmc003_bridge] waiting for local player to enter a vehicle")
            outputChatBox("[fmc003_bridge] waiting for vehicle...", 255, 200, 0)
        end
        return
    end
    waitingTick = 0

    local x, y, z = getElementPosition(vehicle)
    local _, _, rz = getElementRotation(vehicle)
    local speedKmh = getVehicleSpeedKmh(vehicle)
    local ignition = getVehicleEngineState(vehicle)
    local zoneName = getZoneName(x, y, z, false)
    local cityName = getZoneName(x, y, z, true)

    local lat, lon = toLatLon(x, y)

    local payload = {
        playerId = getPlayerName(localPlayer),
        latitude = lat,
        longitude = lon,
        worldX = x,
        worldY = y,
        worldZ = z,
        zoneName = zoneName,
        cityName = cityName,
        speedKmh = speedKmh,
        angleDeg = rz,
        ignition = ignition,
        source = "mta"
    }

    for _, field in ipairs(obdFields) do
        local value = lastObd[field]
        if value ~= nil then
            payload[field] = value
        end
    end

    local body = tableToJson(payload)
    sentCount = sentCount + 1

    -- Pull fresh OBD-like metrics from server for realism; payload uses latest snapshot.
    triggerServerEvent("fmc003_bridge:requestObd", resourceRoot)
    
    fetchRemote(
        bridgeUrl,
        {
            method = "POST",
            postData = body,
            headers = {
                ["Content-Type"] = "application/json"
            },
            queueName = "fmc003-bridge",
            connectionAttempts = 1,
            connectTimeout = 500
        },
        function(responseData, arg2)
            local errorCode, statusCode, success = parseFetchResult(arg2)
            if not isFetchOk(errorCode, statusCode, success) then
                errCount = errCount + 1
                outputDebugString(
                    "[fmc003_bridge] send failed err=" .. tostring(errorCode) ..
                    " status=" .. tostring(statusCode) ..
                    " success=" .. tostring(success),
                    2
                )
                local now = getTickCount()
                if now - lastChatTick > 2000 then
                    lastChatTick = now
                    outputChatBox(
                        "[fmc003_bridge] send failed err=" .. tostring(errorCode) ..
                        " status=" .. tostring(statusCode),
                        255,
                        80,
                        80
                    )
                end
                return
            end

            okCount = okCount + 1
            if (sentCount % debugEveryN) == 0 then
                outputDebugString(
                    "[fmc003_bridge] sent=" .. tostring(sentCount) ..
                    " ok=" .. tostring(okCount) ..
                    " err=" .. tostring(errCount) ..
                    " lastResponse=" .. tostring(responseData)
                )
            end
            if (sentCount % chatEveryN) == 0 then
                outputChatBox(
                    "[fmc003_bridge] sent=" .. tostring(sentCount) ..
                    " ok=" .. tostring(okCount) ..
                    " err=" .. tostring(errCount),
                    120,
                    255,
                    120
                )
            end
        end
    )
end

addEventHandler("onClientResourceStart", resourceRoot, function()
    -- Apply local fallback first so every client has a usable endpoint immediately.
    setBridgeConfig(bridgeHost, bridgePort)
    rebuildBridgeUrl()
    outputChatBox("FMC003 bridge resource started. Sending telemetry every " .. tostring(sendIntervalMs) .. "ms", 0, 255, 0)
    outputDebugString("[fmc003_bridge] resource started; telemetry URL=" .. bridgeUrl)
    outputChatBox("[fmc003_bridge] endpoint: " .. bridgeUrl, 180, 220, 255)

    -- Ask server for authoritative endpoint so all players use the same bridge host/port.
    triggerServerEvent("fmc003_bridge:requestConfig", resourceRoot)

    -- Health check now runs after endpoint is applied.
    checkBridgeHealth()

    -- In case server config event is delayed, keep fallback endpoint active.
    setTimer(function()
        if not configApplied then
            setBridgeConfig(bridgeHost, bridgePort)
            checkBridgeHealth()
        end
    end, 1500, 1)

    setTimer(sendTelemetry, sendIntervalMs, 0)
end)

addEventHandler("onClientVehicleEnter", root, function(player, seat)
    if player == localPlayer and seat == 0 then
        outputDebugString("[fmc003_bridge] driver seat entered; telemetry active")
        outputChatBox("[fmc003_bridge] driver seat entered; telemetry active", 120, 255, 120)
    end
end)
