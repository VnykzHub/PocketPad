/**
 * ER-07-09 parity harness for the M0 2D migration (07 §5.15).
 *
 * The harness is deliberately physics-module agnostic: it receives the
 * `integrate` / `resolveCircleAabb` / `resolveCircleCircle` implementations as
 * an injected module. The golden trace was generated against the pre-migration
 * `packages/runtime/src/physics` code and is verified against
 * `packages/engine/physics/src/two-d`. Both runs execute this exact harness, so
 * a difference in the fixture means a behaviour change in the solver, not a
 * difference in the scenario.
 *
 * The scenario mirrors Coin Run's tick order (`packages/games/platformer/src/
 * player.ts`): move the horizontal velocity toward the command target, apply
 * gravity, jump, `integrate`, then resolve platforms in the world's sorted
 * order with the same `skin` separation and top-surface snap. Game rules that
 * do not touch collision (coins, checkpoints, goal, respawn timers) are out of
 * scope; the arena catches a body that leaves the level so every tick is a
 * pure collision result.
 *
 * Hashing is FNV-1a 32 over a canonical little-endian stream of every body in
 * a fixed order: `f64 x, y, vx, vy`, then `u32 hits` (the number of successful
 * resolutions for that body). `hits` makes a branch difference visible even
 * when positions happen to coincide.
 */

/** Structural mirror of the frozen `Vec2` (07 §5.15). */
export interface Vec2Like {
  x: number;
  y: number;
}

