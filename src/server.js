import http from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Duel, DuelError } from "./duel.js";
import * as semantle from "./semantle.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";
const PAGE = new URL("../public/index.html", import.meta.url);
const DATA = process.env.DATA_DIR ?? new URL("../data", import.meta.url).pathname;
await mkdir(DATA, { recursive: true });

/** Live duels. Every duel is also on disk, so links outlive the process. */
/** @type {Map<string, {duel: Duel, listeners: Set<{player:string, res:http.ServerResponse}>, scores: Map<string, any>}>} */
const rooms = new Map();

const fileOf = (id) => `${DATA}/${id}.json`;

async function save(duel) {
  const tmp = `${fileOf(duel.id)}.tmp`;
  await writeFile(tmp, JSON.stringify(duel));
  await rename(tmp, fileOf(duel.id));
}

async function loadRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  if (!/^[a-z0-9]{5}$/.test(id)) return null;
  let raw;
  try { raw = await readFile(fileOf(id), "utf8"); } catch { return null; }
  if (!rooms.has(id)) rooms.set(id, { duel: Duel.fromJSON(JSON.parse(raw)), listeners: new Set(), scores: new Map() });
  return rooms.get(id);
}
const puzzles = new Map(); // number -> puzzle, so a busy day costs one fetch

async function puzzle(number) {
  if (!puzzles.has(number)) puzzles.set(number, semantle.fetchPuzzle(number).catch((e) => (puzzles.delete(number), Promise.reject(e))));
  return puzzles.get(number);
}

function newId() {
  return randomBytes(4).toString("base64url").replace(/[-_]/g, "x").slice(0, 5).toLowerCase();
}

function broadcast(room) {
  const now = Date.now();
  for (const l of room.listeners) send(l.res, room.duel.viewFor(l.player, now));
}

function send(res, view) {
  res.write(`data: ${JSON.stringify(view)}\n\n`);
}

async function body(req) {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 4096) throw new DuelError("too large");
  }
  return s ? JSON.parse(s) : {};
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function createDuel(which) {
  const today = semantle.todaysNumber();
  const number = Number.isInteger(which) && which >= 1 && which <= today ? which : today;
  const id = newId();
  const duel = new Duel(id, await puzzle(number), Date.now());
  rooms.set(id, { duel, listeners: new Set(), scores: new Map() });
  await save(duel);
  return id;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/today") return json(res, 200, { number: semantle.todaysNumber() });

  if (req.method === "GET" && (parts.length === 0 || url.pathname === "/archive" || (parts[0] === "d" && parts.length === 2))) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(await readFile(PAGE));
  }

  if (req.method === "POST" && url.pathname === "/duels") {
    const { puzzle: which } = await body(req);
    return json(res, 200, { id: await createDuel(which) });
  }

  if (parts[0] !== "d" || parts.length !== 3) return json(res, 404, { error: "not found" });
  const room = await loadRoom(parts[1]);
  if (!room) return json(res, 404, { error: "no such duel" });
  const { duel } = room;
  const action = parts[2];

  if (req.method === "GET" && action === "events") {
    const player = url.searchParams.get("player") ?? "";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const l = { player, res };
    room.listeners.add(l);
    send(res, duel.viewFor(player, Date.now()));
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => (clearInterval(ping), room.listeners.delete(l)));
    return;
  }

  if (req.method !== "POST") return json(res, 405, { error: "method" });
  const msg = await body(req);
  const player = String(msg.player ?? "");
  const now = Date.now();

  if (action === "join") {
    duel.join(player, msg.name, now);
  } else if (action === "giveup") {
    duel.giveUp(player, now);
  } else if (action === "start") {
    if (!duel.players.has(player)) throw new DuelError("not in this duel");
    duel.start(now);
    setTimeout(() => broadcast(room), duel.startsAt - now + 10);
  } else if (action === "guess") {
    const word = String(msg.word ?? "").trim().toLowerCase();
    const why = duel.refusal(player, word, now);
    if (why) return json(res, 409, { error: why });
    if (!room.scores.has(word)) room.scores.set(word, await semantle.score(word, duel.puzzle.secret));
    const result = room.scores.get(word);
    if (!result) return json(res, 409, { error: "unknown word" });
    duel.guess(player, word, result, Date.now());
  } else {
    return json(res, 404, { error: "not found" });
  }
  await save(duel);
  broadcast(room);
  return json(res, 200, { ok: true });
}

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
