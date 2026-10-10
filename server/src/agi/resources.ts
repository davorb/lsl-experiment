// Loads the extracted AGI resources (content/agi/) once; everything is parsed lazily and cached.
import fs from 'node:fs';
import path from 'node:path';
import { parseLogic, parseObjects, parseWords, type GameObjectDef, type ParsedLogic, type Vocabulary } from '../../../shared/agi/logic';
import { parseView, type ParsedView } from '../../../shared/agi/view';
import { parseSound, type ParsedSound } from '../../../shared/agi/sound';
import { CONTENT_DIR } from '../content';

const DIR = path.join(CONTENT_DIR, 'agi');

export function agiAvailable(): boolean {
  return fs.existsSync(path.join(DIR, 'logic', '0.bin')) && fs.existsSync(path.join(DIR, 'words.bin'));
}

export class AgiResources {
  private logics = new Map<number, ParsedLogic | null>();
  private views = new Map<number, ParsedView | null>();
  private pics = new Map<number, Uint8Array | null>();
  private sounds = new Map<number, ParsedSound | null>();
  readonly vocab: Vocabulary;
  readonly objects: GameObjectDef[];

  constructor() {
    this.vocab = parseWords(fs.readFileSync(path.join(DIR, 'words.bin')));
    const f = path.join(DIR, 'object.bin');
    this.objects = fs.existsSync(f) ? parseObjects(fs.readFileSync(f)) : [];
  }

  private raw(kind: string, n: number): Uint8Array | null {
    const f = path.join(DIR, kind, `${n}.bin`);
    return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null;
  }
  logic(n: number): ParsedLogic | null {
    if (!this.logics.has(n)) { const r = this.raw('logic', n); this.logics.set(n, r ? parseLogic(r) : null); }
    return this.logics.get(n)!;
  }
  view(n: number): ParsedView | null {
    if (!this.views.has(n)) { const r = this.raw('view', n); this.views.set(n, r ? parseView(r) : null); }
    return this.views.get(n)!;
  }
  pic(n: number): Uint8Array | null {
    if (!this.pics.has(n)) this.pics.set(n, this.raw('pic', n));
    return this.pics.get(n)!;
  }
  sound(n: number): ParsedSound | null {
    if (!this.sounds.has(n)) { const r = this.raw('snd', n); this.sounds.set(n, r ? parseSound(r) : null); }
    return this.sounds.get(n)!;
  }
}