/** Structural mirror of the frozen `Aabb`. */
export interface AabbLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Structural mirror of the frozen `Arena`. */
export interface ArenaLike {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Structural mirror of the frozen `Contact`. */
export interface ContactLike {
  nx: number;
  ny: number;
  depth: number;
}

/** Structural mirror of the frozen `CircleBody`. */
export interface CircleBodyLike {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  mass: number;
  restitution: number;
  friction: number;
  active: boolean;
  id: number;
}

/** The three frozen solver functions plus the speed cap. */
export interface TwoDPrimitives {
  readonly MAX_SPEED: number;
  integrate(body: CircleBodyLike, dt: number, arena: ArenaLike): void;
  resolveCircleAabb(
    circle: CircleBodyLike,
    box: AabbLike,
    out?: ContactLike,
  ): boolean;
  resolveCircleCircle(
    a: CircleBodyLike,
    b: CircleBodyLike,
    out?: ContactLike,
  ): boolean;
}

/** One horizontal command segment, `[from, to)` in 0-based tick indices. */
export interface MoveSegment {
  readonly from: number;
  readonly to: number;
  readonly moveX: number;
}

/** One scripted Coin Run player. */
export interface PlayerPlan {
  readonly spawnX: number;
  readonly spawnY: number;
  readonly radius: number;
  readonly mass: number;
  readonly segments: readonly MoveSegment[];
  /** 0-based tick indices at which a jump is requested while grounded. */
  readonly jumpTicks: readonly number[];
}

/** One free solver probe. */
export interface BodyPlan {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly radius: number;
  readonly mass: number;
  readonly restitution: number;
  readonly friction: number;
}

/** A circle-circle pair resolved once per tick. */
export interface PairPlan {
  readonly a: BodyPlan;
  readonly b: BodyPlan;
  /** When false the pair keeps its scripted velocities (used for static pairs). */
  readonly gravity: boolean;
}

/** World constants copied from Coin Run's level/config at authoring time. */
export interface ScenarioWorld {
  readonly arena: ArenaLike;
  /** Sorted exactly like `World.platforms`: left edge, then top edge. */
  readonly platforms: readonly AabbLike[];
  readonly gravity: number;
  readonly maxFall: number;
  readonly moveSpeed: number;
  readonly accel: number;
  readonly jumpVelocity: number;
  readonly skin: number;
  /** A contact at or above this vertical component counts as ground. */
  readonly groundNormalY: number;
}

/** Full deterministic scenario. */
export interface Scenario {
  readonly ticks: number;
  readonly dt: number;
  readonly world: ScenarioWorld;
  readonly players: readonly PlayerPlan[];
  readonly probes: readonly BodyPlan[];
  readonly pairs: readonly PairPlan[];
}

/** A hashed body; `hits` counts successful resolutions this run. */
export interface SimBody extends CircleBodyLike {
  hits: number;
}

/** One body's recorded state. */
export interface BodySample {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly hits: number;
}

/** Recorded state at a completed tick (1-based). */
export interface RunSample {
  readonly tick: number;
  readonly bodies: readonly BodySample[];
}

/** Harness output; `hashes[i]` is the state after tick `i + 1`. */
export interface RunResult {
  readonly hashes: readonly string[];
  readonly samples: readonly RunSample[];
  readonly final: RunSample;
}

interface PlayerState {
  readonly plan: PlayerPlan;
  readonly body: SimBody;
  grounded: boolean;
}

interface ProbeState {
  readonly body: SimBody;
}

interface PairState {
  readonly plan: PairPlan;
  readonly a: SimBody;
  readonly b: SimBody;
}

interface SimState {
  readonly players: PlayerState[];
  readonly probes: ProbeState[];
  readonly pairs: PairState[];
}

const CONTACT: ContactLike = { nx: 0, ny: 0, depth: 0 };
const HASH_SCRATCH = new ArrayBuffer(8);
const HASH_VIEW = new DataView(HASH_SCRATCH);

function makeBody(plan: BodyPlan): SimBody {
  return {
    x: plan.x,
    y: plan.y,
    vx: plan.vx,
    vy: plan.vy,
    radius: plan.radius,
    mass: plan.mass,
    restitution: plan.restitution,
    friction: plan.friction,
    active: true,
    id: plan.id,
    hits: 0,
  };
}

function createState(scenario: Scenario): SimState {
  const players: PlayerState[] = [];
  for (let i = 0; i < scenario.players.length; i += 1) {
    const plan = scenario.players[i];
    if (plan === undefined) continue;
    players.push({
      plan,
      grounded: false,
      body: {
        x: plan.spawnX,
        y: plan.spawnY,
        vx: 0,
        vy: 0,
        radius: plan.radius,
        mass: plan.mass,
        restitution: 0,
        friction: 0,
        active: true,
        id: i + 1,
        hits: 0,
      },
    });
  }

  const probes: ProbeState[] = [];
  for (let i = 0; i < scenario.probes.length; i += 1) {
    const plan = scenario.probes[i];
    if (plan === undefined) continue;
    probes.push({ body: makeBody(plan) });
  }

  const pairs: PairState[] = [];
  for (let i = 0; i < scenario.pairs.length; i += 1) {
    const plan = scenario.pairs[i];
    if (plan === undefined) continue;
    pairs.push({ plan, a: makeBody(plan.a), b: makeBody(plan.b) });
  }

  return { players, probes, pairs };
}

/** Move command for a 0-based tick index; outside every segment means 0. */
function moveXAt(segments: readonly MoveSegment[], tick: number): number {
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment !== undefined && tick >= segment.from && tick < segment.to) {
      return segment.moveX;
    }
  }
  return 0;
}

/** Gravity before the solver step; clamps the fall speed like Coin Run. */
function applyGravity(
  body: SimBody,
  world: ScenarioWorld,
  dt: number,
): void {
  body.vy += world.gravity * dt;
  if (body.vy > world.maxFall) {
    body.vy = world.maxFall;
  }
}

/**
 * First sorted-platform index that can overlap a circle. Mirrors
 * `World.platformWindowStart` so player resolution scans the same platforms in
 * the same order as the game.
 */
