/**
 * Controller QA probe (stream E; AR-5).
 *
 * Static page served at `/x/controller-qa/`. It renders the layout recipes in
 * `layouts.json` at a portrait and a landscape phone size and asserts that
 * every interactive control clears 44 x 44 CSS px without the renderer's clamp.
 *
 * The geometry mirrors `packages/controller/src/controls/control.ts`
 * (`measureControl`): `x`/`y` are percentages of surface width/height, while
 * `size`/`r` are percentages of `min(width, height)`. A circle's `r` is its
 * radius; `rounded`/`square` treat `r` as the edge. The test suite compares
 * this helper against the controller implementation so the QA page cannot
 * quietly measure a different layout.
 *
 * No probe runs on load. Only the Run click fetches `layouts.json`; there are
 * no analytics, uploads, cookies or PII (SR-7).
 */

export const MIN_TOUCH_TARGET_PX = 44;

export const PHONE_SIZES = Object.freeze([
  Object.freeze({ orientation: "portrait", width: 390, height: 844 }),
  Object.freeze({ orientation: "landscape", width: 844, height: 390 }),
]);

/** Resolves a layout length (`"50%"` or `12`) against a pixel reference. */
export function resolveLength(length, reference) {
  if (typeof length === "number") return Number.isFinite(length) ? length : 0;
  const text = String(length).trim();
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) return 0;
  return text.endsWith("%") ? (reference * value) / 100 : value;
}

/**
 * Resolves the rendered box of one control, including the AR-5 floor.
 * `undersized` reports that the layout asked for less than 44 px and the
 * renderer would have to enlarge it.
 */
