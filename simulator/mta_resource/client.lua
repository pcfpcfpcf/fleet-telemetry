-- If MTA client and bridge run on the same PC, keep 127.0.0.1.
-- If bridge runs on another PC, set bridgeHost to that machine's LAN IP (for example 192.168.1.50).
local bridgeHost = "127.0.0.1"
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

    local lat, lon = toLatLon(x, y)

    local payload = {
        playerId = getPlayerName(localPlayer),
        latitude = lat,
        longitude = lon,
        speedKmh = speedKmh,
        angleDeg = rz,
        ignition = ignition,
        source = "mta"
    }

    local body = tableToJson(payload)
    sentCount = sentCount + 1
    
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
    outputChatBox("FMC003 bridge resource started. Sending telemetry every " .. tostring(sendIntervalMs) .. "ms", 0, 255, 0)
    outputDebugString("[fmc003_bridge] resource started; telemetry URL=" .. bridgeUrl)
    outputChatBox("[fmc003_bridge] endpoint: " .. bridgeUrl, 180, 220, 255)

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

    setTimer(sendTelemetry, sendIntervalMs, 0)
end)

addEventHandler("onClientVehicleEnter", root, function(player, seat)
    if player == localPlayer and seat == 0 then
        outputDebugString("[fmc003_bridge] driver seat entered; telemetry active")
        outputChatBox("[fmc003_bridge] driver seat entered; telemetry active", 120, 255, 120)
    end
end)
