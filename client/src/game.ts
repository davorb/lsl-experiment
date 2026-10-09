import { Application, Texture } from 'pixi.js';
import type { Flags, Player, Room, ServerMessage, Verb } from '../../shared/protocol';
import { loadIndex, loadPlayerSprites, loadRoom, tryTexture } from './content';
import { Net } from './net';
import { nativePoint, Scene } from './scene';
import { UI } from './ui';

function inRect(x: number, y: number, r: [number, number, number, number]): boolean {
  return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
}

/** Rebuild the walk-behind overlay: background pixels wherever the mask is white. */
async function buildForeground(room: Room, bg: Texture | null): Promise<HTMLCanvasElement | null> {
  if (!bg || !room.masks.length) return null;
  const [w, h] = room.size;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const og = out.getContext('2d')!;
  const bgc = document.createElement('canvas');
  bgc.width = w;
  bgc.height = h;
  bgc.getContext('2d')!.drawImage(bg.source.resource as CanvasImageSource, 0, 0, w, h);
  const bgData = bgc.getContext('2d')!.getImageData(0, 0, w, h);
  const keep = new Uint8Array(w * h);
  let any = false;
  for (const m of room.masks) {
    const tex = await tryTexture(m.image);
    if (!tex) continue;
    const mc = document.createElement('canvas');
    mc.width = w;
    mc.height = h;
    const mg = mc.getContext('2d')!;
    mg.drawImage(tex.source.resource as CanvasImageSource, 0, 0, w, h);
    const md = mg.getImageData(0, 0, w, h).data;
    for (let i = 0; i < w * h; i++) if (md[i * 4]! > 127 && md[i * 4 + 3]! > 0) keep[i] = 1; // white = walk-behind
    any = true;
  }
  if (!any) return null;
  for (let i = 0; i < w * h; i++) if (!keep[i]) bgData.data[i * 4 + 3] = 0;
  og.putImageData(bgData, 0, 0);
  return out;
}

export class Game {
  private net = new Net();
  private ui: UI;
  private scene!: Scene;
  private me = '';
  private code = '';
  private players: Record<string, Player> = {};
  private flags: Flags = {};
  private seq = 0;
  private loadingRoom: string | null = null;
  private canvas!: HTMLCanvasElement;

  constructor() {
    this.ui = new UI({
      onJoin: (code, name) => void this.join(code, name),
      onChat: (text) => this.net.send({ type: 'chat', text }),
    });
    this.net.onMessage = (m) => void this.handle(m);
    this.net.onClose = () => this.ui.showError('Disconnected from server.');
    window.addEventListener('resize', () => this.relayout());
  }

  private async join(code: string, name: string): Promise<void> {
    try {
      this.code = code;
      await this.net.connect();
      this.net.send({ type: 'hello', code, name: name || undefined });
    } catch (e) {
      this.ui.showError(e instanceof Error ? e.message : 'Connection failed.');
    }
  }

  private async boot(): Promise<void> {
    const app = new Application();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    await app.init({ width: 320, height: 168, background: 0x000000, antialias: false, resolution: dpr, autoDensity: true, preference: 'webgl' });
    this.canvas = app.canvas;
    this.ui.stage.prepend(this.canvas);
    this.scene = new Scene(app);
    const index = await loadIndex();
    const sprites = await loadPlayerSprites(index);
    this.scene.sprites = sprites;
    this.canvas.addEventListener('pointerdown', (e) => this.click(e));
    this.canvas.addEventListener('pointermove', (e) => this.hover(e));
    (window as unknown as { __lsl: unknown }).__lsl = this; // handy for debugging in the console
  }

