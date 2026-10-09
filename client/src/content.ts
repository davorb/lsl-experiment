import { Assets, Texture } from 'pixi.js';
import { IndexSchema, RoomSchema, ViewSchema, type ContentIndex, type Room } from '../../shared/protocol';

export function pixelTexture(t: Texture): Texture {
  t.source.scaleMode = 'nearest';
  return t;
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export async function loadIndex(): Promise<ContentIndex> {
  return IndexSchema.parse(await getJson('/content/index.json'));
}

export async function loadRoom(id: string): Promise<Room> {
  return RoomSchema.parse(await getJson(`/content/rooms/${encodeURIComponent(id)}.json`));
}

export async function tryTexture(path: string): Promise<Texture | null> {
  try {
    return pixelTexture(await Assets.load<Texture>(`/content/${path}`));
  } catch {
    return null;
  }
}

export interface Frame { texture: Texture; ax: number; ay: number }
export interface PlayerSprites { loops: Frame[][]; dirs: Record<'right' | 'left' | 'down' | 'up', number>; frameMs: number }

/** Loads the Larry view named in index.json; null means "use the 16x32 rectangle fallback". */
export async function loadPlayerSprites(index: ContentIndex): Promise<PlayerSprites | null> {
  if (!index.player) return null;
  try {
    const v = ViewSchema.parse(await getJson(`/content/sprites/${index.player.view}/view.json`));
    const loops: Frame[][] = [];
    for (const loop of v.loops) {
      const frames: Frame[] = [];
      for (const cel of loop) {
        const tex = await tryTexture(`sprites/${index.player.view}/${cel.file}`);
        if (!tex) return null;
        frames.push({ texture: tex, ax: cel.originX / cel.w, ay: cel.originY / cel.h });
      }
      loops.push(frames);
    }
    return { loops, dirs: index.player.dirs, frameMs: index.player.frameMs };
  } catch {
    return null;
  }
}
