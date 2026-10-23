# Input fixtures (synthetic, data only)

These files are part of the W0 contract surface for `@lanpad/engine-input`
(spec 10, `docs/engine/10-input.md`). They contain **synthetic data only**:
no real keystroke logs, no player names, room codes, tokens, session ids or
other PII. Nothing here is a measurement. No fixture contains a date; map
documents have no timestamp member, and the optional overlay `updatedAt`
described by spec 10 §4.2 is not used by any file here.

Consumers: the `tools/engine-test` conformance rig and the future
`packages/engine/input/test/*.test.ts` suites named in spec 10 §8. The web
protocol is not involved; the engine never imports `@lanpad/protocol`.

## Files

| File | Purpose |
|---|---|
| `action-map-valid.json` | A valid `input.map.json` exercising every binding kind, every pointer axis, every phone axis name, every output member and explicit `component`/`scale`/`threshold`/`hysteresis`/`yUp`/`deadzone` values. |
| `action-map-valid-unknown-fields.json` | A valid map with unknown root/action/binding/output fields. Spec 10 §4.1 says unknown fields are ignored, so this file must load successfully. |
| `action-map-invalid/*.json` | One deliberate violation per file. The table below gives the expected `E_INPUT_FORMAT` JSON path. |
| `deadzone-cases.json` | Raw source value to expected `ActionState` fields for the pure resolver. |
| `tick-order.json` | Input operation placement on the seven-step host tick. It references the core fixture instead of duplicating it. |

## Action-map limits (spec 10 §4.1, §4.2)

- UTF-8 JSON <= 32 KB (`input.map.json`) or <= 16 KB (`input-bindings.json`).
- `formatVersion` must be `1`.
- <= 64 actions in a map; <= 64 keys in an overlay.
- 1..15 bindings per action; action names match `^[a-z][a-z0-9_.-]{0,47}$`
  and are unique and case-sensitive.
- `deadzone` 0..0.9, `threshold` 0.01..1, `hysteresis` 0..0.5, `scale`
  finite in -4..4, `bit` 0..15, phone `slot` 0..7 or `"self"`, gamepad `pad`
  0..3 or `"self"`, gamepad button 0..16, gamepad axis 0..3.
- A gamepad binding sets exactly one of `button`/`axis`; a pointer binding
  sets exactly one of `button`/`axis`.
- `output` has exactly one member and its type matches the action kind.
- `yUp` is valid only on `vector2`.
- A scalar source on a `vector2` action needs an explicit `component`;
  phone `lt`/`rt` always need one there.

The byte-size and action-count caps are not represented as static files; the
future property tests in spec 10 ER-10-13 generate those cases. Every map
fixture here is far below the byte caps.

## Invalid maps and expected paths

The validator reports `E_INPUT_FORMAT` with the JSON path of the first
violation and does not start the game with a half-loaded map.

| File | Expected path |
|---|---|
| `action-map-invalid/format-version-2.json` | `formatVersion` |
| `action-map-invalid/duplicate-action.json` | `actions[1].name` |
| `action-map-invalid/bad-name.json` | `actions[0].name` |
| `action-map-invalid/unknown-kind.json` | `actions[0].kind` |
| `action-map-invalid/bad-deadzone.json` | `actions[0].deadzone` |
| `action-map-invalid/bad-threshold.json` | `actions[0].threshold` |
| `action-map-invalid/bad-hysteresis.json` | `actions[0].hysteresis` |
| `action-map-invalid/yup-on-button.json` | `actions[0].yUp` |
| `action-map-invalid/output-two-members.json` | `actions[0].output` |
| `action-map-invalid/output-kind-mismatch.json` | `actions[0].output` |
| `action-map-invalid/empty-bindings.json` | `actions[0].bindings` |
| `action-map-invalid/too-many-bindings.json` | `actions[0].bindings` |
| `action-map-invalid/unknown-device.json` | `actions[0].bindings[0].device` |
| `action-map-invalid/unknown-channel.json` | `actions[0].bindings[0].channel` |
| `action-map-invalid/gamepad-button-and-axis.json` | `actions[0].bindings[0]` |
| `action-map-invalid/pointer-button-and-axis.json` | `actions[0].bindings[0]` |
| `action-map-invalid/bad-scale.json` | `actions[0].bindings[0].scale` |
| `action-map-invalid/bad-bit.json` | `actions[0].bindings[0].bit` |
| `action-map-invalid/bad-slot.json` | `actions[0].bindings[0].slot` |
| `action-map-invalid/bad-pad.json` | `actions[0].bindings[0].pad` |
| `action-map-invalid/lt-vector-no-component.json` | `actions[0].bindings[0].component` |

