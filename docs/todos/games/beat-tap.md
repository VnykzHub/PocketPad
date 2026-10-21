# Game: Beat Tap

| Field | Value |
|---|---|
| Stage | P6 (ambitious, wave 3) — gated by E11 audio calibration |
| Spec | `SPEC.md` §17.4 Beat Tap |
| Capabilities | C1 buttons, C8 audio sync |
| Goals | G2 timing, G5 haptics optional, G8 |
| Depends on | D3 audio, E11 result, D2 edges, P6-DOCS-01 charts |
| Work-item prefix | `GAME-BT-*` |

## Gate

Do not start unless E11 shows TV audio latency is measurable and calibratable (or the game includes a calibration step that users can complete). If E11 fails, defer Beat Tap. Record the decision.

## Minimal (v1 acceptance)

**Gameplay contract**

- Four lanes; notes scroll toward a hit line.
- One chart (JSON) with CC0 or self-composed music; no copyrighted songs.
- Timing windows: perfect/good/miss; combo and score.
- A calibration step (tap to a beat) sets a per-device audio offset; the game stores it locally (no account).
- Minimal mode: 2 players, 2 lanes each, same chart; other players can watch. Full adds modes.
- Song ends → results screen with score/combo/accuracy; replay.

**Host work items**

- [ ] `GAME-BT-HOST-01` — Audio clock: use `AudioContext.currentTime` as the master; schedule notes against it; never use `Date.now()` for hit timing.
- [ ] `GAME-BT-HOST-02` — Chart loader/validator: notes sorted, times in range, lanes 0–3, BPM offset; reject invalid charts.
- [ ] `GAME-BT-HOST-03` — Judging: combine the controller's press time (synced `tick`) with the audio clock and calibration offset; score perfect/good/miss; combo; no double hit per note.
- [ ] `GAME-BT-HOST-04` — Calibration: a tap-to-beat screen computes an offset; store per host in localStorage; show the value; allow reset.
- [ ] `GAME-BT-HOST-05` — Presentation: lanes, notes, hit line, combo, score, results; beat-synced visual pulse; reduced-motion option.
- [ ] `GAME-BT-HOST-06` — Reconnect: a player can rejoin; notes continue; missed notes are misses (documented).

**Controller work**

- [ ] `GAME-BT-CTRL-01` — Layout `bt-lanes-v1`: four large lane buttons (or two per player), 44 px, multi-touch; same-frame press.
- [ ] `GAME-BT-CTRL-02` — Press edges only; no axis; haptic pulse per hit (Full/optional).
- [ ] `GAME-BT-CTRL-03` — Calibration mode: a single tap button with clear instructions.
- [ ] `GAME-BT-CTRL-04` — Show lane feedback and "miss" state locally.

**Data / content**

```json
// packs/charts-demo-v1.json
{
  "id": "charts-demo-v1",
  "type": "chart",
  "license": "CC0-1.0",
  "items": [
    {
      "id": "demo-120bpm",
      "title": "Demo 120",
      "audio": "audio/demo-120.opus",
      "bpm": 120,
      "offsetMs": 0,
      "notes": [{ "timeMs": 1000, "lane": 0 }]
    }
  ]
}
```

- [ ] `GAME-BT-DATA-01` — At least one CC0/self-composed track + chart; audio WebM/Opus with AAC fallback; record the license.
- [ ] `GAME-BT-DATA-02` — Config: `perfectMs: 40`, `goodMs: 90`, `missMs: 140`, `calibrationOffsetMs`, `lanes: 4`.

**Tests / acceptance**

- [ ] `GAME-BT-TEST-01` — Judging windows at the boundaries; combo/score.
- [ ] `GAME-BT-TEST-02` — Audio clock scheduling: notes fire at the right `currentTime`; pause/resume handled.
- [ ] `GAME-BT-TEST-03` — Calibration offset shifts judging correctly; reset works.
- [ ] `GAME-BT-TEST-04` — Chart validation rejects unsorted/out-of-range notes.
- [ ] `GAME-BT-TEST-05` — 2-player split lanes; independent hits; no cross-talk.
- [ ] `GAME-BT-TEST-06` — Reconnect mid-song; no duplicate judging.
- [ ] `GAME-BT-PERF-01` — Note rendering and audio within frame budget.

**Anti-rework**

- Charts/audio are packs; no hard-coded songs.
- The audio clock is the single time source; no `Date.now()` judging.
- Calibration is a host setting, not a game-specific hack.

## Full version (post-v1 backlog)

- [ ] Several songs, difficulty levels.
- [ ] Chart editor and import.
- [ ] Calibration wizard with visual/audio feedback.
- [ ] Per-hit haptics on Android.
- [ ] Results breakdown, accuracy, local best scores.
- [ ] More lane layouts and 4-player modes.

## Risks / watch-outs

- **TV audio latency (E11)** can be 50–300 ms, especially Bluetooth; calibration is mandatory.
- **Copyright:** use CC0/self-made audio only; record licenses.
- **Audio unlock:** the host start screen must unlock audio before the chart starts.
- **Timing fairness:** controller `tick` sync (E9) plus calibration; document the combined error.
- **Visual latency:** the note scroll is rendered, not audio-driven; keep both in sync.

## Acceptance checklist

- [ ] E11 gate positive or game deferred.
- [ ] Minimal chart playable and scored.
- [ ] Audio-clock judging and calibration tests pass.
- [ ] Chart/audio licenses recorded.
- [ ] Reconnect behavior documented.
- [ ] Budget/frame metrics recorded.
- [ ] No platform changes required.
