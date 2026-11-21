// Semantle's own server, as its page uses it. The secret word stays on our side.

const BASE = "https://server.semantle.com";
const HEADERS = { "User-Agent": "semantle-duel/0.1" };
const EPOCH = Date.UTC(2022, 0, 29); // puzzle #1
const DAY = 86_400_000;

// The daily puzzle turns over at 8pm New York time.
export function todaysNumber(now = new Date()) {
  const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  if (ny.getHours() < 20) ny.setDate(ny.getDate() - 1);
  const day = Date.UTC(ny.getFullYear(), ny.getMonth(), ny.getDate());
  return Math.round((day - EPOCH) / DAY) + 1;
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`semantle ${res.status} for ${path}`);
  return res.json();
}

/** @returns {Promise<{number:number, secret:string, closest:number, tenth:number, thousandth:number}>} */
export async function fetchPuzzle(number) {
  const g = await get(`/semantle/game/${number}/en`);
  if (!g?.secretWord) throw new Error(`no puzzle #${number}`);
  return {
    number,
    secret: g.secretWord,
    closest: g.similarityClosest,
    tenth: g.similarityTenth,
    thousandth: g.similarityThousandth,
  };
}

/** @returns {Promise<{score:number, rank:number|null} | null>} null when the word isn't known */
export async function score(word, secret) {
  const s = await get(`/similarity/${encodeURIComponent(word)}/${encodeURIComponent(secret)}/en`);
  if (!s) return null;
  return { score: s.initialSimilarity, rank: s.percentile ?? null };
}

/** Semantle's 999 nearest words to the secret: [{word, rank (999 = closest), score}]. */
export async function neighbours(secret) {
  const t = await get(`/semantle/top1000/${encodeURIComponent(secret)}/en`);
  if (!t?.data?.length) throw new Error(`no top1000 for ${secret}`);
  return t.data.map((d) => ({ word: d.neighbor, rank: d.percentile, score: Math.round(d.similarity * 10000) / 100 }));
}

/** Semantle's own hint for someone whose best rank so far is `best` (0: not in the top 1000): a word, or null. */
export async function hint(secret, best) {
  const h = await get(`/semantle/hint/${encodeURIComponent(secret)}/${best}/en`);
  return h?.success && h.hintWord ? String(h.hintWord) : null;
}

/** The same, as word -> rank. */
export async function nearest(secret) {
  return new Map((await neighbours(secret)).map((n) => [n.word, n.rank]));
}
