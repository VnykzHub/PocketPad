# 13 — UI and Text

**Status:** authoritative for the engine's UI, text, focus and home-screen subsystem.
**Milestone:** M1 (package, home shell, HUD primitives); game-facing `ctx.ui` exposure follows the additive SDK wave in M2.
**Requirement ID prefix:** `ER-13-*`. Each row in §7 must be registered in `docs/todos/TRACEABILITY.md` before implementation starts.
**Authority:** [`SPEC.md`](../../SPEC.md) for the product contract, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`docs/engine/README.md`](README.md) for the programme rules, [`00-architecture.md`](00-architecture.md) for package boundaries. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded in `docs/todos/README.md`.
**Design source:** root [`DESIGN.md`](../../DESIGN.md) and [`docs/PAGE-PLANS.md`](../PAGE-PLANS.md) for the true-black-flat visual system, focus rules and host page composition. This spec does not restyle the product; it moves the same design into the engine.

---

## 1. Goal

The host currently renders platform UI as DOM (`Launcher`, `StartScreen`, `ResultsOverlay`, `Notice`, `SlotRoster`) and games draw flat text through `Renderer2D.text` (Canvas2D). That caps the visual quality of the product, makes 10-foot layout depend on CSS, and gives the engine no way to draw a HUD, a menu or a world-space label that is part of the game frame.

This spec defines one retained-mode UI layer that:

- renders through the engine's `RenderDevice` (WebGPU, WebGL2, and a Canvas2D fallback) instead of the DOM;
- lays out in a fixed design space and scales predictably from 1280×720 to 4K;
- renders crisp text at any DPR using prebuilt MSDF atlases, bitmap atlases and a packaged-font fallback;
- gives the host a console home with real depth: a layered, engine-rendered scene rather than a flat DOM grid;
- works with a TV remote, keyboard/mouse, gamepad and phone, with one focus model and one navigation grammar;
- exposes a small, stable API a game can build a HUD, pause menu, settings screen or results table from without reading engine source;
- mirrors itself into an accessibility tree so a canvas-rendered UI remains operable by assistive technology.

**Player-visible outcome.** A player on a couch can boot the host, see a home that looks and moves like a console rather than a web page, navigate it with a TV remote, launch a game, read its HUD from 3 metres, open and operate its pause menu, and read every label at 200% text scale, without a mouse and without a single DOM layout shift. A phone can drive the same focus model when the remote is out of reach.

**Engineering outcome.** Layout, focus, text shaping and string tables are pure and testable in Node. Only rasterization and painting touch the GPU or a canvas. The home screen is the first consumer and therefore the acceptance fixture: if the home works, the substrate is proven before any game depends on it.

**Definition of done.** A fresh game developer can build a HUD and a menu from this document plus the SDK reference, without reading `packages/engine/ui/src/**`; and the home screen passes ER-13-02 through ER-13-06 with recorded evidence.

---

## 2. Non-goals

- **No HTML/CSS in the game render path.** The DOM is used only for the accessibility mirror, IME text entry, and the boot/notice fallback when the engine cannot start. A game may not return markup, a CSS string or a DOM node as UI content.
- **No runtime MSDF generation.** MSDF atlases are produced by tooling and shipped as assets. The runtime may rasterize a plain alpha bitmap atlas for fallback glyphs and complex scripts, never an MSDF.
- **No full browser text shaping in the SDF path.** The MSDF path handles simple left-to-right scripts with kerning. Arabic, Hebrew, Devanagari, Thai and other scripts that need contextual shaping or bidi reordering route through the packaged-font/Canvas2D fallback described in §5.7. Shipping a wrong-shaped glyph is a defect, not an acceptable fallback.
- **No CSS parity.** There is no `float`, no arbitrary selector engine, no CSS transitions, no `backdrop-filter`, no blur, no glass, no gradients, no shadows on resting surfaces. The layout subset is deliberate (§5.4).
- **No animation on remote focus.** `DESIGN.md` is explicit: focus moves instantly, with no transition, scale or fade. The engine enforces this for remote and keyboard sources; pointer hover may show a hover state on desktop.
- **No UI editor, visual designer or live-reload authoring surface.** `.ui.json` documents are hand-authored and validated; spec 17 owns any editor.
- **No diegetic interactive 3D UI.** World-space labels and images are in scope; a fully interactive 3D terminal with raycast pointers is not.
- **No UGC markup.** User text is rendered with `textContent` semantics into a glyph run; tags, URLs and control characters are stripped by the SDK sanitizer before they reach this layer.
- **No per-frame DOM synchronization.** The accessibility mirror updates on tree, text or focus change only.
- **No third-party UI or font runtime.** No Preact, no Yoga, no HarfBuzz, no fontkit in a browser bundle. The controller remains a DOM app and does not import this package.

---

## 3. Public interfaces

All types are structural and backend-neutral. No `GPUDevice`, `WebGL2RenderingContext`, `HTMLElement` or DOM event appears in a game-facing signature. The SDK restates these types structurally; `packages/runtime` contains a compile-time assignability test proving the engine's concrete types satisfy them (00 §3.6).

### 3.1 Game-facing surface

```ts
export interface GameUi {
  readonly root: UiNode;                 // screen-space root, design units
  readonly focus: UiFocus;
  readonly theme: UiTheme;
  readonly stats: UiStats;
  readonly a11y: UiA11y;

  create(kind: UiNodeKind, init?: UiNodeInit): UiNode;
  destroy(node: UiNode): void;           // detaches and releases; children follow
  mount(node: UiNode, parent?: UiNode): void;

  loadFont(id: string): Promise<FontHandle>;
  loadScreen(id: string): Promise<UiNode>;
  show(node: UiNode): void;
  hide(node: UiNode): void;

  setTextScale(scale: number): void;     // 1.0 .. 2.0, default 1.0
  dispose(): void;                       // idempotent
}

export type UiNodeKind =
  | "group" | "rect" | "image" | "text" | "button" | "toggle"
  | "slider" | "list" | "scroll" | "world-label" | "custom";

export interface UiNode {
  readonly id: string;
  readonly kind: UiNodeKind;
  readonly children: readonly UiNode[];
  visible: boolean;
  interactive: boolean;
  disabled: boolean;
  layout: UiLayout;
  style: UiStyle;
  text: string;                          // literal; use textKey for localized text
  textKey: string;                       // resolved by the active string table
  onActivate?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onValue?: (value: number) => void;
  onScroll?: (offset: number) => void;
}

export interface UiNodeInit {
  readonly id?: string;                  // default: kind + monotonic counter
  readonly text?: string;
  readonly textKey?: string;
  readonly layout?: Partial<UiLayout>;
  readonly style?: Partial<UiStyle>;
  readonly a11y?: Partial<UiA11yProps>;
  readonly interactive?: boolean;
  readonly visible?: boolean;
}
```

### 3.2 Layout and style

```ts
export type UiLength =
  | { readonly unit: "px"; readonly value: number }
  | { readonly unit: "percent"; readonly value: number }   // of parent content box
  | { readonly unit: "content" };                           // intrinsic

export interface UiInsets {
  readonly top: number; readonly right: number;
  readonly bottom: number; readonly left: number;
}

export type UiAnchor =
  | "top-left" | "top" | "top-right"
  | "left" | "center" | "right"
  | "bottom-left" | "bottom" | "bottom-right"
  | "stretch";

export interface UiLayout {
  anchor: UiAnchor;
  x: number;                             // design px offset from the anchor
  y: number;
  width: UiLength;
  height: UiLength;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  padding: UiInsets;
  direction?: "row" | "column";
  wrap?: boolean;                        // flow to the next line when width is exceeded
  gap?: number;
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "space-between";
  safeArea?: boolean;                    // only honoured on the root
  z: number;                             // sibling order; ties use insertion order
}

export interface UiStyle {
  background?: number;                   // 0xRRGGBBAA, premultiplied at paint time
  border?: { readonly color: number; readonly width: number; readonly radius: number };
  opacity: number;                       // 0..1
  font?: FontHandle;
  fontSizePx?: number;                   // design px before text scale
  lineHeight?: number;                   // multiplier, default 1.2
  tracking?: number;                     // design px per gap, default 0
  color?: number;
  textAlign?: "left" | "center" | "right";
  clip?: boolean;                        // scissor to this node's content box
  image?: string;                        // engine asset id, never a URL
  nineSlice?: readonly [number, number, number, number]; // top,right,bottom,left px
  worldSpace?: UiWorldAnchor;
}

export interface UiWorldAnchor {
  readonly entity: Entity;
  readonly offset: Vec3;
  readonly billboard: boolean;           // face the camera; true for labels
  readonly maxDistance: number;          // design metres; 0 = no limit
  readonly occlude: boolean;             // depth-test against the world
  readonly fadeStart: number;            // metres
}
```

