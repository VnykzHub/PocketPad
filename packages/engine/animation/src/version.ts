/**
 * Runtime constants for `@lanpad/engine-animation` (spec 08).
 *
 * Every value is a rule stated by spec 08; none is a measurement. The
 * matching public types live in `src/contracts/animation.d.ts`.
 */

/** 08 §4.1. `.pclip` container version (owned by spec 06's parser). */
export const ANIMATION_CLIP_VERSION = 1 as const;

/** 08 §4.1. `*.anim.json` metadata sidecar version (tooling only). */
export const ANIMATION_METADATA_VERSION = 1 as const;

/** 08 §4.6. `stateHash()` stream version. */
export const ANIMATION_HASH_VERSION = 1 as const;

/** 08 §3.1. Joints per skeleton (257 rejected at compile). */
export const ANIMATION_MAX_JOINTS = 256 as const;
export const ANIMATION_MAX_ROOTS = 16 as const;

/** 08 §3.1. Clip limits. */
export const ANIMATION_MAX_CLIP_DURATION = 3600 as const;
export const ANIMATION_MAX_KEYS_PER_TRACK = 65535 as const;
export const ANIMATION_MAX_KEYS_PER_CLIP = 200000 as const;
export const ANIMATION_MAX_TRACKS_PER_CLIP = 1024 as const;
export const ANIMATION_MAX_EVENTS_PER_CLIP = 256 as const;
export const ANIMATION_MAX_EVENT_NAME_BYTES = 64 as const;
export const ANIMATION_MAX_CLIP_NAME_BYTES = 64 as const;

/** 08 §3.1. Instance/action limits. */
export const ANIMATION_DEFAULT_MAX_INSTANCES = 1024 as const;
export const ANIMATION_MAX_INSTANCES_HARD = 1024 as const;
export const ANIMATION_MAX_ACTIONS_PER_INSTANCE = 8 as const;
export const ANIMATION_MAX_LAYERS_M1 = 2 as const;
export const ANIMATION_MAX_LAYERS_M2 = 8 as const;
export const ANIMATION_MAX_TREE_SAMPLES = 16 as const;
export const ANIMATION_MAX_MORPH_TARGETS = 32 as const;

/** 08 §3.1, §3.5. Event queue. */
export const ANIMATION_DEFAULT_EVENT_CAPACITY = 512 as const;
export const ANIMATION_MAX_PENDING_EVENTS = 512 as const;

/** 08 §3.5. Crossfade default and bounds. */
export const ANIMATION_DEFAULT_FADE_OUT_PREVIOUS = 0.2 as const;
export const ANIMATION_MAX_FADE_SECONDS = 10 as const;
export const ANIMATION_MIN_SPEED = 0 as const;
export const ANIMATION_MAX_SPEED = 10 as const;

/** 08 §3.1. Fixed step. */
export const ANIMATION_DEFAULT_FIXED_STEP = 1 / 60;

/** 08 §3.6. Root motion. */
export const ANIMATION_DEFAULT_MAX_DELTA_PER_TICK = 2 as const;
/** 08 §5.7. Accumulator bound: 10 s at 60 Hz. */
export const ANIMATION_ROOT_MOTION_ACCUM_TICKS = 600 as const;

/** 08 §4.6. Hash chunk ceiling. */
export const ANIMATION_HASH_CHUNK_BYTES = 65536 as const;

/** 08 §3.1. Event name shape. */
export const ANIMATION_EVENT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

/** 08 §3.3. Track path order used for compile sorting. */
export const ANIMATION_TRACK_PATH_ORDER = [
  "translation",
  "rotation",
  "scale",
  "weights",
] as const;
