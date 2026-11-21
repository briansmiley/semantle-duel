// Local word2vec lookups, from the files scripts/build-vectors.js writes.
// Words stay on disk; only the sorted word list and row index live in memory.

import { open, readFile } from "node:fs/promises";

const DIM = 300, SIZE = DIM * 4;

/** @returns {Promise<{similarity(a:string, b:string): Promise<number|null>, randomWord(): string} | null>} null if the files aren't there */
export async function load(dir) {
  let words, rows, fh;
  try {
    [words, rows, fh] = await Promise.all([readFile(`${dir}/words.txt`), readFile(`${dir}/rows.u32`), open(`${dir}/vectors.f32`)]);
  } catch {
    return null;
  }
  const rowOf = new Uint32Array(rows.buffer, rows.byteOffset, rows.length / 4);
  const starts = new Uint32Array(rowOf.length + 1);
  for (let i = 0, n = 0; i < words.length; i++) if (words[i] === 10) starts[++n] = i + 1;

  const find = (word) => {
    const key = Buffer.from(word);
    let lo = 0, hi = rowOf.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = Buffer.compare(words.subarray(starts[mid], starts[mid + 1] - 1), key);
      if (c === 0) return rowOf[mid];
      c < 0 ? (lo = mid + 1) : (hi = mid - 1);
    }
    return -1;
  };

  const cache = new Map(); // secrets get reused for every guess
  const vector = async (word) => {
    if (cache.has(word)) return cache.get(word);
    const row = find(word);
    if (row < 0) return null;
    const b = Buffer.alloc(SIZE);
    await fh.read(b, 0, SIZE, row * SIZE);
    const v = new Float32Array(b.buffer, b.byteOffset, DIM);
    if (cache.size > 100) cache.clear();
    cache.set(word, v);
    return v;
  };

  // Words for a "new word" duel: common but not too common (the file keeps Google's order, most frequent
  // first; rows 1,000-15,000 give words like festival, satellite, wardrobe), 4-10 letters, and none of the
  // endings that make for plurals, adverbs, participles or comparatives. About 5,500 of them.
  let pool = null;
  const word = (i) => words.toString("utf8", starts[i], starts[i + 1] - 1);
  const randomWord = () => {
    pool ??= Array.from({ length: rowOf.length }, (_, i) => i).filter((i) => {
      if (rowOf[i] < 1000 || rowOf[i] >= 15000) return false;
      const w = word(i);
      return /^[a-z]{4,10}$/.test(w) && !/(ly|ing|ed|s|er|est)$/.test(w);
    });
    return word(pool[Math.floor(Math.random() * pool.length)]);
  };

  console.log(`vectors: ${rowOf.length} words`);
  return {
    randomWord,
    async similarity(a, b) {
      const [x, y] = await Promise.all([vector(a), vector(b)]);
      if (!x || !y) return null;
      let dot = 0;
      for (let k = 0; k < DIM; k++) dot += x[k] * y[k];
      return dot * 100;
    },
  };
}
