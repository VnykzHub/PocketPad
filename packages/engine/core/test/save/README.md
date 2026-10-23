# Save fixture — v1 header

Synthetic golden fixture for the frozen v1 `.pps` header (00 §4.5, 15 §4.9).
It is the byte-level reference W1's header codec must reproduce.

**Synthetic.** `harbor-run`, `1.2.0` and the payload text are invented. There
is no player name, token, room code, PIN, IP address, device id or production
save data in any file here.

## Files

| File | Role |
|---|---|
| `header-v1.hex` | Source of truth: 85 bytes, two hex digits per byte, `#` comments ignored. |
| `header-v1.json` | Decoded fields, the FNV-1a value and the optional SHA-256 slot metadata. |
| `header-v1.bin` | Generated from `header-v1.hex`; exactly 85 bytes; verified below. |

## Byte order and layout

Every multi-byte integer is **little-endian**, read/written with `DataView`.
The 85 bytes are exactly:

```
offset  size  field
     0     4  magic "PPSV" (50 50 53 56)
     4     2  formatVersion = 1
     6     2  headerBytes = 56
     8     4  payloadBytes = 29
    12     4  payloadHash = 0x635F8BC4 (FNV-1a 32 of the stored payload)
    16     2  engineMajor = 0
    18     2  engineMinor = 1
    20     2  enginePatch = 0
    22     2  gameIdBytes = 10
    24     2  gameVersionBytes = 5
    26     2  flags = 0 (uncompressed)
    28     4  createdAtUnixSeconds = 1792627200  (u32 epoch seconds UTC)
    32     4  payloadUncompressedBytes = 0
    36     4  reserved = 0
    40    10  gameId "harbor-run" (UTF-8)
    50     5  gameVersion "1.2.0" (UTF-8)
    55     1  zero padding
    56    29  payload "demo-payload:seed=1;tick=3600" (ASCII)
```

The header is 56 bytes: the 40-byte prefix plus 10 + 5 UTF-8 bytes, padded
with one `0x00` to the next 8-byte boundary
(`headerBytes = align8(40 + 10 + 5) = 56`). There is no trailer:
`fileBytes = headerBytes + payloadBytes = 56 + 29 = 85`.

## Timestamps and hashes

- `createdAtUnixSeconds` is the **file** unit: an unsigned 32-bit count of
  seconds since `1970-01-01T00:00:00Z`. `1792627200` is
  `2026-10-22T00:00:00Z`. The API unit is epoch **milliseconds** UTC:
  `createdAtUnixMs = 1792627200000`. No ISO-8601 string is stored.
- `payloadHash` is **FNV-1a 32** over the stored payload (bytes 56..84):
  `0x635F8BC4` = decimal `1667206084`. It is a corruption check, not a
  security hash.
- `payloadSha256` is optional **slot metadata**, not a header field. For this
  payload: `b090e151095888be944ad76325de802ac690ab1967ab44ad4ee3e1a4c85c4895`.

### Spec transcription note

15 §4.9's decoded JSON prints `"payloadHash": 1667197892` and calls it the
decimal form of `0x635F8BC4`. That decimal is wrong by 8192: `0x635F8BC4` is
`1667206084`. The 85-byte hex dump, the FNV-1a definition in 00 §4.5 and the
generated binary all agree on `0x635F8BC4`, so `header-v1.json` records the
correct decimal together with the hex value.

## What W1 must do

W1's header codec must reproduce `header-v1.bin` **byte-for-byte**:
`encodeSaveHeader`/`encodeSaveFile` over the fields in `header-v1.json` and the
29-byte payload must yield these exact 85 bytes, and
`decodeSaveHeader`/`decodeSaveFile` must return the same fields and re-encode
identically. A fixture change implies a format change and an updated spec.

## Regenerating `header-v1.bin`

From the repo root, with Node >= 20:

```bash
node -e "const fs=require('node:fs');const d='packages/engine/core/test/save/fixtures/';const h=fs.readFileSync(d+'header-v1.hex','utf8').split('\n').map(l=>l.split('#')[0]).join(' ').match(/[0-9a-fA-F]{2}/g);fs.writeFileSync(d+'header-v1.bin',Uint8Array.from(h,p=>parseInt(p,16)));"
```

## Verifying the binary

```bash
node -e "const fs=require('node:fs');const b=fs.readFileSync('packages/engine/core/test/save/fixtures/header-v1.bin');let h=0x811c9dc5;for(const x of b.subarray(56)){h^=x;h=Math.imul(h,0x01000193)>>>0;}console.log(b.length,'0x'+h.toString(16).toUpperCase().padStart(8,'0'));"
```

Expected output: `85 0x635F8BC4`.

## Scope

The W1 M0 header codec is implemented in `src/save/header.ts` and
`src/save/file.ts`; the tests are `header.test.ts`, `file.test.ts` and
`header.property.test.ts` in this directory. The fixture is the byte-level
oracle: the encoder must reproduce it and the decoder must round-trip it.
Storage, compression, SHA-256 computation and migration are M1.
