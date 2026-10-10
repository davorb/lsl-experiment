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
  onItem(item: string): void;
  onChoice(id: string): void;
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
    // The entry point owns the real lobby; this hidden shell only receives reconnect errors.
    this.lobby.append(el('form', {}, el('h1', { textContent: 'Larry Co-op' }), this.err));
    this.lobby.style.display = 'none';
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
      ...(items.length ? items.map((i) => {
        const chip = el<HTMLButtonElement>('button', { className: 'item', textContent: i.replace(/_/g, ' '), type: 'button', title: 'Look at it' });
        chip.onclick = () => this.h.onItem(i);
        return chip;
      }) : [el('span', { className: 'item dim', textContent: '(inventory empty)' })]),
    );
  }

  setMeta(code: string, flags: Flags): void {
    const on = Object.entries(flags).filter(([, v]) => v).map(([k]) => k);
    void code;
    this.meta.replaceChildren('Shared game · ', el('b', { textContent: location.origin }), el('br'), `flags: ${on.join(', ') || '—'}`);
  }

  say(speaker: string, text: string, choices?: { id: string; label: string }[]): void {
    const body = el<HTMLDivElement>('div', { className: 'text' }, el('b', { textContent: speaker }), text);
    this.dialogue.replaceChildren(body);
    if (choices?.length) {
      const row = el<HTMLDivElement>('div', { className: 'choices' });
      for (const c of choices) {
        const b = el<HTMLButtonElement>('button', { type: 'button', textContent: c.label });
        b.onclick = () => { this.h.onChoice(c.id); this.dialogue.style.display = 'none'; };
        row.append(b);
      }
      this.dialogue.append(row);
    }
    this.dialogue.style.display = 'block';
    clearTimeout(this.dialogueTimer);
    // Text auto-hides (longer for longer text); a pending choice stays until answered.
    if (!choices?.length) this.dialogueTimer = window.setTimeout(() => (this.dialogue.style.display = 'none'), 4000 + text.length * 45);
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
