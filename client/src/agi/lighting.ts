import { EGA, PIC_W } from '../../../shared/agi/picture';

// HD-2D lighting per AGI room number: an ambient multiply colour plus warm/cool light pools.
// Positions are native pixels (320x168). Rooms without an entry get a neutral, slightly dimmed look.
export interface RoomLighting {
  ambient: string;
  lights: { x: number; y: number; radius: number; color: string }[];
}

const NEUTRAL: RoomLighting = { ambient: '#d6cec6', lights: [] };

const TABLE: Record<number, RoomLighting> = {
  // Outside Lefty's, night street
  11: {
    ambient: '#7c88b8',
    lights: [
      { x: 50, y: 66, radius: 75, color: 'rgba(255,205,140,0.45)' },
      { x: 137, y: 112, radius: 55, color: 'rgba(255,160,110,0.4)' },
      { x: 276, y: 40, radius: 55, color: 'rgba(120,150,255,0.35)' },
    ],
  },
  // Lefty's bar
  15: {
    ambient: '#b79a8c',
    lights: [
      { x: 160, y: 62, radius: 120, color: 'rgba(255,200,130,0.45)' },
      { x: 290, y: 100, radius: 50, color: 'rgba(255,230,190,0.3)' },
      { x: 90, y: 90, radius: 50, color: 'rgba(255,180,120,0.3)' },
    ],
  },
  // All-night store street
  22: {
    ambient: '#7b86b3',
    lights: [
      { x: 150, y: 80, radius: 80, color: 'rgba(255,235,170,0.4)' },
      { x: 300, y: 85, radius: 70, color: 'rgba(255,120,220,0.3)' },
    ],
  },
};

/**
 * Lighting derived from the picture itself, so every room gets the HD-2D treatment without hand tuning:
 * the ambient tint follows the picture's average colour (darker, cooler rooms stay dark and cool) and warm
 * light pools sit on clusters of yellow pixels, which AGI artists use for lamps and lit windows.
 */
function autoLighting(visual: Uint8Array): RoomLighting {
  let r = 0, g = 0, b = 0;
  const cells = new Map<number, number>();
  for (let i = 0; i < visual.length; i++) {
    const c = EGA[visual[i]!]!;
    r += c[0]; g += c[1]; b += c[2];
    if (visual[i] === 14) {
      const key = ((i % PIC_W) >> 3) + ((((i / PIC_W) | 0) >> 3) << 8);
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
  }
  const n = visual.length;
  const avg: [number, number, number] = [r / n, g / n, b / n];
  const lum = (0.3 * avg[0] + 0.59 * avg[1] + 0.11 * avg[2]) / 255;
  const mx = Math.max(avg[0], avg[1], avg[2], 1);
  const brightness = 0.58 + 0.42 * Math.min(1, lum * 2.2);
  const tint = (v: number) => Math.round(Math.min(255, (255 * (0.62 + 0.38 * (v / mx))) * brightness));
  const ambient = `rgb(${tint(avg[0])},${tint(avg[1])},${tint(avg[2])})`;
  const lights: RoomLighting['lights'] = [];
  const ranked = [...cells].filter(([, k]) => k >= 10).sort((a, b) => b[1] - a[1]);
  for (const [key] of ranked) {
    const x = ((key & 255) * 8 + 4) * 2, y = (key >> 8) * 8 + 4; // native pixels
    if (lights.every((l) => Math.hypot(l.x - x, l.y - y) > 60)) lights.push({ x, y, radius: 58, color: 'rgba(255,214,150,0.36)' });
    if (lights.length >= 4) break;
  }
  return { ambient, lights };
}

export function lightingFor(room: number, visual?: Uint8Array): RoomLighting {
  return TABLE[room] ?? (visual ? autoLighting(visual) : NEUTRAL);
}
