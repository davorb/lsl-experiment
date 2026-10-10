// AGI picture drawing on a pair of 160x168 screens (visual + priority/control). Pure TS: used by the
// extractor, the server (collision needs the priority screen) and the client (rendering).
export const PIC_W = 160;
export const PIC_H = 168;

export const EGA: readonly [number, number, number][] = [
  [0x00, 0x00, 0x00], [0x00, 0x00, 0xaa], [0x00, 0xaa, 0x00], [0x00, 0xaa, 0xaa],
  [0xaa, 0x00, 0x00], [0xaa, 0x00, 0xaa], [0xaa, 0x55, 0x00], [0xaa, 0xaa, 0xaa],
  [0x55, 0x55, 0x55], [0x55, 0x55, 0xff], [0x55, 0xff, 0x55], [0x55, 0xff, 0xff],
  [0xff, 0x55, 0x55], [0xff, 0x55, 0xff], [0xff, 0xff, 0x55], [0xff, 0xff, 0xff],
];

export class PicBuffers {
  visual = new Uint8Array(PIC_W * PIC_H).fill(15);
  priority = new Uint8Array(PIC_W * PIC_H).fill(4);
  clear(): void {
    this.visual.fill(15);
    this.priority.fill(4);
  }
}

/** Draw a vector picture resource onto `buf`. For draw.pic call buf.clear() first; for overlay.pic do not. */
export function drawPicture(data: Uint8Array, buf: PicBuffers): void {
  const vis = buf.visual, pri = buf.priority;
  let visOn = false, priOn = false, visCol = 0, priCol = 0, patCode = 0;
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
      case 0xf4:
      case 0xf5: {
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
      case 0xf9: patCode = next(); break;
      case 0xfa:
        while (true) {
          let tex = 0;
          if (patCode & 0x20) { if (peek() >= 0xf0) break; tex = next(); }
          if (peek() >= 0xf0) break;
          const x = next();
          if (peek() >= 0xf0) break;
          pen(x, next(), tex);
        }
        break;
      case 0xff: return;
      default: break;
    }
  }
}

/** RGBA at 320x168: each AGI pixel doubled horizontally (AGI pixels are 2:1). */
export function pictureToRGBA(visual: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const w = PIC_W * 2;
  const out = new Uint8ClampedArray(new ArrayBuffer(w * PIC_H * 4));
  for (let y = 0; y < PIC_H; y++) {
    for (let x = 0; x < PIC_W; x++) {
      const c = EGA[visual[y * PIC_W + x]!]!;
      for (let k = 0; k < 2; k++) {
        const o = (y * w + x * 2 + k) * 4;
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
      }
    }
  }
  return out;
}
