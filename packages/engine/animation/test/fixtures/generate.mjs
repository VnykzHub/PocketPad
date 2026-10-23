#!/usr/bin/env node
/**
 * Deterministic fixture generator for spec 08 (ER-08-02..ER-08-05, ER-08-10).
 *
 * Run: node packages/engine/animation/test/fixtures/generate.mjs
 *
 * The fixtures are synthetic: a 24-joint rig, analytic walk/run clips, an
 * event clip, a root-motion walk, a seam-authored loop and an 8-target morph
 * clip. Golden joint positions are produced by an independent scalar
 * implementation of §5.4/§5.5 so the TypeScript sampler is checked against a
 * second implementation, not itself.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
const TAU = Math.PI * 2;
const DT = 1 / 60;

// ---------------------------------------------------------------- mat4 (f64)

function mat4Compose(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const m = new Float64Array(16);
  m[0] = (1 - (yy + zz)) * s[0];
  m[1] = (xy + wz) * s[0];
  m[2] = (xz - wy) * s[0];
  m[4] = (xy - wz) * s[1];
  m[5] = (1 - (xx + zz)) * s[1];
  m[6] = (yz + wx) * s[1];
  m[8] = (xz + wy) * s[2];
  m[9] = (yz - wx) * s[2];
  m[10] = (1 - (xx + yy)) * s[2];
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

function mat4Multiply(a, b) {
  const m = new Float64Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + row] * b[column * 4 + k];
      }
      m[column * 4 + row] = sum;
    }
  }
  return m;
}

function mat4Invert(a) {
  const m = new Float64Array(16);
  const a00 = a[0];
  const a01 = a[1];
  const a02 = a[2];
  const a03 = a[3];
  const a10 = a[4];
  const a11 = a[5];
  const a12 = a[6];
  const a13 = a[7];
  const a20 = a[8];
  const a21 = a[9];
  const a22 = a[10];
  const a23 = a[11];
  const a30 = a[12];
  const a31 = a[13];
  const a32 = a[14];
  const a33 = a[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0) throw new Error("matrix is not invertible");
  det = 1 / det;
  m[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  m[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  m[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  m[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  m[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  m[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  m[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  m[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  m[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  m[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  m[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  m[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  m[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  m[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  m[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  m[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return m;
}

// --------------------------------------------------------------------- rig

const JOINT_NAMES = [
  "pelvis",
  "spine",
  "chest",
  "neck",
  "head",
  "leftUpperArm",
  "leftForearm",
  "leftHand",
  "leftFinger",
  "rightUpperArm",
  "rightForearm",
  "rightHand",
  "rightFinger",
  "leftThigh",
  "leftShin",
  "leftFoot",
  "leftToe",
  "rightThigh",
  "rightShin",
  "rightFoot",
  "rightToe",
  "leftShoulder",
  "rightShoulder",
  "headTip",
];

const PARENTS = [
  -1, 0, 1, 2, 3, 2, 5, 6, 7, 2, 9, 10, 11, 0, 13, 14, 15, 0, 17, 18, 19, 2,
  2, 4,
];

const REST_T = [
  0, 1, 0,
  0, 0.2, 0,
  0, 0.2, 0,
  0, 0.15, 0,
  0, 0.15, 0,
  -0.18, 0.1, 0,
  -0.25, 0, 0,
  -0.25, 0, 0,
  -0.1, 0, 0,
  0.18, 0.1, 0,
  0.25, 0, 0,
  0.25, 0, 0,
  0.1, 0, 0,
  -0.1, -0.1, 0,
  0, -0.4, 0,
  0, -0.4, 0.05,
  0, -0.05, 0.12,
  0.1, -0.1, 0,
  0, -0.4, 0,
  0, -0.4, 0.05,
  0, -0.05, 0.12,
  -0.1, 0.12, 0,
  0.1, 0.12, 0,
  0, 0.2, 0,
];

const JOINT_COUNT = JOINT_NAMES.length;
const REST_R = [];
for (let i = 0; i < JOINT_COUNT; i += 1) REST_R.push(0, 0, 0, 1);
const REST_S = [];
for (let i = 0; i < JOINT_COUNT; i += 1) REST_S.push(1, 1, 1);

function restWorld() {
  const worlds = new Array(JOINT_COUNT);
  for (let joint = 0; joint < JOINT_COUNT; joint += 1) {
    const local = mat4Compose(
      [REST_T[joint * 3], REST_T[joint * 3 + 1], REST_T[joint * 3 + 2]],
      [
        REST_R[joint * 4],
        REST_R[joint * 4 + 1],
        REST_R[joint * 4 + 2],
        REST_R[joint * 4 + 3],
      ],
      [REST_S[joint * 3], REST_S[joint * 3 + 1], REST_S[joint * 3 + 2]],
    );
    const parent = PARENTS[joint];
    worlds[joint] = parent < 0 ? local : mat4Multiply(worlds[parent], local);
  }
  return worlds;
}

const rest = restWorld();
const inverseBindMatrices = [];
for (let joint = 0; joint < JOINT_COUNT; joint += 1) {
  const inverse = mat4Invert(rest[joint]);
  for (let i = 0; i < 16; i += 1) inverseBindMatrices.push(inverse[i]);
}

const skeleton = {
  id: "rig-24",
  jointNames: JOINT_NAMES,
  parents: PARENTS,
  inverseBindMatrices,
  restTranslations: REST_T,
  restRotations: REST_R,
  restScales: REST_S,
  rootJoint: 0,
};

// ------------------------------------------------------------------- clips

function yawQuat(radians) {
  return [0, Math.sin(radians / 2), 0, Math.cos(radians / 2)];
}

function axisQuat(x, y, z, radians) {
  const half = radians / 2;
  const s = Math.sin(half);
  return [x * s, y * s, z * s, Math.cos(half)];
}

function keyTimes(duration, keyCount) {
  const times = [];
  for (let i = 0; i < keyCount; i += 1) {
    times.push((duration * i) / (keyCount - 1));
  }
  return times;
}

function makeTrack(target, path, interpolation, times, values) {
  return { target, path, interpolation, times, values };
}

function cyclicTrack(target, path, duration, keyCount, fn) {
  const times = keyTimes(duration, keyCount);
  const values = [];
  for (let i = 0; i < times.length; i += 1) {
    for (const component of fn(times[i])) values.push(component);
  }
  return makeTrack(target, path, "linear", times, values);
}

function walkTracks(duration, amplitude, cycles) {
  const phase = (t) => TAU * cycles * (t / duration);
  return [
    cyclicTrack(0, "translation", duration, 17, (t) => [
      0.06 * amplitude * Math.sin(phase(t)),
      0,
      0.01 * amplitude * Math.cos(phase(t)),
    ]),
    cyclicTrack(1, "rotation", duration, 17, (t) =>
      axisQuat(0, 0, 1, 0.15 * amplitude * Math.sin(phase(t))),
    ),
    cyclicTrack(5, "rotation", duration, 17, (t) =>
      axisQuat(1, 0, 0, 0.5 * amplitude * Math.sin(phase(t))),
    ),
    cyclicTrack(9, "rotation", duration, 17, (t) =>
      axisQuat(1, 0, 0, -0.5 * amplitude * Math.sin(phase(t))),
    ),
    cyclicTrack(13, "rotation", duration, 17, (t) =>
      axisQuat(1, 0, 0, 0.6 * amplitude * Math.sin(phase(t))),
    ),
    cyclicTrack(17, "rotation", duration, 17, (t) =>
      axisQuat(1, 0, 0, -0.6 * amplitude * Math.sin(phase(t))),
    ),
    cyclicTrack(14, "rotation", duration, 17, (t) =>
      axisQuat(1, 0, 0, 0.4 * amplitude * (1 - Math.cos(phase(t))) * 0.5),
    ),
    cyclicTrack(18, "rotation", duration, 17, (t) =>
      axisQuat(1, 0, 0, 0.4 * amplitude * (1 - Math.cos(phase(t))) * 0.5),
    ),
    cyclicTrack(2, "scale", duration, 9, (t) => {
      const k = 1 + 0.02 * Math.sin(phase(t));
      return [k, k, k];
    }),
    // Step interpolation fixture: a clearly visible discrete head tilt.
    makeTrack(
      23,
      "rotation",
      "step",
      [0, duration / 2, duration],
      [
        ...axisQuat(0, 1, 0, 0),
        ...axisQuat(0, 1, 0, 0.2),
        ...axisQuat(0, 1, 0, 0),
      ],
    ),
  ];
}

const walk = {
  name: "walk-1.0",
  skeletonId: "rig-24",
  duration: 1,
  tracks: walkTracks(1, 1, 1),
  events: [],
  rootJoint: 0,
  loop: "repeat",
};

const run = {
  name: "run-0.6",
  skeletonId: "rig-24",
  // Key times are f32; declare the duration as the same f32 so the endpoint
  // key is not rejected as out of range by compileClip.
  duration: Math.fround(0.6),
  tracks: walkTracks(0.6, 2, 1.5),
  events: [],
  rootJoint: 0,
  loop: "repeat",
};

const eventsLoop = {
  name: "events-loop",
  skeletonId: "rig-24",
  duration: 1,
  tracks: [cyclicTrack(0, "translation", 1, 5, () => [0, 0, 0])],
  events: [
    { time: 0.1, name: "beat.one", payload: 1 },
    { time: 0.4, name: "beat.two", payload: 2 },
    { time: 0.7, name: "beat.three", payload: 3 },
    { time: 0.95, name: "beat.four", payload: 4 },
  ],
  rootJoint: -1,
  loop: "repeat",
};

const rootmotionWalk = {
  name: "rootmotion-walk",
  skeletonId: "rig-24",
  duration: 10,
  tracks: [
    makeTrack(
      0,
      "translation",
      "linear",
      Array.from({ length: 11 }, (_, i) => i),
      Array.from({ length: 11 }, (_, i) => [0, 1, 0.8 * i]).flat(),
    ),
    makeTrack(
      0,
      "rotation",
      "linear",
      Array.from({ length: 11 }, (_, i) => i),
      Array.from({ length: 11 }, (_, i) => yawQuat((9 * i * Math.PI) / 180)).flat(),
    ),
    cyclicTrack(13, "rotation", 10, 21, (t) =>
      axisQuat(1, 0, 0, 0.3 * Math.sin((TAU * t) / 2)),
    ),
  ],
  events: [],
  rootJoint: 0,
  loop: "repeat",
};

const seamLoop = {
  name: "seam-loop",
  skeletonId: "rig-24",
  duration: 1,
  tracks: [
    makeTrack(
      0,
      "translation",
      "linear",
      Array.from({ length: 21 }, (_, i) => i * 0.05),
      Array.from({ length: 21 }, (_, i) => {
        const t = i * 0.05;
        return [0.05 * (1 - Math.cos(TAU * t)), 1, 0];
      }).flat(),
    ),
    makeTrack(
      0,
      "rotation",
      "linear",
      Array.from({ length: 21 }, (_, i) => i * 0.05),
      Array.from({ length: 21 }, (_, i) =>
        yawQuat(0.2 * Math.sin(TAU * i * 0.05)),
      ).flat(),
    ),
  ],
  events: [],
  rootJoint: 0,
  loop: "repeat",
};

const morph8 = {
  name: "morph-8",
  skeletonId: "rig-24",
  duration: 1,
  tracks: [
    ...Array.from({ length: 8 }, (_, i) =>
      makeTrack(i, "weights", "linear", [0, 1], [i / 7, 1 - i / 7]),
    ),
    cyclicTrack(0, "translation", 1, 2, () => [0, 1, 0]),
  ],
  events: [],
  rootJoint: -1,
  loop: "repeat",
};

// ---------------------------------------------------------------- goldens

function findKeyIndex(times, time) {
  if (time <= times[0]) return 0;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function sampleTrack(track, time) {
  const stride = track.path === "rotation" ? 4 : 3;
  const times = track.times;
  const index = findKeyIndex(times, time);
  const out = [];
  if (index >= times.length - 1) {
    const base = index * stride;
    for (let i = 0; i < stride; i += 1) out.push(track.values[base + i]);
    return out;
  }
  if (track.interpolation === "step" || times[index] === time) {
    const base = index * stride;
    for (let i = 0; i < stride; i += 1) out.push(track.values[base + i]);
    return out;
  }
  const base = index * stride;
  const next = (index + 1) * stride;
  const t = (time - times[index]) / (times[index + 1] - times[index]);
  if (track.path === "rotation") {
    const ax = track.values[base];
    const ay = track.values[base + 1];
    const az = track.values[base + 2];
    const aw = track.values[base + 3];
    let bx = track.values[next];
    let by = track.values[next + 1];
    let bz = track.values[next + 2];
    let bw = track.values[next + 3];
    if (ax * bx + ay * by + az * bz + aw * bw < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    let x = ax + (bx - ax) * t;
    let y = ay + (by - ay) * t;
    let z = az + (bz - az) * t;
    let w = aw + (bw - aw) * t;
    const norm = Math.hypot(x, y, z, w) || 1;
    out.push(x / norm, y / norm, z / norm, w / norm);
    return out;
  }
  for (let i = 0; i < stride; i += 1) {
    const a = track.values[base + i];
    const b = track.values[next + i];
    out.push(a + (b - a) * t);
  }
  return out;
}

function samplePose(clip, time) {
  const t = new Float64Array(JOINT_COUNT * 3);
  const r = new Float64Array(JOINT_COUNT * 4);
  const s = new Float64Array(JOINT_COUNT * 3);
  t.set(REST_T);
  r.set(REST_R);
  s.set(REST_S);
  for (const track of clip.tracks) {
    if (track.path === "weights") continue;
    const values = sampleTrack(track, time);
    if (track.path === "translation") {
      for (let i = 0; i < 3; i += 1) t[track.target * 3 + i] = values[i];
    } else if (track.path === "rotation") {
      for (let i = 0; i < 4; i += 1) r[track.target * 4 + i] = values[i];
    } else {
      for (let i = 0; i < 3; i += 1) s[track.target * 3 + i] = values[i];
    }
  }
  return { t, r, s };
}

function blendPoses(a, b, weightA, weightB) {
  const total = weightA + weightB;
  const fa = total > 0 ? weightA / total : 1;
  const fb = total > 0 ? weightB / total : 0;
  const t = new Float64Array(JOINT_COUNT * 3);
  const r = new Float64Array(JOINT_COUNT * 4);
  const s = new Float64Array(JOINT_COUNT * 3);
  for (let joint = 0; joint < JOINT_COUNT; joint += 1) {
    for (let i = 0; i < 3; i += 1) {
      t[joint * 3 + i] = a.t[joint * 3 + i] * fa + b.t[joint * 3 + i] * fb;
      s[joint * 3 + i] = a.s[joint * 3 + i] * fa + b.s[joint * 3 + i] * fb;
    }
    const ax = a.r[joint * 4];
    const ay = a.r[joint * 4 + 1];
    const az = a.r[joint * 4 + 2];
    const aw = a.r[joint * 4 + 3];
    let bx = b.r[joint * 4];
    let by = b.r[joint * 4 + 1];
    let bz = b.r[joint * 4 + 2];
    let bw = b.r[joint * 4 + 3];
    if (ax * bx + ay * by + az * bz + aw * bw < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    let x = ax * fa + bx * fb;
    let y = ay * fa + by * fb;
    let z = az * fa + bz * fb;
    let w = aw * fa + bw * fb;
    const norm = Math.hypot(x, y, z, w) || 1;
    r[joint * 4] = x / norm;
    r[joint * 4 + 1] = y / norm;
    r[joint * 4 + 2] = z / norm;
    r[joint * 4 + 3] = w / norm;
  }
  return { t, r, s };
}

function worldPositions(pose) {
  const worlds = new Array(JOINT_COUNT);
  const out = [];
  for (let joint = 0; joint < JOINT_COUNT; joint += 1) {
    const local = mat4Compose(
      [pose.t[joint * 3], pose.t[joint * 3 + 1], pose.t[joint * 3 + 2]],
      [
        pose.r[joint * 4],
        pose.r[joint * 4 + 1],
        pose.r[joint * 4 + 2],
        pose.r[joint * 4 + 3],
      ],
      [pose.s[joint * 3], pose.s[joint * 3 + 1], pose.s[joint * 3 + 2]],
    );
    const parent = PARENTS[joint];
    worlds[joint] = parent < 0 ? local : mat4Multiply(worlds[parent], local);
    out.push(worlds[joint][12], worlds[joint][13], worlds[joint][14]);
  }
  return out;
}

function blendWeights(parameter) {
  if (parameter <= 0) return [1, 0];
  if (parameter >= 1) return [0, 1];
  return [1 - parameter, parameter];
}

const sampleTicks = new Set([0, 150, 300, 450, 600]);
const goldens = [];
const restPose = {
  t: Float64Array.from(REST_T),
  r: Float64Array.from(REST_R),
  s: Float64Array.from(REST_S),
};
let phase = 0;
if (sampleTicks.has(0)) {
  goldens.push({ tick: 0, parameter: 0, positions: worldPositions(restPose) });
}
for (let tick = 1; tick <= 600; tick += 1) {
  const parameter = tick / 600;
  const weights = blendWeights(parameter);
  let rate = 0;
  if (weights[0] > 0) rate += weights[0] / walk.duration;
  if (weights[1] > 0) rate += weights[1] / run.duration;
  phase += DT * rate;
  if (phase >= 1) phase -= Math.floor(phase);
  if (!sampleTicks.has(tick)) continue;
  const walkPose = samplePose(walk, phase * walk.duration);
  const runPose = samplePose(run, phase * run.duration);
  const blended = blendPoses(walkPose, runPose, weights[0], weights[1]);
  goldens.push({ tick, parameter, positions: worldPositions(blended) });
}

// ------------------------------------------------------------------- write

const files = {
  "rig-24.json": skeleton,
  "walk-1.0.json": walk,
  "run-0.6.json": run,
  "events-loop.json": eventsLoop,
  "rootmotion-walk.json": rootmotionWalk,
  "seam-loop.json": seamLoop,
  "morph-8.json": morph8,
  "golden-blend.json": { ticks: 600, jointCount: JOINT_COUNT, samples: goldens },
  "determinism-600.json": {
    ticks: 600,
    fixedStep: DT,
    instanceCount: 32,
    clips: ["walk-1.0", "run-0.6", "events-loop"],
    tree: {
      clips: ["walk-1.0", "run-0.6"],
      thresholds: [0, 1],
      syncPhase: true,
    },
    crossfades: [
      { tick: 120, clip: "run-0.6", fadeOutPreviousSeconds: 0.2 },
      { tick: 240, clip: "walk-1.0", fadeOutPreviousSeconds: 0.1 },
    ],
    speedChange: 1.25,
    fadeChange: 0.3,
  },
  "golden-events.json": {
    clip: "events-loop",
    loops: 3,
    events: [
      { time: 0.1, name: "beat.one", payload: 1 },
      { time: 0.4, name: "beat.two", payload: 2 },
      { time: 0.7, name: "beat.three", payload: 3 },
      { time: 0.95, name: "beat.four", payload: 4 },
    ],
  },
};

for (const [name, value] of Object.entries(files)) {
  writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
  process.stdout.write(`wrote ${name}\n`);
}
