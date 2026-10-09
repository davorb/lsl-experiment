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

export interface ScriptContext { state: Pick<SessionState, 'roomId' | 'players' | 'flags' | 'inventory'>; actorId: string; hotspotId: string }
export interface ScriptResult {
  say?: string;
  flags?: Flags;
  inventory?: { add?: string[]; remove?: string[] };
  /** Move the acting player to another room after showing `say`. */
  go?: { room: string; spawn: [number, number] };
}
type Handler = (ctx: ScriptContext) => ScriptResult | undefined | Promise<ScriptResult | undefined>;

/** "lobby.door" -> content/scripts/lobby.js, export named after the verb. */
export async function runScript(script: string, verb: Verb, ctx: ScriptContext): Promise<ScriptResult | undefined> {
  const mod = script.split('.')[0] ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(mod)) return undefined;
  const file = path.join(CONTENT_DIR, 'scripts', `${mod}.js`);
  if (!fs.existsSync(file)) return undefined;
  const url = `${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`; // cache-bust on edit
  const exports = (await import(url)) as Record<string, unknown>;
  const fn = exports[verb];
  return typeof fn === 'function' ? await (fn as Handler)(ctx) : undefined;
}
