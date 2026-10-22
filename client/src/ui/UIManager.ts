/**
 * UIManager owns the DOM menus (start / pause / result) and the dash-button
 * cooldown indicator. It talks to the game exclusively through gameBus
 * events, keeping gameplay logic free of DOM references.
 */

import { gameBus } from '../game/EventBus';
import { sfx } from '../game/sfx';
import type { Phase, RoundResultMsg, UiCommand } from '../game/types';

const BEST_TIME_KEY = 'lol_best_win_time';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in index.html`);
  return node as T;
}

function fmt(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function readBest(): number | null {
  try {
    const raw = localStorage.getItem(BEST_TIME_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeBest(v: number): void {
  try {
    localStorage.setItem(BEST_TIME_KEY, String(v));
  } catch {
    /* private mode etc. */
  }
}

export class UIManager {
  private phase: Phase = 'idle';
  private paused = false;

  private startOverlay = el('start-overlay');
  private pauseOverlay = el('pause-overlay');
  private resultOverlay = el('result-overlay');
  private resultTitle = el('result-title');
  private resultSub = el('result-sub');
  private resultStats = el('result-stats');
  private dashBtn = el('dash-button');

  constructor() {
    el('btn-play').addEventListener('click', () => this.command('start'));
    el('btn-restart').addEventListener('click', () => this.command('restart'));
    el('btn-restart-2').addEventListener('click', () => this.command('restart'));
    el('btn-resume').addEventListener('click', () => this.resume());
    el('btn-menu').addEventListener('click', () => this.command('menu'));
    el('btn-menu-2').addEventListener('click', () => this.command('menu'));
    el('pause-button').addEventListener('click', () => this.pause());

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyP' || e.code === 'Escape') this.togglePause();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
    });
    window.addEventListener('blur', () => this.pause());

    gameBus.on('phase', (payload: any) => this.onPhase(payload.phase as Phase));
    gameBus.on('result', (payload: any) => this.onResult(payload as RoundResultMsg));
    gameBus.on('player-out', () => {
      // Hide the (now useless) dash button while spectating.
      document.body.dataset.playerOut = '1';
    });
    gameBus.on('dash-cd', (payload: any) => {
      const frac = Math.max(0, Math.min(1, Number(payload?.frac ?? 0)));
      this.dashBtn.style.setProperty('--cd', frac.toFixed(3));
      this.dashBtn.classList.toggle('ready', frac <= 0);
    });

    // Unlock WebAudio on the first gesture anywhere.
    const unlock = () => sfx.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  private command(action: UiCommand): void {
    sfx.unlock();
    gameBus.emit('cmd', { action });
  }

  private onPhase(phase: Phase): void {
    this.phase = phase;
    this.paused = false;
    document.body.dataset.phase = phase;
    delete document.body.dataset.playerOut;
    // Cooldown indicator back to "ready" so a new round never inherits the
    // previous round's leftover cooldown fill.
    this.dashBtn.style.setProperty('--cd', '0');
    this.dashBtn.classList.add('ready');
    this.hideAll();
    if (phase === 'idle') this.startOverlay.classList.remove('hidden');
  }

  private hideAll(): void {
    this.startOverlay.classList.add('hidden');
    this.pauseOverlay.classList.add('hidden');
    this.resultOverlay.classList.add('hidden');
  }

  private pause(): void {
    if (this.paused || (this.phase !== 'playing' && this.phase !== 'countdown')) return;
    this.paused = true;
    this.pauseOverlay.classList.remove('hidden');
    gameBus.emit('cmd', { action: 'pause' });
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pauseOverlay.classList.add('hidden');
    sfx.unlock();
    gameBus.emit('cmd', { action: 'resume' });
  }

  private togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  private onResult(r: RoundResultMsg): void {
    const title =
      r.winnerName === 'Nobody' ? 'DRAW!' : r.playerWon ? 'YOU WIN!' : `${r.winnerName.toUpperCase()} WINS!`;
    this.resultTitle.textContent = title;
    this.resultTitle.style.color = r.playerWon ? '#ffd23f' : r.winnerCss;
    this.resultSub.textContent = r.playerWon
      ? 'Last one laughing.'
      : r.playerOut
        ? `You were knocked out by ${r.outBy ?? 'the arena'}.`
        : 'So close - knock them all off next time.';

    let best = readBest();
    if (r.playerWon) {
      best = best === null ? r.roundTime : Math.min(best, r.roundTime);
      writeBest(best);
    }
    const lines = [`Round time: ${fmt(r.roundTime)}`, `Your knockouts: ${r.playerKos}`];
    if (best !== null) lines.push(`Fastest win: ${fmt(best)}`);
    this.resultStats.replaceChildren(
      ...lines.map((line) => {
        const div = document.createElement('div');
        div.textContent = line;
        return div;
      }),
    );

    this.hideAll();
    this.resultOverlay.classList.remove('hidden');
  }
}
