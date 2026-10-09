// Walk area = polygon in native pixels. Pathfinding = 4px grid A* clamped to the polygon,
// followed by line-of-sight string pulling so characters do not zig-zag along grid cells.
import type { Pt } from '../../shared/protocol';
import { centroid, closestOnPoly, pointInPoly } from './geometry';

const CELL = 4;

export class WalkMap {
  readonly poly: Pt[];
  private cols: number;
  private rows: number;
  private ok: Uint8Array;
  private center: Pt;

  constructor(walk: Pt[], width: number, height: number) {
    // An empty polygon (fresh extraction stub) means the whole picture is walkable.
    this.poly = walk.length >= 3 ? walk : [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]];
    this.cols = Math.ceil(width / CELL);
    this.rows = Math.ceil(height / CELL);
    this.center = centroid(this.poly);
    this.ok = new Uint8Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) this.ok[r * this.cols + c] = pointInPoly(this.cellCenter(c, r), this.poly) ? 1 : 0;
  }

  private cellCenter(c: number, r: number): Pt {
    return [c * CELL + CELL / 2, r * CELL + CELL / 2];
  }
  private cellOf(p: Pt): [number, number] {
    return [Math.min(this.cols - 1, Math.max(0, Math.floor(p[0] / CELL))), Math.min(this.rows - 1, Math.max(0, Math.floor(p[1] / CELL)))];
  }
  private walkable(c: number, r: number): boolean {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows && this.ok[r * this.cols + c] === 1;
  }

  contains(p: Pt): boolean {
    return pointInPoly(p, this.poly);
  }

  /** Closest point inside the polygon (nudged 1px toward the centroid so it is strictly inside). */
  snap(p: Pt): Pt {
    if (this.contains(p)) return p;
    const c = closestOnPoly(p, this.poly);
    const dx = this.center[0] - c[0], dy = this.center[1] - c[1];
    const len = Math.hypot(dx, dy) || 1;
    const n: Pt = [c[0] + dx / len, c[1] + dy / len];
    return this.contains(n) ? n : c;
  }

  private nearestWalkableCell(c: number, r: number): [number, number] | null {
    if (this.walkable(c, r)) return [c, r];
    for (let d = 1; d < Math.max(this.cols, this.rows); d++)
      for (let dr = -d; dr <= d; dr++)
        for (let dc = -d; dc <= d; dc++)
          if (Math.max(Math.abs(dc), Math.abs(dr)) === d && this.walkable(c + dc, r + dr)) return [c + dc, r + dr];
    return null;
  }

  private lineClear(a: Pt, b: Pt): boolean {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (!this.contains([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return false;
    }
    return true;
  }

  /** Waypoints from `from` (excluded) to the snapped `to`. */
  find(from: Pt, to: Pt): Pt[] {
    const s = this.snap(from);
    const g = this.snap(to);
    const sc = this.nearestWalkableCell(...this.cellOf(s));
    const gc = this.nearestWalkableCell(...this.cellOf(g));
    if (!sc || !gc) return [g];
    if (sc[0] === gc[0] && sc[1] === gc[1]) return [g];
    if (this.lineClear(s, g)) return [g];

    const idx = (c: number, r: number) => r * this.cols + c;
    const gScore = new Float32Array(this.cols * this.rows).fill(Infinity);
    const from_ = new Int32Array(this.cols * this.rows).fill(-1);
    const closed = new Uint8Array(this.cols * this.rows);
    const h = (c: number, r: number) => {
      const dx = Math.abs(c - gc[0]), dy = Math.abs(r - gc[1]);
      return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy);
    };
    // Small binary heap keyed on f score.
    const heap: [number, number][] = [];
    const push = (f: number, i: number) => {
      heap.push([f, i]);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heap[p]![0] <= heap[k]![0]) break;
        [heap[p], heap[k]] = [heap[k]!, heap[p]!];
        k = p;
      }
    };
    const pop = (): number => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let m = k;
          if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
          if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k]!, heap[m]!];
          k = m;
        }
      }
      return top[1];
    };

    const start = idx(sc[0], sc[1]);
    const goal = idx(gc[0], gc[1]);
    gScore[start] = 0;
    push(h(sc[0], sc[1]), start);
    while (heap.length) {
      const cur = pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) break;
      const cc = cur % this.cols, cr = (cur / this.cols) | 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const nc = cc + dc, nr = cr + dr;
          if (!this.walkable(nc, nr)) continue;
          if (dc && dr && (!this.walkable(cc + dc, cr) || !this.walkable(cc, cr + dr))) continue; // no corner cutting
          const ni = idx(nc, nr);
          const ng = gScore[cur]! + (dc && dr ? 1.4142 : 1);
          if (ng < gScore[ni]!) {
            gScore[ni] = ng;
            from_[ni] = cur;
            push(ng + h(nc, nr), ni);
          }
        }
      }
    }
    if (!closed[goal]) return [g];

    const cells: Pt[] = [];
    for (let i = goal; i !== -1; i = from_[i]!) cells.push(this.cellCenter(i % this.cols, (i / this.cols) | 0));
    cells.reverse();
    cells[0] = s;
    cells.push(g);

    // String pulling: from each anchor jump to the farthest waypoint still in line of sight.
    const out: Pt[] = [];
    let anchor = 0;
    while (anchor < cells.length - 1) {
      let far = anchor + 1;
      for (let j = cells.length - 1; j > anchor + 1; j--) {
        if (this.lineClear(cells[anchor]!, cells[j]!)) { far = j; break; }
      }
      out.push(cells[far]!);
      anchor = far;
    }
    return out;
  }
}
