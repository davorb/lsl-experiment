// AGI v2 logic interpreter. Runs the original game bytecode; the surrounding session turns its
// output (pictures, animated objects, text) into network messages for the co-op clients.
//
// Execution is generator-based so a command that waits for the player (print, get.string, ...)
// can suspend the whole logic stack and resume when somebody answers.
import { PIC_H, PIC_W, PicBuffers, drawPicture } from '../../../shared/agi/picture';
import type { ParsedLogic } from '../../../shared/agi/logic';
import { matchSaid, parseLine, type ParsedLine } from './parser';
import { findPath, nearestWalkable, walkable, type Pt } from './pathfind';
import type { AgiResources } from './resources';

export const DX = [0, 0, 1, 1, 1, 0, -1, -1, -1];
export const DY = [0, -1, -1, 0, 1, 1, 1, 0, -1];

// Argument counts of the action commands (index = opcode).
const ARGC = [0,1,1,2,2,2,2,2,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,1,1,0,1,1,1,1,0,1,1,3,3,3,3,2,2,2,2,1,1,2,2,2,2,2,2,2,2,2,1,2,1,1,1,1,1,1,1,1,1,1,1,3,1,1,1,2,1,2,2,1,1,2,2,5,5,3,1,1,2,2,1,1,4,0,1,1,1,2,2,2,1,2,0,1,1,3,3,3,0,0,1,2,1,3,0,0,2,5,2,1,2,0,0,3,7,7,0,0,0,0,0,1,3,0,0,1,1,0,0,0,0,0,0,0,1,1,1,0,0,3,3,0,3,4,4,1,5,2,1,2,0,1,1,0,1,0,0,2,2,2,2,0];
const TEST_ARGC: Record<number, number> = { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 1, 8: 1, 9: 1, 10: 2, 11: 5, 12: 1, 13: 0, 15: 2, 16: 5, 17: 5, 18: 5 };

export type Modal =
  | { kind: 'print'; text: string; row?: number; col?: number; width?: number }
  | { kind: 'string'; prompt: string; len: number }
  | { kind: 'number'; prompt: string }
  | { kind: 'inventory'; items: { id: number; name: string }[]; select: boolean }
  | { kind: 'showobj'; view: number; name: string; desc: string }
  | { kind: 'message'; text: string }
  /** Not shown to players: a backward jump (a polling loop) yields so the host can deliver input. */
  | { kind: 'wait' };

interface Pending { modal: Modal; then?: (answer: unknown) => void }

export interface ViewObj {
  animated: boolean;
  drawn: boolean;
  updating: boolean;
  cycling: boolean;
  motion: 'none' | 'normal' | 'wander' | 'follow' | 'move';
  view: number;
  loop: number;
  cel: number;
  x: number;
  y: number;
  dir: number;
  stepSize: number;
  stepTime: number;
  stepCount: number;
  cycleTime: number;
  cycleCount: number;
  cycleType: 'normal' | 'endofloop' | 'reverse' | 'reverseloop';
  cycleFlag: number;
  fixedPri: boolean;
  priority: number;
  fixLoop: boolean;
  ignoreHorizon: boolean;
  ignoreObjs: boolean;
  ignoreBlocks: boolean;
  surface: 'any' | 'water' | 'land';
  targetX: number;
  targetY: number;
  targetStep: number;
  targetFlag: number;
  stuck: number;
  wanderCount: number;
  /** Priority band the wanderer started in (0 = unrestricted); see stepObject. */
  wanderPri: number;
}

const newObj = (): ViewObj => ({
  animated: false, drawn: false, updating: true, cycling: true, motion: 'none', view: 0, loop: 0, cel: 0, x: 0, y: 0, dir: 0,
  stepSize: 1, stepTime: 1, stepCount: 0, cycleTime: 1, cycleCount: 0, cycleType: 'normal', cycleFlag: 0, fixedPri: false, priority: 0,
  fixLoop: false, ignoreHorizon: false, ignoreObjs: false, ignoreBlocks: false, surface: 'any', targetX: 0, targetY: 0, targetStep: 1, targetFlag: 0,
  stuck: 0, wanderCount: 0, wanderPri: 0,
});

export type PicOp = { kind: 'draw' | 'overlay'; pic: number } | { kind: 'add'; view: number; loop: number; cel: number; x: number; y: number; pri: number };

export interface DisplayText { row: number; col: number; text: string; fg: number; bg: number; screen: boolean }
export interface MenuDef { title: string; items: { text: string; controller: number; enabled: boolean }[] }

class NewRoomSignal {}
class GameRestart {}

export const priorityFromY = (y: number): number => (y < 48 ? 4 : Math.min(14, Math.floor((y - 48) / 12) + 5));
const dirFromDelta = (dx: number, dy: number): number => [[8, 1, 2], [7, 0, 3], [6, 5, 4]][Math.sign(dy || 0) + 1]![Math.sign(dx || 0) + 1]!;

export class AgiInterp {
  vars = new Uint8Array(256);
  flags = new Uint8Array(256);
  strings: string[] = Array.from({ length: 24 }, () => '');
  objs: ViewObj[] = Array.from({ length: 64 }, newObj);
  items: { name: string; room: number }[] = [];
  pic = new PicBuffers();
  picOps: PicOp[] = [];
  picVersion = 0;
  horizon = 36;
  playerControl = true;
  acceptInput = true;
  statusLine = false;
  textMode = false;
  texts: DisplayText[] = [];
  menus: MenuDef[] = [];
  textFg = 15;
  textBg = 0;
  block: { x1: number; y1: number; x2: number; y2: number } | null = null;
  soundQueue: (number | null)[] = [];
  sound: { n: number; flag: number; endsAt: number } | null = null;
  nowMs = 0;
  saveSlots: string[] = [];
  gameId = '';
  restartRequested = false;
  quitRequested = false;
  // goto-target for click-to-walk (AGI coordinates)
  walkTarget: { x: number; y: number } | null = null;
  private walkPath: Pt[] | null = null;
  private walkStuck = 0;
  private walkRetries = 0;
  private lastEgoX = -1;
  private lastEgoY = -1;

