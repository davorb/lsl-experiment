// One AGI game per room code. The original logic runs on the server; players share the game state.
// Co-op model: the interpreter has a single "ego" (Larry). Whoever last typed a command (or is the
// first player) is its owner; every other player walks their own avatar around the same room and can
// take over Larry by typing a command, at which point Larry swaps places with them.
import type { WebSocket } from 'ws';
import { PIC_H, PIC_W } from '../../../shared/agi/picture';
import { CHAT_MAX, MAX_PLAYERS, NAME_MAX, type ChatEntry, type ClientMessage, type ServerMessage } from '../../../shared/protocol';
import type { AgiFrame, AgiModal } from '../../../shared/agi/protocol';
import { AgiInterp, DX, DY, type Modal } from './interp';
import type { AgiResources } from './resources';

// The original runs one cycle per (animation interval x 50ms); we tick at twice that rate so the default
// pace suits click-to-walk play. The game's own Speed menu still scales it.
const TICK_MS = 25;
const EXPIRY_MS = 10 * 60 * 1000;
const AUTO_ACK_MS = 45_000;
const AVATAR_VIEW = 0;

interface Avatar {
  x: number;
  y: number;
  dir: number;
  loop: number;
  cel: number;
  target: { x: number; y: number } | null;
  path?: { x: number; y: number }[];
}

interface Conn {
  id: string;
  ws: WebSocket;
  name: string;
  lastChat: number;
  avatar: Avatar;
}

export class AgiSession {
  readonly interp: AgiInterp;
  private conns = new Map<string, Conn>();
  private chat: ChatEntry[] = [];
  private nextId = 1;
  private timer: NodeJS.Timeout | null = null;
  private expiry: NodeJS.Timeout | null = null;
  private owner: string | null = null;
  private ticks = 0;
  private cycleDue = 0;
  private cycleGen: Generator<Modal, void, unknown> | null = null;
  private modal: { mid: number; modal: Modal; timer: NodeJS.Timeout | null } | null = null;
  private nextMid = 1;
  private sentPicVersion = -1;
  private lastRoom = -1;
  private startedAt = Date.now();
  private waiting = false;
  private lastFrameText = '';
  private needGather = false;

  constructor(readonly code: string, res: AgiResources, private onDead: (code: string) => void) {
    this.interp = new AgiInterp(res);
    if (process.env.LSL_SKIP_INTRO) this.skipIntro();
  }

  /** Dev aid: use the game's own restart path (flag 6) to skip the title and age quiz and start in room 11. */
  private skipIntro(): void {
    const it = this.interp;
    it.flags[6] = 1;
    for (let i = 0; i < 400 && it.vars[0] !== 11; i++) {
      it.nowMs += TICK_MS * 2;
      const gen = it.cycle();
      let r = gen.next();
      while (!r.done) r = gen.next(undefined);
    }
    for (let i = 0; i < 30; i++) { it.nowMs += TICK_MS * 2; const gen = it.cycle(); let r = gen.next(); while (!r.done) r = gen.next(undefined); }
    this.lastRoom = it.vars[0]!;
  }

  get size(): number {
    return this.conns.size;
  }

  // ---- connections ------------------------------------------------------------------------

