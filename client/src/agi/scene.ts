// Renders the AGI game state: the picture, animated objects (depth-sorted by AGI priority), avatars of
// the other players, and the HD-2D treatment (lights, tilt-shift, vignette) from the shared fx module.
import { Application, Color, ColorMatrixFilter, Container, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import { PIC_H, PIC_W, pictureToRGBA } from '../../../shared/agi/picture';
import type { AgiAvatar, AgiObj } from '../../../shared/agi/protocol';
import { priorityStartY } from '../../../shared/protocol';
import { loadView, pixelTexture, type Frame } from '../content';
import { buildLights, depthTexture, dotTexture, makeDepthFx, shadowTexture, shaftTexture, vignetteTexture, type DepthFx, type LightLayers } from '../fx';
import { lightingFor } from './lighting';

const W = PIC_W * 2;
const H = PIC_H;
const DPR = Math.min(window.devicePixelRatio || 1, 3);
const BUBBLE_MS = 4000;
const FONT = 'ui-monospace, Menlo, monospace';
const FLAT = new URLSearchParams(location.search).has('flat'); // ?flat turns the 2.5D effects off
const KEYSTONE = FLAT ? 0 : 0.035;
const PARALLAX_X = 2.5 / W; // max camera shift in uv units (2.5 logical px)
const PARALLAX_Y = 1.2 / H;
const MOTES = 34;

interface LightInfo { x: number; y: number; radius: number; rgb: [number, number, number]; power: number }
interface Decor { shadow: Sprite; rim: Sprite; rimMatrix: ColorMatrixFilter }
interface Mote { s: Sprite; x: number; y: number; vx: number; vy: number; phase: number; base: number }

interface Bubble { box: Container; until: number }

export class AgiScene {
  readonly app: Application;
  private root = new Container();
  private world = new Container();
  private actorLayer = new Container();
  private overlay = new Container();
  private vignette = new Sprite(vignetteTexture());
  private fx: DepthFx = makeDepthFx();
  private bg = new Sprite();
  private priSprites: Sprite[] = [];
  private lights: LightLayers | null = null;
  private objSprites = new Map<number, Sprite>();
  private avatarSprites = new Map<string, { sprite: Sprite; label: Text }>();
  private egoLabel: Text;
  private bubbles = new Map<string, Bubble>();
  private views = new Map<number, Frame[][] | null>();
  private loading = new Set<number>();
  private viewsAsked = 0;
  private viewsDone = 0;
  private lightKey = -999;
  private lastVisual: Uint8Array | null = null;
  private lightInfo: LightInfo[] = [];
  private decor = new Map<string, Decor>();
  private motes: Mote[] = [];
  private moteLayer = new Container();
  private shafts: { s: Sprite; base: number; phase: number }[] = [];
  private depthTex: Texture | null = null;
  // Camera for the parallax: target follows the pointer and the player, the current value eases toward it.
  private pointer = { x: 0, y: 0 };
  private egoNorm = 0;
  private cam = { x: 0, y: 0 };
  private focus = 0.6;
  private focusTarget = 0.6;
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
    this.root.filters = [this.fx.filter];
    this.fx.setKeystone(KEYSTONE);
    this.vignette.alpha = 0.3;
    this.vignette.eventMode = 'none';
    this.overlay.eventMode = 'none';
    this.egoLabel = new Text({ text: '', style: { fontFamily: FONT, fontSize: 12, fill: 0xffffff, stroke: { color: 0x000000, width: 3 } }, resolution: DPR });
    this.egoLabel.anchor.set(0.5, 1);
    this.overlay.addChild(this.egoLabel);
    app.stage.addChild(this.root, this.vignette, this.overlay);
    window.addEventListener('pointermove', (e) => {
      const r = app.canvas.getBoundingClientRect();
      this.pointer.x = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2)));
      this.pointer.y = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2)));
    });
    app.ticker.add((t) => { this.tickBubbles(); this.tickFx(t.deltaTime); });
    this.setZoom(2);
  }

  setZoom(zoom: number): void {
    this.zoom = zoom;
    this.app.renderer.resize(Math.round(W * zoom), Math.round(H * zoom));
    this.world.scale.set(zoom);
    this.root.filterArea = new Rectangle(0, 0, Math.round(W * zoom), Math.round(H * zoom));
    this.fx.setBlurTexels(1.4 * zoom * DPR);
    this.vignette.width = W * zoom;
    this.vignette.height = H * zoom;
  }

  // ---- picture ---------------------------------------------------------------------------

  setPicture(visual: Uint8Array, priority: Uint8Array): void {
    this.lastVisual = visual;
    this.depthTex?.destroy(true);
    this.depthTex = depthTexture(priority, PIC_W, PIC_H, priorityStartY);
    this.fx.setDepth(this.depthTex);
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
    this.world.addChild(this.lights.multiply, this.lights.glow, this.moteLayer);
    this.lightInfo = l.lights.map((li) => {
      const c = new Color(li.color);
      return { x: li.x, y: li.y, radius: li.radius, rgb: [c.red, c.green, c.blue], power: c.alpha };
    });
    // Aerial perspective: the distance fades toward a lightened version of the room's ambient colour.
    const a = new Color(l.ambient);
    const lift = (v: number) => Math.min(1, v * 0.55 + 0.45);
    this.fx.setFog([lift(a.red), lift(a.green * 1.02), lift(a.blue * 1.06)], FLAT ? 0 : 0.16);
    this.buildAtmosphere();
  }

  /** Dust motes drifting around the lights, plus a faint light shaft under each hanging lamp. */
  private buildAtmosphere(): void {
    for (const c of this.moteLayer.removeChildren()) c.destroy();
    this.motes = [];
    this.shafts = [];
    if (FLAT) return;
    for (const li of this.lightInfo) {
      if (li.y > 112 || li.radius < 50) continue;
      const s = new Sprite(shaftTexture());
      s.anchor.set(0.5, 0);
      s.position.set(li.x, li.y);
      s.width = li.radius * 0.8;
      s.height = li.radius * 1.5;
      s.skew.x = -0.3;
      s.tint = new Color({ r: li.rgb[0] * 255, g: li.rgb[1] * 255, b: li.rgb[2] * 255 }).toNumber();
      s.blendMode = 'add';
      s.eventMode = 'none';
      this.moteLayer.addChild(s);
      this.shafts.push({ s, base: Math.min(0.22, li.power * 0.4), phase: Math.random() * 6.28 });
    }
    for (let i = 0; i < MOTES; i++) {
      const li = this.lightInfo.length && Math.random() < 0.7 ? this.lightInfo[(Math.random() * this.lightInfo.length) | 0]! : null;
      const x = li ? li.x + (Math.random() - 0.5) * li.radius * 1.6 : Math.random() * W;
      const y = li ? li.y + (Math.random() - 0.3) * li.radius * 1.4 : Math.random() * H;
      const s = new Sprite(dotTexture());
      s.anchor.set(0.5);
      s.width = s.height = 1.5 + Math.random() * 2;
      s.blendMode = 'add';
      s.eventMode = 'none';
      if (li) s.tint = new Color({ r: li.rgb[0] * 255, g: li.rgb[1] * 255, b: li.rgb[2] * 255 }).toNumber();
      this.moteLayer.addChild(s);
      this.motes.push({ s, x, y, vx: (Math.random() - 0.5) * 3, vy: -1 - Math.random() * 3, phase: Math.random() * 6.28, base: 0.25 + Math.random() * 0.4 });
    }
  }

  private tickFx(dt: number): void {
    const k = 1 - Math.pow(0.9, dt);
    const tx = FLAT ? 0 : 0.65 * this.pointer.x + 0.45 * this.egoNorm;
    const ty = FLAT ? 0 : 0.5 * this.pointer.y;
    this.cam.x += (tx - this.cam.x) * k * 0.4;
    this.cam.y += (ty - this.cam.y) * k * 0.4;
    // Camera moving right shows the near layers sliding left, hence the minus.
    this.fx.setParallax(-this.cam.x * PARALLAX_X, -this.cam.y * PARALLAX_Y);
    this.focus += (this.focusTarget - this.focus) * k * 0.3;
    this.fx.setFocus(this.focus);
    const t = performance.now() / 1000;
    const sec = dt / 60;
    for (const m of this.motes) {
      m.x += (m.vx + Math.sin(t * 0.7 + m.phase) * 2) * sec;
      m.y += m.vy * sec;
      if (m.y < -4 || m.x < -4 || m.x > W + 4) { m.y = H + 2; m.x = Math.random() * W; }
      m.s.position.set(m.x, m.y);
      m.s.alpha = m.base * (0.5 + 0.5 * Math.sin(t * 1.3 + m.phase));
    }
    for (const sh of this.shafts) sh.s.alpha = sh.base * (0.8 + 0.2 * Math.sin(t * 0.6 + sh.phase));
  }

  /** Undo the shader's keystone so a pointer position maps back to picture coordinates (native x in 0..W). */
  unwarp(nx: number, ny: number): [number, number] {
    const u = nx / W, v = ny / H;
    return [(0.5 + (u - 0.5) / (1 + KEYSTONE * v)) * W, ny];
  }

  // ---- actor depth cues: ground shadow, rim light, perspective scale --------------------------------

  private decorFor(key: string): Decor {
    let d = this.decor.get(key);
    if (d) return d;
    const shadow = new Sprite(shadowTexture());
    shadow.anchor.set(0.5);
    shadow.eventMode = 'none';
    const rimMatrix = new ColorMatrixFilter();
    const rim = new Sprite();
    rim.eventMode = 'none';
    rim.filters = [rimMatrix];
    rim.blendMode = 'add';
    this.actorLayer.addChild(shadow, rim);
    d = { shadow, rim, rimMatrix };
    this.decor.set(key, d);
    return d;
  }

  /**
   * Place the decorations of one actor. (fx, fy) is the foot centre in logical pixels, w/h the sprite size,
   * z its draw order so the shadow/rim always sit just behind it.
   */
  private dress(key: string, tex: Texture, fx: number, fy: number, w: number, h: number, scale: number, z: number): void {
    const d = this.decorFor(key);
    // Strongest nearby light decides where the shadow falls and which side is rim lit.
    let best: LightInfo | null = null, bw = 0;
    for (const li of this.lightInfo) {
      const wgt = Math.max(0, 1 - Math.hypot(fx - li.x, (fy - h / 2 - li.y) * 1.3) / (li.radius * 1.35)) * Math.min(1, li.power * 2.2);
      if (wgt > bw) { bw = wgt; best = li; }
    }
    const sw = w * scale;
    let ox = 1.5, oy = 0, width = sw * 0.95, alpha = 0.5;
    if (best && bw > 0.05) {
      const dx = fx - best.x, dy = fy - h / 2 - best.y;
      const len = Math.hypot(dx, dy) || 1;
      ox = (dx / len) * (2 + 7 * bw);
      oy = (dy / len) * 2 * bw;
      width = sw * (0.95 + 0.6 * bw);
      alpha = 0.5 + 0.2 * bw;
    }
    d.shadow.position.set(fx + ox, fy - 1 + oy);
    d.shadow.width = width;
    d.shadow.height = 5 + 2 * bw;
    d.shadow.alpha = FLAT ? 0 : alpha;
    d.shadow.zIndex = z - 0.0004;

    d.rim.visible = !FLAT && !!best && bw > 0.12;
    if (d.rim.visible && best) {
      const dx = best.x - fx, dy = best.y - (fy - h / 2);
      const len = Math.hypot(dx, dy) || 1;
      d.rim.texture = tex;
      d.rim.anchor.set(0.5, 1);
      d.rim.scale.set(scale);
      d.rim.position.set(fx + (dx / len) * 1.2, fy + (dy / len) * 0.8);
      d.rim.alpha = Math.min(0.85, 0.9 * bw);
      const m = d.rimMatrix.matrix;
      m[0] = m[1] = m[2] = m[3] = 0; m[5] = m[6] = m[7] = m[8] = 0; m[10] = m[11] = m[12] = m[13] = 0;
      m[4] = best.rgb[0]; m[9] = best.rgb[1]; m[14] = best.rgb[2];
      m[15] = m[16] = m[17] = 0; m[18] = 1; m[19] = 0;
      d.rim.zIndex = z - 0.0002;
    }
  }

  /** Characters get bigger as they walk toward the camera. */
  private static depthScale(y: number): number {
    return 0.95 + 0.13 * Math.max(0, Math.min(1, y / H));
  }

  // ---- objects -----------------------------------------------------------------------------

  private frames(view: number): Frame[][] | null {
    if (this.views.has(view)) return this.views.get(view)!;
    if (!this.loading.has(view)) {
      this.loading.add(view);
      this.viewsAsked++;
      void loadView(String(view)).then((f) => { this.views.set(view, f); this.loading.delete(view); this.viewsDone++; });
    }
    return null;
  }

  /** Sprite loading since the last call to `resetViewProgress`: how many views were wanted and how many arrived. */
  viewProgress(): { done: number; total: number } { return { done: this.viewsDone, total: this.viewsAsked }; }
  resetViewProgress(): void { this.viewsAsked = this.loading.size; this.viewsDone = 0; }

  update(objs: AgiObj[], avatars: AgiAvatar[], egoOwner: string | null): void {
    this.ownerId = egoOwner;
    const seen = new Set<number>();
    const dressed = new Set<string>();
    this.heads.clear();
    for (const o of objs) {
      const f = this.frames(o.view)?.[o.loop]?.[o.cel];
      if (!f) continue;
      seen.add(o.id);
      let sp = this.objSprites.get(o.id);
      if (!sp) { sp = new Sprite(); this.actorLayer.addChild(sp); this.objSprites.set(o.id, sp); }
      sp.texture = f.texture;
      const w = f.texture.width, h = f.texture.height;
      // AGI: x = left edge in 160-wide units, y = baseline row; the bottom edge of the row is y + 1.
      const z = priorityStartY(o.pri) + o.y * 0.001;
      sp.zIndex = z;
      // Walkers (ego and anything with direction loops) get shadows, rim light and perspective scale;
      // doors, props and other scenery stay exactly as drawn.
      const walker = o.id === 0 || (this.frames(o.view)?.length ?? 0) >= 4;
      const scale = walker && !FLAT ? AgiScene.depthScale(o.y) : 1;
      sp.anchor.set(0.5, 1);
      sp.scale.set(scale);
      sp.position.set(o.x * 2 + w / 2, o.y + 1);
      if (walker) { dressed.add(`o${o.id}`); this.dress(`o${o.id}`, f.texture, o.x * 2 + w / 2, o.y + 1, w, h, scale, z); }
      if (o.id === 0) {
        const head = { x: o.x * 2 + w / 2, y: o.y + 1 - h * scale };
        this.egoNorm = ((o.x * 2 + w / 2) / W - 0.5) * 2;
        this.focusTarget = Math.max(0, Math.min(1, o.y / H));
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
      const w = f.texture.width, h = f.texture.height;
      const scale = FLAT ? 1 : AgiScene.depthScale(a.y);
      const z = priorityStartY(Math.min(14, a.y < 48 ? 4 : Math.floor((a.y - 48) / 12) + 5)) + a.y * 0.001;
      e.sprite.anchor.set(0.5, 1);
      e.sprite.scale.set(scale);
      e.sprite.position.set(a.x * 2 + w / 2, a.y + 1);
      e.sprite.zIndex = z;
      dressed.add(`a${a.id}`);
      this.dress(`a${a.id}`, f.texture, a.x * 2 + w / 2, a.y + 1, w, h, scale, z);
      e.label.text = a.name;
      const head = { x: a.x * 2 + w / 2, y: a.y + 1 - h * scale };
      this.heads.set(a.id, head);
      e.label.position.set(head.x * this.zoom, head.y * this.zoom - 2);
    }
    for (const [id, e] of this.avatarSprites) if (!live.has(id)) { e.sprite.destroy(); e.label.destroy(); this.avatarSprites.delete(id); }
    for (const [key, d] of this.decor) if (!dressed.has(key)) { d.shadow.destroy(); d.rim.destroy(); this.decor.delete(key); }
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
