# 09 — Audio

**Status:** authoritative for the engine audio subsystem once implemented. This document specifies a target contract; the only part that exists today is the `AudioBus` described in §5.13.
**Authority:** [`SPEC.md`](../../SPEC.md) §9.3, §9.6 and FR-9.11 for the product contract; [`00-architecture.md`](00-architecture.md) for package boundaries, error taxonomy and the migration map; [`docs/ENGINE.md`](../ENGINE.md) for what exists today. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded in [`docs/todos/README.md`](../todos/README.md).
**Package:** `@lanpad/engine-audio` at `packages/engine/audio` (00 §3.7, §6). The wave brief's `packages/audio` is shorthand for the same package; if the workspace is ever moved, the internal layout is unchanged.

**Milestone boundary.** M0 ships **only** the migration of the existing `AudioBus` (one master gain, one music gain, eight SFX voices, gesture unlock, audio-clock fades). Positional audio, mixer buses beyond master/music, streaming music, radio and decode budgeting are **M1**. Occlusion, Doppler, reverb sends and ambience zones are **M2** and must remain optional per source. 00 §5.14 is normative: adding an M1 audio feature to the M0 wave is an M0 failure even if it works.

---

## 1. Goal

Today the host has one stereo path: `AudioBus` in `packages/runtime/src/audio/AudioBus.ts`. It unlocks from a user gesture, plays preloaded buffers through eight pooled voices, fades music on the `AudioContext` clock and goes silent when Web Audio is unavailable. That is sufficient for a 2D arcade game and insufficient for the engine's north star.

The player-visible outcome this spec targets:

- **A sound has a position in the world.** A car passes left to right, a gunshot comes from the alley behind the player, an NPC's voice is quieter across the street. Panning and distance attenuation follow the same camera the renderer draws.
- **The mix is structured.** Music, SFX, ambience, voice and UI have independent levels, with a master mute owned by the host UI. A game changes a bus, not every source.
- **Music and radio stream.** Long tracks are not fully decoded into RAM, and tuning a different station crossfades without a click or a silence gap.
- **Audio starts only after the player's gesture** (FR-9.11) and is never the reason a frame misses its budget.
- **Audio failure is invisible to the game.** With no Web Audio, a blocked context or a decode failure, the simulation runs unchanged and silently.

The engineering outcome is a contract a game can code against without knowing whether the host is a desktop, a TV or a test fake: one `AudioSystem`, one audio clock, generational source handles, and no Web Audio object in a game-facing signature.

---

## 2. Non-goals

- **No codec or DSP implementation.** The browser decodes Opus/WAV/AAC. No WASM mixer, no custom resampler, no `AudioWorklet` DSP in M1.
- **No third-party audio library.** No Howler, Tone.js, FMOD/Wwise web builds. `engine-audio` depends on `engine-core` only.
- **No HRTF research.** HRTF is one built-in `PannerNode` mode, opt-in per source; equal-power panning is the default for TV speakers.
- **No occlusion, reverb sends, Doppler or ambience zones in M1.** They are M2, additive per-source fields, off by default.
- **No voice chat, network audio or microphone capture.** Not this spec, not v1.
- **No phone-side game audio.** Controllers play haptics, not game sound (SPEC §8); haptics are outside this spec.
- **No automatic adaptive-music authoring.** The engine plays what the game schedules; it does not compose or re-orchestrate.
- **No multiple `AudioContext` instances.** One context per host page, period. A second context is a bug.
- **No audio-driven simulation.** Audio is presentation; it never feeds `simulate`, input, physics or the replay hash.
- **No global audio settings UI.** The host shell owns the mute/volume affordances; this spec owns the mixer they drive.
- **No sample-accurate visual sync.** The engine reports latency; compensating visuals (rhythm calibration) is game or experiment work (E11).

---

## 3. Public interfaces

All types are backend-neutral: no `AudioContext`, `AudioNode`, `HTMLAudioElement` or `AudioBuffer` appears in a game-facing signature. `AudioBuffer` appears only in `AudioAssetValue`, because decode is the asset boundary (00 §3.6 D11 allows `engine-audio` to name Web Audio types; the SDK never sees them).

Contract authority: `packages/engine/audio/src/types.ts`. The `.d.ts` companion required by the programme README §7.1 is generated from that file; the types are the authority and are additive-only after M0 (00 §3.1).

### 3.1 State and options

```ts
import type { Vec3, Quat } from "@lanpad/engine-core";

/** Same strings as the existing AudioBusState; the M0 facade depends on them. */
export type AudioState = "locked" | "unlocked" | "unavailable";

/** Buses present in M1. M0 exposes master and music only; see §5.3. */
export type AudioBusName = "music" | "sfx" | "ambient" | "voice" | "ui";

export type AudioLatencyHint = "interactive" | "balanced";

export interface AudioSystemOptions {
  readonly latencyHint?: AudioLatencyHint;      // default "interactive"
  readonly masterVolume?: number;               // 0..1, default 1
  readonly sfxVoices?: number;                  // 1..32, default 8 (matches today)
  readonly spatialVoices?: number;              // 1..32, default 16
  readonly decodeBudgetBytes?: number;          // default 32 MiB; 0 disables decoding
  readonly mix?: AudioMixConfig;                // from audio-mix.json, validated
  /** Test seam; defaults to detecting globalThis.AudioContext at unlock time. */
  readonly createContext?: (hint: AudioLatencyHint) => BaseAudioContext;
  /** Test seam for streaming; defaults to document.createElement("audio"). */
  readonly createMediaElement?: () => HTMLAudioElement;
}
```

Rules: `masterVolume` is clamped to 0..1; voice counts are integers in 1..32; a non-integer or out-of-range value is clamped, not thrown (boot must not fail on a bad option). `decodeBudgetBytes` is clamped to 0..256 MiB.

### 3.2 Clock and listener