  private keyMap = new Map<string, number>();
  private controllers = new Set<number>();
  private keyHit = false;
  private line: ParsedLine | null = null;
  private lineText = '';
  private pendingLine: string | null = null;
  private lastMenuTitle = -1;
  private cycleNo = 0;
  private lastClockMs = 0;
  private pendingRoom: number | null = null;
  /** set.scan.start: where each logic resumes (instead of at its top) until reset.scan.start or a new room. */
  private scanStart = new Map<number, number>();
  effects: { kind: 'shake'; n: number }[] = [];
  /** Source of randomness for the game's random() command; tests inject a seeded one. */
  rng: () => number = Math.random;

  constructor(readonly res: AgiResources) {
    this.reset();
  }

  reset(): void {
    this.vars.fill(0);
    this.flags.fill(0);
    this.strings = Array.from({ length: 24 }, () => '');
    this.objs = Array.from({ length: 64 }, newObj);
    this.items = this.res.objects.map((o) => ({ name: o.name, room: o.room }));
    this.pic.clear();
    this.picOps = [];
    this.horizon = 36;
    this.playerControl = true;
    this.acceptInput = true;
    this.statusLine = false;
    this.textMode = false;
    this.texts = [];
    this.menus = [];
    this.block = null;
    this.sound = null;
    this.keyMap.clear();
    this.scanStart.clear();
    this.vars[10] = 2; // animation interval
    this.vars[22] = 1; // sound type
    this.vars[23] = 15; // volume
    this.vars[24] = 40; // input buffer
    this.vars[26] = 3; // EGA monitor
    this.vars[8] = 255;
    this.flags[9] = 1; // sound on
    const ego = this.objs[0]!;
    Object.assign(ego, newObj(), { animated: true, updating: true, motion: 'normal' });
    this.picVersion++;
  }

  // ---- host-facing API ------------------------------------------------------------

  /** Dev aid: jump to a room at the start of the next cycle. */
  requestRoom(n: number): void {
    this.pendingRoom = n;
  }

  /** Queue a typed command; it is parsed at the start of the next cycle. */
  enterCommand(text: string): void {
    if (this.acceptInput) this.pendingLine = text;
  }
  pressController(c: number): void {
    this.controllers.add(c);
  }
  /** Key event from the client (function keys etc.): maps through set.key and records have.key. */
  pressKey(ascii: number, scan: number): void {
    const c = this.keyMap.get(`${ascii}:${scan}`) ?? this.keyMap.get(`${ascii}:0`) ?? this.keyMap.get(`0:${scan}`);
    // A key bound to a controller is consumed by that binding, so it does not also satisfy have.key().
    if (c !== undefined) { this.controllers.add(c); return; }
    this.keyHit = true;
    this.vars[19] = ascii & 0xff;
  }
  /** Click-to-walk: aim the ego at a point (centre of the sprite, AGI units). Pathfinding runs on the next cycle. */
  setWalkTarget(t: { x: number; y: number } | null): void {
    this.walkTarget = t;
    this.walkPath = null;
    this.walkStuck = 0;
    this.walkRetries = 0;
    if (t && this.playerControl) this.vars[6] = 0;
  }

  private planOpts(w: number, h: number, ignoreHorizon = false) {
    return { pri: this.pic.priority, w, h, horizon: this.horizon, ignoreHorizon, block: this.block };
  }
  isWalkable(w: number, h: number, x: number, y: number): boolean {
    return walkable(this.planOpts(w, h), x, y);
  }
  /** The walkable position nearest to p for a sprite of this size (p itself if already valid). */
  snapWalkable(w: number, h: number, p: Pt): Pt {
    return nearestWalkable(this.planOpts(w, h), p) ?? p;
  }

  /** Plan a path for a sprite of the given size (used for the other players' avatars too). */
  plan(w: number, h: number, from: Pt, to: Pt, ignoreHorizon = false): Pt[] {
    return findPath({ pri: this.pic.priority, w, h, horizon: this.horizon, ignoreHorizon, block: this.block }, from, to);
  }

  /** Direction from arrow keys (0 = stop). Only applies while the player is in control. */
  setDirection(d: number): void {
    this.setWalkTarget(null);
    if (this.playerControl) this.vars[6] = d;
  }

  /** Run one interpreter cycle. Yields modal requests; the caller resumes with the player's answer. */
  *cycle(): Generator<Modal, void, unknown> {
    this.cycleNo++;
    this.tickClock();
    if (this.pendingRoom !== null) {
      const n = this.pendingRoom;
      this.pendingRoom = null;
      try { this.newRoom(n); } catch (e) { if (!(e instanceof NewRoomSignal)) throw e; }
    }
    // Input line -> flags/word ids.
    if (this.pendingLine !== null) {
      const text = this.pendingLine;
      this.pendingLine = null;
      this.line = parseLine(text, this.res.vocab);
      this.lineText = text;
      this.vars[9] = this.line.unknown;
      if (this.line.ids.length || this.line.unknown) this.flags[2] = 1;
    }
    this.driveEgo();
    let guard = 0;
    for (;;) {
      try {
        yield* this.runLogic(0);
        break;
      } catch (e) {
        if (e instanceof NewRoomSignal && guard++ < 20) continue;
        if (e instanceof GameRestart) { this.reset(); return; }
        throw e;
      }
    }
    this.flags[5] = 0;
    this.flags[2] = 0;
    this.flags[4] = 0;
    this.line = null;
    this.controllers.clear();
    this.keyHit = false;
    this.vars[2] = 0; this.vars[4] = 0; this.vars[5] = 0;
    this.updateObjects();
    if (this.sound && this.nowMs >= this.sound.endsAt) {
      this.flags[this.sound.flag] = 1;
      this.sound = null;
    }
  }

  /** Game clock: variables 11-14 hold seconds, minutes, hours and days. */
  private tickClock(): void {
    while (this.nowMs - this.lastClockMs >= 1000) {
      this.lastClockMs += 1000;
      const v = this.vars;
      v[11] = v[11]! + 1;
      if (v[11]! >= 60) { v[11] = 0; v[12] = v[12]! + 1; }
      if (v[12]! >= 60) { v[12] = 0; v[13] = v[13]! + 1; }
      if (v[13]! >= 24) { v[13] = 0; v[14] = (v[14]! + 1) & 255; }
    }
  }

  /** Ego direction: variable 6 drives it under player control, otherwise it mirrors the object. */
  private driveEgo(): void {
    const ego = this.objs[0]!;
    if (this.playerControl) {
      if (this.walkTarget && ego.drawn) this.followWalkTarget(ego);
      ego.dir = this.vars[6]! <= 8 ? this.vars[6]! : 0;
      if (ego.motion === 'none' || ego.motion === 'move' && !ego.drawn) ego.motion = 'normal';
    } else {
      this.vars[6] = ego.dir;
    }
  }

