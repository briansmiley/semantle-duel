import http from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Duel, DuelError, tally, AWAY_MS } from "./duel.js";
import * as semantle from "./semantle.js";
import * as vectors from "./vectors.js";
import { feedback, rateLimit } from "./feedback.js";

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
const allowNewDuel = rateLimit(20, 60_000);  // per address: duels share the volume, so a script mustn't fill it
const addressOf = (req) => String(req.headers["fly-client-ip"] ?? req.socket.remoteAddress);

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
  try { raw = await readFile(fileOf(id), "utf8"); } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;  // a read that failed is not a duel that's gone: the home page forgets rooms on 404
  }
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

// Score locally when we have the vectors and Semantle's top-1000 list for this secret; otherwise (or for a
// word we don't know) ask Semantle per guess. Should Semantle be down, a word we know is scored without a rank.
const local = vectors.load(process.env.VECTORS_DIR ?? `${DATA}/vectors`);
const nearby = new Map(); // secret -> Promise<Map word -> rank>
// secret -> the scores at ranks 1, 500 and 850 of that same list, for the finished round's chart. Every rank
// (ours or Semantle's per-guess percentile) is a place in this list, so the lines match the proximity column.
const marks = new Map();

// A top-1000 (or per-guess) fetch that failed isn't tried again for a while, so while Semantle stalls each
// guess isn't held for a fresh timeout: it gets the best answer we have at once.
const COOLDOWN_MS = 30_000;
const downUntil = new Map(); // secret -> when to try its top-1000 again
let asksDownUntil = 0; // when to try Semantle's per-guess scores again
// a known word's guess waits at most this long in all, under the page's own 15 s
const ASK_BUDGET_MS = 12_000;

function ranked(secret) {
  if (!nearby.has(secret)) {
    if ((downUntil.get(secret) ?? 0) > Date.now()) return Promise.reject(new Error(`semantle: top1000 for ${secret} is down`));
    if (nearby.size > 50) { nearby.clear(); marks.clear(); downUntil.clear(); }
    nearby.set(secret, semantle.neighbours(secret).then((list) => {
      const at = (rank) => list.find((n) => n.rank === rank)?.score ?? null;
      const m = { r1: at(1), r500: at(500), r850: at(850) };
      if (Object.values(m).some((x) => x !== null)) marks.set(secret, m);
      return new Map(list.map((n) => [n.word, n.rank]));
    }).catch((e) => (nearby.delete(secret), downUntil.set(secret, Date.now() + COOLDOWN_MS), Promise.reject(e))));
  }
  return nearby.get(secret);
}

async function score(word, secret) {
  if (word === secret) return { score: 100, rank: 1000 };
  const v = await local;
  const sim = v && (await v.similarity(word, secret));
  if (sim != null) {
    const began = Date.now();
    const ranks = await ranked(secret).catch(() => null);
    if (ranks) return { score: sim, rank: ranks.get(word) ?? null };
    // no top-1000: Semantle's per-guess answer still carries the rank, if it comes in time
    if (Date.now() >= asksDownUntil) {
      const wait = new Promise((r) => setTimeout(r, Math.max(0, ASK_BUDGET_MS - (Date.now() - began))).unref());
      const asked = await Promise.race([semantle.score(word, secret), wait]).catch(() => undefined);
      if (asked) return asked;
      if (asked === undefined) asksDownUntil = Date.now() + COOLDOWN_MS;
    }
    // Semantle is down: our score still holds (it matches theirs), just not where it ranks
    return { score: sim, rank: null, rankless: true };
  }
  return semantle.score(word, secret);
}

/** The room's score for `word`, asked once; one scored without its rank is asked again next time. */
async function scoreIn(room, word) {
  if (room.scores.has(word)) return room.scores.get(word);
  const result = await score(word, room.duel.puzzle.secret);
  if (!result?.rankless) room.scores.set(word, result);
  return result;
}

function newId() {
  return randomBytes(4).toString("base64url").replace(/[-_]/g, "x").slice(0, 5).toLowerCase();
}

// Voice chat: an audio-only WebRTC mesh between the duel's players who joined it. Who is in it lives
// here (not saved): it goes out with every view, and the offers, answers and ICE candidates
// between two of them are passed along the event stream, the sender stamped by us, never read.
function viewOf(room, player, now) {
  return { ...room.duel.viewFor(player, now), thresholds: marks.get(room.duel.puzzle.secret) ?? null, voice: [...room.voice].map(([id, v]) => ({ id, muted: v.muted })), here: present(room), voters: voters(room, now).map((p) => p.id) };
}

