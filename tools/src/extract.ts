// Asset extraction: ./game-data -> content/{backgrounds,sprites,rooms} + content/index.json
// Usage: npm run extract [-- --game-data <dir>] [--start <roomId>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { decodeMessages, decodeObjects, decodePicture, decodeView, isAgiDir, listResources, pictureToRGBA, viewDescription, PIC_H } from './agi';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const GAME = path.resolve(opt('game-data') ?? path.join(ROOT, 'game-data'));
const CONTENT = path.join(ROOT, 'content');

function fail(msg: string): never {
  console.error(`extract: ${msg}`);
  process.exit(1);
}

function writePng(file: string, width: number, height: number, data: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const png = new PNG({ width, height });
  data.copy(png.data);
  fs.writeFileSync(file, PNG.sync.write(png));
}

function pngSize(file: string): [number, number] | null {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString('ascii', 1, 4) !== 'PNG') return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function writeStubRoom(id: string, w: number, h: number, withPriority = false): void {
  const f = path.join(CONTENT, 'rooms', `${id}.json`);
  if (fs.existsSync(f)) return; // never clobber hand-authored rooms
  const room = {
    id,
    size: [w, h],
    background: `backgrounds/${id}.png`,
    walk: [],
    scale: { yMin: 0, yMax: h, scaleMin: 1, scaleMax: 1 },
    masks: [],
    ...(withPriority ? { priority: `masks/${id}.pri.png` } : {}),
    hotspots: [],
    exits: [],
    lights: [],
  };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(room, null, 2) + '\n');
}

interface IndexFile {
  start: string;
  rooms: string[];
  player?: { view: string; dirs: Record<'right' | 'left' | 'down' | 'up', number>; frameMs: number };
}

function updateIndex(rooms: string[], player: IndexFile['player'] | undefined): void {
  const f = path.join(CONTENT, 'index.json');
  const idx: IndexFile = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { start: rooms[0] ?? 'lobby', rooms: [] };
  for (const r of rooms) if (!idx.rooms.includes(r)) idx.rooms.push(r);
  if (player) idx.player = player;
  const start = opt('start');
  if (start) idx.start = start;
  fs.writeFileSync(f, JSON.stringify(idx, null, 2) + '\n');
}

// ---- AGI (LSL1) ---------------------------------------------------------------

function extractAgi(): void {
  const pics = listResources(GAME, 'PICDIR');
  const views = listResources(GAME, 'VIEWDIR');
  const rooms: string[] = [];
  let skipped = 0;
  for (const [n, data] of [...pics].sort((a, b) => a[0] - b[0])) {
    const id = `pic${String(n).padStart(2, '0')}`;
    const pic = decodePicture(data);
    const rgba = pictureToRGBA(pic);
    writePng(path.join(CONTENT, 'backgrounds', `${id}.png`), rgba.width, rgba.height, rgba.data);
    const painted = pic.visual.reduce((a, c) => a + (c !== 15 ? 1 : 0), 0) / pic.visual.length;
    // AGI priority screen -> masks/<id>.pri.png (red = priority * 16). The client draws pixels whose priority
    // exceeds an actor's (derived from its foot Y) over that actor, which gives bars, poles and railings.
    const pri = Buffer.alloc(rgba.width * PIC_H * 4, 255);
    let hasPri = false;
    for (let y = 0; y < PIC_H; y++) {
      for (let x = 0; x < rgba.width; x++) {
        const q = pic.priority[y * 160 + (x >> 1)]!;
        if (q > 4) hasPri = true;
        const o = (y * rgba.width + x) * 4;
        pri[o] = q * 16; pri[o + 1] = 0; pri[o + 2] = 0;
      }
    }
    if (hasPri) writePng(path.join(CONTENT, 'masks', `${id}.pri.png`), rgba.width, PIC_H, pri);
    writeStubRoom(id, rgba.width, PIC_H, hasPri);
    // Pictures that are nearly blank (title cards, overlays) are written but not listed as rooms.
    if (painted > 0.25) rooms.push(id);
    else skipped++;
  }
  console.log(`pictures: ${pics.size} written, ${rooms.length} listed as rooms (${skipped} mostly blank)`);

  let viewCount = 0;
  let player: IndexFile['player'] | undefined;
  for (const [n, data] of [...views].sort((a, b) => a[0] - b[0])) {
    const loops = decodeView(data);
    if (!loops) continue;
    const dir = path.join(CONTENT, 'sprites', String(n));
    const sidecar = loops.map((cels, li) =>
      cels.map((c, ci) => {
        const file = `${li}_${ci}.png`;
        writePng(path.join(dir, file), c.width, c.height, c.rgba);
        // Origin = foot point: bottom centre of the cel.
        return { file, w: c.width, h: c.height, originX: Math.floor(c.width / 2), originY: c.height - 1 };
      }),
    );
    fs.writeFileSync(path.join(dir, 'view.json'), JSON.stringify({ viewId: String(n), loops: sidecar }, null, 2) + '\n');
    viewCount++;
    // First view with >=4 loops is Larry (AGI ego convention: 0 right, 1 left, 2 front, 3 back).
    if (!player && loops.length >= 4) {
      player = { view: String(n), dirs: { right: 0, left: 1, down: 2, up: 3 }, frameMs: 130 };
    }
  }
  console.log(`views: ${viewCount} written; player view = ${player?.view ?? 'none (client uses 16x32 rectangle)'}`);
  extractText(views);
  updateIndex(rooms, player);
  console.log(`rooms: ${rooms.slice(0, 12).join(', ')}${rooms.length > 12 ? ', ...' : ''}`);
}