```ts
export interface AudioClock {
  /** AudioContext.currentTime in seconds; exactly 0 while locked or unavailable. */
  readonly now: number;
  readonly running: boolean;
  /** Seconds; 0 when the browser does not report it. */
  readonly baseLatency: number;
  /** Seconds; falls back to baseLatency, then 0. */
  readonly outputLatency: number;
  /** Context time for a performance.now() timestamp, clamped to [0, now]. */
  performanceToAudio(perfMs: number): number;
  /** performance.now() estimate for a context time, clamped to now. */
  audioToPerformance(audioSeconds: number): number;
}

export interface AudioListener {
  setPosition(x: number, y: number, z: number): void;
  /** World-space unit vectors; normalized by the engine. */
  setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
  /** Camera convenience: forward from a quaternion, up = world +Y unless supplied. */
  setFromTransform(position: Vec3, rotation: Quat, up?: Vec3): void;
}
```

The listener convention is the renderer's (00 §5, spec 02 §3.5): right-handed, `+Y` up, a camera looks down **−Z**. `setFromTransform` derives forward as `quatRotate(rotation, (0, 0, -1))`; `up` defaults to `(0, 1, 0)`. This guarantees the audio pan matches the image without a second handedness conversation.

### 3.3 Sources

```ts
export type DistanceModel = "inverse" | "linear" | "exponential";
export type PanningModel = "equalpower" | "HRTF";

/** Generational and owned by the AudioSystem. Never a Web Audio node. */
export interface AudioSourceHandle {
  readonly index: number;
  readonly generation: number;
}

export interface AudioSourceDesc {
  readonly assetId: string;                    // manifest id, kind "audio"
  readonly bus?: AudioBusName;                 // default "sfx"
  readonly positional?: boolean;               // default false
  readonly loop?: boolean;                     // default false
  readonly volume?: number;                    // 0..1, default 1
  readonly rate?: number;                      // 0.25..4, default 1
  readonly panningModel?: PanningModel;        // default "equalpower"
  readonly distanceModel?: DistanceModel;      // default "inverse"
  readonly refDistance?: number;               // default 1; > 0
  readonly maxDistance?: number;               // default 100; > refDistance
  readonly rolloff?: number;                   // 0..10, default 1
  readonly priority?: number;                  // 0..255, default 128
  readonly doppler?: boolean;                  // default false; M2 only
}

export interface AudioPlayOptions {
  /** Context time to start; default clock.now. A past time clamps to now + 5 ms. */
  readonly at?: number;
  /** Multiplies the source volume; 0..1, default 1. */
  readonly volume?: number;
  /** Multiplies the source rate; 0.25..4, default 1. */
  readonly rate?: number;
}

/** Decoded by engine-assets; either a decoded buffer or a same-origin stream URL. */
export type AudioAssetValue =
  | { readonly kind: "buffer"; readonly buffer: AudioBuffer }
  | { readonly kind: "stream"; readonly url: string; readonly durationSeconds?: number };
```

Handle rules: handles are generational (00 §5.7). `destroySource` twice, or on a stale generation, is a counted no-op in production and `E_STALE_HANDLE` in dev. A handle never exposes an index into a Web Audio node table to a game.

### 3.4 Mixer, music and radio

```ts
export interface AudioMixConfig {
  readonly formatVersion: 1;
  readonly masterVolume: number;                          // 0..1
  readonly buses: Readonly<Record<AudioBusName, number>>; // each 0..1
  readonly sfxVoices: number;                             // 1..32
  readonly spatialVoices: number;                         // 1..32
  readonly defaults: {
    readonly distanceModel: DistanceModel;
    readonly panningModel: PanningModel;
    readonly refDistance: number;
    readonly maxDistance: number;
    readonly rolloff: number;
  };
}

export interface AudioMixer {
  readonly masterVolume: number;      // 0..1
  readonly muted: boolean;
  setMasterVolume(volume: number, rampMs?: number): void;
  setBusVolume(bus: AudioBusName, volume: number, rampMs?: number): void;
  getBusVolume(bus: AudioBusName): number;
  setBusMuted(bus: AudioBusName, muted: boolean): void;
  setMuted(muted: boolean): void;
}

export interface MusicOptions {
  readonly loop?: boolean;          // default true
  readonly fadeMs?: number;         // default 0; 0..10000
  readonly volume?: number;         // 0..1, default 1
  readonly startAt?: number;        // context time; default clock.now
}

export interface RadioOptions {
  readonly fadeMs?: number;         // crossfade length, default 1500; 0..5000
  readonly loop?: boolean;          // default station's loop flag
}

export interface RadioStation {
  readonly id: string;                // ^[a-z0-9][a-z0-9-]{0,31}$
  readonly tracks: readonly string[]; // 1..64 manifest audio asset ids
  readonly loop: boolean;
}
```

### 3.5 The system

```ts
export interface AudioStats {
  readonly activeVoices: number;       // playing, both pools
  readonly sfxVoices: number;          // pool size
  readonly spatialVoices: number;      // pool size
  readonly droppedPlays: number;       // voice exhaustion, cumulative
  readonly decodedBytes: number;       // decoded buffers currently held
  readonly streaming: boolean;         // a music/radio deck is streaming
  readonly interruptions: number;      // context suspend/interruption events
  readonly steals: number;             // voices stolen, cumulative
}

export interface AudioSystem {
  readonly state: AudioState;
  readonly unlocked: boolean;
  readonly suspended: boolean;
  readonly available: boolean;
  readonly latencyHint: AudioLatencyHint;
  readonly clock: AudioClock;
  readonly mixer: AudioMixer;
  readonly listener: AudioListener;
  readonly stats: AudioStats;

  /** Must be called from a user gesture. Idempotent; never rejects. */
  unlock(): Promise<void>;
  suspend(): Promise<void>;
  resume(): Promise<void>;

  createSource(desc: AudioSourceDesc): AudioSourceHandle;
  destroySource(handle: AudioSourceHandle): void;
  setSourcePosition(handle: AudioSourceHandle, x: number, y: number, z: number): void;
  play(handle: AudioSourceHandle, opts?: AudioPlayOptions): void;
  stop(handle: AudioSourceHandle, fadeMs?: number): void;

  /** Buffer SFX shortcut, matching the frozen GameAudio method. */
  playSfx(assetId: string, opts?: { volume?: number; rate?: number; bus?: AudioBusName }): void;

  playMusic(assetId: string, opts?: MusicOptions): void;
  stopMusic(fadeMs?: number): void;
  readonly musicPlaying: boolean;

  registerRadioStation(station: RadioStation): void;
  tuneRadio(stationId: string, opts?: RadioOptions): void;
  stopRadio(fadeMs?: number): void;
  readonly radioStationId: string | null;

  /** Register an already-decoded buffer (asset decode path or tests). */
  registerBuffer(assetId: string, buffer: AudioBuffer): void;
  /** Drop a buffer when its asset handle is released; safe for unknown ids. */
  releaseBuffer(assetId: string): void;

  /** Once per simulation tick, after game.simulate and before render. Allocation-free. */
  update(dtSeconds: number): void;
  dispose(): void;                  // idempotent; not reusable
}
```

