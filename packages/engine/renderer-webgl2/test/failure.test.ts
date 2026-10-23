/**
 * ER-05-12: fixed failure-screen copy (05 §3.5).
 *
 * The host owns the DOM. This module owns the text, hints and machine detail;
 * these tests pin the exact copy, the branch precedence and the promise that
 * no game name, token, room code or URL can reach the notice.
 */

import { describe, expect, test } from "vitest";
import type { EngineFeature } from "@lanpad/engine-core";
import type { BackendFailureCode } from "../src/contracts/webgl2.js";
import { createBackendFailureNotice } from "../src/failure.js";
import {
  describeMissingFeature,
  missingFeatures,
} from "../src/features.js";

type NoticeInput = Parameters<typeof createBackendFailureNotice>[0];
type Notice = ReturnType<typeof createBackendFailureNotice>;

const BROWSER_HINTS = [
  "Update your browser to the latest version.",
  "Use a PC connected to the TV with an HDMI cable.",
  "Try another device.",
];
const FEATURE_HINTS = ["Update your browser.", "Try a desktop browser."];
const INIT_HINTS = [
  "Reload the page.",
  "Close other tabs that use 3D graphics.",
  "Update your browser.",
];
const LOST_HINTS = ["Reload the page."];
const DRAW_HINTS = ["Update your browser.", "Try another device."];

const ALL_FEATURES: readonly EngineFeature[] = [
  "compute",
  "storage-buffers",
  "timestamp-query",
  "float-render-target",
  "texture-array",
  "msaa4",
  "compressed-astc",
  "compressed-etc2",
  "compressed-s3tc",
];

interface NoticeArgs {
  readonly code: BackendFailureCode;
  readonly backendTried?: NoticeInput["backendTried"];
  readonly browserName?: string;
  readonly gameName?: string;
  readonly missingFeatures?: readonly EngineFeature[];
  readonly detail?: string;
}

