// Read-only AGI logic disassembler: an authoring aid for finding which message belongs to which
// object/verb and where objects are placed. It does not execute anything.
import fs from 'node:fs';
import path from 'node:path';

// Argument counts for AGI v2 action commands, indexed by opcode.
const ARGS = [0,1,1,2,2,2,2,2,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,1,1,0,1,1,1,1,0,1,1,3,3,3,3,2,2,2,2,1,1,2,2,2,2,2,2,2,2,2,1,2,1,1,1,1,1,1,1,1,1,1,1,3,1,1,1,2,1,2,2,1,1,2,2,5,5,3,1,1,2,2,1,1,4,0,1,1,1,2,2,2,1,2,0,1,1,3,3,3,0,0,1,2,1,3,0,0,2,5,2,1,2,0,0,3,7,7,0,0,0,0,0,1,3,0,0,1,1,0,0,0,0,0,0,0,1,1,1,0,0,3,3,0,3,4,4,1,5,2,1,2,0,1,1,0,1,0,0,2,2,2,2,0];
const NAMES: Record<number, string> = {
  1: 'increment', 2: 'decrement', 3: 'assignn', 4: 'assignv', 5: 'addn', 6: 'addv', 7: 'subn', 8: 'subv', 12: 'set', 13: 'reset', 14: 'toggle',
  18: 'new.room', 19: 'new.room.v', 22: 'call', 24: 'load.pic', 25: 'draw.pic', 30: 'load.view', 33: 'animate.obj', 35: 'draw', 36: 'erase',
  37: 'position', 38: 'position.v', 41: 'set.view', 42: 'set.view.v', 43: 'set.loop', 47: 'set.cel', 54: 'set.priority', 92: 'get', 94: 'drop',
  95: 'put', 101: 'print', 102: 'print.v', 103: 'display', 130: 'random', 151: 'print.at', 122: 'add.to.pic', 70: 'stop.cycling', 71: 'start.cycling',
  81: 'move.obj', 77: 'stop.motion', 79: 'step.size', 90: 'block', 144: 'log',
};
const TESTS: Record<number, [string, number]> = {
  1: ['equaln', 2], 2: ['equalv', 2], 3: ['lessn', 2], 4: ['lessv', 2], 5: ['greatern', 2], 6: ['greaterv', 2], 7: ['isset', 1], 8: ['isset.v', 1],
  9: ['has', 1], 10: ['obj.in.room', 2], 11: ['posn', 5], 12: ['controller', 1], 13: ['have.key', 0], 15: ['compare.strings', 2],
  16: ['obj.in.box', 5], 17: ['center.posn', 5], 18: ['right.posn', 5],
};

export function loadWords(dir: string): Map<number, string> {
  const m = new Map<number, string>();
  const f = path.join(dir, 'WORDS.TOK');
  if (!fs.existsSync(f)) return m;
  const b = fs.readFileSync(f);
  let p = 52;
  let prev = '';
  while (p < b.length - 2) {
    const keep = b[p++]!;
    let w = prev.slice(0, keep);
    for (;;) {
      const c = b[p++]!;
      w += String.fromCharCode((c & 0x7f) ^ 0x7f);
      if (c & 0x80) break;
      if (p >= b.length) return m;
    }
    const id = (b[p]! << 8) | b[p + 1]!;
    p += 2;
    prev = w;
    if (!m.has(id)) m.set(id, w);
  }
  return m;
}

export interface Disasm { lines: string[]; ok: boolean }

export function disassemble(b: Buffer, words: Map<number, string>, msgs: Record<number, string>): Disasm {
  const end = 2 + b.readUInt16LE(0);
  const lines: string[] = [];
  const closes: number[] = [];
  let p = 2;
  const ind = () => '  '.repeat(closes.length);
  const msg = (n: number) => JSON.stringify(msgs[n] ?? `<msg ${n}?>`);
  while (p < end) {
    while (closes.length && closes[closes.length - 1]! <= p) { closes.pop(); lines.push(`${ind()}}`); }
    const at = p;
    const op = b[p++]!;
    if (op === 0xff) {
      const conds: string[] = [];
      let neg = false;
      for (;;) {
        const t = b[p++]!;
        if (t === 0xff) break;
        if (t === 0xfd) { neg = true; continue; }
        if (t === 0xfc) { conds.push('OR'); continue; }
        if (t === 14) {
          const n = b[p++]!;
          const ws: string[] = [];
          for (let i = 0; i < n; i++) { const id = b.readUInt16LE(p); p += 2; ws.push(id === 9999 ? '*' : id === 1 ? 'any' : (words.get(id) ?? `#${id}`)); }
          conds.push(`${neg ? '!' : ''}said(${ws.join(' ')})`);
        } else {
          const d = TESTS[t];
          if (!d) return { lines: [...lines, `?? bad test ${t} at ${at}`], ok: false };
          const a = Array.from(b.subarray(p, p + d[1]));
          p += d[1];
          conds.push(`${neg ? '!' : ''}${d[0]}(${a.join(',')})`);
        }
        neg = false;
      }
      const size = b.readUInt16LE(p);
      p += 2;
      lines.push(`${ind()}if (${conds.join(' && ').replace(/ && OR && /g, ' || ')}) {`);
      closes.push(p + size);
    } else if (op === 0xfe) {
      const off = b.readInt16LE(p);
      p += 2;
      lines.push(`${ind()}goto ${p + off}`);
    } else {
      const n = ARGS[op];
      if (n === undefined || op > 169) return { lines: [...lines, `?? bad op ${op} at ${at}`], ok: false };
      const a = Array.from(b.subarray(p, p + n));
      p += n;
      const name = NAMES[op] ?? `cmd${op}`;
      if (op === 101) lines.push(`${ind()}print(${msg(a[0]!)})`);
      else if (op === 151) lines.push(`${ind()}print.at(${msg(a[0]!)}, ${a.slice(1).join(',')})`);
      else lines.push(`${ind()}${name}(${a.join(',')})`);
    }
  }
  while (closes.length) { closes.pop(); lines.push(`${ind()}}`); }
  return { lines, ok: p === end };
}