### 3.6 The frozen game-facing facade

`GameContext.audio` is frozen (`sdk/src/game-api.ts`, `GameAudio`) and must keep working unchanged:

```ts
export interface GameAudio {
  playSfx(id: string, opts?: { volume?: number; rate?: number }): void;
  playMusic(id: string, opts?: { loop?: boolean; fadeMs?: number }): void;
  stopMusic(fadeMs?: number): void;
  now(): number;
  readonly unlocked: boolean;
  readonly latencyHint: "interactive" | "balanced";
}
```

The runtime adapter implements `GameAudio` over `AudioSystem`: `playSfx` delegates to the `"sfx"` bus; `playMusic`/`stopMusic` delegate; `now()` returns `clock.now`; `unlocked` is `state === "unlocked"`; `latencyHint` is the construction hint. **No engine game receives `AudioSystem` directly until spec 18 adds an optional `GameContext.audio3d` member.** Spec 18 owns that additive SDK change; this spec owns the engine type.

### 3.7 Additive error codes

00 §5.9 allows new codes. This spec adds:

```ts
"E_AUDIO_DEVICE"     // context creation or resume failed fatally
"E_AUDIO_DECODE"     // decodeAudioData rejected, or a stream failed after one retry
"E_AUDIO_FORMAT"     // audio-mix.json or radio-stations.json invalid
"E_AUDIO_BUDGET"     // decoded buffers would exceed decodeBudgetBytes
```

None of these ever reaches `simulate` as an exception. They are recorded, counted, and surfaced in the debug overlay and the host notice panel where appropriate.

---

## 4. Data formats

### 4.1 Audio assets

Audio is declared in the game's `asset-manifest.json` (spec 06) with `kind: "audio"`. `engine-assets` fetches bytes only. **It does not decode audio**, because `decodeAudioData` needs an `AudioContext` and no context may exist before the unlock gesture (FR-9.11). `engine-audio` decodes after unlock and registers the buffer.

| Source format | Runtime use | Notes |
|---|---|---|
| Opus in Ogg (`.opus`) | SFX and short music, decoded | Preferred; Chromium and Firefox |
| Opus in WebM (`.webm`) | Streaming music/radio | `HTMLAudioElement` plays it |
| WAV (`.wav`) | Dev and test fixtures only | Never shipped in the production boot set |
| AAC/M4A (`.m4a`) | Optional streamed-music fallback | Only when `canPlayType` accepts it |

Decode/stream rules:

- An asset **streams** when `durationSeconds > 30` or `bytes > 1_048_576`; otherwise it decodes. A manifest entry may force either mode with `"streaming": true|false` (spec 06 owns the field; this spec consumes the resolved `AudioAssetValue`).
- A streamed asset resolves to `AudioAssetValue.kind === "stream"`; `engine-audio` creates the media element. A decoded asset resolves to `kind === "buffer"`.
- Decoded audio is charged against `decodeBudgetBytes` (default 32 MiB), computed as `length * numberOfChannels * 4` bytes (the backing float32 storage). Exceeding the budget fails that decode with `E_AUDIO_BUDGET` and leaves the previous buffer loaded. Streamed audio is not counted.
- Decode happens once per `assetId`. A duplicate `registerBuffer` replaces the buffer, releases the old one, and adjusts `decodedBytes`. `releaseBuffer` is a no-op for an unknown id.
- A decode failure is silent for that id (`E_AUDIO_DECODE`), never a thrown error into a game or a stopped loop.

### 4.2 `audio-mix.json` (optional, game root)

```json
{
  "formatVersion": 1,
  "masterVolume": 0.9,
  "buses": { "music": 0.6, "sfx": 1.0, "ambient": 0.8, "voice": 1.0, "ui": 0.9 },
  "sfxVoices": 8,
  "spatialVoices": 16,
  "defaults": {
    "distanceModel": "inverse",
    "panningModel": "equalpower",
    "refDistance": 1,
    "maxDistance": 100,
    "rolloff": 1
  }
}
```

Limits: UTF-8 JSON ≤ 4 KB; `formatVersion` must be `1`; every volume is finite in 0..1; `sfxVoices` and `spatialVoices` are integers in 1..32; `refDistance > 0`; `maxDistance > refDistance`; `rolloff` is in 0..10. Unknown fields are ignored. A malformed file fails the game load with `E_AUDIO_FORMAT` — never a silent fallback to defaults.

### 4.3 `radio-stations.json` (optional, game root)

```json
{
  "formatVersion": 1,
  "stations": [
    {
      "id": "vice-fm",
      "tracks": ["music/vice-fm-01", "music/vice-fm-02", "music/vice-fm-03"],
      "loop": true
    }
  ]
}
```

Limits: ≤ 16 KB; ≤ 32 stations; ids match `^[a-z0-9][a-z0-9-]{0,31}$` and are unique; 1..64 tracks per station; every track id exists in the asset manifest with `kind: "audio"`; `loop` defaults true. The engine registers stations at boot. `tuneRadio` with an unknown id is a counted no-op, not a throw.

