// Smoke test for the AGI interpreter. Needs the extracted game (npm run extract); skips itself otherwise.
// Asserts on game state (rooms, positions, score, inventory), never on original text.
import fs from 'node:fs';
import path from 'node:path';
import { AgiResources, agiAvailable } from '../src/agi/resources';
import { AgiInterp, type Modal } from '../src/agi/interp';
import { CONTENT_DIR } from '../src/content';

if (!agiAvailable()) { console.log('smoke: no extracted game data, skipping'); process.exit(0); }

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failures++; };
const res = new AgiResources();

class Game {
  g = new AgiInterp(res);
  printed: string[] = [];
  private waits = 0;
  step(): void {
    this.g.nowMs += 50;
    const it = this.g.cycle();
    let r = it.next();
    while (!r.done) {
      const m: Modal = r.value;
      if (m.kind === 'wait') { if (++this.waits % 40 === 0) this.g.pressKey(13, 28); r = it.next(undefined); continue; }
      if (m.kind === 'print' || m.kind === 'message') this.printed.push(m.text);
      r = it.next(m.kind === 'number' ? 30 : m.kind === 'string' ? 'x' : m.kind === 'inventory' ? 255 : undefined);
    }
  }
  run(n: number): void { for (let i = 0; i < n; i++) this.step(); }
  say(cmd: string, n = 12): string[] { const from = this.printed.length; this.g.enterCommand(cmd); this.run(n); return this.printed.slice(from); }
  walk(dir: number, n: number): void { this.g.setDirection(dir); this.run(n); this.g.setDirection(0); this.run(1); }
  /** The game's own restart path (flag 6) skips the title and the age quiz, which needs real answer keys. */
  intro(): void { this.g.flags[6] = 1; for (let i = 0; i < 400 && this.g.vars[0] !== 11; i++) this.step(); this.run(20); }
}

// 1. boot and intro reach the first playable room, with a status line and a drawn ego
{
  const t = new Game();
  t.intro();
  const ego = t.g.objs[0]!;
  check('intro reaches room 11', t.g.vars[0] === 11);
  check('ego drawn and under player control', ego.drawn && t.g.playerControl);
  check('status line on, max score set', t.g.statusLine && t.g.vars[7]! > 0);

  // 2. walking and barriers
  const x0 = ego.x;
  t.walk(7, 10);
  check('ego walks left', ego.x < x0, `${x0} -> ${ego.x}`);
  t.walk(1, 60);
  check('barrier line stops the ego walking up', ego.y > 100, `y=${ego.y}`);

  // 3. parser: known verb answers, unknown word is reported by the game
  check('"look" prints something', t.say('look').length > 0);
  check('gibberish still gets a response', t.say('qwertyuiop').length > 0);

  // 4. pathfinding
  t.g.setWalkTarget({ x: 120, y: 150 });
  for (let i = 0; i < 300 && t.g.walkTarget; i++) t.step();
  check('click-to-walk arrives', !t.g.walkTarget && Math.abs(ego.x + t.g.celW(ego) / 2 - 120) < 6, `ego ${ego.x},${ego.y}`);

  // 5. entering the bar and ordering a drink changes cash, score and inventory
  t.g.setWalkTarget({ x: 67, y: 133 });
  for (let i = 0; i < 300 && t.g.walkTarget; i++) t.step();
  t.say('open door', 40);
  check('door leads into the bar (room 15)', t.g.vars[0] === 15);
  if (t.g.vars[0] === 15) {
    t.walk(1, 16); t.walk(3, 14); t.walk(1, 20);
    t.say('sit', 20);
    check('sitting switches the ego view', t.g.objs[0]!.view !== 0, `view ${t.g.objs[0]!.view}`);
    const cash = t.g.vars[90]!;
    t.say('buy shot', 120);
    check('ordering spends cash and scores', t.g.vars[90]! < cash && t.g.vars[3]! > 0, `cash ${cash} -> ${t.g.vars[90]}`);
    check('whiskey is carried', t.g.items.some((i) => i.room === 255 && /whiskey/i.test(i.name)));
  }
}

// 2. every room's logic runs without throwing
{
  const dir = path.join(CONTENT_DIR, 'agi', 'logic');
  const rooms = fs.readdirSync(dir).map((f) => Number(f.replace('.bin', ''))).filter((n) => n > 0).sort((a, b) => a - b);
  const bad: string[] = [];
  for (const room of rooms) {
    const t = new Game();
    try {
      t.intro();
      t.g.requestRoom(room);
      for (let i = 0; i < 150; i++) {
        if (i % 9 === 0) t.g.setDirection(1 + (i % 8));
        if (i % 40 === 20) t.g.enterCommand('look');
        t.step();
      }
    } catch (e) { bad.push(`${room}: ${(e as Error).message}`); }
  }
  check(`all ${rooms.length} rooms run without errors`, bad.length === 0, bad.join('; '));
}

// 3. sounds all decode
{
  const dir = path.join(CONTENT_DIR, 'agi', 'snd');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const bad = files.filter((f) => res.sound(Number(f.replace('.bin', ''))) === null);
  check(`all ${files.length} sounds decode`, bad.length === 0, bad.join(','));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
