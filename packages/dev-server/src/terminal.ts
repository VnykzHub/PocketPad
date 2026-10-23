/**
 * Boot banner and terminal QR for the dev server (D0-SRV-01, SR-3).
 *
 * The LAN-only warning is part of the frozen boot output: the dev server has
 * no TLS and no production hardening, so it must never be run on a public
 * network.
 */
import qrcode from "qrcode";

/** Exact warning required by SR-3 when TLS is off. */
export const LAN_ONLY_WARNING = [
  "WARNING: LAN only. This server has no TLS and no production hardening.",
  "Do not expose it to a public network. (SR-3)",
].join("\n");

/** Warning when opt-in TLS is active; still a development server. */
export const TLS_DEV_WARNING = [
  "WARNING: LAN only. Opt-in TLS is active, but this is still a development",
  "server with no production hardening. Do not expose it to a public network.",
].join("\n");

export interface BannerOptions {
  /** Room code to show in the controller URL; `<CODE>` until a room exists. */
  roomCode?: string;
  /** True when the server is listening over HTTPS (D5). */
  tls?: boolean;
}

/**
 * Builds the boot banner. Every URL is listed so a phone can be pointed at
 * whichever interface the LAN actually uses.
 */
export function formatBanner(urls: readonly string[], options: BannerOptions = {}): string {
  const primary = urls.find((url) => !url.includes("localhost")) ?? urls[0] ?? "http://localhost";
  const roomCode = options.roomCode ?? "<CODE>";
  const lines = [
    "lanpad dev server",
    `TV / host:   ${primary}/`,
    `Controller:  ${primary}/c/${roomCode}`,
  ];
  if (urls.length > 0) {
    lines.push("All URLs:");
    for (const url of urls) {
      lines.push(`  ${url}/`);
    }
  }
  lines.push(options.tls === true ? TLS_DEV_WARNING : LAN_ONLY_WARNING);
  return lines.join("\n");
}

/** Terminal QR for the root URL (qrcode's ANSI block renderer). */
export function formatQr(url: string): Promise<string> {
  return qrcode.toString(url, { type: "terminal", small: true });
}

export interface BootOutput {
  write(chunk: string): unknown;
}

export interface BootOptions extends BannerOptions {
  /** Defaults to `process.stdout`; tests pass a buffer. */
  output?: BootOutput;
}

/** Prints the banner followed by the QR, in that order. */
export async function printBootInfo(
  urls: readonly string[],
  options: BootOptions = {},
): Promise<void> {
  const output = options.output ?? process.stdout;
  output.write(`${formatBanner(urls, options)}\n`);
  const primary = urls[0];
  if (primary !== undefined) {
    output.write(`${await formatQr(`${primary}/`)}\n`);
  }
}