### 4.4 Versioning

Both JSON files use `formatVersion: 1`. A reader refuses an unknown version with `E_AUDIO_FORMAT` and keeps the game playable in silence; it never guesses. Adding an optional field does not bump the version. Changing the meaning of an existing field does, and requires a migration note in `docs/todos/README.md` (00 §4.1).

### 4.5 Privacy and URLs

Audio URLs are same-origin and relative (00 §4.6). They never contain a room code, token, player name or session id. No audio data is uploaded or logged. Error messages name the asset id, never a URL with credentials.

---

## 5. Architecture

### 5.1 Modules

```
packages/engine/audio/src/
  AudioSystem.ts        facade: state machine, unlock, tick update, dispose
  AudioBus.ts           migrated M0 bus; frozen GameAudio behaviour preserved
  clock/AudioClock.ts   context clock, latency, performance conversion
  mixer/Mixer.ts        bus gains, master gain, mute, ramps
  mixer/BusGraph.ts     node graph construction and reconnection
  spatial/Listener.ts   listener position/orientation writes
  spatial/SpatialPool.ts positional voices
  voice/SfxPool.ts      non-positional one-shot voices
  voice/VoiceStealing.ts priority/age policy (pure)
  music/MusicPlayer.ts  decoded/streamed music, deck A
  music/RadioPlayer.ts  station playlist, prefetch, two-deck crossfade
  decode/decodeAudio.ts decodeAudioData wrapper, budget accounting
  config/mix.ts         audio-mix.json validation
  config/radio.ts       radio-stations.json validation
  types.ts              public types from §3
  index.ts              package exports
```

`AudioSystem` **composes** `AudioBus`; there is one `AudioContext`. `AudioBus` gains an internal `attachContext(context: BaseAudioContext)` seam used by `AudioSystem`; its public constructor keeps the existing injectable `createContext` for tests and for the M0 runtime. The M1 graph is built by `BusGraph` on the attached context, and `AudioBus`'s public methods route through the M1 graph once attached.

### 5.2 State machine

```
locked ──unlock() from a gesture──▶ unlocked
locked ──Web Audio absent / constructor throws──▶ unavailable
locked ──unlock() rejects with NotAllowedError──▶ locked   (gesture missing; retry later)
unlocked ──suspend()──▶ unlocked + suspended
unlocked + suspended ──resume()──▶ unlocked
unavailable                          terminal (only dispose changes it)
```

Rules:

- **No `AudioContext` is constructed before `unlock()`.** The constructor only records the factory and the options. This is the FR-9.11 rule and is tested by ER-09-01.
- `unlock()` is idempotent, never rejects, and coalesces concurrent calls into one promise. Two gestures racing produce one context.
- While `locked` or `unavailable`, `playSfx`/`play`/`playMusic`/`tuneRadio` are silent no-ops and `clock.now` is 0. `createSource` may still allocate a handle so a game's `init` does not branch on state.
- `suspend()` suspends the context when running and sets `suspended`; if the browser throws synchronously, set master gain to 0 and keep the context running (some TV browsers do this). `resume()` reverses it and re-applies the master gain.
- `dispose()` stops sources, closes the context, clears buffers and stations, and is safe to call twice. It is not reusable.
- A `statechange` to `"interrupted"` or `"suspended"` outside an explicit pause increments `stats.interruptions`; the next `resume()` retries once.

### 5.3 Graph and buses

```
BufferSource ─▶ sourceGain ─▶ [PannerNode] ─▶ busGain ─┐
MediaElementSource ─▶ deckGain ────────────▶ musicGain ─┤
                                                        ├─▶ masterGain ─▶ destination
Bus layout: music · sfx · ambient · voice · ui ─────────┘
```

| Bus | M0 | M1 | Intended content |
|---|---|---|---|
| master | yes | yes | one master gain; the only global volume |
| music | yes (`musicGain`) | yes | music decks and radio |
| sfx | yes (voice sum) | yes | pooled one-shots |
| ambient | no | yes | looping 2D ambience; M2 zones |
| voice | no | yes | dialogue; default priority 200 |
| ui | no | yes | menu/UI sounds; default priority 220 |

- One gain node per bus and one master gain. All gains are `AudioParam`s. Per-frame changes use `setTargetAtTime(value, now, 0.01)`; explicit fades use `linearRampToValueAtTime` or `setValueCurveAtTime` for equal-power curves.
- No compressor or limiter in M1: it would colour the existing M0 output. A master limiter is an M2 option (`limiter: true`), never implicit.
- A positional source gets a `PannerNode`; a non-positional source connects directly to its bus. Looping 2D ambience uses `ambient` and no panner.
- `stop()` disconnects and returns the voice to its pool after `source.onended`, or immediately if it never started a source.

### 5.4 Voice pools and stealing

- `sfxVoices` non-positional one-shot voices (default 8, matching today); `spatialVoices` positional voices (default 16).
- Each pooled voice owns its `GainNode` and, for spatial voices, its `PannerNode`, created once at unlock. An `AudioBufferSourceNode` is created per playback — the only unavoidable per-play allocation, as documented in the current `AudioBus`.
- A looping source created with `createSource({ loop: true })` reserves its voice until `destroySource`.
- **Stealing policy** (`VoiceStealing.ts`, pure and tested):
  1. Prefer a free voice.
  2. Otherwise consider the voice with the lowest `priority`.
  3. Ties go to the oldest `startedAt` (context time); then to the lowest voice index.
  4. Never steal a voice whose priority is **higher** than the request. If every voice is higher, drop the request and increment `stats.droppedPlays`.
  5. Steal with a 5 ms linear ramp to 0, then `stop()`; the voice is reusable immediately with a new source.
- `playSfx` requests priority 128. UI and voice use 200–220; distant ambience uses 32–64. A game that cares sets `priority` explicitly.

### 5.5 Positional model

