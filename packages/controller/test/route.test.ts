import { describe, expect, it, vi } from "vitest";
import {
  clearUrlFragment,
  normalizeRoomCode,
  parseControllerPath,
  parseControllerRoute,
  parseFragmentToken,
} from "../src/route.js";

describe("[FR-5.6] manual join route parsing", () => {
  it("[FR-5.6] parses /c/CODE and normalizes the code to uppercase", () => {
    expect(parseControllerPath("/c/abcd")).toEqual({ code: "ABCD", token: null });
    expect(parseControllerPath("/c/ABCD")).toEqual({ code: "ABCD", token: null });
    expect(parseControllerPath("/c/AB12/")).toEqual({ code: "AB12", token: null });
  });

  it("[FR-5.6] returns a null code for missing, short and non-controller paths", () => {
    expect(parseControllerPath("/")).toEqual({ code: null, token: null });
    expect(parseControllerPath("/c/")).toEqual({ code: null, token: null });
    expect(parseControllerPath("/c/ABC")).toEqual({ code: null, token: null });
    expect(parseControllerPath("/c/ABCDE")).toEqual({ code: null, token: null });
    expect(parseControllerPath("/x/ABCD")).toEqual({ code: null, token: null });
    expect(parseControllerPath("/c/ABCD/extra")).toEqual({ code: null, token: null });
  });

  it("[FR-5.6] rejects characters outside the Crockford room-code alphabet", () => {
    // I, L, O and U are excluded from ROOM_CODE_ALPHABET.
    expect(parseControllerPath("/c/ABCI").code).toBeNull();
    expect(parseControllerPath("/c/ABCL").code).toBeNull();
    expect(parseControllerPath("/c/ABCO").code).toBeNull();
    expect(parseControllerPath("/c/ABCU").code).toBeNull();
  });

  it("[FR-5.6] normalizes manual entry by trimming and upper-casing", () => {
    expect(normalizeRoomCode("  abcd ")).toBe("ABCD");
    expect(normalizeRoomCode("AB1Z")).toBe("AB1Z");
    expect(normalizeRoomCode("")).toBeNull();
    expect(normalizeRoomCode(null)).toBeNull();
    expect(normalizeRoomCode(undefined)).toBeNull();
    expect(normalizeRoomCode("AB I")).toBeNull();
  });
});

describe("[FR-5.1] room token is read from the fragment only", () => {
  it("[FR-5.1] reads the token from the URL fragment", () => {
    expect(parseFragmentToken("#tokenValue123")).toBe("tokenValue123");
    expect(parseFragmentToken("tokenValue123")).toBe("tokenValue123");
    expect(parseControllerRoute("/c/ABCD", "#tokenValue123")).toEqual({
      code: "ABCD",
      token: "tokenValue123",
    });
  });

  it("[FR-5.1] decodes percent-encoded fragments and rejects malformed ones", () => {
    expect(parseFragmentToken("#tok%2Ben")).toBe("tok+en");
    expect(parseFragmentToken("#")).toBeNull();
    expect(parseFragmentToken("")).toBeNull();
    expect(parseFragmentToken("%E0%A4%A")).toBeNull();
    expect(parseControllerRoute("/c/ABCD", "").token).toBeNull();
  });

  it("[FR-5.1] clears the fragment before any network call and keeps the query string", () => {
    const replaceState = vi.fn();
    clearUrlFragment({ replaceState }, "/c/ABCD", "?debug=1");

    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/c/ABCD?debug=1");
    const writtenUrl = replaceState.mock.calls[0]?.[2] as string;
    expect(writtenUrl).not.toContain("#");
  });
});
