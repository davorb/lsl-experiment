// Minimal AGI v2 resource reader: DIR files, VOL resources, vector pictures, views.
// Only what is needed to dump backgrounds and sprite cels. Colours are the 16 EGA entries.
import fs from 'node:fs';
import path from 'node:path';

export const EGA: [number, number, number][] = [
  [0x00, 0x00, 0x00], [0x00, 0x00, 0xaa], [0x00, 0xaa, 0x00], [0x00, 0xaa, 0xaa],
  [0xaa, 0x00, 0x00], [0xaa, 0x00, 0xaa], [0xaa, 0x55, 0x00], [0xaa, 0xaa, 0xaa],
  [0x55, 0x55, 0x55], [0x55, 0x55, 0xff], [0x55, 0xff, 0x55], [0x55, 0xff, 0xff],
  [0xff, 0x55, 0x55], [0xff, 0x55, 0xff], [0xff, 0xff, 0x55], [0xff, 0xff, 0xff],
];

export const PIC_W = 160;
export const PIC_H = 168;

export function isAgiDir(dir: string): boolean {
  return ['PICDIR', 'VIEWDIR', 'LOGDIR'].every((f) => fs.existsSync(path.join(dir, f))) && fs.existsSync(path.join(dir, 'VOL.0'));
}

interface DirEntry { vol: number; offset: number }

function readDir(dir: string, name: string): (DirEntry | null)[] {
  const b = fs.readFileSync(path.join(dir, name));
  const out: (DirEntry | null)[] = [];
  for (let i = 0; i + 2 < b.length; i += 3) {
    const b0 = b[i]!, b1 = b[i + 1]!, b2 = b[i + 2]!;
    if (b0 === 0xff && b1 === 0xff && b2 === 0xff) out.push(null);
    else out.push({ vol: b0 >> 4, offset: ((b0 & 0x0f) << 16) | (b1 << 8) | b2 });
  }
  return out;
}

export function readResource(dir: string, entry: DirEntry): Buffer | null {
  const f = path.join(dir, `VOL.${entry.vol}`);
  if (!fs.existsSync(f)) return null;
  const b = fs.readFileSync(f);
  if (b[entry.offset] !== 0x12 || b[entry.offset + 1] !== 0x34) return null;
  const len = b[entry.offset + 3]! | (b[entry.offset + 4]! << 8);
  return b.subarray(entry.offset + 5, entry.offset + 5 + len);
}

export function listResources(dir: string, kind: 'PICDIR' | 'VIEWDIR'): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  readDir(dir, kind).forEach((e, i) => {
    if (!e) return;
    const r = readResource(dir, e);
    if (r && r.length > 2) out.set(i, r);
  });
  return out;
}

// ---- pictures ---------------------------------------------------------------

export interface Picture { visual: Uint8Array; priority: Uint8Array }

export function decodePicture(data: Buffer): Picture {
  const vis = new Uint8Array(PIC_W * PIC_H).fill(15);
  const pri = new Uint8Array(PIC_W * PIC_H).fill(4);
  let visOn = false, priOn = false, visCol = 0, priCol = 0;
  let patCode = 0, patNum = 0;
  let p = 0;
  const next = () => (p < data.length ? data[p++]! : 0xff);
  const peek = () => (p < data.length ? data[p]! : 0xff);

  const plot = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= PIC_W || y >= PIC_H) return;
    const i = y * PIC_W + x;
    if (visOn) vis[i] = visCol;
    if (priOn) pri[i] = priCol;
  };
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1, dy = y2 - y1;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps === 0) return plot(x1, y1);
    for (let s = 0; s <= steps; s++) plot(Math.round(x1 + (dx * s) / steps), Math.round(y1 + (dy * s) / steps));
  };
  const canFill = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= PIC_W || y >= PIC_H) return false;
    const i = y * PIC_W + x;
    if (visOn) return vis[i] === 15 && visCol !== 15;
    if (priOn) return pri[i] === 4 && priCol !== 4;
    return false;
  };
  const fill = (sx: number, sy: number) => {
    if (!canFill(sx, sy)) return;
    const stack: [number, number][] = [[sx, sy]];
    while (stack.length) {
      const [x0, y] = stack.pop()!;
      if (!canFill(x0, y)) continue;
      let l = x0, r = x0;
      while (canFill(l - 1, y)) l--;
      while (canFill(r + 1, y)) r++;
      for (let x = l; x <= r; x++) plot(x, y);
      for (const ny of [y - 1, y + 1]) {
        let inRun = false;
        for (let x = l; x <= r; x++) {
          const ok = canFill(x, ny);
          if (ok && !inRun) stack.push([x, ny]);
          inRun = ok;
        }
      }
    }
  };
  // Pen shapes are approximated (circle by distance, square by box, splatter by a seeded LCG).
  const pen = (cx: number, cy: number, tex: number) => {
    const size = patCode & 7;
    const circle = (patCode & 0x10) === 0;
    const splatter = (patCode & 0x20) !== 0;
    const x0 = Math.max(size, Math.min(PIC_W - 1 - size, cx));
    const y0 = Math.max(size, Math.min(PIC_H - 1 - size, cy));
    let seed = (tex | 1) * 2654435761;
    for (let dy = -size; dy <= size; dy++) {
      for (let dx = -size; dx <= size; dx++) {
        if (circle && dx * dx + dy * dy > size * size + size) continue;
        if (splatter) {
          seed = (seed * 1103515245 + 12345) >>> 0;
          if ((seed >> 16) % 3 !== 0) continue;
        }
        plot(x0 + dx, y0 + dy);
      }
    }
  };

  while (p < data.length) {
    const op = next();
    switch (op) {
      case 0xf0: visCol = next() & 15; visOn = true; break;
      case 0xf1: visOn = false; break;
      case 0xf2: priCol = next() & 15; priOn = true; break;
      case 0xf3: priOn = false; break;
      case 0xf4: // vertical-first corner
      case 0xf5: { // horizontal-first corner
        let x = next(); let y = next();
        if (x >= 0xf0 || y >= 0xf0) break;
        plot(x, y);
        let vertical = op === 0xf4;
        while (peek() < 0xf0) {
          const v = next();
          if (vertical) { line(x, y, x, v); y = v; } else { line(x, y, v, y); x = v; }
          vertical = !vertical;
        }
        break;
      }
      case 0xf6: {
        let x = next(), y = next();
        if (x >= 0xf0 || y >= 0xf0) break;
        plot(x, y);
        while (peek() < 0xf0) {
          const nx = next();
          if (peek() >= 0xf0) break;
          const ny = next();
          line(x, y, nx, ny); x = nx; y = ny;
        }
        break;
      }
      case 0xf7: {
        let x = next(), y = next();
        if (x >= 0xf0 || y >= 0xf0) break;
        plot(x, y);
        while (peek() < 0xf0) {
          const d = next();
          let dx = (d >> 4) & 7, dy = d & 7;
          if (d & 0x80) dx = -dx;
          if (d & 0x08) dy = -dy;
          line(x, y, x + dx, y + dy); x += dx; y += dy;
        }
        break;
      }
      case 0xf8:
        while (peek() < 0xf0) {
          const x = next();
          if (peek() >= 0xf0) break;
          fill(x, next());
        }
        break;
      case 0xf9: patCode = next(); patNum = 0; break;
      case 0xfa:
        while (true) {
          let tex = 0;
          if (patCode & 0x20) { if (peek() >= 0xf0) break; tex = next(); patNum = tex; }
          if (peek() >= 0xf0) break;
          const x = next();
          if (peek() >= 0xf0) break;
          pen(x, next(), tex || patNum);
        }
        break;
      case 0xff: return { visual: vis, priority: pri };
      default: break; // unknown byte: skip
    }
  }
  return { visual: vis, priority: pri };
}