- The listener is written **once per simulation tick**, from the camera, before `AudioSystem.update()` finishes: position and forward from the camera, up = world +Y unless the game supplies another up. The runtime passes the camera transform; `engine-audio` never reads a renderer object.
- `PannerNode` defaults: `panningModel: "equalpower"`, `distanceModel: "inverse"`, `refDistance: 1`, `maxDistance: 100`, `rolloff: 1`. `audio-mix.json` supplies the defaults; a game may override per source.
- Distance attenuation is the browser's `PannerNode` model. The engine does not implement a second attenuation curve, so a golden test compares the browser output against the documented formula, not against custom code.
- HRTF is opt-in per source. It is never enabled globally: it costs CPU per voice and is pointless on TV speakers.
- Listener and source position updates use the `positionX/positionY/positionZ` AudioParams with `setTargetAtTime(value, now, 0.01)` when those params exist; otherwise `setPosition`/`setOrientation`. Updates allocate nothing.
- Doppler is off by default. When enabled (M2), the rate multiplier is computed in `update(dt)` from relative velocity and clamped to 0.5..2.
- Occlusion and reverb sends (M2) are additive per-source fields. No M1 source may depend on them.

### 5.6 Music and radio streaming

- Two decks, A and B, each `HTMLAudioElement → MediaElementAudioSourceNode → deckGain → musicGain`. Two decks make crossfades and gapless station transitions possible without a second context.
- `playMusic` uses deck A, replacing the current track: stop the old deck with a `fadeMs` linear ramp, start the new deck, ramp in.
- `tuneRadio` uses the idle deck: start the station's current track, crossfade equal-power over `fadeMs` (default 1500 ms), then stop the old deck when its gain reaches 0. The idle deck preloads the next track (`preload="auto"`, muted) so a station transition does not wait for a network round trip.
- Track advance: on `ended`, the idle deck becomes active. When the next track's duration is known, the engine may schedule the switch up to 10 s early. Without a duration, advance on `ended` and accept a small gap.
- Every fade is scheduled on the audio clock (`currentTime`), never `setTimeout`. Suspending the context freezes both decks and the clock together, so a paused tab never drifts.
- If `createMediaElement` or `MediaElementAudioSourceNode` is unavailable, the deck plays directly through the element and applies `element.volume`; master/bus mute may not apply in this fallback, and `stats.streaming` still reports true. A failed stream (network or format) advances to the next track once, then records `E_AUDIO_DECODE` and stops.
- `musicPlaying` is true while either deck is audible; `radioStationId` is the tuned station or `null`. Music and radio share the `music` bus and are mutually exclusive in M1: tuning radio stops music and vice versa, with a crossfade between them.

### 5.7 Clock, latency and tick coupling

- `clock.now` is `AudioContext.currentTime`, the only time source for music, rhythm and fades (SPEC C8). It advances only while the context is running and is monotonic within a session.
- `clock.outputLatency` is `context.outputLatency` when finite, else `context.baseLatency`, else 0. Rhythmic games read it to compensate; the frozen `GameAudio` does not expose it.
- `performanceToAudio(perfMs)` = `now - (performance.now() - perfMs) / 1000`, clamped to `[0, now]`. It is a diagnostic bridge, never used inside `simulate` or to drive scheduling.
- Scheduling rules: a one-shot with no `at` starts at `now + 0.005 s` (5 ms lead, avoids "start in the past" clicks). A music start with a fade uses `now + 0.02 s` so the ramp has a stable anchor. An explicit `at` in the past clamps to `now + 0.005 s`. An explicit `at` beyond `now + 10 s` is clamped to `now + 10 s` so a bad value cannot pin the clock forever.
- The fixed loop calls `audio.update(dt)` **once per simulation tick, after `game.simulate` and before render** (spec 01 §3.7). `update` expires stopped voices, advances M2 Doppler, prefetches radio tracks, and refreshes `stats`. It never starts a source; starts happen synchronously when the game calls `play`.
- Audio calls from inside `simulate` are fire-and-forget presentation. They must not read back audio state that affects simulation, and a replay that is silent is still valid (00 §5.8).
- `pause()`/`suspend()` on the loop's pause reasons is integration work: hidden tab, host pause, menu and context loss hold a pause reason (spec 01 §5.3), and the runtime maps those holds to `audio.suspend()`/`audio.resume()`. Audio never owns a global event listener.

### 5.8 Unlock and the runtime gesture

- The host start screen / launcher activation is the gesture (FR-9.11). The runtime calls `audio.unlock()` from that handler; `AudioSystem` never attaches its own global click listener.
- A game calling `playSfx` during `init` is a silent no-op while locked. That is the existing documented behaviour and must not change.
- The start screen shows `locked`, `unlocked` or `unavailable` from the same state strings; no new UI states are introduced.
- One failed unlock due to a missing gesture leaves the state `locked`; the next gesture retries. Construction failures and missing Web Audio are terminal `unavailable`.
- `unlock()` is also callable from a gamepad button or a phone event only if that event is a trusted user activation in the host page. Otherwise it stays `locked`; the start screen remains the supported path.

### 5.9 Fallbacks

| Condition | Behaviour |
|---|---|
| `globalThis.AudioContext` missing | `unavailable`; all calls no-op; game runs silently |
| Context constructor throws | Close any partial context; `unavailable`; `E_AUDIO_DEVICE` counter |
| `context.resume()` throws `NotAllowedError` | Stay `locked`; retry on the next gesture |
| `suspend()` throws | Master gain 0; context keeps running; `suspended` true |
| `positionX` AudioParams missing | Use `setPosition`/`setOrientation` |
| HRTF unavailable | Force `panningModel: "equalpower"` |
| `MediaElementAudioSourceNode` unavailable | Direct element playback with `element.volume` |
| Stream fails | Advance one track, then `E_AUDIO_DECODE` and stop |
| Decode rejects | `E_AUDIO_DECODE`, silent for that id, game continues |
| Decoded budget exceeded | `E_AUDIO_BUDGET`, previous buffer retained |
| `setValueCurveAtTime` unavailable | Fall back to two `linearRampToValueAtTime` steps; crossfade golden tolerance widens by 1 dB |

