/**
 * Custom-engine bake-off contender — composition root.
 *
 * Boot: pick a backend (WebGPU, then WebGL2 on a fresh canvas), load the shared
 * assets, start Rapier, build the scene, render one frame, then run a fixed
 * 60 Hz simulation inside a requestAnimationFrame loop and record wall-clock
 * frame intervals after a 5 s warm-up.
 *
 * The metrics object is the one declared in index.html; it is mutated in
 * place so any reference the runner took stays live.
 */

import { createWebGpuDevice } from "@lanpad/engine-renderer-webgpu";
import { createWebGL2Device } from "@lanpad/engine-renderer-webgl2";
import { createAssetLibrary } from "@lanpad/engine-assets";
import { initRapierPhysics, createRapierWorld } from "@lanpad/engine-physics";
import { createScene } from "./scene.js";
import { createAudio } from "./audio.js";
import { parseGlb, readCar, readPed } from "./glb.js";
import { decodePngRgba, createTextureFromRgba } from "./png.js";

const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;
const MAX_FRAME_DELTA_SECONDS = 0.25;
const WARMUP_MS = 5000;
const SAMPLE_WINDOW_MS = 60000;
const MAX_SAMPLES = 20000;
const MAX_ERRORS = 24;
const AUDIO_VIEW_EVERY_N_FRAMES = 6;
const HUD_EVERY_MS = 250;
const DEBUG_EVERY_MS = 1000;

const metrics = window.__BAKEOFF__;
const status = window.__BAKEOFF_STATUS__;
const bootOverlay = document.getElementById("boot");
const bootDetail = document.getElementById("boot-detail");
const stage = document.getElementById("stage");
const hud = {
  backend: document.getElementById("hud-backend"),
  fps: document.getElementById("hud-fps"),
  draws: document.getElementById("hud-draws"),
  active: document.getElementById("hud-active"),
  measure: document.getElementById("hud-measure"),
  status: document.getElementById("hud-status"),
  errors: document.getElementById("hud-errors"),
};

const reportedErrors = new Set();

function describeError(error) {
  if (error instanceof Error) {
    const code = typeof error.code === "string" ? ` [${error.code}]` : "";
    return `${error.name}${code}: ${error.message}`;
  }
  return String(error);
}

function pushError(text) {
  const clean = String(text).slice(0, 400);
  if (reportedErrors.has(clean)) return;
  reportedErrors.add(clean);
  if (metrics.errors.length < MAX_ERRORS) metrics.errors.push(clean);
  if (hud.errors !== null) hud.errors.textContent = metrics.errors.slice(-3).join("\n");
}

function setStatus(phase, detail) {
  status.phase = phase;
  status.detail = detail;
  if (bootDetail !== null) bootDetail.textContent = detail;
  if (hud.status !== null) hud.status.textContent = detail;
}

