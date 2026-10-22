/**
 * MpUI: the DOM multiplayer lobby (create room / join by code / share link /
 * player list with ready flags / start) plus the reconnecting banner. Reads
 * the authoritative state via mpSession and never talks to the Phaser scene
 * directly (the scene observes the same session).
 */

import { mpSession, MP_ENDPOINT } from '../multiplayer/NetClient';
import { gameBus } from '../game/EventBus';
import { sfx } from '../game/sfx';

const NAME_KEY = 'lol_mp_name';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in index.html`);
  return node as T;
}

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode */
  }
}

export class MpUI {
  private panel = el('mp-lobby');
  private nameInput = el<HTMLInputElement>('mp-name');
  private codeInput = el<HTMLInputElement>('mp-code');
  private btnCreate = el('mp-create');
  private btnJoin = el('mp-join');
  private btnLeave = el('mp-leave');
  private roomView = el('mp-room');
  private codeLabel = el('mp-code-label');
  private btnCopy = el('mp-copy');
  private btnReady = el<HTMLButtonElement>('mp-ready');
  private btnStart = el<HTMLButtonElement>('mp-start');
  private playerList = el('mp-players');
  private statusLine = el('mp-status');
  private errorLine = el('mp-error');
  private reconnectBanner = el('mp-reconnect');

  private myPid = 0;
  private unsub: (() => void)[] = [];
  private lastRenderAt = 0;

  constructor() {
    this.nameInput.value = readName();

    el('btn-online').addEventListener('click', () => {
      sfx.ui();
      this.openPanel();
    });
    el('mp-close').addEventListener('click', () => {
      sfx.ui();
      // Leaving via X also leaves the room if seated.
      if (mpSession.connected) mpSession.requestLeave();
      this.closePanel();
    });
    this.btnCreate.addEventListener('click', () => {
      sfx.ui();
      void this.withName(async (name) => {
        await mpSession.create(name);
      });
    });
    this.btnJoin.addEventListener('click', () => {
      sfx.ui();
      const code = this.codeInput.value.trim().toUpperCase();
      void this.withName(async (name) => {
        await mpSession.join(code, name);
      });
    });
    this.btnCopy.addEventListener('click', () => {
      sfx.ui();
      const url = this.shareUrl();
      navigator.clipboard?.writeText(url).then(
        () => {
          this.btnCopy.textContent = 'Link copied!';
          window.setTimeout(() => (this.btnCopy.textContent = 'Copy invite link'), 1600);
        },
        () => {
          window.prompt('Copy this invite link:', url);
        },
      );
    });
    this.btnReady.addEventListener('click', () => {
      sfx.ui();
      const me = this.me();
      if (me) mpSession.sendReady(!me.ready);
    });
    this.btnStart.addEventListener('click', () => {
      sfx.ui();
      mpSession.sendStart();
    });
    this.btnLeave.addEventListener('click', () => {
      sfx.ui();
      mpSession.requestLeave();
      this.renderLobbyForm();
    });

    this.unsub.push(
      mpSession.on('status', () => this.render()),
      mpSession.on('state', () => this.renderThrottled()),
      mpSession.on('entered', (p: { pid: number; code: string }) => {
        this.myPid = p.pid;
        this.openPanel(); // also covers silent rejoins after a page reload
      }),
      mpSession.on('error', (msg: string) => {
        this.errorLine.textContent = msg;
        this.errorLine.classList.remove('hidden');
      }),
      mpSession.on('server-error', (e: { code: string; message: string }) => {
        this.errorLine.textContent = e.message;
        this.errorLine.classList.remove('hidden');
      }),
      mpSession.on('left', (p: { intentional: boolean }) => {
        // Only a deliberate leave resets identity; an unexpected drop keeps
        // the seat (and myPid) while the SDK auto-reconnection recovers.
        if (p.intentional) {
          this.myPid = 0;
          this.render();
        }
      }),
    );

    // Match phase changes open/close the panel over the canvas.
    gameBus.on('phase', (payload: any) => {
        const phase = payload?.phase as string;
        if (phase === 'countdown' || phase === 'playing') {
          this.panel.classList.add('hidden');
          this.reconnectBanner.classList.add('hidden');
        } else if (phase === 'idle') {
          // Back in the lobby (or menu): the MP panel takes over from the
          // solo start menu while a session is active.
          if (mpSession.connected || this.myPid) this.openPanel();
          else this.render();
        }
    });

    // Entry flow. A stored reconnection token (page reload / crash recovery)
    // always wins: resume the held seat instead of taking a second one.
    const url = new URL(window.location.href);
    const roomParam = (url.searchParams.get('room') ?? '').trim().toUpperCase();
    if (/^[A-Z2-9]{6}$/.test(roomParam)) this.codeInput.value = roomParam;

    const token = mpSession.readToken();
    if (token && !mpSession.connected) {
      mpSession
        .reconnectToken(token)
        .then(() => this.openPanel())
        .catch(() => {
          // Seat gone (room died / grace expired): fall back to fresh entry.
          mpSession.clearToken();
          this.freshEntry(roomParam);
        });
    } else {
      this.freshEntry(roomParam);
    }
  }

  /** No held seat: honor ?room= deep links (auto-join with a saved name). */
  private freshEntry(roomParam: string): void {
    if (/^[A-Z2-9]{6}$/.test(roomParam)) {
      const name = readName();
      if (name) {
        void mpSession.join(roomParam, name).catch(() => this.openPanel());
        this.openPanel();
      } else {
        this.openPanel();
        this.nameInput.focus();
      }
    }
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
  }

  // ------------------------------------------------------------------ flow

  /** State patches arrive at 20 Hz; the lobby only needs ~4 Hz. */
  private renderThrottled(): void {
    const now = Date.now();
    if (now - this.lastRenderAt < 250) return;
    this.lastRenderAt = now;
    this.render();
  }

  private async withName(fn: (name: string) => Promise<void>): Promise<void> {
    if (mpSession.connected) return; // already seated - ignore double clicks
    const name = this.nameInput.value.trim().slice(0, 12) || 'Player';
    writeName(this.nameInput.value.trim().slice(0, 12));
    this.errorLine.classList.add('hidden');
    try {
      await fn(name);
    } catch {
      /* error line already shows the reason */
    }
  }

  private openPanel(): void {
    this.panel.classList.remove('hidden');
    this.render();
  }

  private closePanel(): void {
    this.panel.classList.add('hidden');
  }

  private shareUrl(): string {
    return `${window.location.origin}${window.location.pathname}?room=${mpSession.code}`;
  }

  private me() {
    return mpSession.state?.players.get(String(this.myPid));
  }

  // ---------------------------------------------------------------- render

  private render(): void {
    const connected = mpSession.connected;
    document.body.dataset.mode = connected ? 'mp' : 'solo';
    if (this.panel.classList.contains('hidden')) return;

    if (!connected) {
      this.renderLobbyForm();
      return;
    }
    const state = mpSession.state;
    if (!state) return;

    // Seated: show the room view (code + roster + ready/start).
    el('mp-form').classList.add('hidden');
    this.roomView.classList.remove('hidden');
    this.codeLabel.textContent = state.code;

    const rows = [...state.players.values()].sort((a, b) => a.pid - b.pid);
    const present = rows.filter((p) => p.present);
    const allReady = present.length >= 2 && present.every((p) => p.ready);

    this.playerList.replaceChildren(
      ...rows.map((p) => {
        const li = document.createElement('li');
        if (p.pid === this.myPid) li.classList.add('me');
        const dot = document.createElement('span');
        dot.className = 'p-dot';
        dot.style.background = p.css;
        const name = document.createElement('span');
        name.className = 'p-name';
        name.textContent = p.host ? `${p.name} (host)` : p.name;
        const badges = document.createElement('span');
        badges.className = 'p-badges';
        if (!p.present) badges.textContent = 'reconnecting…';
        else if (p.ready) badges.textContent = 'ready';
        else badges.textContent = '…';
        li.append(dot, name, badges);
        return li;
      }),
    );

    const iAmHost = state.hostPid === this.myPid;
    const inLobby = state.phase === 'lobby';
    this.btnReady.disabled = !inLobby;
    this.btnReady.textContent = this.me()?.ready ? 'Ready ✓' : 'Ready up';
    this.btnReady.classList.toggle('primary', !this.me()?.ready);
    this.btnStart.classList.toggle('hidden', !iAmHost);
    this.btnStart.disabled = !inLobby || !allReady;
    this.btnStart.textContent = inLobby
      ? allReady
        ? 'Start match'
        : 'Waiting for ready players…'
      : 'Match in progress';

    this.statusLine.textContent = inLobby
      ? `${present.length} of 8 players here - share the code or link!`
      : 'Match running - good luck!';
  }

  private renderLobbyForm(): void {
    el('mp-form').classList.remove('hidden');
    this.roomView.classList.add('hidden');
    this.statusLine.textContent = MP_ENDPOINT
      ? 'Create a private room and share the code, or join a friend.'
      : 'Multiplayer server not configured.';
  }
}