/** The players with the page open right now. */
function present(room) {
  return [...room.duel.players.keys()].filter((id) => [...room.listeners].some((l) => l.player === id));
}

/** Who a hint or a co-op give-up waits for: those racing and heard from lately (an open page says so every 10s), so one who left can't hold it up. */
function voters(room, now) {
  return room.duel.racers(now).filter((p) => now - room.duel.lastHeard(p) < AWAY_MS);
}

/** Everyone counted has asked for a hint: give one. Returns why not, if none can be given; either way the asks are spent. */
async function grantHint(room) {
  const { duel } = room;
  const best = duel.bestRank(Date.now());
  if (best >= 999) { duel.hintAsks = []; return "nothing closer but the word itself"; }
  if (room.hinting) return null;  // one is on its way
  room.hinting = true;
  try { await pickHint(duel, best); } finally { room.hinting = false; }
  return null;
}

async function pickHint(duel, best) {
  // Semantle's own hint, given the best rank among those still racing (about a quarter of the way to the word).
  // Should that fail: a neighbour a third of the way there, by rank.
  const near = await semantle.neighbours(duel.puzzle.secret);
  const theirs = await semantle.hint(duel.puzzle.secret, best).catch(() => null);
  const target = Math.min(999, best + Math.max(1, Math.ceil((999 - best) / 3)));
  const pick = near.find((n) => n.word === theirs && n.rank > best) ?? near.filter((n) => n.rank >= target).sort((a, b) => a.rank - b.rank)[0];
  if (pick) duel.giveHint(pick.word, pick, Date.now());
  else duel.hintAsks = [];
}

/** All of `voters` are among `asks` (and there is someone to vote). */
const allAsked = (asks, vs) => vs.length > 0 && vs.every((p) => asks.includes(p.id));

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
  let o;
  try { o = s ? JSON.parse(s) : {}; } catch { throw new DuelError("bad request"); }
  if (!o || typeof o !== "object") throw new DuelError("bad request");
  return o;
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

/** A typed word as we store it: iOS's curly apostrophes straightened, trimmed, lowercase. */
const clean = (word) => String(word ?? "").replace(/[‘’ʼ]/g, "'").trim().toLowerCase();

/**
 * A new duel on Semantle's puzzle `which` (today's if not given), or with `mode: "random"` a word drawn from
 * our list (not one in `avoid`), or with `word` one that `setter` chose (they watch; Semantle must know it).
 * `collab`: the round is played as a room, whichever word it is. `host`: the player id of whoever made it.
 */