// Game text goes to content/text/ (gitignored like the art): per-logic message tables, inventory
// object names, and view descriptions (which hold the "look at item" texts).
function extractText(views: Map<number, Buffer>): void {
  const dir = path.join(CONTENT, 'text');
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const [no, data] of listResources(GAME, 'LOGDIR')) {
    const m = decodeMessages(data);
    if (Object.keys(m).length) { fs.writeFileSync(path.join(dir, `logic${no}.json`), JSON.stringify(m, null, 1)); n++; }
  }
  const desc: Record<string, string> = {};
  for (const [no, data] of views) {
    const d = viewDescription(data);
    if (d) desc[String(no)] = d;
  }
  fs.writeFileSync(path.join(dir, 'views.json'), JSON.stringify(desc, null, 1));
  fs.writeFileSync(path.join(dir, 'objects.json'), JSON.stringify(decodeObjects(GAME), null, 1));
  console.log(`text: ${n} logic message tables, ${Object.keys(desc).length} view descriptions, objects.json`);
}

// ---- already-extracted PNGs ---------------------------------------------------

function importPngs(files: string[]): void {
  const rooms: string[] = [];
  for (const f of files) {
    const size = pngSize(f);
    if (!size) continue;
    const base = path.basename(f, '.png');
    const rel = path.relative(GAME, f).split(path.sep);
    if (rel[0] === 'sprites' && rel.length >= 3) {
      const dest = path.join(CONTENT, 'sprites', ...rel.slice(1));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
    } else if (size[0] >= 256 || rel[0] === 'backgrounds') {
      const id = base.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      fs.mkdirSync(path.join(CONTENT, 'backgrounds'), { recursive: true });
      fs.copyFileSync(f, path.join(CONTENT, 'backgrounds', `${id}.png`));
      writeStubRoom(id, size[0], size[1]);
      rooms.push(id);
    }
  }
  if (!rooms.length) fail('found PNGs but none look like backgrounds (width >= 256 or under backgrounds/).');
  updateIndex(rooms, undefined);
  console.log(`imported ${rooms.length} backgrounds: ${rooms.join(', ')}`);
  console.log('note: sprite sidecars (view.json) are not synthesized for loose PNGs; see tools/README.md.');
}

// ---- SCI (LSL6) -----------------------------------------------------------------

function extractSci(): void {
  // No stable CLI is known for SCI32 views/pics. If the user has one, SCI_EXTRACT_CMD is run
  // as: $SCI_EXTRACT_CMD <game-data> <out-dir>, and its output dir is then imported as PNGs.
  const cmd = process.env.SCI_EXTRACT_CMD;
  if (!cmd) fail('packed SCI resources found; install SCI Companion or ScummVM tools and set SCI_EXTRACT_CMD (see tools/README.md), or drop pre-extracted PNGs into game-data/.');
  const out = fs.mkdtempSync(path.join(ROOT, 'game-data-extract-'));
  const r = spawnSync(cmd, [GAME, out], { stdio: 'inherit', shell: true });
  if (r.status !== 0) fail(`SCI_EXTRACT_CMD failed (exit ${r.status}).`);
  importPngs(walk(out).filter((f) => f.endsWith('.png')));
}

// ---- main -------------------------------------------------------------------------

if (!fs.existsSync(GAME)) fail(`${GAME} does not exist; drop your game files there.`);
const all = walk(GAME);
if (isAgiDir(GAME)) {
  console.log('detected: AGI (LSL1) resources, using built-in reader');
  extractAgi();
} else if (all.some((f) => /(^|\/)(RESOURCE\.(000|MAP)|RESMAP\.\d+|RESSCI\.\d+)$/i.test(f))) {
  console.log('detected: packed SCI resources');
  extractSci();
} else if (all.some((f) => f.toLowerCase().endsWith('.png'))) {
  console.log('detected: pre-extracted PNGs');
  importPngs(all.filter((f) => f.toLowerCase().endsWith('.png')));
} else {
  fail('nothing recognizable in game-data/ (expected AGI VOL/DIR files, SCI RESOURCE/RESMAP files, or PNGs).');
}
