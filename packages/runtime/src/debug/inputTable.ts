/**
 * Live input debug table (D0-RT-01).
 *
 * The D0 host page has no renderer yet, so the slot table is the visible
 * output. It is a debug view, not game UI: eight fixed rows updated in place
 * with `textContent` only (NR-6.2, no virtual DOM).
 *
 * D3 mounts the runtime into `#game-root` and keeps this table behind
 * `?debug=1`; D4 replaces the "Joined/Live" status with session rejoin state.
 */
import { MAX_CONTROLLERS, type InputState } from "@lanpad/protocol";

/** Mutable per-slot state held by the table. Values are wire values, not UI strings. */
export interface SlotSnapshot {
  readonly slot: number;
  joined: boolean;
  buttons: number;
  edges: number;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  lt: number;
  rt: number;
  tick: number;
  /** `performance.now()` when the last InputFwd arrived, or null before any input. */
  receivedAt: number | null;
}

/** Formatted cells for one row; the renderer writes these verbatim. */
export interface SlotCells {
  slot: string;
  status: string;
  buttons: string;
  edges: string;
  left: string;
  right: string;
  triggers: string;
  age: string;
  tick: string;
}

const COLUMNS = [
  "Slot",
  "Status",
  "Buttons",
  "Edges",
  "Left L3",
  "Right R3",
  "Triggers L2/R2",
  "Age",
  "Tick",
] as const;

const CELL_KEYS = [
  "slot",
  "status",
  "buttons",
  "edges",
  "left",
  "right",
  "triggers",
  "age",
  "tick",
] as const;

const EMPTY_TEXT = "—";

export function createSlotSnapshot(slot: number): SlotSnapshot {
  return {
    slot,
    joined: false,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    lt: 0,
    rt: 0,
    tick: 0,
    receivedAt: null,
  };
}

/** Four-digit uppercase hex for a 16-bit level/edge bitfield (FR-7.2). */
export function formatBits(value: number): string {
  return `0x${(value & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Pure row formatter. `nowMs` uses the same clock as `SlotSnapshot.receivedAt`
 * so the age column can be refreshed without new packets.
 */
export function formatSlotCells(snapshot: SlotSnapshot, nowMs: number): SlotCells {
  const receivedAt = snapshot.receivedAt;
  const hasInput = receivedAt !== null;
  const status = snapshot.joined ? (hasInput ? "Live" : "Joined") : EMPTY_TEXT;

  return {
    slot: `P${snapshot.slot}`,
    status,
    buttons: formatBits(snapshot.buttons),
    edges: formatBits(snapshot.edges),
    left: `${snapshot.lx}, ${snapshot.ly}`,
    right: `${snapshot.rx}, ${snapshot.ry}`,
    triggers: `${snapshot.lt} / ${snapshot.rt}`,
    age:
      receivedAt === null
        ? EMPTY_TEXT
        : `${Math.max(0, Math.round(nowMs - receivedAt))} ms`,
    tick: hasInput ? `${snapshot.tick}` : EMPTY_TEXT,
  };
}

export interface InputTableOptions {
  /** `?debug=1` reveals the raw `tick` (server-time ms) column (A3). */
  showTick?: boolean;
}

/**
 * Fixed-size slot table. Rows are created once; updates only assign cell
 * text. Slots outside 1..8 are ignored rather than growing the table.
 */
export class InputTable {
  private readonly snapshots: SlotSnapshot[] = [];
  private readonly rows: HTMLTableCellElement[][] = [];
  private readonly table: HTMLTableElement;

  constructor(root: HTMLElement, options: InputTableOptions = {}) {
    const documentRef = root.ownerDocument;

    this.table = documentRef.createElement("table");
    this.table.className = "input-table";
    if (options.showTick === true) {
      this.table.classList.add("show-tick");
    }

    const head = documentRef.createElement("thead");
    const headRow = documentRef.createElement("tr");
    for (let index = 0; index < COLUMNS.length; index += 1) {
      const heading = documentRef.createElement("th");
      heading.textContent = COLUMNS[index] ?? "";
      if (CELL_KEYS[index] === "tick") {
        heading.className = "tick";
      }
      headRow.appendChild(heading);
    }
    head.appendChild(headRow);
    this.table.appendChild(head);

    const body = documentRef.createElement("tbody");
    for (let slot = 1; slot <= MAX_CONTROLLERS; slot += 1) {
      const row = documentRef.createElement("tr");
      const cells: HTMLTableCellElement[] = [];
      for (let index = 0; index < CELL_KEYS.length; index += 1) {
        const cell = documentRef.createElement("td");
        if (CELL_KEYS[index] === "tick") {
          cell.className = "tick";
        }
        row.appendChild(cell);
        cells.push(cell);
      }
      body.appendChild(row);
      this.rows.push(cells);
      this.snapshots.push(createSlotSnapshot(slot));
    }
    this.table.appendChild(body);

    root.textContent = "";
    root.appendChild(this.table);
    this.render(0);
  }

  setPlayerJoined(slot: number): void {
    const snapshot = this.snapshotFor(slot);
    if (snapshot !== null) {
      snapshot.joined = true;
    }
  }

  setPlayerLeft(slot: number): void {
    const snapshot = this.snapshotFor(slot);
    if (snapshot !== null) {
      Object.assign(snapshot, createSlotSnapshot(slot));
    }
  }

  setInput(slot: number, state: InputState, receivedAt: number): void {
    const snapshot = this.snapshotFor(slot);
    if (snapshot === null) {
      return;
    }
    snapshot.joined = true;
    snapshot.buttons = state.buttons;
    snapshot.edges = state.edges;
    snapshot.lx = state.lx;
    snapshot.ly = state.ly;
    snapshot.rx = state.rx;
    snapshot.ry = state.ry;
    snapshot.lt = state.lt;
    snapshot.rt = state.rt;
    snapshot.tick = state.tick;
    snapshot.receivedAt = receivedAt;
  }

  /** Rewrites changed cells in place. Called per packet and on a slow timer. */
  render(nowMs: number): void {
    for (let slotIndex = 0; slotIndex < this.snapshots.length; slotIndex += 1) {
      const snapshot = this.snapshots[slotIndex];
      const cells = this.rows[slotIndex];
      if (snapshot === undefined || cells === undefined) {
        continue;
      }
      const view = formatSlotCells(snapshot, nowMs);
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
        const key = CELL_KEYS[cellIndex];
        const cell = cells[cellIndex];
        if (key === undefined || cell === undefined) {
          continue;
        }
        const text = view[key];
        if (cell.textContent !== text) {
          cell.textContent = text;
        }
      }
    }
  }

  private snapshotFor(slot: number): SlotSnapshot | null {
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_CONTROLLERS) {
      return null;
    }
    return this.snapshots[slot - 1] ?? null;
  }
}
