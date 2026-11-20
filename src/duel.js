// A duel: up to four people racing at the same Semantle puzzle on one clock.
// Each player finishes on their own (found it, or gave up); finding the word
// doesn't stop anyone else. The duel is over once everyone has finished.

const COUNTDOWN_MS = 3000;
export const MAX_PLAYERS = 4;

/** @typedef {{n:number, word:string, score:number, rank:number|null, at:number}} Guess */
/** @typedef {{at:number, found:boolean}} Finish */
/** @typedef {{id:string, name:string, guesses:Guess[], finish:Finish|null}} Player */

export class Duel {
  /** @param {string} id @param {{number:number, secret:string, closest:number, tenth:number, thousandth:number}} puzzle */
  constructor(id, puzzle, now) {
    this.id = id;
    this.puzzle = puzzle;
    /** @type {Map<string, Player>} */
    this.players = new Map();
    /** @type {number|null} */ this.startsAt = null;
    this.createdAt = now;
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

  /** Why this player can't guess this word right now, or null if they can. */
  refusal(playerId, word, now) {
    const p = this.players.get(playerId);
    if (!p) return "not in this duel";
    if (this.status(now) !== "playing" || p.finish) return "not playing";
    if (!/^[a-z][a-z'-]*$/.test(word)) return "not a word";
    if (p.guesses.some((g) => g.word === word)) return "already guessed";
    return null;
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
  }

  /** What one viewer may see: everything once they've finished (or it's over), otherwise only scores of others. */
  viewFor(viewerId, now) {
    const status = this.status(now);
    const reveal = status === "over" || !!this.players.get(viewerId)?.finish;
    return {
      id: this.id,
      number: this.puzzle.number,
      status,
      now,
      startsAt: this.startsAt,
      endedAt: status === "over" ? this.endedAt() : null,
      secret: reveal ? this.puzzle.secret : null,
      max: MAX_PLAYERS,
      you: viewerId,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        finish: p.finish,
        guesses: p.guesses.map((g) => ({
          n: g.n,
          word: reveal || p.id === viewerId ? g.word : null,
          score: g.score,
          rank: g.rank,
          at: g.at,
        })),
      })),
    };
  }

  toJSON() {
    return { id: this.id, puzzle: this.puzzle, players: [...this.players.values()], startsAt: this.startsAt, createdAt: this.createdAt };
  }

  static fromJSON(o) {
    const d = new Duel(o.id, o.puzzle, o.createdAt);
    for (const p of o.players) d.players.set(p.id, { finish: null, ...p });
    d.startsAt = o.startsAt;
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