export function measureBox(control, surface) {
  const minEdge = Math.min(surface.width, surface.height);
  let width;
  let height;

  switch (control.type) {
    case "button": {
      const edge = resolveLength(control.r, minEdge);
      width = control.shape === "circle" ? edge * 2 : edge;
      height = width;
      break;
    }
    case "dpad":
    case "stick":
    case "trigger": {
      width = resolveLength(control.size, minEdge);
      height = width;
      break;
    }
    case "gyro": {
      // The prompt pill is fixed in the controller (GYRO_PROMPT_* in control.ts).
      width = 168;
      height = MIN_TOUCH_TARGET_PX;
      break;
    }
    default: {
      width = resolveLength(control.w, surface.width);
      height = resolveLength(control.h, surface.height);
      break;
    }
  }

  const centerX = resolveLength(control.x, surface.width);
  const centerY = resolveLength(control.y, surface.height);
  const clampedWidth = Math.max(MIN_TOUCH_TARGET_PX, width);
  const clampedHeight = Math.max(MIN_TOUCH_TARGET_PX, height);

  return {
    centerX,
    centerY,
    left: centerX - clampedWidth / 2,
    top: centerY - clampedHeight / 2,
    width: clampedWidth,
    height: clampedHeight,
    requestedWidth: width,
    requestedHeight: height,
    undersized: width < MIN_TOUCH_TARGET_PX || height < MIN_TOUCH_TARGET_PX,
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function isInteractive(control) {
  return control.type !== "panel";
}

/**
 * Pure checks for every interactive control at every phone size. Panels are
 * display surfaces, not touch targets, so they are skipped.
 */
export function evaluateLayouts(layouts, sizes = PHONE_SIZES) {
  const rows = [];

  for (const layout of layouts) {
    for (const size of sizes) {
      for (const control of layout.controls) {
        if (!isInteractive(control)) continue;
        const box = measureBox(control, size);
        rows.push({
          layout: layout.id,
          orientation: size.orientation,
          surface: `${size.width}x${size.height}`,
          id: control.id,
          type: control.type,
          width: round(box.width),
          height: round(box.height),
          requestedWidth: round(box.requestedWidth),
          requestedHeight: round(box.requestedHeight),
          undersized: box.undersized,
          domWidth: null,
          domHeight: null,
          ok: !box.undersized && box.width >= MIN_TOUCH_TARGET_PX && box.height >= MIN_TOUCH_TARGET_PX,
        });
      }
    }
  }

  const failures = rows.filter((row) => !row.ok).map(describeFailure);
  return {
    ok: failures.length === 0,
    layouts: layouts.length,
    sizes: sizes.length,
    checks: rows.length,
    failures,
    rows,
  };
}

function describeFailure(row) {
  const dom =
    row.domWidth === null || row.domHeight === null
      ? ""
      : ` (DOM ${row.domWidth}x${row.domHeight})`;
  return `${row.layout} ${row.id} at ${row.orientation}: ${row.width}x${row.height}${dom}`;
}

function rowKey(layoutId, orientation, controlId) {
  return `${layoutId}\u0000${orientation}\u0000${controlId}`;
}

/* ------------------------------------------------------------------ */
/* Browser wiring                                                      */
/* ------------------------------------------------------------------ */

function createElement(doc, tag, className, text) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function appendControl(surface, control, size, doc) {
  const box = measureBox(control, size);
  const element = createElement(doc, "div", `qa-control qa-${control.type}`);
  element.dataset.controlId = control.id;
  element.dataset.controlType = control.type;
  element.style.left = `${box.left}px`;
  element.style.top = `${box.top}px`;
  element.style.width = `${box.width}px`;
  element.style.height = `${box.height}px`;
  element.style.zIndex = String(control.z || 0);

  switch (control.type) {
    case "panel":
      element.textContent = "Host panel";
      break;
    case "button":
      element.dataset.shape = control.shape || "circle";
      element.textContent = control.label || control.id;
      break;
    case "dpad": {
      for (const arrow of ["↑", "↓", "←", "→"]) {
        element.append(createElement(doc, "span", "", arrow));
      }
      break;
    }
    case "stick":
      element.append(createElement(doc, "span"));
      break;
    case "gyro":
      element.textContent = "Enable motion";
      break;
    case "trigger":
      element.textContent = control.label || "Trigger";
      break;
    case "touchpad":
      element.textContent = "Drag";
      break;
    case "slider":
      element.append(createElement(doc, "span"));
      break;
    case "text": {
      const input = createElement(doc, "input");
      input.type = "text";
      input.readOnly = true;
      input.placeholder = "Type here";
      input.tabIndex = -1;
      element.append(input);
      break;
    }
    case "choice": {
      const options = Array.isArray(control.options) ? control.options : [];
      for (const option of options.slice(0, 4)) {
        element.append(createElement(doc, "span", "", option.label || option.value));
      }
      break;
    }
    case "canvas":
      element.textContent = "Draw here";
      break;
    default:
      element.textContent = control.id;
      break;
  }

  surface.append(element);
  return element;
}

function renderSurface(layout, size, doc) {
  const surface = createElement(doc, "div", "qa-surface");
  surface.dataset.layoutId = layout.id;
  surface.style.width = `${size.width}px`;
  surface.style.height = `${size.height}px`;
  surface.style.background = layout.background || "#000000";
  for (const control of layout.controls) {
    appendControl(surface, control, size, doc);
  }
  return surface;
}

/** Adds DOM measurements to the pure rows and re-evaluates them. */
function measureDom(layouts, result, doc) {
  const host = doc.getElementById("measure-host");
  const rowsByKey = new Map(
    result.rows.map((row) => [rowKey(row.layout, row.orientation, row.id), row]),
  );

  for (const layout of layouts) {
    for (const size of PHONE_SIZES) {
      const surface = renderSurface(layout, size, doc);
      host.append(surface);
      for (const control of layout.controls) {
        if (!isInteractive(control)) continue;
        const row = rowsByKey.get(rowKey(layout.id, size.orientation, control.id));
        const element = surface.querySelector(`[data-control-id="${control.id}"]`);
        if (!row || !element) continue;
        const rect = element.getBoundingClientRect();
        const box = measureBox(control, size);
        row.domWidth = round(rect.width);
        row.domHeight = round(rect.height);
        const domMatches =
          Math.abs(rect.width - box.width) <= 0.5 && Math.abs(rect.height - box.height) <= 0.5;
        const domClears = rect.width >= MIN_TOUCH_TARGET_PX && rect.height >= MIN_TOUCH_TARGET_PX;
        row.ok = row.ok && domMatches && domClears;
      }
      surface.remove();
    }
  }

  result.failures = result.rows.filter((row) => !row.ok).map(describeFailure);
  result.ok = result.failures.length === 0;
  return result;
}

async function loadLayouts() {
  const response = await fetch(new URL("./layouts.json", import.meta.url), { cache: "no-store" });
  if (!response.ok) throw new Error(`layouts.json returned ${response.status}`);
  const layouts = await response.json();
  if (!Array.isArray(layouts) || layouts.length === 0) {
    throw new Error("layouts.json must be a non-empty array");
  }
  return layouts;
}

function populateSelect(select, layouts) {
  const previous = select.value;
  select.textContent = "";
  for (const layout of layouts) {
    const option = document.createElement("option");
    option.value = layout.id;
    option.textContent = layout.id;
    select.append(option);
  }
  const keep = layouts.some((layout) => layout.id === previous);
  select.value = keep ? previous : layouts[0].id;
}

function renderFrames(frames, layouts, selectedId) {
  frames.textContent = "";
  const layout = layouts.find((item) => item.id === selectedId) || layouts[0];
  for (const size of PHONE_SIZES) {
    const figure = document.createElement("figure");
    figure.className = "qa-phone";
    const caption = document.createElement("figcaption");
    caption.textContent = `${size.orientation} - ${size.width} x ${size.height}`;
    figure.append(caption, renderSurface(layout, size, document));
    frames.append(figure);
  }
}

function renderTable(tbody, rows) {
  tbody.textContent = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.dataset.ok = row.ok ? "true" : "false";
    const cells = [
      row.layout,
      `${row.orientation} ${row.surface}`,
      row.id,
      row.type,
      `${row.width} x ${row.height}`,
      row.domWidth === null ? "not measured" : `${row.domWidth} x ${row.domHeight}`,
      row.ok ? "PASS" : "FAIL",
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    tbody.append(tr);
  }
}

function setStatus(status, result, layouts) {
  if (result.ok) {
    status.dataset.tone = "pass";
    status.textContent =
      `PASS - ${result.checks} targets >= ${MIN_TOUCH_TARGET_PX} px across ` +
      `${layouts.length} layouts x ${PHONE_SIZES.length} phone sizes.`;
  } else {
    status.dataset.tone = "fail";
    status.textContent =
      `FAIL - ${result.failures.length} target(s) below ${MIN_TOUCH_TARGET_PX} px ` +
      "or relying on the renderer clamp; see the table.";
  }
}

function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.append(area);
  area.select();
  try {
    document.execCommand("copy");
  } finally {
    area.remove();
  }
}

function mount() {
  const runButton = document.getElementById("run");
  const copyButton = document.getElementById("copy");
  const status = document.getElementById("status");
  const frames = document.getElementById("frames");
  const tbody = document.querySelector("#results tbody");
  const json = document.getElementById("json");
  const select = document.getElementById("layout-select");
  if (!runButton || !copyButton || !status || !frames || !tbody || !json || !select) {
    return;
  }

  const state = { layouts: null, result: null };

  function copyJson() {
    if (state.result === null) return;
    const text = JSON.stringify(state.result, null, 2);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  async function run() {
    runButton.disabled = true;
    copyButton.disabled = true;
    status.dataset.tone = "";
    status.textContent = "Running...";
    try {
      const layouts = await loadLayouts();
      const result = measureDom(layouts, evaluateLayouts(layouts), document);
      state.layouts = layouts;
      state.result = {
        ok: result.ok,
        generatedAt: new Date().toISOString(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        phoneSizes: PHONE_SIZES.map((size) => `${size.orientation} ${size.width}x${size.height}`),
        layouts: layouts.map((layout) => layout.id),
        checks: result.checks,
        failures: result.failures,
        rows: result.rows,
      };

      populateSelect(select, layouts);
      renderFrames(frames, layouts, select.value);
      renderTable(tbody, result.rows);
      json.textContent = JSON.stringify(state.result, null, 2);
      setStatus(status, result, layouts);
      copyButton.disabled = false;
    } catch (error) {
      status.dataset.tone = "fail";
      status.textContent = `FAIL - ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      runButton.disabled = false;
    }
  }

  runButton.addEventListener("click", () => {
    void run();
  });
  copyButton.addEventListener("click", copyJson);
  select.addEventListener("change", () => {
    if (state.layouts !== null) renderFrames(frames, state.layouts, select.value);
  });
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  mount();
}