  private followWalkTarget(ego: ViewObj): void {
    const w = this.celW(ego), h = this.celH(ego);
    const goal = { x: this.walkTarget!.x - w / 2, y: this.walkTarget!.y };
    if (!this.walkPath) {
      this.walkPath = this.plan(w, h, { x: ego.x, y: ego.y }, goal, ego.ignoreHorizon);
      if (!this.walkPath.length) { this.setWalkTarget(null); this.vars[6] = 0; return; }
    }
    const step = Math.max(1, ego.stepSize);
    // Advance only when exactly on a waypoint: cutting corners can step into a barrier the path went around.
    while (this.walkPath.length && this.walkPath[0]!.x === ego.x && this.walkPath[0]!.y === ego.y) this.walkPath.shift();
    if (!this.walkPath.length) { this.setWalkTarget(null); this.vars[6] = 0; return; }
    // Blocked by something the planner cannot see (a moving object): re-plan a few times, then give up.
    if (ego.x === this.lastEgoX && ego.y === this.lastEgoY) {
      if (++this.walkStuck > 8) {
        this.walkStuck = 0;
        if (++this.walkRetries > 3) { this.setWalkTarget(null); this.vars[6] = 0; return; }
        this.walkPath = this.plan(w, h, { x: ego.x, y: ego.y }, goal, ego.ignoreHorizon);
        if (!this.walkPath.length) { this.setWalkTarget(null); this.vars[6] = 0; return; }
      }
    } else this.walkStuck = 0;
    this.lastEgoX = ego.x;
    this.lastEgoY = ego.y;
    const wp = this.walkPath[Math.min(step, this.walkPath.length) - 1]!;
    this.vars[6] = dirFromDelta(wp.x - ego.x, wp.y - ego.y);
  }

  // ---- logic execution --------------------------------------------------------------

  private logic(n: number): ParsedLogic {
    const l = this.res.logic(n);
    if (!l) throw new Error(`missing logic ${n}`);
    return l;
  }

  private *runLogic(n: number): Generator<Modal, void, unknown> {
    const lg = this.logic(n);
    const code = lg.code;
    let pc = this.scanStart.get(n) ?? 0;
    while (pc < code.length) {
      const op = code[pc++]!;
      if (op === 0) return;
      if (op === 0xff) {
        const r = this.evalConds(code, pc, lg);
        pc = r.pc;
        const len = code[pc]! | (code[pc + 1]! << 8);
        pc += 2;
        if (!r.ok) pc += len;
        continue;
      }
      if (op === 0xfe) {
        const off = (code[pc]! | (code[pc + 1]! << 8)) << 16 >> 16;
        pc += 2 + off;
        if (off < 0) yield { kind: 'wait' };
        continue;
      }
      const argc = ARGC[op];
      if (argc === undefined) throw new Error(`bad opcode ${op} in logic ${n}`);
      const a = code.subarray(pc, pc + argc);
      pc += argc;
      if (op === 145) { this.scanStart.set(n, pc); continue; }
      if (op === 146) { this.scanStart.delete(n); continue; }
      if (op === 22) { yield* this.runLogic(a[0]!); continue; }
      if (op === 23) { yield* this.runLogic(this.vars[a[0]!]!); continue; }
      const pending = this.exec(op, a, lg);
      if (pending) {
        const ans = yield pending.modal;
        pending.then?.(ans);
      }
    }
  }

  private evalConds(code: Uint8Array, start: number, lg: ParsedLogic): { ok: boolean; pc: number } {
    let pc = start;
    let ok = true;
    let inOr = false;
    let orAny = false;
    let not = false;
    for (;;) {
      const t = code[pc++]!;
      if (t === 0xff) break;
      if (t === 0xfc) {
        if (!inOr) { inOr = true; orAny = false; } else { inOr = false; if (!orAny) ok = false; }
        continue;
      }
      if (t === 0xfd) { not = !not; continue; }
      let skip = (!inOr && !ok) || (inOr && orAny);
      let v = false;
      if (t === 14) {
        const n = code[pc++]!;
        const pattern: number[] = [];
        for (let i = 0; i < n; i++) { pattern.push(code[pc]! | (code[pc + 1]! << 8)); pc += 2; }
        if (!skip) v = this.testSaid(pattern);
      } else {
        const argc = TEST_ARGC[t];
        if (argc === undefined) throw new Error(`bad test ${t}`);
        const a = code.subarray(pc, pc + argc);
        pc += argc;
        if (!skip) v = this.test(t, a);
      }
      if (!skip) {
        if (not) v = !v;
        if (inOr) { if (v) orAny = true; } else if (!v) ok = false;
      }
      not = false;
      skip = false;
    }
    void lg;
    return { ok, pc };
  }

  private testSaid(pattern: number[]): boolean {
    if (!this.flags[2] || this.flags[4] || !this.line) return false;
    if (this.line.unknown) return false;
    if (!matchSaid(pattern, this.line.ids)) return false;
    this.flags[4] = 1;
    return true;
  }

  private test(t: number, a: Uint8Array): boolean {
    const v = this.vars;
    switch (t) {
      case 1: return v[a[0]!] === a[1]!;
      case 2: return v[a[0]!] === v[a[1]!];
      case 3: return v[a[0]!]! < a[1]!;
      case 4: return v[a[0]!]! < v[a[1]!]!;
      case 5: return v[a[0]!]! > a[1]!;
      case 6: return v[a[0]!]! > v[a[1]!]!;
      case 7: return this.flags[a[0]!] === 1;
      case 8: return this.flags[v[a[0]!]!] === 1;
      case 9: return this.items[a[0]!]?.room === 255;
      case 10: return this.items[a[0]!]?.room === v[a[1]!];
      case 11: { const o = this.objs[a[0]!]!; return o.x >= a[1]! && o.y >= a[2]! && o.x <= a[3]! && o.y <= a[4]!; }
      case 12: return this.controllers.has(a[0]!);
      case 13: return this.keyHit;
      case 15: return this.strings[a[0]!]!.trim().toLowerCase() === this.strings[a[1]!]!.trim().toLowerCase();
      case 16: { const o = this.objs[a[0]!]!; return o.x >= a[1]! && o.y >= a[2]! && o.x + this.celW(o) - 1 <= a[3]! && o.y <= a[4]!; }
      case 17: { const o = this.objs[a[0]!]!; const cx = o.x + (this.celW(o) >> 1); return cx >= a[1]! && o.y >= a[2]! && cx <= a[3]! && o.y <= a[4]!; }
      case 18: { const o = this.objs[a[0]!]!; const rx = o.x + this.celW(o) - 1; return rx >= a[1]! && o.y >= a[2]! && rx <= a[3]! && o.y <= a[4]!; }
      default: return false;
    }
  }

