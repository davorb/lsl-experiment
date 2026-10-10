import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IndexSchema, RoomSchema, type ContentIndex, type Flags, type Room, type SessionState, type Verb } from '../../shared/protocol';
import { WalkMap } from './path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CONTENT_DIR = path.join(ROOT, 'content');

export interface LoadedRoom { room: Room; walk: WalkMap }

const roomCache = new Map<string, { mtime: number; loaded: LoadedRoom }>();

export function loadIndex(): ContentIndex {
  const idx = IndexSchema.parse(JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'index.json'), 'utf8')));
  const override = process.env.LSL_START;
  return override ? { ...idx, start: override } : idx;
}

export function loadRoom(id: string): LoadedRoom | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const file = path.join(CONTENT_DIR, 'rooms', `${id}.json`);
  if (!fs.existsSync(file)) return null;
  const mtime = fs.statSync(file).mtimeMs;
  const hit = roomCache.get(id);
  if (hit && hit.mtime === mtime) return hit.loaded;
  const room = RoomSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  const loaded = { room, walk: new WalkMap(room.walk, room.size[0], room.size[1]) };
  roomCache.set(id, { mtime, loaded });
  return loaded;
}

// ---- scripts ----------------------------------------------------------------------

export interface ScriptContext {
  state: Pick<SessionState, 'roomId' | 'players' | 'flags' | 'inventory'>;
  actorId: string;
  hotspotId: string;
  /** Set when answering a dialogue choice (handler `choose`). */
  choice?: string;
  /** Original game text: text(logicNo, ...messageNos), joined by blank lines; undefined if not extracted. */
  text: (logic: number, ...nos: number[]) => string | undefined;
}
export interface ScriptResult {
  say?: string;
  choices?: { id: string; label: string }[];
  pose?: { anim: 'idle' | 'sit'; x?: number; y?: number; facing?: 'left' | 'right' | 'up' | 'down' };
  flags?: Flags;
  inventory?: { add?: string[]; remove?: string[] };
  /** Move the acting player to another room after showing `say`. */
  go?: { room: string; spawn: [number, number] };
}
type Handler = (ctx: ScriptContext) => ScriptResult | undefined | Promise<ScriptResult | undefined>;

// ---- extracted game text (content/text/, gitignored) -----------------------------

const textCache = new Map<string, Record<string, string> | null>();
function readText(name: string): Record<string, string> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  if (!textCache.has(name)) {
    const f = path.join(CONTENT_DIR, 'text', `${name}.json`);
    textCache.set(name, fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, string>) : null);
  }
  return textCache.get(name) ?? null;
}

/** Expand AGI message codes: %vNN -> variable (only the cash var 90 is modelled), %mNN -> message NN, %sNN -> "". */
function expand(table: Record<string, string>, text: string, vars: Record<number, number>, depth = 0): string {
  return text
    .replace(/%m(\d+)/g, (_, n: string) => (depth < 4 && table[n] ? expand(table, table[n]!, vars, depth + 1) : ''))
    .replace(/%v(\d+)(?::%v\d+\|\d)?/g, (_, n: string) => String(vars[Number(n)] ?? 0))
    .replace(/%s\d+/g, '');
}

export function makeText(flags: Flags): ScriptContext['text'] {
  const vars = { 90: Number(flags['cash'] ?? 0) };
  return (logic, ...nos) => {
    const t = readText(`logic${logic}`);
    if (!t) return undefined;
    const parts = nos.map((n) => (t[String(n)] ? expand(t, t[String(n)]!, vars) : undefined)).filter((x): x is string => !!x);
    return parts.length ? parts.join('\n\n') : undefined;
  };
}

/** Look text for an inventory item: AGI keeps it in the item's view description (view = 100 + object number). */
export function itemLookText(itemId: string, flags: Flags): string {
  const items = readItems();
  const obj = items[itemId];
  const desc = readText('views');
  const raw = obj !== undefined ? desc?.[String(100 + obj)] : undefined;
  if (!raw) return `It's ${itemId.replace(/_/g, ' ')}.`;
  return expand({}, raw, { 90: Number(flags['cash'] ?? 0) });
}
let itemsCache: Record<string, number> | null = null;
function readItems(): Record<string, number> {
  return (itemsCache ??= JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'items.json'), 'utf8')) as Record<string, number>);
}

/** "lobby.door" -> content/scripts/lobby.js, export named after the verb (or `choose`). */
export async function runScript(script: string, verb: Verb | 'choose', ctx: ScriptContext): Promise<ScriptResult | undefined> {
  const mod = script.split('.')[0] ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(mod)) return undefined;
  const file = path.join(CONTENT_DIR, 'scripts', `${mod}.js`);
  if (!fs.existsSync(file)) return undefined;
  const url = `${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`; // cache-bust on edit
  const exports = (await import(url)) as Record<string, unknown>;
  const fn = exports[verb];
  return typeof fn === 'function' ? await (fn as Handler)(ctx) : undefined;
}
