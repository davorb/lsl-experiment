import { Application, Container, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import { priorityStartY, scaleAt, type Anim, type Facing, type Pt, type Room } from '../../shared/protocol';
import { pixelTexture, type Frame, type PlayerSprites } from './content';
import { buildLights, makeTiltShift, vignetteTexture, type LightLayers, type TiltShift } from './fx';
import { fallbackActorCanvas, placeholderBackground } from './placeholder';

const INTERP_DELAY_MS = 120; // render slightly behind the 10 Hz snapshots so we always have two to blend
const BUBBLE_MS = 4000;
const DPR = Math.min(window.devicePixelRatio || 1, 3);

interface Snap { t: number; x: number; y: number; facing: Facing; anim: Anim }

interface Actor {
  id: string;
  sprite: Sprite;
  label: Text;
  bubble: Container | null;
  bubbleUntil: number;
  buf: Snap[];
  fallback: Texture | null;
  w: number;
  h: number;
  scale: number;
  x: number;
  y: number;
}

export interface PropSpec {
  frames: Frame[];
  cel: number;
  agi?: [number, number];
  at?: [number, number];
  cycleMs?: number;
}
interface Prop extends PropSpec { sprite: Sprite }

const COLORS = ['#d94f4f', '#4f8fd9', '#4fd98f', '#d9c34f', '#a24fd9', '#d98f4f', '#4fd9d3', '#d94fa2'];

export class Scene {
  readonly app: Application;
  private root = new Container(); // filtered (tilt-shift)
  private world = new Container(); // native pixels, scaled by integer zoom
  private actorLayer = new Container();
  private overlay = new Container(); // screen-space text, unfiltered
  private vignette = new Sprite(vignetteTexture());
  private tilt: TiltShift = makeTiltShift();
  private bg = new Sprite();
  private fg = new Sprite();
  private lights: LightLayers | null = null;
  private actors = new Map<string, Actor>();
  private props: Prop[] = [];
  private priLayers: Sprite[] = [];
  private colorIdx = 0;
  room: Room | null = null;
  zoom = 2;
  sprites: PlayerSprites | null = null;
  frameMs = 130;

  constructor(app: Application) {
    this.app = app;
    this.actorLayer.sortableChildren = true;
    this.world.addChild(this.bg, this.actorLayer, this.fg);
    this.root.addChild(this.world);
    this.root.filters = [this.tilt.filter];
    this.vignette.alpha = 0.32;
    this.vignette.eventMode = 'none';
    this.overlay.eventMode = 'none';
    app.stage.addChild(this.root, this.vignette, this.overlay);
    app.ticker.add(() => this.update());
  }

  setZoom(zoom: number): void {
    this.zoom = zoom;
    const [w, h] = this.room?.size ?? [320, 168];
    this.app.renderer.resize(w * zoom, h * zoom);
    this.world.scale.set(zoom);
    this.root.filterArea = new Rectangle(0, 0, w * zoom, h * zoom);
    this.tilt.setBlurTexels(1.6 * zoom * DPR);
    this.vignette.width = w * zoom;
    this.vignette.height = h * zoom;
  }

  async setRoom(room: Room, background: Texture | null, masks: HTMLCanvasElement | null, props: PropSpec[] = [], layers: { q: number; canvas: HTMLCanvasElement }[] = []): Promise<void> {
    this.room = room;
    for (const l of this.priLayers) l.destroy();
    this.priLayers = layers.map(({ q, canvas }) => {
      const sp = new Sprite(pixelTexture(Texture.from(canvas)));
      sp.zIndex = priorityStartY(q) - 0.5; // draws over every actor whose foot Y is above this priority band
      sp.eventMode = 'none';
      this.actorLayer.addChild(sp);
      return sp;
    });
    for (const p of this.props) p.sprite.destroy();
    this.props = props.map((spec) => {
      const sprite = new Sprite();
      this.actorLayer.addChild(sprite);
      return { ...spec, sprite };
    });
    this.bg.texture = background ?? pixelTexture(Texture.from(placeholderBackground(room)));
    this.fg.visible = !!masks;
    if (masks) this.fg.texture = pixelTexture(Texture.from(masks));
    this.lights?.dispose();
    this.lights = buildLights(this.app.renderer, room);
    this.world.addChild(this.lights.multiply, this.lights.glow);
    this.setZoom(this.zoom);
  }

  // ---- actors ----------------------------------------------------------------------

  syncActors(players: Record<string, { name: string; roomId: string; x: number; y: number; facing: Facing; anim: Anim }>): void {
    const here = new Set<string>();
    for (const [id, p] of Object.entries(players)) {
      if (p.roomId !== this.room?.id) continue;
      here.add(id);
      let a = this.actors.get(id);
      if (!a) a = this.createActor(id, p.name);
      a.label.text = p.name;
      this.snap(id, p);
    }
    for (const id of [...this.actors.keys()]) if (!here.has(id)) this.removeActor(id);
  }

  private createActor(id: string, name: string): Actor {
    const sprite = new Sprite();
    this.actorLayer.addChild(sprite);
    const label = new Text({
      text: name,
      style: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
      resolution: DPR,
    });
    label.anchor.set(0.5, 1);
    this.overlay.addChild(label);
    const a: Actor = { id, sprite, label, bubble: null, bubbleUntil: 0, buf: [], fallback: null, w: 16, h: 32, scale: 1, x: 0, y: 0 };
    if (!this.sprites) {
      const color = COLORS[this.colorIdx++ % COLORS.length]!;
      a.fallback = pixelTexture(Texture.from(fallbackActorCanvas(color)));
    }
    this.actors.set(id, a);
    return a;
  }

  private removeActor(id: string): void {
    const a = this.actors.get(id);
    if (!a) return;
    a.sprite.destroy();
    a.label.destroy();
    a.bubble?.destroy({ children: true });
    this.actors.delete(id);
  }

  /** Hard position set (spawn, room change). */
  snap(id: string, p: { x: number; y: number; facing: Facing; anim: Anim }): void {
    const a = this.actors.get(id);
    if (!a) return;
    a.buf = [{ t: performance.now(), x: p.x, y: p.y, facing: p.facing, anim: p.anim }];
  }

  pushMove(id: string, m: { x: number; y: number; facing: Facing; anim: Anim }): void {
    const a = this.actors.get(id);
    if (!a) return;
    a.buf.push({ t: performance.now(), ...m });
    if (a.buf.length > 20) a.buf.shift();
  }

  showBubble(id: string, text: string): void {
    const a = this.actors.get(id);
    if (!a) return;
    a.bubble?.destroy({ children: true });
    const t = new Text({
      text,
      style: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, fill: 0x111111, wordWrap: true, wordWrapWidth: 170 },
      resolution: DPR,
    });
    t.anchor.set(0.5, 1);
    t.position.set(0, -4);
    const bg = new Graphics().roundRect(-t.width / 2 - 6, -t.height - 8, t.width + 12, t.height + 8, 5).fill(0xfff6dc).stroke({ color: 0x222222, width: 1 });
    const b = new Container();
    b.addChild(bg, t);
    this.overlay.addChild(b);
    a.bubble = b;
    a.bubbleUntil = performance.now() + BUBBLE_MS;
  }

  /** Topmost actor under a native-pixel point. */
  hitActor(nx: number, ny: number): string | null {
    let best: string | null = null;
    let bestY = -Infinity;
    for (const a of this.actors.values()) {
      if (nx >= a.x - (a.w * a.scale) / 2 && nx <= a.x + (a.w * a.scale) / 2 && ny <= a.y && ny >= a.y - a.h * a.scale && a.y > bestY) {
        best = a.id;
        bestY = a.y;
      }
    }
    return best;
  }

  private updateProps(now: number): void {
    for (const p of this.props) {
      if (!p.frames.length) continue;
      const i = p.cycleMs && p.frames.length > 1 ? Math.floor(now / p.cycleMs) % p.frames.length : p.cel;
      const f = p.frames[i] ?? p.frames[0]!;
      p.sprite.texture = f.texture;
      p.sprite.anchor.set(f.ax, f.ay);
      // AGI places cels by their bottom-left corner in 160-wide units; native foot centre = x*2 + width/2.
      const x = p.agi ? p.agi[0] * 2 + f.texture.width / 2 : (p.at?.[0] ?? 0);
      const y = p.agi ? p.agi[1] : (p.at?.[1] ?? 0);
      p.sprite.position.set(Math.round(x), Math.round(y));
      p.sprite.zIndex = y;
    }
  }

  private update(): void {
    const now = performance.now();
    this.updateProps(now);
    const rt = now - INTERP_DELAY_MS;
    const room = this.room;
    if (!room) return;
    for (const a of this.actors.values()) {
      const buf = a.buf;
      if (!buf.length) continue;
      // Drop snapshots older than the one just before render time.
      while (buf.length > 2 && buf[1]!.t <= rt) buf.shift();
      const p = buf[0]!;
      const n = buf[1];
      let x = p.x, y = p.y, facing = p.facing, anim = p.anim;
      if (n && rt >= p.t) {
        const k = Math.min(1, (rt - p.t) / Math.max(1, n.t - p.t));
        x = p.x + (n.x - p.x) * k;
        y = p.y + (n.y - p.y) * k;
        facing = n.facing;
        anim = k >= 1 ? n.anim : p.anim === 'walk' || n.anim === 'walk' ? 'walk' : n.anim;
      }
      a.x = x;
      a.y = y;
      const sc = scaleAt(room, y);
      a.scale = sc;
      this.applyFrame(a, facing, anim, now);
      a.sprite.scale.set(sc);
      a.sprite.position.set(Math.round(x), Math.round(y)); // snap to native pixels for crisp art
      a.sprite.zIndex = y; // y-sort by foot
      const sx = Math.round(x) * this.zoom;
      const top = (Math.round(y) - a.h * sc) * this.zoom;
      a.label.position.set(sx, top - 2);
      if (a.bubble) {
        if (now > a.bubbleUntil) { a.bubble.destroy({ children: true }); a.bubble = null; }
        else a.bubble.position.set(sx, top - 18);
      }
    }
  }

  private applyFrame(a: Actor, facing: Facing, anim: Anim, now: number): void {
    const s = this.sprites;
    if (!s) {
      if (a.fallback) { a.sprite.texture = a.fallback; a.sprite.anchor.set(0.5, 1); }
      return;
    }
    if (anim === 'sit' && s.sit) {
      a.sprite.texture = s.sit.texture;
      a.sprite.anchor.set(s.sit.ax, s.sit.ay);
      a.w = s.sit.texture.width;
      a.h = s.sit.texture.height;
      return;
    }
    const loop = s.loops[s.dirs[facing]] ?? s.loops[0];
    if (!loop || !loop.length) return;
    const i = anim === 'walk' && loop.length > 1 ? Math.floor(now / s.frameMs) % loop.length : 0;
    const f = loop[i]!;
    a.sprite.texture = f.texture;
    a.sprite.anchor.set(f.ax, f.ay);
    a.w = f.texture.width;
    a.h = f.texture.height;
  }

  clearActors(): void {
    for (const id of [...this.actors.keys()]) this.removeActor(id);
  }
}

export function nativePoint(canvas: HTMLCanvasElement, zoom: number, e: { clientX: number; clientY: number }): Pt {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom];
}
