/* Generated from page.ts by experiments/e14/build.mjs. Do not edit directly. */
import { classifyBlockReason, deriveControlWsUrl, validateLanWsUrl } from "./validate.js";
const REPORT_SCHEMA_VERSION = 1;
const CONNECT_TIMEOUT_MS = 4e3;
function errorNameOf(error) {
  if (error instanceof Error && error.name.length > 0) return error.name;
  return "Error";
}
function errorMessageOf(error) {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  return String(error);
}
function requireElement(doc, id) {
  const element = doc.getElementById(id);
  if (element === null) {
    throw new Error(`E14 markup is missing #${id}`);
  }
  return element;
}
function outcomeClass(outcome) {
  return outcome === "opened" || outcome === "allowed" ? "status-pass" : "status-fail";
}
async function copyText(doc, win, text) {
  try {
    const clipboard = win.navigator.clipboard;
    if (clipboard !== void 0 && typeof clipboard.writeText === "function") {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
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
async function attemptWebSocket(doc, win, target, timeoutMs, nowMs) {
  return await new Promise((resolve) => {
    const startedAt = nowMs();
    let settled = false;
    let socket = null;
    let timer = null;
    const violation = { current: null };
    const onViolation = (event) => {
      const candidate = event;
      if (candidate.effectiveDirective === "connect-src") violation.current = candidate;
    };
    doc.addEventListener("securitypolicyviolation", onViolation);
    const cleanup = () => {
      doc.removeEventListener("securitypolicyviolation", onViolation);
      if (timer !== null) {
        win.clearTimeout(timer);
        timer = null;
      }
    };
    const finish = (outcome, blockedBy, errorName, errorMessage, note) => {
      if (settled) return;
      settled = true;
      const elapsedMs = nowMs() - startedAt;
      cleanup();
      if (socket !== null && socket.readyState === 1) {
        try {
          socket.close(1e3, "probe complete");
        } catch {
        }
      }
      resolve({ outcome, blockedBy, errorName, errorMessage, elapsedMs, note });
    };
    let created;
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
        "The WebSocket constructor threw before a connection opened. In Chromium this is the mixed-content rejection path."
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
        "WebSocket opened. The probe sends no application data and closes it immediately."
      );
    });
    created.addEventListener("error", () => {
      win.setTimeout(() => {
        if (settled) return;
        const blockedBy = classifyBlockReason(
          "WebSocket error event",
          "",
          violation.current !== null
        );
        const violationDetail = violation.current;
        finish(
          blockedBy === "unknown" ? "error" : "blocked",
          blockedBy,
          "WebSocket error event",
          violationDetail !== null ? `Content Security Policy blocked ${violationDetail.blockedURI || target} (${violationDetail.effectiveDirective}).` : "The browser fired an error event with no message. Check the DevTools console for mixed-content, private-network or connection-refused details.",
          violationDetail !== null ? "CSP blocked the WebSocket before any network connection." : "No open event. The browser hides the reason from script; the exact cause is only visible in the console."
        );
      }, 0);
    });
    created.addEventListener("close", (event) => {
      if (settled) return;
      const reason = event.reason.length > 0 ? `: ${event.reason}` : "";
      const blockedBy = classifyBlockReason(
        "CloseEvent",
        event.reason,
        violation.current !== null
      );
      finish(
        "closed",
        blockedBy === "unknown" ? null : blockedBy,
        "CloseEvent",
        `Socket closed before opening (code ${event.code}${reason}).`,
        "A close before open usually means the connection was refused or blocked."
      );
    });
    timer = win.setTimeout(() => {
      finish(
        "timeout",
        "unknown",
        "TimeoutError",
        `No open, error or close event within ${timeoutMs} ms.`,
        "No conclusion: an unreachable host also times out. Check the LAN IP, port and router AP/client isolation."
      );
    }, timeoutMs);
  });
}
async function attemptFetch(doc, win, target, timeoutMs, nowMs) {
  const startedAt = nowMs();
  const controller = new win.AbortController();
  const violation = { current: null };
  const onViolation = (event) => {
    const candidate = event;
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
      signal: controller.signal
    });
    return {
      outcome: "allowed",
      blockedBy: null,
      errorName: null,
      errorMessage: null,
      elapsedMs: nowMs() - startedAt,
      note: `fetch resolved without a browser block (opaque no-cors response, status ${response.status}). The request is a GET with no body and no credentials.`
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
        note: "No conclusion: an unreachable host also times out."
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
        note: "The dev-server CSP connect-src allows 'self' and ws:, not http:, so this row reports a CSP block, not mixed content."
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
      note: "fetch rejected. The browser usually hides the reason behind a generic TypeError; check the console."
    };
  } finally {
    win.clearTimeout(timer);
    doc.removeEventListener("securitypolicyviolation", onViolation);
  }
}
function mountE14Page(doc, win, options = {}) {
  var _a, _b, _c;
  const elements = {
    input: requireElement(doc, "ws-url"),
    validation: requireElement(doc, "validation"),
    status: requireElement(doc, "status"),
    table: requireElement(doc, "results"),
    json: requireElement(doc, "json"),
    copy: requireElement(doc, "copy"),
    lanWsButton: requireElement(doc, "test-lan-ws"),
    lanFetchButton: requireElement(doc, "test-lan-fetch"),
    localhostButton: requireElement(doc, "test-localhost-ws"),
    contextList: requireElement(doc, "context-list"),
    contextNote: requireElement(doc, "context-note")
  };
  const clock = (_a = options.now) != null ? _a : (() => /* @__PURE__ */ new Date());
  const nowMs = (_b = options.performanceNow) != null ? _b : (() => win.performance.now());
  const timeoutMs = (_c = options.timeoutMs) != null ? _c : CONNECT_TIMEOUT_MS;
  const attempts = [];
  let busy = false;
  const page = {
    protocol: win.location.protocol,
    hostname: win.location.hostname,
    port: win.location.port,
    url: `${win.location.origin}${win.location.pathname}`,
    secureContext: win.isSecureContext === true,
    userAgent: win.navigator.userAgent
  };
  function renderContext() {
    elements.contextList.textContent = "";
    const rows = [
      ["Page URL", page.url],
      ["Protocol", page.protocol],
      ["Secure context", page.secureContext ? "yes" : "no"],
      [
        "Mixed-content test applicable",
        page.protocol === "https:" ? "yes - this page is HTTPS" : "no - open this page through an HTTPS tunnel"
      ]
    ];
    for (const [label, value] of rows) {
      const term = doc.createElement("dt");
      term.textContent = label;
      const description = doc.createElement("dd");
      description.textContent = value;
      elements.contextList.appendChild(term);
      elements.contextList.appendChild(description);
    }
    elements.contextNote.textContent = page.protocol === "https:" ? "This page is loaded over HTTPS. The LAN attempts below are the real E14 mixed-content test." : "This page is not HTTPS, so it cannot demonstrate mixed-content blocking. Follow the tunnel steps above and reopen this page at https://<tunnel-host>/x/e14/. URL validation and the localhost control still work here.";
  }
  function renderValidation() {
    var _a2, _b2, _c2, _d, _e;
    if (elements.input.value.trim().length === 0) {
      elements.validation.textContent = "Enter a ws:// URL. The dev server prints its LAN address; port 8080 is the default.";
      return;
    }
    const result = validateLanWsUrl(elements.input.value);
    if (!result.ok) {
      elements.validation.textContent = (_b2 = (_a2 = result.problem) == null ? void 0 : _a2.message) != null ? _b2 : "Invalid URL.";
      return;
    }
    elements.validation.textContent = `Valid ${(_c2 = result.hostKind) != null ? _c2 : "LAN"} host. WebSocket: ${(_d = result.wsUrl) != null ? _d : ""} - health check: ${(_e = result.healthUrl) != null ? _e : ""}`;
  }
  function buildReport() {
    return {
      schema: REPORT_SCHEMA_VERSION,
      experiment: "E14",
      title: "Mixed content and private-network reachability",
      ranAt: clock().toISOString(),
      pageUrl: page.url,
      userAgent: page.userAgent,
      isSecureContext: page.secureContext,
      attempts: attempts.map((attempt) => ({ ...attempt }))
    };
  }
  function renderResults() {
    var _a2, _b2;
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
      const cells = [
        [attempt.label, ""],
        [attempt.target, ""],
        [attempt.outcome, outcomeClass(attempt.outcome)],
        [(_a2 = attempt.blockedBy) != null ? _a2 : "", ""],
        [
          attempt.errorName !== null ? `${attempt.errorName}: ${(_b2 = attempt.errorMessage) != null ? _b2 : ""}` : attempt.note,
          ""
        ],
        [attempt.elapsedMs.toFixed(1), ""]
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
  function addAttempt(attempt, label, target, data) {
    const record = {
      attempt,
      label,
      target,
      ...data,
      pageProtocol: page.protocol,
      secureContext: page.secureContext
    };
    attempts.push(record);
    renderResults();
    const cause = record.blockedBy !== null ? ` (${record.blockedBy})` : "";
    elements.status.textContent = `${label}: ${record.outcome}${cause} in ${record.elapsedMs.toFixed(1)} ms.`;
    return record;
  }
  function setButtonsDisabled(disabled) {
    elements.lanWsButton.disabled = disabled;
    elements.lanFetchButton.disabled = disabled;
    elements.localhostButton.disabled = disabled;
    elements.copy.disabled = disabled || attempts.length === 0;
  }
  async function withBusy(action) {
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
  function invalidStatus(prefix, result) {
    var _a2, _b2;
    elements.status.textContent = `${prefix} not attempted: ${(_b2 = (_a2 = result.problem) == null ? void 0 : _a2.message) != null ? _b2 : "invalid URL."}`;
    return null;
  }
  async function runLanWebSocket() {
    const parsed = validateLanWsUrl(elements.input.value);
    if (!parsed.ok || parsed.wsUrl === null) return invalidStatus("LAN WebSocket", parsed);
    const target = parsed.wsUrl;
    return await withBusy(async () => {
      elements.status.textContent = `Testing ${target} ...`;
      const data = await attemptWebSocket(doc, win, target, timeoutMs, nowMs);
      return addAttempt("lan-ws", "ws:// LAN WebSocket", target, data);
    });
  }
  async function runLanFetch() {
    const parsed = validateLanWsUrl(elements.input.value);
    if (!parsed.ok || parsed.healthUrl === null) return invalidStatus("LAN fetch", parsed);
    const target = parsed.healthUrl;
    return await withBusy(async () => {
      elements.status.textContent = `Testing ${target} ...`;
      const data = await attemptFetch(doc, win, target, timeoutMs, nowMs);
      return addAttempt("lan-fetch", "http:// LAN health check", target, data);
    });
  }
  async function runLocalhostControl() {
    const parsed = validateLanWsUrl(elements.input.value);
    const target = deriveControlWsUrl(parsed, { hostname: page.hostname, port: page.port });
    return await withBusy(async () => {
      elements.status.textContent = `Testing ${target} ...`;
      const data = await attemptWebSocket(doc, win, target, timeoutMs, nowMs);
      return addAttempt("localhost-ws", "ws:// localhost control", target, data);
    });
  }
  async function copyJson() {
    if (attempts.length === 0) {
      elements.status.textContent = "Run at least one attempt before copying JSON.";
      return;
    }
    const copied = await copyText(doc, win, JSON.stringify(buildReport(), null, 2));
    elements.status.textContent = copied ? "JSON copied to the clipboard." : "Copy failed; select the JSON block and copy it manually.";
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
    getReport: buildReport
  };
}
export {
  CONNECT_TIMEOUT_MS,
  REPORT_SCHEMA_VERSION,
  mountE14Page
};
