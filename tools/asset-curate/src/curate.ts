/**
 * Curation core: scan the local drop, plan a licence-checked subset, verify
 * bytes, and generate the ledger, curation report and per-game manifests.
 *
 * The function is deliberately transactional for errors: it performs no
 * writes until every source, licence, hash and manifest check has passed.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { GlbParseError, parseGlb, type GlbInfo } from "./glb.js";
import {
  formatLedger,
  parseLedger,
  validateLedger,
  type LedgerRow,
} from "./ledger.js";
import {
  CURATION_DATE,
  EXCLUSIONS,
  GAME_IDS,
  GAME_MANIFESTS,
  SELECTION,
  type CuratableKind,
  type CurationGroup,
  type GameId,
  type LicenceSource,
  type SelectionEntry,
} from "./selection.js";

/** Mirrors ASSET_BOOT_HARD_CAP_BYTES in sdk/src/assets.ts. */
export const ASSET_BOOT_HARD_CAP_BYTES = 5 * 1024 * 1024;
export const LICENSES_FILE = "LICENSES.csv";
export const CURATION_JSON_FILE = "CURATION.json";
export const CURATION_MD_FILE = "CURATION.md";
export const MANIFEST_DIR = "manifests";

const GROUP_ORDER: readonly CurationGroup[] = [
  "characters",
  "vehicles",
  "props",
  "audio-ui",
  "audio-impact",
  "audio-scifi",
  "audio-digital",
  "music",
];
const GAME_SET: ReadonlySet<string> = new Set(GAME_IDS);
const ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*$/;

export interface SourceScan {
  readonly files: number;
  readonly bytes: number;
  readonly glb: number;
  readonly ogg: number;
}

export interface CuratedAsset {
  readonly id: string;
  readonly kind: CuratableKind;
  readonly group: CurationGroup;
  /** assets-relative path, forward slashes. */
  readonly path: string;
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly sha256: string;
  readonly sourcePack: string;
  readonly sourcePath: string;
  readonly sourceBytes: number;
  readonly sourceSha256: string;
  /** Ledger id of the owning asset for a GLB texture dependency; empty otherwise. */
  readonly parent: string;
  parents: string[];
  games: GameId[];
  readonly licence: LicenceSource;
  readonly derivation: string;
  notes: string;
  readonly clips?: readonly string[];
  dependencyIds: string[];
}

export interface CuratedManifest {
  readonly game: GameId;
  readonly path: string;
  readonly content: string;
  readonly bootIds: readonly string[];
  readonly assetCount: number;
  readonly bootBytes: number;
  readonly bootGzipBytes: number;
  readonly totalBytes: number;
  readonly totalGzipBytes: number;
}

export interface CurateOptions {
  readonly sourceRoot: string;
  readonly assetRoot: string;
  readonly check?: boolean;
}

export interface CurateResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly files: readonly CuratedAsset[];
  readonly ledgerText: string;
  readonly curationJsonText: string;
  readonly curationMdText: string;
  readonly manifests: readonly CuratedManifest[];
  readonly scan: SourceScan;
  readonly totals: { readonly files: number; readonly bytes: number; readonly gzipBytes: number };
  readonly groups: readonly {
    readonly group: CurationGroup;
    readonly files: number;
    readonly bytes: number;
    readonly gzipBytes: number;
  }[];
  readonly written: readonly string[];
}

interface ScanIndex {
  readonly sizes: Map<string, number>;
  readonly scan: SourceScan;
}

interface PlannedFile {
  readonly asset: CuratedAsset;
  readonly sourceAbs: string;
  readonly destAbs: string;
  /** Expected bytes for a direct copy; null for a pre-derived file already in assets/. */
  readonly content: Uint8Array | null;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function commas(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (path.includes("\\") || path.includes("://")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\u0000"));
}

function listRelativeFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else if (entry.isFile()) result.push(relative);
    }
  };
  walk(root, "");
  return result.sort((a, b) => a.localeCompare(b));
}

