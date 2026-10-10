import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClientMessageSchema, CODE_RE, parseWith, type ServerMessage } from '../../shared/protocol';
import { CONTENT_DIR, ROOT } from './content';
import { Registry } from './session';

const PORT = Number(process.env.PORT ?? 8787);
const DIST = path.join(ROOT, 'client', 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
};
// Only these parts of content/ are served; scripts stay server-side.
const CONTENT_PUBLIC = /^\/(index\.json|(rooms|backgrounds|sprites|masks)\/[\w./-]+|agi\/(pic|snd|view)\/\d+\.bin)$/;

function serveFile(res: http.ServerResponse, file: string): boolean {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p.includes('..')) { res.writeHead(400).end(); return; }
  if (p.startsWith('/content/')) {
    const sub = p.slice('/content'.length);
    if (CONTENT_PUBLIC.test(sub) && serveFile(res, path.join(CONTENT_DIR, sub))) return;
    res.writeHead(404).end('not found');
    return;
  }
  if (serveFile(res, path.join(DIST, p === '/' ? 'index.html' : p))) return;
  if (serveFile(res, path.join(DIST, 'index.html'))) return;
  res.writeHead(404, { 'content-type': 'text/plain' }).end('Client not built. Run `npm run dev` (Vite) or `npm run build`.');
});

const registry = new Registry();
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });

function reply(ws: WebSocket, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  let session: ReturnType<Registry['getOrCreate']> = null;
  let playerId: string | null = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = parseWith(ClientMessageSchema, data.toString());
    if (!msg) return; // unknown fields / bad shape: drop, never crash

    if (msg.type === 'hello') {
      if (session) return;
      const code = msg.code.trim().toUpperCase();
      if (!CODE_RE.test(code)) return reply(ws, { type: 'error', message: 'Room code must be 4 letters.' });
      const s = registry.getOrCreate(code);
      if (!s) return reply(ws, { type: 'error', message: 'Server is full.' });
      const joined = s.join(ws, msg.name);
      if (typeof joined === 'string') return reply(ws, { type: 'error', message: joined });
      session = s;
      playerId = joined.id;
      return;
    }
    if (!session || !playerId) return;
    session.handle(playerId, msg);
  });

  ws.on('close', () => {
    if (session && playerId) session.leave(playerId);
  });
  ws.on('error', () => ws.close());
});

server.listen(PORT, () => console.log(`[server] http+ws on :${PORT}  (content: ${CONTENT_DIR})`));
