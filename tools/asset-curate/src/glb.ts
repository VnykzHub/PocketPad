/**
 * Minimal GLB reader for curation.
 *
 * Kenney GLBs embed geometry but reference `Textures/*.png` externally, so a
 * curated GLB is only complete when those files are copied beside it. This
 * module reads just enough of the container to list those dependencies and
 * animation names; it is not a renderer loader.
 */

export interface GlbInfo {
  readonly generator: string;
  readonly animations: readonly string[];
  readonly images: readonly string[];
  readonly buffers: readonly string[];
  readonly skins: number;
  readonly meshes: number;
}

export class GlbParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlbParseError";
  }
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"

interface GlbJson {
  readonly asset?: { readonly generator?: unknown };
  readonly animations?: readonly { readonly name?: unknown }[];
  readonly images?: readonly { readonly uri?: unknown }[];
  readonly buffers?: readonly { readonly uri?: unknown }[];
  readonly skins?: readonly unknown[];
  readonly meshes?: readonly unknown[];
}

/**
 * Rejects paths that could escape the curated tree or fetch a remote URL.
 * GLB URIs are percent-encoded in some exporters; only plain relative paths
 * are accepted here, which is what the Kenney packs use.
 */
export function isSafeGlbUri(uri: string): boolean {
  if (uri.length === 0 || uri.length > 200) return false;
  if (uri.startsWith("/") || uri.endsWith("/")) return false;
  if (uri.includes("\\") || uri.includes("://") || uri.includes("?")) return false;
  if (/^[A-Za-z]:/.test(uri)) return false;
  return uri
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\u0000"));
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseGlb(buffer: Uint8Array): GlbInfo {
  if (buffer.length < 20) throw new GlbParseError("file is shorter than a GLB header and JSON chunk");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new GlbParseError("bad GLB magic");
  const version = view.getUint32(4, true);
  if (version !== 2) throw new GlbParseError(`unsupported GLB version ${version}`);
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== buffer.length) {
    throw new GlbParseError(`declared length ${declaredLength} does not match file length ${buffer.length}`);
  }
  const jsonLength = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (jsonType !== CHUNK_JSON) throw new GlbParseError("first chunk is not JSON");
  if (20 + jsonLength > buffer.length) throw new GlbParseError("JSON chunk runs past end of file");

  const jsonText = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(20, 20 + jsonLength));
  let json: GlbJson;
  try {
    json = JSON.parse(jsonText) as GlbJson;
  } catch {
    throw new GlbParseError("JSON chunk is not valid JSON");
  }

  const images: string[] = [];
  for (const image of json.images ?? []) {
    const uri = stringField(image.uri);
    if (uri !== "") {
      if (!isSafeGlbUri(uri)) throw new GlbParseError(`unsafe image uri "${uri}"`);
      images.push(uri);
    }
  }
  const buffers: string[] = [];
  for (const buffer of json.buffers ?? []) {
    const uri = stringField(buffer.uri);
    if (uri !== "") {
      if (!isSafeGlbUri(uri)) throw new GlbParseError(`unsafe buffer uri "${uri}"`);
      buffers.push(uri);
    }
  }
  const animations = (json.animations ?? [])
    .map((animation) => stringField(animation.name))
    .filter((name) => name !== "");

  return {
    generator: stringField(json.asset?.generator),
    animations,
    images,
    buffers,
    skins: json.skins?.length ?? 0,
    meshes: json.meshes?.length ?? 0,
  };
}
