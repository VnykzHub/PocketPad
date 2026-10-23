// Measurement harness for the bake-off. `window.__BAKEOFF__` carries exactly
// the README contract fields, created before the engine boots so the runner can
// poll it at any time. Everything else lives on `window.__BAKEOFF_EXTRA__`, so
// the contract object never grows non-contract keys (the runner flags those).
// `ready` means "scene has rendered its first frame"; `measurementComplete`
// means the warm-up plus sample window has finished.

const DEFAULT_WARMUP_SECONDS = 5;
const DEFAULT_RUN_SECONDS = 60;

function readSeconds(params, name, fallback) {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 && value <= 600 ? value : fallback;
}

export function createMetrics() {
  const params = new URLSearchParams(location.search);
  const metrics = {
    // Contract fields (README "Metrics interface").
    ready: false,
    backend: 'unknown',
    frameTimesMs: [],
    drawCalls: 0,
    triangles: 0,
    instances: 0,
    firstFrameMs: 0,
    activations: 0,
    deactivations: 0,
    errors: [],
    // Extra, documented fields (not exposed on the contract object).
    measurementComplete: false,
    warmupSeconds: readSeconds(params, 'warmupSeconds', DEFAULT_WARMUP_SECONDS),
    runSeconds: readSeconds(params, 'runSeconds', DEFAULT_RUN_SECONDS),
    sampleCount: 0,
    backendInfo: '',
    softwareRenderer: false,
    crossOriginIsolated: window.crossOriginIsolated === true,
    assetSource: 'unknown',
    audio: 'pending',
    running: false,
    activePeds: 0,
    peakActivePeds: 0,
    activeStreamables: 0,
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
  };

  // The runner reads this object by name; keep its shape to the contract.
  const contract = {
    ready: false,
    backend: 'unknown',
    frameTimesMs: metrics.frameTimesMs,
    drawCalls: 0,
    triangles: 0,
    instances: 0,
    firstFrameMs: 0,
    activations: 0,
    deactivations: 0,
    errors: metrics.errors,
  };
  window.__BAKEOFF__ = contract;
  window.__BAKEOFF_EXTRA__ = metrics;

  metrics.publish = () => {
    contract.ready = metrics.ready;
    contract.backend = metrics.backend;
    contract.drawCalls = metrics.drawCalls;
    contract.triangles = metrics.triangles;
    contract.instances = metrics.instances;
    contract.firstFrameMs = metrics.firstFrameMs;
    contract.activations = metrics.activations;
    contract.deactivations = metrics.deactivations;
  };
  return metrics;
}

export function recordError(metrics, context, error) {
  const detail = error && error.stack ? error.stack : String(error);
  metrics.errors.push(`${context}: ${detail}`);
  console.error(`[bakeoff] ${context}`, error);
}

/**
 * Wires frame sampling to Babylon's after-render observable.
 * Warm-up runs for `warmupSeconds` after the first rendered frame, then every
 * frame interval is recorded for `runSeconds`. No outlier trimming: p50/p95
 * are computed by the runner from the raw array.
 */
export function createFrameRecorder(metrics, getStats) {
  let firstFrameAt = 0;
  let samplingStartAt = 0;
  let lastSampleAt = 0;
  // Cap protects a page left open for hours after the run completes.
  const maxSamples = Math.ceil(metrics.runSeconds * 300) + 16;

  return function recordFrame(now = performance.now()) {
    if (firstFrameAt === 0) {
      firstFrameAt = now;
      samplingStartAt = now + metrics.warmupSeconds * 1000;
      metrics.firstFrameMs = now;
      metrics.ready = true;
      metrics.publish();
    }
    if (metrics.measurementComplete) return;
    if (now < samplingStartAt) return;
    if (lastSampleAt === 0) {
      lastSampleAt = now;
      return;
    }
    if (metrics.frameTimesMs.length < maxSamples) {
      metrics.frameTimesMs.push(now - lastSampleAt);
    }
    metrics.sampleCount = metrics.frameTimesMs.length;
    lastSampleAt = now;

    const stats = getStats();
    metrics.drawCalls = stats.drawCalls;
    metrics.triangles = stats.triangles;
    metrics.instances = stats.instances;
    metrics.activations = stats.activations;
    metrics.deactivations = stats.deactivations;
    metrics.activePeds = stats.activePeds;
    metrics.activeStreamables = stats.activeStreamables ?? 0;
    if (stats.activePeds > metrics.peakActivePeds) metrics.peakActivePeds = stats.activePeds;

    if (now - samplingStartAt >= metrics.runSeconds * 1000) {
      metrics.measurementComplete = true;
    }
    metrics.publish();
  };
}
