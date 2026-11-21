// A duel: up to eight people racing at the same Semantle puzzle on one clock.
// Each player finishes on their own (found it, or gave up); finding the word
// doesn't stop anyone else. The duel is over once everyone has finished.

const COUNTDOWN_MS = 3000;
export const MAX_PLAYERS = 8;
const ABANDON_MS = 24 * 3600_000; // a started duel with no moves this long ends
// No sign of life from anyone still playing this long: the clock stops (as of when they were last heard).
// Long enough to ride out a background tab's throttled timers (Chrome: once a minute).
export const AWAY_MS = Number(process.env.AWAY_MS ?? 90_000);

/** @typedef {{n:number, word:string, score:number, rank:number|null, at:number, hint?:boolean}} Guess  hint: given to everyone, agreed on */
/** @typedef {{word:string, score:number, rank:number|null, at:number}} Check  a word scored after you finished, for your eyes only */
/** @typedef {{at:number, found:boolean}} Finish */
/** @typedef {{from:number, to:number|null, by:string|null}} Pause  by: who pressed pause, or null when everyone left */
/** @typedef {{id:string, name:string, guesses:Guess[], finish:Finish|null, ready?:boolean, checks?:Check[]}} Player  ready: in the lobby, said they are set to go */

export class Duel {
  /** @param {string} id @param {{number:number, secret:string, closest:number, tenth:number, thousandth:number}} puzzle */
  constructor(id, puzzle, now) {
    this.id = id;
    this.puzzle = puzzle;
    /** @type {Map<string, Player>} */
    this.players = new Map();
    /** @type {number|null} */ this.startsAt = null;
    this.createdAt = now;
    /** @type {string|null} the rematch duel, once someone asks for one */ this.next = null;
    /** @type {Pause[]} */ this.pauses = [];
    /** @type {Record<string, number>} when each player was last heard from */ this.seen = {};
    /** @type {string[]} players asking for a hint; given once everyone still racing has asked */ this.hintAsks = [];
  }

  /** The open pause, if the clock is stopped. */
  pause() {
    const last = this.pauses.at(-1);
    return last && last.to === null ? last : null;
  }

  /** Clock time at wall time t: time since the start, less any paused time. */
  elapsed(t) {
    if (this.startsAt === null) return 0;
    let ms = t - this.startsAt;
    for (const p of this.pauses) ms -= Math.max(0, Math.min(p.to ?? t, t) - Math.max(p.from, this.startsAt));
    return Math.max(0, ms);
  }

  /** Still racing: started, not over, and not yet finished themselves. */
  racing(playerId, now) {
    const p = this.players.get(playerId);
    return !!p && !p.finish && this.status(now) === "playing";
  }

  lastHeard(p) {
    return Math.max(this.startsAt ?? 0, this.seen[p.id] ?? 0, p.guesses.at(-1)?.at ?? 0);
  }

  /** A player showed signs of life. Ends a pause that started because everyone had left. Returns true if it changed anything visible. */
  touch(playerId, now) {
    if (!this.players.has(playerId)) return false;
    this.seen[playerId] = now;
    const open = this.pause();
    if (!open || open.by !== null || !this.racing(playerId, now)) return false;
    open.to = now;
    return true;
  }

  /** Stop the clock if everyone still racing has gone quiet, as of when the last of them was heard. Returns true if it did. */
  checkAway(now) {
    if (this.status(now) !== "playing" || this.pause()) return false;
    const racing = [...this.players.values()].filter((p) => !p.finish);
    const last = Math.max(...racing.map((p) => this.lastHeard(p)));
    if (now - last < AWAY_MS) return false;
    this.pauses.push({ from: last, to: null, by: null });
    return true;
  }

  setPaused(playerId, paused, now) {
    if (!this.racing(playerId, now)) throw new DuelError("not playing");
    const open = this.pause();
    if (paused && !open) this.pauses.push({ from: now, to: null, by: playerId });
    if (!paused && open) open.to = now;
  }

