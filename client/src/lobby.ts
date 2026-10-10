import './style.css';

const el = <T extends HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T => {
  const e = document.createElement(tag) as T;
  Object.assign(e, props);
  e.append(...kids);
  return e;
};

/** Name entry for the one shared game. The caller decides what to launch from the server's reply. */
export class Lobby {
  private root = el<HTMLDivElement>('div', { id: 'lobby' });
  private err = el<HTMLDivElement>('div', { className: 'err' });

  constructor(onJoin: (name: string) => void) {
    const name = el<HTMLInputElement>('input', { name: 'name', placeholder: 'Your name (optional)', maxLength: 16 });
    try { name.value = localStorage.getItem('lsl.name') ?? ''; } catch { /* storage unavailable */ }
    const go = el<HTMLButtonElement>('button', { type: 'submit', textContent: 'Join the game' });
    const note = el<HTMLDivElement>('div', { className: 'note', textContent: 'Everyone plays the same game. It restarts every two hours.' });
    const link = (href: string, textContent: string) =>
      el<HTMLAnchorElement>('a', { href, textContent, target: '_blank', rel: 'noopener noreferrer' });
    const links = el<HTMLDivElement>('div', { className: 'links' }, el('hr'), el('div', { className: 'note', textContent: 'Enjoying the port? Follow me!' }), el('div', { className: 'row' }, link('https://x.com/davorb89', 'X @davorb89'), link('https://github.com/davorb', 'GitHub @davorb')));
    const form = el<HTMLFormElement>('form', {}, el('h1', { textContent: 'Larry Co-op' }), name, go, note, this.err, links);
    form.onsubmit = (e) => {
      e.preventDefault();
      try { localStorage.setItem('lsl.name', name.value); } catch { /* ignore */ }
      this.err.textContent = '';
      onJoin(name.value.trim());
    };
    this.root.append(form);
    document.getElementById('app')!.append(this.root);
    queueMicrotask(() => name.focus());
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
