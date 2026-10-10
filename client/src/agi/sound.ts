// WebAudio synth for AGI (IBM PCjr) sound resources: three square-wave voices plus a noise channel.
import { parseSound, type NoteEvent } from '../../../shared/agi/sound';

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private stopFns: (() => void)[] = [];
  private noiseBuf: AudioBuffer | null = null;
  muted = false;
  private token = 0;

  /** Must be called from a user gesture (the join click) so the browser allows audio. */
  unlock(): void {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.5;
        this.master.connect(this.ctx.destination);
      }
      void this.ctx.resume();
    } catch { /* audio unavailable: the game still works */ }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  stop(): void {
    this.token++;
    for (const f of this.stopFns.splice(0)) { try { f(); } catch { /* already stopped */ } }
  }

  async play(n: number | null): Promise<void> {
    this.stop();
    if (n === null || !this.ctx || !this.master) return;
    const my = this.token;
    let data: Uint8Array;
    try {
      const r = await fetch(`/content/agi/snd/${n}.bin`);
      if (!r.ok) return;
      data = new Uint8Array(await r.arrayBuffer());
    } catch { return; }
    if (my !== this.token) return; // superseded while loading
    const snd = parseSound(data);
    if (!snd) return;
    const ctx = this.ctx, out = this.master;
    const t0 = ctx.currentTime + 0.05;
    const gainOf = (att: number) => (att >= 15 ? 0 : 0.22 * Math.pow(10, (-att * 2) / 20));

    const schedule = (events: NoteEvent[], node: AudioNode, setFreq: ((e: NoteEvent, t: number) => void) | null, gain: GainNode) => {
      gain.gain.setValueAtTime(0, t0);
      for (const e of events) {
        const t = t0 + e.t;
        setFreq?.(e, t);
        gain.gain.setValueAtTime(e.freq > 0 || !setFreq ? gainOf(e.att) : 0, t);
      }
      const end = events.length ? events[events.length - 1]!.t + events[events.length - 1]!.dur : 0;
      gain.gain.setValueAtTime(0, t0 + end);
      gain.connect(out);
      void node;
    };

    for (const voice of snd.voices) {
      if (!voice.length) continue;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      const g = ctx.createGain();
      osc.connect(g);
      schedule(voice, osc, (e, t) => osc.frequency.setValueAtTime(Math.max(20, e.freq || 20), t), g);
      osc.start(t0);
      osc.stop(t0 + snd.length + 0.1);
      this.stopFns.push(() => { osc.stop(); g.disconnect(); });
    }
    if (snd.noise.length) {
      this.noiseBuf ??= (() => {
        const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        return b;
      })();
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const g = ctx.createGain();
      src.connect(g);
      schedule(snd.noise, src, null, g);
      src.start(t0);
      src.stop(t0 + snd.length + 0.1);
      this.stopFns.push(() => { src.stop(); g.disconnect(); });
    }
  }
}