async function createDuel(which, room = null, { mode, word, setter, avoid, collab, host } = {}) {
  const today = semantle.todaysNumber();
  let pick;
  if (word !== undefined) {
    const w = clean(word);
    if (!/^[a-z][a-z'-]{0,29}$/.test(w)) throw new DuelError("one word, letters only");
    if (!(await knows(w))) throw new DuelError("Semantle doesn’t know that word");
    pick = { number: null, secret: w, mode: "set" };
  } else if (mode === "random") {
    const skip = new Set(Array.isArray(avoid) ? avoid.slice(0, 500).map(String) : []);
    let w = DRAW[Math.floor(Math.random() * DRAW.length)];
    for (let i = 0; i < 50 && skip.has(w); i++) w = DRAW[Math.floor(Math.random() * DRAW.length)];
    pick = { number: WORDS.archive[w] ?? null, secret: w, mode: "random" };
  } else {
    pick = await puzzle(Number.isInteger(which) && which >= 1 && which <= today ? which : today);
  }
  let id;
  do id = newId(); while (rooms.has(id) || existsSync(fileOf(id)));  // ids are short: past a few thousand duels, they meet
  const duel = new Duel(id, pick, Date.now());
  if (room) duel.room = room;
  duel.collab = !!collab;
  duel.host = String(host ?? "") || null;
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

  const read = req.method === "GET" || req.method === "HEAD";  // Node drops the body for HEAD

  if (read && url.pathname === "/today") return json(res, 200, { number: semantle.todaysNumber() });

  if (read && (parts.length === 0 || url.pathname === "/archive" || (parts[0] === "d" && parts.length === 2))) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(await readFile(PAGE));
  }

  if (req.method === "POST" && url.pathname === "/feedback") {
    const [code, out] = await receiveFeedback(await body(req, 3_000_000), addressOf(req));  // room for a screenshot
    return json(res, code, out);
  }

  if (req.method === "POST" && url.pathname === "/duels") {
    if (!allowNewDuel(addressOf(req))) return json(res, 429, { error: "that's a lot of new duels; try again in a minute" });
    const { puzzle: which, mode, word, player, name, avoid } = await body(req, 16_384);
    return json(res, 200, { id: await createDuel(which, null, { mode, word, avoid, setter: { id: player, name }, host: player }) });
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
    if (req.destroyed) return;  // gone while we waited: its "close" has fired, so a listener added now would never leave
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const l = { player, res };
    room.listeners.add(l);
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
    if (duel.touch(player, Date.now()) || (duel.status(Date.now()) === "lobby" && duel.players.has(player))) { await save(duel); broadcast(room); }  // (in the lobby: they're back)
    send(res, viewOf(room, player, Date.now()));
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
    duel.askGiveUp(player, !!msg.want, now, voters(room, now));
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
      // a rematch is a new duel too: the same limit. Refused, the last yes is taken back, so nobody sees all yeses with
      // nothing happening; their retry once it lifts still finds everyone else's.
      if (!room.rematch && !allowNewDuel(addressOf(req))) {
        duel.askRematch(player, false, null, now);
        return json(res, 429, { error: "that's a lot of new duels; try again in a minute" });
      }
      room.rematch ??= createDuel(agreed.puzzle, duel.room, { mode: agreed.mode, collab: agreed.collab, host: agreed.by, avoid: [...(agreed.avoid ?? []), duel.puzzle.secret] }).then((id) => { duel.next = id; duel.rematch = null; }).finally(() => (room.rematch = null));
      await room.rematch;
    }
  } else if (action === "hint") {
    if (duel.askHint(player, !!msg.want, now, voters(room, now))) {
      // Everyone agreed.
      const why = await grantHint(room);
      if (why) { await save(duel); broadcast(room); return json(res, 409, { error: why }); }
    }
  } else if (action === "guess" && duel.players.get(player)?.finish) {
    // finished: words are only checked, for their score, outside the race
    const word = clean(msg.word);
    const why = duel.checkRefusal(player, word);
    if (why) return json(res, 409, { error: why });
    const result = await scoreIn(room, word);
    if (!result) return json(res, 409, { error: unknown(word) });
    duel.check(player, word, result, Date.now());
  } else if (action === "guess") {
    const word = clean(msg.word);
    const why = duel.refusal(player, word, now);
    if (why) return json(res, 409, { error: why });
    const result = await scoreIn(room, word);
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

// Stop the clock in duels where everyone still playing has gone quiet; settle a vote whose last holdout has gone
// quiet; drop whoever has left a lobby.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.duel.checkAway(now)) save(room.duel).then(() => broadcast(room), console.error);
    settleVotes(room, now).catch(console.error);
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

/** A hint or co-op give-up everyone still counted has asked for goes through, without anyone asking again. Also
 * rebroadcasts when who counts changes, so pages stop waiting on (or start waiting on) the right people. */
async function settleVotes(room, now) {
  const { duel } = room;
  const vs = voters(room, now);
  const key = vs.map((p) => p.id).join();
  const moved = room.voterKey !== undefined && key !== room.voterKey;
  room.voterKey = key;
  if (duel.collab && allAsked(duel.giveUpAsks, vs)) duel.finishAll(false, now);
  else if (!duel.pause() && !room.hinting && allAsked(duel.hintAsks, vs)) await grantHint(room).catch((e) => { console.error(e); duel.hintAsks = []; });  // no retrying every 5s
  else { if (moved) broadcast(room); return; }
  await save(duel);
  broadcast(room);
}

// Drop idle duels from memory; they stay on disk.
setInterval(() => {
  for (const [id, r] of rooms) if (r.listeners.size === 0) rooms.delete(id);
}, 3600_000).unref();

http
  .createServer((req, res) =>
    handle(req, res).catch((e) => {
      if (res.headersSent) return console.error(e), res.destroy();  // mid-stream (a failed save on events): too late for a JSON error
      if (e instanceof DuelError) return json(res, 409, { error: e.message });
      console.error(e);
      json(res, 502, { error: "upstream trouble" });
    }),
  )
  .listen(PORT, HOST, () => console.log(`semantle-duel on http://${HOST}:${PORT}`));
