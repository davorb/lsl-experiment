// AGI logic resources (bytecode + message table) and the WORDS.TOK vocabulary.
const KEY = 'Avis Durgan';
const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);

export interface ParsedLogic {
  /** Bytecode, starting at offset 0 = first instruction. */
  code: Uint8Array;
  /** Messages by 1-based number. */
  messages: Record<number, string>;
}

export function parseLogic(b: Uint8Array): ParsedLogic {
  const codeEnd = 2 + u16(b, 0);
  const code = b.slice(2, codeEnd);
  const messages: Record<number, string> = {};
  const msgStart = codeEnd;
  if (msgStart + 3 <= b.length) {
    const count = b[msgStart]!;
    const textStart = msgStart + 3 + count * 2;
    for (let i = 0; i < count && textStart <= b.length; i++) {
      const off = u16(b, msgStart + 3 + i * 2);
      if (off === 0) continue;
      let p = msgStart + 1 + off;
      let s = '';
      while (p < b.length) {
        const c = b[p]! ^ KEY.charCodeAt((p - textStart) % KEY.length);
        if (c === 0) break;
        s += String.fromCharCode(c);
        p++;
      }
      messages[i + 1] = s;
    }
  }
  return { code, messages };
}

export interface Vocabulary {
  /** Word (lower case, may contain spaces) -> word id. Id 0 = ignored filler word. */
  words: Map<string, number>;
  maxWordLen: number;
}

export function parseWords(b: Uint8Array): Vocabulary {
  const words = new Map<string, number>();
  let p = 52;
  let prev = '';
  let maxWordLen = 0;
  while (p < b.length - 2) {
    const keep = b[p++]!;
    let w = prev.slice(0, keep);
    for (;;) {
      const c = b[p++]!;
      w += String.fromCharCode((c & 0x7f) ^ 0x7f);
      if (c & 0x80) break;
      if (p >= b.length) return { words, maxWordLen };
    }
    const id = (b[p]! << 8) | b[p + 1]!;
    p += 2;
    prev = w;
    words.set(w, id);
    maxWordLen = Math.max(maxWordLen, w.split(' ').length);
  }
  return { words, maxWordLen };
}

export interface GameObjectDef { id: number; name: string; room: number }

/** OBJECT file: item names and starting rooms (XOR-encrypted in most releases). */
export function parseObjects(raw: Uint8Array): GameObjectDef[] {
  const dec = raw.map((c, i) => c ^ KEY.charCodeAt(i % KEY.length));
  const ok = (b: Uint8Array) => b.length > 6 && u16(b, 0) > 0 && u16(b, 0) < b.length && u16(b, 0) % 3 === 0;
  const b = !ok(raw) && ok(dec) ? dec : raw;
  const count = Math.floor(u16(b, 0) / 3);
  const out: GameObjectDef[] = [];
  for (let i = 0; i < count; i++) {
    const off = u16(b, 3 + i * 3);
    let e = 3 + off;
    while (e < b.length && b[e] !== 0) e++;
    out.push({ id: i, name: String.fromCharCode(...b.subarray(3 + off, e)), room: b[3 + i * 3 + 2]! });
  }
  return out;
}