The invariant: **audio failure never stops the loop, never throws into `simulate`, and never changes game state.**

### 5.10 Memory and lifetime

| Resource | Owner | Freed by |
|---|---|---|
| `AudioContext` and node graph | `AudioSystem` | `dispose()` |
| Decoded `AudioBuffer`s | `AudioSystem` registry | `releaseBuffer`, replacement, `dispose()` |
| Pooled voices (gain/panner nodes) | `AudioSystem` | `dispose()` only |
| Per-play `AudioBufferSourceNode` | Web Audio | automatic on `ended` |
| Streaming decks | `MusicPlayer`/`RadioPlayer` | `stopMusic`/`stopRadio`/`dispose` |
| `AudioSourceHandle` | caller | `destroySource`; stale handles are a counted no-op |

Teardown order on host dispose: stop radio → stop music → stop all sources → close context → clear registries. `dispose()` is idempotent. Stale handles are detected by generation, with `E_STALE_HANDLE` in dev and a counter in production (00 §5.7).

### 5.11 Hot-path and allocation rules

`update(dt)` and mixer writes allocate nothing. `playSfx`/`play` allocate only the unavoidable `AudioBufferSourceNode`. No `Array.prototype.map/filter/forEach`, no string concatenation, no closures in `update`. Gain ramps reuse preallocated constants. Voice selection is integer comparison over fixed arrays. `stats` is one reused object; a caller that retains it must copy fields. Debug counters use the fixed-capacity path from spec 16.

`AudioSystem` allocates everything at construction: voice tables, the stats object, the listener vectors, the clock wrapper, and one bound update function.

### 5.12 Determinism

Audio is presentation. Voice selection is deterministic for a given command order, but audio never feeds `simulate`, input, physics or the replay state hash (00 §5.8). A replay may be silent and still valid. Audio scheduling uses the audio clock, which is not part of simulation time and must not be read by game logic for decisions.

### 5.13 Migration of `AudioBus` (M0)

The M0 migration is behaviour-preserving. `packages/runtime/src/audio/AudioBus.ts` moves to `packages/engine/audio/src/AudioBus.ts`; the runtime path becomes a deprecated re-export for one wave, then is deleted at M1 (00 §5.13).

Every existing public member is preserved exactly:

| `AudioBus` member | Preserved behaviour |
|---|---|
| `constructor(options)` | Same options, same lazy factory, same `latencyHint` |
| `state`, `unlocked`, `paused`, `available` | Same state strings and meanings |
| `masterVolume`, `baseLatency`, `outputLatency` | Same values and fallback chain |
| `unlock()` | Lazy context creation, idempotent, never rejects |
| `setMasterVolume` | Clamped 0..1, immediate on the context clock |
| `registerSfx`, `registerMusic` | Same registries; music remains separate in M0 |
| `decodeAudio(Blob \| ArrayBuffer)` | Rejects while locked, as today |
| `playSfx`, `playMusic`, `stopMusic` | Same round-robin pool, same fades, same silent no-ops |
| `now()`, `pause()`, `resume()`, `dispose()` | Same semantics, including synchronous-throw handling |

`AudioSystem` in M0 delegates to `AudioBus` and adds only the `AudioClock`/`stats` views. The M1 cutover attaches the context and builds the bus graph; the frozen `GameAudio` adapter never changes.

---

## 6. File ownership

This spec owns `docs/engine/09-audio.md` and the implementation paths below. The integration agent owns `package.json`, `tsconfig.json`, the root Vitest project entry and the runtime adapter file; feature agents do not edit them concurrently (00 §6).

| Path | Milestone | Contents |
|---|---|---|
| `packages/engine/audio/src/types.ts` | M0 | Public types from §3; contract authority |
| `packages/engine/audio/src/index.ts` | M0 | Exports; no DOM leak beyond the documented entries |
| `packages/engine/audio/src/AudioBus.ts` | M0 | Migrated from `packages/runtime/src/audio/AudioBus.ts`; behaviour preserved, plus `attachContext` |
| `packages/engine/audio/src/AudioSystem.ts` | M0/M1 | State machine, composes the bus, owns the one context |
| `packages/engine/audio/src/clock/AudioClock.ts` | M0 | Clock, latency, performance conversion |
| `packages/engine/audio/src/mixer/Mixer.ts`, `BusGraph.ts` | M1 | Buses, master, mute, ramps |
| `packages/engine/audio/src/spatial/Listener.ts`, `SpatialPool.ts` | M1 | Listener writes and the positional pool |
| `packages/engine/audio/src/voice/SfxPool.ts`, `VoiceStealing.ts` | M0/M1 | Non-positional pool; pure stealing policy |
| `packages/engine/audio/src/music/MusicPlayer.ts`, `RadioPlayer.ts` | M1 | Two-deck streaming and crossfade |
| `packages/engine/audio/src/decode/decodeAudio.ts` | M1 | Decode wrapper and budget accounting |
| `packages/engine/audio/src/config/mix.ts`, `radio.ts` | M1 | Format validation |
| `packages/engine/audio/test/**` | all | Unit, property, golden, integration tests |
| `packages/engine/audio/test/fixtures/**` | all | Synthetic WAVs, mix/radio JSON, gain envelopes |
| `experiments/e-m1-audio/**` | M1 | Real-context probe and benchmark page (co-owned with spec 19) |
| `packages/runtime/src/audio/AudioBus.ts` | M0 migration | Deprecated re-export, deleted at M1 |
| `packages/runtime/src/game/GameContext.ts` | integration | `GameAudio` adapter over `AudioSystem`; spec 18 owns the SDK surface |

Not owned here: `sdk/src/game-api.ts` (spec 18), asset manifest parsing (spec 06), camera transforms (spec 04/05), the start screen (existing runtime owner), root build config (integration agent).

---

## 7. Acceptance

Every row has an `ER-09-NN` ID. Thresholds are acceptance targets, not measurements. A row is PASS only with a recorded build, device, browser version, date and numbers in `docs/RESULTS.md`; otherwise it says PENDING and names the run needed. Named hardware is the repo's baseline: Desktop Chrome 155 on Windows 11 (`pc-win11-rtx3050`, GPU adapter recorded).

