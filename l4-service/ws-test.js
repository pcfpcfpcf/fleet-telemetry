import { WebSocket } from 'ws';

const WS_URL = process.env.WS_URL || 'ws://localhost:3001';

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log(`CONNECTED ${WS_URL}`);
});

ws.on('message', (data) => {
  try {
    const parsed = JSON.parse(data.toString());
    const type = parsed?.type || 'unknown';
    if (type === 'telemetry') {
      console.log(`TELEMETRY ${parsed.event?.device_id || 'unknown'} ${parsed.event?.timestamp || ''}`);
    } else if (type === 'alert') {
      console.log(`ALERT ${parsed.alert_type || 'unknown'} ${parsed.device_id || 'unknown'} ${parsed.ts || ''}`);
    } else {
      console.log(`MESSAGE ${data.toString()}`);
    }
  } catch {
    console.log(`MESSAGE ${data.toString()}`);
  }
});

ws.on('close', () => {
  console.log('DISCONNECTED');
});

ws.on('error', (err) => {
  console.error(`ERROR ${err.message}`);
});