  // ---- messages -----------------------------------------------------------------------

  private fmt(lg: ParsedLogic, s: string, depth = 0): string {
    if (!s.includes('%')) return s;
    return s.replace(/%([vsmgw])(\d+)(?:\|(\d+))?/g, (_m, kind: string, num: string, width?: string) => {
      const n = Number(num);
      switch (kind) {
        case 'v': {
          const text = String(this.vars[n] ?? 0);
          return width ? text.padStart(Number(width), '0') : text;
        }
        case 's': return this.strings[n] ?? '';
        case 'm': return depth < 4 ? this.fmt(lg, lg.messages[n] ?? '', depth + 1) : '';
        case 'g': return depth < 4 ? this.fmt(lg, this.logic(0).messages[n] ?? '', depth + 1) : '';
        case 'w': return this.line?.texts[n - 1] ?? '';
        default: return '';
      }
    });
  }
  private msg(lg: ParsedLogic, n: number): string {
    return this.fmt(lg, lg.messages[n] ?? '');
  }

  // ---- command execution ----------------------------------------------------------------

  private exec(op: number, a: Uint8Array, lg: ParsedLogic): Pending | void {
    const v = this.vars;
    const f = this.flags;
    const obj = (i: number) => this.objs[i]!;
    switch (op) {
      case 1: v[a[0]!] = Math.min(255, v[a[0]!]! + 1); return;
      case 2: v[a[0]!] = Math.max(0, v[a[0]!]! - 1); return;
      case 3: v[a[0]!] = a[1]!; return;
      case 4: v[a[0]!] = v[a[1]!]!; return;
      case 5: v[a[0]!] = (v[a[0]!]! + a[1]!) & 255; return;
      case 6: v[a[0]!] = (v[a[0]!]! + v[a[1]!]!) & 255; return;
      case 7: v[a[0]!] = (v[a[0]!]! - a[1]!) & 255; return;
      case 8: v[a[0]!] = (v[a[0]!]! - v[a[1]!]!) & 255; return;
      case 9: v[v[a[0]!]!] = v[a[1]!]!; return;
      case 10: v[a[0]!] = v[v[a[1]!]!]!; return;
      case 11: v[v[a[0]!]!] = a[1]!; return;
      case 12: f[a[0]!] = 1; return;
      case 13: f[a[0]!] = 0; return;
      case 14: f[a[0]!] = f[a[0]!] ? 0 : 1; return;
      case 15: f[v[a[0]!]!] = 1; return;
      case 16: f[v[a[0]!]!] = 0; return;
      case 17: { const i = v[a[0]!]!; f[i] = f[i] ? 0 : 1; return; }
      case 18: return this.newRoom(a[0]!);
      case 19: return this.newRoom(v[a[0]!]!);
      case 20: case 21: return; // load.logics
      case 24: case 27: return; // load.pic / discard.pic
      case 25: { const n = v[a[0]!]!; this.pic.clear(); this.picOps = [{ kind: 'draw', pic: n }]; this.drawPic(n); this.picVersion++; return; }
      case 26: return; // show.pic
      case 28: { const n = v[a[0]!]!; this.picOps.push({ kind: 'overlay', pic: n }); this.drawPic(n); this.picVersion++; return; }
      case 29: return; // show.pri.screen
      case 30: case 31: case 32: case 153: return; // load/discard view
      case 33: {
        const o = obj(a[0]!);
        if (o.animated) return;
        Object.assign(o, newObj(), { animated: true, view: o.view, loop: o.loop, cel: o.cel, x: o.x, y: o.y });
        return;
      }
      case 34: for (let i = 1; i < this.objs.length; i++) { this.objs[i]!.animated = false; this.objs[i]!.drawn = false; } return;
      case 35: { const o = obj(a[0]!); if (!o.drawn) { o.drawn = true; this.clampObject(o); } return; }
      case 36: obj(a[0]!).drawn = false; return;
      case 37: { const o = obj(a[0]!); o.x = a[1]!; o.y = a[2]!; return; }
      case 38: { const o = obj(a[0]!); o.x = v[a[1]!]!; o.y = v[a[2]!]!; return; }
      case 39: { const o = obj(a[0]!); v[a[1]!] = o.x; v[a[2]!] = o.y; return; }
      case 40: { const o = obj(a[0]!); o.x += (v[a[1]!]! << 24) >> 24; o.y += (v[a[2]!]! << 24) >> 24; return; }
      case 41: this.setView(obj(a[0]!), a[1]!); return;
      case 42: this.setView(obj(a[0]!), v[a[1]!]!); return;
      case 43: this.setLoop(obj(a[0]!), a[1]!, true); return;
      case 44: this.setLoop(obj(a[0]!), v[a[1]!]!, true); return;
      case 45: obj(a[0]!).fixLoop = true; return;
      case 46: obj(a[0]!).fixLoop = false; return;
      case 47: this.setCel(obj(a[0]!), a[1]!); return;
      case 48: this.setCel(obj(a[0]!), v[a[1]!]!); return;
      case 49: { const o = obj(a[0]!); v[a[1]!] = Math.max(0, this.cels(o) - 1); return; }
      case 50: v[a[1]!] = obj(a[0]!).cel; return;
      case 51: v[a[1]!] = obj(a[0]!).loop; return;
      case 52: v[a[1]!] = obj(a[0]!).view; return;
      case 53: v[a[1]!] = this.res.view(obj(a[0]!).view)?.loops.length ?? 0; return;
      case 54: { const o = obj(a[0]!); o.fixedPri = true; o.priority = a[1]!; return; }
      case 55: { const o = obj(a[0]!); o.fixedPri = true; o.priority = v[a[1]!]!; return; }
      case 56: obj(a[0]!).fixedPri = false; return;
      case 57: { const o = obj(a[0]!); v[a[1]!] = o.fixedPri ? o.priority : priorityFromY(o.y); return; }
      case 58: obj(a[0]!).updating = false; return;
      case 59: case 60: obj(a[0]!).updating = true; return;
      case 61: obj(a[0]!).ignoreHorizon = true; return;
      case 62: obj(a[0]!).ignoreHorizon = false; return;
      case 63: this.horizon = a[0]!; return;
      case 64: obj(a[0]!).surface = 'water'; return;
      case 65: obj(a[0]!).surface = 'land'; return;
      case 66: obj(a[0]!).surface = 'any'; return;
      case 67: obj(a[0]!).ignoreObjs = true; return;
      case 68: obj(a[0]!).ignoreObjs = false; return;
      case 69: {
        const p = obj(a[0]!), q = obj(a[1]!);
        v[a[2]!] = p.drawn && q.drawn ? Math.min(254, Math.abs(p.x - q.x) + Math.abs(p.y - q.y)) : 255;
        return;
      }
      case 70: obj(a[0]!).cycling = false; return;
      case 71: obj(a[0]!).cycling = true; return;
      case 72: { const o = obj(a[0]!); o.cycleType = 'normal'; o.cycling = true; return; }
      case 73: { const o = obj(a[0]!); o.cycleType = 'endofloop'; o.cycleFlag = a[1]!; o.cycling = true; f[a[1]!] = 0; return; }
      case 74: { const o = obj(a[0]!); o.cycleType = 'reverse'; o.cycling = true; return; }
      case 75: { const o = obj(a[0]!); o.cycleType = 'reverseloop'; o.cycleFlag = a[1]!; o.cycling = true; f[a[1]!] = 0; return; }
      case 76: obj(a[0]!).cycleTime = Math.max(1, v[a[1]!]!); return;
      case 77: { const o = obj(a[0]!); o.motion = 'none'; o.dir = 0; if (a[0] === 0) { v[6] = 0; this.playerControl = false; } return; }
      case 78: { const o = obj(a[0]!); o.motion = 'normal'; if (a[0] === 0) this.playerControl = true; return; }
      case 79: obj(a[0]!).stepSize = v[a[1]!]!; return;
      case 80: obj(a[0]!).stepTime = Math.max(1, v[a[1]!]!); return;
      case 81: this.moveObj(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!); return;
      case 82: this.moveObj(a[0]!, v[a[1]!]!, v[a[2]!]!, v[a[3]!]!, a[4]!); return;
      case 83: { const o = obj(a[0]!); o.motion = 'follow'; o.targetStep = a[1]! || o.stepSize; o.targetFlag = a[2]!; f[a[2]!] = 0; if (a[0] === 0) this.playerControl = false; return; }
      case 84: { const o = obj(a[0]!); o.motion = 'wander'; o.wanderCount = 0; o.wanderPri = this.wanderBand(o); if (a[0] === 0) this.playerControl = false; return; }
      case 85: obj(a[0]!).motion = 'normal'; return;
      case 86: obj(a[0]!).dir = v[a[1]!]! <= 8 ? v[a[1]!]! : 0; return;
      case 87: v[a[1]!] = obj(a[0]!).dir; return;
      case 88: obj(a[0]!).ignoreBlocks = true; return;
      case 89: obj(a[0]!).ignoreBlocks = false; return;
      case 90: this.block = { x1: a[0]!, y1: a[1]!, x2: a[2]!, y2: a[3]! }; return;
      case 91: this.block = null; return;
      case 92: { const it = this.items[a[0]!]; if (it) it.room = 255; return; }
      case 93: { const it = this.items[v[a[0]!]!]; if (it) it.room = 255; return; }
      case 94: { const it = this.items[a[0]!]; if (it) it.room = 0; return; }
      case 95: { const it = this.items[a[0]!]; if (it) it.room = a[1]!; return; }
      case 96: { const it = this.items[a[0]!]; if (it) it.room = v[a[1]!]!; return; }
      case 97: v[a[1]!] = this.items[v[a[0]!]!]?.room ?? 0; return;
      case 98: return; // load.sound
      case 99: {
        const s = this.res.sound(a[0]!);
        f[a[1]!] = 0;
        this.soundQueue.push(a[0]!);
        this.sound = { n: a[0]!, flag: a[1]!, endsAt: this.nowMs + (s ? s.length * 1000 : 0) };
        if (!s) { f[a[1]!] = 1; this.sound = null; }
        return;
      }
      case 100: { if (this.sound) { f[this.sound.flag] = 1; this.sound = null; } this.soundQueue.push(null); return; }
      case 101: return { modal: { kind: 'print', text: this.msg(lg, a[0]!) } };
      case 102: return { modal: { kind: 'print', text: this.msg(lg, v[a[0]!]!) } };
      case 151: return { modal: { kind: 'print', text: this.msg(lg, a[0]!), row: a[1], col: a[2], width: a[3] } };
      case 152: return { modal: { kind: 'print', text: this.msg(lg, v[a[0]!]!), row: v[a[1]!], col: v[a[2]!], width: v[a[3]!] } };
      case 103: this.display(a[0]!, a[1]!, this.msg(lg, a[2]!)); return;
      case 104: this.display(v[a[0]!]!, v[a[1]!]!, this.msg(lg, v[a[2]!]!)); return;
      case 105: this.texts = this.texts.filter((t) => t.row < a[0]! || t.row > a[1]!); return;
      case 106: this.textMode = true; return;
      case 107: this.textMode = false; this.texts = this.texts.filter((t) => !t.screen); return;
      case 108: return; // set.cursor.char
      case 109: this.textFg = a[0]!; this.textBg = a[1]!; return;
      case 110: this.effects.push({ kind: 'shake', n: a[0]! }); return;
      case 111: return; // configure.screen
      case 112: this.statusLine = true; return;
      case 113: this.statusLine = false; return;
      case 114: this.strings[a[0]!] = this.msg(lg, a[1]!); return;
      case 115: {
        const dest = a[0]!;
        return { modal: { kind: 'string', prompt: this.msg(lg, a[1]!), len: a[4]! }, then: (ans) => { this.strings[dest] = String(ans ?? '').slice(0, a[4]!); } };
      }
      case 116: this.strings[a[1]!] = this.line?.texts[v[a[0]!]! - 1] ?? ''; return;
      case 117: {
        this.line = parseLine(this.strings[a[0]!]!, this.res.vocab);
        v[9] = this.line.unknown;
        if (this.line.ids.length || this.line.unknown) { f[2] = 1; f[4] = 0; }
        return;
      }
      case 118: {
        const dest = a[1]!;
        return { modal: { kind: 'number', prompt: this.msg(lg, a[0]!) }, then: (ans) => { v[dest] = Math.max(0, Math.min(255, Number(ans) || 0)); } };
      }
      case 119: this.acceptInput = false; return;
      case 120: this.acceptInput = true; return;
      case 121: this.keyMap.set(`${a[0]}:${a[1]}`, a[2]!); return;
      case 122: this.addToPic(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!, a[6]!); return;
      case 123: this.addToPic(v[a[0]!]!, v[a[1]!]!, v[a[2]!]!, v[a[3]!]!, v[a[4]!]!, v[a[5]!]!, v[a[6]!]!); return;
      case 124: {
        const items = this.items.map((it, id) => ({ id, name: it.name, room: it.room })).filter((it) => it.room === 255 && it.id !== 0);
        const select = f[13] === 1;
        return { modal: { kind: 'inventory', items: items.map(({ id, name }) => ({ id, name })), select }, then: (ans) => { if (select) v[25] = typeof ans === 'number' ? ans : 255; } };
      }
      case 125: { this.saveSlots[0] = this.snapshot(); return { modal: { kind: 'message', text: 'Game saved.' } }; }
      case 126: {
        const snap = this.saveSlots[0];
        if (!snap) return { modal: { kind: 'message', text: 'There is no saved game to restore.' } };
        this.restore(snap);
        return { modal: { kind: 'message', text: 'Game restored.' } };
      }
      case 127: return; // init.disk
      case 128: this.restartRequested = true; throw new GameRestart();
      case 129: return this.showObj(a[0]!);
      case 130: v[a[2]!] = a[0]! + Math.floor(this.rng() * (a[1]! - a[0]! + 1)); return;
      case 131: this.playerControl = false; return;
      case 132: this.playerControl = true; return;
      case 133: return; // obj.status.v
      case 134: this.quitRequested = true; return { modal: { kind: 'message', text: 'Thanks for playing. The game will restart.' }, then: () => { this.reset(); throw new GameRestart(); } };
      case 135: return; // show.mem
      case 136: return { modal: { kind: 'message', text: 'Game paused.' } };
      case 137: case 138: case 139: case 140: return;
      case 141: return; // version
      case 142: return; // script.size
      case 143: this.gameId = this.msg(lg, a[0]!); return;
      case 144: return; // log
      case 145: case 146: return;
      case 147: { const o = obj(a[0]!); o.x = a[1]!; o.y = a[2]!; return; }
      case 148: { const o = obj(a[0]!); o.x = v[a[1]!]!; o.y = v[a[2]!]!; return; }
      case 149: case 150: return;
      case 154: case 155: return;
      case 156: this.menus.push({ title: this.msg(lg, a[0]!), items: [] }); this.lastMenuTitle = this.menus.length - 1; return;
      case 157: this.menus[this.lastMenuTitle]?.items.push({ text: this.msg(lg, a[0]!), controller: a[1]!, enabled: true }); return;
      case 158: return; // submit.menu
      case 159: this.setItemEnabled(a[0]!, true); return;
      case 160: this.setItemEnabled(a[0]!, false); return;
      case 161: return; // menu.input
      case 162: return this.showObj(v[a[0]!]!);
      case 163: case 164: case 169: return;
      case 165: v[a[0]!] = (v[a[0]!]! * a[1]!) & 255; return;
      case 166: v[a[0]!] = (v[a[0]!]! * v[a[1]!]!) & 255; return;
      case 167: v[a[0]!] = a[1]! ? Math.floor(v[a[0]!]! / a[1]!) : 0; return;
      case 168: v[a[0]!] = v[a[1]!] ? Math.floor(v[a[0]!]! / v[a[1]!]!) : 0; return;
      default:
        return;
    }
  }

