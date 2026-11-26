import http from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Duel, DuelError, tally } from "./duel.js";
import * as semantle from "./semantle.js";
import * as vectors from "./vectors.js";
import { feedback } from "./feedback.js";

// What a "random word" duel draws from (scripts/build-words.js): Semantle's archive answers, word -> number,
// and our own extra words, filtered for fitness.
const WORDS = JSON.parse(await readFile(new URL("./words.json", import.meta.url), "utf8"));
const DRAW = [...Object.keys(WORDS.archive), ...WORDS.extra];

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";
const PAGE = new URL("../public/index.html", import.meta.url);
const DATA = process.env.DATA_DIR ?? new URL("../data", import.meta.url).pathname;
await mkdir(DATA, { recursive: true });

/** Live duels. Every duel is also on disk, so links outlive the process. */
/** @type {Map<string, {duel: Duel, listeners: Set<{player:string, res:http.ServerResponse}>, scores: Map<string, any>, voice: Map<string, {muted:boolean}>}>} */
const rooms = new Map();

const fileOf = (id) => `${DATA}/${id}.json`;
const receiveFeedback = feedback({ dir: `${DATA}/feedback` });

// One write at a time per duel: two guesses landing together used to race on
// the same .tmp file, and the loser's request failed after its guess counted.
const writing = new Map(); // id -> Promise

function save(duel) {
  const next = (writing.get(duel.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const tmp = `${fileOf(duel.id)}.tmp`;
    await writeFile(tmp, JSON.stringify(duel));
    await rename(tmp, fileOf(duel.id));
  });
  writing.set(duel.id, next);
  next.finally(() => writing.get(duel.id) === next && writing.delete(duel.id)).catch(() => {});
  return next;
}

async function loadRoom(id) {
  const room = await findRoom(id);
  const now = Date.now();
  // also catches up on what happened while nobody had it open (or the machine was asleep)
  if (room && (room.duel.expire(now) | room.duel.checkAway(now))) await save(room.duel);
  return room;
}

async function findRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  if (!/^[a-z0-9]{5}$/.test(id)) return null;
  let raw;
  try { raw = await readFile(fileOf(id), "utf8"); } catch { return null; }
  if (!rooms.has(id)) rooms.set(id, { duel: Duel.fromJSON(JSON.parse(raw)), listeners: new Set(), scores: new Map(), voice: new Map() });
  return rooms.get(id);
}
const puzzles = new Map(); // number -> puzzle, so a busy day costs one fetch

/** Semantle has neighbours for it (so it can be scored and hinted). */
async function knows(word) {
  try { return (await semantle.neighbours(word)).length > 0; } catch { return false; }
}

async function puzzle(number) {
  if (!puzzles.has(number)) puzzles.set(number, semantle.fetchPuzzle(number).catch((e) => (puzzles.delete(number), Promise.reject(e))));
  return puzzles.get(number);
}

// Score locally when we have the vectors and Semantle's top-1000 list for this
// secret; otherwise (or for a word we don't know) ask Semantle per guess.
const local = vectors.load(process.env.VECTORS_DIR ?? `${DATA}/vectors`);
const nearby = new Map(); // secret -> Promise<Map word -> rank>
// secret -> the scores at ranks 1, 500 and 850 of that same list, for the finished round's chart. Every rank
// (ours or Semantle's per-guess percentile) is a place in this list, so the lines match the proximity column.
const marks = new Map();

function ranked(secret) {
  if (!nearby.has(secret)) {
    if (nearby.size > 50) { nearby.clear(); marks.clear(); }
    nearby.set(secret, semantle.neighbours(secret).then((list) => {
      const at = (rank) => list.find((n) => n.rank === rank)?.score ?? null;
      const m = { r1: at(1), r500: at(500), r850: at(850) };
      if (Object.values(m).some((x) => x !== null)) marks.set(secret, m);
      return new Map(list.map((n) => [n.word, n.rank]));
    }).catch((e) => (nearby.delete(secret), Promise.reject(e))));
  }
  return nearby.get(secret);
}

async function score(word, secret) {
  if (word === secret) return { score: 100, rank: 1000 };
  const v = await local;
  if (v) {
    const [sim, ranks] = await Promise.all([v.similarity(word, secret), ranked(secret).catch(() => null)]);
    if (sim !== null && ranks) return { score: sim, rank: ranks.get(word) ?? null };
  }
  return semantle.score(word, secret);
}

function newId() {
  return randomBytes(4).toString("base64url").replace(/[-_]/g, "x").slice(0, 5).toLowerCase();
}

