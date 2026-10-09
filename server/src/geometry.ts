import type { Pt, Rect } from '../../shared/protocol';

export function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
}

export function closestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return [a[0] + dx * t, a[1] + dy * t];
}

export function closestOnPoly(p: Pt, poly: Pt[]): Pt {
  let best: Pt = poly[0] ?? p;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const c = closestOnSegment(p, poly[i]!, poly[(i + 1) % poly.length]!);
    const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

export function centroid(poly: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}