### 3.3 Focus and navigation

```ts
export type NavigationSource =
  | { readonly device: "remote" }
  | { readonly device: "keyboard" }
  | { readonly device: "gamepad"; readonly pad: number }
  | { readonly device: "phone"; readonly slot: number }
  | { readonly device: "pointer" };

export type FocusDirection = "up" | "down" | "left" | "right";

export interface UiFocus {
  readonly current: UiNode | null;
  readonly scope: UiNode;
  setScope(scope: UiNode): void;         // pushes a modal scope; restores on pop
  popScope(): void;
  focus(node: UiNode): void;
  move(direction: FocusDirection, source?: NavigationSource): boolean;
  activate(source?: NavigationSource): boolean;
  back(source?: NavigationSource): boolean;
  save(): UiFocusSnapshot;               // store before opening a modal
  restore(snapshot: UiFocusSnapshot): void;
  readonly wrap: boolean;                // per scope; home = true, dialogs = false
}

export interface UiFocusSnapshot {
  readonly scope: UiNode;
  readonly node: UiNode | null;
}

export interface UiFocusEvent {
  readonly node: UiNode;
  readonly previous: UiNode | null;
  readonly source: NavigationSource;
}
```

### 3.4 Text and theme

```ts
export interface FontHandle {
  readonly id: string;                   // manifest asset id
  readonly family: string;
  readonly kind: "msdf" | "bitmap" | "woff2";
  readonly atlasPages: number;
  readonly glyphCount: number;
  readonly supportsShaping: boolean;     // false on the MSDF path
  measure(text: string, sizePx: number, maxWidth: number, out?: TextMetrics2): TextMetrics2;
}

export interface TextMetrics2 {
  width: number;
  height: number;
  ascent: number;
  descent: number;
  lineCount: number;
}

export type UiColorToken =
  | "ground" | "surface" | "text" | "muted" | "faint" | "rule" | "control"
  | "accent" | "warning" | "negative"
  | "player-1" | "player-2" | "player-3" | "player-4"
  | "player-5" | "player-6" | "player-7" | "player-8";

export type UiTypeToken =
  | "host-title" | "host-heading" | "host-body" | "host-meta" | "host-faint"
  | "hud-number" | "hud-label" | "menu-item" | "menu-title" | "caption";

export interface UiTheme {
  readonly id: string;
  readonly colors: Readonly<Record<UiColorToken, number>>;
  readonly type: Readonly<Record<UiTypeToken, TextStyleSpec>>;
  readonly radii: Readonly<Record<"control" | "card" | "panel", number>>;
  readonly spacing: Readonly<Record<"xs" | "sm" | "md" | "lg" | "xl", number>>;
  readonly focusRing: { readonly color: number; readonly width: number; readonly offset: number };
  readonly motionScale: number;          // 0 when prefers-reduced-motion is set
}

export interface TextStyleSpec {
  readonly font: string;                 // font asset id
  readonly sizePx: number;
  readonly weight: number;               // 400 | 500 | 600; selects the font variant
  readonly lineHeight: number;
  readonly tracking: number;
}
```

### 3.5 Accessibility

```ts
export interface UiA11yProps {
  readonly role: string;                 // "button" | "heading" | "listitem" | ...
  readonly label: string;
  readonly description?: string;
  readonly hidden?: boolean;             // decorative; omitted from the mirror
  readonly valueNow?: number;            // slider/toggle
  readonly valueMin?: number;
  readonly valueMax?: number;
}

export interface UiA11y {
  readonly enabled: boolean;
  set(node: UiNode, props: Partial<UiA11yProps>): void;
  announce(message: string, priority?: "polite" | "assertive"): void;
  setFocusAnnouncements(enabled: boolean): void;  // default true for dialogs
}
```

### 3.6 Home screen

```ts
export interface HomeModel {
  readonly room: { readonly code: string; readonly pin: string; readonly players: number; readonly capacity: number };
  readonly games: readonly HomeGameCard[];
  readonly focusedSlug: string | null;
  readonly title: string;                // default "PocketPad"
}

export interface HomeGameCard {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly connected: number;
  readonly poster?: string;              // engine asset id; optional
  readonly accent?: number;              // 0xRRGGBBAA; defaults to the player-1 hue
}

export interface HomeScreen {
  readonly root: UiNode;
  readonly focus: UiFocus;
  readonly depth: HomeDepthState;
  setModel(model: HomeModel): void;
  focusSlug(slug: string): void;
  dispose(): void;
}

/** Debug/acceptance surface for the home depth requirement (§7, ER-13-02). */
export interface HomeDepthState {
  readonly layers: number;               // >= 4 for the engine home
  readonly ambientDrift: boolean;        // false under reduced motion
  readonly parallax: {
    readonly background: number;         // per-layer multiplier, diagnostic only
    readonly midground: number;
    readonly shelf: number;
    readonly overlay: number;
  };
}

export interface UiStats {
  readonly nodes: number;
  readonly layoutMs: number;             // last layout pass
  readonly textRasterMs: number;         // last frame's rasterization
  readonly drawCalls: number;            // last frame
  readonly glyphs: number;               // last frame
  readonly atlasBytes: number;
  readonly textCacheBytes: number;
}
```

### 3.7 `GameContext` addition

`GameContext` is frozen (00 §3.1). This spec adds one optional member, restated structurally in `sdk/src/game-api.ts`:

```ts
export interface GameContext {
  // ... existing frozen members unchanged
  readonly ui?: GameUi;                  // additive; undefined before the UI wave
}
```

A game that uses `ctx.ui` must handle `undefined` and fall back to `ctx.renderer.text` or no UI. The runtime installs the member only when `engine-ui` is present and initialized. Calling a missing capability must fail loudly with `CapabilityUnavailableError`, never silently.

**Freeze rule.** `GameUi`, `UiNode`, `UiLayout`, `UiStyle`, `UiFocus` and `FontHandle` freeze after the first M1 release. New members are additive and optional. Removing, renaming or changing the meaning of an existing member requires an SDK major and an amendment (00 §3.1).

---

## 4. Data formats

### 4.1 Design space and scaling

UI is authored in a **1920×1080 design space**. The renderer maps it to the actual surface:

```
uiScale = clamp(min(cssWidth / 1920, cssHeight / 1080), 0.5, 3.0)
offsetX = (cssWidth  - 1920 * uiScale) / 2
offsetY = (cssHeight - 1080 * uiScale) / 2
```

- All `UiLayout` numbers are design units. The engine applies `uiScale` once, at the root; a game never reads CSS pixels.
- The host uses the same 16:9 letterbox contract as the game canvas (ENGINE.md §2.6). The UI never stretches: a 4:3 surface gets bars, not distorted text.
- Safe area at the root: 48 design px on all sides by default; the `tv` device profile uses 64 design px to survive overscan. The root's `safeArea: true` applies once; child nodes ignore it.
- DPR affects rasterization, not layout: `atlasScale = clamp(ceil(dpr * uiScale * 2) / 2, 1, 3)`.
- Text scale is a user setting (`1.0`, `1.25`, `1.5`, `2.0`). It multiplies `fontSizePx` and line height, marks layout dirty, and never clips: containers with `height: content` grow; containers with fixed height must declare `clip` and are rejected by the accessibility audit if text overflows.

### 4.2 `ui-screen.json` v1

A declarative screen document. It is data, never code: no expressions, no event handlers, no URLs, no `eval`.

```json
{
  "formatVersion": 1,
  "id": "hud.race",
  "design": { "width": 1920, "height": 1080, "safeArea": 48 },
  "theme": "themes/true-black.json",
  "strings": "strings/en.json",
  "root": {
    "id": "root",
    "kind": "group",
    "layout": { "anchor": "stretch", "padding": 48 },
    "children": [
      {
        "id": "speed",
        "kind": "text",
        "textKey": "hud.speed",
        "style": { "font": "fonts/display", "fontSizePx": 72, "color": "#FFFFFFFF" },
        "layout": {
          "anchor": "bottom-right", "x": -48, "y": -48,
          "width": { "unit": "content" }, "height": { "unit": "content" }
        }
      },
      {
        "id": "lap",
        "kind": "text",
        "textKey": "hud.lap",
        "style": { "font": "fonts/display", "fontSizePx": 28 },
        "layout": { "anchor": "top-left", "x": 48, "y": 48,
          "width": { "unit": "content" }, "height": { "unit": "content" } }
      }
    ]
  }
}
```

Rules:

