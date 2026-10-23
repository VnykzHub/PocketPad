// Cold-boot size accounting: every byte under dist/ counts, because the host
// must fetch all of it to boot. Raw and gzip totals are both reported; the
// 5 MiB budget is compared against the gzip total (repo budget semantics).

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');
const BUDGET_GZIP = 5 * 1024 * 1024;

async function walk(dir, prefix = '') {
  const rows = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const published = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      rows.push(...(await walk(path, published)));
    } else {
      const data = await readFile(path);
      rows.push({
        path: published,
        raw: (await stat(path)).size,
        gzip: gzipSync(data, { level: 9 }).length,
      });
    }
  }
  return rows;
}

const rows = (await walk(dist)).sort((a, b) => b.gzip - a.gzip);
const rawTotal = rows.reduce((sum, row) => sum + row.raw, 0);
const gzipTotal = rows.reduce((sum, row) => sum + row.gzip, 0);
const format = (bytes) => `${bytes.toLocaleString('en-US')} B (${(bytes / 1024).toFixed(1)} KiB)`;

console.log('file                                   raw            gzip');
for (const row of rows) {
  console.log(
    `${row.path.padEnd(38)} ${String(row.raw).padStart(10)} ${String(row.gzip).padStart(10)}`,
  );
}
console.log('-'.repeat(62));
console.log(`raw total:  ${format(rawTotal)}`);
console.log(`gzip total: ${format(gzipTotal)}`);
console.log(`budget:     5,242,880 B (5 MiB gzip) — ${gzipTotal <= BUDGET_GZIP ? 'PASS' : 'FAIL'}`);
console.log(`dist files: ${rows.length}`);
