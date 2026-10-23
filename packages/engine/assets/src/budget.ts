/**
 * Budget ledgers (06 §5.5).
 *
 * Reservations are all-or-nothing: a request that would cross either ledger
 * fails before any fetch or decode, and nothing is partially charged. The
 * total/initial manifest budgets are enforced by `manifest.ts`, not here.
 */

import { assetError } from "./errors.js";

export interface BudgetCharge {
  readonly id: string;
  /** CPU decoded bytes; 0 for metadata values. */
  readonly decodedBytes: number;
  /** Planned texture GPU bytes; 0 for non-textures. */
  readonly textureGpuBytes: number;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Tracks live decoded and texture bytes. No allocation happens on a reserve
 * or release beyond the returned number.
 */
export class AssetBudgetLedger {
  readonly decodedBudgetBytes: number;
  readonly textureBudgetBytes: number;
  private decodedUsed = 0;
  private textureUsed = 0;

  constructor(decodedBudgetBytes: number, textureBudgetBytes: number) {
    if (!Number.isFinite(decodedBudgetBytes) || decodedBudgetBytes < 0) {
      throw assetError(
        "E_ASSET_FORMAT",
        `decodedBudgetBytes must be non-negative, got ${decodedBudgetBytes}`,
      );
    }
    if (!Number.isFinite(textureBudgetBytes) || textureBudgetBytes < 0) {
      throw assetError(
        "E_ASSET_FORMAT",
        `textureBudgetBytes must be non-negative, got ${textureBudgetBytes}`,
      );
    }
    this.decodedBudgetBytes = decodedBudgetBytes;
    this.textureBudgetBytes = textureBudgetBytes;
  }

  get decodedBytes(): number {
    return this.decodedUsed;
  }

  get textureBytes(): number {
    return this.textureUsed;
  }

  /**
   * Reserves both ledgers or throws `E_ASSET_BUDGET` with the requesting id
   * and the ledger that would overflow. Nothing changes on failure.
   */
  reserve(charge: BudgetCharge): void {
    const decoded = nonNegative(charge.decodedBytes);
    const texture = nonNegative(charge.textureGpuBytes);
    if (this.decodedUsed + decoded > this.decodedBudgetBytes) {
      throw assetError(
        "E_ASSET_BUDGET",
        `${charge.id}: decoded bytes ${this.decodedUsed} + ${decoded} exceed the ${this.decodedBudgetBytes}-byte budget`,
        charge.id,
      );
    }
    if (this.textureUsed + texture > this.textureBudgetBytes) {
      throw assetError(
        "E_ASSET_BUDGET",
        `${charge.id}: texture bytes ${this.textureUsed} + ${texture} exceed the ${this.textureBudgetBytes}-byte budget`,
        charge.id,
      );
    }
    this.decodedUsed += decoded;
    this.textureUsed += texture;
  }

  /** Returns both charges. Never goes below zero. */
  release(charge: BudgetCharge): void {
    this.decodedUsed = Math.max(
      0,
      this.decodedUsed - nonNegative(charge.decodedBytes),
    );
    this.textureUsed = Math.max(
      0,
      this.textureUsed - nonNegative(charge.textureGpuBytes),
    );
  }

  /** Drops every charge (dispose/releaseAll). */
  reset(): void {
    this.decodedUsed = 0;
    this.textureUsed = 0;
  }
}

/** Metadata source bytes are reported, never charged (06 §5.5). */
export class MetadataLedger {
  private used = 0;

  get bytes(): number {
    return this.used;
  }

  add(bytes: number): void {
    this.used += nonNegative(bytes);
  }

  remove(bytes: number): void {
    this.used = Math.max(0, this.used - nonNegative(bytes));
  }

  reset(): void {
    this.used = 0;
  }
}
