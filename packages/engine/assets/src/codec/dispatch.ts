/**
 * Decode dispatch by kind and container (06 §5.1, §5.6).
 *
 * The worker entry and the main-thread fallback share this function so the
 * two paths cannot drift. It never touches the network and never allocates
 * outside the decode itself.
 */

import type {
  AssetCapability,
  AssetContainer,
  AssetKind,
  AssetTextureFormat,
  AssetValue,
  AudioMimeType,
} from "../contracts/assets.js";
import { assetError } from "../errors.js";
import { containerForUrl } from "../manifest.js";
import type { CreateImageBitmapFn, ReadPixelsFn } from "./image.js";
import { decodeImage } from "./image.js";
import { decodeGlb } from "./glb.js";
import { decodeKtx2 } from "./ktx2.js";
import { decodeAudio } from "./audio.js";
import { decodeFont } from "./font.js";
import { decodeJson } from "./json.js";
import { decodeMaterial } from "./material.js";

export interface DecodeDispatchOptions {
  readonly id: string;
  readonly kind: AssetKind;
  /** Absent for JSON/material/atlas payloads. */
  readonly container?: AssetContainer;
  readonly url: string;
  readonly bytes: ArrayBuffer;
  /** Audio only. */
  readonly mimeType?: AudioMimeType;
  readonly capabilities?: ReadonlySet<AssetCapability>;
  /** Texture only; cross-checked against the decoded container when present. */
  readonly format?: AssetTextureFormat;
  /** Material only. */
  readonly lookupKind: (assetId: string) => AssetKind | undefined;
  /** Image only; tests inject a fake factory. */
  readonly createBitmap?: CreateImageBitmapFn;
  readonly readPixels?: ReadPixelsFn;
}

export interface DecodeOutcome {
  readonly value: AssetValue<AssetKind>;
  /** Mesh only (06 §4.5). */
  readonly droppedAttributes?: number;
}

function incompatible(
  id: string,
  kind: AssetKind,
  container: AssetContainer | undefined,
): never {
  throw assetError(
    "E_ASSET_FORMAT",
    `${id}: kind ${kind} cannot be decoded from ${container ?? "an unknown container"}`,
    id,
  );
}

function textureContainer(
  id: string,
  container: AssetContainer | undefined,
  url: string,
): "ktx2" | "webp" | "png" {
  const resolved = container ?? containerForUrl(url);
  if (resolved === "ktx2" || resolved === "webp" || resolved === "png") {
    return resolved;
  }
  return incompatible(id, "texture", resolved);
}

/**
 * Decodes one asset value. Throws an `AssetEngineError` for every failure;
 * the pool converts it to `AssetDecodeResult`.
 */
export async function decodeAsset(
  options: DecodeDispatchOptions,
): Promise<DecodeOutcome> {
  const { id, bytes, url } = options;

  switch (options.kind) {
    case "mesh": {
      const container = options.container ?? containerForUrl(url);
      if (container !== "glb") incompatible(id, "mesh", container);
      const decoded = decodeGlb(id, bytes);
      return {
        value: decoded.mesh,
        droppedAttributes: decoded.droppedAttributes,
      };
    }

    case "texture": {
      const container = textureContainer(id, options.container, url);
      const value =
        container === "ktx2"
          ? decodeKtx2({
              id,
              bytes,
              ...(options.capabilities !== undefined
                ? { capabilities: options.capabilities }
                : {}),
            })
          : await decodeImage({
              id,
              bytes,
              container,
              ...(options.createBitmap !== undefined
                ? { createBitmap: options.createBitmap }
                : {}),
              ...(options.readPixels !== undefined
                ? { readPixels: options.readPixels }
                : {}),
            });
      if (options.format !== undefined && value.format !== options.format) {
        throw assetError(
          "E_ASSET_FORMAT",
          `${id}: decoded texture format ${value.format} does not match the manifest ${options.format}`,
          id,
        );
      }
      return { value };
    }

    case "material":
      return {
        value: decodeMaterial({
          id,
          bytes,
          lookupKind: options.lookupKind,
        }),
      };

    case "audio":
      return {
        value: decodeAudio({
          id,
          url,
          bytes,
          ...(options.container !== undefined
            ? { container: options.container }
            : {}),
          ...(options.mimeType !== undefined
            ? { mimeType: options.mimeType }
            : {}),
        }),
      };

    case "font":
      return {
        value: decodeFont({
          id,
          bytes,
          ...(options.container === "woff2"
            ? { container: "woff2" as const }
            : {}),
        }),
      };

    case "json":
      return { value: decodeJson({ id, bytes }) };

    case "scene":
    case "animation":
      throw assetError(
        "E_ASSET_UNSUPPORTED",
        `${id}: kind ${options.kind} is not implemented in M0`,
        id,
      );
  }
}

/** CPU bytes charged for a decoded value (06 §5.5). */
export function decodedBytesOf(
  kind: AssetKind,
  value: AssetValue<AssetKind>,
): number {
  switch (kind) {
    case "mesh": {
      const mesh = value as AssetValue<"mesh">;
      let total = 0;
      for (const primitive of mesh.primitives) {
        total += primitive.vertices.byteLength + primitive.indices.byteLength;
      }
      return total;
    }
    case "texture": {
      const texture = value as AssetValue<"texture">;
      let total = 0;
      for (const level of texture.levels) total += level.bytes.byteLength;
      return total;
    }
    case "audio": {
      const audio = value as AssetValue<"audio">;
      return audio.kind === "encoded" ? audio.bytes.byteLength : 0;
    }
    case "font": {
      const font = value as AssetValue<"font">;
      return font.kind === "woff2" ? font.bytes.byteLength : 0;
    }
    case "json":
    case "material":
    case "scene":
    case "animation":
      return 0;
  }
}

/** True when the kind's payload is metadata, not a CPU-decoded buffer. */
export function isMetadataKind(kind: AssetKind): boolean {
  return kind === "json" || kind === "material" || kind === "scene";
}
