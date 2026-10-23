/**
 * Snake Royale grid simulation (GAME-SR-HOST-01/02/03/05; GAME-SR-DATA-01/02).
 *
 * A fixed 32x32 grid stepped at 8 Hz. Every snake, food object and scratch
 * buffer is allocated in the constructor; `update`, `step` and `shrink` only
 * touch typed arrays and fields, so the hot path allocates nothing (PR-9.3).
 *
 * Rules, documented because the plan leaves the head-on case open
 * (GAME-SR-TEST-02):
 *
 * - Every snake computes its next head from the state at the start of the
 *   step, then all deaths resolve simultaneously.
 * - A head moving out of bounds, onto a wall, or onto an occupied cell dies.
 *   The one exception is a snake's tail cell when that owner moves and does
 *   not grow this step: the tail vacates, so following it is legal.
 * - Two or more heads targeting the same cell all die (head-on rule).
 * - Moving into another snake's body, including its head cell, dies; head
 *   swaps are not allowed and are treated as a collision.
 * - A disconnected snake keeps its last direction (no turns) for up to
 *   `respawnGraceMs`; after that it is eliminated. Reconnecting before the
 *   deadline resumes control if the snake is still alive (GAME-SR-HOST-05).
 */
import { createPool, type Pool } from "@lanpad/game-kit";
import {
  DIRECTION_DX,
  DIRECTION_DY,
  DIRECTION_RIGHT,
  HOST_TICK_MS,
  SNAKE_ROYALE_CONFIG,
  isDirection,
  oppositeDirection,
  type Direction,
  type Turn,
} from "./config.js";

/** Deterministic integer source, normally `GameRng.int`. */
export type RandomInt = (min: number, max: number) => number;

export interface SnakeWorldOptions {
  readonly gridSize?: number;
  readonly stepHz?: number;
  readonly initialLength?: number;
  readonly shrinkEveryMs?: number;
  readonly foodCount?: number;
  readonly respawnGraceMs?: number;
}

interface Food {
  x: number;
  y: number;
}

const SLOT_COUNT = SNAKE_ROYALE_CONFIG.maxPlayers;
const TARGET_NONE = -1;
const TARGET_OUT = -2;

function requireInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in ${min}..${max}.`);
  }
}

function requirePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number.`);
  }
}

/** One snake's grid state. Fields are read by the HUD and renderer. */
export class Snake {
  readonly slot: number;
  readonly cells: Int32Array;
  readonly prevCells: Int32Array;
  participating = false;
  alive = false;
  connected = false;
  direction: Direction = DIRECTION_RIGHT;
  /** A queued turn, applied on the next step; -1 means none. */
  turn: Turn = -1;
  length = 0;
  prevLength = 0;
  foodEaten = 0;
  disconnectedMs = 0;

  constructor(slot: number, capacity: number) {
    this.slot = slot;
    this.cells = new Int32Array(capacity);
    this.prevCells = new Int32Array(capacity);
  }

  reset(): void {
    this.participating = false;
    this.alive = false;
    this.connected = false;
    this.direction = DIRECTION_RIGHT;
    this.turn = -1;
    this.length = 0;
    this.prevLength = 0;
    this.foodEaten = 0;
    this.disconnectedMs = 0;
    this.cells.fill(0);
    this.prevCells.fill(0);
  }
}

export class SnakeWorld {
  readonly gridSize: number;
  readonly stepIntervalMs: number;
  readonly initialLength: number;
  readonly shrinkEveryMs: number;
  readonly foodCount: number;
  readonly respawnGraceMs: number;
  readonly maxInset: number;
  readonly capacity: number;
  readonly walls: Uint8Array;
  readonly occupancy: Int32Array;
  readonly foodCells: Uint8Array;
  readonly snakes: readonly Snake[];

