/**
 * Tilt Maze Race ball simulation (GAME-TM-HOST-01/05; GAME-TM-DATA-02; C9).
 *
 * Every ball is allocated once for the eight protocol slots, and the step path
 * uses plain field reads, scalar arithmetic and collision queries against the
 * maze data. No arrays or objects are created per tick (PR-9.3).
 *
 * Physics, shared by gyro and stick because the game feeds one acceleration
 * per slot (GAME-TM-HOST-02):
 *
 *   v += (a - friction * v) * dt          linear damping, terminal a / friction
 *   |v| is capped at maxSpeed
 *   movement is split into sub-steps no longer than one ball radius
 *   x and y resolve separately against walls (slide along a wall)
 *
 * A wall contact stops that axis at the closest free fraction found by a short
 * binary search, so the ball rests flush instead of leaving a visible gap. The
 * speed cap keeps per-tick travel at ~6.3 maze units, and the radius-sized
 * sub-steps make tunnelling through a 16+ unit wall impossible; the world test
 * drives the ball into a wall at full speed to prove it.
 *
 * Finishes are recorded in slot order inside one step, so two balls reaching
 * the exit on the same tick produce a deterministic finish order. The game
 * ends the round on the first entry; the remaining order is the tie-break.
 *
 * A disconnected ball receives no acceleration but keeps its velocity and
 * coasts under friction; its position is never reset, so a reconnect resumes
 * from where it stopped (GAME-TM-HOST-05).
 */
import { exitRadius, SLOT_COUNT, type TiltMazeConfig } from "./config.js";
import { collides, reachesExit, startPointFor, type Maze } from "./maze.js";

/** One pooled ball, indexed by `slot - 1`. */
export class Ball {
  readonly slot: number;
  /** In the current race roster. */
  active = false;
  /** Controller present for the current tick; false lets the ball coast. */
  connected = false;
  x = 0;
  y = 0;
  /** Previous tick position, for render interpolation. */
  prevX = 0;
  prevY = 0;
  vx = 0;
  vy = 0;
  /** Acceleration written by the game for this tick. */
  ax = 0;
  ay = 0;
  finished = false;
  /** Race-relative finish time in milliseconds; -1 until finished. */
  finishMs = -1;
  /** 1-based finish rank; 0 while racing or when the round ended first. */
  finishRank = 0;

  constructor(slot: number) {
    this.slot = slot;
  }

  reset(): void {
    this.active = false;
    this.connected = false;
    this.x = 0;
    this.y = 0;
    this.prevX = 0;
    this.prevY = 0;
    this.vx = 0;
    this.vy = 0;
    this.ax = 0;
    this.ay = 0;
    this.finished = false;
    this.finishMs = -1;
    this.finishRank = 0;
  }

  /** Current speed in maze units per second; debug and tests only. */
  speed(): number {
    return Math.hypot(this.vx, this.vy);
  }
}

export class TiltMazeWorld {
  readonly maze: Maze;
  readonly config: TiltMazeConfig;
  readonly balls: readonly Ball[];

  private readonly finishSlots: number[] = [];
  private readonly exitTriggerRadius: number;
  private elapsedValue = 0;
  private stepCountValue = 0;

