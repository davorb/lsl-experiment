// AGI (PCjr) sound resources: three tone voices plus noise, 5-byte records of (duration, divisor, attenuation).
const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);

export interface NoteEvent {
  /** Start and length in seconds. */
  t: number;
  dur: number;
  /** Frequency in Hz (tone) or noise rate selector (0-3) for the noise channel. */
  freq: number;
  /** 0 (loudest) to 15 (silent). */
  att: number;
  white?: boolean;
}
export interface ParsedSound { voices: NoteEvent[][]; noise: NoteEvent[]; length: number }

export function parseSound(b: Uint8Array): ParsedSound | null {
  if (b.length < 8) return null;
  const voices: NoteEvent[][] = [];
  let noise: NoteEvent[] = [];
  let length = 0;
  for (let ch = 0; ch < 4; ch++) {
    const events: NoteEvent[] = [];
    let p = u16(b, ch * 2);
    let t = 0;
    while (p + 4 < b.length) {
      const dur = u16(b, p);
      if (dur === 0xffff) break;
      const div = ((b[p + 2]! & 0x3f) << 4) | (b[p + 3]! & 0x0f);
      const att = b[p + 4]! & 0x0f;
      const seconds = dur / 60;
      if (ch < 3) events.push({ t, dur: seconds, freq: div ? 111860.8 / div : 0, att });
      else events.push({ t, dur: seconds, freq: b[p + 3]! & 3, att, white: (b[p + 3]! & 4) !== 0 });
      t += seconds;
      p += 5;
    }
    length = Math.max(length, t);
    if (ch < 3) voices.push(events);
    else noise = events;
  }
  return { voices, noise, length };
}