// Voice chat: an audio-only WebRTC mesh between the duel's players who joined it. Who is in it lives
// here (not saved): it goes out with every view, and the offers, answers and ICE candidates
// between two of them are passed along the event stream, the sender stamped by us, never read.
function viewOf(room, player, now) {
  return { ...room.duel.viewFor(player, now), thresholds: marks.get(room.duel.puzzle.secret) ?? null, voice: [...room.voice].map(([id, v]) => ({ id, muted: v.muted })), here: present(room) };
}

/** The players with the page open right now. */
function present(room) {
  return [...room.duel.players.keys()].filter((id) => [...room.listeners].some((l) => l.player === id));
}

// In a lobby, someone whose page has been gone this long is dropped from it, so a player who left can't hold
// up the start. Long enough for a phone to switch apps and come back.
const LOBBY_GONE_MS = Number(process.env.LOBBY_GONE_MS ?? 45_000);

function broadcast(room) {
  const now = Date.now();
  for (const l of room.listeners) send(l.res, viewOf(room, l.player, now));
}

function send(res, view) {
  res.write(`data: ${JSON.stringify(view)}\n\n`);
}

async function body(req, limit = 4096) {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > limit) throw new DuelError("too large");
  }
  return s ? JSON.parse(s) : {};
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

/**
 * A new duel on Semantle's puzzle `which` (today's if not given), or with `mode: "random"` a word drawn from
 * our list (not one in `avoid`), or with `word` one that `setter` chose (they watch; Semantle must know it).
 * `collab`: the round is played as a room, whichever word it is.
 */