- UTF-8 JSON, **≤ 1 MiB**, **≤ 4096 nodes**, tree depth **≤ 16**.
- `id` matches `^[a-z0-9][a-z0-9_.-]{0,63}$`, unique within the document. The runtime may prefix it with the screen id.
- `kind` is one of the §3.1 kinds. Unknown kinds are refused (`E_UI_FORMAT`), not ignored, because a missing control changes behaviour.
- `textKey` resolves through the active string table. `text` is allowed only for debug fixtures and numbers; a shipping screen uses keys. A missing key renders the key in `--warning` and increments a counter in dev; in production it renders an empty string.
- `image` is an engine asset id, resolved by `engine-assets`; a URL, a `data:` URI or a path with `..` is refused before load.
- Unknown fields are ignored for forward compatibility. Unknown `formatVersion` is refused with `E_UI_FORMAT`.
- A document may not contain scripts, styles, event handler names, `href`, `src`, or HTML.

### 4.3 Theme `ui-theme.json` v1

```json
{
  "formatVersion": 1,
  "id": "true-black",
  "colors": {
    "ground": "#000000FF", "surface": "#111111FF", "text": "#F5F5F5FF",
    "muted": "#A3A3A3FF", "faint": "#737373FF", "rule": "#242424FF",
    "control": "#3A3A3AFF", "accent": "#C6F24EFF",
    "warning": "#F2C94CFF", "negative": "#EB5757FF",
    "player-1": "#4CB3F0FF", "player-2": "#F2994AFF",
    "player-3": "#27AE60FF", "player-4": "#BB6BD9FF",
    "player-5": "#F2C94CFF", "player-6": "#56CCF2FF",
    "player-7": "#F178B6FF", "player-8": "#9B51E0FF"
  },
  "type": {
    "host-title": { "font": "fonts/display", "sizePx": 64, "weight": 600, "lineHeight": 1.1, "tracking": -0.02 },
    "host-heading": { "font": "fonts/display", "sizePx": 40, "weight": 600, "lineHeight": 1.15, "tracking": -0.01 },
    "host-body": { "font": "fonts/text", "sizePx": 24, "weight": 400, "lineHeight": 1.4, "tracking": 0 },
    "host-meta": { "font": "fonts/text", "sizePx": 18, "weight": 400, "lineHeight": 1.4, "tracking": 0 },
    "host-faint": { "font": "fonts/text", "sizePx": 18, "weight": 400, "lineHeight": 1.4, "tracking": 0 },
    "hud-number": { "font": "fonts/hud", "sizePx": 72, "weight": 600, "lineHeight": 1, "tracking": 0 },
    "hud-label": { "font": "fonts/text", "sizePx": 20, "weight": 500, "lineHeight": 1.2, "tracking": 0.02 },
    "menu-item": { "font": "fonts/text", "sizePx": 28, "weight": 500, "lineHeight": 1.2, "tracking": 0 },
    "menu-title": { "font": "fonts/display", "sizePx": 56, "weight": 600, "lineHeight": 1.1, "tracking": -0.02 },
    "caption": { "font": "fonts/text", "sizePx": 22, "weight": 500, "lineHeight": 1.3, "tracking": 0 }
  },
  "radii": { "control": 999, "card": 20, "panel": 20 },
  "spacing": { "xs": 4, "sm": 8, "md": 16, "lg": 24, "xl": 48 },
  "focusRing": { "color": "#C6F24EFF", "width": 3, "offset": 2 }
}
```

Rules: ≤ 64 colors, ≤ 32 type tokens, size 8–256 design px, weight 400/500/600, `tracking` −0.1..0.1 em. A theme token named in `DESIGN.md` keeps its meaning; a game theme may add tokens but may not redefine `accent` or the eight player hues.

### 4.4 Font formats

Three font kinds share `FontHandle`:

**MSDF (preferred for display text).** `.msdf.json` v1 plus a KTX2/WebP atlas:

```json
{
  "formatVersion": 1,
  "id": "fonts/display",
  "family": "Pocket Display",
  "style": "semibold",
  "unitsPerEm": 2048,
  "sizePx": 48,
  "pxRange": 4,
  "atlas": { "asset": "fonts/display-0.ktx2", "width": 2048, "height": 2048 },
  "metrics": { "ascent": 1900, "descent": -500, "lineGap": 0 },
  "glyphs": [
    { "cp": 65, "x": 0, "y": 0, "w": 48, "h": 56, "ox": 2, "oy": -40, "advance": 40 }
  ],
  "kerning": [[65, 86, -40]]
}
```

Limits: atlas ≤ 4096×4096, ≤ 4 pages, ≤ 4096 glyphs per page, JSON ≤ 2 MiB, `pxRange` 2–8. At runtime an MSDF glyph is scaled by `fontSizePx / sizePx * atlasScale`; the shader reconstructs a signed distance with `pxRange` and applies `fwidth`-based smoothing. One atlas page is one draw batch.

**Bitmap (HUD digits and small labels).** `.bitmapfont.json` v1: metrics, fixed-width or proportional glyph rects, optional monospace flag, one atlas. Used for score/lap/time counters where deterministic advance width matters. Max 512 glyphs.

**WOFF2 fallback (complex scripts, IME, dynamic text).** A packaged font asset loaded with `FontFace` from a same-origin URL. The UI rasterizes needed runs to an alpha atlas with `OffscreenCanvas` (or a hidden canvas when OffscreenCanvas is unavailable), using the browser's own shaping, bidi and fallback. Cache key includes locale, script, direction, size and text. Max 2 dynamic pages of 2048×2048 per font, LRU eviction; a page is never shared across fonts.

**Font stack.** Each `FontHandle` carries an ordered fallback list resolved at load: MSDF → bitmap → WOFF2 → system UI font. If no font can draw a codepoint, the engine draws U+FFFD and increments `ui.missingGlyph`. A screen that loses its primary font still renders readable text.

### 4.5 String tables

`strings.<locale>.json` v1:

```json
{
  "formatVersion": 1,
  "locale": "en",
  "fallback": "en",
  "dir": "ltr",
  "strings": {
    "hud.speed": "Speed",
    "menu.players": "{count, plural, one {# player} other {# players}}",
    "menu.games": "Games"
  }
}
```

Rules:

- Key: `^[a-z0-9][a-z0-9_.-]{0,63}$`; ≤ 4096 keys; file ≤ 256 KB; value ≤ 512 code points.
- Placeholders are `{name}` and `{count}`. The only supported formatter is the mini plural shown above (`one` and `other`; `zero`, `two`, `few`, `many` accepted when a CLDR-style locale needs them). No ICU message syntax beyond this; no HTML.
- `locale` is a BCP-47 tag. `dir` is `ltr` or `rtl`. Missing keys fall back to `fallback`, then to the key itself.
- Values are sanitized with the SDK `sanitizeText` rules (C0/C1 stripped except tab/LF/CR); the UI never interprets markup.
- RTL: layout anchors `left`/`right` become logical `start`/`end`; text runs are reordered by the browser in the WOFF2 path. The MSDF path refuses RTL and routes to WOFF2, so an RTL locale must ship a WOFF2 font.
- Locale selection: explicit game setting → host `navigator.languages` → `en`. The selection is stored by the host, not in a save.

### 4.6 Limits

| Limit | Value | Enforced at |
|---|---:|---|
| Nodes per screen | 4096 | Document load and runtime `create` |
| Tree depth | 16 | Document load |
| Text run length | 4096 code points | `setText` / table load |
| Fonts resident | 32 | Font registry |
| Atlas pages per font | 4 (MSDF/bitmap), 2 (dynamic) | Font load |
| Atlas page size | 2048×2048 default, 4096×4096 max | Tooling + load |
| String keys | 4096 per locale | Table load |
| String file | 256 KiB | Asset load |
| UI document | 1 MiB | Asset load |
| Draw calls per screen | 24 | Runtime; counter + dev warning |
| Glyphs per frame | 16,384 | Draw-list build; excess is clipped and counted |
| Text cache | 8 MiB | LRU |
| Focus candidates per move | 256 | Spatial search; nearest 256 scored |
| Interactive target | ≥ 44×44 design px | Validator + a11y audit |

Numbers are targets, not measurements. The 24-draw-call target follows SPEC PR-9.1 (120 draw calls total, with the world owning the rest) and is measured by ER-13-03.

### 4.7 Version registry

| Format | Current | Owner | Bump rule |
|---|---:|---|---|
| `UI_SCREEN_FORMAT_VERSION` | 1 | 13 | Required field or semantic change |
| `UI_THEME_FORMAT_VERSION` | 1 | 13 | Token meaning change |
| `MSDF_FORMAT_VERSION` | 1 | 13 | Glyph metric or atlas layout change |
| `BITMAP_FONT_FORMAT_VERSION` | 1 | 13 | Glyph table change |
| `STRINGS_FORMAT_VERSION` | 1 | 13 | Placeholder/plural semantics change |