| ID | Criterion | Fixture / method | Hardware | Evidence |
|---|---|---|---|---|
| ER-09-01 | No `AudioContext` exists before `unlock()`; after a gesture the state is `unlocked`; 10 concurrent and repeated `unlock()` calls construct exactly **one** context | `packages/engine/audio/test/unlock.test.ts` with an injected factory that counts constructions | CI Node 20 (fake context) | PENDING — M0 migration |
| ER-09-02 | Positional pan: sources at `x=-5` and `x=+5`, listener at origin facing `-Z`, 1 s of a 440 Hz tone rendered per channel; left/right RMS differs by **≥ 6 dB** with the correct sign in both directions | `experiments/e-m1-audio/?case=pan` using `OfflineAudioContext(2, 48000, 48000)`; golden WAV in `test/fixtures/pan/` | Desktop Chrome 155, Windows 11 | PENDING — M1 run |
| ER-09-03 | Distance attenuation follows the documented inverse model within **±1 dB** at 1 m, 5 m and 20 m (ref 1, rolloff 1, max 100) | `?case=distance` offline render; RMS compared to `ref/d` | Desktop Chrome 155, Windows 11 | PENDING — M1 run |
| ER-09-04 | Pools never exceed their configured size. With 64 equal-priority `playSfx` calls and a pool of 8, exactly 8 are audible and **`steals = 56` with `droppedPlays = 0`** (equal priority is stealable per §5.4; `droppedPlays` counts only plays that cannot be admitted at all); stealing picks the lowest priority, then the oldest, then the lowest index | `test/voiceStealing.property.test.ts` + `?case=voices` | CI (policy) + Desktop Chrome 155 | PENDING — M1 run |
| ER-09-05 | Equal-power radio crossfade over 1.5 s matches `cos/sin` within **±2%** at 10 sampled times; music start/stop linear ramps match within **±2%** | `?case=crossfade` offline render; golden samples in `test/fixtures/crossfade.json` | Desktop Chrome 155, Windows 11 | PENDING — M1 run |
| ER-09-06 | `clock.now` is monotonic and advances within **0.1%** of wall time over 10 s; a click scheduled at `now + 0.25` lands within **±2 ms** of sample 12,000 in a 48 kHz offline render | `?case=clock`; `AudioClock` unit test with a fake `currentTime` | Desktop Chrome 155 + CI fake | PENDING — M1 run |
| ER-09-07 | After unlock, `stats`/clock expose finite `baseLatency` and `outputLatency`; the measured values are recorded, not gated | `?case=latency&report=1`, values copied to `docs/RESULTS.md` | Desktop Chrome 155, Windows 11 | PENDING — M1 run |
| ER-09-08 | Hidden tab suspends audio; visible resumes the same track without restart and without a clock jump; `interruptions` stays 0 in the normal path | Browser integration driving `visibilitychange` through the runtime pause reasons | Desktop Chrome 155, Windows 11 | PENDING — M1 run |
| ER-09-09 | Missing or throwing Web Audio leaves `state="unavailable"`, every public call a silent no-op, no rejected promise, and the game loop stays green | `test/fallback.test.ts` with a throwing factory | CI Node 20 | PENDING — M0 |
| ER-09-10 | M0 migration parity: the existing `AudioBus` tests pass unchanged, and both reference games unlock audio from the start-screen gesture | `test/AudioBus.test.ts` (moved), `npm run check`, start-screen integration test | CI Node 20 + Desktop Chrome 155 | PENDING — M0 migration wave |
| ER-09-11 | Hot path allocates nothing: heap growth **≤ 256 KiB** over 600 frames after 120 warm-up frames; frame p95 regresses by **≤ +0.3 ms** versus the same scene with audio muted | `?case=alloc&bench=1` using `performance.memory`; frame times from the spec-16 profiler | Desktop Chrome 155, Windows 11 | PENDING — M1 run |
| ER-09-12 | Decoded audio stays **≤ `decodeBudgetBytes`** (default 32 MiB); streamed assets are excluded; exceeding the budget fails only the new asset and keeps the previous buffer | `test/budget.test.ts` | CI Node 20 | PENDING — M1 |
| ER-09-13 | TV: unlock from the remote's Enter, music/radio continuity across a hidden tab, and recorded latency on the named TV browsers | `experiments/e-m1-audio/?case=latency&report=1` | **PENDING device:** a 2020-era Android TV Chromium and a Tizen/webOS set from SPEC §12 | PENDING — no TV hardware |
| ER-09-14 | A 10,000-call random sequence of public API calls in every state (`locked`, `unlocked`, `suspended`, `unavailable`, disposed) throws nothing and never leaves the system in an inconsistent state; `dispose()` twice is a no-op | `test/audioSystem.property.test.ts` (`fast-check`) | CI Node 20 (fake context) | PENDING — M0/M1 |
| ER-09-15 | `audio-mix.json` and `radio-stations.json` validate per §4.2/§4.3: a complete document keeps every field; unknown fields are ignored; an out-of-range volume, a bad voice count, unordered distance defaults, a non-object root or invalid JSON fail with `E_AUDIO_FORMAT` and a JSON path; the 4 KB cap is exact; a station without `loop` defaults to true | `test/config.test.ts` | CI Node 20 | PENDING — M0 |

