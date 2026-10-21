/**
 * Token and PIN primitives (D4-SRV-01, SR-1/SR-4/SR-9).
 *
 * Entropy is injected everywhere, so no test depends on real randomness and
 * every generated secret is reproducible.
 */
import { describe, expect, test, vi } from "vitest";
import { TOKEN_BYTES } from "@lanpad/protocol";
import {
  constantTimeEqual,
  generatePin,
  generateToken,
  isValidPin,
} from "../src/auth/tokens.js";
import { seededRandomBytes } from "./helpers.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const PIN_PATTERN = /^\d{4}$/;

describe("generateToken", () => {
  test("[SR-1] a token is 16 random bytes encoded as 22 base64url characters", () => {
    const bytes = Uint8Array.from({ length: TOKEN_BYTES }, (_, index) => index * 16 + 7);
    let requested = 0;

    const token = generateToken((count) => {
      requested = count;
      return bytes;
    });

    expect(requested).toBe(16);
    expect(token).toBe(Buffer.from(bytes).toString("base64url"));
    expect(token).toHaveLength(22);
    expect(token).toMatch(TOKEN_PATTERN);
    expect(token).not.toContain("=");
  });

  test("[SR-1] generated tokens are unique and URL-safe across entropy sources", () => {
    const tokens = new Set<string>();
    for (let seed = 0; seed < 256; seed += 1) {
      const token = generateToken(seededRandomBytes(seed));
      expect(token).toMatch(TOKEN_PATTERN);
      tokens.add(token);
    }
    expect(tokens.size).toBe(256);
  });

  test("[SR-1] a short entropy source is rejected instead of producing a weak token", () => {
    expect(() => generateToken(() => new Uint8Array(8))).toThrow(/expected 16/);
  });
});

describe("constantTimeEqual", () => {
  test("[SR-1] equal values match; unequal and length-mismatched values do not", () => {
    expect(constantTimeEqual("1234", "1234")).toBe(true);
    expect(constantTimeEqual("1234", "1235")).toBe(false);
    expect(constantTimeEqual("1234", "12345")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "x")).toBe(false);
    expect(constantTimeEqual("AAEC-v8", "AAEC-v8")).toBe(true);
    expect(constantTimeEqual("AAEC-v8", "AAEC-v9")).toBe(false);
  });

  test("[SR-1] a truncated token never matches and the compare never throws", () => {
    const token = generateToken(seededRandomBytes(1));
    expect(constantTimeEqual(token.slice(0, 21), token)).toBe(false);
    expect(constantTimeEqual(`${token}x`, token)).toBe(false);
  });

  test("[SR-1] non-ASCII input compares by UTF-8 bytes without throwing", () => {
    expect(constantTimeEqual("é", "e")).toBe(false);
    expect(constantTimeEqual("🔒", "🔒")).toBe(true);
    expect(constantTimeEqual("🔒", "🔓")).toBe(false);
  });
});

describe("PIN generation and validation", () => {
  test("[SR-4] generated PINs are exactly four digits and keep leading zeros", () => {
    let sawLeadingZero = false;
    for (let seed = 0; seed < 200; seed += 1) {
      const pin = generatePin(seededRandomBytes(seed));
      expect(pin).toMatch(PIN_PATTERN);
      expect(pin).toHaveLength(4);
      if (pin.startsWith("0")) {
        sawLeadingZero = true;
      }
    }
    expect(sawLeadingZero).toBe(true);
  });

  test("[SR-4] a short or wrong-size entropy draw is rejected", () => {
    expect(() => generatePin(() => new Uint8Array(1))).toThrow(/expected 2/);
    // A source that always lands outside the unbiased range must fail loudly.
    expect(() => generatePin(() => new Uint8Array([0xff, 0xff]))).toThrow(/rejected/);
  });

  test("[SR-4] PIN validation accepts only exactly four ASCII digits", () => {
    expect(isValidPin("0000")).toBe(true);
    expect(isValidPin("9876")).toBe(true);
    expect(isValidPin("987")).toBe(false);
    expect(isValidPin("98765")).toBe(false);
    expect(isValidPin("98a6")).toBe(false);
    expect(isValidPin(" 986")).toBe(false);
    expect(isValidPin("+986")).toBe(false);
    expect(isValidPin("٩٨٧٦")).toBe(false);
    expect(isValidPin("")).toBe(false);
  });

  test("[SR-4] a wrong or missing PIN never compares equal", () => {
    const pin = generatePin(seededRandomBytes(3));
    const wrong = pin === "0000" ? "0001" : "0000";

    expect(constantTimeEqual(pin, pin)).toBe(true);
    expect(constantTimeEqual(pin, wrong)).toBe(false);
    expect(constantTimeEqual(pin, "")).toBe(false);
    expect(constantTimeEqual("", pin)).toBe(false);
  });

  test("[FR-5.6] a PIN-only credential verifies with no camera, token or session", () => {
    const pin = generatePin(seededRandomBytes(11));
    const submitted = pin;
    const wrong = pin === "0000" ? "0001" : "0000";

    // The manual path is self-contained: exactly one 4-digit PIN is compared.
    expect(isValidPin(submitted)).toBe(true);
    expect(constantTimeEqual(submitted, pin)).toBe(true);
    expect(constantTimeEqual(wrong, pin)).toBe(false);
  });
});

describe("secret hygiene", () => {
  test("[SR-9] token and PIN generation never writes secrets to the console", () => {
    const spies = (["log", "info", "debug", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const secrets: string[] = [];
    try {
      for (let seed = 0; seed < 20; seed += 1) {
        secrets.push(generateToken(seededRandomBytes(seed)));
        secrets.push(generatePin(seededRandomBytes(seed + 1000)));
      }

      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          const text = call
            .map((argument) => (typeof argument === "string" ? argument : JSON.stringify(argument)))
            .join(" ");
          for (const secret of secrets) {
            expect(text).not.toContain(secret);
          }
        }
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