function scanSource(root: string): ScanIndex {
  if (!existsSync(root)) {
    throw new Error(
      `Game-assets is missing at ${root}. The 1.3 GB drop is gitignored; restore it or pass --source <dir>.`,
    );
  }
  const sizes = new Map<string, number>();
  let bytes = 0;
  let glb = 0;
  let ogg = 0;
  for (const relative of listRelativeFiles(root)) {
    const size = statSync(join(root, ...relative.split("/"))).size;
    sizes.set(relative, size);
    bytes += size;
    const lower = relative.toLowerCase();
    if (lower.endsWith(".glb")) glb += 1;
    if (lower.endsWith(".ogg")) ogg += 1;
  }
  return { sizes, scan: { files: sizes.size, bytes, glb, ogg } };
}

function absUnder(root: string, relative: string): string {
  return resolve(root, ...relative.split("/"));
}

function validateMetadata(entries: readonly SelectionEntry[], errors: string[]): void {
  const ids = new Set<string>();
  const outputs = new Set<string>();
  for (const entry of entries) {
    const label = entry.id === "" ? "(empty id)" : entry.id;
    if (!ID_PATTERN.test(entry.id) || entry.id.length > 64) {
      errors.push(`${label}: invalid asset id`);
    }
    if (ids.has(entry.id)) errors.push(`${label}: duplicate id`);
    ids.add(entry.id);

    if (!isSafeRelativePath(entry.output)) errors.push(`${label}: unsafe output path "${entry.output}"`);
    if (outputs.has(entry.output)) errors.push(`${label}: duplicate output path "${entry.output}"`);
    outputs.add(entry.output);

    if (!isSafeRelativePath(entry.source)) errors.push(`${label}: unsafe source path "${entry.source}"`);
    if (entry.games.length === 0) errors.push(`${label}: no games assigned`);
    for (const game of entry.games) {
      if (!GAME_SET.has(game)) errors.push(`${label}: unknown game "${game}"`);
    }

    if (entry.clips !== undefined) {
      if (entry.kind !== "mesh") errors.push(`${label}: clips are only valid on mesh assets`);
      if (entry.clips.length === 0) errors.push(`${label}: clips must not be empty`);
      if (new Set(entry.clips).size !== entry.clips.length) errors.push(`${label}: duplicate clip name`);
    }
    if (entry.derived !== undefined) {
      if (entry.kind !== "mesh") errors.push(`${label}: only meshes may be derived`);
      if (!isSafeRelativePath(entry.derived.source)) errors.push(`${label}: unsafe derivation source`);
      if (entry.derived.beforeBytes <= 0 || entry.derived.afterBytes <= 0) {
        errors.push(`${label}: derivation sizes must be positive`);
      }
    }

    const licence = entry.licence;
    if (licence.pack === "") errors.push(`${label}: licence pack is required`);
    if (licence.licence !== "CC0 1.0") errors.push(`${label}: licence must be CC0 1.0`);
    if (!licence.licenceUrl.startsWith("https://")) errors.push(`${label}: licence URL must be https`);
    if (licence.licenceFile === "") errors.push(`${label}: licence file is required`);
    if (!licence.sourceUrl.startsWith("https://")) errors.push(`${label}: source URL must be https`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(licence.accessed)) errors.push(`${label}: accessed must be YYYY-MM-DD`);
    if (licence.attribution === "") errors.push(`${label}: attribution is required`);
  }
}

function checkLicenceEvidence(
  entries: readonly SelectionEntry[],
  sourceRoot: string,
  index: ScanIndex,
  errors: string[],
): void {
  const packs = new Map<string, LicenceSource>();
  for (const entry of entries) packs.set(entry.licence.pack, entry.licence);
  for (const [pack, licence] of packs) {
    const evidence = posix.join(pack, licence.licenceFile);
    if (!index.sizes.has(evidence)) {
      errors.push(`${pack}: licence evidence missing at ${evidence}`);
      continue;
    }
    const text = readFileSync(absUnder(sourceRoot, evidence), "utf8");
    if (!/CC0/i.test(text)) errors.push(`${pack}: ${evidence} does not state CC0`);
  }
}

