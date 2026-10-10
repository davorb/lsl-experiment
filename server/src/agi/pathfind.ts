// A* over the AGI priority screen so click-to-walk goes around walls instead of grinding into them.
// Positions use AGI conventions: x = left edge of the sprite, y = baseline row, in the 160x168 grid.
import { PIC_H, PIC_W } from '../../../shared/agi/picture';

export interface Pt { x: number; y: number }
export interface PlanOpts {
  pri: Uint8Array;
  /** Sprite width/height in AGI pixels. */
  w: number;
  h: number;
  horizon: number;
  ignoreHorizon?: boolean;
  block?: { x1: number; y1: number; x2: number; y2: number } | null;
}

const SIZE = PIC_W * PIC_H;
const DIRS: [number, number, number][] = [
  [0, -1, 1], [1, 0, 1], [0, 1, 1], [-1, 0, 1], [1, -1, 1.4142], [1, 1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142],
];

export function walkable(o: PlanOpts, x: number, y: number): boolean {
  if (x < 0 || x + o.w > PIC_W || y < 0 || y >= PIC_H) return false;
  if (!o.ignoreHorizon && y <= o.horizon) return false;
  if (y - o.h + 1 < 0) return false;
  for (let i = 0; i < o.w; i++) {
    const p = o.pri[y * PIC_W + x + i]!;
    if (p === 0 || p === 1) return false;
  }
  if (o.block && (x < o.block.x1 || x + o.w - 1 > o.block.x2 || y < o.block.y1 || y > o.block.y2)) return false;
  return true;
}

export function lineClear(o: PlanOpts, a: Pt, b: Pt): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  for (let i = 1; i <= n; i++) if (!walkable(o, Math.round(a.x + (dx * i) / n), Math.round(a.y + (dy * i) / n))) return false;
  return true;
}

/**
 * Waypoints from `from` (excluded) to the reachable point nearest `to` (the exact point when reachable).
 * Flood fill from the start, so unreachable clicks (inside a wall, across a barrier) still go somewhere useful.
 */
export function findPath(o: PlanOpts, from: Pt, to: Pt): Pt[] {
  const start = { x: Math.round(from.x), y: Math.round(from.y) };
  const goal = { x: Math.round(to.x), y: Math.round(to.y) };
  if (start.x === goal.x && start.y === goal.y) return [];

  const prev = new Int32Array(SIZE).fill(-2);
  const queue = new Int32Array(SIZE);
  let qh = 0, qt = 0;
  const s = start.y * PIC_W + start.x;
  prev[s] = -1;
  queue[qt++] = s;
  let best = s, bestD = (start.x - goal.x) ** 2 + (start.y - goal.y) ** 2;
  while (qh < qt) {
    const cur = queue[qh++]!;
    const cx = cur % PIC_W, cy = (cur / PIC_W) | 0;
    const d = (cx - goal.x) ** 2 + (cy - goal.y) ** 2;
    if (d < bestD) { bestD = d; best = cur; }
    if (d === 0) break;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= PIC_W || ny >= PIC_H) continue;
      const ni = ny * PIC_W + nx;
      if (prev[ni] !== -2 || !walkable(o, nx, ny)) continue;
      prev[ni] = cur;
      queue[qt++] = ni;
    }
  }
  if (best === s) return [];
  const cells: Pt[] = [];
  for (let i = best; i !== -1; i = prev[i]!) cells.push({ x: i % PIC_W, y: (i / PIC_W) | 0 });
  cells.reverse();
  // Every step is a legal 8-way move, so the cell path is followed as is (no corner-cutting shortcuts that
  // the sprite's 8-direction stepping could not follow). Drop the start cell.
  const out = cells.slice(1);

  return out;
}

/** The walkable point nearest to `p` (ring search), or null if there is none nearby. */
export function nearestWalkable(o: PlanOpts, p: Pt): Pt | null {
  const x0 = Math.round(p.x), y0 = Math.round(p.y);
  if (walkable(o, x0, y0)) return { x: x0, y: y0 };
  for (let r = 1; r < 60; r++) {
    let best: Pt | null = null, bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!walkable(o, x0 + dx, y0 + dy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = { x: x0 + dx, y: y0 + dy }; }
      }
    }
    if (best) return best;
  }
  return null;
}