  private setItemEnabled(controller: number, on: boolean): void {
    for (const m of this.menus) for (const it of m.items) if (it.controller === controller) it.enabled = on;
  }

  private showObj(n: number): Pending {
    const view = this.res.view(n);
    return { modal: { kind: 'showobj', view: n, name: this.items[n - 100]?.name ?? '', desc: this.fmt(this.logic(0), view?.description ?? '') } };
  }

  private display(row: number, col: number, text: string): void {
    this.texts = this.texts.filter((t) => !(t.row === row && t.col === col && t.screen === this.textMode));
    this.texts.push({ row, col, text, fg: this.textFg, bg: this.textBg, screen: this.textMode });
  }

  private drawPic(n: number): void {
    const data = this.res.pic(n);
    if (data) drawPicture(data, this.pic);
  }

  // ---- rooms ------------------------------------------------------------------------------

  private newRoom(n: number): never {
    this.soundQueue.push(null);
    this.sound = null;
    this.scanStart.clear();
    for (let i = 1; i < this.objs.length; i++) { this.objs[i]!.animated = false; this.objs[i]!.drawn = false; }
    const ego = this.objs[0]!;
    ego.drawn = false;
    this.block = null;
    this.horizon = 36;
    this.texts = [];
    this.picOps = [];
    this.vars[1] = this.vars[0]!;
    this.vars[0] = n;
    this.vars[4] = 0;
    this.vars[5] = 0;
    this.vars[16] = ego.view;
    // Ego enters from the opposite edge it left through.
    const w = this.celW(ego);
    switch (this.vars[2]) {
      case 1: ego.y = PIC_H - 1; break;
      case 2: ego.x = 0; break;
      case 3: ego.y = this.horizon + 1; break;
      case 4: ego.x = PIC_W - w; break;
    }
    this.vars[2] = 0;
    this.flags[5] = 1;
    this.walkTarget = null;
    this.picVersion++;
    throw new NewRoomSignal();
  }