## Deadzone cases

`deadzone-cases.json` is self-describing:

```
{ id, kind, deadzone, threshold, hysteresis, yUp,
  previous: { pressed, engaged },
  raw: { x?, y?, value?, level? },
  pending?: { press, release },
  expect: { x, y, value, pressed, engaged, edges, released, releaseEdges } }
```

`kind` is one of:

- `radial` — a stick pair, deadzoned by magnitude.
- `scalar` — one analog axis or trigger, deadzoned by absolute value.
- `digital` — a key/pointer/gamepad button level (0 or 1) with pending edges.
- `button-analog` — an analog gamepad button on a `button` action; the
  action's `pressed` follows engagement, including the hysteresis hold band.

Formulas (spec 10 §5.8.2):

```
radial:  m = hypot(x, y)
         m <= dz -> x' = 0, y' = 0
         else    -> s = (m - dz) / (1 - dz); x' = x/m*s; y' = y/m*s
scalar:  |v| <= dz -> 0
         else      -> sign(v) * (|v| - dz) / (1 - dz)
```

`x`/`y` are the stored action fields; `value` is the vector magnitude after
merge, capped at 1. `yUp` negates the stored `y` **after** `value` is
computed. The tolerance for numeric comparison is `1e-9` by default.

Edge layout is 16-bit: bit 0 is the aggregate action, bit `i + 1` is binding
`i`. These fixtures resolve one binding, so a press is `edges = 3` and a
release is `releaseEdges = 3`.

`released` follows spec 10 §5.8.4 literally: for axis/vector2 actions it is
`value <= threshold - hysteresis`; for button actions it is the complement of
per-binding engagement. It is therefore `true` on an action that was never
pressed. It is a level signal, not an event; consumers use the edge masks for
events.

Phone sticks already carry the controller's 8% deadzone (SPEC FR-7.4). The
engine does not apply it again; `phone-legacy-8pct-not-reapplied` records
that an engine deadzone of 0 leaves the received value unchanged.

## Tick order

`tick-order.json` references
`packages/engine/core/test/conformance/tick-order.json` for the seven host
steps and adds only input operations:

- step 1: tilt is copied into the router;
- step 2: `InputRouter.poll(loop.tick)` exactly once, before `simulate`;
- step 3: the runtime adapter updates the legacy `InputReader`;
- step 5: `game.simulate` may read the frame, never mutate it.

A second `poll` with the same tick returns the existing frame and emits no
new edges. A decreasing tick is `E_INPUT_TICK` in development and ignored in
production. `poll` is forbidden inside `simulate` and inside the render pass,
as are `setBindings`, `reset`, `beginCapture`, `cancelCapture` and
`saveBindings`.

## Known spec ambiguities recorded by these fixtures

- **Slot base.** Spec 10 uses engine slots 0..7; the frozen SDK and runtime
  use slots 1..8 (`GameControllerState.slot`, `GameInputSnapshot.players`
  index = slot - 1). The runtime adapter owns the +1 mapping. The contract
  exposes engine slots as 0..7.
- **Axis `component` default.** Spec 10 §5.8.3 says a scalar source defaults
  to `x` when `component` is omitted, but the §4.1 example omits it on
  gamepad axis 1. The valid fixture declares `component` explicitly on every
  gamepad axis so it does not depend on the unresolved default.
- **`Escape` role.** The default map binds `Escape` to `pause`, while the
  rebinding rules make `Escape` reserved and never bindable. Rebinding is
  about future assignments; the default map is shipped data. The valid
  fixture avoids `Escape` and uses `KeyP` for `pause` so no test depends on
  the conflict.