Budget targets are inherited from existing SPEC limits — frame p95 14 ms, hard fail 20 ms, host + game ≤ 5 MB gz — and are not new inventions.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | state machine, unlock idempotence and single context, volume clamps, bus mute, handle generations, config validation, budget accounting | `packages/engine/audio/test/*.test.ts` |
| Property (`fast-check`) | gain ramps are monotonic and end at the target; distance attenuation is monotonic non-increasing; stealing never evicts a higher priority; API calls never throw in any state | `test/audio.property.test.ts`, `test/voiceStealing.property.test.ts` |
| Golden / offline | pan, distance, crossfade and clock scheduling rendered with `OfflineAudioContext` in the browser page; WAV/JSON fixtures under `test/fixtures/` | `test/golden/*.test.ts` (runner in the page) + `experiments/e-m1-audio/` |
| Integration | start-screen gesture unlocks; pause reasons suspend/resume; audio unavailable leaves the game running; the runtime adapter implements `GameAudio` unchanged | `packages/runtime/test/audioIntegration.test.ts` |
| Benchmark | `update` cost, frame-time delta with audio on/off, heap growth, voice counts | `experiments/e-m1-audio/?bench=1` |
| Manual | TV unlock/latency/continuity, Bluetooth speaker latency, mute behaviour | `docs/RESULTS.md` rows ER-09-07/13 |

Rules:

- CI never constructs a real `AudioContext`; it injects a fake `BaseAudioContext` that records calls. Real Web Audio runs only in the browser page.
- Offline-render goldens store sample rate, channel count, tone frequency and the expected RMS/gain samples in the fixture, so the test is reproducible.
- No fixed sleeps for audio scheduling; wait on `ended`, promise resolution or an explicit render boundary.
- Every test title carries its `ER-09-NN` tag, and the tag resolves to a row in `docs/todos/TRACEABILITY.md` once the engine programme is registered.
- A failing audio test is never skipped to land a wave. Browser-only coverage is a page plus a recorded manual result, never a deleted test.

---

## 9. Dependencies

| Dependency | Why | State |
|---|---|---|
| Spec 00 | Package boundary, one-writer rule, migration map, error taxonomy, DOM allowance | written |
| Spec 01 | Fixed tick, `EngineFrame`, where `update(dt)` is called | written |
| Spec 02 | `Vec3`/`Quat` conventions for listener and source positions | written |
| Spec 06 | Audio asset entries, fetch-only bytes, stream-vs-decode metadata | written; M0 uses the existing `AssetLoader` blob path |
| Spec 04/05 | Camera transform supplied to `listener.setFromTransform` | written; runtime passes a plain `Vec3`/`Quat` |
| Spec 16 | Profiler and the allocation benchmark page | written |
| Spec 18 | Additive `GameContext.audio3d` exposure; frozen `GameAudio` remains | written; required before games use positional audio |
| Spec 19 | Benchmark harness and `docs/RESULTS.md` rows | written |
| `packages/runtime` | Composition root, start-screen gesture, `GameAudio` adapter, pause-reason mapping | integration agent owns |

Package rule: `engine-audio` imports `engine-core` only. It does not import `@lanpad/protocol`, `@lanpad/sdk`, `@lanpad/runtime` or a game, and it has no third-party runtime dependency. DOM and Web Audio access is confined to `engine-audio` modules named in §5.1 (00 D11); the pure voice-stealing and config validators have no DOM dependency and run in Node.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| A1 | Browser autoplay policy blocks unlock on a TV or an unusual browser | Medium | No sound for the session | Stay `locked` on `NotAllowedError` and retry on the next gesture instead of failing terminally; the start screen already requires a gesture |
| A2 | TV audio output latency is large and variable (100–300 ms, worse over Bluetooth) | High | Rhythm games feel wrong; lip-sync off | Report `baseLatency`/`outputLatency`; schedule on the audio clock; rhythm compensation is game/experiment work; TV rows stay PENDING until measured |
| A3 | Media-element streaming is silent through `MediaElementAudioSourceNode` (CSP/media error) | Medium | Music/radio silent while SFX work | Same-origin URLs only; one-track advance on error; direct-element fallback documented in §5.9 |
| A4 | HRTF panning costs too much with 16 voices on a weak TV CPU | Medium | Frame drops | HRTF is opt-in per source; equal-power default; spatial pool is configurable downward |
| A5 | Voice exhaustion in a dense city scene | High in M2 | Important sounds dropped | Priority, deterministic stealing, `droppedPlays`, per-bus pools |
| A6 | Decoded audio memory grows past the TV memory ceiling | Medium | Tab crash on TV | 32 MiB default budget, stream long assets, per-asset failure keeps the prior buffer |
| A7 | Context sample rate differs from the asset (44.1 vs 48 kHz) | Certain | Pitch/length surprises if assumed | Never assume a sample rate; schedule in context time; pitch is `playbackRate` only |
| A8 | `suspend()`/`resume()` misbehave on TV Chromium | Medium | Audio continues on a hidden tab or stays silent | Master-gain mute fallback; `statechange` tracking; one retry per resume |
| A9 | Offline-render goldens drift across Chrome versions | Low | Flaky CI | Goldens assert RMS/gain envelopes with tolerances, not raw samples; the browser version is recorded |
| A10 | Per-play node allocation causes GC spikes in a dense scene | Medium | Frame spikes | Voice pooling; one `AudioBufferSourceNode` per play (documented); no allocation in `update`; allocation benchmark |
| A11 | Scope creeps into occlusion/reverb/adaptive music before M1 | High | Nothing ships | §2 and the milestone tags are normative; M2 features are additive per-source fields only |
| A12 | A second `AudioContext` is created by a game or adapter | Low | Device contention, doubled latency | `AudioSystem` is the only construction site; test ER-09-01; code review |
| A13 | Moving `AudioBus` breaks frozen `GameAudio` or the start screen | Medium at M0 | Non-green tree | Behaviour-preserving move, existing tests moved with it, deprecated re-export, start-screen golden |
| A14 | Tokens or session data leak into audio URLs or logs | Low | Security regression | Same-origin asset ids only; no URL logging; error messages name the asset id (00 §5.9) |
| A15 | Two decks plus prefetch doubles network use on a slow LAN | Low | Radio stalls on a weak connection | Prefetch only one track ahead, `preload="auto"`, and degrade to `ended` switching without prefetch |

**Fallback if this spec cannot be implemented on a target:** the game runs with the M0 `AudioBus` (2D, eight voices) or silently. The engine never fails a game because audio is unavailable, and never claims a latency or panning result that was not measured on the named device.
