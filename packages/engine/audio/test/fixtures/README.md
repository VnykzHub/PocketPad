# Audio fixtures

Data-only contract fixtures for `@lanpad/engine-audio`. They record rules
stated by `docs/engine/09-audio.md`; they are not measurements and carry no
device, browser, frame-time or memory result. No test file reads them in this
wave.

| File | Contents |
|---|---|
| `bus-cases.json` | State-machine, option clamp, mixer, voice-pool/stealing and scheduling cases from 09 §3–§5. |
| `positional-cases.json` | Listener transform, inverse-distance attenuation, pan-sign and Doppler-bound cases from 09 §3.2 and §5.5. |
| `format-matrix.json` | Accepted codecs/containers, fallback order, stream-vs-decode routing and decode-budget rules from 09 §4.1. |

All values are synthetic contract data. Asset ids, station ids and positions
are illustrative, never production content. Files contain no dates, tokens,
room codes or player data.

`bus-cases.json` records both the 09 §5.4 equal-priority steal rule and the
ER-09-04 expectation (`64` calls into a pool of `8` yields `droppedPlays: 56`)
as separate cases. They conflict; the disagreement is recorded, not resolved.

Adding a fixture requires a matching rule in 09. A fixture never asserts a
latency, size or hardware result.
