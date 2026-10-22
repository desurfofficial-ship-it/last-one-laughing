/**
 * Central tuning constants for Last One Laughing.
 * All gameplay numbers live here so the prototype can be balanced in one place.
 * The world is a fixed 1080x1080 logical space, scaled to fit any screen.
 */

/** Fixed logical game resolution. A square keeps the circular arena equally
 *  playable on portrait phones and landscape desktops (Phaser Scale.FIT). */
export const LOGICAL_WIDTH = 1080;
export const LOGICAL_HEIGHT = 1080;

export const ARENA_CENTER = { x: LOGICAL_WIDTH / 2, y: LOGICAL_HEIGHT / 2 };
export const ARENA_RADIUS = 440;
/** Sudden-death shrink floor so every round is guaranteed to end. */
export const ARENA_MIN_RADIUS = 270;
/** A fighter falls once its center passes this far beyond the arena edge. */
export const FALL_MARGIN = 6;

export const INPUT = {
  /** Joystick deadzone (fraction of full deflection). */
  deadzone: 0.12,
  /** Max stick travel in CSS px. */
  joystickRadius: 64,
};

export const MOVEMENT = {
  /** Acceleration while input is held (px/s^2). */
  accelNormal: 3500,
  accelSlippery: 950,
  /** Exponential velocity damping (1/s). Terminal speed = accel / damping. */
  dampingNormal: 6.8,
  dampingSlippery: 1.15,
};

export const DASH = {
  /** Instant velocity impulse added along the input direction (px/s). */
  speed: 840,
  /** Time window in which a dash counts as a "slam" for knockback purposes. */
  duration: 0.16,
  cooldown: 1.8,
  /** Impulse multiplier when a dashing fighter hits a non-dashing one. */
  knockbackMultiplier: 1.35,
  /** Extra flat shove applied to a dashed victim (px/s). */
  flatKnockback: 70,
};

export const COMBAT = {
  /** Collision restitution. Slightly below 1 keeps pile-ups stable. */
  restitution: 0.94,
  /** Victim delta-v (px/s) above which a hit counts as "big". */
  bigHitDeltaV: 850,
  /** Brief hitstop on big hits (ms) for impact weight. */
  freezeMs: 50,
  shakeMs: 100,
  shakeIntensity: 0.0035,
};

export const ROUND = {
  countdown: 3,
  /** After this many seconds the arena starts shrinking (sudden death). */
  suddenDeathAfter: 75,
  /** Arena shrink speed during sudden death (px/s). */
  suddenDeathShrink: 14,
};

export const SLIPPERY = {
  /** Seconds of normal floor between slippery phases. */
  normal: 10,
  /** Seconds of warning banner before the floor turns slippery. */
  warning: 2,
  /** Seconds the floor stays slippery. */
  slippery: 4,
};

export const FALL_ANIM_MS = 450;

export const PALETTE = {
  bg: 0x0e1120,
  arenaFill: 0x171d33,
  arenaRing: 0x55628f,
  arenaInner: 0x2a3352,
  icy: 0x7fd8ff,
  warning: 0xffd23f,
  danger: 0xff5d5d,
  text: '#eef1ff',
};

export interface FighterDef {
  name: string;
  color: number;
  css: string;
  isPlayer: boolean;
  radius: number;
}

export const FIGHTER_DEFS: FighterDef[] = [
  { name: 'You', color: 0xffd23f, css: '#ffd23f', isPlayer: true, radius: 40 },
  { name: 'Rex', color: 0xff5d5d, css: '#ff5d5d', isPlayer: false, radius: 44 },
  { name: 'Momo', color: 0x3ddc97, css: '#3ddc97', isPlayer: false, radius: 38 },
  { name: 'Bit', color: 0x4da3ff, css: '#4da3ff', isPlayer: false, radius: 36 },
];

/** Spawn angles (degrees) around the arena center, one per fighter. */
export const SPAWN_ANGLES_DEG = [135, 225, 315, 45];

export const LOL_TEXTS = ['HA!', 'HA HA!', 'LOL!', 'BYE!', 'GOT EM!'];
