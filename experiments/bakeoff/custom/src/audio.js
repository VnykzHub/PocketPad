/**
 * Positional engine hum for the custom contender.
 *
 * The engine audio system is used end to end: `unlock()` on a user gesture,
 * a procedural buffer registered through `registerBuffer`, a positional
 * looping source created with `createSource`, per-tick `setSourcePosition`
 * and listener updates, then `update(dt)`.
 *
 * This is a real positional Web Audio source; its pitch is fixed because the
 * M0 audio contract exposes no live rate control for a playing source. That
 * limitation, and the autoplay state in headless Chrome, are reported in
 * CHECKLIST.md instead of being hidden behind a fake "engine sound".
 */

import { EngineAudioSystem } from "@lanpad/engine-audio";

const HUM_ASSET_ID = "engine-hum";
const HUM_SECONDS = 2;
const HUM_BASE_HZ = 48;
const HUM_SECOND_HZ = 96;
const HUM_THIRD_HZ = 144;
const HUM_MODULATION_HZ = 3;

/**
 * Fills an AudioBuffer with a seamless 2 s engine hum: three harmonics plus a
 * slow amplitude wobble. Every frequency completes a whole number of cycles
 * in 2 s, so looping does not click.
 */
function fillHumBuffer(context) {
  const sampleRate = context.sampleRate;
  const frames = Math.floor(sampleRate * HUM_SECONDS);
  const buffer = context.createBuffer(1, frames, sampleRate);
  const channel = buffer.getChannelData(0);
  const twoPi = Math.PI * 2;
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / sampleRate;
    const wobble = 0.85 + 0.15 * Math.sin(twoPi * HUM_MODULATION_HZ * t);
    const sample =
      Math.sin(twoPi * HUM_BASE_HZ * t) * 0.5 +
      Math.sin(twoPi * HUM_SECOND_HZ * t) * 0.28 +
      Math.sin(twoPi * HUM_THIRD_HZ * t) * 0.12;
    channel[frame] = sample * 0.35 * wobble;
  }
  return buffer;
}

export function createAudio({ onError }) {
  let context = null;
  let source = null;
  let bufferReady = false;
  let unlockAttempted = false;
  const reported = new Set();
  const reportedState = { value: "locked" };

  function report(error) {
    const text = String(error).slice(0, 300);
    if (reported.has(text)) return;
    reported.add(text);
    onError?.(text);
  }

  const system = new EngineAudioSystem({
    masterVolume: 0.55,
    latencyHint: "interactive",
    createContext: (hint) => {
      const Constructor =
        globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (Constructor === undefined) {
        throw new Error("AudioContext is not available");
      }
      if (context === null) {
        context = new Constructor({ latencyHint: hint });
      }
      return context;
    },
  });

  function ensureSource() {
    if (source !== null || !system.unlocked || context === null) return;
    if (!bufferReady) {
      const buffer = fillHumBuffer(context);
      system.registerBuffer(HUM_ASSET_ID, buffer);
      bufferReady = true;
    }
    source = system.createSource({
      assetId: HUM_ASSET_ID,
      bus: "sfx",
      positional: true,
      loop: true,
      volume: 0.85,
      refDistance: 5,
      maxDistance: 90,
      rolloff: 1.2,
      distanceModel: "inverse",
      panningModel: "equalpower",
    });
    system.play(source);
  }

  async function unlock() {
    unlockAttempted = true;
    try {
      await system.unlock();
      ensureSource();
    } catch (error) {
      report(`audio unlock failed: ${String(error)}`);
    }
    const nextState = system.state;
    if (nextState !== reportedState.value) {
      reportedState.value = nextState;
    }
    if (system.state === "unavailable" && !reported.has("audio unavailable")) {
      reported.add("audio unavailable");
      onError?.(
        "audio unavailable: no AudioContext in this browser (checklist item 7 is PENDING, not faked)",
      );
    }
  }

  // Autoplay policy: the first real gesture retries the unlock. Added once.
  function gestureUnlock() {
    void unlock();
    globalThis.removeEventListener("pointerdown", gestureUnlock);
    globalThis.removeEventListener("keydown", gestureUnlock);
  }
  globalThis.addEventListener("pointerdown", gestureUnlock, { passive: true });
  globalThis.addEventListener("keydown", gestureUnlock);

  function update(dt, view) {
    system.update(dt);
    if (source === null) return;
    system.setSourcePosition(
      source,
      view.carX,
      view.carY + 0.4,
      view.carZ,
    );
    system.listener.setPosition(view.cameraX, view.cameraY, view.cameraZ);
    const forwardLength = Math.hypot(view.forwardX, view.forwardZ) || 1;
    system.listener.setOrientation(
      view.forwardX / forwardLength,
      0,
      view.forwardZ / forwardLength,
      0,
      1,
      0,
    );
  }

  function state() {
    return {
      state: system.state,
      unlocked: system.unlocked,
      suspended: system.suspended,
      available: system.available,
      unlockAttempted,
      sourceCreated: source !== null,
      buffersRegistered: bufferReady,
      stats: {
        activeVoices: system.stats.activeVoices,
        spatialVoices: system.stats.spatialVoices,
        droppedPlays: system.stats.droppedPlays,
        interruptions: system.stats.interruptions,
      },
    };
  }

  return { system, unlock, update, state };
}
