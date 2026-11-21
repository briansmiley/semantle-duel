// Build src/words.json: the words a "random word" duel draws from.
//
//   node --env-file=.env scripts/build-words.js [vectorsDir] [cacheDir]
//
// 1. Every Semantle archive answer (#1 to today), fetched once: hand-picked, the backbone.
// 2. Candidates from the vectors (common-ish words: rows 1,000-20,000 of Google's most-frequent-first
//    order), filtered by Claude Haiku for words that make fair, fun secret words.
// Each step caches to cacheDir, so a rerun only does what's missing. Needs ANTHROPIC_API_KEY for step 2.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import * as semantle from "../src/semantle.js";

const [vectorsDir = "data/vectors", cacheDir = "data/words-cache"] = process.argv.slice(2);
const OUT = new URL("../src/words.json", import.meta.url);
await mkdir(cacheDir, { recursive: true });

const cached = async (name, make) => {
  const file = `${cacheDir}/${name}.json`;
  try { return JSON.parse(await readFile(file, "utf8")); } catch {}
  const value = await make();
  await writeFile(file, JSON.stringify(value));
  return value;
};

/** Run `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---- 1. the archive
const today = semantle.todaysNumber();
const archive = await cached(`archive-${today}`, async () => {
  const numbers = Array.from({ length: today }, (_, i) => i + 1);
  const got = {};
  await pool(numbers, 3, async (n) => {
    for (let tries = 0; tries < 3; tries++) {
      try { const p = await semantle.fetchPuzzle(n); got[p.secret] = n; return; }
      catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    console.warn(`archive: no #${n}`);
  });
  return got;
});
console.log(`archive: ${Object.keys(archive).length} answers`);

// ---- 2. candidates from the vectors, filtered by Haiku
const words = (await readFile(`${vectorsDir}/words.txt`, "utf8")).split("\n");
const rowsBuf = await readFile(`${vectorsDir}/rows.u32`);
const rows = new Uint32Array(rowsBuf.buffer, rowsBuf.byteOffset, rowsBuf.length / 4);
// An inflected form (plural, past, -ing, -ly adverb) of a word that's also in the vocabulary: not a candidate.
const vocab = new Set(words);
const has = (w) => w.length >= 3 && vocab.has(w);
const inflected = (w) => {
  const stems = [];
  if (w.endsWith("ies")) stems.push(w.slice(0, -3) + "y");
  if (w.endsWith("es")) stems.push(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) stems.push(w.slice(0, -1));
  for (const end of ["ed", "ing"]) if (w.endsWith(end)) {
    const b = w.slice(0, -end.length);
    stems.push(b, b + "e");
    if (b.length > 2 && b.at(-1) === b.at(-2)) stems.push(b.slice(0, -1));  // stopped -> stop
    if (b.endsWith("i")) stems.push(b.slice(0, -1) + "y");                  // tried -> try
  }
  if (w.endsWith("ly")) stems.push(w.slice(0, -2), w.slice(0, -2) + "e", w.slice(0, -3) + "y");
  return stems.some(has);
};
const candidates = words
  .map((w, i) => [w, rows[i]])
  .filter(([w, r]) => r >= 1000 && r < 20000 && /^[a-z]{4,12}$/.test(w) && !(w in archive) && !inflected(w))
  .sort((a, b) => a[1] - b[1])
  .map(([w]) => w);
console.log(`candidates: ${candidates.length}`);

const client = new Anthropic();
const SCHEMA = {
  type: "object",
  properties: { keep: { type: "array", items: { type: "string" } } },
  required: ["keep"],
  additionalProperties: false,
};
const PROMPT = `You're choosing secret words for a Semantle-style game: players try to find a hidden English word by guessing words and seeing how semantically close each guess is. A good secret word is one any adult knows, with a clear, concrete-ish meaning and plenty of related words to work towards it from: umbrella, salad, folklore, rocket, nursery, flame, agony.

From the list below, return only the words that clearly make fair, fun secret words. Be selective: when in doubt, leave it out. Mostly nouns; common verbs and adjectives are fine too, in their base form.

Leave out:
- plurals and inflected forms (cats, humans, whistled, stumbles, tossing, faster, duties), unless the word is itself a common base word (building, news)
- dry, abstract or bureaucratic words (purview, impartiality, signifies, allotted, outlining, environments)
- misspellings, and British spellings when the American one is the usual form
- names of people, places, companies, brands, teams or products
- abbreviations, acronyms, slang and internet words
- anything offensive, sexual or a slur
- function words and fillers (however, therefore, also, would)
- obscure, technical, jargon or archaic words that a typical adult wouldn't know

Return the words you keep exactly as written.

Words:
`;
const batches = [];
for (let i = 0; i < candidates.length; i += 250) batches.push(candidates.slice(i, i + 250));
const kept = (await pool(batches, 4, (batch, i) => cached(`haiku2-${i}-${batch.length}-${batch[0]}`, async () => {
  for (let tries = 0; tries < 3; tries++) {
    try {
      const res = await client.messages.parse({
        model: "claude-haiku-5-5",
        max_tokens: 16000,
        output_config: { effort: "medium", format: jsonSchemaOutputFormat(SCHEMA) },
        messages: [{ role: "user", content: PROMPT + batch.join("\n") }],
      });
      if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error(`no output (${res.stop_reason})`);
      const asked = new Set(batch);
      return res.parsed_output.keep.filter((w) => asked.has(w));  // only words we sent
    } catch (e) {
      if (e instanceof Anthropic.APIError && e.status && e.status < 500 && e.status !== 429) throw e;
      console.warn(`batch ${i}: ${e.message}; retrying`);
    }
  }
  throw new Error(`batch ${i} failed`);
}))).flat();
console.log(`haiku kept: ${kept.length} of ${candidates.length}`);

// ---- out
const extra = [...new Set(kept)].sort();
await writeFile(OUT, JSON.stringify({ built: new Date().toISOString().slice(0, 10), archive, extra }) + "\n");
console.log(`wrote src/words.json: ${Object.keys(archive).length} archive + ${extra.length} extra`);
