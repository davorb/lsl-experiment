// Renders the AGI game state: the picture, animated objects (depth-sorted by AGI priority), avatars of
// the other players, and the HD-2D treatment (lights, tilt-shift, vignette) from the shared fx module.
import { Application, Container, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import { PIC_H, PIC_W, pictureToRGBA } from '../../../shared/agi/picture';
import type { AgiAvatar, AgiObj } from '../../../shared/agi/protocol';
import { priorityStartY } from '../../../shared/protocol';
import { loadView, pixelTexture, type Frame } from '../content';
import { buildLights, makeTiltShift, vignetteTexture, type LightLayers, type TiltShift } from '../fx';
import { lightingFor } from './lighting';

const W = PIC_W * 2;
const H = PIC_H;
const DPR = Math.min(window.devicePixelRatio || 1, 3);
const BUBBLE_MS = 4000;
const FONT = 'ui-monospace, Menlo, monospace';

interface Bubble { box: Container; until: number }

export class AgiScene {
  readonly app: Application;
  private root = new Container();
  private world = new Container();
  private actorLayer = new Container();
  private overlay = new Container();
  private vignette = new Sprite(vignetteTexture());
  private tilt: TiltShift = makeTiltShift();
  private bg = new Sprite();
  private priSprites: Sprite[] = [];
  private lights: LightLayers | null = null;
  private objSprites = new Map<number, Sprite>();
  private avatarSprites = new Map<string, { sprite: Sprite; label: Text }>();
  private egoLabel: Text;
  private bubbles = new Map<string, Bubble>();
  private views = new Map<number, Frame[][] | null>();
  private loading = new Set<number>();
  private lightKey = -999;
  private lastVisual: Uint8Array | null = null;
  zoom = 2;
  /** Native position (pixels) of each player's head, for bubbles. */
  private heads = new Map<string, { x: number; y: number }>();
  ownerId: string | null = null;
  names: Record<string, string> = {};

  constructor(app: Application) {
    this.app = app;
    this.actorLayer.sortableChildren = true;
    this.world.addChild(this.bg, this.actorLayer);
    this.root.addChild(this.world);
    this.root.filters = [this.tilt.filter];
    this.vignette.alpha = 0.3;
    this.vignette.eventMode = 'none';
    this.overlay.eventMode = 'none';
    this.egoLabel = new Text({ text: '', style: { fontFamily: FONT, fontSize: 12, fill: 0xffffff, stroke: { color: 0x000000, width: 3 } }, resolution: DPR });
    this.egoLabel.anchor.set(0.5, 1);
    this.overlay.addChild(this.egoLabel);
    app.stage.addChild(this.root, this.vignette, this.overlay);
    app.ticker.add(() => this.tickBubbles());
    this.setZoom(2);
  }

  setZoom(zoom: number): void {
    this.zoom = zoom;
    this.app.renderer.resize(Math.round(W * zoom), Math.round(H * zoom));
    this.world.scale.set(zoom);
    this.root.filterArea = new Rectangle(0, 0, Math.round(W * zoom), Math.round(H * zoom));
    this.tilt.setBlurTexels(1.4 * zoom * DPR);
    this.vignette.width = W * zoom;
    this.vignette.height = H * zoom;
  }

  // ---- picture ---------------------------------------------------------------------------

  setPicture(visual: Uint8Array, priority: Uint8Array): void {
    this.lastVisual = visual;
    this.lightKey = -999; // relight: the new picture may need different automatic lighting
    const rgba = pictureToRGBA(visual);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, W, H), 0, 0);
    this.bg.texture = pixelTexture(Texture.from(canvas));
    for (const s of this.priSprites) s.destroy();
    this.priSprites = [];
    // Pixels whose priority is above an actor's priority are drawn over that actor: one layer per level.
    const layers = new Map<number, ImageData>();
    for (let i = 0; i < PIC_W * PIC_H; i++) {
      const q = priority[i]!;
      if (q < 5 || q > 15) continue;
      let layer = layers.get(q);
      if (!layer) layers.set(q, (layer = new ImageData(W, H)));
      const x = i % PIC_W, y = (i / PIC_W) | 0;
      for (let k = 0; k < 2; k++) {
        const o = (y * W + x * 2 + k) * 4;
        layer.data[o] = rgba[o]!; layer.data[o + 1] = rgba[o + 1]!; layer.data[o + 2] = rgba[o + 2]!; layer.data[o + 3] = 255;
      }
    }
    for (const [q, data] of layers) {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      c.getContext('2d')!.putImageData(data, 0, 0);
      const sp = new Sprite(pixelTexture(Texture.from(c)));
      sp.zIndex = priorityStartY(q) - 0.5;
      sp.eventMode = 'none';
      this.actorLayer.addChild(sp);
      this.priSprites.push(sp);
    }
  }

  setRoom(room: number): void {
    if (room === this.lightKey) return;
    this.lightKey = room;
    this.lights?.dispose();
    const l = lightingFor(room, this.lastVisual ?? undefined);
    this.lights = buildLights(this.app.renderer, { size: [W, H], ambient: l.ambient, lights: l.lights });
    this.world.addChild(this.lights.multiply, this.lights.glow);
  }

  // ---- objects -----------------------------------------------------------------------------

  private frames(view: number): Frame[][] | null {
    if (this.views.has(view)) return this.views.get(view)!;
    if (!this.loading.has(view)) {
      this.loading.add(view);
      void loadView(String(view)).then((f) => { this.views.set(view, f); this.loading.delete(view); });
    }
    return null;
  }

  update(objs: AgiObj[], avatars: AgiAvatar[], egoOwner: string | null): void {
    this.ownerId = egoOwner;
    const seen = new Set<number>();
    this.heads.clear();
    for (const o of objs) {
      const f = this.frames(o.view)?.[o.loop]?.[o.cel];
      if (!f) continue;
      seen.add(o.id);
      let sp = this.objSprites.get(o.id);
      if (!sp) { sp = new Sprite(); this.actorLayer.addChild(sp); this.objSprites.set(o.id, sp); }
      sp.texture = f.texture;
      sp.anchor.set(0, 1);
      // AGI: x = left edge in 160-wide units, y = baseline row; the bottom edge of the row is y + 1.
      sp.position.set(o.x * 2, o.y + 1);
      sp.zIndex = priorityStartY(o.pri) + o.y * 0.001;
      if (o.id === 0) {
        const head = { x: o.x * 2 + f.texture.width / 2, y: o.y + 1 - f.texture.height };
        if (egoOwner) this.heads.set(egoOwner, head);
        this.egoLabel.text = egoOwner ? this.names[egoOwner] ?? '' : '';
        this.egoLabel.position.set(head.x * this.zoom, head.y * this.zoom - 2);
        this.egoLabel.visible = !!egoOwner;
      }
    }
    for (const [id, sp] of this.objSprites) if (!seen.has(id)) { sp.destroy(); this.objSprites.delete(id); }
    if (!seen.has(0)) this.egoLabel.visible = false;

    const live = new Set<string>();
    for (const a of avatars) {
      const f = this.frames(0)?.[a.loop]?.[a.cel % (this.frames(0)?.[a.loop]?.length ?? 1)];
      if (!f) continue;
      live.add(a.id);
      let e = this.avatarSprites.get(a.id);
      if (!e) {
        const sprite = new Sprite();
        this.actorLayer.addChild(sprite);
        const label = new Text({ text: a.name, style: { fontFamily: FONT, fontSize: 12, fill: 0xd9e6ff, stroke: { color: 0x000000, width: 3 } }, resolution: DPR });
        label.anchor.set(0.5, 1);
        this.overlay.addChild(label);
        e = { sprite, label };
        this.avatarSprites.set(a.id, e);
      }
      e.sprite.texture = f.texture;
      e.sprite.anchor.set(0, 1);
      e.sprite.position.set(a.x * 2, a.y + 1);
      e.sprite.zIndex = priorityStartY(Math.min(14, a.y < 48 ? 4 : Math.floor((a.y - 48) / 12) + 5)) + a.y * 0.001;
      e.label.text = a.name;
      const head = { x: a.x * 2 + f.texture.width / 2, y: a.y + 1 - f.texture.height };
      this.heads.set(a.id, head);
      e.label.position.set(head.x * this.zoom, head.y * this.zoom - 2);
    }
    for (const [id, e] of this.avatarSprites) if (!live.has(id)) { e.sprite.destroy(); e.label.destroy(); this.avatarSprites.delete(id); }
  }

  /** Native-pixel position hit test used for the cursor label; returns the object id under a point. */
  objectAt(nx: number, ny: number): number | null {
    let best: number | null = null;
    let bestZ = -Infinity;
    for (const [id, sp] of this.objSprites) {
      if (id === 0) continue;
      const b = sp.getBounds();
      const x = nx * this.zoom, y = ny * this.zoom;
      if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height && sp.zIndex > bestZ) { best = id; bestZ = sp.zIndex; }
    }
    return best;
  }

  // ---- chat bubbles ----------------------------------------------------------------------------

  showBubble(playerId: string, text: string): void {
    this.bubbles.get(playerId)?.box.destroy({ children: true });
    const t = new Text({ text, style: { fontFamily: FONT, fontSize: 12, fill: 0x111111, wordWrap: true, wordWrapWidth: 170 }, resolution: DPR });
    t.anchor.set(0.5, 1);
    t.position.set(0, -4);
    const bg = new Graphics().roundRect(-t.width / 2 - 6, -t.height - 8, t.width + 12, t.height + 8, 5).fill(0xfff6dc).stroke({ color: 0x222222, width: 1 });
    const box = new Container();
    box.addChild(bg, t);
    this.overlay.addChild(box);
    this.bubbles.set(playerId, { box, until: performance.now() + BUBBLE_MS });
  }

  private tickBubbles(): void {
    const now = performance.now();
    for (const [id, b] of this.bubbles) {
      const head = this.heads.get(id);
      if (now > b.until || !head) { b.box.destroy({ children: true }); this.bubbles.delete(id); continue; }
      b.box.position.set(head.x * this.zoom, head.y * this.zoom - 20);
    }
  }
}