/** RGBA at 320x168: each AGI pixel is doubled horizontally (AGI pixels are 2:1). */
export function pictureToRGBA(pic: Picture): { width: number; height: number; data: Buffer } {
  const width = PIC_W * 2;
  const data = Buffer.alloc(width * PIC_H * 4);
  for (let y = 0; y < PIC_H; y++) {
    for (let x = 0; x < PIC_W; x++) {
      const c = EGA[pic.visual[y * PIC_W + x]!]!;
      for (let k = 0; k < 2; k++) {
        const o = (y * width + x * 2 + k) * 4;
        data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
      }
    }
  }
  return { width, height: PIC_H, data };
}

// ---- views ------------------------------------------------------------------

export interface Cel { width: number; height: number; rgba: Buffer }
export type Loop = Cel[];

/** Decode a view into loops of RGBA cels (width doubled to match the 320-wide playfield). */
export function decodeView(b: Buffer): Loop[] | null {
  if (b.length < 5) return null;
  const nLoops = b[2]!;
  if (nLoops === 0 || nLoops > 16 || 5 + nLoops * 2 > b.length) return null;
  interface Raw { w: number; h: number; trans: number; mirror: boolean; mirrorOf: number; px: Uint8Array }
  const raw: Raw[][] = [];
  for (let l = 0; l < nLoops; l++) {
    const lo = b.readUInt16LE(5 + l * 2);
    if (lo >= b.length) return null;
    const nCels = b[lo]!;
    const cels: Raw[] = [];
    for (let c = 0; c < nCels; c++) {
      const co = lo + b.readUInt16LE(lo + 1 + c * 2);
      if (co + 3 > b.length) return null;
      const w = b[co]!, h = b[co + 1]!, tm = b[co + 2]!;
      const trans = tm & 15;
      const mirror = (tm & 0x80) !== 0;
      const mirrorOf = (tm >> 4) & 7;
      const px = new Uint8Array(w * h).fill(trans);
      let q = co + 3;
      for (let y = 0; y < h; y++) {
        let x = 0;
        while (q < b.length) {
          const v = b[q++]!;
          if (v === 0) break;
          const col = v >> 4, run = v & 15;
          for (let k = 0; k < run && x < w; k++) px[y * w + x++] = col;
        }
      }
      cels.push({ w, h, trans, mirror, mirrorOf, px });
    }
    raw.push(cels);
  }
  return raw.map((cels, li) =>
    cels.map((c) => {
      const flip = c.mirror && c.mirrorOf !== li;
      const W = c.w * 2;
      const rgba = Buffer.alloc(W * c.h * 4);
      for (let y = 0; y < c.h; y++) {
        for (let x = 0; x < c.w; x++) {
          const sx = flip ? c.w - 1 - x : x;
          const idx = c.px[y * c.w + sx]!;
          const col = EGA[idx]!;
          for (let k = 0; k < 2; k++) {
            const o = (y * W + x * 2 + k) * 4;
            rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2];
            rgba[o + 3] = idx === c.trans ? 0 : 255;
          }
        }
      }
      return { width: W, height: c.h, rgba };
    }),
  );
}
