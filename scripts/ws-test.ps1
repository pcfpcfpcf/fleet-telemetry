param(
  [string]$Url = "ws://localhost:3001",
  [int]$DurationSeconds = 20
)

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$cts = [System.Threading.CancellationTokenSource]::new()

try {
  $uri = [System.Uri]::new($Url)
  $ws.ConnectAsync($uri, $cts.Token).GetAwaiter().GetResult()
  Write-Output "CONNECTED $Url"

  $buffer = New-Object byte[] 8192
  $segment = [System.ArraySegment[byte]]::new($buffer)
  $start = [DateTime]::UtcNow

  while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open -and (([DateTime]::UtcNow - $start).TotalSeconds -lt $DurationSeconds)) {
    $result = $ws.ReceiveAsync($segment, $cts.Token).GetAwaiter().GetResult()
    if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
      Write-Output "DISCONNECTED"
      break
    }

    $count = $result.Count
    $message = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $count)
    Write-Output "MESSAGE $message"
  }
}
catch {
  Write-Error $_.Exception.Message
}
finally {
  if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
    try {
      $closeStatus = [System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure
      $ws.CloseOutputAsync($closeStatus, "done", [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    }
    catch {
      # Ignore close race conditions; test already captured messages.
    }
  }
  $ws.Dispose()
  $cts.Dispose()
}