  private readonly randomInt: RandomInt;
  private readonly freeCells: Int32Array;
  private readonly spawnSlots: Int32Array;
  private readonly targets: Int32Array;
  private readonly foodPool: Pool<Food>;
  private readonly activeFoods: Food[] = [];
  private activeFoodCountValue = 0;
  private participantMaskValue = 0;
  private participantCountValue = 0;
  private aliveCountValue = 0;
  private insetValue = 0;
  private elapsedValue = 0;
  private nextShrinkAt = 0;
  private accumulator = 0;
  private stepCountValue = 0;

  constructor(randomInt: RandomInt, options: SnakeWorldOptions = {}) {
    const gridSize = options.gridSize ?? SNAKE_ROYALE_CONFIG.gridSize;
    const stepHz = options.stepHz ?? SNAKE_ROYALE_CONFIG.stepHz;
    const initialLength = options.initialLength ?? SNAKE_ROYALE_CONFIG.initialLength;
    const shrinkEveryMs = options.shrinkEveryMs ?? SNAKE_ROYALE_CONFIG.shrinkEveryMs;
    const foodCount = options.foodCount ?? SNAKE_ROYALE_CONFIG.foodCount;
    const respawnGraceMs = options.respawnGraceMs ?? SNAKE_ROYALE_CONFIG.respawnGraceMs;

    requireInteger("gridSize", gridSize, 4, 256);
    requireInteger("stepHz", stepHz, 1, 60);
    requireInteger("initialLength", initialLength, 1, gridSize - 2);
    requirePositive("shrinkEveryMs", shrinkEveryMs);
    requireInteger("foodCount", foodCount, 0, gridSize * gridSize);
    if (!Number.isFinite(respawnGraceMs) || respawnGraceMs < 0) {
      throw new RangeError("respawnGraceMs must be a non-negative number.");
    }

    this.gridSize = gridSize;
    this.stepIntervalMs = 1000 / stepHz;
    this.initialLength = initialLength;
    this.shrinkEveryMs = shrinkEveryMs;
    this.foodCount = foodCount;
    this.respawnGraceMs = respawnGraceMs;
    this.maxInset = Math.floor((gridSize - 2) / 2);
    this.capacity = gridSize * gridSize;
    this.walls = new Uint8Array(this.capacity);
    this.occupancy = new Int32Array(this.capacity);
    this.foodCells = new Uint8Array(this.capacity);
    this.randomInt = randomInt;
    this.freeCells = new Int32Array(this.capacity);
    this.spawnSlots = new Int32Array(SLOT_COUNT);
    this.targets = new Int32Array(SLOT_COUNT);

    const snakes: Snake[] = [];
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      snakes.push(new Snake(slot, this.capacity));
    }
    this.snakes = snakes;

    this.foodPool = createPool<Food>(
      () => ({ x: 0, y: 0 }),
      (food) => {
        food.x = 0;
        food.y = 0;
      },
      foodCount,
    );

