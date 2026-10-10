// Usage: tsx src/dump-logic.ts <logicNo...>   (reads ./game-data)   Output is for local authoring only.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMessages, listResources } from './agi';
import { disassemble, loadWords } from './agi-logic';

const GAME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../game-data');
const logics = listResources(GAME, 'LOGDIR');
const words = loadWords(GAME);
const nums = process.argv.slice(2);
if (nums[0] === '--check') {
  let bad = 0;
  for (const [n, b] of logics) {
    const r = disassemble(b, words, decodeMessages(b));
    if (!r.ok) { bad++; console.log(`logic ${n}: ${r.lines.at(-1)}`); }
  }
  console.log(`checked ${logics.size} logics, ${bad} failed to parse cleanly; ${words.size} words loaded`);
} else {
  for (const n of nums.map(Number)) {
    const b = logics.get(n);
    if (!b) { console.log(`no logic ${n}`); continue; }
    const r = disassemble(b, words, decodeMessages(b));
    console.log(`// logic ${n} ok=${r.ok}`);
    console.log(r.lines.join('\n'));
  }
}