function notice(input: NoticeArgs): Notice {
  return createBackendFailureNotice({
    code: input.code,
    browserName: input.browserName ?? "Chrome",
    backendTried: input.backendTried ?? "webgl2",
    ...(input.gameName === undefined ? {} : { gameName: input.gameName }),
    ...(input.missingFeatures === undefined
      ? {}
      : { missingFeatures: input.missingFeatures }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  });
}

describe("[ER-05-12] failure notices", () => {
  test("[ER-05-12] E_DEVICE_UNAVAILABLE without a 2D attempt reports no 3D context", () => {
    const result = notice({ code: "E_DEVICE_UNAVAILABLE" });
    expect(result.code).toBe("E_DEVICE_UNAVAILABLE");
    expect(result.title).toBe("3D graphics are not available");
    expect(result.message).toBe(
      "Chrome cannot create a 3D graphics context, so this game cannot run on this device.",
    );
    expect(result.detail).toBe("no-3d-context");
    expect(result.hints).toEqual(BROWSER_HINTS);
    expect(result.missingFeatures).toEqual([]);
    expect(result.canRetry).toBe(false);
  });

  test("[ER-05-12] E_DEVICE_UNAVAILABLE after a Canvas2D attempt reports no 2D or 3D", () => {
    const result = notice({
      code: "E_DEVICE_UNAVAILABLE",
      backendTried: "canvas2d",
    });
    expect(result.title).toBe("Cannot draw on this device");
    expect(result.message).toBe("Chrome could not create a 2D or 3D drawing context.");
    expect(result.detail).toBe("no-2d-or-3d-context");
    expect(result.hints).toEqual(DRAW_HINTS);
    expect(result.canRetry).toBe(false);
  });

  test("[ER-05-12] E_RENDERER_UNAVAILABLE reports no tier and offers no retry", () => {
    const result = notice({ code: "E_RENDERER_UNAVAILABLE", backendTried: "none" });
    expect(result.title).toBe("Cannot draw on this device");
    expect(result.message).toBe("Chrome could not create a 2D or 3D drawing context.");
    expect(result.detail).toBe("no-tier");
    expect(result.hints).toEqual(DRAW_HINTS);
    expect(result.canRetry).toBe(false);
  });

  test("[ER-05-12] a 3D game on Canvas2D wins over a missing-feature list", () => {
    const result = notice({
      code: "E_UNSUPPORTED_FEATURE",
      backendTried: "canvas2d",
      detail: "3d-on-canvas2d",
      missingFeatures: ["compute", "msaa4"],
    });
    expect(result.title).toBe("This game needs 3D graphics");
    expect(result.message).toBe(
      "This device provides only 2D drawing. This game requires a 3D renderer.",
    );
    expect(result.missingFeatures).toEqual([]);
    expect(result.detail).toBe("3d-on-canvas2d");
    expect(result.hints).toEqual(BROWSER_HINTS);
    expect(result.canRetry).toBe(false);
  });

  test("[ER-05-12] missing features join their fixed sentences in order", () => {
    const required: readonly EngineFeature[] = ["compute", "storage-buffers", "msaa4"];
    const result = notice({
      code: "E_UNSUPPORTED_FEATURE",
      missingFeatures: required,
    });
    expect(result.title).toBe("This game needs a graphics feature this device lacks");
    expect(result.message).toBe(
      `${describeMissingFeature("compute")} ${describeMissingFeature("storage-buffers")} ${describeMissingFeature("msaa4")}`,
    );
    expect(result.missingFeatures).toBe(required);
    expect(result.detail).toBe("missing-feature");
    expect(result.hints).toEqual(FEATURE_HINTS);
    expect(result.canRetry).toBe(false);
  });

  test("[ER-05-12] an unsupported feature with no list uses the generic sentence", () => {
    const result = notice({ code: "E_UNSUPPORTED_FEATURE" });
    expect(result.title).toBe("This game needs a graphics feature this device lacks");
    expect(result.message).toBe(
      "This game requires a graphics feature this device does not provide.",
    );
    expect(result.missingFeatures).toEqual([]);
    expect(result.detail).toBe("unsupported-feature");
    expect(result.hints).toEqual(FEATURE_HINTS);
    expect(result.canRetry).toBe(false);
  });

  test("[ER-05-12] E_BACKEND_INIT is retryable with init hints", () => {
    const result = notice({ code: "E_BACKEND_INIT" });
    expect(result.title).toBe("Graphics could not start");
    expect(result.message).toBe(
      "Chrome has 3D graphics, but the context failed to initialize.",
    );
    expect(result.detail).toBe("backend-init");
    expect(result.hints).toEqual(INIT_HINTS);
    expect(result.canRetry).toBe(true);
  });

  test("[ER-05-12] E_DEVICE_LOST is retryable with the reload hint", () => {
    const result = notice({ code: "E_DEVICE_LOST" });
    expect(result.title).toBe("Graphics was reset");
    expect(result.message).toBe(
      "The graphics device was reset and could not be restored. The game was stopped to protect your device.",
    );
    expect(result.detail).toBe("device-lost");
    expect(result.hints).toEqual(LOST_HINTS);
    expect(result.canRetry).toBe(true);
  });

  test("[ER-05-12] the browser name is interpolated but never a game name", () => {
    const result = createBackendFailureNotice({
      code: "E_BACKEND_INIT",
      browserName: "Firefox",
      backendTried: "webgl2",
      gameName: "Secret Game Title",
    });
    expect(result.message).toContain("Firefox");
    expect(JSON.stringify(result)).not.toContain("Secret Game Title");
  });

  test("[ER-05-12] supplied machine details are preserved", () => {
    expect(notice({ code: "E_BACKEND_INIT", detail: "gl-context-null" }).detail).toBe(
      "gl-context-null",
    );
    expect(notice({ code: "E_DEVICE_LOST", detail: "restore-exhausted" }).detail).toBe(
      "restore-exhausted",
    );
    expect(
      notice({
        code: "E_UNSUPPORTED_FEATURE",
        missingFeatures: ["compute"],
        detail: "game-needs-compute",
      }).detail,
    ).toBe("game-needs-compute");
    expect(notice({ code: "E_UNSUPPORTED_FEATURE", detail: "custom" }).detail).toBe("custom");
  });

  test("[ER-05-12] every notice is a frozen record", () => {
    for (const code of [
      "E_DEVICE_UNAVAILABLE",
      "E_BACKEND_INIT",
      "E_UNSUPPORTED_FEATURE",
      "E_DEVICE_LOST",
      "E_RENDERER_UNAVAILABLE",
    ] as const) {
      expect(Object.isFrozen(notice({ code }))).toBe(true);
    }
  });

  test("[ER-05-12] notice copy carries no token, URL, path or room code", () => {
    const hostileGameName = "ROOM-1234 https://evil.example/?token=abc user@example.com";
    const texts: string[] = [];
    for (const code of [
      "E_DEVICE_UNAVAILABLE",
      "E_BACKEND_INIT",
      "E_UNSUPPORTED_FEATURE",
      "E_DEVICE_LOST",
      "E_RENDERER_UNAVAILABLE",
    ] as const) {
      const result = createBackendFailureNotice({
        code,
        browserName: "Chrome",
        backendTried: "webgl2",
        gameName: hostileGameName,
      });
      texts.push(
        result.title,
        result.message,
        result.detail,
        ...result.hints,
        ...result.missingFeatures,
      );
    }
    const joined = texts.join("\n");
    expect(joined).not.toContain("ROOM-1234");
    expect(joined).not.toContain("http://");
    expect(joined).not.toContain("https://");
    expect(joined).not.toContain("token=");
    expect(joined).not.toContain("@");
    expect(joined).not.toContain("evil.example");
    expect(/[A-Za-z]:\\|\\\\|\.\.\//.test(joined)).toBe(false);
    expect(joined).not.toContain(hostileGameName);
  });
});

describe("[ER-05-12] missing feature selection", () => {
  test("[ER-05-12] available features are skipped and order is preserved", () => {
    const available = new Set<EngineFeature>(["storage-buffers", "msaa4"]);
    expect(
      missingFeatures(["compute", "storage-buffers", "timestamp-query", "msaa4"], available),
    ).toEqual(["compute", "timestamp-query"]);
  });

  test("[ER-05-12] duplicate requirements are reported once", () => {
    expect(missingFeatures(["compute", "compute", "msaa4", "compute"], new Set())).toEqual([
      "compute",
      "msaa4",
    ]);
  });

  test("[ER-05-12] an all-available or empty requirement list is empty", () => {
    const everything = new Set<EngineFeature>(ALL_FEATURES);
    expect(missingFeatures(ALL_FEATURES, everything)).toEqual([]);
    expect(missingFeatures([], everything)).toEqual([]);
  });

  test("[ER-05-12] every core feature has its fixed sentence", () => {
    const expected: Readonly<Record<EngineFeature, string>> = {
      compute:
        "This game needs WebGPU compute, which this browser does not provide. It can run on a WebGPU-capable desktop browser.",
      "storage-buffers":
        "This game needs GPU storage buffers, which WebGL2 does not provide.",
      "timestamp-query":
        "This game requires GPU timing queries, which this device does not expose.",
      "float-render-target":
        "This game needs HDR rendering, which this device's WebGL2 cannot provide.",
      "texture-array":
        "This game requires texture arrays, which this device does not provide.",
      msaa4:
        "This game requires 4× anti-aliasing, which this device's WebGL2 cannot provide.",
      "compressed-astc":
        "This game requires a compressed texture format this device does not support.",
      "compressed-etc2":
        "This game requires a compressed texture format this device does not support.",
      "compressed-s3tc":
        "This game requires a compressed texture format this device does not support.",
    };
    for (const feature of ALL_FEATURES) {
      expect(describeMissingFeature(feature)).toBe(expected[feature]);
    }
  });
});