async function createDuel(which, room = null, { mode, word, setter, avoid, collab } = {}) {
  const today = semantle.todaysNumber();
  let pick;
  if (word !== undefined) {
    const w = String(word).trim().toLowerCase();
    if (!/^[a-z][a-z'-]*$/.test(w) || !(await knows(w))) throw new DuelError("Semantle doesn’t know that word");
    pick = { number: null, secret: w, mode: "set" };
  } else if (mode === "random") {
    const skip = new Set(Array.isArray(avoid) ? avoid.slice(0, 500).map(String) : []);
    let w = DRAW[Math.floor(Math.random() * DRAW.length)];
    for (let i = 0; i < 50 && skip.has(w); i++) w = DRAW[Math.floor(Math.random() * DRAW.length)];
    pick = { number: WORDS.archive[w] ?? null, secret: w, mode: "random" };
  } else {
    pick = await puzzle(Number.isInteger(which) && which >= 1 && which <= today ? which : today);
  }
  const id = newId();
  const duel = new Duel(id, pick, Date.now());
  if (room) duel.room = room;
  duel.collab = !!collab;
  if (pick.mode === "set") duel.setter = { id: String(setter?.id ?? ""), name: String(setter?.name ?? "").trim().slice(0, 24) || "someone" };
  rooms.set(id, { duel, listeners: new Set(), scores: new Map(), voice: new Map() });
  ranked(duel.puzzle.secret).catch(() => {});  // warm: for scoring, and the chart's lines once it's over
  await save(duel);
  return id;
}

// Google's word2vec, which Semantle scores with, left out just these four common words: no score exists for them.
const UNSCORED = new Set(["a", "and", "of", "to"]);
const unknown = (word) => (UNSCORED.has(word) ? "not included" : "unknown word");

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/today") return json(res, 200, { number: semantle.todaysNumber() });

  if (req.method === "GET" && (parts.length === 0 || url.pathname === "/archive" || (parts[0] === "d" && parts.length === 2))) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(await readFile(PAGE));
  }

  if (req.method === "POST" && url.pathname === "/feedback") {
    const address = String(req.headers["fly-client-ip"] ?? req.socket.remoteAddress);
    const [code, out] = await receiveFeedback(await body(req, 3_000_000), address);  // room for a screenshot
    return json(res, code, out);
  }

  if (req.method === "POST" && url.pathname === "/duels") {
    const { puzzle: which, mode, word, player, name, avoid } = await body(req, 16_384);
    return json(res, 200, { id: await createDuel(which, null, { mode, word, avoid, setter: { id: player, name } }) });
  }

  if (parts[0] !== "d" || parts.length !== 3) return json(res, 404, { error: "not found" });
  const room = await loadRoom(parts[1]);
  if (!room) return json(res, 404, { error: "no such duel" });
  const { duel } = room;
  const action = parts[2];

  // A room's link opens its latest round, unless you're still racing an earlier one.
  if (req.method === "GET" && action === "head") {
    const player = url.searchParams.get("player") ?? "";
    let r = room;
    for (let i = 0; i < 100 && r.duel.next && !r.duel.racing(player, Date.now()); i++) {
      const next = await loadRoom(r.duel.next);
      if (!next) break;
      r = next;
    }
    // and what the home page's "open now" needs: is anyone there, are you in it
    const now = Date.now(), d = r.duel;
    const heard = Math.max(d.lastMove(), ...Object.values(d.seen));
    return json(res, 200, { id: d.id, room: d.room, status: d.status(now), here: present(r).length, in: d.players.has(player), racing: d.racing(player, now), idle: now - heard });
  }

  // The room's record: its rounds from the first, through the rematch chain.
  if (req.method === "GET" && action === "tally") {
    const rounds = [];
    for (let r = await loadRoom(duel.room); r && rounds.length < 1000; r = r.duel.next ? await loadRoom(r.duel.next) : null) rounds.push(r.duel);
    return json(res, 200, tally(rounds, Date.now()));
  }

  if (req.method === "GET" && action === "events") {
    const player = url.searchParams.get("player") ?? "";
    // warm the top-1000 for the chart's lines; a finished round waits for it, so its first view has them
    const warm = ranked(duel.puzzle.secret).catch(() => {});
    if (duel.status(Date.now()) === "over") await warm;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const l = { player, res };
    room.listeners.add(l);
    if (duel.touch(player, Date.now()) || (duel.status(Date.now()) === "lobby" && duel.players.has(player))) { await save(duel); broadcast(room); }  // (in the lobby: they're back)
    send(res, viewOf(room, player, Date.now()));
    // a named event (not a comment) so the page can tell a dead stream from a quiet one
    const ping = setInterval(() => res.write("event: ping\ndata: \n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      room.listeners.delete(l);
      // their last page gone: out of voice (a page that reconnects says it is in again)
      const gone = ![...room.listeners].some((x) => x.player === player);
      if (gone && room.voice.has(player)) room.voice.delete(player);
      if (gone && (room.voice.size || room.duel.players.has(player))) broadcast(room);  // others see them away
    });
    return;
  }

  if (req.method !== "POST") return json(res, 405, { error: "method" });
  const msg = await body(req, action === "signal" ? 32_768 : action === "rematch" ? 16_384 : 4096);  // an SDP offer runs to a few KB; a rematch carries words to avoid
  const player = String(msg.player ?? "");
  const now = Date.now();

  if (action === "voice") {
    if (!duel.players.has(player) && duel.setter?.id !== player) throw new DuelError("not in this duel");  // the setter may talk too
    if (msg.on) room.voice.set(player, { muted: !!msg.muted }); else room.voice.delete(player);
    broadcast(room);
    return json(res, 200, { ok: true });
  }
  if (action === "signal") {
    const to = String(msg.to ?? "");
    if (!room.voice.has(player) || !room.voice.has(to) || to === player || typeof msg.data !== "string") return json(res, 409, { error: "not in voice" });
    const out = `event: signal\ndata: ${JSON.stringify({ from: player, data: msg.data })}\n\n`;
    for (const l of room.listeners) if (l.player === to) l.res.write(out);
    return json(res, 200, { ok: true });
  }
  const resumed = duel.touch(player, now);

  // heartbeat from an open page: only worth a broadcast if it ended an away-pause
  if (action === "here" && !resumed) {
    if (now - (room.seenSaved ?? 0) > 20_000) { room.seenSaved = now; await save(duel); }
    return json(res, 200, { ok: true });
  }

  if (action === "here") {
    // resumed; saved and broadcast below
  } else if (action === "pause") {
    duel.setPaused(player, !!msg.paused, now);
  } else if (action === "join") {
    duel.join(player, msg.name, now);
  } else if (action === "leave") {
    if (duel.leave(player, now)) {
      room.voice.delete(player);  // voice is for the players
      if (duel.startsAt) setTimeout(() => broadcast(room), duel.startsAt - now + 10);  // their leaving started the countdown
    }
  } else if (action === "giveup") {
    duel.giveUp(player, now);
  } else if (action === "askgiveup") {
    duel.askGiveUp(player, !!msg.want, now);
  } else if (action === "collab") {
    duel.setCollab(player, !!msg.collab, now);
  } else if (action === "ready") {
    if (duel.setReady(player, !!msg.ready, now)) setTimeout(() => broadcast(room), duel.startsAt - now + 10);
  } else if (action === "rematch") {
    // first one to ask proposes the puzzle, and compete or collab (unsaid: as this round); it's made once every player says yes
    const random = msg.mode === "random";
    const pick = random || msg.puzzle !== undefined
      ? { puzzle: msg.puzzle, mode: msg.mode, collab: !!(msg.collab ?? duel.collab), avoid: random && Array.isArray(msg.avoid) ? msg.avoid.slice(0, 500).map(String) : undefined }
      : null;  // only a yes (or no) to what's proposed
    const agreed = duel.askRematch(player, msg.want !== false, pick, now);
    if (agreed) {
      room.rematch ??= createDuel(agreed.puzzle, duel.room, { mode: agreed.mode, collab: agreed.collab, avoid: [...(agreed.avoid ?? []), duel.puzzle.secret] }).then((id) => { duel.next = id; duel.rematch = null; }).finally(() => (room.rematch = null));
      await room.rematch;
    }
  } else if (action === "hint") {
    if (duel.askHint(player, !!msg.want, now)) {
      // Everyone agreed.
      const best = duel.bestRank(now);
      if (best >= 999) { duel.hintAsks = []; await save(duel); broadcast(room); return json(res, 409, { error: "nothing closer but the word itself" }); }
      // Semantle's own hint, given the best rank among those still racing (about a quarter of the way to the word).
      // Should that fail: a neighbour a third of the way there, by rank.
      const near = await semantle.neighbours(duel.puzzle.secret);
      const theirs = await semantle.hint(duel.puzzle.secret, best).catch(() => null);
      const target = Math.min(999, best + Math.max(1, Math.ceil((999 - best) / 3)));
      const pick = near.find((n) => n.word === theirs && n.rank > best) ?? near.filter((n) => n.rank >= target).sort((a, b) => a.rank - b.rank)[0];
      if (pick) duel.giveHint(pick.word, pick, Date.now());
    }
  } else if (action === "guess" && duel.players.get(player)?.finish) {
    // finished: words are only checked, for their score, outside the race
    const word = String(msg.word ?? "").trim().toLowerCase();
    const why = duel.checkRefusal(player, word);
    if (why) return json(res, 409, { error: why });
    if (!room.scores.has(word)) room.scores.set(word, await score(word, duel.puzzle.secret));
    const result = room.scores.get(word);
    if (!result) return json(res, 409, { error: unknown(word) });
    duel.check(player, word, result, Date.now());
  } else if (action === "guess") {
    const word = String(msg.word ?? "").trim().toLowerCase();
    const why = duel.refusal(player, word, now);
    if (why) return json(res, 409, { error: why });
    if (!room.scores.has(word)) room.scores.set(word, await score(word, duel.puzzle.secret));
    const result = room.scores.get(word);
    if (!result) return json(res, 409, { error: unknown(word) });
    duel.guess(player, word, result, Date.now());
  } else {
    return json(res, 404, { error: "not found" });
  }
  await save(duel);
  broadcast(room);
  // the caller's own view comes back too, so a stalled event stream can't strand them
  return json(res, 200, { ok: true, view: viewOf(room, player, Date.now()) });
}

