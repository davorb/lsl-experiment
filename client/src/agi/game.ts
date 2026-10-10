// Client for the AGI-interpreter mode: DOM chrome (menus, status, command line, dialogs) around the Pixi scene.
import { Application } from 'pixi.js';
import { EGA } from '../../../shared/agi/picture';
import type { AgiFrame, AgiModal } from '../../../shared/agi/protocol';
import type { ChatEntry, ServerMessage } from '../../../shared/protocol';
import type { Net } from '../net';
import { AgiScene } from './scene';
import { Synth } from './sound';

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rgb = (c: number): string => `rgb(${EGA[c & 15]!.join(',')})`;

function el<T extends HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = document.createElement(tag) as T;
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

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
  private stage = el<HTMLDivElement>('div', { id: 'stage' });
  private texts = el<HTMLDivElement>('div', { id: 'agi-texts' });
  private modalBox = el<HTMLDivElement>('div', { id: 'dialogue' });
  private chatlog = el<HTMLDivElement>('div', { id: 'chatlog' });
  private cmdInput = el<HTMLInputElement>('input', { id: 'agi-cmd', placeholder: 'Type a command: look, open door, talk to bartender…', maxLength: 120, autocomplete: 'off' });
  private chatInput = el<HTMLInputElement>('input', { id: 'agi-chat', placeholder: 'Chat with your friends (Enter)', maxLength: 200, autocomplete: 'off' });
  private pressed = new Set<string>();
  private lastDir = 0;

  constructor(private net: Net, private synth: Synth, private me: string, chat: ChatEntry[]) {
    this.net.onMessage = (m) => this.handle(m);
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
    const mute = el<HTMLButtonElement>('button', { type: 'button', textContent: '♪ on', title: 'Toggle music' });
    mute.onclick = () => { this.synth.setMuted(!this.synth.muted); mute.textContent = this.synth.muted ? '♪ off' : '♪ on'; };
    this.cmdInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { this.sendCommand(this.cmdInput.value); this.cmdInput.value = ''; }
      else if (ARROW_DIR[e.key]) { e.preventDefault(); this.keydown(e); }
    });
    this.cmdInput.addEventListener('keyup', (e) => { if (ARROW_DIR[e.key]) this.keyup(e); });
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && this.chatInput.value.trim()) { this.net.send({ type: 'chat', text: this.chatInput.value }); this.chatInput.value = ''; }
    });
    this.stage.append(canvas, this.texts, this.chatlog, this.modalBox);
    this.root.append(
      this.menubar,
      this.statusBar,
      this.stage,
      this.roster,
      el<HTMLDivElement>('div', { id: 'agi-bar' }, verbs, mute),
      el<HTMLDivElement>('div', { id: 'agi-inputs' }, this.cmdInput, this.chatInput),
    );
    this.modalBox.style.display = 'none';
  }

  private layout(): void {
    this.zoom = Math.max(2, Math.floor(Math.min(window.innerWidth / 320, (window.innerHeight - 190) / 168)));
    this.stage.style.width = `${320 * this.zoom}px`;
    this.stage.style.height = `${168 * this.zoom}px`;
    this.root.style.width = `${320 * this.zoom}px`;
    this.scene.setZoom(this.zoom);
    this.renderTexts();
  }

  private sendCommand(text: string): void {
    if (!text.trim()) return;
    this.net.send({ type: 'agi_cmd', text });
  }

  // ---- server messages -----------------------------------------------------------------------------

  private handle(m: ServerMessage): void {
    // The server sends the picture right after the welcome, before the renderer has finished starting.
    if (!this.ready) { this.queue.push(m); return; }
    switch (m.type) {
      case 'agi_pic': this.scene.setPicture(b64(m.visual), b64(m.priority)); break;
      case 'agi_frame': this.onFrame(m.frame); break;
      case 'agi_modal': this.openModal(m.mid, m.modal, m.owner); break;
      case 'agi_modal_close': if (this.modalId === m.mid) this.closeModal(); break;
      case 'agi_sound': void this.synth.play(m.n); break;
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
    this.scene.setRoom(f.room);
    this.scene.update(f.objs, f.avatars, f.egoOwner);
    this.statusBar.style.visibility = f.statusLine ? 'visible' : 'hidden';
    const owner = f.egoOwner ? this.names[f.egoOwner] ?? '' : '';
    this.statusBar.replaceChildren(
      el('span', { textContent: `Score: ${f.score} of ${f.maxScore}` }),
      el('span', { className: 'who', textContent: owner ? `Larry: ${owner}${f.egoOwner === this.me ? ' (you)' : ''}` : '' }),
      el('span', { textContent: `Sound: ${f.soundOn ? 'on' : 'off'}` }),
    );
    this.cmdInput.disabled = !f.accept || this.modalId !== null;
    this.renderRoster();
    this.renderMenus(f);
    this.renderTexts();
  }

  private renderRoster(): void {
    const owner = this.frame?.egoOwner ?? null;
    const parts = Object.entries(this.names).map(([id, name]) => `${name}${id === this.me ? ' (you)' : ''}${id === owner ? ' ★ Larry' : ''}`);
    this.roster.textContent = `In this game: ${parts.join(' · ') || '—'}. Type a command to take over Larry; otherwise walk your own character.`;
  }

  private renderMenus(f: AgiFrame): void {
    const sig = JSON.stringify(f.menus);
    if (this.menubar.dataset['sig'] === sig) return;
    this.menubar.dataset['sig'] = sig;
    this.menubar.replaceChildren(
      ...f.menus.map((menu) => {
        const items = el<HTMLDivElement>('div', { className: 'menu-items' });
        for (const it of menu.items) {
          const b = el<HTMLButtonElement>('button', { type: 'button', textContent: it.text, disabled: !it.enabled });
          b.onclick = () => this.net.send({ type: 'agi_menu', controller: it.controller });
          items.append(b);
        }
        return el<HTMLDivElement>('div', { className: 'menu' }, el('span', { textContent: menu.title }), items);
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
    const nx = (e.clientX - r.left) / this.zoom;
    const ny = (e.clientY - r.top) / this.zoom;
    console.log('click native', Math.round(nx), Math.round(ny));
    this.net.send({ type: 'agi_goto', x: nx / 2, y: ny });
  }
}
