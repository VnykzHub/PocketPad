/**
 * QR rendering for the host room panel (D4-HOST-01; FR-5.1, SR-2).
 *
 * The join URL is `<publicOrigin>/c/<CODE>#<roomToken>`. The room token is
 * appended after the `#` only: it never appears in the path or query, is
 * never written to the DOM as text or an attribute, and is never logged.
 *
 * QR generation is isolated here so P2 can swap in a server-rendered image
 * without touching `RoomPanel`.
 */
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  TOKEN_LENGTH,
} from "@lanpad/protocol";
import QRCode from "qrcode";

/** Canvas backing size in device pixels; CSS presents it large on a TV. */
export const QR_CANVAS_SIZE = 384;

/** The subset of `qrcode`'s canvas options this module relies on. */
export interface QrRenderOptions {
  readonly errorCorrectionLevel: "L" | "M" | "Q" | "H";
  readonly margin: number;
  readonly width: number;
  readonly color: { readonly dark: string; readonly light: string };
}

export const DEFAULT_QR_RENDER_OPTIONS: QrRenderOptions = {
  errorCorrectionLevel: "M",
  margin: 2,
  width: QR_CANVAS_SIZE,
  color: { dark: "#000000", light: "#ffffff" },
};

/**
 * Renders `text` into `canvas`. Injectable so tests and any future
 * server-rendered QR can replace the `qrcode` implementation.
 */
export type QrRenderer = (
  canvas: HTMLCanvasElement,
  text: string,
  options: QrRenderOptions,
) => Promise<unknown>;

export const defaultQrRenderer: QrRenderer = (canvas, text, options) =>
  QRCode.toCanvas(canvas, text, options);

const ROOM_CODE_PATTERN = new RegExp(
  `^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`,
);
const ROOM_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`);

type BuildTimeMeta = ImportMeta & {
  readonly env?: Readonly<Record<string, unknown>>;
};

/**
 * Reads `VITE_PUBLIC_ORIGIN` (the pages origin in production) from Vite's
 * build-time env, with a guarded `process.env` fallback for Node tools.
 * `location.origin` is the dev default; the relay/server origin is never used
 * because a QR must point at the page that serves the controller.
 */
function readConfiguredPublicOrigin(): string | undefined {
  const viteValue = (import.meta as BuildTimeMeta).env?.VITE_PUBLIC_ORIGIN;
  const nodeProcess = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  const nodeValue = nodeProcess?.env?.VITE_PUBLIC_ORIGIN;

  for (const value of [viteValue, nodeValue]) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readLocationOrigin(): string | undefined {
  const location = globalThis.location;
  if (location === undefined || typeof location.origin !== "string") {
    return undefined;
  }
  const origin = location.origin.trim();
  return origin.length > 0 && origin !== "null" ? origin : undefined;
}

/**
 * Normalizes a pages origin: absolute http(s), no trailing slash, query and
 * fragment dropped. A path prefix is preserved so a pages deployment under
 * `/tv` still yields `/tv/c/<CODE>#<TOKEN>`.
 *
 * @throws when the value is not an absolute http(s) URL. The message never
 * echoes the value, so a misconfigured secret cannot leak through an error.
 */
export function normalizePublicOrigin(publicOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(publicOrigin);
  } catch {
    throw new Error(
      "Invalid public origin: expected an absolute http or https URL.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      "Invalid public origin: expected an http or https URL.",
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * Resolves the origin a phone should open: an explicit value, then
 * `VITE_PUBLIC_ORIGIN`, then `location.origin` (the dev LAN address).
 *
 * @throws when no source is configured or the value is not an http(s) URL.
 */
export function resolvePublicOrigin(explicit?: string): string {
  const candidate =
    explicit ?? readConfiguredPublicOrigin() ?? readLocationOrigin();
  if (candidate === undefined || candidate.trim().length === 0) {
    throw new Error(
      "Cannot resolve the public origin: pass one explicitly, set VITE_PUBLIC_ORIGIN at build time, or run in a browser.",
    );
  }
  return normalizePublicOrigin(candidate);
}

/**
 * Builds the join URL with the room token in the fragment only (FR-5.1,
 * SR-2). The code is validated against the protocol alphabet and the token
 * against the base64url token shape before either reaches a URL.
 *
 * @throws without echoing the code or token in the message.
 */
export function buildJoinUrl(
  publicOrigin: string,
  code: string,
  roomToken: string,
): string {
  const base = normalizePublicOrigin(publicOrigin);
  if (!ROOM_CODE_PATTERN.test(code)) {
    throw new Error(
      `Invalid room code: expected ${ROOM_CODE_LENGTH} Crockford base32 characters.`,
    );
  }
  if (!ROOM_TOKEN_PATTERN.test(roomToken)) {
    throw new Error(
      `Invalid room token: expected ${TOKEN_LENGTH} base64url characters.`,
    );
  }
  // Only this line sees the token. It goes after "#", never before it.
  return `${base}/c/${code}#${roomToken}`;
}

/** Renders a join URL through the injected (or default `qrcode`) renderer. */
export async function renderJoinQr(
  canvas: HTMLCanvasElement,
  joinUrl: string,
  renderer: QrRenderer = defaultQrRenderer,
  options: QrRenderOptions = DEFAULT_QR_RENDER_OPTIONS,
): Promise<void> {
  await renderer(canvas, joinUrl, options);
}
