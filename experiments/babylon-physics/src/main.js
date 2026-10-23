/**
 * Spike entry point. One page runs one engine, selected with `?engine=`.
 *
 * Everything a measurement needs is published on `window.__SPIKE__` and the
 * CDP runner polls `done`. No measurement lives only in the DOM: the status
 * line is for humans watching, the object is for the runner.
 */

import { createEngine, describeRenderer } from "./render.js";
import {
  buildBenchmarkWorld,
  buildShowcase,
  measureFrames,
  measurePhysicsSteps,
  runCarAcceleration,
  runCarProbe,
  runCarSlalom,
  runCharacterDrop,
  runCharacterStep,
  runCharacterWall,
  runDeterminism,
} from "./scenarios.js";

const params = new URLSearchParams(window.location.search);
const engineName = params.get("engine") === "rapier" ? "rapier" : "havok";
globalThis.__PHYSICS_DEBUG__ = params.get("probe") === "1";
const canvas = document.getElementById("stage");
const statusElement = document.getElementById("status");

const spike = {
  engine: engineName,
  status: "starting",
  done: false,
  error: null,
  errors: [],
  boot: {
    wasmInitMs: null,
    backendReportedInitMs: null,
    firstWorldMs: null,
    navigationToReadyMs: null,
  },
  environment: {},
  scenarios: {},
  probe: null,
  benchmark: null,
  showcase: null,
  resources: [],
};
window.__SPIKE__ = spike;

window.addEventListener("error", (event) => {
  spike.errors.push(String(event.message ?? event.error ?? "window error"));
});
window.addEventListener("unhandledrejection", (event) => {
  spike.errors.push(String(event.reason ?? "unhandled rejection"));
});

function setStatus(text) {
  spike.status = text;
  if (statusElement) statusElement.textContent = `${engineName}: ${text}`;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function main() {
  const engine = createEngine(canvas);
  // Loaded only inside main() so `window.__SPIKE__` exists before a failed
  // import can reject. Dynamic so a Havok run never downloads Rapier's 4 MB
  // bundle and vice versa; otherwise the boot comparison would measure the
  // other engine's download.
  const backendModule =
    engineName === "rapier"
      ? await import("./engines/rapier.js")
      : await import("./engines/havok.js");
  spike.environment = {
    ...describeRenderer(engine),
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };

  setStatus("loading physics");
  const started = performance.now();
  const backend =
    engineName === "rapier"
      ? await backendModule.createRapierBackend()
      : await backendModule.createHavokBackend();
  spike.boot.wasmInitMs = round(performance.now() - started, 1);
  spike.boot.backendReportedInitMs = round(backend.wasmInitMs, 1);
  spike.boot.navigationToReadyMs = round(performance.now(), 1);
  spike.boot.backendVersion = backend.version;

  setStatus("first world");
  const warmup = backend.createWorld({ visual: false });
  warmup.addStaticBox({
    halfExtents: { x: 40, y: 0.5, z: 40 },
    position: { x: 0, y: -0.5, z: 0 },
  });
  warmup.dispose();
  spike.boot.firstWorldMs = round(performance.now() - started, 1);

  if (params.get("probe") === "1") {
    setStatus("car probe");
    spike.probe = runCarProbe(backend);
  }

  setStatus("car acceleration");
  spike.scenarios.carAcceleration = runCarAcceleration(backend);
  setStatus("car slalom");
  spike.scenarios.carSlalom = runCarSlalom(backend);
  setStatus("character step");
  spike.scenarios.characterStep = runCharacterStep(backend);
  setStatus("character drop");
  spike.scenarios.characterDrop = runCharacterDrop(backend);
  setStatus("character wall");
  spike.scenarios.characterWall = runCharacterWall(backend);
  setStatus("determinism");
  spike.scenarios.determinism = runDeterminism(backend);

  setStatus("benchmark");
  const benchWorld = buildBenchmarkWorld(backend, engine);
  spike.benchmark = {
    dynamicBodies: benchWorld.dynamicBodyCount(),
    physics: measurePhysicsSteps(benchWorld),
    frames: await measureFrames(benchWorld),
  };
  benchWorld.dispose();

  setStatus("showcase");
  const showcase = buildShowcase(backend, engine);
  await renderFrames(showcase.world, 20);
  spike.showcase = {
    screenshotReady: true,
    car: {
      x: round(showcase.car.root.position.x, 3),
      y: round(showcase.car.root.position.y, 3),
      z: round(showcase.car.root.position.z, 3),
    },
    character: poseOf(showcase.world.characterState(showcase.character)),
  };

  spike.resources = performance
    .getEntriesByType("resource")
    .map((entry) => ({
      name: entry.name.split("/").pop() ?? entry.name,
      initiatorType: entry.initiatorType,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
      durationMs: round(entry.duration, 2),
    }));
  const navigation = performance.getEntriesByType("navigation")[0];
  if (navigation) {
    spike.boot.domContentLoadedMs = round(navigation.domContentLoadedEventEnd, 1);
    spike.boot.loadEventMs = round(navigation.loadEventEnd, 1);
  }

  setStatus("done");
  spike.done = true;
}

async function renderFrames(world, count) {
  for (let i = 0; i < count; i += 1) {
    world.stepSync();
    world.scene.render();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

function poseOf(state) {
  return {
    x: round(state.position.x, 3),
    y: round(state.position.y, 3),
    z: round(state.position.z, 3),
    grounded: state.grounded,
  };
}

main().catch((error) => {
  spike.error = String(error?.stack ?? error);
  spike.errors.push(spike.error);
  setStatus("failed");
  spike.done = true;
});
