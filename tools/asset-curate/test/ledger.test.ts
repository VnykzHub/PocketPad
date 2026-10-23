import { describe, expect, test } from "vitest";
import {
  LEDGER_COLUMNS,
  formatLedger,
  gamesFromRow,
  ledgerKeysFromCsv,
  parseLedger,
  validateLedger,
  type LedgerRow,
} from "../src/ledger.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    file: "models/props/bench.glb",
    id: "prop.bench",
    kind: "mesh",
    group: "props",
    bytes: 1024,
    sha256: HASH_A,
    parent: "",
    source_pack: "kenney_retro-urban-kit",
    source_path: "kenney_retro-urban-kit/Models/GLB format/detail-bench.glb",
    source_bytes: 2048,
    source_sha256: HASH_B,
    author: "Kenney",
    licence: "CC0 1.0",
    licence_url: "https://creativecommons.org/publicdomain/zero/1.0/",
    licence_file: "kenney_retro-urban-kit/License.txt",
    source_url: "https://kenney.nl/assets/retro-urban-kit",
    accessed: "2026-10-23",
    attribution: "None required.",
    games: "heist-planner;open-world-showcase",
    derivation: "",
    notes: "",
    ...overrides,
  };
}

describe("LICENSES.csv ledger", () => {
  test("[ER-23-01] ledger round-trips commas, quotes and newlines", () => {
    const original = row({
      file: "audio/ui/click.ogg",
      id: "sfx.ui.click",
      kind: "audio",
      group: "ui",
      notes: 'from "interface", click\ntrimmed at 20 ms',
    });

    const text = formatLedger([original]);
    const parsed = parseLedger(text);

    expect(parsed.header).toEqual([...LEDGER_COLUMNS]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.["notes"]).toBe(original.notes);
    expect(parsed.rows[0]?.["file"]).toBe(original.file);
    expect(validateLedger(parsed)).toEqual([]);
    expect(ledgerKeysFromCsv(text)).toEqual(new Set([original.file]));
  });

  test("[ER-23-01] ledger reports every missing licence, bad byte count and unknown game", () => {
    const rows = [
      row({ file: "a.glb", id: "prop.a" }),
      row({ file: "b.glb", id: "prop.b", licence: "" }),
      row({ file: "c.glb", id: "prop.c", bytes: 0 }),
      row({ file: "d.glb", id: "prop.d", source_bytes: -1 }),
      row({ file: "e.glb", id: "prop.e", sha256: "not-a-hash" }),
      row({ file: "f.glb", id: "prop.f", source_sha256: HASH_A.toUpperCase() }),
      row({ file: "g.glb", id: "prop.g", games: "" }),
      row({ file: "h.glb", id: "prop.h", games: "steering-wheel-racer;not-a-game" }),
      row({ file: "i.glb", id: "prop.i", accessed: "23/10/2026" }),
      row({ file: "j.glb", id: "prop.j", source_url: "http://kenney.nl/assets/car-kit" }),
      row({ file: "k.glb", id: "prop.k", licence_url: "http://example.com/cc0" }),
      row({ id: "prop.l", file: "../escape.glb" }),
    ];

    const errors = validateLedger(parseLedger(formatLedger(rows)));

    expect(errors).toContain("b.glb: licence must be CC0 1.0 for this curated set");
    expect(errors).toContain("c.glb: bytes must be a positive integer");
    expect(errors).toContain("d.glb: source_bytes must be a positive integer");
    expect(errors).toContain("e.glb: sha256 must be 64 lowercase hex chars");
    expect(errors).toContain("f.glb: source_sha256 must be 64 lowercase hex chars");
    expect(errors).toContain("g.glb: at least one game is required");
    expect(errors).toContain('h.glb: unknown game "not-a-game"');
    expect(errors).toContain("i.glb: accessed must be YYYY-MM-DD");
    expect(errors).toContain("j.glb: source_url must be https");
    expect(errors).toContain("k.glb: licence_url must be https");
    expect(errors).toContain("../escape.glb: file must be a safe assets-relative path");
  });

  test("[ER-23-01] ledger requires one row per curated file in both directions", () => {
    const parsed = parseLedger(formatLedger([row({ file: "a.glb", id: "prop.a" })]));

    expect(validateLedger(parsed, { knownFiles: new Set(["a.glb", "Textures/b.png"]) })).toContain(
      "Textures/b.png: curated file has no ledger row",
    );
    expect(validateLedger(parsed, { knownFiles: new Set(["other.glb"]) })).toContain(
      "a.glb: row does not match a curated file",
    );
  });

  test("[ER-23-01] ledger rejects duplicate rows, duplicate ids and dangling parents", () => {
    const parsed = parseLedger(
      formatLedger([
        row({ file: "a.glb", id: "prop.same" }),
        row({ file: "a.glb", id: "prop.other" }),
        row({ file: "b.glb", id: "prop.same" }),
        row({ file: "c.glb", id: "prop.child", kind: "texture", parent: "missing.parent" }),
      ]),
    );

    const errors = validateLedger(parsed);
    expect(errors).toContain("a.glb: duplicate file row");
    expect(errors).toContain('b.glb: duplicate id "prop.same"');
    expect(errors).toContain('c.glb: parent "missing.parent" is not a ledger id');
  });

  test("[ER-23-01] gamesFromRow keeps only known game ids", () => {
    expect(gamesFromRow(row({ games: "sumo-bumpers;not-a-game;beat-tap" }))).toEqual([
      "sumo-bumpers",
      "beat-tap",
    ]);
  });
});
