/**
 * Failure-screen content (05 §3.5, ER-05-12). Fixed copy only.
 *
 * The host owns the DOM element, focus and remote bindings. This module owns
 * the text and hints, and must never emit tokens, room codes, player names,
 * filesystem paths or credentialed URLs (SR-2, SR-9).
 */

import type { EngineFeature } from "@lanpad/engine-core";
import type {
  BackendFailureCode,
  BackendFailureNotice,
} from "./contracts/webgl2.js";
import { describeMissingFeature } from "./features.js";

const BROWSER_HINTS = [
  "Update your browser to the latest version.",
  "Use a PC connected to the TV with an HDMI cable.",
  "Try another device.",
] as const;

const FEATURE_HINTS = [
  "Update your browser.",
  "Try a desktop browser.",
] as const;

const INIT_HINTS = [
  "Reload the page.",
  "Close other tabs that use 3D graphics.",
  "Update your browser.",
] as const;

const LOST_HINTS = ["Reload the page."] as const;

const DRAW_HINTS = ["Update your browser.", "Try another device."] as const;

const NO_FEATURES: readonly EngineFeature[] = [];

/** Builds the fixed-copy failure notice (05 §3.5). */
export function createBackendFailureNotice(input: {
  readonly code: BackendFailureCode;
  readonly browserName: string;
  readonly backendTried: "webgpu" | "webgl2" | "canvas2d" | "none";
  readonly gameName?: string;
  readonly missingFeatures?: readonly EngineFeature[];
  readonly detail?: string;
}): BackendFailureNotice {
  const browser = input.browserName;
  const missing = input.missingFeatures ?? NO_FEATURES;

  switch (input.code) {
    case "E_DEVICE_UNAVAILABLE":
      if (input.backendTried === "canvas2d") {
        return notice(
          input.code,
          "Cannot draw on this device",
          `${browser} could not create a 2D or 3D drawing context.`,
          NO_FEATURES,
          DRAW_HINTS,
          false,
          input.detail ?? "no-2d-or-3d-context",
        );
      }
      return notice(
        input.code,
        "3D graphics are not available",
        `${browser} cannot create a 3D graphics context, so this game cannot run on this device.`,
        NO_FEATURES,
        BROWSER_HINTS,
        false,
        input.detail ?? "no-3d-context",
      );

    case "E_RENDERER_UNAVAILABLE":
      return notice(
        input.code,
        "Cannot draw on this device",
        `${browser} could not create a 2D or 3D drawing context.`,
        NO_FEATURES,
        DRAW_HINTS,
        false,
        input.detail ?? "no-tier",
      );

    case "E_UNSUPPORTED_FEATURE":
      if (input.detail === "3d-on-canvas2d") {
        return notice(
          input.code,
          "This game needs 3D graphics",
          "This device provides only 2D drawing. This game requires a 3D renderer.",
          NO_FEATURES,
          BROWSER_HINTS,
          false,
          "3d-on-canvas2d",
        );
      }
      if (missing.length > 0) {
        let message = "";
        for (let index = 0; index < missing.length; index += 1) {
          const feature = missing[index];
          if (feature === undefined) continue;
          if (message.length > 0) message += " ";
          message += describeMissingFeature(feature);
        }
        return notice(
          input.code,
          "This game needs a graphics feature this device lacks",
          message,
          missing,
          FEATURE_HINTS,
          false,
          input.detail ?? "missing-feature",
        );
      }
      return notice(
        input.code,
        "This game needs a graphics feature this device lacks",
        "This game requires a graphics feature this device does not provide.",
        NO_FEATURES,
        FEATURE_HINTS,
        false,
        input.detail ?? "unsupported-feature",
      );

    case "E_BACKEND_INIT":
      return notice(
        input.code,
        "Graphics could not start",
        `${browser} has 3D graphics, but the context failed to initialize.`,
        NO_FEATURES,
        INIT_HINTS,
        true,
        input.detail ?? "backend-init",
      );

    case "E_DEVICE_LOST":
      return notice(
        input.code,
        "Graphics was reset",
        "The graphics device was reset and could not be restored. The game was stopped to protect your device.",
        NO_FEATURES,
        LOST_HINTS,
        true,
        input.detail ?? "device-lost",
      );
  }
}

function notice(
  code: BackendFailureCode,
  title: string,
  message: string,
  missingFeatures: readonly EngineFeature[],
  hints: readonly string[],
  canRetry: boolean,
  detail: string,
): BackendFailureNotice {
  return Object.freeze({
    code,
    title,
    message,
    missingFeatures,
    hints,
    canRetry,
    detail,
  });
}
