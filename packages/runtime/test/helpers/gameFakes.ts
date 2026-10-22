/**
 * Shared fakes for the D3 game-host and acceptance tests: an injected
 * frame clock, a recording SDK renderer, a silent audio surface and an
 * InputFwd packet builder. No DOM, socket or real timer is used.
 */
import type { InputState } from "@lanpad/protocol";
import type { GameAudio, GameRenderer3D, Vec3 } from "@lanpad/sdk";

/** Drives `FixedLoop` deterministically: `step(ms)` fires one rAF. */
export class FakeFrames {
  nowMs = 1000;
  private pending: ((t: number) => void) | null = null;
  private nextId = 1;

  readonly now = (): number => this.nowMs;
  readonly raf = (cb: (t: number) => void): number => {
    this.pending = cb;
    return this.nextId++;
  };
  readonly cancel = (): void => {
    this.pending = null;
  };

  get scheduled(): boolean {
    return this.pending !== null;
  }

  step(ms: number): void {
    this.nowMs += ms;
    const cb = this.pending;
    this.pending = null;
    cb?.(this.nowMs);
  }

  run(frames: number, ms = 1000 / 60): void {
    for (let index = 0; index < frames; index += 1) this.step(ms);
  }
}

export class RecordingRenderer implements GameRenderer3D {
  readonly backend = "canvas2d" as const;
  drawCalls = 0;
  textureMemoryMB = 0;
  frames = 0;
  lastRotation = 0;
  lastSize = 0;
  lastColor = "";

  beginFrame(): void {
    this.frames += 1;
    this.drawCalls = 0;
  }
  endFrame(): void {}
  setCamera(): void {}
  drawCube(_position: Vec3, size: number, color: string, rotationY: number): void {
    this.drawCalls += 1;
    this.lastRotation = rotationY;
    this.lastSize = size;
    this.lastColor = color;
  }
}

export interface CountingAudio extends GameAudio {
  pauses: number;
  resumes: number;
  pause(): void;
  resume(): void;
}

export function silentAudio(): CountingAudio {
  return {
    pauses: 0,
    resumes: 0,
    playSfx(): void {},
    playMusic(): void {},
    stopMusic(): void {},
    now: () => 0,
    unlocked: false,
    latencyHint: "interactive",
    pause(): void {
      this.pauses += 1;
    },
    resume(): void {
      this.resumes += 1;
    },
  };
}

export function packet(overrides: Partial<InputState> = {}): InputState {
  return {
    tick: 1000,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    lt: 0,
    rt: 0,
    flags: 0,
    ...overrides,
  };
}
