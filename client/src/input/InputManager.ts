/**
 * Unified input: keyboard (desktop) + floating touch joystick and dash button
 * (mobile). Pointer Events cover touch, pen and mouse. All state is written
 * into the shared playerInput bridge; the game layer never touches the DOM.
 */

import { INPUT } from '../game/constants';
import { playerInput } from './playerInput';

const MOVE_KEYS: Record<string, readonly [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

const DASH_KEYS = new Set(['Space']);

export class InputManager {
  private keys = new Set<string>();
  private joyActive = false;
  private joyId = -1;
  private baseX = 0;
  private baseY = 0;

  private readonly zone: HTMLElement;
  private readonly dashBtn: HTMLElement;
  private readonly joyBase: HTMLElement;
  private readonly joyStick: HTMLElement;

  constructor(zone: HTMLElement, dashBtn: HTMLElement) {
    this.zone = zone;
    this.dashBtn = dashBtn;
    this.joyBase = document.getElementById('joy-base') as HTMLElement;
    this.joyStick = document.getElementById('joy-stick') as HTMLElement;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.clearAll);

    this.zone.addEventListener('pointerdown', this.onZoneDown);
    this.zone.addEventListener('pointermove', this.onZoneMove);
    this.zone.addEventListener('pointerup', this.onZoneUp);
    this.zone.addEventListener('pointercancel', this.onZoneUp);

    this.dashBtn.addEventListener('pointerdown', this.onDashDown);
    this.dashBtn.addEventListener('pointerup', this.onDashUp);
    this.dashBtn.addEventListener('pointercancel', this.onDashUp);

    for (const el of [this.zone, this.dashBtn]) {
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  // ------------------------------------------------------------- keyboard

  /** True when the user is typing into a form field — game keys must not steal letters. */
  private isTypingTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    if (!el) return false;
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return !!el.closest?.('input, textarea, select, [contenteditable="true"]');
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isTypingTarget(e.target)) return;
    if (MOVE_KEYS[e.code] || DASH_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(e.code);
    if (DASH_KEYS.has(e.code)) playerInput.dashQueued = true;
    this.applyKeyboard();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (this.isTypingTarget(e.target)) return;
    this.keys.delete(e.code);
    this.applyKeyboard();
  };

  private applyKeyboard(): void {
    if (this.joyActive) return; // joystick wins while it is engaged
    let x = 0;
    let y = 0;
    for (const code of this.keys) {
      const v = MOVE_KEYS[code];
      if (v) {
        x += v[0];
        y += v[1];
      }
    }
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    playerInput.moveX = x;
    playerInput.moveY = y;
  }

  private clearAll = (): void => {
    this.keys.clear();
    this.joyActive = false;
    this.joyId = -1;
    this.joyBase.style.display = 'none';
    playerInput.moveX = 0;
    playerInput.moveY = 0;
  };

  // ------------------------------------------------------- touch joystick

  private onZoneDown = (e: PointerEvent): void => {
    if (this.joyId !== -1) return;
    e.preventDefault();
    this.joyId = e.pointerId;
    this.joyActive = true;
    try {
      this.zone.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    this.baseX = e.clientX;
    this.baseY = e.clientY;
    this.joyBase.style.left = `${this.baseX}px`;
    this.joyBase.style.top = `${this.baseY}px`;
    this.joyBase.style.display = 'block';
    this.joyStick.style.transform = 'translate(-50%, -50%)';
  };

  private onZoneMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.joyId) return;
    e.preventDefault();
    let dx = e.clientX - this.baseX;
    let dy = e.clientY - this.baseY;
    const len = Math.hypot(dx, dy);
    const max = INPUT.joystickRadius;
    if (len > max) {
      dx = (dx / len) * max;
      dy = (dy / len) * max;
    }
    this.joyStick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    const mag = Math.min(1, len / max);
    if (mag < INPUT.deadzone || len === 0) {
      playerInput.moveX = 0;
      playerInput.moveY = 0;
    } else {
      const scale = (mag - INPUT.deadzone) / (1 - INPUT.deadzone);
      playerInput.moveX = (dx / len) * scale;
      playerInput.moveY = (dy / len) * scale;
    }
  };

  private onZoneUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.joyId) return;
    this.joyId = -1;
    this.joyActive = false;
    this.joyBase.style.display = 'none';
    this.applyKeyboard(); // re-apply keyboard if keys are still held, else zero
  };

  // ---------------------------------------------------------- dash button

  private onDashDown = (e: PointerEvent): void => {
    e.preventDefault();
    playerInput.dashQueued = true;
    this.dashBtn.classList.add('pressed');
  };

  private onDashUp = (): void => {
    this.dashBtn.classList.remove('pressed');
  };
}
