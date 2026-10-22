/**
 * Minimal synthesized sound effects via WebAudio - no external audio assets.
 * The context is created/resumed on the first user gesture (Play button),
 * which satisfies mobile autoplay policies. Everything is fail-safe: if
 * WebAudio is unavailable the game runs silently.
 */

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  /** Call from any trusted user gesture. Safe to call repeatedly. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
        const AC = w.AudioContext ?? w.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      /* audio is optional */
    }
  }

  private tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number, delay = 0): void {
    if (!this.ctx || !this.master) return;
    try {
      const t = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(Math.max(1, f0), t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    } catch {
      /* ignore */
    }
  }

  /** k in 0..1 scales pitch drop and loudness with impact strength. */
  hit(k: number): void {
    this.tone(160 + 140 * k, 55, 0.1 + 0.08 * k, 'square', 0.22 + 0.28 * k);
  }

  dash(): void {
    this.tone(240, 640, 0.12, 'triangle', 0.16);
  }

  fall(): void {
    this.tone(520, 90, 0.4, 'sawtooth', 0.2);
  }

  tick(): void {
    this.tone(430, 430, 0.08, 'sine', 0.2);
  }

  go(): void {
    this.tone(660, 880, 0.18, 'sine', 0.24);
  }

  warn(): void {
    this.tone(640, 640, 0.07, 'square', 0.13);
    this.tone(640, 640, 0.07, 'square', 0.13, 0.13);
  }

  slip(): void {
    this.tone(500, 180, 0.3, 'sine', 0.15);
  }

  win(): void {
    this.tone(523, 523, 0.16, 'triangle', 0.2, 0);
    this.tone(659, 659, 0.16, 'triangle', 0.2, 0.12);
    this.tone(784, 784, 0.22, 'triangle', 0.22, 0.24);
  }

  /** Gentle descending cue when a bot takes the round. */
  lose(): void {
    this.tone(392, 392, 0.14, 'triangle', 0.16, 0);
    this.tone(311, 262, 0.3, 'triangle', 0.16, 0.15);
  }
}

export const sfx = new Sfx();
