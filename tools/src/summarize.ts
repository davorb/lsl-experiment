// Usage: tsx src/summarize.ts [logic...]  -> room exits, item changes and score changes with their guarding conditions.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMessages, listResources } from './agi';
import { loadWords, summarize } from './agi-logic';

const GAME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../game-data');
const logics = listResources(GAME, 'LOGDIR');
const words = loadWords(GAME);
const only = process.argv.slice(2).map(Number);
const items = (await import('./agi')).decodeObjects(GAME);
for (const [n, b] of logics) {
  if (only.length && !only.includes(n)) continue;
  const msgs = decodeMessages(b);
  const lines = summarize(b, words, (op, a) => {
    switch (op) {
      case 18: return `NEW ROOM ${a[0]}`;
      case 19: return `NEW ROOM v${a[0]}`;
      case 92: return `GET ${items[a[0]!]?.name ?? a[0]}`;
      case 94: return `DROP ${items[a[0]!]?.name ?? a[0]}`;
      case 95: return `PUT ${items[a[0]!]?.name ?? a[0]} in room ${a[1]}`;
      case 5: return a[0] === 3 ? `SCORE +${a[1]}` : null;
      case 7: return a[0] === 90 ? `MONEY -${a[1]}` : null;
      case 3: return a[0] === 76 ? `GOTO ROOM ${a[1]}` : null;
      case 4: return a[0] === 76 ? `GOTO ROOM v${a[1]}` : null;
      case 101: return null;
      default: return null;
    }
  });
  void msgs;
  if (lines.length) console.log(`\n== logic ${n} ==\n${lines.join('\n')}`);
}