// Stop the clock in duels where everyone still playing has gone quiet; drop whoever has left a lobby.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.duel.checkAway(now)) save(room.duel).then(() => broadcast(room), console.error);
    if (room.duel.status(now) !== "lobby") { room.gone = null; continue; }
    room.gone ??= new Map();  // player -> since when their page has been gone
    const here = new Set(present(room));
    let dropped = false;
    for (const id of [...room.duel.players.keys()]) {
      if (here.has(id)) { room.gone.delete(id); continue; }
      if (!room.gone.has(id)) room.gone.set(id, now);
      else if (now - room.gone.get(id) > LOBBY_GONE_MS && room.duel.leave(id, now)) {
        room.gone.delete(id); dropped = true;
        if (room.duel.startsAt) setTimeout(() => broadcast(room), room.duel.startsAt - now + 10);  // it left the rest all ready
      }
    }
    if (dropped) save(room.duel).then(() => broadcast(room), console.error);
  }
}, 5_000).unref();

// Drop idle duels from memory; they stay on disk.
setInterval(() => {
  for (const [id, r] of rooms) if (r.listeners.size === 0) rooms.delete(id);
}, 3600_000).unref();

http
  .createServer((req, res) =>
    handle(req, res).catch((e) => {
      if (e instanceof DuelError || e instanceof SyntaxError) return json(res, 409, { error: e.message });
      console.error(e);
      json(res, 502, { error: "upstream trouble" });
    }),
  )
  .listen(PORT, HOST, () => console.log(`semantle-duel on http://${HOST}:${PORT}`));
