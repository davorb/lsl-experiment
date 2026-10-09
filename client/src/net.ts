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
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not reach the server.'));
      ws.onclose = () => this.onClose();
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
