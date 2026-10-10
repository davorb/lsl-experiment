import type { WebSocket } from 'ws';
import {
  CHAT_MAX, MAX_PLAYERS, NAME_MAX, TICK_HZ,
  scaleAt,
  type ChatEntry, type Facing, type Flags, type Player, type Pt, type ServerMessage, type SessionState, type Verb,
} from '../../shared/protocol';
import { inRect } from './geometry';
import { itemLookText, loadIndex, loadRoom, makeText, runScript, type ScriptContext } from './content';

const WALK_SPEED = 70; // native px/s at scale 1.0
const EXPIRY_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 200;

interface Exit { to: string; spawn: Pt }

interface Conn {
  id: string;
  ws: WebSocket;
  p: Player;
  path: Pt[];
  pendingExit: Exit | null;
  pendingVerb: { hotspotId: string; verb: Verb } | null;
  seq: number;
  lastChat: number;
  dirty: boolean; // moved or changed anim this tick
}

export class Session {
  readonly code: string;
  private conns = new Map<string, Conn>();
  private flags: Flags = {};
  private inventory: string[] = [];
  private chat: ChatEntry[] = [];
  private nextId = 1;
  private timer: NodeJS.Timeout | null = null;
  private expiry: NodeJS.Timeout | null = null;
  private hostId: string | null = null; // first socket; informational, the server process is the authority
  private startRoom: string;

  constructor(code: string, private onDead: (code: string) => void) {
    this.code = code;
    const idx = loadIndex();
    this.startRoom = idx.start;
    this.flags = { ...(idx.startFlags ?? {}) };
    this.inventory = [...(idx.startInventory ?? [])];
  }

  get size(): number {
    return this.conns.size;
  }