  private async handle(m: ServerMessage): Promise<void> {
    switch (m.type) {
      case 'error':
        this.ui.showError(m.message);
        break;
      case 'welcome': {
        this.me = m.playerId;
        this.players = m.state.players;
        this.flags = m.state.flags;
        if (!this.scene) await this.boot();
        this.ui.hideLobby();
        this.ui.setInventory(m.state.inventory);
        this.ui.setMeta(this.code, this.flags);
        for (const c of m.state.chat) this.ui.addChat(c);
        await this.enterRoom(this.players[this.me]!.roomId);
        break;
      }
      case 'patch': {
        if (m.flags) { Object.assign(this.flags, m.flags); this.ui.setMeta(this.code, this.flags); }
        if (m.inventory) this.ui.setInventory(m.inventory);
        if (m.players) {
          for (const [id, p] of Object.entries(m.players)) {
            if (p) this.players[id] = p;
            else delete this.players[id];
          }
          const mine = this.players[this.me];
          if (mine && mine.roomId !== this.scene.room?.id && mine.roomId !== this.loadingRoom) await this.enterRoom(mine.roomId);
          else this.scene.syncActors(this.players);
        }
        break;
      }
      case 'move':
        for (const [id, e] of Object.entries(m.players)) {
          const p = this.players[id];
          if (!p) continue;
          Object.assign(p, { x: e.x, y: e.y, facing: e.facing, anim: e.anim });
          this.scene.pushMove(id, e);
        }
        break;
      case 'chat': {
        this.ui.addChat(m.entry);
        const p = this.players[m.entry.id];
        if (p && p.roomId === this.scene.room?.id) this.scene.showBubble(m.entry.id, m.entry.text);
        break;
      }
      case 'result':
        if (m.say) this.ui.say(this.players[m.actorId]?.name ?? '???', m.say);
        break;
    }
  }

  private async enterRoom(id: string): Promise<void> {
    this.loadingRoom = id;
    try {
      const room = await loadRoom(id);
      const bg = await tryTexture(room.background);
      const fg = await buildForeground(room, bg);
      this.scene.clearActors();
      await this.scene.setRoom(room, bg, fg);
      this.relayout();
      this.scene.syncActors(this.players);
    } catch (e) {
      this.ui.showError(`Could not load room "${id}": ${e instanceof Error ? e.message : e}`);
    } finally {
      this.loadingRoom = null;
    }
  }

  private relayout(): void {
    const room = this.scene?.room;
    if (!room) return;
    const zoom = this.ui.fitZoom(room.size[0], room.size[1]);
    this.ui.sizeStage(room.size[0], room.size[1], zoom);
    this.scene.setZoom(zoom);
  }

  // ---- pointer ---------------------------------------------------------------------

  private pick(e: PointerEvent): { actor: string | null; hotspot: Room['hotspots'][number] | null; pt: [number, number] } {
    const [nx, ny] = nativePoint(this.canvas, this.scene.zoom, e);
    const room = this.scene.room!;
    return {
      pt: [nx, ny],
      actor: this.scene.hitActor(nx, ny),
      hotspot: room.hotspots.find((h) => inRect(nx, ny, h.rect)) ?? null,
    };
  }

  private hover(e: PointerEvent): void {
    if (!this.scene.room) return;
    const { actor, hotspot } = this.pick(e);
    const label = actor ? this.players[actor]?.name ?? null : hotspot ? hotspot.name ?? hotspot.id : null;
    this.canvas.style.cursor = label ? 'pointer' : 'default';
    this.ui.setHover(label ? `${this.ui.verb === 'walk' ? (actor ? 'look' : hotspot!.verb) : this.ui.verb} ${label}` : null);
  }

  private click(e: PointerEvent): void {
    if (!this.scene.room) return;
    const { actor, hotspot, pt } = this.pick(e);
    const verb = this.ui.verb;
    console.log('click native', Math.round(pt[0]), Math.round(pt[1]));
    if (actor) {
      const who = this.players[actor];
      if (who) this.ui.say(who.name, actor === this.me ? "That's you." : verb === 'talk' ? 'Use the chat box to talk.' : "That's a fellow guest.");
      this.ui.setVerb('walk');
      return;
    }
    if (hotspot) {
      const v: Verb = verb === 'walk' ? hotspot.verb : verb;
      this.net.send({ type: 'verb', hotspotId: hotspot.id, verb: v });
      this.ui.setVerb('walk');
      return;
    }
    this.net.send({ type: 'input', seq: ++this.seq, x: Math.round(pt[0]), y: Math.round(pt[1]) });
  }
}