function dependencyId(output: string): string {
  const withoutExtension = output.replace(/\.[A-Za-z0-9]+$/, "");
  const slug = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return `dep.${slug}`;
}

function makeAsset(
  entry: SelectionEntry,
  options: {
    readonly bytes: number;
    readonly gzipBytes: number;
    readonly sha256: string;
    readonly sourceBytes: number;
    readonly sourceSha256: string;
    readonly parents?: readonly string[];
    readonly notes?: string;
  },
): CuratedAsset {
  const derivation =
    entry.derived === undefined
      ? options.parents === undefined
        ? ""
        : "Copied unchanged; external GLB texture."
      : `${entry.derived.change} Tool: ${entry.derived.tool}; command: ${entry.derived.command}.`;
  return {
    id: entry.id,
    kind: entry.kind,
    group: entry.group,
    path: entry.output,
    bytes: options.bytes,
    gzipBytes: options.gzipBytes,
    sha256: options.sha256,
    sourcePack: entry.licence.pack,
    sourcePath: entry.source,
    sourceBytes: options.sourceBytes,
    sourceSha256: options.sourceSha256,
    parent: options.parents?.[0] ?? "",
    parents: [...(options.parents ?? [])],
    games: [...entry.games],
    licence: entry.licence,
    derivation,
    notes: options.notes ?? entry.notes ?? "",
    ...(entry.clips === undefined ? {} : { clips: entry.clips }),
    dependencyIds: [],
  };
}

