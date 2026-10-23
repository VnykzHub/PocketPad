/**
 * Shared slot rules (internal module, not re-exported from the package).
 *
 * The platform supports slots 1..8 (SPEC §5). Every public kit surface that
 * takes a slot validates through here so the range and error text stay in one
 * place.
 */

export const MIN_SLOT = 1;
export const MAX_SLOT = 8;
export const DEFAULT_COUNTDOWN_MS = 3000;
export const DEFAULT_ROUNDS_TO_WIN = 3;

/** True for an integer slot in 1..8. */
export function isSlot(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_SLOT &&
    value <= MAX_SLOT
  );
}

/** Throws RangeError unless `value` is a slot; names the offending field. */
export function requireSlot(value: number, name = "slot"): void {
  if (!isSlot(value)) {
    throw new RangeError(`${name} must be an integer in ${MIN_SLOT}..${MAX_SLOT}.`);
  }
}

/** Throws RangeError unless `value` is finite. */
export function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number.`);
  }
}