Readers accept the current version and the previous one when a migration exists; an unknown newer version is refused with `E_UI_FORMAT`. Tooling writes only the current version.

---

## 5. Architecture

### 5.1 Module map

```
packages/engine/ui/
  src/scene/    node tree, style, layout measure/arrange, dirty flags
  src/text/     font registry, string tables, shaping, atlas, glyph cache
  src/render/   draw-list builder, quad batcher, MSDF shader, Canvas2D adapter
  src/focus/    focus manager, spatial search, repeat, scope stack
  src/input/    keyboard/remote, gamepad, phone adapter, pointer
  src/a11y/     DOM mirror, announcements, media-query settings
  src/theme/    token parsing, DESIGN defaults, contrast checks
  src/home/     home scene composition, depth layers, shelf navigation
  src/platform/ IME overlay, OffscreenCanvas/FontFace probes, safe-area probe
  src/index.ts  GameUi factory and public exports
```

Dependency rule (00 §5.2 D2): `engine-ui` imports `engine-core` and `engine-assets` only. It never imports a renderer backend, `engine-input`, `@lanpad/sdk`, `@lanpad/protocol`, `@lanpad/runtime` or a game. It receives a narrow `UiPainter` interface from the composition root, implemented by whichever backend is active.

```ts
export interface UiPainter {
  readonly backend: "webgpu" | "webgl2" | "canvas2d";
  readonly width: number;               // CSS pixels
  readonly height: number;
  beginUiFrame(): void;
  drawQuads(batch: UiQuadBatch): void;
  endUiFrame(): void;
  createTexture(desc: { width: number; height: number; format: "rgba8" | "alpha8" }): UiTextureHandle;
  uploadTexture(handle: UiTextureHandle, bytes: Uint8Array): void;
  destroyTexture(handle: UiTextureHandle): void;
}
```

`UiPainter` is internal to the engine and never appears in `GameUi`.

### 5.2 Frame pipeline and layers

The UI runs after the game's world render and before the host debug overlay:

```
input events (this frame)
  → UiInputRouter (topmost scope wins)
  → UiFocus (move/activate/back)
  → node state changes mark layout or paint dirty
  → layout pass (only if dirty)
  → text measure/shape/cache
  → draw-list build (ordered, clipped)
  → batcher (atlas pages + solid/rounded quads)
  → UiPainter → active backend
  → a11y mirror update (only if tree/text/focus changed)
```

Layers are fixed and ordered:

| Layer | Owner | Content |
|---|---|---|
| 0 `world` | game/engine scene | 3D world; not UI |
| 1 `hud` | game | score, speed, ammo, subtitles; `observe` input policy |
| 2 `menu` | game | pause/settings/results; `capture` input policy when visible |
| 3 `system` | host shell | notices, leave confirm, reconnect banner, room chip |
| 4 `debug` | host, `?debug=1` | profiler/overlay; never in production |

Each layer has one `UiScreen` root. Draw order is layer, then sibling `z`, then insertion. Screen-space layers draw with depth test disabled. `world-label` nodes are drawn in layer 1 with depth test enabled against the world depth buffer.

`UiInputPolicy` is per screen: `capture` (all navigation and activate/back keys are consumed while the screen is visible), `observe` (navigation keys pass to the game; the HUD never blocks), `off`. The game maps a controller button to "open pause menu"; while the menu is open, the host still delivers the same input snapshot to the game, but the game must not act on it. The engine does not silently swallow game input.

### 5.3 Layout engine

Layout is a deterministic two-pass solver over a node tree. It is pure, synchronous and allocation-free after the first build.

**Pass 1, measure.** Bottom-up intrinsic size:
- `text`: `FontHandle.measure` at the effective size, with wrapping at `maxWidth` when the parent gives a bounded width.
- `image`: intrinsic pixel size divided by `atlasScale`, or the declared width/height.
- `group`/`scroll`: sum of children along `direction` plus `gap`, plus padding; cross-axis max.
- `slider`/`toggle`: theme-defined height (56 design px), width from `content` or parent.

**Pass 2, arrange.** Top-down placement:
- The root is the design rect minus safe area.
- `anchor` + `x`/`y` place a node against its parent content box. `stretch` sets width/height to the parent content box minus offsets.
- `percent` resolves against the parent content box on that axis.
- `min/max` clamp after resolution; a `content` axis uses the measured intrinsic size.
- `direction: row|column` lays out children along the main axis; `justify` distributes leftover space; `align` positions on the cross axis; `wrap` starts a new line when the next child would exceed the main extent.
- `padding` shrinks the content box for children.
- `z` affects paint order only, never layout.
- A `scroll` node has a content box larger than its frame; `scrollY`/`scrollX` offset children; children are clipped by scissor.

**Dirty rules.** Layout reruns only when the viewport, text scale, a node's layout/style/text, or the tree changes. Paint reruns when color, opacity, focus state, image, or a text cache entry changes. A frame with no dirty node performs no layout and no text work.

**Cycle and overflow safety.** A parent cycle is impossible (tree), but a pathological `percent` chain is clamped to 0..8192 design px. NaN or Infinity in any length is treated as 0 and counted (`ui.invalidLength`). Overflow beyond 16,384 design px is clipped and counted; it is a content bug, not a crash.

**Text reflow.** Text is measured once per cache key. A change in text scale invalidates all text metrics, but the engine reflows in one pass: it never animates text size, so there is no intermediate layout.

### 5.4 Painting and batching

- The draw list is a flat array of `UiQuad`s in paint order: `{ x, y, w, h, u0, v0, u1, v1, color, mode, radius, textureId }`.
- `mode`: `solid`, `rounded`, `texture`, `nine-slice`, `msdf-text`, `bitmap-text`.
- Rounded rectangles are drawn with an SDF in the fragment shader, not with stencil geometry. Radius ≤ half the shorter side; a larger radius clamps.
- Clipping is a scissor-rect stack. Rounded clipping is not supported in v1; a `clip` node clips to its rectangle.
- Text glyphs are quads referencing the font's atlas page. Consecutive quads sharing `textureId` and `mode` merge into one draw batch.
- One dynamic vertex buffer per frame, written once; one index buffer with a fixed pattern. No per-quad buffer allocation.
- The batcher sorts by paint order, not by texture; a texture switch breaks the batch. The screen designer is responsible for keeping atlas pages few. The engine reports `drawCalls` and warns in dev when a screen exceeds 24.
- MSDF text uses one shader: `alpha = median(r, g, b)`, smoothed with `fwidth` derived from `pxRange`, with optional 1 px outline (threshold offset) and 1 px shadow (offset sample). No blur, no gradient, no glow (DESIGN.md bans them).
- Opacity is premultiplied at write time. A group's opacity multiplies its descendants; the engine does not render to an offscreen layer unless a future spec adds it.
- The Canvas2D adapter implements the same draw list with `fillRect`, `roundRect` (fallback to a path), `drawImage`, and `fillText` for WOFF2 runs. It uses the same layout results, so geometry does not drift between backends.

### 5.5 Text pipeline

1. **Resolve.** `textKey` → string table → string; `{placeholders}` substituted; `sanitizeText` applied. The result is a grapheme-cluster array via `Intl.Segmenter` when available, else code points.
2. **Shape.** If the font `supportsShaping` is false and the run is simple LTR text (no bidi controls, no joining scripts), use MSDF advances and kerning. Otherwise route to the WOFF2/Canvas2D path, where the browser shapes the run; cache the rasterized bitmap run.
3. **Measure.** Return `TextMetrics2` from the font. Measurement and shaping never rasterize, so layout is stable even if the atlas is not ready.
4. **Cache.** Key = `fontId | sizePx*atlasScale | textScale | wrapWidth | text`. A hit returns a glyph-run object (positions + atlas refs). Miss builds a run and may rasterize.
5. **Rasterize.** MSDF glyphs are already in the atlas; no rasterization. Bitmap glyphs are already in the atlas. WOFF2 runs rasterize into a dynamic page with `OffscreenCanvas` (or a hidden canvas), then upload.
6. **Pack.** Dynamic pages use a shelf packer with 1 px padding. Full pages evict the least-recently-used run; an evicted run is re-rasterized on next use. Atlas memory is reported in `UiStats.atlasBytes`.
7. **Upload.** At most 256 KiB and 2 ms of main-thread raster/upload per frame; a run that misses the budget is queued and drawn on the next frame. Layout does not wait for it, so nothing jumps.
8. **Draw.** Glyph quads are emitted in visual order. Missing glyphs draw U+FFFD and count.