  private addToPic(view: number, loop: number, cel: number, x: number, y: number, pri: number, margin: number): void {
    this.picOps.push({ kind: 'add', view, loop, cel, x, y, pri });
    const c = this.res.view(view)?.loops[loop]?.cels[cel];
    if (c) {
      // Like a drawn object, a stamped cel only shows where the picture's priority does not outrank it.
      for (let cy = 0; cy < c.h; cy++) {
        for (let cx = 0; cx < c.w; cx++) {
          const col = c.data[cy * c.w + cx]!;
          if (col === c.trans) continue;
          const px = x + cx, py = y - c.h + 1 + cy;
          if (px < 0 || px >= PIC_W || py < 0 || py >= PIC_H) continue;
          const i = py * PIC_W + px;
          if (Math.max(4, this.pic.priority[i]!) > pri) continue;
          this.pic.visual[i] = col;
          this.pic.priority[i] = pri;
        }
      }
      // A margin below 4 lays a control line along the base of the object (e.g. a barrier under a stool).
      if (margin < 4) for (let cx = 0; cx < c.w; cx++) if (x + cx < PIC_W && y < PIC_H) this.pic.priority[y * PIC_W + x + cx] = margin;
    }
    this.picVersion++;
  }

  // ---- objects ----------------------------------------------------------------------------

