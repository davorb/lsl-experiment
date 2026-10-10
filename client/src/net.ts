import { ServerMessageSchema, parseWith, type ClientMessage, type ServerMessage } from '../../shared/protocol';

export class Net {
  private ws: WebSocket | null = null;
  onMessage: (m: ServerMessage) => void = () => {};
  onClose: () => void = () => {};

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws = ws;
      // A proxy can leave a socket "connecting" forever while the server is down: give up after a few seconds.
      const timer = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) { ws.close(); reject(new Error('Could not reach the server.')); } }, 4000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Could not reach the server.')); };
      ws.onclose = () => { if (this.ws === ws) this.onClose(); };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        const msg = parseWith(ServerMessageSchema, e.data);
        if (msg) this.onMessage(msg);
        else console.warn('dropped malformed server frame');
      };
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
