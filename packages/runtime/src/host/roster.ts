/**
 * HP-08 roster, raw input table and stage-bar counters.
 *
 * The roster is the visible player list; the raw D0 table is debug only and
 * lives in its own container inside the roster section. This module owns the
 * per-slot presence state and the single place that mirrors it into the stage
 * bar, the launcher card counts and the roster rows.
 */
import type { InputState } from "@lanpad/protocol";
import { InputTable } from "../debug/inputTable.js";
import { SlotRoster, type SlotRosterEntry, type SlotRosterState } from "../ui/SlotRoster.js";
import type { ConsolePlayerInput } from "../ui/console/types.js";
import { playerCountLabel } from "./routes.js";

const SLOT_COUNT = 8;
const EMPTY_ROOM_CODE = "----";

export interface RosterDeps {
  readonly doc: Document;
  readonly slotsEl: HTMLElement;
  readonly stageRoomEl: HTMLElement;
  readonly stagePlayersEl: HTMLElement;
  readonly debug: boolean;
  readonly getRoomCode: () => string | null;
  /** Updates the connected count on launcher cards when the shelf is up. */
  readonly onCountsChanged: () => void;
}

export interface HostRoster {
  connectedCount(): number;
  /** Occupied slots as console-lobby inputs; identity is left to the shell. */
  playerInputs(): ReadonlyArray<ConsolePlayerInput>;
  resetSlots(): void;
  markAllPlayersLeft(): void;
  updateStageBar(): void;
  renderTable(): void;
  setPlayerJoined(slot: number, state: SlotRosterState): void;
  setPlayerLeft(slot: number, state: SlotRosterState): void;
  setPlayerSuspended(slot: number, state: SlotRosterState): void;
  setPlayerResumed(slot: number, state: SlotRosterState): void;
  setInput(slot: number, state: InputState, receivedAt: number): void;
}

export function createRoster(deps: RosterDeps): HostRoster {
  // HP-08: the roster is the visible player list; the raw D0 table is debug
  // only and lives in its own container inside the roster section.
  const roster = new SlotRoster(deps.doc);
  roster.mount(deps.slotsEl);
  const debugTableMount = deps.doc.createElement("div");
  debugTableMount.className = "roster__debug";
  const table = new InputTable(debugTableMount, { showTick: deps.debug });
  if (deps.debug) {
    // Fixed to the viewport: the roster is hidden during play, and the raw
    // input table is exactly what a "no response" report needs to see.
    debugTableMount.classList.add("debug-input");
    deps.doc.body.append(debugTableMount);
  }

  /** HP-08 presence per slot, fed by the broker's player events. */
  const slotStates: SlotRosterState[] = [];
  for (let slot = 0; slot <= SLOT_COUNT; slot += 1) slotStates.push("open");

  function connectedCount(): number {
    let count = 0;
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      if (slotStates[slot] === "connected") count += 1;
    }
    return count;
  }

  function entries(): SlotRosterEntry[] {
    const result: SlotRosterEntry[] = [];
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      result.push({ slot, state: slotStates[slot] ?? "open" });
    }
    return result;
  }

  /**
   * Open slots are omitted: the console lobby renders its own eight rows and
   * fills labels/colours, so only real presence crosses the boundary.
   */
  function playerInputs(): ReadonlyArray<ConsolePlayerInput> {
    const result: ConsolePlayerInput[] = [];
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      const state = slotStates[slot] ?? "open";
      if (state === "open") continue;
      result.push({ slot, state });
    }
    return result;
  }

  function updateStageBar(): void {
    deps.stageRoomEl.textContent = deps.getRoomCode() ?? EMPTY_ROOM_CODE;
    deps.stagePlayersEl.textContent = playerCountLabel(connectedCount());
  }

  function refresh(): void {
    roster.update(entries());
    updateStageBar();
    deps.onCountsChanged();
  }

  function setSlotState(slot: number, state: SlotRosterState): void {
    if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) return;
    slotStates[slot] = state;
    refresh();
  }

  function resetSlots(): void {
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      slotStates[slot] = "open";
    }
    refresh();
  }

  function renderTable(): void {
    table.render(performance.now());
  }

  function setPlayerJoined(slot: number, state: SlotRosterState): void {
    table.setPlayerJoined(slot);
    setSlotState(slot, state);
    renderTable();
  }

  function setPlayerLeft(slot: number, state: SlotRosterState): void {
    table.setPlayerLeft(slot);
    setSlotState(slot, state);
    renderTable();
  }

  function setPlayerSuspended(slot: number, state: SlotRosterState): void {
    setSlotState(slot, state);
    renderTable();
  }

  function setPlayerResumed(slot: number, state: SlotRosterState): void {
    table.setPlayerJoined(slot);
    setSlotState(slot, state);
    renderTable();
  }

  function setInput(slot: number, state: InputState, receivedAt: number): void {
    table.setInput(slot, state, receivedAt);
    renderTable();
  }

  /** Clears the raw table rows only; the caller decides when to reset slots. */
  function markAllPlayersLeft(): void {
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      table.setPlayerLeft(slot);
    }
  }

  return {
    connectedCount,
    playerInputs,
    resetSlots,
    markAllPlayersLeft,
    updateStageBar,
    renderTable,
    setPlayerJoined,
    setPlayerLeft,
    setPlayerSuspended,
    setPlayerResumed,
    setInput,
  };
}
