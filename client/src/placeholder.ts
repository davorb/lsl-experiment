import type { Room } from '../../shared/protocol';

/** Procedural backdrop used when a room has no background PNG (zero-game-data boot). */
export function placeholderBackground(room: Room): HTMLCanvasElement {
  const [w, h] = room.size;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  const warm = room.id === 'lobby';
  g.fillStyle = warm ? '#6b4a3a' : '#3b4660';
  g.fillRect(0, 0, w, h);
  const top = Math.min(...(room.walk.length ? room.walk.map((p) => p[1]) : [h * 0.6]));
  g.fillStyle = warm ? '#8c6a52' : '#55617f';
  g.fillRect(0, 0, w, top);
  for (let x = 0; x < w; x += 32) { g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x, 0, 2, top); }
  if (room.walk.length >= 3) {
    g.beginPath();
    room.walk.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fillStyle = warm ? '#a98763' : '#6c7794';
    g.fill();
  }
  g.font = '8px monospace';
  for (const hs of room.hotspots) {
    const [x1, y1, x2, y2] = hs.rect;
    g.fillStyle = 'rgba(240,220,160,0.55)';
    g.fillRect(x1, y1, x2 - x1, y2 - y1);
    g.fillStyle = '#1a1208';
    g.fillText(hs.name ?? hs.id, x1 + 2, y1 + 9);
  }
  for (const e of room.exits) {
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(e.rect[0], e.rect[1], e.rect[2] - e.rect[0], e.rect[3] - e.rect[1]);
    g.fillStyle = '#fff';
    g.fillText(`> ${e.to}`, e.rect[0] + 2, e.rect[1] + 7);
  }
  g.fillStyle = 'rgba(255,255,255,0.7)';
  g.fillText(`${room.id} (placeholder)`, 4, h - 4);
  return c;
}

export function fallbackActorCanvas(color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.fillRect(0, 0, 16, 32);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(3, 2, 10, 8);
  return c;
}
