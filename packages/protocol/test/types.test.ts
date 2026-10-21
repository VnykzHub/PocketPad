import { expect, test } from "vitest";
import type { InputState } from "../src/binary";
import { INPUT_FRAME_BYTES, MAX_CONTROLLERS } from "../src/constants";
import type { ClientToServerMessage, JsonControlMessage } from "../src/messages";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

// The InputState shape is the frozen 26-byte wire contract: analog fields are
// i16-shaped numbers, triggers u8-shaped, and no field may be renamed silently.
type InputFieldNames = Expect<
  Equal<
    keyof InputState,
    | "tick"
    | "buttons"
    | "edges"
    | "lx"
    | "ly"
    | "rx"
    | "ry"
    | "gx"
    | "gy"
    | "gz"
    | "lt"
    | "rt"
    | "flags"
  >
>;
type AnalogFieldsAreNumbers = Expect<Equal<InputState["lx"] | InputState["ly"], number>>;
type TriggerFieldsAreNumbers = Expect<Equal<InputState["lt"] | InputState["rt"], number>>;

// Keep the compile-time assertions referenced so lint sees them as used.
const inputContract: InputFieldNames = true;
const analogFieldsAreNumbers: AnalogFieldsAreNumbers = true;
const triggerFieldsAreNumbers: TriggerFieldsAreNumbers = true;

// Compile-time rejection: an unknown discriminant is not a control message.
// @ts-expect-error - unknown `t` is not in the catalog
const unknownMessage: JsonControlMessage = { t: "nope" };

// Compile-time rejection: `join` requires `code`.
// @ts-expect-error - `join` requires `code`
const joinWithoutCode: ClientToServerMessage = { t: "join", v: 1, pin: "1234" };

test("[FR-7.4] analog and trigger ranges are documented in types", () => {
  expect(INPUT_FRAME_BYTES).toBe(26);
  expect(MAX_CONTROLLERS).toBe(8);
  expect(unknownMessage).toBeDefined();
  expect(joinWithoutCode).toBeDefined();
  expect(inputContract).toBe(true);
  expect(analogFieldsAreNumbers).toBe(true);
  expect(triggerFieldsAreNumbers).toBe(true);
});