**Crispness.** MSDF is resolution-independent; `atlasScale` only affects the dynamic/bitmap paths. Text at 64 design px on a 4K TV remains sharp because the atlas is generated at 48 px with `pxRange` 4 and sampled with linear filtering. The acceptance check compares edge contrast at 1× and 2× DPR, not raw pixels.

**Numbers.** HUD numbers use the bitmap font with tabular advances, so a score does not jitter when digits change. `fontVariantNumeric: tabular-nums` is not available in the MSDF path; the tooling marks which glyphs are tabular and the layout uses a fixed advance for them.

### 5.6 Focus and navigation

Focus is a tree of interactive nodes plus a scope stack:

- **Scope.** The root is one scope. A modal calls `focus.setScope(modalRoot)`; `popScope()` restores the saved focus. A scope traps focus: navigation never leaves the modal while it is active.
- **Candidate set.** All visible, enabled, interactive descendants of the current scope, excluding nodes with `interactive: false`, `disabled: true`, `visible: false`, zero-size boxes, or `a11y.hidden`.
- **Directional search.** For a direction, keep candidates whose center lies in the half-plane of that direction from the current center (a 90° cone, with a 1 px tolerance for aligned edges). Score:
  ```
  score = primaryDistance + 0.5 * secondaryDistance + 0.25 * anglePenalty + 4 * overlapPenalty
  ```
  where `primaryDistance` is along the direction axis, `secondaryDistance` across it, `anglePenalty` is the absolute tangent of the off-axis angle, and `overlapPenalty` is 1 when the boxes do not overlap on the cross axis. Lowest score wins. Explicit `node.next = { up, down, left, right }` overrides the search for that node and direction.
- **Wrap.** A scope declares `wrap`; the home shelf wraps at the ends, dialogs do not. Wrapping re-enters the candidate set from the opposite edge.
- **Repeat.** A held direction moves once immediately, then after 250 ms, then every 120 ms. Release, blur, scope change or a different source stops the repeat. Gamepad axes use a 0.5 threshold with a 200 ms debounce; the d-pad uses the same repeat as keys.
- **Source lock.** When two sources navigate within 250 ms, the first claims the focus for 250 ms; the other is ignored. This prevents a phone and a remote fighting over one TV focus. The focus ring is drawn for the last source; `pointer` never moves focus, it only activates on click.
- **Activation.** `Enter`, `Space`, remote `OK`/`Select`, gamepad A, pointer click and phone activate call `onActivate` exactly once. `event.repeat` is ignored. A disabled node does nothing and announces "Unavailable" if focus announcements are on.
- **Back.** `Escape`, remote Back/GoBack, gamepad B and phone B pop the top scope; if no scope is open, the host's leave-confirm handler runs. The UI never swallows Back when it has nothing to close.
- **Restore.** Opening a modal saves `{ scope, node }`; closing restores it. If the node was destroyed, focus returns to the first interactive node in the scope.
- **Focus ring.** 3 design px `accent`, 2 design px offset, plus a 2 design px `ground` outer ring when the node's background is light. The ring is drawn in the UI layer, never with a DOM outline. It is visible in every state, including over a game frame.

### 5.7 Input mapping

| Action | Remote | Keyboard | Gamepad | Phone |
|---|---|---|---|---|
| Move | Arrow keys | Arrow keys / WASD | D-pad / left stick | Platform menu layout d-pad bits 8–11 |
| Activate | OK / Select / Enter | Enter / Space | A (button 0) | bit 0 |
| Back | Back / GoBack | Escape | B (button 1) | bit 1 |
| Page | Channel Up/Down | PageUp / PageDown | LB / RB | — |
| First/last | — | Home / End | — | — |
| Text entry | — | Any key opens IME overlay | — | `text` control event |
| Pointer | — | Mouse move/click | — | Touch (via controller layout) |

- Remote key names vary by TV. The adapter accepts `key` values (`"Enter"`, `" "`, `"Spacebar"`, `"Select"`, `"OK"`, `"GoBack"`, `"Back"`, `"Escape"`) and legacy `keyCode` 13/37–40/8/27, matching the existing `Launcher` and `StartScreen` behaviour. It never relies on a vendor-specific key name alone.
- Phone navigation uses a **platform-owned menu layout** (`layouts/system-menu.json`, installed by the host when the home or a platform modal is visible). It binds a d-pad to bits 8–11, A to bit 0 and B to bit 1. The controller needs no new control type and no new protocol frame. The host reads those bits from the existing `InputFwd` stream and forwards them to the UI input router. The game's input mapper also sees them; while the home is active no game is running, and while a platform modal is open the game is paused or its input policy is `capture`.
- Text entry: activating a `text` node opens a DOM `<input>` positioned off-screen (or over the field on desktop) for IME and physical keyboard. The value is mirrored into the UI and committed on Enter or blur. The overlay is removed when the field loses focus. This is the only case where a visible DOM element may sit above the canvas; it is transparent except for the caret and composition text.
- Gamepad polling is injected by `engine-input`; the UI package does not call `navigator.getGamepads()` itself. The adapter receives a normalized `GamepadSnapshot` and maps buttons/axes.

### 5.8 Accessibility

Canvas pixels are invisible to assistive technology. The UI therefore maintains a **DOM mirror**:

- One hidden container per UI layer, `position: fixed; left: -10000px; width: 1px; height: 1px; overflow: hidden;` (not `display: none`, which removes it from the tree).
- Each interactive node maps to a real `<button>`, `<input>`, `<li>` or `<div role="...">` with `aria-label`, `aria-describedby`, `aria-disabled`, `aria-pressed`, `aria-valuenow/min/max`, and `tabindex`. Headings map to `<h2>`/`<h3>`; lists map to `<ul>`/`<li>`.
- Focus is mirrored both ways: a screen-reader focus event calls `UiFocus.focus(node)`; a UI focus change calls `.focus()` on the mirrored element with `preventScroll`.
- Text changes update `textContent` only when the string changes. The mirror never contains markup from game or user text.
- `a11y.announce()` writes to a single `aria-live` region (`polite` by default, `assertive` for errors). Focus announcements are off by default for the HUD and on for dialogs.
- The mirror is updated at most once per frame and only when the tree, text or focus changed. A 4,000-node screen does not rebuild the DOM per frame.
- Settings: `prefers-reduced-motion: reduce` sets `theme.motionScale = 0` and disables ambient home drift; `prefers-contrast: more` selects the high-contrast token set (pure white text, 3 px focus ring, 1 px borders); `forced-colors` is detected but canvas rendering cannot honour it, so the high-contrast theme is offered in settings and the mirror remains usable by the OS.
- Text scale 100–200% is a product setting; it reflows layout and must not clip. The a11y audit checks every fixed-height text container at 200% in the fixture locales.
- Targets: interactive nodes are at least 44×44 design px, and the home cards are 560×360 design px (PAGE-PLANS HP-03).
- State is never conveyed by colour alone: the winner row carries the word `WIN`, the connected dot has a text label, and focus has a ring.

### 5.9 Home screen and the depth requirement

The home is the engine's flagship UI and the acceptance fixture. It is **not** a DOM launcher with a background image.

**Composition.** The home renders at least four depth layers in one scene:

| Layer | Content | Depth | Motion |
|---|---|---|---|
| L0 `background` | city/skyline silhouette, vignette, ambient gradient-free shapes | z = 0.00 | slow ambient drift ≤ 0.2°/s; off under reduced motion |
| L1 `midground` | ambient particles / grid / player-hue glow shapes | z = 0.35 | tied to L0 drift only |
| L2 `shelf` | game cards on a perspective plane, 560×360 design px | z = 0.70 | static |
| L3 `overlay` | title, room chip, roster, focus ring, scroll affordance | z = 1.00 | static |

- The shelf is a single row (or 2×4 grid at ≥ 1920 design px) of cards. Each card shows a drawn motif or `poster` texture, the game name at 40 design px, the player range, a one-line description, and the live connected count when `> 0`.
- Focus is instant: the ring appears, the card title brightens from `muted` to `text`, and nothing translates, scales or fades. The depth layers do **not** parallax on focus; that would violate `DESIGN.md`'s "nothing animates on remote focus movement". Depth is a static composition plus an optional slow ambient drift.
- The room code and PIN appear exactly once, in the home's join block, matching PAGE-PLANS HP-02/HP-03. The roster sits below the shelf, not in the hero.
- Empty state: "No games installed" plus "Add a game package, then restart the host." The frame and depth layers stay.
- Search and filters are reachable without a keyboard: filters are a row of buttons (All / 1 / 2–4 / 5–8); search opens the IME overlay. The registry is the only source of cards; no slug is hard-coded.
- The home is engine-rendered: the visual tree must not contain `.lanpad-launcher`. The accessibility mirror may contain the same roles and labels.