  /** @returns {"lobby"|"countdown"|"playing"|"over"} */
  status(now) {
    if (this.startsAt === null) return "lobby";
    if (now < this.startsAt) return "countdown";
    return [...this.players.values()].every((p) => p.finish) ? "over" : "playing";
  }

  /** When the last player finished. */
  endedAt() {
    return Math.max(...[...this.players.values()].map((p) => p.finish?.at ?? Infinity));
  }

  /** End an abandoned duel: anyone still playing gives up as of the last move. Returns true if it did. */
  expire(now) {
    if (this.status(now) !== "playing" || this.pause()) return false;
    const ps = [...this.players.values()];
    const last = Math.max(this.startsAt, ...ps.flatMap((p) => [p.finish?.at ?? 0, ...p.guesses.map((g) => g.at)]));
    if (now - last < ABANDON_MS) return false;
    for (const p of ps) p.finish ??= { at: last, found: false };
    return true;
  }

  join(playerId, name, now) {
    const clean = String(name ?? "").trim().slice(0, 24) || "player";
    const p = this.players.get(playerId);
    if (p) return void (p.name = clean);
    if (this.status(now) !== "lobby") throw new DuelError("already started");
    if (this.players.size >= MAX_PLAYERS) throw new DuelError("full");
    this.players.set(playerId, { id: playerId, name: clean, guesses: [], finish: null });
  }

  start(now) {
    if (this.status(now) !== "lobby") throw new DuelError("already started");
    if (this.players.size < 2) throw new DuelError("waiting for an opponent");
    this.startsAt = now + COUNTDOWN_MS;
  }

  /** Ready (or not) in the lobby. Once everyone (two or more) is ready the countdown starts; returns true if it did. */
  setReady(playerId, ready, now) {
    const p = this.players.get(playerId);
    if (!p) throw new DuelError("not in this duel");
    if (this.status(now) !== "lobby") throw new DuelError("already started");
    p.ready = ready;
    if (this.players.size < 2 || ![...this.players.values()].every((q) => q.ready)) return false;
    this.start(now);
    return true;
  }

