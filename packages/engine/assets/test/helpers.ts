/**
 * Test-only builders and a fake same-origin fetch server for the asset
 * package. Every byte here is synthetic; no test opens a socket, reads a
 * clock-sensitive measurement or touches real game content.
 */

import { expect } from "vitest";
import { AssetEngineError } from "../src/errors.js";

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function arrayBufferOf(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
}

export function textBytes(text: string): ArrayBuffer {
  return arrayBufferOf(utf8(text));
}

export function jsonBytes(value: unknown): ArrayBuffer {
  return textBytes(JSON.stringify(value));
}

export function concatBytes(chunks: readonly Uint8Array[]): ArrayBuffer {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    target[offset + index] = text.charCodeAt(index);
  }
}

// ---------------------------------------------------------------------------
// Synthetic GLB
// ---------------------------------------------------------------------------

export interface GlbOptions {
  /** Adds a TANGENT attribute the static-pbr-v1 layout must drop. */
  readonly tangent?: boolean;
  readonly omitNormal?: boolean;
  readonly externalBuffer?: boolean;
  /** Writes index 7 against a three-vertex mesh. */
  readonly badIndex?: boolean;
}

interface GlbDocument {
  readonly asset: { readonly version: string };
  readonly buffers: Array<Record<string, unknown>>;
  readonly bufferViews: Array<Record<string, unknown>>;
  readonly accessors: Array<Record<string, unknown>>;
  readonly meshes: Array<{ primitives: Array<Record<string, unknown>> }>;
  readonly materials: Array<Record<string, unknown>>;
}

/**
 * One triangle, stride-32 static-pbr-v1 vertices, uint16 indices. The BIN
 * chunk is 104 bytes: 3 x 32 vertex bytes followed by 3 x uint16 indices.
 */
export function buildTriangleGlb(options: GlbOptions = {}): ArrayBuffer {
  const bin = new ArrayBuffer(104);
  const binView = new DataView(bin);
  const vertices: readonly (readonly number[])[] = [
    [0, 0, 0, 0, 0, 1, 0, 0],
    [1, 0, 0, 0, 0, 1, 1, 0],
    [0, 1, 0, 0, 0, 1, 0, 1],
  ];
  for (let vertex = 0; vertex < vertices.length; vertex += 1) {
    const values = vertices[vertex];
    if (values === undefined) continue;
    for (let component = 0; component < values.length; component += 1) {
      binView.setFloat32(
        vertex * 32 + component * 4,
        values[component] ?? 0,
        true,
      );
    }
  }
  binView.setUint16(96, 0, true);
  binView.setUint16(98, 1, true);
  binView.setUint16(100, options.badIndex === true ? 7 : 2, true);

  const attributes: Record<string, number> = {
    POSITION: 0,
    TEXCOORD_0: 2,
  };
  if (options.omitNormal !== true) attributes["NORMAL"] = 1;
  if (options.tangent === true) attributes["TANGENT"] = 2;

  const buffer: Record<string, unknown> = { byteLength: 104 };
  if (options.externalBuffer === true) buffer["uri"] = "mesh.bin";

  const document: GlbDocument = {
    asset: { version: "2.0" },
    buffers: [buffer],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 96, byteStride: 32 },
      { buffer: 0, byteOffset: 96, byteLength: 6 },
    ],
    accessors: [
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      {
        bufferView: 0,
        byteOffset: 12,
        componentType: 5126,
        count: 3,
        type: "VEC3",
      },
      {
        bufferView: 0,
        byteOffset: 24,
        componentType: 5126,
        count: 3,
        type: "VEC2",
      },
      {
        bufferView: 1,
        componentType: 5123,
        count: 3,
        type: "SCALAR",
      },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes,
            indices: 3,
            material: 0,
          },
        ],
      },
    ],
    materials: [{ name: "body" }],
  };

  const json = utf8(JSON.stringify(document));
  const padding = (4 - (json.byteLength % 4)) % 4;
  const jsonPadded = new Uint8Array(json.byteLength + padding);
  jsonPadded.set(json);
  jsonPadded.fill(0x20, json.byteLength);

  const total = 12 + 8 + jsonPadded.byteLength + 8 + bin.byteLength;
  const output = new ArrayBuffer(total);
  const view = new DataView(output);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(output, 20, jsonPadded.byteLength).set(jsonPadded);
  const binHeader = 20 + jsonPadded.byteLength;
  view.setUint32(binHeader, bin.byteLength, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  new Uint8Array(output, binHeader + 8, bin.byteLength).set(
    new Uint8Array(bin),
  );
  return output;
}

