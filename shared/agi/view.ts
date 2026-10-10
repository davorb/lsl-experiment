// AGI view resources: loops of cels (run-length encoded rows). Widths are in AGI pixels (160-wide space).
export interface ViewCel {
  w: number;
  h: number;
  trans: number;
  /** Palette index per pixel; transparent pixels hold `trans`. Mirrored cels are already flipped. */
  data: Uint8Array;
}
export interface ViewLoop { cels: ViewCel[] }
export interface ParsedView { loops: ViewLoop[]; description: string }

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);

export function parseView(b: Uint8Array): ParsedView | null {
  if (b.length < 5) return null;
  const nLoops = b[2]!;
  if (nLoops === 0 || nLoops > 16 || 5 + nLoops * 2 > b.length) return null;
  interface Raw { w: number; h: number; trans: number; mirror: boolean; mirrorOf: number; px: Uint8Array }
  const raw: Raw[][] = [];
  for (let l = 0; l < nLoops; l++) {
    const lo = u16(b, 5 + l * 2);
    if (lo >= b.length) return null;
    const nCels = b[lo]!;
    const cels: Raw[] = [];
    for (let c = 0; c < nCels; c++) {
      const co = lo + u16(b, lo + 1 + c * 2);
      if (co + 3 > b.length) return null;
      const w = b[co]!, h = b[co + 1]!, tm = b[co + 2]!;
      const trans = tm & 15;
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
      cels.push({ w, h, trans, mirror: (tm & 0x80) !== 0, mirrorOf: (tm >> 4) & 7, px });
    }
    raw.push(cels);
  }
  const loops: ViewLoop[] = raw.map((cels, li) => ({
    cels: cels.map((c) => {
      const flip = c.mirror && c.mirrorOf !== li;
      let data = c.px;
      if (flip) {
        data = new Uint8Array(c.px.length);
        for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) data[y * c.w + x] = c.px[y * c.w + (c.w - 1 - x)]!;
      }
      return { w: c.w, h: c.h, trans: c.trans, data };
    }),
  }));
  let description = '';
  const off = u16(b, 3);
  if (off && off < b.length) {
    let e = off;
    while (e < b.length && b[e] !== 0) e++;
    description = String.fromCharCode(...b.subarray(off, e));
  }
  return { loops, description };
}
