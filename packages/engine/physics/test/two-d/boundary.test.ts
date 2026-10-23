/**
 * ER-07-09 — the frozen 2D API and its package boundary (07 §5.15).
 *
 * The migration must keep every exported name, signature and constant of the
 * former `packages/runtime/src/physics` module, expose it from the Rapier-free
 * `./two-d` subpath, and let `two-d/` import nothing but its own files. These
 * checks fail if the move gains a dependency on Rapier, the runtime, or a game.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as twoD from "../../src/two-d/index.js";
import {
  MAX_SPEED,
  integrate,
  resolveCircleAabb,
  resolveCircleCircle,
  type Aabb,
  type Arena,
  type CircleBody,
  type Contact,
  type Vec2,
} from "../../src/two-d/index.js";

/* Compile-time checks: the frozen signatures must be assignable unchanged. */
const aabbSignature: (
  circle: CircleBody,
  box: Aabb,
  out?: Contact,
) => boolean = resolveCircleAabb;
const circleSignature: (
  a: CircleBody,
  b: CircleBody,
  out?: Contact,
) => boolean = resolveCircleCircle;
const integrateSignature: (
  body: CircleBody,
  dt: number,
  arena: Arena,
) => void = integrate;

/* Compile-time checks: the frozen data shapes keep their fields. */
const vec2: Vec2 = { x: 1, y: 2 };
const aabb: Aabb = { x: 0, y: 0, w: 4, h: 2 };
const arena: Arena = { minX: -10, maxX: 10, minY: -10, maxY: 10 };
const contact: Contact = { nx: 0, ny: -1, depth: 0.5 };
const body: CircleBody = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  radius: 0.4,
  mass: 1,
  restitution: 0,
  friction: 0,
  active: true,
  id: 7,
};

describe("frozen 2D API [ER-07-09]", () => {
  test("[ER-07-09] the subpath exports exactly the four frozen runtime names", () => {
    expect(Object.keys(twoD).sort()).toEqual([
      "MAX_SPEED",
      "integrate",
      "resolveCircleAabb",
      "resolveCircleCircle",
    ]);
    expect(MAX_SPEED).toBe(1000);
    expect(twoD.MAX_SPEED).toBe(MAX_SPEED);
    expect(twoD.resolveCircleAabb).toBe(resolveCircleAabb);
    expect(twoD.resolveCircleCircle).toBe(resolveCircleCircle);
    expect(twoD.integrate).toBe(integrate);
  });

  test("[ER-07-09] signatures and data shapes keep their frozen types", () => {
    expect(aabbSignature).toBe(resolveCircleAabb);
    expect(circleSignature).toBe(resolveCircleCircle);
    expect(integrateSignature).toBe(integrate);
    expect(vec2).toEqual({ x: 1, y: 2 });
    expect(aabb).toEqual({ x: 0, y: 0, w: 4, h: 2 });
    expect(arena).toEqual({ minX: -10, maxX: 10, minY: -10, maxY: 10 });
    expect(contact).toEqual({ nx: 0, ny: -1, depth: 0.5 });
    expect(body.id).toBe(7);
  });
});

describe("2D package boundary [ER-07-09]", () => {
  const twoDUrl = new URL("../../src/two-d/", import.meta.url);
  const twoDDir = fileURLToPath(twoDUrl);
  const sources = readdirSync(twoDDir).filter((file) => file.endsWith(".ts"));
  const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;

  test("[ER-07-09] two-d contains only the four frozen source files", () => {
    expect(sources.sort()).toEqual([
      "Aabb.ts",
      "Vec2.ts",
      "collide.ts",
      "index.ts",
    ]);
  });

  test("[ER-07-09] two-d imports only its own sibling files", () => {
    for (const file of sources) {
      const text = readFileSync(join(twoDDir, file), "utf8");
      for (const match of text.matchAll(importPattern)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        expect(specifier, `${file} may only import siblings`).toMatch(
          /^\.\/[A-Za-z0-9._-]+\.js$/,
        );
        const sourceFile = `${specifier.slice(2, -3)}.ts`;
        expect(sources, `${file} imports missing ${sourceFile}`).toContain(
          sourceFile,
        );
      }
    }
  });

  test("[ER-07-09] package.json exposes the Rapier-free ./two-d subpath", () => {
    const packageUrl = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(packageUrl, "utf8")) as {
      exports?: Record<string, { types?: string; import?: string }>;
      dependencies?: Record<string, string>;
    };
    expect(pkg.exports?.["./two-d"]).toEqual({
      types: "./dist/two-d/index.d.ts",
      import: "./dist/two-d/index.js",
    });
    const dependencies = Object.keys(pkg.dependencies ?? {});
    expect(dependencies).not.toContain("@lanpad/runtime");
    expect(dependencies.some((name) => name.startsWith("@lanpad/games"))).toBe(
      false,
    );
  });

  test("[ER-07-09] the runtime compatibility shim imports the subpath", () => {
    const shimUrl = new URL(
      "../../../../runtime/src/physics/index.ts",
      import.meta.url,
    );
    const shim = readFileSync(shimUrl, "utf8");
    expect(shim).toContain('export * from "@lanpad/engine-physics/two-d";');
    const specifiers: string[] = [];
    for (const match of shim.matchAll(importPattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
    expect(specifiers).toEqual(["@lanpad/engine-physics/two-d"]);
  });
});