window.addEventListener("error", (event) => {
  pushError(event.message === "" ? describeError(event.error) : event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  pushError(`unhandled rejection: ${describeError(event.reason)}`);
});

const query = new URLSearchParams(window.location.search);
const forcedBackend = query.get("backend"); // "webgpu" | "webgl2" | null

function surfaceFor(canvas) {
  const cssWidth =
    stage !== null && stage.clientWidth > 0
      ? stage.clientWidth
      : Math.max(1, window.innerWidth);
  const cssHeight =
    stage !== null && stage.clientHeight > 0
      ? stage.clientHeight
      : Math.max(1, window.innerHeight);
  const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return { kind: "canvas", native: canvas, cssWidth, cssHeight, dpr };
}

function mountCanvas() {
  const canvas = document.createElement("canvas");
  if (stage !== null) stage.replaceChildren(canvas);
  return canvas;
}

/**
 * A canvas can hold one context type. If WebGPU configured the canvas before
 * failing, the fallback must start from a fresh element — the WebGL2 contract
 * requires that replacement explicitly.
 */
async function bootRenderer() {
  let webgpuFailure = null;

  if (forcedBackend !== "webgl2") {
    const canvas = mountCanvas();
    try {
      const result = await createWebGpuDevice({
        quality: "high",
        shadowCascades: 0,
        powerPreference: "high-performance",
      });
      await result.device.init(surfaceFor(canvas), {
        quality: "high",
        shadowCascades: 0,
      });
      return {
        device: result.device,
        backend: "webgpu",
        adapterInfo: result.adapterInfo,
        fallbackReason: null,
      };
    } catch (error) {
      webgpuFailure = describeError(error);
      if (forcedBackend === "webgpu") {
        throw new Error(`WebGPU requested via ?backend=webgpu, init failed: ${webgpuFailure}`);
      }
    }
  }

  setStatus("booting", `WebGPU unavailable (${webgpuFailure ?? "skipped"}); starting WebGL2`);

  const canvas = mountCanvas();
  const result = await createWebGL2Device({
    canvas,
    quality: "high",
    shadowCascades: 0,
    antialias: true,
    powerPreference: "high-performance",
  });

  return {
    device: result.device,
    backend: "webgl2",
    adapterInfo: result.adapterInfo,
    fallbackReason: webgpuFailure,
  };
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function textureDescFromAsset(data, label) {
  const format =
    data.format === "rgba8unorm" && data.sourceColorSpace === "srgb"
      ? "rgba8unorm-srgb"
      : data.format;
  return {
    label,
    width: data.width,
    height: data.height,
    mipLevels: data.mipLevels,
    format,
    usage: ["sample", "copy-dst"],
    data: data.levels.map((level) => ({
      mipLevel: level.mipLevel,
      layer: level.layer,
      bytes: level.bytes,
      bytesPerRow: level.bytesPerRow,
    })),
    sampler: {
      label: `${label}-sampler`,
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: data.mipLevels > 1 ? "linear" : "nearest",
      addressU: "repeat",
      addressV: "repeat",
    },
  };
}

async function boot() {
  setStatus("booting", "Selecting a renderer");

  const { device, backend, adapterInfo, fallbackReason } = await bootRenderer();
  if (fallbackReason !== null) {
    // Expected path on browsers without WebGPU; kept out of `errors` so that
    // array only carries real failures, but shown in the HUD and debug dump.
    setStatus("booting", `WebGPU unavailable (${fallbackReason}); running WebGL2`);
  }

  device.onDeviceLost((info) => {
    pushError(`device lost (${info.reason}): ${info.message}`);
  });

  setStatus("booting", `Renderer ready: ${backend}. Loading assets`);

  const manifestUrl = new URL("assets-manifest.json", document.baseURI).href;
  const library = await createAssetLibrary({
    gameId: "bakeoff",
    manifestUrl,
    // The manifest sits inside `custom/`; one `../` lands on the shared
    // `experiments/bakeoff/` folder that the entry URLs are relative to.
    baseUrl: new URL("../", manifestUrl).href,
    // The library's worker URL cannot survive Vite bundling in this package;
    // a throwing factory makes it degrade to a synchronous main-thread decode,
    // which is the documented behaviour of `degraded`.
    workerFactory: () => {
      throw new Error("bakeoff: worker decode disabled; decode on the main thread");
    },
  });
  library.onFailure((failure) => {
    pushError(`asset ${failure.id} ${failure.code}: ${failure.message}`);
  });

  const [groundHandle, buildingHandle, facadeHandle] = await Promise.all([
    library.load("ground"),
    library.load("building"),
    library.load("facade"),
  ]);

  // `load` resolves with a failed handle rather than rejecting when the fetch
  // or decode fails, so the state has to be checked before reading `value`.
  function requireReady(handle) {
    if (handle.state !== "ready") {
      const failure = handle.failed;
      throw new Error(
        `asset ${handle.id} is ${handle.state}` +
          (failure === null ? "" : ` (${failure.code}: ${failure.message})`),
      );
    }
    return handle.value;
  }
  const ground = requireReady(groundHandle);
  const building = requireReady(buildingHandle);
  const facade = requireReady(facadeHandle);

  const [layoutData, carBytes, pedBytes] = await Promise.all([
    fetch(new URL("../assets/layout.json", document.baseURI)).then((response) => {
      if (!response.ok) throw new Error(`layout.json: HTTP ${response.status}`);
      return response.json();
    }),
    fetchBytes(new URL("../assets/car.glb", document.baseURI)),
    fetchBytes(new URL("../assets/ped.glb", document.baseURI)),
  ]);

  const carGlb = parseGlb(carBytes.buffer);
  const pedGlb = parseGlb(pedBytes.buffer);
  const carData = readCar(carGlb);
  const pedData = readPed(pedGlb);

  const facadeTexture = device.createTexture(
    textureDescFromAsset(facade, "facade"),
  );

  let carTexture = null;
  if (carData.material.image !== null) {
    try {
      const image = await decodePngRgba(carData.material.image.bytes, "car-colormap");
      carTexture = createTextureFromRgba(device, "car-colormap", image);
    } catch (error) {
      // A missing car texture is a visible downgrade, not a silent feature.
      pushError(`car texture: ${describeError(error)}`);
    }
  }

  setStatus("booting", "Starting physics");
  await initRapierPhysics();
  const physics = createRapierWorld({
    gravity: { x: 0, y: -9.81, z: 0 },
    fixedDt: FIXED_DT,
    layers: ["default", "world", "peds"],
    debug: false,
  });

  setStatus("booting", "Building the scene");
  const scene = createScene({
    device,
    backend,
    layout: layoutData,
    ground,
    building,
    facadeTexture,
    carData,
    pedData,
    carTexture,
    physics,
    onError: pushError,
  });

  const audio = createAudio({ onError: pushError });
  void audio.unlock();

  // The camera is device-sized; keep the swapchain in step with the element.
  window.addEventListener("resize", () => {
    const size = surfaceFor(stage?.firstElementChild ?? document.createElement("canvas"));
    device.resize(size.cssWidth, size.cssHeight, size.dpr);
  });

  /* ------------------------------------------------------- first frame ---- */

  setStatus("booting", "Rendering the first frame");
  const firstFrame = device.beginFrame();
  if (!firstFrame.valid) {
    throw new Error("the first frame was invalid (device lost or zero-sized surface)");
  }
  scene.render(firstFrame);
  device.endFrame();
  const firstFrameMs = performance.now();

  metrics.backend = backend;
  metrics.firstFrameMs = round(firstFrameMs);
  metrics.drawCalls = device.stats.drawCalls;
  metrics.triangles = device.stats.triangles;
  metrics.instances = device.stats.instances;
  metrics.activations = scene.activations();
  metrics.deactivations = scene.deactivations();
  metrics.ready = true;
  window.__BAKEOFF_BOOTED__ = true;

  if (bootOverlay !== null) bootOverlay.classList.add("done");
  if (hud.backend !== null) hud.backend.textContent = backend;
  setStatus("running", `Running on ${backend}`);

  /* --------------------------------------------------------- main loop ---- */

  const view = {
    carX: 0,
    carY: 0,
    carZ: 0,
    cameraX: 0,
    cameraY: 0,
    cameraZ: 0,
    forwardX: 0,
    forwardZ: 0,
  };
  const carSnapshot = { x: 0, y: 0, z: 0 };
  const cameraSnapshot = { x: 0, y: 0, z: 0, lookX: 0, lookY: 0, lookZ: 0 };

  function refreshAudioView() {
    const car = scene.car();
    carSnapshot.x = car.x;
    carSnapshot.y = car.y;
    carSnapshot.z = car.z;
    const camera = scene.camera();
    cameraSnapshot.x = camera.x;
    cameraSnapshot.y = camera.y;
    cameraSnapshot.z = camera.z;
    cameraSnapshot.lookX = camera.lookX;
    cameraSnapshot.lookY = camera.lookY;
    cameraSnapshot.lookZ = camera.lookZ;
    view.carX = carSnapshot.x;
    view.carY = carSnapshot.y;
    view.carZ = carSnapshot.z;
    view.cameraX = cameraSnapshot.x;
    view.cameraY = cameraSnapshot.y;
    view.cameraZ = cameraSnapshot.z;
    view.forwardX = cameraSnapshot.lookX - cameraSnapshot.x;
    view.forwardZ = cameraSnapshot.lookZ - cameraSnapshot.z;
  }
  refreshAudioView();

  let accumulator = 0;
  let frameIndex = 0;
  let samplingStarted = false;
  let samplingDone = false;
  let sampleWindowStart = 0;
  let lastNow = performance.now();
  let warmupEndsAt = lastNow + WARMUP_MS;
  let lastHudAt = 0;
  let lastDebugAt = 0;
  let measuredFps = 0;

  function copyStats() {
    metrics.drawCalls = device.stats.drawCalls;
    metrics.triangles = device.stats.triangles;
    metrics.instances = device.stats.instances;
    metrics.activations = scene.activations();
    metrics.deactivations = scene.deactivations();
  }

  function updateHud(now) {
    if (hud.fps !== null) hud.fps.textContent = `${measuredFps.toFixed(1)}`;
    if (hud.draws !== null) {
      hud.draws.textContent = `${metrics.drawCalls} / ${metrics.triangles}`;
    }
    if (hud.active !== null) {
      const diag = scene.diagnostics();
      hud.active.textContent =
        `${diag.buildings} buildings · ${diag.peds.active}/${diag.peds.total} peds`;
    }
    if (hud.measure !== null) {
      if (samplingDone) {
        hud.measure.textContent = `${metrics.frameTimesMs.length} frames`;
      } else if (samplingStarted) {
        hud.measure.textContent =
          `${((now - sampleWindowStart) / 1000).toFixed(1)} s / 60 s`;
      } else {
        hud.measure.textContent = `warm-up ${((warmupEndsAt - now) / 1000).toFixed(1)} s`;
      }
    }
    if (hud.errors !== null && metrics.errors.length > 0) {
      hud.errors.textContent = metrics.errors.slice(-3).join("\n");
    }
  }

  function updateDebug(now) {
    const diagnostics = scene.diagnostics();
    const audioState = audio.state();
    window.__BAKEOFF_DEBUG__ = {
      at: round(now),
      backend,
      adapterInfo,
      fallbackReason,
      crossOriginIsolated: window.crossOriginIsolated === true,
      capabilities: {
        quality: device.capabilities.quality,
        shadowCascades: device.capabilities.shadowCascades,
        maxTextureSize: device.capabilities.maxTextureSize,
        directionalLights: device.capabilities.directionalLights,
        supportsPost: device.capabilities.supportsPost,
        features: Array.from(device.capabilities.features),
      },
      size: { width: device.size.width, height: device.size.height },
      stats: {
        drawCalls: device.stats.drawCalls,
        triangles: device.stats.triangles,
        instances: device.stats.instances,
        culledInstances: device.stats.culledInstances,
        droppedDraws: device.stats.droppedDraws,
        gpuErrors: device.stats.gpuErrors,
        textureBytes: device.stats.textureBytes,
        bufferBytes: device.stats.bufferBytes,
        cpuFrameMs: round(device.stats.cpuFrameMs),
        gpuFrameMs: device.stats.gpuFrameMs,
      },
      scene: diagnostics,
      audio: audioState,
      assets: {
        degraded: library.degraded,
        loadedBytes: library.loadedBytes,
        textureBytes: library.textureBytes,
        failures: library.failures.map((failure) => `${failure.id}: ${failure.code}`),
      },
      samples: metrics.frameTimesMs.length,
    };
  }

  function loop(now) {
    const rawMs = now - lastNow;
    lastNow = now;
    const deltaSeconds = Math.min(
      Math.max(rawMs, 0) / 1000,
      MAX_FRAME_DELTA_SECONDS,
    );

    accumulator += deltaSeconds;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      scene.update(FIXED_DT);
      accumulator -= FIXED_DT;
      steps += 1;
    }
    // A long stall (tab hidden, debugger pause) must not spiral; drop the
    // backlog rather than running 100 physics steps on one displayed frame.
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

    frameIndex += 1;
    if (frameIndex % AUDIO_VIEW_EVERY_N_FRAMES === 0) refreshAudioView();
    audio.update(deltaSeconds, view);

    const frame = device.beginFrame();
    const valid = frame.valid;
    if (valid) scene.render(frame);
    device.endFrame();
    copyStats();

    // Measurement: wall-clock intervals only, after the warm-up, for 60 s.
    if (valid && rawMs > 0) {
      if (!samplingStarted && now >= warmupEndsAt) {
        samplingStarted = true;
        sampleWindowStart = now;
      }
      if (
        samplingStarted &&
        !samplingDone &&
        now - sampleWindowStart <= SAMPLE_WINDOW_MS &&
        metrics.frameTimesMs.length < MAX_SAMPLES
      ) {
        metrics.frameTimesMs.push(round(rawMs));
        const count = metrics.frameTimesMs.length;
        const span = now - sampleWindowStart;
        measuredFps = span > 0 ? (count * 1000) / span : 0;
      } else if (
        samplingStarted &&
        !samplingDone &&
        now - sampleWindowStart > SAMPLE_WINDOW_MS
      ) {
        samplingDone = true;
        setStatus(
          "running",
          `Measurement complete on ${backend}: ${metrics.frameTimesMs.length} frames`,
        );
      }
    }

    if (now - lastHudAt >= HUD_EVERY_MS) {
      lastHudAt = now;
      updateHud(now);
    }
    if (now - lastDebugAt >= DEBUG_EVERY_MS) {
      lastDebugAt = now;
      updateDebug(now);
    }

    window.requestAnimationFrame(loop);
  }

  updateHud(lastNow);
  updateDebug(lastNow);
  lastNow = performance.now();
  warmupEndsAt = lastNow + WARMUP_MS;
  window.requestAnimationFrame(loop);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

boot().catch((error) => {
  const text = describeError(error);
  pushError(text);
  setStatus("error", `Boot failed: ${text}`);
  if (bootOverlay !== null) bootOverlay.classList.remove("done");
  if (bootDetail !== null) bootDetail.textContent = `Boot failed:\n${text}`;
});
