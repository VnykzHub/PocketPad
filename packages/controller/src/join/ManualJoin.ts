/**
 * Manual code + PIN join helpers (D4-CTRL-01, FR-5.6, SR-4).
 *
 * Manual entry is the no-camera path: a 4-character Crockford room code and
 * the 4-digit PIN shown on the TV. Validation here is a UX convenience only;
 * the server remains authoritative. Nothing in this module touches the DOM or
 * the network, so the form can be rendered by the page shell and tested as a
 * pure projection.
 */
import { ROOM_PIN_LENGTH } from "@lanpad/protocol";
import { normalizeRoomCode } from "../route.js";

const PIN_PATTERN = new RegExp(`^\\d{${ROOM_PIN_LENGTH}}$`);

/** Inline messages for client-side validation. */
export const MANUAL_JOIN_MESSAGES = {
  code: "Enter the 4-character code shown on the TV.",
  pin: `Enter the ${ROOM_PIN_LENGTH}-digit PIN shown on the TV.`,
} as const;

export interface ManualJoinInput {
  code: string;
  pin: string;
}

/** Field-level errors; absent fields are valid. */
export interface ManualJoinErrors {
  code?: string;
  pin?: string;
}

export type ManualJoinValidation =
  | { ok: true; code: string; pin: string }
  | { ok: false; code: string | null; pin: string; errors: ManualJoinErrors };

/** Trims and validates a PIN without ever logging it. */
export function normalizePin(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const pin = value.trim();
  return PIN_PATTERN.test(pin) ? pin : null;
}

/**
 * Normalizes a manual entry. Both fields are checked so the form can show
 * both errors at once; no state is mutated and nothing is sent.
 */
export function validateManualJoin(input: ManualJoinInput): ManualJoinValidation {
  const code = normalizeRoomCode(input.code);
  const pin = normalizePin(input.pin);
  const errors: ManualJoinErrors = {};
  if (code === null) {
    errors.code = MANUAL_JOIN_MESSAGES.code;
  }
  if (pin === null) {
    errors.pin = MANUAL_JOIN_MESSAGES.pin;
  }
  if (code !== null && pin !== null) {
    return { ok: true, code, pin };
  }
  return { ok: false, code, pin: input.pin.trim(), errors };
}

export interface ManualJoinViewInput {
  code: string;
  pin: string;
  errors?: ManualJoinErrors;
  notice?: string | null;
  /** Remaining lockout in ms; a positive value disables submit. */
  retryAfterMs?: number | null;
}

/** What the page shell renders: field errors, a form-level notice and button state. */
export interface ManualJoinView {
  code: string;
  pin: string;
  codeError: string | null;
  pinError: string | null;
  notice: string | null;
  canSubmit: boolean;
  submitLabel: string;
}

export function manualJoinView(input: ManualJoinViewInput): ManualJoinView {
  const retryAfterMs = input.retryAfterMs ?? 0;
  const canSubmit = retryAfterMs <= 0;
  const seconds = Math.max(0, Math.ceil(retryAfterMs / 1000));
  return {
    code: input.code,
    pin: input.pin,
    codeError: input.errors?.code ?? null,
    pinError: input.errors?.pin ?? null,
    notice: input.notice ?? null,
    canSubmit,
    submitLabel: canSubmit ? "Join" : `Try again in ${seconds}s`,
  };
}
