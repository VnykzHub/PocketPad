/**
 * Package-boundary tests (04 §3.1, ER-04-16).
 *
 * The package is a leaf over `@lanpad/engine-core`: no third-party runtime
 * dependency, no import of the host app or the per-backend SDK, no WebGPU/DOM
 * type in the SDK-facing capability shape. The `npm run size` gzip figure and
 * the full SDK compile check are owned by the repo gate and are not measured
 * here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { RenderDevice } from "@lanpad/engine-core";
import type { WebGpuDevice } from "../src/contracts/webgpu.js";

interface PackageManifest {
  readonly name: string;
  readonly type: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

interface SdkRendererCapabilities {
  readonly backend: "webgpu" | "webgl2" | "canvas2d";
  readonly features: ReadonlySet<string>;
  readonly quality: "off" | "low" | "medium" | "high";
  readonly maxTextureSize: number;
  readonly maxTextureLayers: number;
  readonly maxBindGroups: number;
  readonly maxUniformBufferBytes: number;
  readonly maxSamples: 1 | 4;
  readonly anisotropy: number;
  readonly directionalLights: number;
  readonly pointLights: number;
  readonly shadowCascades: 0 | 2 | 3;
  readonly supportsPost: boolean;
  readonly supportsTimestamps: boolean;
}

// Compile-time proofs: if the backend drifts from the frozen core contract or
// the SDK structural snapshot, `tsc -p tsconfig.test.json` fails here.
const coreDeviceProof: RenderDevice = null as unknown as WebGpuDevice;
const sdkCapabilitiesProof: SdkRendererCapabilities =
  null as unknown as WebGpuDevice["capabilities"];
void coreDeviceProof;
void sdkCapabilitiesProof;

const PACKAGE_ROOT = new URL("../", import.meta.url);
const SRC_ROOT = new URL("../src/", import.meta.url);
const IMPORT_PATTERN =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function sourceFiles(directory: URL): URL[] {
  const out: URL[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(new URL(`${entry.name}/`, directory)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(child);
    }
  }
  return out;
}

function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

const manifest = JSON.parse(
  readFileSync(new URL("package.json", PACKAGE_ROOT), "utf8"),
) as PackageManifest;

describe("dependency boundary", () => {
  test("[ER-04-16] the package depends only on engine-core", () => {
    expect(manifest.name).toBe("@lanpad/engine-renderer-webgpu");
    expect(manifest.type).toBe("module");
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([
      "@lanpad/engine-core",
    ]);
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
  });

  test("[ER-04-16] every source import is relative or engine-core", () => {
    const files = sourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const bare = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importedSpecifiers(source)) {
        if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
          bare.add(specifier);
        }
        expect(specifier, file.pathname).not.toContain("three");
        expect(specifier, file.pathname).not.toContain("renderer-webgl2");
        expect(specifier, file.pathname).not.toContain("@lanpad/runtime");
        expect(specifier, file.pathname).not.toContain("@lanpad/protocol");
        expect(specifier, file.pathname).not.toContain("@lanpad/controller");
        expect(specifier, file.pathname).not.toContain("@lanpad/sdk");
      }
    }
    expect([...bare]).toEqual(["@lanpad/engine-core"]);
  });

  test("[ER-04-16] the public entry exports only the backend surface", async () => {
    const entry = await import("../src/index.js");
    expect(Object.keys(entry).sort()).toEqual([
      "PIPELINE_CACHE_VERSION",
      "RENDERER_ABI_VERSION",
      "SHADER_ABI_VERSION",
      "WebGpuRendererDevice",
      "createWebGpuDevice",
    ]);
    expect(typeof entry.createWebGpuDevice).toBe("function");
    expect(typeof entry.WebGpuRendererDevice).toBe("function");
  });
});