  private cels(o: ViewObj): number {
    return this.res.view(o.view)?.loops[o.loop]?.cels.length ?? 0;
  }
  celW(o: ViewObj): number {
    return this.res.view(o.view)?.loops[o.loop]?.cels[o.cel]?.w ?? 1;
  }
  celH(o: ViewObj): number {
    return this.res.view(o.view)?.loops[o.loop]?.cels[o.cel]?.h ?? 1;
  }
  private setView(o: ViewObj, n: number): void {
    o.view = n;
    const lv = this.res.view(n);
    if (lv && o.loop >= lv.loops.length) o.loop = 0;
    if (this.cels(o) && o.cel >= this.cels(o)) o.cel = 0;
  }
  private setLoop(o: ViewObj, n: number, _fix: boolean): void {
    const lv = this.res.view(o.view);
    o.loop = lv && n < lv.loops.length ? n : 0;
    if (this.cels(o) && o.cel >= this.cels(o)) o.cel = 0;
  }
  private setCel(o: ViewObj, n: number): void {
    o.cel = this.cels(o) && n < this.cels(o) ? n : 0;
  }

  private moveObj(i: number, x: number, y: number, step: number, flag: number): void {
    const o = this.objs[i]!;
    o.motion = 'move';
    o.targetX = x;
    o.targetY = y;
    o.targetStep = step || o.stepSize;
    o.targetFlag = flag;
    o.stuck = 0;
    this.flags[flag] = 0;
    if (i === 0) { this.playerControl = false; this.vars[6] = 0; }
  }

  private clampObject(o: ViewObj): void {
    const w = this.celW(o), h = this.celH(o);
    if (o.x < 0) o.x = 0;
    if (o.x + w > PIC_W) o.x = PIC_W - w;
    if (o.y > PIC_H - 1) o.y = PIC_H - 1;
    if (o.y - h + 1 < 0) o.y = h - 1;
    if (!o.ignoreHorizon && o.y <= this.horizon) o.y = this.horizon + 1;
  }

  private priAt(x: number, y: number): number {
    if (x < 0 || x >= PIC_W || y < 0 || y >= PIC_H) return 4;
    return this.pic.priority[y * PIC_W + x]!;
  }

  /** Try to move an object to (nx, ny). Returns the border it hit (1-4) or 0, and whether it moved. */
  private tryMove(idx: number, nx: number, ny: number): { border: number } {
    const o = this.objs[idx]!;
    const w = this.celW(o), h = this.celH(o);
    let border = 0;
    if (nx < 0) { nx = 0; border = 4; }
    if (nx + w > PIC_W) { nx = PIC_W - w; border = 2; }
    if (ny > PIC_H - 1) { ny = PIC_H - 1; border = 3; }
    if (!o.ignoreHorizon && ny <= this.horizon) { ny = this.horizon + 1; border = 1; }
    if (ny - h + 1 < 0) { ny = h - 1; border = 1; }
    let blocked = false;
    let water = 0;
    for (let i = 0; i < w; i++) {
      const p = this.priAt(nx + i, ny);
      if (p === 0) blocked = true;
      else if (p === 1 && !o.ignoreBlocks) blocked = true;
      else if (p === 3) water++;
    }
    if (o.surface === 'land' && water > 0) blocked = true;
    if (o.surface === 'water' && water < w) blocked = true;
    if (!blocked && !o.ignoreObjs) {
      for (let j = 0; j < this.objs.length; j++) {
        if (j === idx) continue;
        const q = this.objs[j]!;
        if (!q.animated || !q.drawn || q.ignoreObjs) continue;
        const overlapX = nx < q.x + this.celW(q) && nx + w > q.x;
        // Colliding means landing on the other object's baseline row or stepping across it.
        if (overlapX && (ny === q.y || (o.y - q.y) * (ny - q.y) < 0)) { blocked = true; break; }
      }
    }
    if (!blocked && this.block && !o.ignoreBlocks) {
      const b = this.block;
      if (nx < b.x1 || nx + w - 1 > b.x2 || ny < b.y1 || ny > b.y2) blocked = true;
    }
    if (!blocked) { o.x = nx; o.y = ny; }
    return { border };
  }

  private cycleCel(o: ViewObj): void {
    const n = this.cels(o);
    if (n <= 1) return;
    switch (o.cycleType) {
      case 'normal': o.cel = (o.cel + 1) % n; break;
      case 'reverse': o.cel = (o.cel + n - 1) % n; break;
      case 'endofloop':
        if (o.cel < n - 1) { o.cel++; if (o.cel === n - 1) { this.flags[o.cycleFlag] = 1; o.cycling = false; o.cycleType = 'normal'; } }
        else { this.flags[o.cycleFlag] = 1; o.cycling = false; o.cycleType = 'normal'; }
        break;
      case 'reverseloop':
        if (o.cel > 0) { o.cel--; if (o.cel === 0) { this.flags[o.cycleFlag] = 1; o.cycling = false; o.cycleType = 'normal'; } }
        else { this.flags[o.cycleFlag] = 1; o.cycling = false; o.cycleType = 'normal'; }
        break;
    }
  }

  private loopFromDir(o: ViewObj): void {
    if (o.fixLoop || o.dir === 0) return;
    const lv = this.res.view(o.view);
    const n = lv?.loops.length ?? 0;
    let loop = -1;
    if (n >= 4) loop = [-1, 3, 0, 0, 0, 2, 1, 1, 1][o.dir]!;
    else if (n >= 2) loop = [-1, -1, 0, 0, 0, -1, 1, 1, 1][o.dir]!;
    if (loop >= 0 && loop !== o.loop) { o.loop = loop; if (o.cel >= this.cels(o)) o.cel = 0; }
  }

