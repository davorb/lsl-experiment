// Client for the AGI-interpreter mode: DOM chrome (menus, status, command line, dialogs) around the Pixi scene.
import { Application } from 'pixi.js';
import { EGA } from '../../../shared/agi/picture';
import type { AgiFrame, AgiModal } from '../../../shared/agi/protocol';
import type { ChatEntry, ServerMessage } from '../../../shared/protocol';
import type { Net } from '../net';
import { AgiScene } from './scene';
import { Synth, scheduleSound } from './sound';
import { parseSound } from '../../../shared/agi/sound';

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rgb = (c: number): string => `rgb(${EGA[c & 15]!.join(',')})`;

function el<T extends HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = document.createElement(tag) as T;
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

const LOAD_QUIPS = [
  'Larry is checking his breath…',
  'Straightening the leisure suit…',
  'Counting the bar stools…',
  'Looking for a quarter for the payphone…',
  'Asking the bartender for directions…',
  'Dodging a puddle of something questionable…',
  'Combing the three remaining hairs…',
];

const ARROW_DIR: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
const DIR_OF = (dx: number, dy: number): number => [[8, 1, 2], [7, 0, 3], [6, 5, 4]][dy + 1]![dx + 1]!;
const FKEY_SCAN: Record<string, number> = { F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88 };

export class AgiGame {
  private scene!: AgiScene;
  private frame: AgiFrame | null = null;
  private names: Record<string, string> = {};
  private modalId: number | null = null;
  private modalKind: AgiModal['kind'] | null = null;
  private zoom = 2;
  private ready = false;
  private queue: ServerMessage[] = [];

  private root = el<HTMLDivElement>('div', { id: 'agi' });
  private menubar = el<HTMLDivElement>('div', { id: 'agi-menubar' });
  private statusBar = el<HTMLDivElement>('div', { id: 'agi-status' });
  private roster = el<HTMLDivElement>('div', { id: 'agi-roster' });
  private keys = el<HTMLDivElement>('div', { id: 'agi-keys' });
  private stage = el<HTMLDivElement>('div', { id: 'stage' });
  private texts = el<HTMLDivElement>('div', { id: 'agi-texts' });
  private modalBox = el<HTMLDivElement>('div', { id: 'dialogue' });
  private chatlog = el<HTMLDivElement>('div', { id: 'chatlog' });
  private cmdInput = el<HTMLInputElement>('input', { id: 'agi-cmd', placeholder: 'Type a command: look, open door, talk to bartender…', maxLength: 120, autocomplete: 'off' });
  private chatInput = el<HTMLInputElement>('input', { id: 'agi-chat', placeholder: 'Chat with your friends (Enter)', maxLength: 200, autocomplete: 'off' });
  private pressed = new Set<string>();
  private lastDir = 0;
  private banner = el<HTMLDivElement>('div', { id: 'agi-banner' });
  private loader = el<HTMLDivElement>('div', { id: 'agi-loader' });
  private loaderBar = el<HTMLDivElement>('div', { className: 'fill' });
  private loaderMsg = el<HTMLDivElement>('div', { className: 'msg' });
  private loadRoom = -1;
  private loadStart = 0;
  private loadShown = 0;
  private loadTimer = 0;

  constructor(private net: Net, private synth: Synth, private me: string, chat: ChatEntry[]) {
    this.net.onMessage = (m) => this.handle(m);
    this.net.onClose = () => void this.reconnect();
    for (const c of chat) this.addChat(c);
  }

  async start(): Promise<void> {
    const app = new Application();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    await app.init({ width: 320, height: 168, background: 0x000000, antialias: false, resolution: dpr, autoDensity: true, preference: 'webgl' });
    this.scene = new AgiScene(app);
    this.scene.names = this.names;
    this.buildDom(app.canvas);
    this.layout();
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('orientationchange', () => setTimeout(() => this.layout(), 150));
    window.visualViewport?.addEventListener('resize', () => this.layout());
    window.addEventListener('keydown', (e) => this.keydown(e));
    window.addEventListener('keyup', (e) => this.keyup(e));
    app.canvas.addEventListener('pointerdown', (e) => this.click(e));
    (window as unknown as { __agi: unknown }).__agi = this; // for debugging in the console
    this.ready = true;
    for (const m of this.queue.splice(0)) this.handle(m);
  }