  constructor(maze: Maze, config: TiltMazeConfig) {
    this.maze = maze;
    this.config = config;
    this.exitTriggerRadius = exitRadius(config);
    const balls: Ball[] = [];
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      balls.push(new Ball(slot));
    }
    this.balls = balls;
  }

  /** Slots that reached the exit this round, in finish (slot-tiebreak) order. */
  get finishOrder(): readonly number[] {
    return this.finishSlots;
  }

  /** Race-relative simulation time, milliseconds. */
  get elapsedMs(): number {
    return this.elapsedValue;
  }

  get stepCount(): number {
    return this.stepCountValue;
  }

  get participantCount(): number {
    let count = 0;
    for (let index = 0; index < this.balls.length; index += 1) {
      if (this.balls[index]?.active === true) count += 1;
    }
    return count;
  }

  participates(slot: number): boolean {
    return this.balls[slot - 1]?.active === true;
  }

  ball(slot: number): Ball | undefined {
    return this.balls[slot - 1];
  }

  /** Clears every ball, timer and finish; used on lobby/teardown. */
  reset(): void {
    for (let index = 0; index < this.balls.length; index += 1) {
      this.balls[index]?.reset();
    }
    this.finishSlots.length = 0;
    this.elapsedValue = 0;
    this.stepCountValue = 0;
  }

  /**
   * Places every roster ball on its independent start point, facing zero
   * velocity. `rosterMask` uses bit N for slot N (the kit/match convention).
   */
  startRace(rosterMask: number): void {
    this.reset();
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      if ((rosterMask & (1 << slot)) === 0) continue;
      const ball = this.balls[slot - 1];
      if (ball === undefined) continue;
      const start = startPointFor(this.maze, slot);
      ball.active = true;
      ball.connected = true;
      ball.x = start.x;
      ball.y = start.y;
      ball.prevX = start.x;
      ball.prevY = start.y;
    }
  }

  /** Mirrors controller presence onto a roster ball. */
  setConnected(slot: number, connected: boolean): void {
    const ball = this.balls[slot - 1];
    if (ball === undefined || !ball.active) return;
    ball.connected = connected;
  }

  /** Writes this tick's acceleration for one slot; ignored outside the roster. */
  setAcceleration(slot: number, ax: number, ay: number): void {
    const ball = this.balls[slot - 1];
    if (ball === undefined || !ball.active) return;
    ball.ax = Number.isFinite(ax) ? ax : 0;
    ball.ay = Number.isFinite(ay) ? ay : 0;
  }

  /** One fixed simulation step; the host calls this once per 1/60 s tick. */
  step(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    this.elapsedValue += dtSeconds * 1000;
    this.stepCountValue += 1;

    const config = this.config;
    const radius = config.ballRadius;
    const maxSpeedSq = config.maxSpeed * config.maxSpeed;

    for (let index = 0; index < this.balls.length; index += 1) {
      const ball = this.balls[index];
      if (ball === undefined || !ball.active) continue;
      ball.prevX = ball.x;
      ball.prevY = ball.y;
      if (ball.finished) continue;

      const ax = ball.connected ? ball.ax : 0;
      const ay = ball.connected ? ball.ay : 0;
      ball.vx += (ax - config.friction * ball.vx) * dtSeconds;
      ball.vy += (ay - config.friction * ball.vy) * dtSeconds;

      const speedSq = ball.vx * ball.vx + ball.vy * ball.vy;
      if (speedSq > maxSpeedSq) {
        const scale = config.maxSpeed / Math.sqrt(speedSq);
        ball.vx *= scale;
        ball.vy *= scale;
      }

      const travel = Math.max(Math.abs(ball.vx), Math.abs(ball.vy)) * dtSeconds;
      const substeps = travel > radius ? Math.ceil(travel / radius) : 1;
      const stepX = (ball.vx * dtSeconds) / substeps;
      const stepY = (ball.vy * dtSeconds) / substeps;
      for (let sub = 0; sub < substeps; sub += 1) {
        this.moveAxis(ball, stepX, true);
        this.moveAxis(ball, stepY, false);
      }

      if (reachesExit(this.maze, ball.x, ball.y, this.exitTriggerRadius)) {
        ball.finished = true;
        ball.vx = 0;
        ball.vy = 0;
        ball.finishMs = this.elapsedValue;
        ball.finishRank = this.finishSlots.length + 1;
        this.finishSlots.push(ball.slot);
      }
    }
  }

  /**
   * Moves one axis and stops at the first wall contact. A free target moves
   * directly; otherwise a six-iteration search finds the largest free fraction
   * of the delta. The blocked velocity component is zeroed (not reflected).
   */
  private moveAxis(ball: Ball, delta: number, xAxis: boolean): void {
    if (delta === 0) return;
    const targetX = xAxis ? ball.x + delta : ball.x;
    const targetY = xAxis ? ball.y : ball.y + delta;
    if (!collides(this.maze, targetX, targetY, this.config.ballRadius)) {
      if (xAxis) ball.x = targetX;
      else ball.y = targetY;
      return;
    }

    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const mid = (low + high) / 2;
      const testX = xAxis ? ball.x + delta * mid : ball.x;
      const testY = xAxis ? ball.y : ball.y + delta * mid;
      if (collides(this.maze, testX, testY, this.config.ballRadius)) {
        high = mid;
      } else {
        low = mid;
      }
    }

    if (xAxis) {
      ball.x += delta * low;
      ball.vx = 0;
    } else {
      ball.y += delta * low;
      ball.vy = 0;
    }
  }
}
