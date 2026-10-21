/**
 * E14 mixed-content probe page controller (D1-EXP-05).
 *
 * The page tests three things from whatever origin serves it:
 * 1. `ws://<LAN-IP>:<port>/ws` - the mixed-content / private-network case.
 * 2. `http://<LAN-IP>:<port>/healthz` - the same case over fetch.
 * 3. `ws://localhost:<port>/ws` - a control that is exempt from mixed-content
 *    blocking because loopback is potentially trustworthy.
 *
 * Safety rules:
 * - Nothing runs on load. `mountE14Page()` only reads the page context and
 *   attaches click listeners.
 * - Every attempt is a user action, sends no application data, uses a GET for
 *   fetch with `credentials: "omit"`, and persists nothing (no cookies, no
 *   browser storage, no analytics).
 * - The page reports the browser's exact error name/message and elapsed time;
 *   when the browser hides the reason, it says so instead of guessing.
 *
 * The controller takes `Document` and `Window` as parameters so the no-network
 * mount behaviour can be tested without a browser. `boot.js` is the only place
 * that calls it with the real globals.
 */

import { classifyBlockReason, deriveControlWsUrl, validateLanWsUrl } from "./validate.js";
import type { BlockReason, LanUrlResult } from "./validate.js";

export const REPORT_SCHEMA_VERSION = 1;
export const CONNECT_TIMEOUT_MS = 4000;

/**
 * `Window` in the DOM lib does not expose the global constructors as
 * properties, so the injected environment names the two the probe uses.
 */
export type E14Window = Window & {
  WebSocket: typeof WebSocket;
  AbortController: typeof AbortController;
};

export type AttemptId = "lan-ws" | "lan-fetch" | "localhost-ws";
export type AttemptOutcome = "opened" | "allowed" | "blocked" | "error" | "timeout" | "closed";

export interface AttemptRecord {
  attempt: AttemptId;
  label: string;
  target: string;
  outcome: AttemptOutcome;
  /** Best-effort cause; the exact browser error is in errorName/errorMessage. */
  blockedBy: BlockReason | null;
  errorName: string | null;
  errorMessage: string | null;
  elapsedMs: number;
  pageProtocol: string;
  secureContext: boolean;
  note: string;
}

export interface E14Report {
  schema: number;
  experiment: "E14";
  title: string;
  ranAt: string;
  /** Origin plus path only; query and fragment are never included. */
  pageUrl: string;
  userAgent: string;
  isSecureContext: boolean;
  attempts: AttemptRecord[];
}

