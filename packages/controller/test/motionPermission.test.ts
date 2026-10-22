/**
 * D6-CTRL-01 permission tests: pure feature detection, the secure-context
 * gate, prompt-only-when-needed behavior and safe denial fallbacks.
 */
import { describe, expect, it } from "vitest";
import {
  readMotionEnvironment,
  requestMotionPermission,
  resolveMotionSupport,
  type MotionEnvironment,
} from "../src/sensors/motionPermission.js";

const supportedEnvironment: MotionEnvironment = {
  isSecureContext: true,
  hasDeviceMotionEvent: true,
};

describe("[FR-12.1] resolveMotionSupport", () => {
  it("[FR-12.1][E7] requires a secure context before anything else", () => {
    expect(
      resolveMotionSupport({
        isSecureContext: false,
        hasDeviceMotionEvent: true,
        requestPermission: async () => "granted",
      }),
    ).toBe("insecure-context");
    expect(
      resolveMotionSupport({
        isSecureContext: false,
        hasDeviceMotionEvent: false,
      }),
    ).toBe("insecure-context");
  });

  it("[FR-12.1] distinguishes unsupported, prompt and no-prompt environments", () => {
    expect(
      resolveMotionSupport({ isSecureContext: true, hasDeviceMotionEvent: false }),
    ).toBe("unsupported");
    expect(resolveMotionSupport(supportedEnvironment)).toBe("supported");
    expect(
      resolveMotionSupport({
        ...supportedEnvironment,
        requestPermission: async () => "granted",
      }),
    ).toBe("permission-required");
  });
});

describe("[FR-12.1] requestMotionPermission", () => {
  it("[FR-12.1] never calls requestPermission in insecure or unsupported environments", async () => {
    let calls = 0;
    const requestPermission = async (): Promise<string> => {
      calls += 1;
      return "granted";
    };

    await expect(
      requestMotionPermission({
        isSecureContext: false,
        hasDeviceMotionEvent: true,
        requestPermission,
      }),
    ).resolves.toBe("denied");
    await expect(
      requestMotionPermission({
        isSecureContext: true,
        hasDeviceMotionEvent: false,
        requestPermission,
      }),
    ).resolves.toBe("denied");

    expect(calls).toBe(0);
  });

  it("resolves granted without a prompt where events flow freely", async () => {
    await expect(requestMotionPermission(supportedEnvironment)).resolves.toBe("granted");
  });

  it("maps the browser answer to granted or denied", async () => {
    await expect(
      requestMotionPermission({
        ...supportedEnvironment,
        requestPermission: async () => "granted",
      }),
    ).resolves.toBe("granted");

    await expect(
      requestMotionPermission({
        ...supportedEnvironment,
        requestPermission: async () => "denied",
      }),
    ).resolves.toBe("denied");

    await expect(
      requestMotionPermission({
        ...supportedEnvironment,
        requestPermission: async () => "maybe",
      }),
    ).resolves.toBe("denied");
  });

  it("treats a thrown request as denial", async () => {
    await expect(
      requestMotionPermission({
        ...supportedEnvironment,
        requestPermission: async () => {
          throw new Error("permission prompt failed");
        },
      }),
    ).resolves.toBe("denied");
  });
});

describe("[FR-12.1] readMotionEnvironment", () => {
  it("reads a supplied scope lazily", () => {
    const empty = readMotionEnvironment({});
    expect(empty.isSecureContext).toBe(false);
    expect(empty.hasDeviceMotionEvent).toBe(false);
    expect(empty.requestPermission).toBeUndefined();

    function DeviceMotionEvent(): void {
      // constructor stand-in
    }
    const supported = readMotionEnvironment({
      isSecureContext: true,
      DeviceMotionEvent,
    });
    expect(resolveMotionSupport(supported)).toBe("supported");
  });

  it("[A5] wraps a static requestPermission with the constructor as this", async () => {
    let thisWasConstructor = false;

    function DeviceMotionEvent(): void {
      // constructor stand-in
    }
    (
      DeviceMotionEvent as unknown as {
        requestPermission: () => Promise<unknown>;
      }
    ).requestPermission = function requestPermission(this: unknown): Promise<unknown> {
      thisWasConstructor = this === DeviceMotionEvent;
      return Promise.resolve("granted");
    };

    const environment = readMotionEnvironment({
      isSecureContext: true,
      DeviceMotionEvent,
    });
    expect(resolveMotionSupport(environment)).toBe("permission-required");
    await expect(environment.requestPermission?.()).resolves.toBe("granted");
    expect(thisWasConstructor).toBe(true);
  });

  it("does not treat a non-function constructor or requestPermission as support", () => {
    const environment = readMotionEnvironment({
      isSecureContext: true,
      DeviceMotionEvent: { requestPermission: "nope" },
    });
    expect(environment.hasDeviceMotionEvent).toBe(false);
    expect(environment.requestPermission).toBeUndefined();
    expect(resolveMotionSupport(environment)).toBe("unsupported");
  });

  it("defaults to globalThis without throwing when import-time globals differ", () => {
    const environment = readMotionEnvironment();
    expect(typeof environment.isSecureContext).toBe("boolean");
    expect(typeof environment.hasDeviceMotionEvent).toBe("boolean");
  });
});