function buildAssets(
  sourceRoot: string,
  assetRoot: string,
  index: ScanIndex,
  errors: string[],
): PlannedFile[] {
  const planned: PlannedFile[] = [];
  const byOutput = new Map<string, PlannedFile>();

  for (const entry of [...SELECTION].sort((a, b) => a.id.localeCompare(b.id))) {
    const sourceRel = entry.derived?.source ?? entry.source;
    const size = index.sizes.get(sourceRel);
    if (size === undefined) {
      errors.push(`${entry.id}: source file missing: ${sourceRel}`);
      continue;
    }
    const sourceAbs = absUnder(sourceRoot, sourceRel);
    const destAbs = absUnder(assetRoot, entry.output);
    let sourceBytes: Uint8Array;
    try {
      sourceBytes = readFileSync(sourceAbs);
    } catch (error) {
      errors.push(`${entry.id}: cannot read ${sourceRel}: ${String(error)}`);
      continue;
    }
    const sourceSha = sha256(sourceBytes);

    if (entry.derived !== undefined) {
      if (sourceBytes.length !== entry.derived.beforeBytes) {
        errors.push(
          `${entry.id}: source is ${sourceBytes.length} bytes, expected ${entry.derived.beforeBytes}`,
        );
      }
      if (!existsSync(destAbs)) {
        errors.push(
          `${entry.id}: derived file missing at assets/${entry.output}; run ${entry.derived.command}`,
        );
        continue;
      }
      const destBytes = readFileSync(destAbs);
      if (destBytes.length !== entry.derived.afterBytes) {
        errors.push(`${entry.id}: derived file is ${destBytes.length} bytes, expected ${entry.derived.afterBytes}`);
        continue;
      }
      const asset = makeAsset(entry, {
        bytes: destBytes.length,
        gzipBytes: gzipSync(destBytes).length,
        sha256: sha256(destBytes),
        sourceBytes: sourceBytes.length,
        sourceSha256: sourceSha,
      });
      const file: PlannedFile = { asset, sourceAbs, destAbs, content: null };
      planned.push(file);
      byOutput.set(asset.path, file);
      continue;
    }

    const asset = makeAsset(entry, {
      bytes: sourceBytes.length,
      gzipBytes: gzipSync(sourceBytes).length,
      sha256: sourceSha,
      sourceBytes: sourceBytes.length,
      sourceSha256: sourceSha,
    });
    const file: PlannedFile = { asset, sourceAbs, destAbs, content: sourceBytes };
    planned.push(file);
    byOutput.set(asset.path, file);

    if (entry.kind !== "mesh") continue;

    let info: GlbInfo;
    try {
      info = parseGlb(sourceBytes);
    } catch (error) {
      errors.push(`${entry.id}: ${error instanceof GlbParseError ? error.message : String(error)}`);
      continue;
    }
    if (info.buffers.length > 0) {
      errors.push(
        `${entry.id}: external buffer(s) ${info.buffers.join(", ")} are unsupported; use a GLB with embedded buffers`,
      );
      continue;
    }
    for (const uri of info.images) {
      const sourceDep = posix.normalize(posix.join(posix.dirname(entry.source), uri));
      const outputDep = posix.normalize(posix.join(posix.dirname(entry.output), uri));
      if (!isSafeRelativePath(sourceDep) || !isSafeRelativePath(outputDep)) {
        errors.push(`${entry.id}: unsafe texture dependency "${uri}"`);
        continue;
      }
      if (!index.sizes.has(sourceDep)) {
        errors.push(`${entry.id}: texture dependency missing: ${sourceDep}`);
        continue;
      }

      const existing = byOutput.get(outputDep);
      if (existing !== undefined) {
        if (existing.asset.sourcePath !== sourceDep) {
          errors.push(
            `${entry.id}: texture collision at ${outputDep}: ${existing.asset.sourcePath} vs ${sourceDep}`,
          );
          continue;
        }
        existing.asset.games = [...new Set([...existing.asset.games, ...entry.games])];
        if (!existing.asset.parents.includes(entry.id)) existing.asset.parents.push(entry.id);
        existing.asset.notes = `Referenced by ${existing.asset.parents.join(", ")} via images[].uri.`;
        if (!asset.dependencyIds.includes(existing.asset.id)) asset.dependencyIds.push(existing.asset.id);
        continue;
      }

      const depSourceAbs = absUnder(sourceRoot, sourceDep);
      const depBytes = readFileSync(depSourceAbs);
      const depEntry: SelectionEntry = {
        id: dependencyId(outputDep),
        kind: "texture",
        group: entry.group,
        source: sourceDep,
        output: outputDep,
        games: entry.games,
        licence: entry.licence,
        notes: `Referenced by ${entry.id} via images[].uri.`,
      };
      const depAsset = makeAsset(depEntry, {
        bytes: depBytes.length,
        gzipBytes: gzipSync(depBytes).length,
        sha256: sha256(depBytes),
        sourceBytes: depBytes.length,
        sourceSha256: sha256(depBytes),
        parents: [entry.id],
        notes: `Referenced by ${entry.id} via images[].uri.`,
      });
      const depFile: PlannedFile = {
        asset: depAsset,
        sourceAbs: depSourceAbs,
        destAbs: absUnder(assetRoot, outputDep),
        content: depBytes,
      };
      planned.push(depFile);
      byOutput.set(outputDep, depFile);
      asset.dependencyIds.push(depAsset.id);
    }
  }

  return planned;
}

function toLedgerRow(asset: CuratedAsset): LedgerRow {
  return {
    file: asset.path,
    id: asset.id,
    kind: asset.kind,
    group: asset.group,
    bytes: asset.bytes,
    sha256: asset.sha256,
    parent: asset.parent,
    source_pack: asset.licence.pack,
    source_path: asset.sourcePath,
    source_bytes: asset.sourceBytes,
    source_sha256: asset.sourceSha256,
    author: asset.licence.author,
    licence: asset.licence.licence,
    licence_url: asset.licence.licenceUrl,
    licence_file: `${asset.licence.pack}/${asset.licence.licenceFile}`,
    source_url: asset.licence.sourceUrl,
    accessed: asset.licence.accessed,
    attribution: asset.licence.attribution,
    games: asset.games.join(";"),
    derivation: asset.derivation,
    notes: asset.notes,
  };
}