// ---------------------------------------------------------------------------
// Synthetic KTX2
// ---------------------------------------------------------------------------

export const KTX2_SIGNATURE = [
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
] as const;

export interface Ktx2Options {
  readonly vkFormat?: number;
  readonly width?: number;
  readonly height?: number;
  /** Overrides the complete mip-chain level count. */
  readonly levelCount?: number;
  readonly supercompressionScheme?: number;
  /** Added to every level byteOffset; use a non-multiple of 4 to break alignment. */
  readonly levelOffsetDelta?: number;
}

interface BlockInfo {
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly blockBytes: number;
}

function ktxBlock(vkFormat: number): BlockInfo {
  if (vkFormat === 37 || vkFormat === 43) {
    return { blockWidth: 1, blockHeight: 1, blockBytes: 4 };
  }
  if (vkFormat === 131 || vkFormat === 132) {
    return { blockWidth: 4, blockHeight: 4, blockBytes: 8 };
  }
  return { blockWidth: 4, blockHeight: 4, blockBytes: 16 };
}

/** Header + complete level index + level bytes for a pre-transcoded KTX2. */
export function buildKtx2(options: Ktx2Options = {}): ArrayBuffer {
  const vkFormat = options.vkFormat ?? 37;
  const width = options.width ?? 2;
  const height = options.height ?? 2;
  const levelCount =
    options.levelCount ?? 1 + Math.floor(Math.log2(Math.max(width, height)));
  const block = ktxBlock(vkFormat);
  const levels: Array<{ offset: number; length: number }> = [];
  let offset = 80 + levelCount * 24 + (options.levelOffsetDelta ?? 0);
  for (let level = 0; level < levelCount; level += 1) {
    const levelWidth = Math.max(1, width >> level);
    const levelHeight = Math.max(1, height >> level);
    const length =
      Math.ceil(levelWidth / block.blockWidth) *
      Math.ceil(levelHeight / block.blockHeight) *
      block.blockBytes;
    levels.push({ offset, length });
    offset += length;
  }

  const output = new ArrayBuffer(offset);
  const bytes = new Uint8Array(output);
  for (let index = 0; index < KTX2_SIGNATURE.length; index += 1) {
    bytes[index] = KTX2_SIGNATURE[index] ?? 0;
  }
  const view = new DataView(output);
  view.setUint32(12, vkFormat, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(28, 0, true);
  view.setUint32(32, 0, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, levelCount, true);
  view.setUint32(44, options.supercompressionScheme ?? 0, true);

  for (let level = 0; level < levelCount; level += 1) {
    const info = levels[level];
    if (info === undefined) continue;
    const entry = 80 + level * 24;
    view.setBigUint64(entry, BigInt(info.offset), true);
    view.setBigUint64(entry + 8, BigInt(info.length), true);
    view.setBigUint64(entry + 16, BigInt(info.length), true);
  }
  for (const info of levels) {
    bytes.fill(0x7f, info.offset, info.offset + info.length);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Synthetic images
// ---------------------------------------------------------------------------

/** A PNG header long enough for `readPngDimensions` (signature + IHDR). */
export function buildPngHeader(width: number, height: number): ArrayBuffer {
  const output = new ArrayBuffer(33);
  const bytes = new Uint8Array(output);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(output);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return output;
}

/** A lossless WebP header (VP8L) that carries width and height. */
export function buildWebpVp8l(width: number, height: number): ArrayBuffer {
  const output = new ArrayBuffer(25);
  const bytes = new Uint8Array(output);
  const view = new DataView(output);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 25 - 8, true);
  writeAscii(bytes, 8, "WEBP");
  writeAscii(bytes, 12, "VP8L");
  view.setUint32(16, 2, true);
  bytes[20] = 0x2f;
  view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return output;
}

// ---------------------------------------------------------------------------
// Synthetic fonts and audio
// ---------------------------------------------------------------------------

/** A minimal WOFF2 header; `length` may deliberately disagree with the buffer. */
export function buildWoff2(length = 48): ArrayBuffer {
  const output = new ArrayBuffer(Math.max(48, length));
  const view = new DataView(output);
  view.setUint32(0, 0x774f4632, false);
  view.setUint32(4, 0x00010000, false);
  view.setUint32(8, length, false);
  view.setUint16(12, 1, false);
  return output;
}

export type TestAudioContainer = "ogg" | "webm" | "wav" | "m4a";

/** A 16-byte container signature recognised by the audio sniffer. */
export function buildAudio(container: TestAudioContainer): ArrayBuffer {
  const output = new ArrayBuffer(16);
  const bytes = new Uint8Array(output);
  if (container === "ogg") {
    writeAscii(bytes, 0, "OggS");
  } else if (container === "webm") {
    bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  } else if (container === "wav") {
    writeAscii(bytes, 0, "RIFF");
    writeAscii(bytes, 8, "WAVE");
  } else {
    writeAscii(bytes, 4, "ftyp");
  }
  return output;
}

// ---------------------------------------------------------------------------
// Fake fetch server
// ---------------------------------------------------------------------------

export interface FakeRoute {
  readonly status?: number;
  readonly chunks?: readonly Uint8Array[];
  readonly body?: string | Uint8Array | ArrayBuffer;
  readonly contentType?: string | null;
  /** "auto" (default) sets the true body length; null omits the header. */
  readonly contentLength?: number | null | "auto";
  /** Keeps the request pending until its signal aborts. */
  readonly hang?: boolean;
  readonly delayMs?: number;
}

function routeBody(route: FakeRoute): readonly Uint8Array[] {
  if (route.chunks !== undefined) return route.chunks;
  const body = route.body ?? new Uint8Array(0);
  if (typeof body === "string") return [utf8(body)];
  if (body instanceof Uint8Array) return [body];
  return [new Uint8Array(body)];
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/**
 * A same-origin fake server. Manifest and asset URLs are absolute; only the
 * routes registered here can ever answer, so no test can reach the network.
 */
export class FakeServer {
  readonly calls: string[] = [];
  readonly inits: Array<RequestInit | undefined> = [];
  readonly manifestUrl: string;
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  private readonly routes = new Map<string, FakeRoute>();

  constructor(manifestUrl: string, manifestText: string) {
    this.manifestUrl = manifestUrl;
    this.baseUrl = new URL(".", manifestUrl).href;
    this.routes.set(manifestUrl, {
      body: manifestText,
      contentType: "application/json; charset=utf-8",
    });
    this.fetch = (input, init) => this.handle(input, init);
  }

  add(key: string, route: FakeRoute): string {
    const url = this.urlOf(key);
    this.routes.set(url, route);
    return url;
  }

  remove(key: string): void {
    this.routes.delete(this.urlOf(key));
  }

  urlOf(key: string): string {
    return new URL(key, this.baseUrl).href;
  }

  assetCalls(): readonly string[] {
    return this.calls.filter((url) => url !== this.manifestUrl);
  }

  private async handle(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = urlOf(input);
    this.calls.push(url);
    this.inits.push(init);
    const route = this.routes.get(url) ?? {
      status: 404,
      body: "not found",
      contentType: "text/plain",
    };
    if (route.hang === true) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = (): void => {
          reject(new DOMException("aborted", "AbortError"));
        };
        if (signal?.aborted === true) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (route.delayMs !== undefined && route.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, route.delayMs);
      });
    }
    if (init?.signal?.aborted === true) {
      throw new DOMException("aborted", "AbortError");
    }

    const chunks = routeBody(route);
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const headers = new Headers();
    const contentType =
      route.contentType === undefined
        ? "application/octet-stream"
        : route.contentType;
    if (contentType !== null) headers.set("content-type", contentType);
    const contentLength =
      route.contentLength === undefined ? "auto" : route.contentLength;
    if (contentLength !== null) {
      headers.set(
        "content-length",
        String(contentLength === "auto" ? total : contentLength),
      );
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return new Response(stream, {
      status: route.status ?? 200,
      headers,
    });
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

export function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

export async function catchAsync(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

export function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(AssetEngineError);
  expect((error as AssetEngineError).code).toBe(code);
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
