/**
 * Exact byte evidence for the spike.
 *
 * Raw and gzip bytes are read from the installed packages, not from a CDN or
 * a datasheet. Licences are read from the same installed trees; the spike stops
 * with a non-zero exit if a declared licence is outside the permissive set.
 */

import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const nodeModules = join(root, "node_modules");
const PERMISSIVE = new Set(["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause"]);
const GZIP_LEVEL = 9;

const TARGETS = [
  {
    group: "havok",
    label: "havok wasm",
    path: "@babylonjs/havok/lib/esm/HavokPhysics.wasm",
  },
  {
    group: "havok",
    label: "havok esm glue",
    path: "@babylonjs/havok/lib/esm/HavokPhysics_es.js",
  },
  {
    group: "rapier",
    label: "rapier compat bundle (wasm inlined)",
    path: "@dimforge/rapier3d-compat/dist/rapier.mjs",
  },
  {
    group: "rapier",
    label: "rapier wasm (standalone)",
    path: "@dimforge/rapier3d-compat/dist/rapier_wasm3d_bg.wasm",
  },
  {
    group: "rapier",
    label: "rapier wasm loader (standalone)",
    path: "@dimforge/rapier3d-compat/dist/rapier_wasm3d.js",
  },
];

const LICENCES = [
  { package: "@babylonjs/havok", path: "@babylonjs/havok/LICENSE" },
  { package: "@dimforge/rapier3d-compat", path: "@dimforge/rapier3d-compat/LICENSE" },
];

async function measureFile(absolutePath, label, group) {
  const data = await readFile(absolutePath);
  return {
    group,
    label,
    path: relative(root, absolutePath).split("\\").join("/"),
    rawBytes: data.length,
    gzipBytes: gzipSync(data, { level: GZIP_LEVEL }).length,
  };
}

export async function measureSizes() {
  const files = [];
  for (const target of TARGETS) {
    files.push(
      await measureFile(join(nodeModules, target.path), target.label, target.group),
    );
  }

  const distAssets = join(root, "dist", "assets");
  const dist = [];
  if (existsSync(distAssets)) {
    const names = (await readdir(distAssets)).sort();
    for (const name of names) {
      const absolutePath = join(distAssets, name);
      const info = await stat(absolutePath);
      if (!info.isFile()) continue;
      const data = await readFile(absolutePath);
      dist.push({
        file: `dist/assets/${name}`,
        rawBytes: data.length,
        gzipBytes: gzipSync(data, { level: GZIP_LEVEL }).length,
      });
    }
  }

  const licences = [];
  for (const entry of LICENCES) {
    const absolutePath = join(nodeModules, entry.path);
    const text = await readFile(absolutePath, "utf8");
    const packageJson = JSON.parse(
      await readFile(join(nodeModules, entry.package, "package.json"), "utf8"),
    );
    licences.push({
      package: entry.package,
      version: packageJson.version,
      declaredLicense: packageJson.license,
      licenseFile: relative(root, absolutePath).split("\\").join("/"),
      licenseFirstLine: text.split(/\r?\n/)[0]?.trim() ?? "",
      sha256: createHash("sha256").update(text).digest("hex"),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    gzipLevel: GZIP_LEVEL,
    permissive: licences.every((entry) => PERMISSIVE.has(entry.declaredLicense)),
    licences,
    files,
    dist,
  };
}

function formatBytes(value) {
  return value.toLocaleString("en-US");
}

function printReport(report) {
  console.log("\n[bytes] installed physics packages");
  for (const file of report.files) {
    console.log(
      `  ${file.group.padEnd(7)} ${file.label.padEnd(42)} ${formatBytes(file.rawBytes).padStart(12)} raw  ${formatBytes(file.gzipBytes).padStart(10)} gzip`,
    );
  }
  console.log("\n[licence]");
  for (const licence of report.licences) {
    console.log(
      `  ${licence.package}@${licence.version}: ${licence.declaredLicense} (${licence.licenseFile})`,
    );
    console.log(`    first line: ${licence.licenseFirstLine}`);
    console.log(`    sha256: ${licence.sha256}`);
  }
  console.log(`\n[licence] permissive: ${report.permissive}`);
}

async function main() {
  const report = await measureSizes();
  await writeFile(join(root, "size-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
  if (!report.permissive) {
    console.error("[licence] STOP: at least one declared licence is not permissive");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