    this.reset();
  }

  get participantMask(): number {
    return this.participantMaskValue;
  }

  get participantCount(): number {
    return this.participantCountValue;
  }

  get aliveCount(): number {
    return this.aliveCountValue;
  }

  get wallInset(): number {
    return this.insetValue;
  }

  get elapsedMs(): number {
    return this.elapsedValue;
  }

  get stepCount(): number {
    return this.stepCountValue;
  }

  get activeFoodCount(): number {
    return this.activeFoodCountValue;
  }

  get shrinkRemainingMs(): number {
    const remaining = this.nextShrinkAt - this.elapsedValue;
    return remaining > 0 ? remaining : 0;
  }

  cellIndex(x: number, y: number): number {
    return y * this.gridSize + x;
  }

  cellX(index: number): number {
    return index % this.gridSize;
  }

  cellY(index: number): number {
    return (index / this.gridSize) | 0;
  }

  foodX(index: number): number {
    return this.activeFoods[index]?.x ?? 0;
  }

  foodY(index: number): number {
    return this.activeFoods[index]?.y ?? 0;
  }

  participates(slot: number): boolean {
    return (this.participantMaskValue & (1 << slot)) !== 0;
  }

  /** Clears the board, timers and snakes; food is not refilled here. */
  reset(): void {
    this.walls.fill(0);
    this.occupancy.fill(0);
    this.foodCells.fill(0);
    this.foodPool.clear();
    this.activeFoods.length = 0;
    this.activeFoodCountValue = 0;
    for (let index = 0; index < this.snakes.length; index += 1) {
      this.snakes[index]?.reset();
    }
    this.participantMaskValue = 0;
    this.participantCountValue = 0;
    this.aliveCountValue = 0;
    this.insetValue = 0;
    this.elapsedValue = 0;
    this.nextShrinkAt = this.shrinkEveryMs;
    this.accumulator = 0;
    this.stepCountValue = 0;
    this.targets.fill(TARGET_NONE);
  }

  /**
   * Starts a round: spawns one snake per set bit on a spaced ring, then fills
   * food only on cells no snake occupies (GAME-SR-DATA-02).
   */
  startRound(rosterMask: number): void {
    this.reset();
    let count = 0;
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      if ((rosterMask & (1 << slot)) !== 0) {
        this.spawnSlots[count] = slot;
        count += 1;
      }
    }
    for (let order = 0; order < count; order += 1) {
      const slot = this.spawnSlots[order] ?? 0;
      if (slot >= 1) {
        this.spawnRingSnake(slot, order, count);
      }
    }
    this.refreshCounts();
    this.refillFood();
  }

  /**
   * Places a straight snake at `(x, y)` with its body opposite `direction`;
   * returns false when any cell would overlap a wall or another snake.
   */
  spawnSnakeAt(
    slot: number,
    x: number,
    y: number,
    direction: Direction,
    length = this.initialLength,
  ): boolean {
    const placed = this.placeStraightSnake(slot, x, y, direction, length);
    if (placed) this.refreshCounts();
    return placed;
  }

  /**
   * Places an explicit cell list (test and spawn support). Cells are ordered
   * head first; walls and foreign snakes are rejected with a RangeError.
   */
  placeSnake(slot: number, cellList: readonly number[], direction: Direction): Snake {
    const snake = this.snakes[slot - 1];
    if (snake === undefined) {
      throw new RangeError(`slot must be an integer in 1..${SLOT_COUNT}.`);
    }
    if (cellList.length === 0) {
      throw new RangeError("a snake needs at least one cell.");
    }
    const capacity = this.capacity;
    for (let index = 0; index < cellList.length; index += 1) {
      const cell = cellList[index] ?? -1;
      if (!Number.isInteger(cell) || cell < 0 || cell >= capacity) {
        throw new RangeError(`cell ${cell} is outside the grid.`);
      }
      if (this.walls[cell] === 1) {
        throw new RangeError(`cell ${cell} is a wall.`);
      }
      const owner = this.occupancy[cell] ?? 0;
      if (owner !== 0 && owner !== slot) {
        throw new RangeError(`cell ${cell} is occupied by slot ${owner}.`);
      }
      for (let other = 0; other < index; other += 1) {
        if (cellList[other] === cell) {
          throw new RangeError(`cell ${cell} is repeated.`);
        }
      }
    }

    this.clearSnakeCells(snake);
    snake.participating = true;
    snake.alive = true;
    snake.connected = true;
    snake.direction = direction;
    snake.turn = -1;
    snake.length = cellList.length;
    snake.prevLength = cellList.length;
    snake.foodEaten = 0;
    snake.disconnectedMs = 0;
    for (let index = 0; index < cellList.length; index += 1) {
      const cell = cellList[index] ?? 0;
      snake.cells[index] = cell;
      snake.prevCells[index] = cell;
      this.occupancy[cell] = slot;
    }
    this.refreshCounts();
    return snake;
  }

  /** Adds one food object at a free cell; false when the cell is not free. */
  placeFoodAt(x: number, y: number): boolean {
    if (x < 0 || x >= this.gridSize || y < 0 || y >= this.gridSize) {
      return false;
    }
    const cell = this.cellIndex(x, y);
    if (this.walls[cell] === 1 || (this.occupancy[cell] ?? 0) !== 0 || this.foodCells[cell] === 1) {
      return false;
    }
    if (this.activeFoodCountValue >= this.foodCount) {
      return false;
    }
    const food = this.foodPool.acquire();
    food.x = x;
    food.y = y;
    this.foodCells[cell] = 1;
    this.activeFoods[this.activeFoodCountValue] = food;
    this.activeFoodCountValue += 1;
    return true;
  }

  /** Removes every food object; used by tests and round resets. */
  clearFood(): void {
    this.foodPool.clear();
    this.foodCells.fill(0);
    this.activeFoods.length = 0;
    this.activeFoodCountValue = 0;
  }

  /**
   * Queues a turn for the next step. Opposite reversals and repeated
   * directions are ignored (GAME-SR-CTRL-02).
   */
  queueTurn(slot: number, direction: Direction): boolean {
    const snake = this.snakes[slot - 1];
    if (snake === undefined || !snake.alive || !snake.connected) return false;
    if (!isDirection(direction) || direction === snake.direction) return false;
    if (direction === oppositeDirection(snake.direction)) return false;
    snake.turn = direction;
    return true;
  }

  /**
   * Updates a participant's connection state. A reconnection inside the
   * grace window cancels removal; a dead snake is never revived mid-round.
   */
  setConnected(slot: number, connected: boolean): void {
    const snake = this.snakes[slot - 1];
    if (snake === undefined || !snake.participating) return;
    if (snake.connected === connected) return;
    snake.connected = connected;
    if (connected) {
      snake.disconnectedMs = 0;
    }
  }

  /**
   * Advances real time: shrink rings on schedule, then run every whole logic
   * step. The host calls this once per fixed tick with its 16.7 ms delta.
   */
  update(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return;
    this.elapsedValue += dtMs;
    while (this.elapsedValue >= this.nextShrinkAt) {
      this.shrink();
      this.nextShrinkAt += this.shrinkEveryMs;
    }
    this.accumulator += dtMs;
    while (this.accumulator >= this.stepIntervalMs) {
      this.accumulator -= this.stepIntervalMs;
      this.step();
    }
  }

  /**
   * One simultaneous logic step (GAME-SR-HOST-02). Turns apply first, then
   * every alive snake's target is collected before any snake moves.
   */
  step(): void {
    if (this.aliveCountValue === 0) return;
    this.stepCountValue += 1;

    // Grace removal happens before movement; a reconnect in the same tick
    // reaches setConnected before update and cancels it.
    for (let index = 0; index < this.snakes.length; index += 1) {
      const snake = this.snakes[index];
      if (snake === undefined || !snake.alive || snake.connected) continue;
      snake.disconnectedMs += this.stepIntervalMs;
      if (snake.disconnectedMs >= this.respawnGraceMs) {
        this.eliminate(snake);
      }
    }
    if (this.aliveCountValue === 0) {
      this.rebuildOccupancy();
      return;
    }

    for (let index = 0; index < this.snakes.length; index += 1) {
      const snake = this.snakes[index];
      if (snake === undefined || !snake.alive) continue;
      const queued = snake.turn;
      if (queued !== -1 && queued !== oppositeDirection(snake.direction)) {
        snake.direction = queued;
      }
      snake.turn = -1;
      snake.prevLength = snake.length;
      snake.prevCells.set(snake.cells);
    }

    const targets = this.targets;
    targets.fill(TARGET_NONE);
    for (let index = 0; index < this.snakes.length; index += 1) {
      const snake = this.snakes[index];
      if (snake === undefined || !snake.alive) continue;
      const head = snake.cells[0] ?? 0;
      const direction = snake.direction;
      const nextX = (head % this.gridSize) + (DIRECTION_DX[direction] ?? 0);
      const nextY = ((head / this.gridSize) | 0) + (DIRECTION_DY[direction] ?? 0);
      if (nextX < 0 || nextX >= this.gridSize || nextY < 0 || nextY >= this.gridSize) {
        targets[index] = TARGET_OUT;
      } else {
        targets[index] = nextY * this.gridSize + nextX;
      }
    }

    let deathMask = 0;
    for (let index = 0; index < this.snakes.length; index += 1) {
      const snake = this.snakes[index];
      if (snake === undefined || !snake.alive) continue;
      const target = targets[index] ?? TARGET_NONE;
      if (target === TARGET_OUT || this.walls[target] === 1) {
        deathMask |= 1 << index;
      }
    }
    for (let index = 0; index < this.snakes.length; index += 1) {
      const snake = this.snakes[index];
      if (snake === undefined || !snake.alive) continue;
      const target = targets[index] ?? TARGET_NONE;
      if (target < 0) continue;
      for (let other = index + 1; other < this.snakes.length; other += 1) {
        const rival = this.snakes[other];
        if (rival === undefined || !rival.alive) continue;
        if (targets[other] === target) {
          deathMask |= 1 << index;
          deathMask |= 1 << other;
        }
      }
    }
    for (let index = 0; index < this.snakes.length; index += 1) {
      const snake = this.snakes[index];
      if (snake === undefined || !snake.alive) continue;
      if ((deathMask & (1 << index)) !== 0) continue;
      if (this.isBodyBlocked(targets[index] ?? TARGET_NONE, deathMask)) {
        deathMask |= 1 << index;
      }
    }

    for (let index = 0; index < this.snakes.length; index += 1) {
      const snake = this.snakes[index];
      if (snake === undefined || !snake.alive) continue;
      if ((deathMask & (1 << index)) !== 0) {
        this.eliminate(snake);
      }
    }

    for (let index = 0; index < this.snakes.length; index += 1) {
      const snake = this.snakes[index];
      if (snake === undefined || !snake.alive) continue;
      const target = targets[index] ?? TARGET_NONE;
      if (target < 0) continue;
      if (this.foodCells[target] === 1) {
        if (snake.length < this.capacity) {
          snake.cells.copyWithin(1, 0, snake.length);
          snake.cells[0] = target;
          snake.length += 1;
          snake.foodEaten += 1;
          this.removeFoodAt(target);
        }
      } else {
        if (snake.length > 1) {
          snake.cells.copyWithin(1, 0, snake.length - 1);
        }
        snake.cells[0] = target;
      }
    }

    this.rebuildOccupancy();
    this.refillFood();
  }

  /**
   * Walls the next outer ring, removes food on it and eliminates every snake
   * occupying a removed cell (GAME-SR-HOST-03). Stops at a 2x2 arena.
   */
  shrink(): void {
    if (this.insetValue >= this.maxInset) return;
    const ring = this.insetValue;
    const far = this.gridSize - 1 - ring;
    for (let x = 0; x < this.gridSize; x += 1) {
      this.walls[this.cellIndex(x, ring)] = 1;
      this.walls[this.cellIndex(x, far)] = 1;
    }
    for (let y = 0; y < this.gridSize; y += 1) {
      this.walls[this.cellIndex(ring, y)] = 1;
      this.walls[this.cellIndex(far, y)] = 1;
    }
    this.insetValue = ring + 1;

    for (let index = this.activeFoodCountValue - 1; index >= 0; index -= 1) {
      const food = this.activeFoods[index];
      if (food === undefined) continue;
      const cell = this.cellIndex(food.x, food.y);
      if (this.walls[cell] === 1) {
        this.removeFoodAtIndex(index);
      }
    }

    for (let index = 0; index < this.snakes.length; index += 1) {
      const snake = this.snakes[index];
      if (snake === undefined || !snake.alive) continue;
      for (let segment = 0; segment < snake.length; segment += 1) {
        const cell = snake.cells[segment] ?? 0;
        if (this.walls[cell] === 1) {
          this.eliminate(snake);
          break;
        }
      }
    }

    this.rebuildOccupancy();
    this.refillFood();
  }

  /** Latest slot alive after a round, or null for zero or several survivors. */
  winnerSlot(): number | null {
    if (this.aliveCountValue !== 1) return null;
    for (let index = 0; index < this.snakes.length; index += 1) {
      const snake = this.snakes[index];
      if (snake !== undefined && snake.alive) return snake.slot;
    }
    return null;
  }

  /** Rebuilds `occupancy` from every alive snake; no allocation. */
  rebuildOccupancy(): void {
    this.occupancy.fill(0);
    for (let index = 0; index < this.snakes.length; index += 1) {
      const snake = this.snakes[index];
      if (snake === undefined || !snake.alive) continue;
      for (let segment = 0; segment < snake.length; segment += 1) {
        const cell = snake.cells[segment] ?? 0;
        this.occupancy[cell] = snake.slot;
      }
    }
  }

  /**
   * Interpolation factor for the current display frame (GAME-SR-HOST-04,
   * FR-9.1). `alpha` is the host loop's fraction of the 16.7 ms tick; adding
   * the in-step accumulator maps it onto the 125 ms logic step.
   */
  renderBlend(alpha: number): number {
    const safeAlpha = Number.isFinite(alpha)
      ? alpha < 0
        ? 0
        : alpha > 1
          ? 1
          : alpha
      : 0;
    const intoStep = this.accumulator + safeAlpha * HOST_TICK_MS;
    const blend = intoStep / this.stepIntervalMs;
    return blend < 0 ? 0 : blend > 1 ? 1 : blend;
  }

  private spawnRingSnake(slot: number, order: number, count: number): void {
    if (count <= 0) return;
    const gridSize = this.gridSize;
    const center = (gridSize - 1) / 2;
    const baseAngle = -Math.PI / 2 + (2 * Math.PI * order) / count;
    const baseRadius = Math.max(2, Math.round(gridSize * 0.32));
    const radii = [
      baseRadius,
      Math.max(2, baseRadius - 2),
      Math.min(gridSize - 3, baseRadius + 2),
      Math.max(2, Math.round(gridSize * 0.2)),
    ];
    const offsets = [0, 0.32, -0.32, 0.64, -0.64];

    for (let radiusIndex = 0; radiusIndex < radii.length; radiusIndex += 1) {
      const radius = radii[radiusIndex] ?? baseRadius;
      for (let offsetIndex = 0; offsetIndex < offsets.length; offsetIndex += 1) {
        const angle = baseAngle + (offsets[offsetIndex] ?? 0);
        const x = Math.round(center + Math.cos(angle) * radius);
        const y = Math.round(center + Math.sin(angle) * radius);
        const tangentX = -Math.sin(angle);
        const tangentY = Math.cos(angle);
        const direction: Direction =
          Math.abs(tangentX) >= Math.abs(tangentY)
            ? tangentX >= 0
              ? 1
              : 3
            : tangentY >= 0
              ? 2
              : 0;
        if (this.placeStraightSnake(slot, x, y, direction, this.initialLength)) {
          return;
        }
      }
    }

    // Deterministic fallback: first free row-major cell with any safe body.
    for (let y = 1; y < gridSize - 1; y += 1) {
      for (let x = 1; x < gridSize - 1; x += 1) {
        for (let direction = 0; direction < 4; direction += 1) {
          if (
            this.placeStraightSnake(
              slot,
              x,
              y,
              direction as Direction,
              this.initialLength,
            )
          ) {
            return;
          }
        }
      }
    }
  }

  private placeStraightSnake(
    slot: number,
    x: number,
    y: number,
    direction: Direction,
    length: number,
  ): boolean {
    const snake = this.snakes[slot - 1];
    if (snake === undefined || length < 1) return false;
    const gridSize = this.gridSize;
    const dx = DIRECTION_DX[direction] ?? 0;
    const dy = DIRECTION_DY[direction] ?? 0;

    for (let segment = 0; segment < length; segment += 1) {
      const cellX = x - dx * segment;
      const cellY = y - dy * segment;
      if (cellX < 0 || cellX >= gridSize || cellY < 0 || cellY >= gridSize) {
        return false;
      }
      const cell = this.cellIndex(cellX, cellY);
      if (this.walls[cell] === 1 || (this.occupancy[cell] ?? 0) !== 0) {
        return false;
      }
    }

    this.clearSnakeCells(snake);
    snake.participating = true;
    snake.alive = true;
    snake.connected = true;
    snake.direction = direction;
    snake.turn = -1;
    snake.length = length;
    snake.prevLength = length;
    snake.foodEaten = 0;
    snake.disconnectedMs = 0;
    for (let segment = 0; segment < length; segment += 1) {
      const cell = this.cellIndex(x - dx * segment, y - dy * segment);
      snake.cells[segment] = cell;
      snake.prevCells[segment] = cell;
      this.occupancy[cell] = slot;
    }
    return true;
  }

  private clearSnakeCells(snake: Snake): void {
    for (let segment = 0; segment < snake.length; segment += 1) {
      const cell = snake.cells[segment] ?? 0;
      if ((this.occupancy[cell] ?? 0) === snake.slot) {
        this.occupancy[cell] = 0;
      }
    }
  }

  private eliminate(snake: Snake): void {
    if (!snake.alive) return;
    snake.alive = false;
    snake.turn = -1;
    this.aliveCountValue -= 1;
  }

  private isBodyBlocked(target: number, deathMask: number): boolean {
    if (target < 0) return false;
    const owner = this.occupancy[target] ?? 0;
    if (owner === 0) return false;
    const other = this.snakes[owner - 1];
    if (other === undefined || !other.alive) return false;
    // A snake that already died this step does not move, so its tail stays.
    if ((deathMask & (1 << (owner - 1))) !== 0) return true;

    const tail = other.cells[other.length - 1] ?? -1;
    if (target === tail) {
      const otherTarget = this.targets[owner - 1] ?? TARGET_NONE;
      const grows = otherTarget >= 0 && this.foodCells[otherTarget] === 1;
      if (!grows) return false;
    }
    return true;
  }

  private refillFood(): void {
    while (this.activeFoodCountValue < this.foodCount) {
      if (!this.spawnOneFood()) return;
    }
  }

  private spawnOneFood(): boolean {
    let free = 0;
    const freeCells = this.freeCells;
    for (let cell = 0; cell < this.capacity; cell += 1) {
      if (
        this.walls[cell] === 0 &&
        (this.occupancy[cell] ?? 0) === 0 &&
        this.foodCells[cell] === 0
      ) {
        freeCells[free] = cell;
        free += 1;
      }
    }
    if (free === 0) return false;

    const rawPick = this.randomInt(0, free - 1);
    const pick = Number.isFinite(rawPick)
      ? Math.min(free - 1, Math.max(0, Math.trunc(rawPick)))
      : 0;
    const cell = freeCells[pick] ?? 0;
    const food = this.foodPool.acquire();
    food.x = cell % this.gridSize;
    food.y = (cell / this.gridSize) | 0;
    this.foodCells[cell] = 1;
    this.activeFoods[this.activeFoodCountValue] = food;
    this.activeFoodCountValue += 1;
    return true;
  }

  private removeFoodAt(cell: number): void {
    for (let index = 0; index < this.activeFoodCountValue; index += 1) {
      const food = this.activeFoods[index];
      if (food === undefined) continue;
      if (this.cellIndex(food.x, food.y) === cell) {
        this.removeFoodAtIndex(index);
        return;
      }
    }
  }

  private removeFoodAtIndex(index: number): void {
    const food = this.activeFoods[index];
    if (food === undefined) return;
    this.foodCells[this.cellIndex(food.x, food.y)] = 0;
    this.foodPool.release(food);
    this.activeFoodCountValue -= 1;
    const last = this.activeFoods[this.activeFoodCountValue];
    if (index !== this.activeFoodCountValue && last !== undefined) {
      this.activeFoods[index] = last;
    }
    this.activeFoods.length = this.activeFoodCountValue;
  }

  private refreshCounts(): void {
    let participants = 0;
    let alive = 0;
    let mask = 0;
    for (let index = 0; index < this.snakes.length; index += 1) {
      const snake = this.snakes[index];
      if (snake === undefined || !snake.participating) continue;
      participants += 1;
      mask |= 1 << snake.slot;
      if (snake.alive) alive += 1;
    }
    this.participantCountValue = participants;
    this.aliveCountValue = alive;
    this.participantMaskValue = mask;
  }
}
