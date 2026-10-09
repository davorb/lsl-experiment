import type { ChatEntry, Flags, Verb } from '../../shared/protocol';
import './style.css';

const VERBS: Verb[] = ['look', 'talk', 'use', 'walk'];
const el = <T extends HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T => {
  const e = document.createElement(tag) as T;
  Object.assign(e, props);
  e.append(...kids);
  return e;
};

export interface UIHandlers {
  onJoin(code: string, name: string): void;
  onChat(text: string): void;
}

export class UI {
  readonly stage = el<HTMLDivElement>('div', { id: 'stage' });
  private dialogue = el<HTMLDivElement>('div', { id: 'dialogue' });
  private chatlog = el<HTMLDivElement>('div', { id: 'chatlog' });
  private hover = el<HTMLDivElement>('div', { id: 'hover' });
  private inventory = el<HTMLDivElement>('div', { id: 'inventory' });
  private meta = el<HTMLDivElement>('div', { id: 'meta' });
  private verbBtns = new Map<Verb, HTMLButtonElement>();
  private lobby = el<HTMLDivElement>('div', { id: 'lobby' });
  private err = el<HTMLDivElement>('div', { className: 'err' });
  private dialogueTimer = 0;
  verb: Verb = 'walk';

  constructor(private h: UIHandlers) {
    const app = document.getElementById('app')!;

    const verbs = el<HTMLElement>('section', { id: 'verbs' });
    for (const v of VERBS) {
      const b = el<HTMLButtonElement>('button', { textContent: v[0]!.toUpperCase() + v.slice(1), type: 'button' });
      b.onclick = () => this.setVerb(v);
      this.verbBtns.set(v, b);
      verbs.append(b);
    }
    const mid = el<HTMLElement>('section', { id: 'mid' }, this.inventory, this.meta);
    const input = el<HTMLInputElement>('input', { placeholder: 'Say something… (Enter)', maxLength: 200 });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && input.value.trim()) { h.onChat(input.value); input.value = ''; }
    });
    const chat = el<HTMLElement>('section', { id: 'chatbox' }, input);
    this.stage.append(this.chatlog, this.hover, this.dialogue);
    app.append(this.stage, el<HTMLElement>('div', { id: 'hud' }, verbs, mid, chat));
    this.setVerb('walk');
    this.setInventory([]);
    this.buildLobby(app);
  }

  private buildLobby(app: HTMLElement): void {
    const name = el<HTMLInputElement>('input', { name: 'name', placeholder: 'Your name (optional)', maxLength: 16 });
    const code = el<HTMLInputElement>('input', { name: 'code', placeholder: 'CODE', maxLength: 4 });
    try { name.value = localStorage.getItem('lsl.name') ?? ''; } catch { /* storage unavailable */ }
    const fromUrl = (location.hash.slice(1) || new URLSearchParams(location.search).get('code') || '').toUpperCase();
    if (/^[A-Z]{4}$/.test(fromUrl)) code.value = fromUrl;
    const join = (c: string) => {
      if (!/^[A-Za-z]{4}$/.test(c)) { this.err.textContent = 'Room code is 4 letters.'; return; }
      try { localStorage.setItem('lsl.name', name.value); } catch { /* ignore */ }
      this.err.textContent = '';
      this.h.onJoin(c.toUpperCase(), name.value.trim());
    };
    const create = el<HTMLButtonElement>('button', { type: 'button', textContent: 'New room' });
    create.onclick = () => join(Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(''));
    const go = el<HTMLButtonElement>('button', { type: 'submit', textContent: 'Join' });
    const form = el<HTMLFormElement>('form', {}, el('h1', { textContent: 'Larry Co-op' }), name, code, el('div', { className: 'row' }, go, create), this.err);
    form.onsubmit = (e) => { e.preventDefault(); join(code.value); };
    this.lobby.append(form);
    app.append(this.lobby);
  }

  showError(msg: string): void {
    this.lobby.style.display = 'flex';
    this.err.textContent = msg;
  }
  hideLobby(): void {
    this.lobby.style.display = 'none';
  }

  setVerb(v: Verb): void {
    this.verb = v;
    for (const [k, b] of this.verbBtns) b.classList.toggle('on', k === v);
  }

  /** Integer zoom of a native-size playfield that leaves room for the HUD. */
  fitZoom(w: number, h: number): number {
    return Math.max(2, Math.floor(Math.min(window.innerWidth / w, (window.innerHeight - 160) / h)));
  }
  sizeStage(w: number, h: number, zoom: number): void {
    this.stage.style.width = `${w * zoom}px`;
    this.stage.style.height = `${h * zoom}px`;
  }

  setInventory(items: string[]): void {
    this.inventory.replaceChildren(
      ...(items.length ? items.map((i) => el('span', { className: 'item', textContent: i.replace(/_/g, ' ') })) : [el('span', { className: 'item dim', textContent: '(inventory empty)' })]),
    );
  }

  setMeta(code: string, flags: Flags): void {
    const on = Object.entries(flags).filter(([, v]) => v).map(([k]) => k);
    this.meta.replaceChildren('Room ', el('b', { textContent: code }), ' · share this URL: ', el('b', { textContent: `${location.origin}/#${code}` }), el('br'), `flags: ${on.join(', ') || '—'}`);
  }

  say(speaker: string, text: string): void {
    this.dialogue.replaceChildren(el('b', { textContent: speaker }), text);
    this.dialogue.style.display = 'block';
    clearTimeout(this.dialogueTimer);
    this.dialogueTimer = window.setTimeout(() => (this.dialogue.style.display = 'none'), 6000);
  }

  addChat(e: ChatEntry): void {
    const row = el<HTMLDivElement>('div', {}, el('b', { textContent: `${e.name}: ` }), e.text);
    this.chatlog.append(row);
    while (this.chatlog.children.length > 6) this.chatlog.firstElementChild?.remove();
    setTimeout(() => row.remove(), 20000);
  }

  setHover(text: string | null): void {
    this.hover.style.display = text ? 'block' : 'none';
    if (text) this.hover.textContent = text;
  }
}
