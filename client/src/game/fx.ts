/**
 * FX helpers shared by the multiplayer scene (extracted from GameScene's
 * private helpers, parameterized by scene, so the two render paths stay
 * visually identical). GameScene keeps its own copies to guarantee the
 * solo path stays byte-identical.
 */

import Phaser from 'phaser';

/** Directional impact burst (capped concurrent emitters keep pile-ups cheap). */
export function impactBurst(
  scene: Phaser.Scene,
  emitters: Set<Phaser.GameObjects.Particles.ParticleEmitter>,
  x: number,
  y: number,
  tint: number,
  dirDeg: number,
  spreadDeg: number,
  count: number,
  speed: number,
): void {
  if (emitters.size >= 6) {
    const oldest = emitters.values().next().value;
    if (oldest) {
      emitters.delete(oldest);
      oldest.destroy();
    }
  }
  const emitter = scene.add
    .particles(x, y, 'dot', {
      speed,
      angle: { min: dirDeg - spreadDeg, max: dirDeg + spreadDeg },
      lifespan: { min: 180, max: 380 },
      scale: { start: 0.75, end: 0 },
      blendMode: 'ADD',
      tint,
      emitting: false,
    })
    .setDepth(20);
  emitters.add(emitter);
  emitter.explode(count);
  scene.time.delayedCall(430, () => {
    emitters.delete(emitter);
    emitter.destroy();
  });
}

/** Short white flash ring at the contact point (big hits only). */
export function impactFlash(scene: Phaser.Scene, x: number, y: number): void {
  const ring = scene.add
    .circle(x, y, 20)
    .setStrokeStyle(4, 0xffffff, 0.95)
    .setDepth(21)
    .setBlendMode(Phaser.BlendModes.ADD);
  scene.tweens.add({
    targets: ring,
    scale: { from: 0.4, to: 1.7 },
    alpha: { from: 0.95, to: 0 },
    duration: 170,
    ease: 'Quad.easeOut',
    onComplete: () => ring.destroy(),
  });
}

/** Winner-colored confetti pop with upward bias and gravity. */
export function confetti(
  scene: Phaser.Scene,
  x: number,
  y: number,
  tint: number,
  delayMs: number,
): void {
  scene.time.delayedCall(delayMs, () => {
    const emitter = scene.add
      .particles(x, y, 'dot', {
        speed: { min: 220, max: 520 },
        angle: { min: 200, max: 340 },
        lifespan: { min: 500, max: 800 },
        scale: { start: 0.9, end: 0 },
        gravityY: 900,
        blendMode: 'ADD',
        tint,
        emitting: false,
      })
      .setDepth(22);
    emitter.explode(12);
    scene.time.delayedCall(900, () => emitter.destroy());
  });
}

/** Rim splash ring where a fighter falls out. */
export function splash(scene: Phaser.Scene, x: number, y: number, color: number): void {
  const ring = scene.add.circle(x, y, 26).setStrokeStyle(5, color, 0.9).setDepth(24);
  scene.tweens.add({
    targets: ring,
    scale: { from: 0.4, to: 1.8 },
    alpha: { from: 0.9, to: 0 },
    duration: 380,
    ease: 'Quad.easeOut',
    onComplete: () => ring.destroy(),
  });
}

/** Floating knockout messaging: bold main line plus a small info sub-line. */
export function koText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  main: string,
  color: string,
  sub: string | null,
): void {
  const label = scene.add
    .text(x, y, main, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '40px',
      fontStyle: 'bold',
      color,
      stroke: '#0e1120',
      strokeThickness: 6,
      resolution: 2,
    })
    .setOrigin(0.5)
    .setDepth(25);
  scene.tweens.add({
    targets: label,
    y: y - 70,
    alpha: { from: 0, to: 1 },
    duration: 150,
    ease: 'Quad.easeOut',
    onComplete: () => {
      scene.tweens.add({
        targets: label,
        alpha: 0,
        duration: 420,
        delay: 260,
        onComplete: () => label.destroy(),
      });
    },
  });

  if (!sub) return;
  const subLabel = scene.add
    .text(x, y + 44, sub, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '24px',
      fontStyle: 'bold',
      color: '#aab2d5',
      stroke: '#0e1120',
      strokeThickness: 4,
      resolution: 2,
    })
    .setOrigin(0.5)
    .setDepth(25);
  scene.tweens.add({
    targets: subLabel,
    y: y + 44 - 70,
    alpha: { from: 0, to: 0.95 },
    duration: 150,
    ease: 'Quad.easeOut',
    onComplete: () => {
      scene.tweens.add({
        targets: subLabel,
        alpha: 0,
        duration: 420,
        delay: 340,
        onComplete: () => subLabel.destroy(),
      });
    },
  });
}

export function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export function fmtTime(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function vibrate(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported (e.g. iOS Safari) */
  }
}

/** '#rrggbb' -> 0xrrggbb (roster colors arrive as CSS strings). */
export function cssToColor(css: string): number {
  const n = parseInt(css.replace('#', ''), 16);
  return Number.isFinite(n) ? n : 0xffffff;
}
