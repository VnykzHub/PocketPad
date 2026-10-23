/**
 * Audio container sniffing and routing (06 §4.10).
 *
 * This package never creates an AudioContext and never calls
 * `decodeAudioData`. It returns encoded bytes or a same-origin stream URL,
 * plus the MIME type engine-audio needs after gesture unlock.
 */

import type {
  AssetContainer,
  AudioAssetData,
  AudioMimeType,
} from "../contracts/assets.js";
import { assetError } from "../errors.js";

export const AUDIO_STREAM_THRESHOLD_SECONDS = 30;
export const AUDIO_STREAM_THRESHOLD_BYTES = 1_048_576;

export type AudioContainer = "ogg" | "webm" | "m4a" | "wav";

export interface AudioDecodeOptions {
  readonly id: string;
  readonly url: string;
  readonly bytes: ArrayBuffer;
  readonly container?: AssetContainer;
  readonly mimeType?: AudioMimeType;
  readonly durationSeconds?: number;
  /** Manifest override; true always streams, false always buffers. */
  readonly streaming?: boolean;
}

export interface AudioStreamOptions {
  readonly id: string;
  readonly url: string;
  readonly container?: AssetContainer;
  readonly mimeType?: AudioMimeType;
  readonly durationSeconds?: number;
}

const AUDIO_CONTAINERS: ReadonlySet<string> = new Set([
  "ogg",
  "webm",
  "m4a",
  "wav",
]);

const EXTENSION_CONTAINER: Readonly<Record<string, AudioContainer>> = {
  ".ogg": "ogg",
  ".webm": "webm",
  ".m4a": "m4a",
  ".mp4": "m4a",
  ".wav": "wav",
};

const CONTAINER_MIME: Readonly<Record<AudioContainer, AudioMimeType>> = {
  ogg: "audio/ogg",
  webm: "audio/webm",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

function fail(id: string, reason: string): never {
  throw assetError("E_ASSET_FORMAT", `${id}: ${reason}`, id);
}

function isAudioContainer(value: string): value is AudioContainer {
  return AUDIO_CONTAINERS.has(value);
}

/** Audio container implied by a validated URL extension, if any. */
export function audioContainerFromUrl(
  url: string,
): AudioContainer | undefined {
  const lower = url.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXTENSION_CONTAINER[lower.slice(dot)];
}

/** MIME type for a container. */
export function audioMimeForContainer(
  container: AudioContainer,
): AudioMimeType {
  return CONTAINER_MIME[container];
}

/** Container signature sniff (06 §4.10); throws `E_ASSET_FORMAT` on mismatch. */
export function sniffAudioContainer(
  id: string,
  bytes: ArrayBuffer,
): AudioContainer {
  if (bytes.byteLength < 12) fail(id, "audio is too small to sniff");
  const u8 = new Uint8Array(bytes);
  if (u8[0] === 0x4f && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53) {
    return "ogg";
  }
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) {
    return "webm";
  }
  if (
    u8[0] === 0x52 &&
    u8[1] === 0x49 &&
    u8[2] === 0x46 &&
    u8[3] === 0x46 &&
    u8[8] === 0x57 &&
    u8[9] === 0x41 &&
    u8[10] === 0x56 &&
    u8[11] === 0x45
  ) {
    return "wav";
  }
  if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
    return "m4a";
  }
  fail(id, "audio container signature is not recognized");
}

/**
 * Stream when `durationSeconds > 30` or `bytes > 1 MiB`; a manifest
 * `streaming` boolean overrides either way (09 §4.1).
 */
export function shouldStreamAudio(
  byteLength: number,
  durationSeconds: number | undefined,
  streaming: boolean | undefined,
): boolean {
  if (streaming === true) return true;
  if (streaming === false) return false;
  if (
    durationSeconds !== undefined &&
    durationSeconds > AUDIO_STREAM_THRESHOLD_SECONDS
  ) {
    return true;
  }
  return byteLength > AUDIO_STREAM_THRESHOLD_BYTES;
}

function resolveMime(
  id: string,
  url: string,
  container: AudioContainer,
  declared: AudioMimeType | undefined,
): AudioMimeType {
  const expected = CONTAINER_MIME[container];
  const fromUrl = audioContainerFromUrl(url);
  if (fromUrl !== undefined && fromUrl !== container) {
    fail(id, "audio url extension does not agree with the container signature");
  }
  if (declared !== undefined && declared !== expected) {
    fail(id, "declared audio mimeType does not agree with the signature");
  }
  return expected;
}

/**
 * Decodes an audio asset to transport data. The bytes are intentionally
 * passed through; this is a sniff and route step, not a codec.
 */
export function decodeAudio(options: AudioDecodeOptions): AudioAssetData {
  const { id, bytes, url } = options;
  const sniffed = sniffAudioContainer(id, bytes);
  const declaredContainer =
    options.container !== undefined && isAudioContainer(options.container)
      ? options.container
      : undefined;
  if (declaredContainer !== undefined && declaredContainer !== sniffed) {
    fail(id, "audio container hint does not agree with the signature");
  }
  const mimeType = resolveMime(id, url, sniffed, options.mimeType);

  if (
    shouldStreamAudio(
      bytes.byteLength,
      options.durationSeconds,
      options.streaming,
    )
  ) {
    return {
      kind: "stream",
      url,
      mimeType,
      ...(options.durationSeconds !== undefined
        ? { durationSeconds: options.durationSeconds }
        : {}),
    };
  }

  return {
    kind: "encoded",
    bytes,
    mimeType,
    ...(options.durationSeconds !== undefined
      ? { durationSeconds: options.durationSeconds }
      : {}),
    streaming: false,
  };
}

/**
 * Builds a stream result without fetching bytes. The library calls this for
 * an audio entry whose route is stream, so playback (engine-audio) performs
 * the request and it is excluded from asset progress.
 */
export function streamAudio(options: AudioStreamOptions): AudioAssetData {
  const { id, url } = options;
  const fromUrl = audioContainerFromUrl(url);
  const declared =
    options.container !== undefined && isAudioContainer(options.container)
      ? options.container
      : undefined;
  const container = declared ?? fromUrl;
  if (container === undefined) {
    fail(id, "audio stream url has no recognized container");
  }
  if (declared !== undefined && fromUrl !== undefined && declared !== fromUrl) {
    fail(id, "audio url extension does not agree with the declared container");
  }
  const mimeType = resolveMime(id, url, container, options.mimeType);
  return {
    kind: "stream",
    url,
    mimeType,
    ...(options.durationSeconds !== undefined
      ? { durationSeconds: options.durationSeconds }
      : {}),
  };
}