  private updateObjects(): void {
    for (let i = 0; i < this.objs.length; i++) {
      const o = this.objs[i]!;
      if (!o.animated || !o.drawn || !o.updating) continue;
      // Motion.
      if (o.motion !== 'none') {
        if (++o.stepCount >= o.stepTime) {
          o.stepCount = 0;
          this.stepObject(i, o);
        }
      }
      this.loopFromDir(o);
      // Cycling (the ego only animates while walking).
      const standing = i === 0 && o.dir === 0 && o.motion === 'normal';
      if (o.cycling && !standing) {
        if (++o.cycleCount >= o.cycleTime) { o.cycleCount = 0; this.cycleCel(o); }
      } else if (standing && o.cycleType === 'normal' && o.cycling) {
        o.cel = 0;
      }
    }
    const ego = this.objs[0]!;
    if (ego.drawn) {
      let water = 0, trigger = false;
      const w = this.celW(ego);
      for (let k = 0; k < w; k++) {
        const p = this.priAt(ego.x + k, ego.y);
        if (p === 3) water++;
        if (p === 2) trigger = true;
      }
      this.flags[0] = water === w && w > 0 ? 1 : 0;
      this.flags[3] = trigger ? 1 : 0;
    }
  }

  private inBand(o: ViewObj, x: number, y: number, pri: number): boolean {
    const w = this.celW(o);
    for (let k = 0; k < w; k++) if (this.priAt(x + k, y) !== pri) return false;
    return true;
  }

  private wanderBand(o: ViewObj): number {
    const p = this.priAt(o.x + (this.celW(o) >> 1), o.y);
    return p > 4 && p < 16 && this.inBand(o, o.x, o.y, p) ? p : 0;
  }

  private stepObject(i: number, o: ViewObj): void {
    const step = o.stepSize;
    const touch = (border: number) => {
      if (!border) return;
      if (i === 0) this.vars[2] = border;
      else { this.vars[4] = i; this.vars[5] = border; }
    };
    switch (o.motion) {
      case 'normal': {
        if (o.dir === 0) return;
        const r = this.tryMove(i, o.x + DX[o.dir]! * step, o.y + DY[o.dir]! * step);
        touch(r.border);
        return;
      }
      case 'wander': {
        if (o.wanderCount <= 0 || o.dir === 0) { o.dir = 1 + Math.floor(this.rng() * 8); o.wanderCount = 6 + Math.floor(this.rng() * 20); }
        o.wanderCount--;
        const ox = o.x, oy = o.y;
        const nx = o.x + DX[o.dir]! * step, ny = o.y + DY[o.dir]! * step;
        // An NPC that starts in a foreground priority band (the bartender behind the bar) stays inside it.
        if (o.wanderPri > 4 && !this.inBand(o, nx, ny, o.wanderPri)) { o.wanderCount = 0; return; }
        const r = this.tryMove(i, nx, ny);
        touch(r.border);
        if (o.x === ox && o.y === oy) o.wanderCount = 0;
        return;
      }
      case 'follow': {
        const ego = this.objs[0]!;
        const dx = ego.x - o.x, dy = ego.y - o.y;
        const near = Math.abs(dx) <= o.targetStep * 2 && Math.abs(dy) <= o.targetStep;
        if (near) { this.flags[o.targetFlag] = 1; o.dir = 0; return; }
        o.dir = dirFromDelta(Math.abs(dx) <= o.targetStep ? 0 : dx, Math.abs(dy) <= o.targetStep ? 0 : dy);
        this.tryMove(i, o.x + DX[o.dir]! * o.targetStep, o.y + DY[o.dir]! * o.targetStep);
        return;
      }
      case 'move': {
        const dx = o.targetX - o.x, dy = o.targetY - o.y;
        if (dx === 0 && dy === 0) { this.finishMove(i, o); return; }
        const sx = Math.max(-o.targetStep, Math.min(o.targetStep, dx));
        const sy = Math.max(-o.targetStep, Math.min(o.targetStep, dy));
        o.dir = dirFromDelta(sx, sy);
        const ox = o.x, oy = o.y;
        const r = this.tryMove(i, o.x + sx, o.y + sy);
        touch(r.border);
        if (o.x === ox && o.y === oy) { if (++o.stuck > 6) this.finishMove(i, o); } else o.stuck = 0;
        if (o.x === o.targetX && o.y === o.targetY) this.finishMove(i, o);
        return;
      }
    }
  }

  private finishMove(i: number, o: ViewObj): void {
    o.motion = 'normal';
    o.dir = 0;
    this.flags[o.targetFlag] = 1;
    if (i === 0) { this.vars[6] = 0; this.playerControl = true; }
  }

  // ---- snapshots ----------------------------------------------------------------------------

  /** The drawn objects as the clients should see them. */
  visibleObjects(): { id: number; view: number; loop: number; cel: number; x: number; y: number; pri: number }[] {
    const out = [];
    for (let i = 0; i < this.objs.length; i++) {
      const o = this.objs[i]!;
      if (!o.drawn || !o.animated) continue;
      out.push({ id: i, view: o.view, loop: o.loop, cel: o.cel, x: o.x, y: o.y, pri: o.fixedPri ? o.priority : priorityFromY(o.y) });
    }
    return out;
  }

  snapshot(): string {
    return JSON.stringify({
      vars: [...this.vars], flags: [...this.flags], strings: this.strings, objs: this.objs, items: this.items,
      picOps: this.picOps, horizon: this.horizon, playerControl: this.playerControl, statusLine: this.statusLine,
    });
  }

  restore(s: string): void {
    const d = JSON.parse(s) as ReturnType<typeof JSON.parse>;
    this.vars.set(d.vars);
    this.flags.set(d.flags);
    this.strings = d.strings;
    this.objs = d.objs;
    this.items = d.items;
    this.horizon = d.horizon;
    this.playerControl = d.playerControl;
    this.statusLine = d.statusLine;
    this.pic.clear();
    this.picOps = [];
    for (const op of d.picOps as PicOp[]) {
      if (op.kind === 'draw') { this.pic.clear(); this.picOps = [op]; this.drawPic(op.pic); }
      else if (op.kind === 'overlay') { this.picOps.push(op); this.drawPic(op.pic); }
      else if (op.kind === 'add') this.addToPic(op.view, op.loop, op.cel, op.x, op.y, op.pri, 4);
    }
    this.flags[12] = 1; // "game was restored"
    this.picVersion++;
  }
}