  // ---- DOM ---------------------------------------------------------------------------------------

  private buildDom(canvas: HTMLCanvasElement): void {
    const app = document.getElementById('app')!;
    app.replaceChildren(this.root);
    const verbs = el<HTMLDivElement>('div', { id: 'agi-verbs' });
    const verb = (label: string, text: string, send: boolean) => {
      const b = el<HTMLButtonElement>('button', { type: 'button', textContent: label });
      b.onclick = () => {
        if (send) this.sendCommand(text);
        else { this.cmdInput.value = text; this.cmdInput.focus(); }
      };
      verbs.append(b);
    };
    verb('Look around', 'look', true);
    verb('Look at', 'look at ', false);
    verb('Open', 'open ', false);
    verb('Get', 'get ', false);
    verb('Talk to', 'talk to ', false);
    verb('Use', 'use ', false);
    verb('Inventory', 'inventory', true);
    // Function keys (the casino uses F4/F6/F8): on-screen buttons for phones, which have none.
    for (const f of ['F4', 'F6', 'F8']) {
      const b = el<HTMLButtonElement>('button', { type: 'button', textContent: f, title: `Press ${f}` });
      b.onclick = () => { if (this.modalId === null) this.net.send({ type: 'agi_key', ascii: 0, scan: FKEY_SCAN[f]! }); };
      verbs.append(b);
    }
    const mute = el<HTMLButtonElement>('button', { type: 'button', textContent: '♪ on', title: 'Toggle music' });
    mute.onclick = () => { this.synth.setMuted(!this.synth.muted); mute.textContent = this.synth.muted ? '♪ off' : '♪ on'; };
    mute.className = 'mute';
    verbs.append(mute);
    this.cmdInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { this.sendCommand(this.cmdInput.value); this.cmdInput.value = ''; }
      else if (FKEY_SCAN[e.key] !== undefined) this.keydown(e);
      else if (ARROW_DIR[e.key]) { e.preventDefault(); this.keydown(e); }
    });
    this.cmdInput.addEventListener('keyup', (e) => { if (ARROW_DIR[e.key]) this.keyup(e); });
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && this.chatInput.value.trim()) { this.net.send({ type: 'chat', text: this.chatInput.value }); this.chatInput.value = ''; }
      else if (FKEY_SCAN[e.key] !== undefined) this.keydown(e);
    });
    // Keys for screens that wait for a keypress (the age quiz, "press any key"): phones have no keyboard to hand.
    for (const [label, ascii] of [['A', 97], ['B', 98], ['C', 99], ['D', 100], ['Enter ⏎', 13]] as const) {
      const b = el<HTMLButtonElement>('button', { type: 'button', textContent: label });
      b.onclick = () => this.net.send({ type: 'agi_key', ascii, scan: ascii === 13 ? 28 : 0 });
      this.keys.append(b);
    }
    this.keys.style.display = 'none';
    this.banner.style.display = 'none';
    this.loader.append(
      el('div', { className: 'title', textContent: 'Loading…' }),
      el('div', { className: 'bar' }, this.loaderBar),
      this.loaderMsg,
    );
    this.stage.append(canvas, this.texts, this.chatlog, this.modalBox, this.banner, this.loader);
    this.root.append(
      this.menubar,
      this.statusBar,
      this.stage,
      this.roster,
      this.keys,
      el<HTMLDivElement>('div', { id: 'agi-bar' }, verbs),
      el<HTMLDivElement>('div', { id: 'agi-inputs' }, this.cmdInput, this.chatInput),
    );
    this.modalBox.style.display = 'none';
  }

  /** Fit the picture to the screen: integer zoom when there is room (crisp pixels), a fractional fit on phones. */
  private layout(): void {
    const vw = window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const pad = vw < 700 ? 8 : 24;
    // Short landscape screens (phones on their side): picture on the left, controls in a column on the right.
    const side = vh < 480 && vw > vh;
    const compact = vw < 700 && !side;
    const fit = (uiHeight: number): number => {
      let z = side ? Math.min((vw * 0.6) / 320, (vh - 44) / 168) : Math.min((vw - 2 * pad) / 320, (vh - uiHeight) / 168);
      z = z >= 2 ? Math.floor(z) : Math.max(0.75, z);
      return Math.floor(320 * z) / 320; // whole-pixel width
    };
    const apply = (z: number) => {
      this.zoom = z;
      this.stage.style.width = `${Math.round(320 * z)}px`;
      this.stage.style.height = `${Math.round(168 * z)}px`;
      this.root.style.width = side ? '100%' : `${Math.round(320 * z)}px`;
      this.scene.setZoom(z);
    };
    this.root.classList.toggle('side', side);
    this.root.classList.toggle('compact', compact || side);
    // Dialogs sit beside/below the picture on small screens instead of covering it.
    const inline = compact || side;
    if (inline && this.modalBox.parentElement !== this.root) this.root.insertBefore(this.modalBox, this.stage.nextSibling);
    if (!inline && this.modalBox.parentElement !== this.stage) this.stage.append(this.modalBox);
    // First guess with a typical chrome height, then correct once using the real measured height.
    apply(fit(this.zoom ? Math.max(120, this.root.offsetHeight - this.stage.offsetHeight) : 190));
    if (!side) {
      const ui = this.root.offsetHeight - this.stage.offsetHeight;
      if (ui > 0) apply(fit(ui + 8));
    }
    this.renderTexts();
  }

  private sendCommand(text: string): void {
    if (!text.trim()) return;
    this.net.send({ type: 'agi_cmd', text });
  }

  /** The server went away (a restart, a network drop): retry until it is back, then rejoin the shared game. */
  /** Verification aid: render a sound with the real synth code into an offline buffer and return its samples. */
  async renderSoundOffline(n: number, seconds: number): Promise<{ sampleRate: number; samples: Float32Array }> {
    const r = await fetch(`/content/agi/snd/${n}.bin`);
    const snd = parseSound(new Uint8Array(await r.arrayBuffer()));
    if (!snd) throw new Error('sound did not parse');
    const sampleRate = 22050;
    const ctx = new OfflineAudioContext(1, Math.ceil(sampleRate * seconds), sampleRate);
    const master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    scheduleSound(ctx, master, snd, 0, null);
    const buf = await ctx.startRendering();
    return { sampleRate, samples: buf.getChannelData(0) };
  }

  private reconnecting = false;
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.banner.textContent = 'Connection lost. Reconnecting…';
    this.banner.style.display = 'block';
    this.closeModal();
    for (let attempt = 0; ; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(5000, 1000 + attempt * 500)));
      try {
        await this.net.connect();
      } catch { continue; }
      let name: string | undefined;
      try { name = localStorage.getItem('lsl.name') || undefined; } catch { /* storage unavailable */ }
      this.net.send({ type: 'hello', name });
      this.reconnecting = false;
      return;
    }
  }

  // ---- server messages -----------------------------------------------------------------------------

  private handle(m: ServerMessage): void {
    // The server sends the picture right after the welcome, before the renderer has finished starting.
    if (!this.ready) { this.queue.push(m); return; }
    switch (m.type) {
      case 'agi_welcome':
        this.me = m.playerId;
        for (const k of Object.keys(this.names)) delete this.names[k];
        this.banner.style.display = 'none';
        break;
      case 'agi_pic': this.scene.setPicture(b64(m.visual), b64(m.priority)); break;
      case 'agi_frame': this.onFrame(m.frame); break;
      case 'agi_modal': this.openModal(m.mid, m.modal, m.owner); break;
      case 'agi_modal_close': if (this.modalId === m.mid) this.closeModal(); break;
      case 'agi_sound': void this.synth.play(m.n); break;
      case 'agi_shake': this.shake(m.n); break;
      case 'agi_players': Object.assign(this.names, m.players); for (const k of Object.keys(this.names)) if (!(k in m.players)) delete this.names[k]; this.renderRoster(); break;
      case 'chat': {
        this.addChat(m.entry);
        this.scene.showBubble(m.entry.id, m.entry.text);
        break;
      }
      case 'error': console.warn(m.message); break;
      default: break;
    }
  }

  private onFrame(f: AgiFrame): void {
    this.frame = f;
    if (f.room !== this.loadRoom) this.beginLoading(f.room);
    this.scene.setRoom(f.room);
    this.scene.update(f.objs, f.avatars, f.egoOwner);
    this.statusBar.style.visibility = f.statusLine ? 'visible' : 'hidden';
    const owner = f.egoOwner ? this.names[f.egoOwner] ?? '' : '';
    this.statusBar.replaceChildren(
      el('span', { textContent: `Score: ${f.score} of ${f.maxScore}` }),
      el('span', { className: 'who', textContent: owner ? `Larry: ${owner}${f.egoOwner === this.me ? ' (you)' : ''}` : '' }),
    );
    this.cmdInput.disabled = !f.accept || this.modalId !== null;
    this.keys.style.display = !f.accept && this.modalId === null && f.egoOwner === this.me ? 'flex' : 'none';
    this.renderRoster();
    this.renderMenus(f);
    this.renderTexts();
  }

  // ---- room loading ---------------------------------------------------------------------------

  /** A room change makes the client fetch the new room's sprites; cover the stall with a Sierra-style loading bar. */
  private beginLoading(room: number): void {
    this.loadRoom = room;
    this.loadStart = performance.now();
    this.scene.resetViewProgress();
    this.loadShown = 0;
    window.clearInterval(this.loadTimer);
    this.loadTimer = window.setInterval(() => this.pollLoading(), 50);
  }

  private pollLoading(): void {
    const now = performance.now(), t = now - this.loadStart;
    const { done, total } = this.scene.viewProgress();
    const finished = done >= total;
    if (finished && t > 120) { // quick (cached) rooms never flash the overlay
      window.clearInterval(this.loadTimer);
      this.loadTimer = 0;
      if (this.loader.style.display !== 'flex') return;
      this.loaderBar.style.width = '100%';
      window.setTimeout(() => { if (!this.loadTimer) this.loader.style.display = 'none'; }, 180);
      return;
    }
    if (t < 250) return; // only bother the player when it is actually slow
    if (this.loader.style.display !== 'flex') {
      this.loader.style.display = 'flex';
      this.loaderMsg.textContent = LOAD_QUIPS[Math.floor(Math.random() * LOAD_QUIPS.length)]!;
    }
    // Real progress, plus a slow creep so the bar never looks stuck while a single big view downloads.
    const real = total ? done / total : 0;
    this.loadShown = Math.max(this.loadShown, Math.min(0.95, real * 0.9 + (1 - Math.exp(-t / 2500)) * 0.1));
    this.loaderBar.style.width = `${Math.round(this.loadShown * 20) * 5}%`; // chunky 5% steps, like EGA blocks
    if (Math.floor(t / 1800) !== Math.floor((t - 50) / 1800)) this.loaderMsg.textContent = LOAD_QUIPS[Math.floor(Math.random() * LOAD_QUIPS.length)]!;
  }

  /** shake.screen: jolt the picture n times. */
  private shake(n: number): void {
    const s = this.stage;
    const times = Math.max(1, Math.min(12, n || 4));
    let i = 0;
    const tick = () => {
      s.style.transform = i >= times * 2 ? '' : `translate(${(i % 2 ? -1 : 1) * 6}px, ${(i % 3 ? 3 : -3)}px)`;
      if (i++ < times * 2) setTimeout(tick, 45);
    };
    tick();
  }

  private renderRoster(): void {
    const owner = this.frame?.egoOwner ?? null;
    const parts = Object.entries(this.names).map(([id, name]) => `${name}${id === this.me ? ' (you)' : ''}${id === owner ? ' ★ Larry' : ''}`);
    this.roster.textContent = `In this game: ${parts.join(' · ') || '—'}. Type a command to take over Larry, or just walk around as yourself.`;
  }

  private renderMenus(f: AgiFrame): void {
    const sig = JSON.stringify(f.menus);
    if (this.menubar.dataset['sig'] === sig) return;
    this.menubar.dataset['sig'] = sig;
    this.menubar.replaceChildren(
      ...f.menus.map((menu) => {
        const items = el<HTMLDivElement>('div', { className: 'menu-items' });
        for (const it of menu.items) {
          if (/^-+$/.test(it.text.trim())) { items.append(el('hr')); continue; }
          const [label, hint] = it.text.trim().split(/\s{2,}/);
          const b = el<HTMLButtonElement>('button', { type: 'button', disabled: !it.enabled }, label ?? '', ...(hint ? [el('span', { className: 'key', textContent: hint.replace(/[<>]/g, '') })] : []));
          b.onclick = () => this.net.send({ type: 'agi_menu', controller: it.controller });
          items.append(b);
        }
        return el<HTMLDivElement>('div', { className: 'menu' }, el('span', { textContent: menu.title.trim() }), items);
      }),
    );
  }

  private renderTexts(): void {
    const f = this.frame;
    if (!f) return;
    const z = this.zoom;
    this.texts.style.background = f.textMode ? '#000' : 'transparent';
    this.texts.style.fontSize = `${8 * z}px`;
    this.texts.style.lineHeight = `${8 * z}px`;
    this.texts.style.letterSpacing = `${3.2 * z}px`;
    this.texts.replaceChildren(
      ...f.texts
        .filter((t) => (f.textMode ? true : t.row >= 1 && t.row <= 21))
        .map((t) => {
          const span = el<HTMLSpanElement>('span', { textContent: t.text });
          span.style.left = `${t.col * 8 * z}px`;
          span.style.top = `${(f.textMode ? t.row * 7 : t.row - 1 === 0 ? 0 : (t.row - 1) * 8) * z}px`;
          span.style.color = rgb(t.fg);
          span.style.background = t.bg === 0 ? 'transparent' : rgb(t.bg);
          return span;
        }),
    );
  }

  private addChat(e: ChatEntry): void {
    const row = el<HTMLDivElement>('div', {}, el('b', { textContent: `${e.name}: ` }), e.text);
    this.chatlog.append(row);
    while (this.chatlog.children.length > 6) this.chatlog.firstElementChild?.remove();
    setTimeout(() => row.remove(), 20000);
  }

  // ---- dialogs -----------------------------------------------------------------------------------------

  private openModal(mid: number, modal: AgiModal, owner: string | null): void {
    this.modalId = mid;
    this.modalKind = modal.kind;
    this.cmdInput.disabled = true;
    const box = this.modalBox;
    const ack = (value?: string | number) => this.net.send({ type: 'agi_ack', mid, value });
    box.replaceChildren();
    const body = el<HTMLDivElement>('div', { className: 'text' });
    box.append(body);
    const hint = (t: string) => box.append(el('div', { className: 'hint', textContent: t }));
    switch (modal.kind) {
      case 'print':
      case 'message':
        body.textContent = modal.text;
        hint('Press Enter or click to continue');
        box.onclick = () => ack();
        break;
      case 'showobj': {
        const img = el<HTMLImageElement>('img', { src: `/content/sprites/${modal.view}/0_0.png`, className: 'obj' });
        body.append(img, el('div', { textContent: `${modal.name}\n${modal.desc}` }));
        hint('Press Enter or click to continue');
        box.onclick = () => ack();
        break;
      }
      case 'inventory': {
        body.textContent = modal.select ? 'Select an item:' : 'You are carrying:';
        const list = el<HTMLDivElement>('div', { className: 'choices' });
        if (!modal.items.length) list.append(el('div', { textContent: '(nothing)' }));
        for (const it of modal.items) {
          if (modal.select) {
            const b = el<HTMLButtonElement>('button', { type: 'button', textContent: it.name });
            b.onclick = (e) => { e.stopPropagation(); ack(it.id); };
            list.append(b);
          } else list.append(el('div', { textContent: `• ${it.name}` }));
        }
        box.append(list);
        hint(modal.select ? 'Escape to cancel' : 'Press Enter or click to continue');
        box.onclick = modal.select ? null : () => ack();
        break;
      }
      case 'string':
      case 'number': {
        body.textContent = modal.prompt;
        box.onclick = null;
        if (owner && owner !== this.me) { hint(`Waiting for ${this.names[owner] ?? 'the other player'}…`); break; }
        const input = el<HTMLInputElement>('input', { className: 'prompt', type: modal.kind === 'number' ? 'number' : 'text', autocomplete: 'off' });
        if (modal.kind === 'string') input.maxLength = modal.len;
        input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') ack(input.value); });
        box.append(input);
        queueMicrotask(() => input.focus());
        hint('Type your answer and press Enter');
        break;
      }
    }
    box.style.display = 'block';
  }

  private closeModal(): void {
    this.modalId = null;
    this.modalKind = null;
    this.modalBox.style.display = 'none';
    this.modalBox.onclick = null;
    this.cmdInput.disabled = !(this.frame?.accept ?? true);
    if (!this.cmdInput.disabled) this.cmdInput.focus();
  }

  // ---- input ---------------------------------------------------------------------------------------------

  private keydown(e: KeyboardEvent): void {
    if (this.modalId !== null) {
      if (this.modalKind === 'string' || this.modalKind === 'number') return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.net.send({ type: 'agi_ack', mid: this.modalId }); }
      else if (e.key === 'Escape' && this.modalKind === 'inventory') this.net.send({ type: 'agi_ack', mid: this.modalId, value: 255 });
      return;
    }
    if (ARROW_DIR[e.key]) {
      e.preventDefault();
      if (!this.pressed.has(e.key)) { this.pressed.add(e.key); this.sendDir(); }
      return;
    }
    const scan = FKEY_SCAN[e.key];
    if (scan !== undefined) { e.preventDefault(); this.net.send({ type: 'agi_key', ascii: 0, scan }); return; }
    if (e.key === 'Escape') { this.net.send({ type: 'agi_key', ascii: 27, scan: 1 }); return; }
    const typing = document.activeElement === this.cmdInput || document.activeElement === this.chatInput;
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    // "Press any key" screens: forward the key. Printable keys also start typing a command.
    const ascii = e.key === 'Enter' ? 13 : e.key === ' ' ? 32 : e.key.length === 1 ? e.key.charCodeAt(0) : 0;
    if (ascii) this.net.send({ type: 'agi_key', ascii, scan: 0 });
    if (e.key.length === 1 && e.key !== ' ' && !this.cmdInput.disabled) this.cmdInput.focus();
  }

  private keyup(e: KeyboardEvent): void {
    if (this.pressed.delete(e.key)) this.sendDir();
  }

  private sendDir(): void {
    let dx = 0, dy = 0;
    for (const k of this.pressed) { dx += ARROW_DIR[k]![0]; dy += ARROW_DIR[k]![1]; }
    const d = DIR_OF(Math.sign(dx), Math.sign(dy));
    if (d !== this.lastDir) { this.lastDir = d; this.net.send({ type: 'agi_dir', dir: d }); }
  }

  private click(e: PointerEvent): void {
    if (this.modalId !== null) return;
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const [nx, ny] = this.scene.unwarp((e.clientX - r.left) / this.zoom, (e.clientY - r.top) / this.zoom);
    console.log('click native', Math.round(nx), Math.round(ny));
    this.net.send({ type: 'agi_goto', x: nx / 2, y: ny });
  }
}
