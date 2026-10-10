import './style.css';

const el = <T extends HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T => {
  const e = document.createElement(tag) as T;
  Object.assign(e, props);
  e.append(...kids);
  return e;
};

/** Name + room code entry. Calls onJoin; the owner decides what to launch from the server's reply. */
export class Lobby {
  private root = el<HTMLDivElement>('div', { id: 'lobby' });
  private err = el<HTMLDivElement>('div', { className: 'err' });

  constructor(onJoin: (code: string, name: string) => void) {
    const name = el<HTMLInputElement>('input', { name: 'name', placeholder: 'Your name (optional)', maxLength: 16 });
    const code = el<HTMLInputElement>('input', { name: 'code', placeholder: 'CODE', maxLength: 4 });
    try { name.value = localStorage.getItem('lsl.name') ?? ''; } catch { /* storage unavailable */ }
    const fromUrl = (location.hash.slice(1) || new URLSearchParams(location.search).get('code') || '').toUpperCase();
    if (/^[A-Z]{4}$/.test(fromUrl)) code.value = fromUrl;
    const join = (c: string) => {
      if (!/^[A-Za-z]{4}$/.test(c)) { this.err.textContent = 'Room code is 4 letters.'; return; }
      try { localStorage.setItem('lsl.name', name.value); } catch { /* ignore */ }
      this.err.textContent = '';
      onJoin(c.toUpperCase(), name.value.trim());
    };
    const create = el<HTMLButtonElement>('button', { type: 'button', textContent: 'New room' });
    create.onclick = () => join(Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(''));
    const go = el<HTMLButtonElement>('button', { type: 'submit', textContent: 'Join' });
    const form = el<HTMLFormElement>('form', {}, el('h1', { textContent: 'Larry Co-op' }), name, code, el('div', { className: 'row' }, go, create), this.err);
    form.onsubmit = (e) => { e.preventDefault(); join(code.value); };
    this.root.append(form);
    document.getElementById('app')!.append(this.root);
    history.replaceState(null, '', location.pathname);
    this.onCodeHint(code);
  }

  private onCodeHint(code: HTMLInputElement): void {
    code.addEventListener('input', () => { code.value = code.value.toUpperCase(); });
  }

  showError(msg: string): void {
    this.root.style.display = 'flex';
    this.err.textContent = msg;
  }
  hide(): void {
    this.root.style.display = 'none';
  }
  destroy(): void {
    this.root.remove();
  }
}
