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
  private btnCreate = el<HTMLButtonElement>('mp-create');
  private btnJoin = el<HTMLButtonElement>('mp-join');
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
  /** True while a join is retrying (server likely cold-starting). */
  private waking = false;

  constructor() {
    this.nameInput.value = readName();

    // pointerup + debounced click (same reason as UIManager: mobile WebKit can
    // drop synthetic clicks when touchmove is non-passive-prevented).
    const on = (node: HTMLElement, fn: () => void) => {
      let last = 0;
      const fire = () => {
        const now = performance.now();
        if (now - last < 350) return;
        last = now;
        fn();
      };
      node.addEventListener('pointerup', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        fire();
      });
      node.addEventListener('click', fire);
    };

    on(el('btn-online'), () => {
      sfx.ui();
      this.openPanel();
    });
    on(el('mp-close'), () => {
      sfx.ui();
      // Leaving via X also leaves the room if seated.
      if (mpSession.connected) mpSession.requestLeave();
      this.closePanel();
    });
    on(this.btnCreate, () => {
      sfx.ui();
      void this.withName(async (name) => {
        await mpSession.create(name);
      });
    });
    on(this.btnJoin, () => {
      sfx.ui();
      const code = this.codeInput.value.trim().toUpperCase();
      void this.withName(async (name) => {
        await mpSession.join(code, name);
      });
    });
    on(this.btnCopy, () => {
      sfx.ui();
      void this.shareInvite();
    });
    on(this.btnReady, () => {
      sfx.ui();
      const me = this.me();
      if (me) mpSession.sendReady(!me.ready);
    });
    on(this.btnStart, () => {
      sfx.ui();
      mpSession.sendStart();
    });
    on(this.btnLeave, () => {
      sfx.ui();
      mpSession.requestLeave();
      this.renderLobbyForm();
    });

    this.unsub.push(
      mpSession.on('status', () => this.render()),
      mpSession.on('state', () => this.renderThrottled()),
      mpSession.on('entered', (p: { pid: number; code: string }) => {
        this.waking = false;
        this.reconnectBanner.classList.add('hidden');
        this.myPid = p.pid;
        // Opening the panel over a LIVE match would block play (and park
        // the buttons under the joystick zone) - stay out of the way; the
        // phase handler reopens the panel when the round ends.
        const phase = document.body.dataset.phase;
        if (!phase || phase === 'idle' || phase === 'lobby') this.openPanel();
        else this.render();
      }),
      mpSession.on('error', (msg: string) => {
        this.waking = false;
        this.myPid = 0; // terminal session failure: the seat is gone
        this.errorLine.textContent = msg;
        this.errorLine.classList.remove('hidden');
        this.reconnectBanner.classList.add('hidden');
        // Connection losses can happen while the panel is hidden (mid-match);
        // surface the failure instead of leaving a dead screen.
        if (!mpSession.connected) this.openPanel();
      }),
      mpSession.on('server-error', (e: { code: string; message: string }) => {
        this.errorLine.textContent = e.message;
        this.errorLine.classList.remove('hidden');
      }),
      // Free-tier hosts sleep when idle; surface the retry instead of silence.
      mpSession.on('connecting-retry', () => {
        this.waking = true;
        if (!mpSession.connected) this.render();
      }),
      mpSession.on('left', (p: { intentional: boolean }) => {
        // Only a deliberate leave resets identity; an unexpected drop keeps
        // the seat (and myPid) while the SDK auto-reconnection recovers.
        if (p.intentional) {
          this.myPid = 0;
          this.waking = false;
          this.reconnectBanner.classList.add('hidden');
          this.render();
        } else {
          // Seat is held server-side (~90 s): show the reconnecting state
          // even mid-match, when the lobby panel itself is hidden.
          this.reconnectBanner.classList.remove('hidden');
        }
      }),
      mpSession.on('reconnected', () => {
        this.reconnectBanner.classList.add('hidden');
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

  /** Web Share wins on mobile (native share sheet); clipboard elsewhere. */
  private async shareInvite(): Promise<void> {
    const url = this.shareUrl();
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ url });
        return;
      } catch {
        /* user cancelled - fall through to clipboard */
      }
    }
    const copied = await navigator.clipboard?.writeText(url).then(
      () => true,
      () => false,
    );
    if (copied) {
      this.btnCopy.textContent = 'Copied';
      window.setTimeout(() => (this.btnCopy.textContent = 'Copy link'), 1600);
    } else {
      window.prompt('Copy this invite link:', url);
    }
  }

  private openPanel(): void {
    this.panel.classList.remove('hidden');
    // A freshly opened lobby never shows yesterday's error.
    this.errorLine.textContent = '';
    this.errorLine.classList.add('hidden');
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
    // 'mp' stays active while a seat is held (reconnecting) so mid-match UI
    // (touch controls, pause guard) keeps multiplayer semantics.
    const mpActive = mpSession.connected || this.myPid !== 0;
    document.body.dataset.mode = mpActive ? 'mp' : 'solo';
    if (this.panel.classList.contains('hidden')) return;

    const connected = mpSession.connected;
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
    this.btnStart.textContent = allReady ? 'Start match' : 'Waiting for ready players…';

    // The roster + buttons are the interface; a running match needs no copy.
    this.statusLine.textContent = '';
  }

  private renderLobbyForm(): void {
    el('mp-form').classList.remove('hidden');
    this.roomView.classList.add('hidden');

    if (!MP_ENDPOINT) {
      // Deployment state: this build has no multiplayer server wired up.
      this.statusLine.textContent = 'Multiplayer is not configured.';
      this.btnCreate.disabled = true;
      this.btnJoin.disabled = true;
      return;
    }

    // Session states: connecting (first attempt) vs waking (retry after a
    // cold start). Everything else stays silent - the form IS the interface.
    const connecting = mpSession.status === 'connecting';
    this.btnCreate.disabled = connecting;
    this.btnJoin.disabled = connecting;
    this.statusLine.textContent = connecting ? (this.waking ? 'Waking the server…' : 'Connecting…') : '';
  }
}