**Depth acceptance (ER-13-02).** The fixture `experiments/e-ui-home/?bench=1&depth=1` exposes:

```ts
window.__UI_BENCH__ = {
  layers: 4,
  parallax: { background: 0.15, midground: 0.35, shelf: 0.70, overlay: 1.00 },
  depthOrder: ["background", "midground", "shelf", "overlay"],
  focusDeltaPx: 0,          // measured card translation on a focus move; must be <= 0.5
  ambientDrift: true,
  drawCalls: number,
  frameP95Ms: number,
  nodes: number
};
```

The test asserts: `layers >= 4`; the four layers are painted in the stated order; a focus move produces `focusDeltaPx <= 0.5`; the ambient drift is disabled when `prefers-reduced-motion` is emulated; and the 8-card fixture holds the frame budget. This is the measurable meaning of "depth" in this spec. It is visual depth (z-separated layers, perspective, occlusion), not a focus animation.

**Fallbacks.**

1. WebGPU or WebGL2: full four-layer scene.
2. Canvas2D only: a flat three-layer composition (background, shelf, overlay) with scale-based depth; no perspective, no ambient drift. It still meets layout, focus and accessibility acceptance, but not the four-layer depth row.
3. UI renderer init failure: the existing DOM launcher remains mounted and a notice explains that the engine home is unavailable. Never a blank screen; never a non-functional canvas.

**Migration from the DOM launcher.** The existing `Launcher` stays in `packages/runtime/src/ui/Launcher.ts` until the engine home passes the parity rows (search, filters, roster, empty state, focus, phone navigation). Then the root route mounts the engine home and the DOM launcher moves behind `?ui=dom` for one milestone before deletion. Deleting it earlier is out of scope and a review failure.

### 5.10 Hot paths and allocation rules

Hot paths: `UiFocus.move`, layout arrange, draw-list build, text cache lookup, batcher flush, a11y diff. In these paths:

- no `new`, no object/array literals, no closures created per call, no `map`/`filter`/`forEach`, no string concatenation;
- node objects are created at screen build and pooled per screen; a destroyed node returns to a free list;
- glyph runs, quad arrays, candidate arrays and scissor stacks are preallocated and reused;
- `textContent` is written only when the string changes;
- debug counters and `UiStats` are updated without allocation;
- a screen may allocate on `setModel`, `loadScreen`, text scale change, and theme change.

A new allocation in a hot path requires a comment explaining why it is not per-frame in practice. The benchmark enforces heap growth (ER-13-12).

### 5.11 Failure handling and fallbacks

| Failure | Behaviour |
|---|---|
| Primary font fails to load | Fall back through the font stack; counter `ui.fontFallback`; a notice only if no font at all |
| Atlas page full | Evict LRU runs; if still full, drop decorative glyphs before body text; counter |
| UI document invalid | Refuse the screen with `E_UI_FORMAT`; the host shows a notice; the previous screen stays |
| Text key missing | Render the key in `warning` in dev, empty string in production; counter |
| NaN/Infinity layout | Treat as 0; counter `ui.invalidLength`; dev warning once per node |
| GPU device lost | Invalidate UI textures; CPU glyph cache survives; re-upload on the next frame; if it fails twice, fall back to the Canvas2D painter |
| UI painter init fails | Mount the DOM fallback (launcher or notice); do not start a game that requires `ctx.ui` without telling the player |
| Focus scope has no interactive node | Focus stays null; `activate()` returns false; Back still closes the modal |
| Two sources fight | 250 ms source lock; no lost activation |

All recoverable failures increment a counter and degrade one feature. Unrecoverable failures route an `EngineError` (`layer: "ui"`) to the host notice panel (00 §5.9).

### 5.12 Determinism and testability

- Layout and focus are deterministic functions of the tree, viewport, text scale and input sequence. They run in Node with a stub `FontHandle` whose metrics are a fixed table.
- Text shaping in the MSDF path is deterministic. The WOFF2 path depends on the browser's font engine, so golden tests for complex scripts are captured per browser and compared with a tolerance; they are not a cross-browser pixel contract.
- The home's ambient drift is time-based, so the fixture supports `?freeze=1` to pin a phase for golden capture. Acceptance compares the frozen phase.
- The UI never reads `Math.random`; all randomness in decorative layers is seeded from the screen id and the `ctx.rng` seed if the game supplies one. The home uses a fixed seed.
- The engine exposes `UiStats` and `window.__UI_BENCH__` in dev only; production bundles drop the benchmark object.

### 5.13 What the first implementation must not do

- It must not build a general CSS engine. The layout subset in §5.3 is the whole contract.
- It must not rasterize MSDF at runtime or ship an MSDF generator in the browser bundle.
- It must not render text with a DOM overlay except the IME input.
- It must not animate remote focus.
- It must not import a renderer backend or `@lanpad/sdk`.
- It must not remove the DOM launcher before parity is recorded.
- It must not claim the TV depth/performance rows from a desktop run.

---

## 6. File ownership

One writer per file. This spec owns the UI package and its tests. Integration-owned files (root `package.json`, `tsconfig.json`, the root Vitest config, `eslint.config.js`, `workspaces`) are edited by the integration agent in the same wave, never by the UI feature agent. The SDK and runtime files named at the bottom are owned by their existing specs; 13 proposes the change, the owner writes it.

| Path | Contents | Wave |
|---|---|---|
| `docs/engine/13-ui-text.md` | this spec | spec wave |
| `packages/engine/ui/package.json` | workspace `@lanpad/engine-ui`, private, deps `@lanpad/engine-core` + `@lanpad/engine-assets` only | M1 |
| `packages/engine/ui/tsconfig.json` | project reference; `lib` includes DOM because `a11y/`, `platform/` and the Canvas2D painter need it | M1 |
| `packages/engine/ui/src/index.ts` | public exports: `GameUi`, `UiPainter`, factories | M1 |
| `packages/engine/ui/src/scene/**` | node tree, style, measure/arrange, dirty flags, pooling | M1 |
| `packages/engine/ui/src/text/**` | font registry, string tables, shaping, glyph cache, atlas packer | M1 |
| `packages/engine/ui/src/render/**` | draw-list builder, quad batcher, MSDF shader source, Canvas2D painter | M1 |
| `packages/engine/ui/src/focus/**` | focus manager, spatial search, repeat, scope stack, source lock | M1 |
| `packages/engine/ui/src/input/**` | keyboard/remote, gamepad, phone-menu adapter, pointer, IME bridge | M1 |
| `packages/engine/ui/src/a11y/**` | DOM mirror, announcements, media-query and contrast settings | M1 |
| `packages/engine/ui/src/theme/**` | token parsing, DESIGN defaults, contrast checks, text scaling | M1 |
| `packages/engine/ui/src/home/**` | home composition, depth layers, shelf, filters, empty state | M1 |
| `packages/engine/ui/src/platform/**` | OffscreenCanvas/FontFace probes, safe-area probe, DPR probe | M1 |
| `packages/engine/ui/test/**` | unit, property, golden layout, focus, a11y, integration, bench | M1 |
| `packages/engine/ui/test/fixtures/fonts/**` | stub font metrics and a 96-glyph MSDF fixture; no licensed font | M1 |
| `packages/engine/ui/test/fixtures/screens/**` | `hud-race.ui.json`, `menu-settings.ui.json`, `home-8card.ui.json` | M1 |
| `experiments/e-ui-home/fixtures/**` | data used by the acceptance page; spec 19 owns the page shell | M1 |

Boundaries and non-owned paths:

- `engine-ui` imports `engine-core` and `engine-assets` only (00 §5.2 D2). It never imports a backend package, `engine-input`, `@lanpad/sdk`, `@lanpad/protocol`, `@lanpad/runtime`, `@lanpad/controller` or a game.
- `UiPainter` is implemented in `packages/runtime/src/compat/uiPainter*.ts` by the integration agent, beside `selectRenderer.ts`. The UI package never names a concrete backend.
- `sdk/src/game-api.ts` and any `sdk/src/ui.ts` are owned by spec 18. 13 supplies the structural types; 18 adds the optional `GameContext.ui` member and the SDK size test.
- `packages/runtime/src/ui/Launcher.ts`, `StartScreen.ts`, `ResultsOverlay.ts`, `Notice.ts`, `SlotRoster.ts` and `RoomPanel.ts` stay with their current owners until the parity row (ER-13-06) passes. 13 may read them; it may not edit them. The migration is an integration wave.
- Font tooling (MSDF generation, WOFF2 subsetting, atlas packing) implements the formats in §4.4 but lives under `packages/engine/tooling/src/node/font/**`, owned by spec 16. 13 owns the format and the runtime reader.
- `experiments/e-ui-home/**` is owned by spec 19; 13 supplies fixture data and the `?depth=1` contract in §5.9.
- `packages/controller/**` is not touched. Phone menu navigation uses the existing control types and the existing binary input frame (bits 8–11, 0, 1).
- Root `package.json`, `tsconfig.json`, Vitest projects and `eslint.config.js` are integration-agent edits (00 §5.16).

