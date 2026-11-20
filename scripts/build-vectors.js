// Turn Google's GoogleNews-vectors-negative300.bin.gz (the vectors Semantle uses)
// into the files src/vectors.js reads, keeping only lowercase words that our
// duels accept (no phrases, capitals or digits).
//
//   node scripts/build-vectors.js GoogleNews-vectors-negative300.bin.gz out/
//
// Writes out/words.txt (sorted, one per line), out/rows.u32 (row of each sorted
// word) and out/vectors.f32 (unit-length rows, 300 float32s each).
// Streams, so it runs in a few hundred MB of RAM.

import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { once } from "node:events";

const [src, out] = process.argv.slice(2);
if (!src || !out) throw new Error("usage: build-vectors.js <bin.gz> <outdir>");
mkdirSync(out, { recursive: true });

const KEEP = /^[a-z][a-z'-]*$/; // same shape Duel.refusal allows
const vecOut = createWriteStream(`${out}/vectors.f32`);
const kept = []; // [word, row]
let buf = Buffer.alloc(0), dim = 0, total = 0, seen = 0;

async function write(b) {
  if (!vecOut.write(b)) await once(vecOut, "drain");
}

for await (const chunk of createReadStream(src).pipe(createGunzip())) {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  let i = 0;
  if (!dim) {
    const nl = buf.indexOf(10);
    [total, dim] = buf.subarray(0, nl).toString().trim().split(" ").map(Number);
    i = nl + 1;
  }
  const size = dim * 4;
  for (;;) {
    while (i < buf.length && buf[i] === 10) i++; // some writers put \n between rows
    const sp = buf.indexOf(32, i);
    if (sp < 0 || sp + 1 + size > buf.length) break;
    const word = buf.toString("utf8", i, sp);
    const v = buf.subarray(sp + 1, sp + 1 + size);
    i = sp + 1 + size;
    seen++;
    if (!KEEP.test(word)) continue;
    const f = new Float32Array(dim);
    let norm = 0;
    for (let k = 0; k < dim; k++) norm += (f[k] = v.readFloatLE(k * 4)) ** 2;
    norm = Math.sqrt(norm);
    for (let k = 0; k < dim; k++) f[k] /= norm;
    kept.push([word, kept.length]);
    await write(Buffer.from(f.buffer));
  }
  buf = buf.subarray(i);
  if (seen % 200_000 < 2000) process.stdout.write(`\r${seen}/${total} read, ${kept.length} kept`);
}
vecOut.end();
await once(vecOut, "finish");

kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
writeFileSync(`${out}/words.txt`, kept.map((k) => k[0]).join("\n") + "\n");
writeFileSync(`${out}/rows.u32`, Buffer.from(Uint32Array.from(kept, (k) => k[1]).buffer));
console.log(`\n${seen} read, ${kept.length} kept, dim ${dim}`);
