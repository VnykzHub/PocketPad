/**
 * Default desktop action map (10 §5.9).
 *
 * Phones use `slot: "self"` so the same map works for every player. The
 * bindings mirror the accepted layout: WASD + arrows + left phone stick +
 * left pad stick, and so on. `Escape` appears as a game binding here; it is
 * reserved for UI/capture, which is why `pause` also has `KeyP`.
 */

import type { InputAction } from "../contracts/input.js";

/** Returns a fresh copy so callers cannot mutate a shared map. */
export function defaultDesktopMap(): InputAction[] {
  return [
    {
      name: "move",
      kind: "vector2",
      yUp: true,
      deadzone: 0.15,
      output: { stick: "left" },
      bindings: [
        { device: "keyboard", code: "KeyW", component: "y", scale: -1 },
        { device: "keyboard", code: "KeyS", component: "y", scale: 1 },
        { device: "keyboard", code: "KeyA", component: "x", scale: -1 },
        { device: "keyboard", code: "KeyD", component: "x", scale: 1 },
        { device: "keyboard", code: "ArrowUp", component: "y", scale: -1 },
        { device: "keyboard", code: "ArrowDown", component: "y", scale: 1 },
        { device: "keyboard", code: "ArrowLeft", component: "x", scale: -1 },
        { device: "keyboard", code: "ArrowRight", component: "x", scale: 1 },
        { device: "phone", slot: "self", channel: "axis", axis: "lx" },
        { device: "phone", slot: "self", channel: "axis", axis: "ly" },
        {
          device: "gamepad",
          pad: "self",
          axis: 0,
          component: "x",
        },
        {
          device: "gamepad",
          pad: "self",
          axis: 1,
          component: "y",
        },
      ],
    },
    {
      name: "look",
      kind: "vector2",
      deadzone: 0.15,
      output: { stick: "right" },
      bindings: [
        { device: "phone", slot: "self", channel: "axis", axis: "rx" },
        { device: "phone", slot: "self", channel: "axis", axis: "ry" },
        {
          device: "gamepad",
          pad: "self",
          axis: 2,
          component: "x",
        },
        {
          device: "gamepad",
          pad: "self",
          axis: 3,
          component: "y",
        },
      ],
    },
    {
      name: "primary",
      kind: "button",
      output: { button: 0 },
      bindings: [
        { device: "keyboard", code: "Space" },
        { device: "keyboard", code: "Enter" },
        { device: "gamepad", pad: "self", button: 0 },
      ],
    },
    {
      name: "secondary",
      kind: "button",
      output: { button: 1 },
      bindings: [
        { device: "keyboard", code: "ShiftLeft" },
        { device: "gamepad", pad: "self", button: 1 },
      ],
    },
    {
      name: "interact",
      kind: "button",
      output: { button: 2 },
      bindings: [
        { device: "keyboard", code: "KeyE" },
        { device: "gamepad", pad: "self", button: 2 },
      ],
    },
    {
      name: "pause",
      kind: "button",
      output: { button: 9 },
      bindings: [
        { device: "keyboard", code: "Escape" },
        { device: "keyboard", code: "KeyP" },
        { device: "gamepad", pad: "self", button: 9 },
      ],
    },
    {
      name: "back",
      kind: "button",
      output: { button: 8 },
      bindings: [
        { device: "keyboard", code: "Backspace" },
        { device: "gamepad", pad: "self", button: 8 },
      ],
    },
  ];
}