function sumGzip(assets: readonly CuratedAsset[]): number {
  return assets.reduce((total, asset) => total + asset.gzipBytes, 0);
}

function buildManifests(
  assets: readonly CuratedAsset[],
  errors: string[],
): CuratedManifest[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const manifests: CuratedManifest[] = [];
  for (const config of GAME_MANIFESTS) {
    const gameAssets = assets.filter((asset) => asset.games.includes(config.game));
    const gameIds = new Set(gameAssets.map((asset) => asset.id));
    const boot = new Set<string>();
    const addBoot = (id: string): void => {
      if (boot.has(id)) return;
      const asset = byId.get(id);
      if (asset === undefined) {
        errors.push(`${config.game}: boot asset "${id}" does not exist`);
        return;
      }
      boot.add(id);
      for (const dependency of asset.dependencyIds) addBoot(dependency);
    };
    for (const id of config.boot) {
      if (!gameIds.has(id)) {
        errors.push(`${config.game}: boot asset "${id}" is not assigned to this game`);
        continue;
      }
      addBoot(id);
    }

    const declarations = [...gameIds]
      .sort((a, b) => a.localeCompare(b))
      .map((id) => {
        const asset = byId.get(id);
        if (asset === undefined) throw new Error(`missing asset ${id}`);
        return {
          id,
          path: asset.path,
          kind: asset.kind,
          bytes: asset.bytes,
          group: boot.has(id) ? "boot" : "lazy",
          ledger: asset.path,
          ...(asset.clips === undefined ? {} : { clips: asset.clips }),
        };
      });
    const bootAssets = [...boot]
      .map((id) => byId.get(id))
      .filter((asset): asset is CuratedAsset => asset !== undefined);
    const bootBytes = bootAssets.reduce((total, asset) => total + asset.bytes, 0);
    const bootGzipBytes = sumGzip(bootAssets);
    const totalBytes = gameAssets.reduce((total, asset) => total + asset.bytes, 0);
    const totalGzipBytes = sumGzip(gameAssets);
    if (bootBytes > ASSET_BOOT_HARD_CAP_BYTES) {
      errors.push(
        `${config.game}: eager assets are ${bootBytes} bytes, over the ${ASSET_BOOT_HARD_CAP_BYTES}-byte hard cap`,
      );
    }
    if (bootGzipBytes > ASSET_BOOT_HARD_CAP_BYTES) {
      errors.push(`${config.game}: eager assets are ${bootGzipBytes} gzip bytes, over the hard cap`);
    }

    const manifest = {
      schemaVersion: 1 as const,
      groups: [
        { id: "boot", mode: "eager" as const },
        { id: "lazy", mode: "lazy" as const },
      ],
      assets: declarations,
    };
    manifests.push({
      game: config.game,
      path: `${MANIFEST_DIR}/${config.game}.assets.json`,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      bootIds: [...boot].sort((a, b) => a.localeCompare(b)),
      assetCount: gameAssets.length,
      bootBytes,
      bootGzipBytes,
      totalBytes,
      totalGzipBytes,
    });
  }
  return manifests;
}

function groupTotals(assets: readonly CuratedAsset[]): CurateResult["groups"] {
  return GROUP_ORDER.filter((group) => assets.some((asset) => asset.group === group)).map((group) => {
    const members = assets.filter((asset) => asset.group === group);
    return {
      group,
      files: members.length,
      bytes: members.reduce((total, asset) => total + asset.bytes, 0),
      gzipBytes: sumGzip(members),
    };
  });
}