export interface MountOptions {
  /** Injected wall clock; defaults to `new Date()`. */
  now?: () => Date;
  /** Injected monotonic clock; defaults to `window.performance.now()`. */
  performanceNow?: () => number;
  /** Per-attempt timeout; defaults to `CONNECT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface E14PageController {
  runLanWebSocket: () => Promise<AttemptRecord | null>;
  runLanFetch: () => Promise<AttemptRecord | null>;
  runLocalhostControl: () => Promise<AttemptRecord | null>;
  getReport: () => E14Report;
}

interface AttemptOutcomeData {
  outcome: AttemptOutcome;
  blockedBy: BlockReason | null;
  errorName: string | null;
  errorMessage: string | null;
  elapsedMs: number;
  note: string;
}

interface Elements {
  input: HTMLInputElement;
  validation: HTMLElement;
  status: HTMLElement;
  table: HTMLTableElement;
  json: HTMLElement;
  copy: HTMLButtonElement;
  lanWsButton: HTMLButtonElement;
  lanFetchButton: HTMLButtonElement;
  localhostButton: HTMLButtonElement;
  contextList: HTMLElement;
  contextNote: HTMLElement;
}

function errorNameOf(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  return "Error";
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  return String(error);
}

function requireElement<T extends Element>(doc: Document, id: string): T {
  const element = doc.getElementById(id);
  if (element === null) {
    throw new Error(`E14 markup is missing #${id}`);
  }
  return element as unknown as T;
}

function outcomeClass(outcome: AttemptOutcome): string {
  return outcome === "opened" || outcome === "allowed" ? "status-pass" : "status-fail";
}

async function copyText(doc: Document, win: Window, text: string): Promise<boolean> {
  try {
    const clipboard = win.navigator.clipboard as Clipboard | undefined;
    if (clipboard !== undefined && typeof clipboard.writeText === "function") {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API needs a secure context; fall through to the local copy.
  }

  try {
    const textarea = doc.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.className = "copy-buffer";
    doc.body.appendChild(textarea);
    textarea.select();
    const copied = doc.execCommand("copy");
    doc.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

/**
 * Attempts one WebSocket connection. Resolves with a record rather than
 * rejecting: a blocked connection is a result, not an exception.
 */
async function attemptWebSocket(
  doc: Document,
  win: E14Window,
  target: string,
  timeoutMs: number,
  nowMs: () => number,
): Promise<AttemptOutcomeData> {
  return await new Promise<AttemptOutcomeData>((resolve) => {
    const startedAt = nowMs();
    let settled = false;
    let socket: WebSocket | null = null;
    let timer: number | null = null;
    // A holder object keeps the closure assignment visible to the control-flow
    // analysis that narrows a plain local variable to null.
    const violation: { current: SecurityPolicyViolationEvent | null } = { current: null };

    const onViolation = (event: Event): void => {
      const candidate = event as SecurityPolicyViolationEvent;
      if (candidate.effectiveDirective === "connect-src") violation.current = candidate;
    };
    doc.addEventListener("securitypolicyviolation", onViolation);

    const cleanup = (): void => {
      doc.removeEventListener("securitypolicyviolation", onViolation);
      if (timer !== null) {
        win.clearTimeout(timer);
        timer = null;
      }
    };

    const finish = (
      outcome: AttemptOutcome,
      blockedBy: BlockReason | null,
      errorName: string | null,
      errorMessage: string | null,
      note: string,
    ): void => {
      if (settled) return;
      settled = true;
      const elapsedMs = nowMs() - startedAt;
      cleanup();
      if (socket !== null && socket.readyState === 1) {
        try {
          socket.close(1000, "probe complete");
        } catch {
          // Closing a socket that is already gone is not a probe failure.
        }
      }
      resolve({ outcome, blockedBy, errorName, errorMessage, elapsedMs, note });
    };

    let created: WebSocket;
    try {
      created = new win.WebSocket(target);
    } catch (error) {
      const name = errorNameOf(error);
      const message = errorMessageOf(error);
      const blockedBy = classifyBlockReason(name, message, violation.current !== null);
      finish(
        blockedBy === "unknown" ? "error" : "blocked",
        blockedBy,
        name,
        message,
        "The WebSocket constructor threw before a connection opened. In Chromium this is the mixed-content rejection path.",
      );
      return;
    }
    socket = created;

    created.addEventListener("open", () => {
      finish(
        "opened",
        null,
        null,
        null,
        "WebSocket opened. The probe sends no application data and closes it immediately.",
      );
    });

    created.addEventListener("error", () => {
      // Defer one task so a CSP violation event dispatched alongside the error
      // can be observed before the cause is classified.
      win.setTimeout(() => {
        if (settled) return;
        const blockedBy = classifyBlockReason(
          "WebSocket error event",
          "",
          violation.current !== null,
        );
        const violationDetail = violation.current;
        finish(
          blockedBy === "unknown" ? "error" : "blocked",
          blockedBy,
          "WebSocket error event",
          violationDetail !== null
            ? `Content Security Policy blocked ${violationDetail.blockedURI || target} (${violationDetail.effectiveDirective}).`
            : "The browser fired an error event with no message. Check the DevTools console for mixed-content, private-network or connection-refused details.",
          violationDetail !== null
            ? "CSP blocked the WebSocket before any network connection."
            : "No open event. The browser hides the reason from script; the exact cause is only visible in the console.",
        );
      }, 0);
    });

    created.addEventListener("close", (event) => {
      if (settled) return;
      const reason = event.reason.length > 0 ? `: ${event.reason}` : "";
      const blockedBy = classifyBlockReason(
        "CloseEvent",
        event.reason,
        violation.current !== null,
      );
      finish(
        "closed",
        blockedBy === "unknown" ? null : blockedBy,
        "CloseEvent",
        `Socket closed before opening (code ${event.code}${reason}).`,
        "A close before open usually means the connection was refused or blocked.",
      );
    });

    timer = win.setTimeout(() => {
      finish(
        "timeout",
        "unknown",
        "TimeoutError",
        `No open, error or close event within ${timeoutMs} ms.`,
        "No conclusion: an unreachable host also times out. Check the LAN IP, port and router AP/client isolation.",
      );
    }, timeoutMs);
  });
}

/**
 * Attempts the `http://.../healthz` fetch. `no-cors` keeps the response
 * opaque, so the probe learns only whether the browser allowed the request.
 * GET with `credentials: "omit"` means no body and no cookies are sent.
 */
async function attemptFetch(
  doc: Document,
  win: E14Window,
  target: string,
  timeoutMs: number,
  nowMs: () => number,
): Promise<AttemptOutcomeData> {
  const startedAt = nowMs();
  const controller = new win.AbortController();
  const violation: { current: SecurityPolicyViolationEvent | null } = { current: null };

  const onViolation = (event: Event): void => {
    const candidate = event as SecurityPolicyViolationEvent;
    if (candidate.effectiveDirective === "connect-src") violation.current = candidate;
  };
  doc.addEventListener("securitypolicyviolation", onViolation);
  const timer = win.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await win.fetch(target, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    return {
      outcome: "allowed",
      blockedBy: null,
      errorName: null,
      errorMessage: null,
      elapsedMs: nowMs() - startedAt,
      note: `fetch resolved without a browser block (opaque no-cors response, status ${response.status}). The request is a GET with no body and no credentials.`,
    };
  } catch (error) {
    const elapsedMs = nowMs() - startedAt;
    if (controller.signal.aborted) {
      return {
        outcome: "timeout",
        blockedBy: "unknown",
        errorName: "TimeoutError",
        errorMessage: `fetch did not settle within ${timeoutMs} ms.`,
        elapsedMs,
        note: "No conclusion: an unreachable host also times out.",
      };
    }

    if (violation.current !== null) {
      const blocked = violation.current;
      return {
        outcome: "blocked",
        blockedBy: "csp",
        errorName: "SecurityPolicyViolation",
        errorMessage: `CSP blocked ${blocked.blockedURI || target} (directive ${blocked.effectiveDirective}).`,
        elapsedMs,
        note: "The dev-server CSP connect-src allows 'self' and ws:, not http:, so this row reports a CSP block, not mixed content.",
      };
    }

    const name = errorNameOf(error);
    const message = errorMessageOf(error);
    const blockedBy = classifyBlockReason(name, message, false);
    return {
      outcome: blockedBy === "mixed-content" || blockedBy === "private-network" ? "blocked" : "error",
      blockedBy,
      errorName: name,
      errorMessage: message,
      elapsedMs,
      note: "fetch rejected. The browser usually hides the reason behind a generic TypeError; check the console.",
    };
  } finally {
    win.clearTimeout(timer);
    doc.removeEventListener("securitypolicyviolation", onViolation);
  }
}

/**
 * Mounts the page. Reads only `location`/`navigator`, renders the context and
 * validation text, and attaches click listeners. It never opens a connection.
 */
export function mountE14Page(
  doc: Document,
  win: E14Window,
  options: MountOptions = {},
): E14PageController {
  const elements: Elements = {
    input: requireElement<HTMLInputElement>(doc, "ws-url"),
    validation: requireElement<HTMLElement>(doc, "validation"),
    status: requireElement<HTMLElement>(doc, "status"),
    table: requireElement<HTMLTableElement>(doc, "results"),
    json: requireElement<HTMLElement>(doc, "json"),
    copy: requireElement<HTMLButtonElement>(doc, "copy"),
    lanWsButton: requireElement<HTMLButtonElement>(doc, "test-lan-ws"),
    lanFetchButton: requireElement<HTMLButtonElement>(doc, "test-lan-fetch"),
    localhostButton: requireElement<HTMLButtonElement>(doc, "test-localhost-ws"),
    contextList: requireElement<HTMLElement>(doc, "context-list"),
    contextNote: requireElement<HTMLElement>(doc, "context-note"),
  };

  const clock = options.now ?? (() => new Date());
  const nowMs = options.performanceNow ?? (() => win.performance.now());
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const attempts: AttemptRecord[] = [];
  let busy = false;

  const page = {
    protocol: win.location.protocol,
    hostname: win.location.hostname,
    port: win.location.port,
    url: `${win.location.origin}${win.location.pathname}`,
    secureContext: win.isSecureContext === true,
    userAgent: win.navigator.userAgent,
  };

  function renderContext(): void {
    elements.contextList.textContent = "";
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["Page URL", page.url],
      ["Protocol", page.protocol],
      ["Secure context", page.secureContext ? "yes" : "no"],
      [
        "Mixed-content test applicable",
        page.protocol === "https:" ? "yes - this page is HTTPS" : "no - open this page through an HTTPS tunnel",
      ],
    ];
    for (const [label, value] of rows) {
      const term = doc.createElement("dt");
      term.textContent = label;
      const description = doc.createElement("dd");
      description.textContent = value;
      elements.contextList.appendChild(term);
      elements.contextList.appendChild(description);
    }
    elements.contextNote.textContent =
      page.protocol === "https:"
        ? "This page is loaded over HTTPS. The LAN attempts below are the real E14 mixed-content test."
        : "This page is not HTTPS, so it cannot demonstrate mixed-content blocking. Follow the tunnel steps above and reopen this page at https://<tunnel-host>/x/e14/. URL validation and the localhost control still work here.";
  }

