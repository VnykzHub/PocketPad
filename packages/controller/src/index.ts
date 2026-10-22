/**
 * @lanpad/controller — controller layer (D0-CTRL-01, D4-CTRL-01/02).
 *
 * Public surface: URL route parsing, the controller network client and the D4
 * session pieces it is built from (join flow, session store, reconnect,
 * suspend/Wake Lock lifecycle and the connection pill model). The page shell
 * (`src/main.ts`) is a Vite entry, not a library export.
 */
export * from "./route.js";
export * from "./net/controllerClient.js";
export * from "./join/joinFlow.js";
export * from "./join/ManualJoin.js";
export * from "./join/sessionStore.js";
export * from "./net/reconnect.js";
export * from "./lifecycle/suspend.js";
export * from "./lifecycle/wakeLock.js";
export * from "./ui/ConnectionPill.js";
export * from "./controls/control.js";
export * from "./controls/registry.js";
export * from "./controls/eventSink.js";
export * from "./controls/panel.js";
export * from "./controls/strokeBatcher.js";
export * from "./controls/textInput.js";
export * from "./events/EventQueue.js";
export * from "./layout/viewport.js";
export * from "./sensors/MotionEnable.js";
export * from "./sensors/motionPermission.js";
export * from "./sensors/MotionSource.js";
export * from "./sensors/calibration.js";
export * from "./sensors/remap.js";
export * from "./sensors/lowPass.js";
export * from "./haptics/HapticPlayer.js";
export * from "./haptics/toggle.js";