---

## 7. Acceptance

Every row carries an `ER-13-*` requirement ID that must resolve to a row in `docs/todos/TRACEABILITY.md` once the engine programme is registered. **Evidence rule:** PASS requires a recorded build hash, device id, browser version, date and numbers in `docs/RESULTS.md`. Untested rows say PENDING and name the run needed. No row is claimed from this document. Thresholds are targets derived from `DESIGN.md`, `PAGE-PLANS.md`, SPEC §11 and 00 §7, not measurements.

The **UI fixture** is `experiments/e-ui-home/` with `?bench=1&depth=1` and the checked-in `home-8card` model; the **UI conformance fixture** is `packages/engine/ui/test/fixtures/screens/**` rendered by a fake `UiPainter` in Node and by the real painter in the browser.

| ID | Criterion | Fixture / method | Hardware | Evidence state |
|---|---|---|---|---|
| ER-13-01 | `npm run check` exits 0; every test title carries its `ER-13-*`; no test skipped, removed or weakened for the wave | full gate | CI Node 20 | PENDING — first M1 UI wave |
| ER-13-02 | **Home depth:** the engine home paints ≥ **4** layers in the order `background, midground, shelf, overlay`; a focus move produces `focusDeltaPx ≤ 0.5`; ambient drift is present at `motionScale > 0` and absent with `prefers-reduced-motion: reduce`; the 8-card fixture holds its frame budget | `experiments/e-ui-home/?bench=1&depth=1&freeze=1`; `window.__UI_BENCH__` from §5.9; fixture `home-8card.ui.json` | `pc-win11-rtx3050`, Chrome 155.0.8059.85, WebGPU; WebGL2 repeat recorded | PENDING — page and fixture not built |
| ER-13-03 | **Frame budget:** the 8-card home at 1920×1080 CSS, DPR 1, 600 measured frames after 120 warm-up: frame p95 ≤ **14 ms**, UI draw calls ≤ **24**, UI CPU (layout + text + draw-list) p95 ≤ **1.5 ms**; the same page on WebGL2 p95 ≤ **20 ms** (hard) | same page, `?bench=1`; `UiStats` sampled per frame | `pc-win11-rtx3050`, Chrome 155.0.8059.85 (WebGPU and WebGL2 runs) | PENDING — needs the M1 page |
| ER-13-04 | **Text crispness and reflow:** MSDF edge contrast at 2× DPR is within **10%** of the 1× capture at the same design size; a 200% text-scale run of every fixture screen has zero clipped text boxes and zero overlapping focus rings; the missing-key and missing-glyph paths render U+FFFD/empty and increment their counters | `?bench=1&textScale=2&dpr=2`; golden captures for `hud-race`, `menu-settings`, `home-8card`; Node layout assertions | `pc-win11-rtx3050`, Chrome 155 (DPR 2 emulation); golden files in `test/fixtures/golden/` | PENDING — implementation and captures |
| ER-13-05 | **One focus grammar:** a recorded input sequence (up/down/left/right/activate/back, 60 events) produces exactly the expected focus path for remote, keyboard, gamepad and phone sources; a source switch inside 250 ms is ignored; held-direction repeat fires at 0 ms, 250 ms, then every 120 ms; a modal traps focus and restores the previous node on pop | `packages/engine/ui/test/fixtures/focus-sequence.json`; Node unit + jsdom mirror test | CI Node 20 + jsdom | PENDING — fixture authored with implementation |
| ER-13-06 | **Home parity:** search, the four player-count filters, room code + PIN, roster, empty state, focus and phone navigation match the DOM launcher's behaviour; the engine visual tree contains no `.lanpad-launcher`; the DOM launcher remains reachable at `?ui=dom` for one milestone | `experiments/e-ui-home/?bench=1`; manual side-by-side record; integration test of the root route | `pc-win11-rtx3050`, Chrome 155 | PENDING — migration wave |
| ER-13-07 | **Accessibility mirror:** every interactive node exposes a role, accessible name and state; focus changes call `.focus()` on the mirror; `announce()` reaches one `aria-live` region; a 4,000-node screen updates the mirror at most once per frame and only when the tree, text or focus changed | jsdom test with a node-count fixture; screen-reader smoke run (NVDA on Windows, VoiceOver on macOS) | CI Node 20 + jsdom; **manual:** NVDA 2025 on `pc-win11-rtx3050` | PENDING — implementation; screen-reader run pending |
| ER-13-08 | **No per-frame allocation:** heap growth ≤ **512 KiB** over 480 measured frames after 120 warm-up on the home fixture, with focus moving every frame and no text changes; no allocation site in layout, focus search, draw-list build or a11y diff | `?bench=1&alloc=1`; `performance.memory` sampled after forced settle | `pc-win11-rtx3050`, Chrome 155 (heap API available) | PENDING — needs the M1 page |
| ER-13-09 | **Text pipeline budget:** WOFF2 rasterization and upload ≤ **256 KiB** and ≤ **2 ms** main-thread work per frame; a run that misses the budget is queued and appears on the next frame without a layout jump; dynamic pages evict LRU and re-rasterize correctly | `?bench=1&glyphStress=1`; `UiStats.textRasterMs`, `atlasBytes`; fault fixture with a full atlas | `pc-win11-rtx3050`, Chrome 155 | PENDING — implementation |
| ER-13-10 | **Bundle budget:** `@lanpad/engine-ui` ≤ **120 KB gzip** in the host bundle (target; recorded in the size report); the controller bundle byte count is unchanged; no third-party UI/font dependency appears in the production bundle | `npm run size` + build-graph test | CI Node 20 | PENDING — first M1 build |
| ER-13-11 | **Canvas2D fallback:** with the Canvas2D painter, layout, focus, text at 100% and 200%, the a11y mirror and the home parity rows pass; the four-layer depth row is explicitly **not** claimed, and the fallback notice names the reduced tier | `?backend=canvas2d` on the same fixture | `pc-win11-rtx3050`, Chrome 155 | PENDING — implementation |
| ER-13-12 | **TV legibility:** the home and a HUD screen are readable at **3 m** on a 1080p TV; text at 100% and 200% does not clip; focus ring is visible over a bright game frame; UI draw calls ≤ 24 and frame p95 ≤ 20 ms on the TV profile | manual capture + `?bench=1&profile=tv`; recorded in `docs/RESULTS.md` | **PENDING device:** a 2020-era Android TV Chromium and a Tizen/webOS set from SPEC §12 | PENDING — no TV hardware |
| ER-13-13 | **Determinism:** the same screen document, viewport, text scale and input sequence produces byte-identical layout boxes and focus paths on two runs in Node; a viewport matrix (1280×720, 1920×1080, 3840×2160, 4:3) produces the expected golden boxes, including safe-area and letterbox offsets | `packages/engine/ui/test/fixtures/layout/*.json`; golden boxes | CI Node 20 | PENDING — fixtures authored with implementation |
| ER-13-14 | **UI document safety:** a document containing a script, `href`, `data:` image, `..` asset path or unknown `kind` is refused with `E_UI_FORMAT`; a missing `textKey` renders the production fallback and increments `ui.missingKey`; an unknown newer `formatVersion` is refused | `packages/engine/ui/test/fixtures/reject/**` | CI Node 20 | PENDING — implementation |