  function renderValidation(): void {
    if (elements.input.value.trim().length === 0) {
      elements.validation.textContent =
        "Enter a ws:// URL. The dev server prints its LAN address; port 8080 is the default.";
      return;
    }
    const result = validateLanWsUrl(elements.input.value);
    if (!result.ok) {
      elements.validation.textContent = result.problem?.message ?? "Invalid URL.";
      return;
    }
    elements.validation.textContent = `Valid ${result.hostKind ?? "LAN"} host. WebSocket: ${result.wsUrl ?? ""} - health check: ${result.healthUrl ?? ""}`;
  }

  function buildReport(): E14Report {
    return {
      schema: REPORT_SCHEMA_VERSION,
      experiment: "E14",
      title: "Mixed content and private-network reachability",
      ranAt: clock().toISOString(),
      pageUrl: page.url,
      userAgent: page.userAgent,
      isSecureContext: page.secureContext,
      attempts: attempts.map((attempt) => ({ ...attempt })),
    };
  }

  function renderResults(): void {
    elements.table.textContent = "";
    const head = doc.createElement("thead");
    const headerRow = doc.createElement("tr");
    for (const heading of ["Attempt", "Target", "Outcome", "Blocked by", "Error / note", "Time (ms)"]) {
      const cell = doc.createElement("th");
      cell.scope = "col";
      cell.textContent = heading;
      headerRow.appendChild(cell);
    }
    head.appendChild(headerRow);
    elements.table.appendChild(head);

    const body = doc.createElement("tbody");
    for (const attempt of attempts) {
      const row = doc.createElement("tr");
      const cells: ReadonlyArray<readonly [string, string]> = [
        [attempt.label, ""],
        [attempt.target, ""],
        [attempt.outcome, outcomeClass(attempt.outcome)],
        [attempt.blockedBy ?? "", ""],
        [
          attempt.errorName !== null
            ? `${attempt.errorName}: ${attempt.errorMessage ?? ""}`
            : attempt.note,
          "",
        ],
        [attempt.elapsedMs.toFixed(1), ""],
      ];
      for (const [text, className] of cells) {
        const cell = doc.createElement("td");
        cell.textContent = text;
        if (className.length > 0) cell.className = className;
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    elements.table.appendChild(body);
    elements.json.textContent = JSON.stringify(buildReport(), null, 2);
    elements.copy.disabled = attempts.length === 0;
  }

  function addAttempt(
    attempt: AttemptId,
    label: string,
    target: string,
    data: AttemptOutcomeData,
  ): AttemptRecord {
    const record: AttemptRecord = {
      attempt,
      label,
      target,
      ...data,
      pageProtocol: page.protocol,
      secureContext: page.secureContext,
    };
    attempts.push(record);
    renderResults();
    const cause = record.blockedBy !== null ? ` (${record.blockedBy})` : "";
    elements.status.textContent = `${label}: ${record.outcome}${cause} in ${record.elapsedMs.toFixed(1)} ms.`;
    return record;
  }

  function setButtonsDisabled(disabled: boolean): void {
    elements.lanWsButton.disabled = disabled;
    elements.lanFetchButton.disabled = disabled;
    elements.localhostButton.disabled = disabled;
    elements.copy.disabled = disabled || attempts.length === 0;
  }

  async function withBusy(action: () => Promise<AttemptRecord>): Promise<AttemptRecord | null> {
    if (busy) {
      elements.status.textContent = "An attempt is already running. Wait for it to finish.";
      return null;
    }
    busy = true;
    setButtonsDisabled(true);
    try {
      return await action();
    } finally {
      busy = false;
      setButtonsDisabled(false);
    }
  }

  function invalidStatus(prefix: string, result: LanUrlResult): null {
    elements.status.textContent = `${prefix} not attempted: ${result.problem?.message ?? "invalid URL."}`;
    return null;
  }

  async function runLanWebSocket(): Promise<AttemptRecord | null> {
    const parsed = validateLanWsUrl(elements.input.value);
    if (!parsed.ok || parsed.wsUrl === null) return invalidStatus("LAN WebSocket", parsed);
    const target = parsed.wsUrl;

    return await withBusy(async () => {
      elements.status.textContent = `Testing ${target} ...`;
      const data = await attemptWebSocket(doc, win, target, timeoutMs, nowMs);
      return addAttempt("lan-ws", "ws:// LAN WebSocket", target, data);
    });
  }

  async function runLanFetch(): Promise<AttemptRecord | null> {
    const parsed = validateLanWsUrl(elements.input.value);
    if (!parsed.ok || parsed.healthUrl === null) return invalidStatus("LAN fetch", parsed);
    const target = parsed.healthUrl;

    return await withBusy(async () => {
      elements.status.textContent = `Testing ${target} ...`;
      const data = await attemptFetch(doc, win, target, timeoutMs, nowMs);
      return addAttempt("lan-fetch", "http:// LAN health check", target, data);
    });
  }

  async function runLocalhostControl(): Promise<AttemptRecord | null> {
    const parsed = validateLanWsUrl(elements.input.value);
    const target = deriveControlWsUrl(parsed, { hostname: page.hostname, port: page.port });

    return await withBusy(async () => {
      elements.status.textContent = `Testing ${target} ...`;
      const data = await attemptWebSocket(doc, win, target, timeoutMs, nowMs);
      return addAttempt("localhost-ws", "ws:// localhost control", target, data);
    });
  }

  async function copyJson(): Promise<void> {
    if (attempts.length === 0) {
      elements.status.textContent = "Run at least one attempt before copying JSON.";
      return;
    }
    const copied = await copyText(doc, win, JSON.stringify(buildReport(), null, 2));
    elements.status.textContent = copied
      ? "JSON copied to the clipboard."
      : "Copy failed; select the JSON block and copy it manually.";
  }

  elements.input.addEventListener("input", renderValidation);
  elements.lanWsButton.addEventListener("click", () => {
    void runLanWebSocket();
  });
  elements.lanFetchButton.addEventListener("click", () => {
    void runLanFetch();
  });
  elements.localhostButton.addEventListener("click", () => {
    void runLocalhostControl();
  });
  elements.copy.addEventListener("click", () => {
    void copyJson();
  });

  renderContext();
  renderValidation();
  elements.status.textContent = "Not run. No connection is attempted until you press a test button.";
  elements.json.textContent = "Not run.";
  elements.copy.disabled = true;

  return {
    runLanWebSocket,
    runLanFetch,
    runLocalhostControl,
    getReport: buildReport,
  };
}