  /** Why this player can't guess this word right now, or null if they can. */
  refusal(playerId, word, now) {
    const p = this.players.get(playerId);
    if (!p) return "not in this duel";
    if (this.status(now) !== "playing" || p.finish) return "not playing";
    if (this.pause()) return "paused";
    if (!/^[a-z][a-z'-]*$/.test(word)) return "not a word";
    if (p.guesses.some((g) => g.word === word)) return "already guessed";
    return null;
  }

  /** Why a finished player can't check this word, or null if they can. */
  checkRefusal(playerId, word) {
    const p = this.players.get(playerId);
    if (!p?.finish) return "not finished";
    if (!/^[a-z][a-z'-]*$/.test(word)) return "not a word";
    if (p.guesses.some((g) => g.word === word) || p.checks?.some((c) => c.word === word)) return "already guessed";
    return null;
  }

  /** After finishing: score a word just to see, outside the race. */
  check(playerId, word, { score, rank }, now) {
    const why = this.checkRefusal(playerId, word);
    if (why) throw new DuelError(why);
    const p = this.players.get(playerId);
    (p.checks ??= []).push({ word, score, rank, at: now });
  }

  /** Still racing, in the order they joined. */
  racers(now) {
    return this.status(now) === "playing" ? [...this.players.values()].filter((p) => !p.finish) : [];
  }

  /** Ask for a hint (or stop asking). Returns true once everyone still racing has asked. */
  askHint(playerId, want, now) {
    if (!this.racing(playerId, now)) throw new DuelError("not playing");
    if (this.pause()) throw new DuelError("paused");
    const racing = new Set(this.racers(now).map((p) => p.id));
    this.hintAsks = this.hintAsks.filter((id) => id !== playerId && racing.has(id));
    if (want) this.hintAsks.push(playerId);
    return racing.size > 0 && [...racing].every((id) => this.hintAsks.includes(id));
  }

  /** The best rank anyone has reached (0 if nobody is in the top 1000). */
  bestRank() {
    return Math.max(0, ...[...this.players.values()].flatMap((p) => p.guesses.map((g) => (g.word === this.puzzle.secret ? 0 : g.rank ?? 0))));
  }

  /** Everyone still racing gets this word as a guess. */
  giveHint(word, { score, rank }, now) {
    for (const p of this.racers(now)) {
      if (p.guesses.some((g) => g.word === word)) continue;
      p.guesses.push({ n: p.guesses.length + 1, word, score, rank, at: now, hint: true });
    }
    this.hintAsks = [];
  }

  /** Record a scored guess. Re-checks, since scoring is async. */
  guess(playerId, word, { score, rank }, now) {
    const why = this.refusal(playerId, word, now);
    if (why) throw new DuelError(why);
    const p = this.players.get(playerId);
    p.guesses.push({ n: p.guesses.length + 1, word, score, rank, at: now });
    if (word === this.puzzle.secret) p.finish = { at: now, found: true };
  }

  giveUp(playerId, now) {
    const p = this.players.get(playerId);
    if (!p || p.finish || this.status(now) !== "playing") throw new DuelError("not playing");
    p.finish = { at: now, found: false };
    const open = this.pause();
    if (open && [...this.players.values()].every((q) => q.finish)) open.to = now;
  }

  /** What one viewer may see: everything once they've finished (or it's over), otherwise only scores of others. */
  viewFor(viewerId, now) {
    const status = this.status(now);
    const reveal = status === "over" || !!this.players.get(viewerId)?.finish;
    const ended = status === "over" ? this.endedAt() : now;
    const open = this.pause();
    const mine = new Set(this.players.get(viewerId)?.guesses.map((g) => g.word));
    return {
      id: this.id,
      number: this.puzzle.number,
      status,
      now,
      startsAt: this.startsAt,
      endedAt: status === "over" ? this.endedAt() : null,
      elapsed: this.elapsed(ended),  // the clock as of `now`; it runs on from here unless paused or over
      paused: open ? { by: open.by, from: open.from } : null,
      hintAsks: status === "playing" ? this.hintAsks.filter((id) => !this.players.get(id)?.finish) : [],
      secret: reveal ? this.puzzle.secret : null,
      max: MAX_PLAYERS,
      next: this.next,
      you: viewerId,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        ready: !!p.ready,
        finish: p.finish && { ...p.finish, time: this.elapsed(p.finish.at) },
        guesses: p.guesses.map((g) => ({
          n: g.n,
          // an opponent's word shows once you've guessed it too
          word: reveal || p.id === viewerId || g.hint || mine.has(g.word) ? g.word : null,
          score: g.score,
          rank: g.rank,
          at: g.at,
          hint: !!g.hint,
          // someone else found their own way to this word too (scores give that away anyway)
          shared: !g.hint && [...this.players.values()].some((q) => q !== p && q.guesses.some((h) => h.word === g.word && !h.hint)),
        })),
        checks: p.id === viewerId ? p.checks ?? [] : [],
      })),
    };
  }

  toJSON() {
    return { id: this.id, puzzle: this.puzzle, players: [...this.players.values()], startsAt: this.startsAt, createdAt: this.createdAt, next: this.next, pauses: this.pauses, seen: this.seen, hintAsks: this.hintAsks };
  }

  static fromJSON(o) {
    const d = new Duel(o.id, o.puzzle, o.createdAt);
    for (const p of o.players) d.players.set(p.id, { finish: null, ...p });
    d.startsAt = o.startsAt;
    d.next = o.next ?? null;
    d.pauses = o.pauses ?? [];
    d.seen = o.seen ?? {};
    d.hintAsks = o.hintAsks ?? [];
    // duels saved before players finished separately: the winner had found it
    if (o.won) {
      const w = d.players.get(o.won.player);
      if (w) w.finish = { at: o.won.at, found: true };
      for (const p of d.players.values()) p.finish ??= { at: o.won.at, found: false };
    }
    return d;
  }
}

export class DuelError extends Error {}