function gamesByGroup(assets: readonly CuratedAsset[]): { group: CurationGroup; games: string }[] {
  return GROUP_ORDER.map((group) => {
    const games = new Set<string>();
    for (const asset of assets) {
      if (asset.group !== group) continue;
      for (const game of asset.games) games.add(game);
    }
    return { group, games: [...games].sort((a, b) => a.localeCompare(b)).join(", ") };
  }).filter((row) => row.games !== "");
}

interface FileReport {
  readonly id: string;
  readonly path: string;
  readonly kind: string;
  readonly group: string;
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly sha256: string;
  readonly licenceRow: string;
  readonly licence: string;
  readonly sourcePack: string;
  readonly sourcePath: string;
  readonly sourceBytes: number;
  readonly sourceUrl: string;
  readonly accessed: string;
  readonly parent: string | null;
  readonly games: readonly string[];
  readonly derivation: string;
  readonly notes: string;
  readonly clips?: readonly string[];
}

function renderCurationJson(
  assets: readonly CuratedAsset[],
  manifests: readonly CuratedManifest[],
  scan: SourceScan,
  totals: CurateResult["totals"],
  groups: CurateResult["groups"],
): string {
  const files: FileReport[] = [...assets]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((asset) => ({
      id: asset.id,
      path: asset.path,
      kind: asset.kind,
      group: asset.group,
      bytes: asset.bytes,
      gzipBytes: asset.gzipBytes,
      sha256: asset.sha256,
      licenceRow: asset.path,
      licence: asset.licence.licence,
      sourcePack: asset.licence.pack,
      sourcePath: asset.sourcePath,
      sourceBytes: asset.sourceBytes,
      sourceUrl: asset.licence.sourceUrl,
      accessed: asset.licence.accessed,
      parent: asset.parent === "" ? null : asset.parent,
      games: asset.games,
      derivation: asset.derivation,
      notes: asset.notes,
      ...(asset.clips === undefined ? {} : { clips: asset.clips }),
    }));
  const value = {
    schemaVersion: 1,
    generated: CURATION_DATE,
    source: "Game-assets (gitignored local drop)",
    scan,
    totals,
    groups,
    files,
    manifests: manifests.map((manifest) => ({
      game: manifest.game,
      path: manifest.path,
      assets: manifest.assetCount,
      bootAssets: manifest.bootIds.length,
      bootBytes: manifest.bootBytes,
      bootGzipBytes: manifest.bootGzipBytes,
      totalBytes: manifest.totalBytes,
      totalGzipBytes: manifest.totalGzipBytes,
    })),
    exclusions: EXCLUSIONS,
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderCurationMd(
  assets: readonly CuratedAsset[],
  manifests: readonly CuratedManifest[],
  scan: SourceScan,
  totals: CurateResult["totals"],
): string {
  const lines: string[] = [];
  lines.push("# Curated assets");
  lines.push("");
  lines.push(
    `Generated by \`tools/asset-curate\` on ${CURATION_DATE} from the local, gitignored \`Game-assets/\` drop. Do not edit by hand.`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("| --- | ---: |");
  lines.push(`| curated files | ${commas(totals.files)} |`);
  lines.push(`| curated bytes | ${commas(totals.bytes)} |`);
  lines.push(`| per-file gzip bytes | ${commas(totals.gzipBytes)} |`);
  lines.push(`| source files scanned | ${commas(scan.files)} |`);
  lines.push(`| source bytes scanned | ${commas(scan.bytes)} |`);
  lines.push(`| source GLB files | ${commas(scan.glb)} |`);
  lines.push(`| source OGG files | ${commas(scan.ogg)} |`);
  lines.push("");
  lines.push("The ledger at `assets/LICENSES.csv` is the licence source of truth; every row key is the file path below.");
  lines.push("");
  lines.push("## Games served by group");
  lines.push("");
  lines.push("| group | games |");
  lines.push("| --- | --- |");
  for (const row of gamesByGroup(assets)) lines.push(`| ${row.group} | ${row.games} |`);
  lines.push("");
  lines.push("## Files");
  lines.push("");
  lines.push("| id | path | kind | group | bytes | gzip | licence row | games |");
  lines.push("| --- | --- | --- | --- | ---: | ---: | --- | --- |");
  for (const asset of [...assets].sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push(
      `| ${asset.id} | ${asset.path} | ${asset.kind} | ${asset.group} | ${commas(asset.bytes)} | ${commas(asset.gzipBytes)} | ${asset.path} | ${asset.games.join(", ")} |`,
    );
  }
  lines.push("");
  lines.push("## Per-game manifests");
  lines.push("");
  lines.push("| game | manifest | boot assets | boot bytes | boot gzip | total assets | total bytes | total gzip |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const manifest of manifests) {
    lines.push(
      `| ${manifest.game} | ${manifest.path} | ${manifest.bootIds.length} | ${commas(manifest.bootBytes)} | ${commas(manifest.bootGzipBytes)} | ${manifest.assetCount} | ${commas(manifest.totalBytes)} | ${commas(manifest.totalGzipBytes)} |`,
    );
  }
  lines.push("");
  lines.push(
    "The SDK hard cap for eager assets is 5 MiB (5,242,880 bytes). These figures are asset-only; the host and game code share the same cap and must be measured together at integration.",
  );
  lines.push("");
  lines.push("## Exclusions");
  lines.push("");
  lines.push("| pattern | reason |");
  lines.push("| --- | --- |");
  for (const row of EXCLUSIONS) lines.push(`| ${row.pattern} | ${row.reason} |`);
  lines.push("");
  lines.push("## OGG decode (D6)");
  lines.push("");
  lines.push(
    "The curation CLI does not assert browser decode support. The stream C Chrome smoke result is reported in the stream handoff; Firefox and Safari stay pending until run on those engines.",
  );
  lines.push("");
  return lines.join("\n");
}

function writeText(root: string, relative: string, content: string, written: string[]): void {
  const path = absUnder(root, relative);
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  written.push(relative);
}

function materialize(
  planned: readonly PlannedFile[],
  check: boolean,
  errors: string[],
  written: string[],
): void {
  for (const file of planned) {
    const relative = file.asset.path;
    if (file.content === null) {
      if (!existsSync(file.destAbs)) {
        errors.push(`${relative}: derived file is missing`);
        continue;
      }
      if (!check) continue;
      const dest = readFileSync(file.destAbs);
      if (dest.length !== file.asset.bytes || sha256(dest) !== file.asset.sha256) {
        errors.push(`${relative}: derived file does not match the recorded hash`);
      }
      continue;
    }
    if (check) {
      if (!existsSync(file.destAbs)) {
        errors.push(`${relative}: missing from assets/`);
        continue;
      }
      const dest = readFileSync(file.destAbs);
      if (!dest.equals(file.content)) errors.push(`${relative}: assets copy differs from source bytes`);
      continue;
    }
    mkdirSync(dirname(file.destAbs), { recursive: true });
    if (!existsSync(file.destAbs) || !readFileSync(file.destAbs).equals(file.content)) {
      copyFileSync(file.sourceAbs, file.destAbs);
      written.push(relative);
    }
    const copied = readFileSync(file.destAbs);
    if (!copied.equals(file.content)) errors.push(`${relative}: copied bytes do not match source`);
  }
}

export function curate(options: CurateOptions): CurateResult {
  const errors: string[] = [];
  const warnings: string[] = [
    "The 5 MiB boot budget covers host + game + eager assets; this CLI measures assets only.",
    "music.menu-sting is a short jingle, not a loop; Beat Tap must use a self-made track (D8).",
  ];
  const sourceRoot = resolve(options.sourceRoot);
  const assetRoot = resolve(options.assetRoot);
  const check = options.check ?? false;

  let index: ScanIndex;
  try {
    index = scanSource(sourceRoot);
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings,
      files: [],
      ledgerText: "",
      curationJsonText: "",
      curationMdText: "",
      manifests: [],
      scan: { files: 0, bytes: 0, glb: 0, ogg: 0 },
      totals: { files: 0, bytes: 0, gzipBytes: 0 },
      groups: [],
      written: [],
    };
  }

  validateMetadata(SELECTION, errors);
  checkLicenceEvidence(SELECTION, sourceRoot, index, errors);
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      warnings,
      files: [],
      ledgerText: "",
      curationJsonText: "",
      curationMdText: "",
      manifests: [],
      scan: index.scan,
      totals: { files: 0, bytes: 0, gzipBytes: 0 },
      groups: [],
      written: [],
    };
  }

  const planned = buildAssets(sourceRoot, assetRoot, index, errors);
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      warnings,
      files: [],
      ledgerText: "",
      curationJsonText: "",
      curationMdText: "",
      manifests: [],
      scan: index.scan,
      totals: { files: 0, bytes: 0, gzipBytes: 0 },
      groups: [],
      written: [],
    };
  }

  const assets = planned.map((file) => file.asset).sort((a, b) => a.path.localeCompare(b.path));
  const totals = {
    files: assets.length,
    bytes: assets.reduce((total, asset) => total + asset.bytes, 0),
    gzipBytes: sumGzip(assets),
  };
  const groups = groupTotals(assets);
  const ledgerText = formatLedger(assets.map(toLedgerRow));
  const knownFiles = new Set(assets.map((asset) => asset.path));
  errors.push(...validateLedger(parseLedger(ledgerText), { knownFiles }));
  const manifests = buildManifests(assets, errors);
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      warnings,
      files: assets,
      ledgerText,
      curationJsonText: "",
      curationMdText: "",
      manifests,
      scan: index.scan,
      totals,
      groups,
      written: [],
    };
  }

  const curationJsonText = renderCurationJson(assets, manifests, index.scan, totals, groups);
  const curationMdText = renderCurationMd(assets, manifests, index.scan, totals);

  const expected = new Set<string>([
    ...assets.map((asset) => asset.path),
    LICENSES_FILE,
    CURATION_JSON_FILE,
    CURATION_MD_FILE,
    ...manifests.map((manifest) => manifest.path),
  ]);
  for (const relative of listRelativeFiles(assetRoot)) {
    if (!expected.has(relative)) {
      errors.push(`${relative}: unexpected file in assets/ (remove it or add it to the ledger)`);
    }
  }

  const written: string[] = [];
  if (errors.length === 0) {
    materialize(planned, check, errors, written);
    if (check) {
      for (const [relative, content] of [
        [LICENSES_FILE, ledgerText],
        [CURATION_JSON_FILE, curationJsonText],
        [CURATION_MD_FILE, curationMdText],
        ...manifests.map((manifest) => [manifest.path, manifest.content] as const),
      ] as const) {
        const path = absUnder(assetRoot, relative);
        if (!existsSync(path)) errors.push(`${relative}: missing from assets/`);
        else if (readFileSync(path, "utf8") !== content) errors.push(`${relative}: stale; rerun the curator`);
      }
    } else {
      writeText(assetRoot, LICENSES_FILE, ledgerText, written);
      writeText(assetRoot, CURATION_JSON_FILE, curationJsonText, written);
      writeText(assetRoot, CURATION_MD_FILE, curationMdText, written);
      for (const manifest of manifests) writeText(assetRoot, manifest.path, manifest.content, written);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    files: assets,
    ledgerText,
    curationJsonText,
    curationMdText,
    manifests,
    scan: index.scan,
    totals,
    groups,
    written,
  };
}
