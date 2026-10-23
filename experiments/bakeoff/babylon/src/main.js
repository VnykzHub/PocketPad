// Composition root. The engine-specific code lives in backend.js; this file
// only wires metrics, the asset base and the HUD, mirroring how the host app
// would consume an engine behind GameContext.

import { createMetrics, createFrameRecorder, recordError } from './metrics.js';
import { createBabylonBackend } from './backend.js';
// Vite emits the WASM next to the other assets and hands us its hashed URL,
// so dist/ carries one copy only.
import havokWasmUrl from '@babylonjs/havok/lib/esm/HavokPhysics.wasm?url';

const statusEl = document.getElementById('status');
const setStatus = (text) => {
  if (statusEl) statusEl.textContent = text;
};

const metrics = createMetrics();
const params = new URLSearchParams(location.search);

// ?assets= can point the contender at a different copy of the shared assets;
// the default is the sibling experiments/bakeoff/assets folder, loaded through
// the relative URL the integration contract specifies. The build does not copy
// or modify the shared assets.
const assetBase = params.get('assets')
  ? new URL(params.get('assets'), document.baseURI).href
  : new URL('../assets/', document.baseURI).href;

async function boot() {
  const canvas = document.getElementById('renderCanvas');
  const backend = await createBabylonBackend({
    canvas,
    metrics,
    assetBase,
    havokWasmUrl,
    forceBackend: params.get('backend'),
  });

  metrics.backend = backend.info.backend;
  metrics.backendInfo = backend.info.backendInfo;
  metrics.softwareRenderer = backend.info.softwareRenderer;
  metrics.assetSource = backend.info.assetSource;
  metrics.assets = backend.info.assets;
  metrics.buildings = backend.info.buildings;
  metrics.pedestrians = backend.info.pedestrians;
  metrics.animatedPeds = backend.info.animatedPeds;
  metrics.pedestrianControllers = backend.info.pedestrianControllers;
  metrics.wheelNodes = backend.info.wheelNodes;
  metrics.carPhysics = backend.info.carPhysics;
  metrics.shadows = backend.info.shadows;
  metrics.physics = backend.info.physics;
  metrics.layoutCells = backend.info.layoutCells;
  metrics.publish();

  const recordFrame = createFrameRecorder(metrics, backend.getStats);
  backend.onAfterRender((now) => recordFrame(now));
  backend.start();
  window.__BAKEOFF_VIEW_PEDS__ = () => backend.viewPeds();

  window.addEventListener('resize', () => backend.resize());
  window.addEventListener('pointerdown', () => backend.unlockAudio(), { passive: true });
  window.addEventListener('keydown', () => backend.unlockAudio());

  setStatus(
    `${backend.info.backend} · frame ${Math.round(metrics.firstFrameMs)} ms · ` +
      `ready in ${metrics.ready ? 'yes' : 'no'}`,
  );
  setInterval(() => {
    const state = metrics.measurementComplete
      ? 'measured'
      : metrics.ready
        ? `sampling ${metrics.sampleCount}`
        : 'warming up';
    setStatus(
      `${backend.info.backend} · ${state} · ${metrics.drawCalls} draws · ` +
        `${metrics.triangles >= 1000 ? `${Math.round(metrics.triangles / 1000)}k` : metrics.triangles} tris · ` +
        `${metrics.instances} inst`,
    );
  }, 500);
}

boot().catch((error) => {
  recordError(metrics, 'fatal', error);
  metrics.publish();
  setStatus(`fatal: ${error && error.message ? error.message : String(error)}`);
});