  private send(c: Conn, msg: ServerMessage): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }
  private broadcast(msg: ServerMessage, except?: string): void {
    const text = JSON.stringify(msg);
    for (const c of this.conns.values()) if (c.id !== except && c.ws.readyState === c.ws.OPEN) c.ws.send(text);
  }

  private state(forRoom: string): SessionState {
    const players: Record<string, Player> = {};
    for (const c of this.conns.values()) players[c.id] = c.p;
    return { roomId: forRoom, players, flags: this.flags, inventory: this.inventory, chat: this.chat };
  }

  private uniqueName(wanted: string | undefined): string {
    const taken = new Set([...this.conns.values()].map((c) => c.p.name));
    const clean = (wanted ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, NAME_MAX);
    if (clean && !taken.has(clean)) return clean;
    for (let n = 1; ; n++) if (!taken.has(`Guest${n}`)) return `Guest${n}`;
  }

  private spawnPoint(roomId: string): Pt {
    const lr = loadRoom(roomId);
    if (!lr) return [160, 120];
    const xs = lr.walk.poly.map((p) => p[0]), ys = lr.walk.poly.map((p) => p[1]);
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    return lr.walk.snap([x, Math.max(...ys) - 8]);
  }

  join(ws: WebSocket, wantedName: string | undefined): Conn | string {
    if (this.conns.size >= MAX_PLAYERS) return 'Room is full.';
    if (!loadRoom(this.startRoom)) return `Start room "${this.startRoom}" is missing from content/rooms.`;
    if (this.expiry) { clearTimeout(this.expiry); this.expiry = null; }
    const id = `p${this.nextId++}`;
    const [x, y] = this.spawnPoint(this.startRoom);
    const c: Conn = {
      id, ws, path: [], pendingExit: null, pendingVerb: null, seq: 0, lastChat: 0, dirty: false,
      p: { name: this.uniqueName(wantedName), x, y, facing: 'down', roomId: this.startRoom, anim: 'idle' },
    };
    this.hostId ??= id;
    this.conns.set(id, c);
    this.send(c, { type: 'welcome', playerId: id, state: this.state(this.startRoom) });
    this.broadcast({ type: 'patch', players: { [id]: c.p } }, id);
    this.timer ??= setInterval(() => this.tick(1 / TICK_HZ), 1000 / TICK_HZ);
    return c;
  }

  leave(id: string): void {
    if (!this.conns.delete(id)) return;
    this.broadcast({ type: 'patch', players: { [id]: null } });
    if (this.conns.size === 0) {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.expiry = setTimeout(() => this.onDead(this.code), EXPIRY_MS);
    }
  }

  // ---- input ---------------------------------------------------------------------

  input(id: string, seq: number, tx: number, ty: number): void {
    const c = this.conns.get(id);
    const lr = c && loadRoom(c.p.roomId);
    if (!c || !lr || !Number.isFinite(tx) || !Number.isFinite(ty)) return;
    c.seq = seq;
    c.pendingExit = null;
    c.pendingVerb = null;
    // Clicking an exit walks to the nearest walkable point, then leaves on arrival.
    const exit = lr.room.exits.find((e) => inRect(tx, ty, e.rect) && this.exitOpen(e.requires));
    if (exit) c.pendingExit = { to: exit.to, spawn: exit.spawn };
    c.path = lr.walk.find([c.p.x, c.p.y], [tx, ty]);
    if (c.path.length) this.setAnim(c, 'walk');
  }

  private exitOpen(requires: string | undefined): boolean {
    return !requires || Boolean(this.flags[requires]);
  }

  private setAnim(c: Conn, anim: Player['anim']): void {
    if (c.p.anim !== anim) { c.p.anim = anim; c.dirty = true; }
  }

  private tick(dt: number): void {
    const moves: Record<string, { x: number; y: number; facing: Facing; anim: Player['anim']; seq: number }> = {};
    for (const c of this.conns.values()) {
      const lr = loadRoom(c.p.roomId);
      if (!lr) continue;
      if (c.path.length) {
        let budget = WALK_SPEED * scaleAt(lr.room, c.p.y) * dt;
        while (budget > 0 && c.path.length) {
          const [tx, ty] = c.path[0]!;
          const dx = tx - c.p.x, dy = ty - c.p.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 0.01) c.p.facing = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
          if (dist <= budget) { c.p.x = tx; c.p.y = ty; budget -= dist; c.path.shift(); }
          else { c.p.x += (dx / dist) * budget; c.p.y += (dy / dist) * budget; budget = 0; }
        }
        c.dirty = true;
        if (!c.path.length) {
          this.setAnim(c, 'idle');
          const pv = c.pendingVerb;
          c.pendingVerb = null;
          if (pv) void this.runVerb(c, pv.hotspotId, pv.verb);
        }
        // Walking onto an open exit rect leaves the room; so does arriving after clicking one.
        const hit = lr.room.exits.find((e) => inRect(c.p.x, c.p.y, e.rect) && this.exitOpen(e.requires));
        const target: Exit | null = hit ? { to: hit.to, spawn: hit.spawn } : !c.path.length ? c.pendingExit : null;
        if (target) { this.changeRoom(c, target); continue; }
      }
      if (c.dirty) {
        moves[c.id] = { x: c.p.x, y: c.p.y, facing: c.p.facing, anim: c.p.anim, seq: c.seq };
        c.dirty = false;
      }
    }
    if (Object.keys(moves).length) this.broadcast({ type: 'move', t: Date.now(), players: moves });
  }

  private changeRoom(c: Conn, to: Exit): void {
    const dest = loadRoom(to.to);
    if (!dest) return;
    c.path = [];
    c.pendingExit = null;
    c.pendingVerb = null;
    c.p = { ...c.p, roomId: to.to, x: to.spawn[0], y: to.spawn[1], anim: 'idle' };
    c.dirty = false;
    this.broadcast({ type: 'patch', players: { [c.id]: c.p } });
  }

  // ---- verbs and chat --------------------------------------------------------------

  /** use/talk walk to the hotspot first (point-and-click); look is immediate. */
  async verb(id: string, hotspotId: string, verb: Verb): Promise<void> {
    const c = this.conns.get(id);
    const lr = c && loadRoom(c.p.roomId);
    if (!c || !lr) return;
    if (hotspotId.startsWith('item:')) {
      const item = hotspotId.slice(5);
      if (this.inventory.includes(item)) this.send(c, { type: 'result', actorId: id, hotspotId, verb: 'look', say: itemLookText(item, this.flags) });
      return;
    }
    const hs = lr.room.hotspots.find((h) => h.id === hotspotId);
    if (!hs) return;
    if (verb !== 'look' && verb !== 'walk') {
      const stand = lr.walk.snap(hs.at ?? [(hs.rect[0] + hs.rect[2]) / 2, hs.rect[3]]);
      if (Math.hypot(stand[0] - c.p.x, stand[1] - c.p.y) > 8) {
        c.pendingExit = null;
        c.path = lr.walk.find([c.p.x, c.p.y], stand);
        c.pendingVerb = { hotspotId, verb };
        if (c.path.length) { this.setAnim(c, 'walk'); return; }
        c.pendingVerb = null;
      }
    }
    await this.runVerb(c, hotspotId, verb);
  }

  private async runVerb(c: Conn, hotspotId: string, verb: Verb): Promise<void> {
    await this.exec(c, hotspotId, verb);
  }

  /** Answer to a dialogue `choices` list from an earlier result. */
  async choose(id: string, hotspotId: string, choice: string): Promise<void> {
    const c = this.conns.get(id);
    if (c) await this.exec(c, hotspotId, 'choose', choice);
  }

  private async exec(c: Conn, hotspotId: string, verb: Verb | 'choose', choice?: string): Promise<void> {
    const id = c.id;
    const lr = loadRoom(c.p.roomId);
    const hs = lr?.room.hotspots.find((h) => h.id === hotspotId);
    if (!lr || !hs) return;
    let say: string | undefined;
    let choices: { id: string; label: string }[] | undefined;
    let go: { room: string; spawn: Pt } | undefined;
    try {
      const ctx: ScriptContext = {
        state: structuredClone({ roomId: c.p.roomId, players: this.state(c.p.roomId).players, flags: this.flags, inventory: this.inventory }),
        actorId: id,
        hotspotId,
        choice,
        text: makeText(this.flags),
      };
      const res = hs.script ? await runScript(hs.script, verb, ctx) : undefined;
      if (res) {
        say = res.say;
        choices = res.choices;
        go = res.go;
        const patch: ServerMessage = { type: 'patch' };
        if (res.flags) { Object.assign(this.flags, res.flags); patch.flags = res.flags; }
        if (res.inventory) {
          const remove = new Set(res.inventory.remove ?? []);
          this.inventory = this.inventory.filter((i) => !remove.has(i));
          for (const a of res.inventory.add ?? []) if (!this.inventory.includes(a)) this.inventory.push(a);
          patch.inventory = this.inventory;
        }
        if (res.pose) {
          const p = res.pose;
          c.path = [];
          c.pendingExit = null;
          c.pendingVerb = null;
          c.p = { ...c.p, anim: p.anim, x: p.x ?? c.p.x, y: p.y ?? c.p.y, facing: p.facing ?? c.p.facing };
          patch.players = { [id]: c.p };
        }
        if (patch.flags || patch.inventory || patch.players) this.broadcast(patch);
      }
    } catch (err) {
      console.error(`script ${hs.script} (${verb}) failed:`, err);
      say = 'Something goes wrong.';
    }
    if (say === undefined && go && !choices) { this.changeRoom(c, { to: go.room, spawn: go.spawn }); return; }
    if (say === '' && !choices) { if (go) this.changeRoom(c, { to: go.room, spawn: go.spawn }); return; }
    if (verb === 'choose' && say === undefined && !choices) return;
    say ??= verb === 'look' ? (hs.name ? `It's a ${hs.name}.` : 'Nothing special.') : "That doesn't work.";
    const base = { type: 'result' as const, actorId: id, hotspotId, verb: verb === 'choose' ? ('talk' as const) : verb, say };
    for (const o of this.conns.values()) {
      if (o.p.roomId !== c.p.roomId) continue;
      this.send(o, o.id === id && choices?.length ? { ...base, choices } : base);
    }
    if (go) this.changeRoom(c, { to: go.room, spawn: go.spawn });
  }

  say(id: string, raw: string): void {
    const c = this.conns.get(id);
    if (!c) return;
    const now = Date.now();
    if (now - c.lastChat < 300) return;
    const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CHAT_MAX);
    if (!text) return;
    c.lastChat = now;
    const entry: ChatEntry = { id, name: c.p.name, text, t: now };
    this.chat.push(entry);
    if (this.chat.length > 50) this.chat.shift();
    this.broadcast({ type: 'chat', entry });
  }

  get host(): string | null {
    return this.hostId;
  }
}

export class Registry {
  private sessions = new Map<string, Session>();

  getOrCreate(code: string): Session | null {
    let s = this.sessions.get(code);
    if (!s) {
      if (this.sessions.size >= MAX_SESSIONS) return null;
      s = new Session(code, (c) => this.sessions.delete(c));
      this.sessions.set(code, s);
    }
    return s;
  }
}