  private send(c: Conn, msg: ServerMessage): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }
  private broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const c of this.conns.values()) if (c.ws.readyState === c.ws.OPEN) c.ws.send(text);
  }

  private uniqueName(wanted: string | undefined): string {
    const taken = new Set([...this.conns.values()].map((c) => c.name));
    const clean = (wanted ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, NAME_MAX);
    if (clean && !taken.has(clean)) return clean;
    for (let n = 1; ; n++) if (!taken.has(`Guest${n}`)) return `Guest${n}`;
  }

  join(ws: WebSocket, wantedName: string | undefined): { id: string } | string {
    if (this.conns.size >= MAX_PLAYERS) return 'Room is full.';
    if (this.expiry) { clearTimeout(this.expiry); this.expiry = null; }
    const id = `p${this.nextId++}`;
    const ego = this.interp.objs[0]!;
    const c: Conn = {
      id, ws, name: this.uniqueName(wantedName), lastChat: 0,
      avatar: { x: ego.x, y: ego.y, dir: 0, loop: 2, cel: 0, target: null },
    };
    this.conns.set(id, c);
    if (ego.drawn) this.placeAround();
    this.owner ??= id;
    this.send(c, { type: 'agi_welcome', playerId: id, chat: this.chat });
    this.broadcastPlayers();
    this.send(c, this.picMessage());
    // Music is broadcast once when the game starts it, so a late joiner (or a reload) gets the current
    // sound here; it restarts from the top rather than from where everyone else is.
    if (this.interp.sound) this.send(c, { type: 'agi_sound', n: this.interp.sound.n });
    this.send(c, { type: 'agi_frame', frame: this.frame() });
    if (this.modal) this.send(c, { type: 'agi_modal', mid: this.modal.mid, modal: this.modal.modal as AgiModal, owner: this.owner });
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
    this.pushFrame();
    return { id };
  }

  leave(id: string): void {
    if (!this.conns.delete(id)) return;
    if (this.owner === id) this.owner = [...this.conns.keys()][0] ?? null;
    this.broadcastPlayers();
    this.pushFrame();
    if (this.conns.size === 0) {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.expiry = setTimeout(() => this.onDead(this.code), EXPIRY_MS);
    }
  }

  /** Send the current frame to everyone now (used when players come and go while the game waits on a dialog). */
  private pushFrame(): void {
    const frame = this.frame();
    this.lastFrameText = JSON.stringify(frame);
    this.broadcast({ type: 'agi_frame', frame });
  }

  private broadcastPlayers(): void {
    const players: Record<string, string> = {};
    for (const c of this.conns.values()) players[c.id] = c.name;
    this.broadcast({ type: 'agi_players', players });
  }

  // ---- input --------------------------------------------------------------------------------

  handle(id: string, msg: ClientMessage): void {
    const c = this.conns.get(id);
    if (!c) return;
    switch (msg.type) {
      case 'chat': this.say(c, msg.text); break;
      case 'agi_cmd': {
        if (this.modal) return;
        if (!msg.text.trim()) return;
        this.claimEgo(c);
        this.interp.enterCommand(msg.text.slice(0, 120));
        break;
      }
      case 'agi_dir': {
        if (this.owner === id) this.interp.setDirection(msg.dir);
        else { c.avatar.dir = msg.dir; c.avatar.target = null; c.avatar.path = undefined; }
        break;
      }
      case 'agi_goto': {
        const target = { x: Math.max(0, Math.min(PIC_W - 1, Math.round(msg.x))), y: Math.max(0, Math.min(PIC_H - 1, Math.round(msg.y))) };
        if (this.owner === id) this.interp.setWalkTarget(target);
        else { c.avatar.target = target; c.avatar.path = undefined; c.avatar.dir = 0; }
        break;
      }
      case 'agi_key': {
        if (this.modal) return;
        if (this.owner === id) this.interp.pressKey(msg.ascii, msg.scan);
        break;
      }
      case 'agi_menu': {
        if (this.modal) return;
        this.claimEgo(c);
        this.interp.pressController(msg.controller);
        break;
      }
      case 'agi_ack': this.ack(c, msg.mid, msg.value); break;
      default: break;
    }
  }

  announce(text: string): void {
    this.broadcast({ type: 'chat', entry: { id: 'sys', name: 'Game', text, t: Date.now() } });
  }

  /** Start the game over for everyone connected (scheduled every couple of hours). */
  hardReset(): void {
    if (this.modal) {
      if (this.modal.timer) clearTimeout(this.modal.timer);
      this.broadcast({ type: 'agi_modal_close', mid: this.modal.mid });
      this.modal = null;
    }
    this.cycleGen = null;
    this.waiting = false;
    this.interp.reset();
    this.owner = [...this.conns.keys()][0] ?? null;
    this.lastRoom = -1;
    this.lastFrameText = '';
    this.broadcast({ type: 'agi_sound', n: null });
    this.broadcast(this.picMessage());
    this.broadcast({ type: 'agi_frame', frame: this.frame() });
    this.announce('The game has restarted.');
  }

  /** Hand the ego to this player: Larry swaps places with them. */
  private claimEgo(c: Conn): void {
    if (this.owner === c.id) return;
    const ego = this.interp.objs[0]!;
    if (!this.interp.playerControl || !ego.drawn) { this.owner = c.id; return; }
    const prev = this.owner ? this.conns.get(this.owner) : null;
    if (prev) prev.avatar = { x: ego.x, y: ego.y, dir: 0, loop: ego.loop, cel: 0, target: null };
    const spot = this.interp.snapWalkable(this.interp.celW(ego), this.interp.celH(ego), { x: c.avatar.x, y: c.avatar.y });
    ego.x = spot.x;
    ego.y = spot.y;
    this.interp.vars[6] = 0;
    this.interp.setWalkTarget(null);
    c.avatar.dir = 0;
    c.avatar.target = null;
    this.owner = c.id;
  }

  private say(c: Conn, raw: string): void {
    const jump = /^\/room (\d{1,2})$/.exec(raw.trim());
    if (jump && process.env.LSL_DEV) { this.interp.requestRoom(Number(jump[1])); return; }
    const now = Date.now();
    if (now - c.lastChat < 300) return;
    const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CHAT_MAX);
    if (!text) return;
    c.lastChat = now;
    const entry: ChatEntry = { id: c.id, name: c.name, text, t: now };
    this.chat.push(entry);
    if (this.chat.length > 50) this.chat.shift();
    this.broadcast({ type: 'chat', entry });
  }

  // ---- modals ---------------------------------------------------------------------------------

  private openModal(modal: Modal): void {
    const mid = this.nextMid++;
    const entry = { mid, modal, timer: null as NodeJS.Timeout | null };
    // Plain messages dismiss themselves eventually so an idle table cannot freeze the game forever.
    if (modal.kind === 'print' || modal.kind === 'message' || modal.kind === 'showobj') {
      entry.timer = setTimeout(() => this.resolve(mid, undefined), AUTO_ACK_MS);
    }
    this.modal = entry;
    this.broadcast({ type: 'agi_modal', mid, modal: modal as AgiModal, owner: this.owner });
  }

  private ack(c: Conn, mid: number, value: string | number | undefined): void {
    if (!this.modal || this.modal.mid !== mid) return;
    const kind = this.modal.modal.kind;
    // Prompts belong to the player driving Larry (unless they left).
    if ((kind === 'string' || kind === 'number') && this.owner && this.owner !== c.id) return;
    this.resolve(mid, value);
  }

  private resolve(mid: number, value: string | number | undefined): void {
    const m = this.modal;
    if (!m || m.mid !== mid) return;
    if (m.timer) clearTimeout(m.timer);
    this.modal = null;
    this.broadcast({ type: 'agi_modal_close', mid });
    this.advance(value);
  }

  // ---- the driver -------------------------------------------------------------------------------

  private tick(): void {
    this.ticks++;
    if (this.modal) return; // the game clock stands still while a dialog is open
    this.interp.nowMs += TICK_MS;
    if (this.waiting) { this.waiting = false; this.advance(undefined); return; }
    if (!this.cycleGen) {
      this.cycleDue++;
      const period = Math.max(1, this.interp.vars[10]!);
      if (this.cycleDue < period) return;
      this.cycleDue = 0;
      this.cycleGen = this.interp.cycle();
      this.advance(undefined);
    }
  }

  /** Run the suspended cycle until it finishes or asks for another dialog. */
  private advance(answer: unknown): void {
    if (!this.cycleGen) return;
    try {
      const r = this.cycleGen.next(answer);
      if (!r.done) {
        this.flush(); // show the current picture/text before pausing, not only at the end of a cycle
        if (r.value.kind === 'wait') { this.waiting = true; return; }
        this.openModal(r.value);
        return;
      }
    } catch (err) {
      console.error('AGI interpreter error:', err);
      this.cycleGen = null;
      this.interp.reset();
      return;
    }
    this.cycleGen = null;
    this.afterCycle();
  }

  private afterCycle(): void {
    const it = this.interp;
    const roomChanged = it.vars[0] !== this.lastRoom;
    this.lastRoom = it.vars[0]!;
    const ego = it.objs[0]!;
    // Everyone arrives together, but only once the game hands Larry back (a cutscene may still be moving
    // him): avatars gather on walkable ground around his final spot.
    if (roomChanged) this.needGather = true;
    if (this.needGather && ego.drawn && it.playerControl) { this.needGather = false; this.placeAround(); }
    this.stepAvatars();
    this.flush();
  }

  /** Send pending sounds, a changed picture and a changed frame to everyone. */
  private flush(): void {
    const it = this.interp;
    for (const n of it.soundQueue.splice(0)) this.broadcast({ type: 'agi_sound', n });
    for (const e of it.effects.splice(0)) this.broadcast({ type: 'agi_shake', n: e.n });
    if (it.picVersion !== this.sentPicVersion) this.broadcast(this.picMessage());
    const frame = this.frame();
    const text = JSON.stringify(frame);
    if (text !== this.lastFrameText) { this.lastFrameText = text; this.broadcast({ type: 'agi_frame', frame }); }
  }

  // ---- avatars (non-owner players) --------------------------------------------------------------

  /** Distinct walkable spots around Larry for the other players' avatars. */
  private placeAround(): void {
    const it = this.interp;
    const ego = it.objs[0]!;
    const w = it.celW(ego), h = it.celH(ego);
    const offsets: [number, number][] = [[10, 0], [-10, 0], [0, 8], [0, -8], [20, 0], [-20, 0], [10, 8], [-10, 8], [10, -8], [-10, -8], [0, 16], [30, 0], [-30, 0], [20, 8], [-20, 8], [0, -16]];
    const used = new Set<string>([`${ego.x},${ego.y}`]);
    let k = 0;
    for (const c of this.conns.values()) {
      if (c.id === this.owner) continue;
      let spot = { x: ego.x, y: ego.y };
      for (; k < offsets.length; k++) {
        const o = offsets[k]!;
        const cand = { x: ego.x + o[0], y: ego.y + o[1] };
        if (it.isWalkable(w, h, cand.x, cand.y) && !used.has(`${cand.x},${cand.y}`)) { spot = cand; k++; break; }
      }
      c.avatar = { x: spot.x, y: spot.y, dir: 0, loop: 2, cel: 0, target: null };
      used.add(`${spot.x},${spot.y}`);
    }
  }

  private stepAvatars(): void {
    const it = this.interp;
    const ego = it.objs[0]!;
    const w = it.celW(ego);
    const step = Math.max(1, ego.stepSize);
    for (const c of this.conns.values()) {
      if (c.id === this.owner) continue;
      const a = c.avatar;
      let dir = a.dir;
      if (a.target) {
        if (!a.path) a.path = it.plan(w, it.celH(ego), { x: a.x, y: a.y }, { x: a.target.x - w / 2, y: a.target.y });
        while (a.path.length && a.path[0]!.x === a.x && a.path[0]!.y === a.y) a.path.shift();
        if (!a.path.length) { a.target = null; a.path = undefined; dir = 0; }
        else {
          const wp = a.path[Math.min(step, a.path.length) - 1]!;
          dir = [[8, 1, 2], [7, 0, 3], [6, 5, 4]][Math.sign(wp.y - a.y) + 1]![Math.sign(wp.x - a.x) + 1]!;
        }
        a.dir = dir;
      }
      if (dir === 0) { a.cel = 0; continue; }
      let nx = a.x + DX[dir]! * step, ny = a.y + DY[dir]! * step;
      nx = Math.max(0, Math.min(PIC_W - w, nx));
      ny = Math.max(it.horizon + 1, Math.min(PIC_H - 1, ny));
      let blocked = false;
      for (let i = 0; i < w; i++) {
        const p = it.pic.priority[ny * PIC_W + nx + i]!;
        if (p === 0 || p === 1) blocked = true;
      }
      if (!blocked) { a.x = nx; a.y = ny; }
      a.loop = dir === 1 ? 3 : dir === 5 ? 2 : [6, 7, 8].includes(dir) ? 1 : 0;
      a.cel = (a.cel + 1) % 6;
    }
  }

  // ---- state for clients ------------------------------------------------------------------------

  private picMessage(): ServerMessage {
    const it = this.interp;
    this.sentPicVersion = it.picVersion;
    return { type: 'agi_pic', version: it.picVersion, visual: Buffer.from(it.pic.visual).toString('base64'), priority: Buffer.from(it.pic.priority).toString('base64') };
  }

  private frame(): AgiFrame {
    const it = this.interp;
    return {
      room: it.vars[0]!,
      picVersion: it.picVersion,
      objs: it.visibleObjects(),
      texts: it.texts.filter((t) => t.screen === it.textMode).map(({ row, col, text, fg, bg }) => ({ row, col, text, fg, bg })),
      textMode: it.textMode,
      statusLine: it.statusLine,
      score: it.vars[3]!,
      maxScore: it.vars[7]!,
      soundOn: it.flags[9] === 1,
      accept: it.acceptInput,
      egoOwner: this.owner,
      avatars: [...this.conns.values()]
        .filter((c) => c.id !== this.owner && !this.needGather)
        .map((c) => ({ id: c.id, name: c.name, x: c.avatar.x, y: c.avatar.y, loop: c.avatar.loop, cel: c.avatar.cel })),
      menus: it.menus.map((m) => ({ title: m.title, items: m.items.map((i) => ({ ...i })) })),
    };
  }

  /** For tests and debugging. */
  uptimeMs(): number {
    return Date.now() - this.startedAt;
  }
}

void AVATAR_VIEW;