A row may not be marked PASS from a specification or from a synthetic device other than the one named. ER-13-12 stays PENDING until a real TV run is recorded.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | length resolution, anchor/stretch/percent math, min/max clamp, dirty propagation, focus scoring and tie-breaks, repeat timing, source lock, string substitution and plural, sanitizer, theme token parse, text-scale reflow, slot/target limits | `packages/engine/ui/test/unit/**` |
| Property (`fast-check`) | layout is finite and inside `0..16384` design px for finite inputs; a node's box contains its children when `clip` is false; focus never selects a hidden/disabled/zero-size node; scope push/pop restores exactly; text measure never exceeds declared max lines; pool reuse returns the same node count | `packages/engine/ui/test/property/**` |
| Golden | layout boxes for the viewport matrix; draw-list order for `hud-race`, `menu-settings`, `home-8card`; focus path for `focus-sequence.json`; mirror HTML for a fixed tree; frozen home capture | `packages/engine/ui/test/golden/**` |
| Contract | fake `UiPainter` records draw calls, textures and frame boundaries; WebGPU, WebGL2 and Canvas2D painters must pass the same draw-list conformance suite; painter dispose is idempotent | `packages/engine/ui/test/contract/uiPainter.conformance.test.ts` |
| Integration | runtime mounts the engine home, `?ui=dom` still serves the launcher, UI painter selection follows the renderer, `ctx.ui` is present/absent correctly, focus reaches the game only under `observe`, teardown releases textures and mirror nodes | `packages/runtime/test/integration/uiBoot.test.ts` |
| Browser/benchmark | home depth fixture, frame p95, draw calls, text raster budget, 2× DPR contrast, allocation growth, Canvas2D fallback | `experiments/e-ui-home/?bench=1` (shell owned by 19) |
| Manual | TV legibility at 3 m, remote key matrix on real sets, NVDA/VoiceOver pass, IME on Android and iOS keyboards | `docs/RESULTS.md` rows |
| Meta | every `ER-13-*` row has a test or a named manual run; every fixture named in §7 exists; no row claims a number without a device | `tools/trace-check` with the ER grammar extension |

Rules:

- Test titles carry `ER-13-*` or a leading `// @req ER-13-*`; the tag must resolve to a traceability row.
- Layout, focus, string and theme tests run in Node with a stub `FontHandle` and no DOM. jsdom is confined to `test/a11y/` and mirror tests.
- Integration tests bind `127.0.0.1:0`, wait on events and never use fixed sleeps. They do not mock the dev server.
- Browser-only rows are measured on the page and recorded; a browser row is never deleted to make CI green. CI covers the same draw list through the fake painter.
- Performance rows report build hash, device id, browser version, backend, resolution, DPR, sample count and p50/p95/max. A number without those fields is not evidence.
- Every golden capture is generated from a fixture with `?freeze=1`; an ambient-drift capture without freezing is not a valid golden.
- No test uses a licensed font. The MSDF fixture is generated from an open-licence face; the licence file ships beside it.

---

## 9. Dependencies

| Dependency | Why | Status |
|---|---|---|
| `00-architecture.md` | Package boundary, `GameContext` additive rule, `EngineErrorCode`, no-per-frame-allocation rule, format registry | Exists |
| `01-core-loop-time.md` | Frame phase order (UI after world, before debug), `EngineFrame`, fixed tick boundary for input policy | Exists |
| `04-renderer-webgpu.md` / `05-renderer-webgl2.md` | The `RenderDevice` frame boundary and the `UiPainter` adapter contract; no backend import | Exists |
| `06-assets.md` | `AssetLibrary`, `AssetHandle`, font/image/atlas kinds, same-origin URL rules, worker decode | written |
| `09-audio.md` | Optional UI sounds and the gesture-unlock rule; the UI must work silently while locked | Exists |
| `10-input.md` | Normalized keyboard/gamepad snapshot, phone adapter, action map; the UI router consumes normalized events, never DOM/gamepad directly | written |
| `12-world-streaming.md` | `WorldCell` keys for world-label culling and cell-scoped HUD state; no runtime dependency in M1 | Exists |
| `16-tooling-profiler.md` | Font/atlas generation command, profiler overlay, dev-only size checks | Exists |
| `18-game-sdk.md` | Additive `GameContext.ui`, SDK structural types, size test | written |
| `19-testing-benchmarks.md` | The `experiments/e-ui-home/` shell, golden-image rig, benchmark result schema | written |
| `SPEC.md` §11 (PR-9.8), §12 (FR-12.1/12.2), §13 | Draw-call and frame budgets, TV device matrix, feature detection, no PII/tokens in UI or logs | Exists |
| `DESIGN.md`, `docs/PAGE-PLANS.md` | True-black-flat visual system, home composition, focus rules, type scale, 3 m legibility | Exists |
| Existing `packages/runtime/src/ui/*` | Migration source and parity reference; owned by the current runtime owners, not 13 | Exists |
| Existing `packages/controller/src/controls/*` | Phone menu layout uses existing control types; no controller change | Exists |

**Sequencing.** Layout/focus/text core can land against a fake painter before any backend work. The engine home lands after layout, text and focus, and before the DOM launcher is removed. The WebGPU/WebGL2 painters land with 04/05's frame boundaries; the Canvas2D painter is the fallback and must not delay M1. `ctx.ui` is exposed only after the package passes ER-13-02 through ER-13-08.

**Prerequisites for the fixture.** Spec 06 must return decoded image bytes and a KTX2 atlas handle to the UI; spec 16 must generate the MSDF/bitmap atlases from the fixture font; spec 19 must provide the comparison page and golden capture; spec 18 must add the optional SDK member before a game can consume `ctx.ui`.

**Paper-trail prerequisites.** The `ER-*` grammar extension in `tools/trace-check` and the `TRACEABILITY.md` rows are owned by spec 19. Until they land, ER-13 rows are documentation-only and are not gate evidence. The engine UI package must be added to root `workspaces`, `tsconfig` references, Vitest projects and eslint boundary rules by the integration agent (00 §5.16).

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R13-1 | The engine home is slower or less legible than the DOM launcher, and the migration regresses the product | Medium | Users see a worse home; migration stalls | Parity rows first; DOM launcher kept behind `?ui=dom`; golden and manual side-by-side; the migration is reversible until ER-13-06 passes |
| R13-2 | TV browsers render 10-foot text badly or overscan clips it | High until measured | Illegible UI on the primary TV target | Safe area 64 design px, 3 m legibility row, MSDF atlas generated for TV sizes, text-scale setting, TV run recorded before claiming the row |
| R13-3 | Complex scripts shape incorrectly in the MSDF path | Medium | Wrong or unreadable text for some locales | MSDF refuses RTL/complex runs and routes to WOFF2; per-script fixtures; missing glyphs are visible and counted, never silently wrong |
| R13-4 | Fonts and atlases inflate the host bundle or memory | Medium | 5 MB gate failure, TV memory pressure | WOFF2 subsetting, MSDF atlas caps, ≤32 resident fonts, 8 MiB text cache, lazy load per locale, size report per wave |
| R13-5 | The Canvas2D painter drifts from the GPU painters | High if unmanaged | Games look different by backend | One draw list and one layout result; painter conformance suite; golden captures per backend; Canvas2D is an explicit reduced tier |
| R13-6 | The DOM mirror and canvas diverge, so assistive technology describes a different UI | Medium | Accessibility failure | Mirror built from the same tree and updated on the same change; jsdom contract test; NVDA/VoiceOver smoke run; no second source of truth for labels |
| R13-7 | Focus fights between remote, phone, keyboard and gamepad | Medium | Lost activations, unusable menus | One focus manager, 250 ms source lock, repeat/timing fixture, pointer never moves focus, scope trap and restore |
| R13-8 | Layout/text work creeps into a general CSS engine | High over time | Months of scope, unpredictable performance | The subset in §5.3 is closed; new layout features are additive and require a game need; no selectors, transitions, filters or blur |
| R13-9 | Per-frame allocations or DOM writes cause GC and layout hitches on TV | High over time | Frame spikes, dropped input | Pooled nodes/runs/quads, dirty flags, 4 Hz mirror updates, allocation benchmark, review rule |
| R13-10 | A 4,000-node HUD blows the 24-draw-call target | Medium | Frame budget failure | Atlas-page sorting, batch merging, dev warning, screen splitting; the target is measured, not assumed |
| R13-11 | IME overlay misplaces text or leaks composition state | Medium | Text entry broken on some phones | Off-screen/hidden input with mirrored value, commit on Enter/blur, composition events, manual Android/iOS keyboard run |
| R13-12 | UI package leaks a renderer backend or SDK import into the engine graph | Medium | Boundary violation, bundle bloat | eslint D2/D3 rules, boundary test, `UiPainter` in runtime, no backend type in public signatures |
| R13-13 | The home's “depth” becomes an animation contest that violates DESIGN.md | Medium | Focus motion, motion-sickness, brand drift | Depth is static layers plus optional ambient drift; focus movement is instant; reduced-motion disables drift; ER-13-02 measures exactly that |
| R13-14 | Text scale 200% breaks fixed-height HUD layouts | Medium | Clipped score/labels | `height: content` for text containers, 200% reflow row, a11y audit refuses clipped fixed-height text, scroll containers for long lists |
| R13-15 | UI work lands before the assets/font pipeline and blocks on placeholders | Medium | Wave slips | Fake `FontHandle` and fixture atlases unblock layout/focus; real fonts are a later integration; no runtime font generation |
