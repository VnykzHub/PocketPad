// Generates the single positional engine loop used by the bake-off car.
// 22050 Hz, 16-bit mono, 1.0 s. Every partial completes an integer number of
// cycles in the loop, so the WAV is seamless when looped. Generated in-repo:
// CC0, no third-party sample (see LICENSES.csv in ../assets).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 22050;
const SECONDS = 1;
const SAMPLE_COUNT = SAMPLE_RATE * SECONDS;
const DATA_BYTES = SAMPLE_COUNT * 2;

const data = Buffer.alloc(DATA_BYTES);
for (let i = 0; i < SAMPLE_COUNT; i++) {
    const t = i / SAMPLE_RATE;
    const tone =
        Math.sin(2 * Math.PI * 55 * t) * 0.5 +
        Math.sin(2 * Math.PI * 110 * t) * 0.22 +
        Math.sin(2 * Math.PI * 165 * t) * 0.12 +
        Math.sin(2 * Math.PI * 220 * t) * 0.05;
    const amplitude = 0.65 + 0.35 * Math.sin(2 * Math.PI * 4 * t);
    const sample = Math.max(-1, Math.min(1, tone * amplitude * 0.55));
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
}

const wav = Buffer.alloc(44 + DATA_BYTES);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + DATA_BYTES, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);                    // PCM
wav.writeUInt16LE(1, 22);                    // mono
wav.writeUInt32LE(SAMPLE_RATE, 24);
wav.writeUInt32LE(SAMPLE_RATE * 2, 28);      // byte rate
wav.writeUInt16LE(2, 32);                    // block align
wav.writeUInt16LE(16, 34);                   // bits per sample
wav.write('data', 36);
wav.writeUInt32LE(DATA_BYTES, 40);
data.copy(wav, 44);

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'audio', 'engine.wav');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, wav);
console.log(`wrote ${out} (${wav.length} bytes)`);