function platformWindowStart(
  platforms: readonly AabbLike[],
  maxPlatformWidth: number,
  x: number,
  radius: number,
): number {
  const minX = x - radius - maxPlatformWidth;
  let low = 0;
  let high = platforms.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const platform = platforms[mid];
    if (platform !== undefined && platform.x < minX) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function maxWidth(platforms: readonly AabbLike[]): number {
  let widest = 0;
  for (let i = 0; i < platforms.length; i += 1) {
    const platform = platforms[i];
    if (platform !== undefined && platform.w > widest) {
      widest = platform.w;
    }
  }
  return widest;
}

/**
 * Coin Run's platform resolution: sorted scan with the x-window and break,
 * full positional correction from the solver, `skin` separation, then a top
 * contact snap. Returns the grounded flag for the next tick's jump.
 */
function resolvePlayerPlatforms(
  primitives: TwoDPrimitives,
  world: ScenarioWorld,
  widest: number,
  state: PlayerState,
): boolean {
  const body = state.body;
  const radius = body.radius;
  const platforms = world.platforms;
  const start = platformWindowStart(platforms, widest, body.x, radius);
  let grounded = false;

  for (let i = start; i < platforms.length; i += 1) {
    const box = platforms[i];
    if (box === undefined || box.x > body.x + radius) {
      break;
    }
    const vyBefore = body.vy;
    if (!primitives.resolveCircleAabb(body, box, CONTACT)) {
      continue;
    }
    body.hits += 1;
    body.x += CONTACT.nx * world.skin;
    body.y += CONTACT.ny * world.skin;

    if (CONTACT.ny <= world.groundNormalY && vyBefore >= 0) {
      body.y = box.y - radius;
      if (body.vy > 0) body.vy = 0;
      grounded = true;
    }
  }

  return grounded;
}

/** Raw solver probe path: every platform is tested in sorted order. */
function resolveFreePlatforms(
  primitives: TwoDPrimitives,
  world: ScenarioWorld,
  body: SimBody,
): void {
  const platforms = world.platforms;
  for (let i = 0; i < platforms.length; i += 1) {
    const box = platforms[i];
    if (box === undefined) continue;
    if (primitives.resolveCircleAabb(body, box, CONTACT)) {
      body.hits += 1;
    }
  }
}

function stepPlayer(
  primitives: TwoDPrimitives,
  scenario: Scenario,
  widest: number,
  state: PlayerState,
  tick: number,
): void {
  const body = state.body;
  if (!body.active) return;
  const world = scenario.world;
  const dt = scenario.dt;

  // Horizontal: approach the target speed at a bounded acceleration.
  const targetVx = moveXAt(state.plan.segments, tick) * world.moveSpeed;
  const maxDelta = world.accel * dt;
  if (body.vx < targetVx) {
    body.vx = Math.min(targetVx, body.vx + maxDelta);
  } else if (body.vx > targetVx) {
    body.vx = Math.max(targetVx, body.vx - maxDelta);
  }

  // Gravity before the jump impulse: a jump starts at exactly jumpVelocity.
  applyGravity(body, world, dt);
  if (state.plan.jumpTicks.includes(tick) && state.grounded) {
    body.vy = -world.jumpVelocity;
  }
  state.grounded = false;

  primitives.integrate(body, dt, world.arena);
  state.grounded = resolvePlayerPlatforms(primitives, world, widest, state);
}

function stepProbe(
  primitives: TwoDPrimitives,
  scenario: Scenario,
  body: SimBody,
): void {
  applyGravity(body, scenario.world, scenario.dt);
  primitives.integrate(body, scenario.dt, scenario.world.arena);
  resolveFreePlatforms(primitives, scenario.world, body);
}

function stepPair(
  primitives: TwoDPrimitives,
  scenario: Scenario,
  pair: PairState,
): void {
  const dt = scenario.dt;
  if (pair.plan.gravity) {
    applyGravity(pair.a, scenario.world, dt);
    applyGravity(pair.b, scenario.world, dt);
  }
  primitives.integrate(pair.a, dt, scenario.world.arena);
  primitives.integrate(pair.b, dt, scenario.world.arena);
  resolveFreePlatforms(primitives, scenario.world, pair.a);
  resolveFreePlatforms(primitives, scenario.world, pair.b);
  if (primitives.resolveCircleCircle(pair.a, pair.b, CONTACT)) {
    pair.a.hits += 1;
    pair.b.hits += 1;
  }
}

function allBodies(state: SimState): SimBody[] {
  const bodies: SimBody[] = [];
  for (let i = 0; i < state.players.length; i += 1) {
    const player = state.players[i];
    if (player !== undefined) bodies.push(player.body);
  }
  for (let i = 0; i < state.probes.length; i += 1) {
    const probe = state.probes[i];
    if (probe !== undefined) bodies.push(probe.body);
  }
  for (let i = 0; i < state.pairs.length; i += 1) {
    const pair = state.pairs[i];
    if (pair !== undefined) {
      bodies.push(pair.a);
      bodies.push(pair.b);
    }
  }
  return bodies;
}

/** JSON-safe number: `-0` is written as `0` by JSON.stringify anyway. */
function jsonNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function bodySample(body: SimBody): BodySample {
  return {
    id: body.id,
    x: jsonNumber(body.x),
    y: jsonNumber(body.y),
    vx: jsonNumber(body.vx),
    vy: jsonNumber(body.vy),
    hits: body.hits,
  };
}

function hashFloat(hash: number, value: number): number {
  HASH_VIEW.setFloat64(0, value, true);
  let next = hash;
  for (let i = 0; i < 8; i += 1) {
    next = Math.imul(next ^ HASH_VIEW.getUint8(i), 0x01000193);
  }
  return next >>> 0;
}

function hashU32(hash: number, value: number): number {
  HASH_VIEW.setUint32(0, value, true);
  let next = hash;
  for (let i = 0; i < 4; i += 1) {
    next = Math.imul(next ^ HASH_VIEW.getUint8(i), 0x01000193);
  }
  return next >>> 0;
}

/** FNV-1a 32 over the canonical body-state stream. */
export function hashBodies(bodies: readonly SimBody[]): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bodies.length; i += 1) {
    const body = bodies[i];
    if (body === undefined) continue;
    hash = hashFloat(hash, body.x);
    hash = hashFloat(hash, body.y);
    hash = hashFloat(hash, body.vx);
    hash = hashFloat(hash, body.vy);
    hash = hashU32(hash, body.hits);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Runs the scenario with the injected solver. Pure: creates its own bodies and
 * writes no global state, so the pre- and post-migration runs cannot share a
 * mutable scratch object by accident.
 */
export function runScenario(
  primitives: TwoDPrimitives,
  scenario: Scenario,
): RunResult {
  const state = createState(scenario);
  const widest = maxWidth(scenario.world.platforms);
  const hashes: string[] = [];
  const samples: RunSample[] = [];
  let final: RunSample = { tick: 0, bodies: [] };

  for (let tick = 0; tick < scenario.ticks; tick += 1) {
    for (let i = 0; i < state.players.length; i += 1) {
      const player = state.players[i];
      if (player !== undefined) {
        stepPlayer(primitives, scenario, widest, player, tick);
      }
    }
    for (let i = 0; i < state.probes.length; i += 1) {
      const probe = state.probes[i];
      if (probe !== undefined) stepProbe(primitives, scenario, probe.body);
    }
    for (let i = 0; i < state.pairs.length; i += 1) {
      const pair = state.pairs[i];
      if (pair !== undefined) stepPair(primitives, scenario, pair);
    }

    const bodies = allBodies(state);
    hashes.push(hashBodies(bodies));
    const completed = tick + 1;
    if (completed % 30 === 0 || completed === scenario.ticks) {
      const sample: RunSample = {
        tick: completed,
        bodies: bodies.map(bodySample),
      };
      samples.push(sample);
      final = sample;
    }
  }

  return { hashes, samples, final };
}
