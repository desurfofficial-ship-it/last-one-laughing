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
  deadzone: 0.1,
  /** Max stick travel in CSS px. */
  joystickRadius: 72,
};

export const MOVEMENT = {
  /** Acceleration while input is held (px/s^2). Snappier ramp than the
   *  original 3500/6.8 while terminal speed only rises ~5% (540 px/s):
   *  quicker to start AND quicker to stop, so steering feels predictable. */
  accelNormal: 4000,
  accelSlippery: 1100,
  /** Exponential velocity damping (1/s). Terminal speed = accel / damping. */
  dampingNormal: 7.4,
  dampingSlippery: 1.3,
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
  flatKnockback: 90,
};

export const COMBAT = {
  /** Collision restitution. Slightly below 1 keeps pile-ups stable. */
  restitution: 0.94,
  /** Victim delta-v (px/s) above which a hit counts as "big". */
  bigHitDeltaV: 850,
  /** Victim delta-v (px/s) a dash needs to count as "big" (grazes stay light). */
  dashBigDeltaV: 420,
  /** Hits below this delta-v are resting nudges: no feedback at all. */
  hitFxMinDeltaV: 140,
  /** Min gap between non-big feedback on the same victim (ms); stops grind spam. */
  pairFxCooldownMs: 110,
  /** Brief hitstop on big hits (ms) for impact weight. */
  freezeMs: 50,
  /** Camera shake bounds for big hits; scaled by impact between min and max. */
  shakeMs: 130,
  shakeIntensity: 0.0035,
  /** View-only knockback offset on the victim, as a fraction of its radius. */
  knockOffsetFrac: 0.42,
  /** Victim delta-v (px/s) above which a BUMPER strike counts as "big". */
  bumpBigDeltaV: 460,
  /** A confirmed dash slam (deltaV > dashBigDeltaV) always shoves the victim
   *  at least this fast along the contact normal. Prevents "dead slams"
   *  where a real connection barely moves the target. */
  slamMinKnock: 470,
};

/** Moving-obstacle + shrinking-arena modifier timing and tuning. */
export const MODS = {
  /** Seconds of quiet after GO before the first modifier warning. */
  firstDelay: 6,
  /** Seconds of quiet between one modifier window ending and the next warning. */
  restBetween: 12,
  /** Seconds of warning banner before a modifier activates. */
  warn: 2.5,
  /** Bumper-ball window (s) and ball tuning (px units). */
  bumperDuration: 9,
  bumperCount: 2,
  bumperRadius: 34,
  bumperSpeed: 300,
  /** Shrinking-arena window (s), how much radius it removes (px), and the
   *  seconds it takes to ease back out afterwards. */
  shrinkDuration: 7,
  shrinkAmount: 100,
  shrinkRestore: 2.5,
  /** Modifier shrink never goes below this, keeping headroom for sudden death. */
  shrinkFloor: 40,
};

export const ROUND = {
  countdown: 3,
  /** After this many seconds the arena starts shrinking for good (sudden
   *  death). This is the guaranteed round-ender; the temporary "shrinking
   *  arena" modifier is a separate, announced event. */
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
  bumper: 0xff9f43,
  bumperCore: 0x1a2036,
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

/** localStorage flag so the first-round tutorial hints show exactly once. */
export const TUTORIAL_KEY = 'lol_tut_v1';
