// A duel: up to eight people racing at the same Semantle puzzle on one clock.
// Each player finishes on their own (found it, or gave up); finding the word
// doesn't stop anyone else. The duel is over once everyone has finished.
// A co-op round (`collab`) is the room working together: one list of words, each still stored with whoever
// guessed it; finding the word finishes everyone, and giving up takes everyone's vote.

const COUNTDOWN_MS = 3000;
export const MAX_PLAYERS = 8;
const ABANDON_MS = 24 * 3600_000; // a started duel with no moves this long ends
// No sign of life from anyone still playing this long: the clock stops (as of when they were last heard).
// Long enough to ride out a background tab's throttled timers (Chrome: once a minute).
export const AWAY_MS = Number(process.env.AWAY_MS ?? 90_000);

/** @typedef {{n:number, word:string, score:number, rank:number|null, at:number, hint?:boolean}} Guess  hint: given to everyone, agreed on */
/** @typedef {{word:string, score:number, rank:number|null, at:number}} Check  a word scored after finishing; shown to their owner, and to whoever may see everything (finished having played, setter, round over), not to those still racing */
/** @typedef {{at:number, found:boolean}} Finish */
/** @typedef {{from:number, to:number|null, by:string|null}} Pause  by: who pressed pause, or null when everyone left */
/** @typedef {{by:string, puzzle?:number, mode?:string, collab:boolean, avoid?:string[], asks:string[]}} Rematch  proposed, not yet made; asks: who has said yes */
/** @typedef {{id:string, name:string, guesses:Guess[], finish:Finish|null, ready?:boolean, checks?:Check[], key?:string}} Player  ready: in the lobby, said they are set to go; key: the hash of their browser's private key */

export class Duel {
  /** @param {string} id @param {{number:number|null, secret:string, mode?:"random"|"set"}} puzzle  number: Semantle's, if it's one of theirs; null for our own words and set ones */
  constructor(id, puzzle, now) {
    this.id = id;
    this.puzzle = puzzle;
    /** @type {Map<string, Player>} */
    this.players = new Map();
    /** @type {number|null} */ this.startsAt = null;
    this.createdAt = now;
    /** @type {string|null} the rematch duel, once every player has said yes to one */ this.next = null;
    /** @type {Rematch|null} a rematch someone has proposed, until it's made (or withdrawn) */ this.rematch = null;
    /** @type {{id:string, name:string, key?:string}|null} whoever set the word (a "set" duel): watches, sees every word, doesn't play; key: the hash of their browser's private key */ this.setter = null;
    /** the room: the first duel's id, kept by every rematch after it; its link always opens the latest round */ this.room = id;
    /** @type {Pause[]} */ this.pauses = [];
    /** @type {Record<string, number>} when each player was last heard from */ this.seen = {};
    /** @type {string[]} players asking for a hint; given once everyone still racing has asked */ this.hintAsks = [];
    /** how this round is played, whatever the word's source (puzzle.mode): racing, or the room together */ this.collab = false;
    /** @type {string[]} co-op: players asking to give up; the round ends once everyone still racing has asked */ this.giveUpAsks = [];
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

  /** When they last showed signs of life: a hint handed to them doesn't count. */
  lastHeard(p) {
    return Math.max(this.startsAt ?? 0, this.seen[p.id] ?? 0, p.guesses.findLast((g) => !g.hint)?.at ?? 0);
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
    if (this.status(now) !== "playing") return false;
    const last = this.lastMove();
    if (now - last < ABANDON_MS) return false;
    // paused and left, too: the pause ends where the last of it happened
    const open = this.pause();
    if (open) open.to = Math.max(open.from, last);
    for (const p of this.players.values()) p.finish ??= { at: last, found: false };
    return true;
  }

  /** When anything last happened in it: the start, a guess, a finish, a pause or resume. */
  lastMove() {
    const ps = [...this.players.values()];
    return Math.max(this.startsAt ?? this.createdAt, ...ps.flatMap((p) => [p.finish?.at ?? 0, ...p.guesses.map((g) => g.at)]),
      ...this.pauses.flatMap((p) => [p.from, p.to ?? 0]));
  }

  /** In the lobby, or late: until it's over anyone can join, on the same clock as everyone else. */
  join(playerId, name, now) {
    const clean = String(name ?? "").trim().slice(0, 24) || "player";
    const p = this.players.get(playerId);
    if (p) return void (p.name = clean);
    if (!/^[\da-f-]{1,64}$/i.test(playerId)) throw new DuelError("bad player id");  // the page makes UUIDs or hex, never a name like __proto__ (ids key `seen`)
    if (this.setter?.id === playerId) throw new DuelError("you set the word");
    if (this.status(now) === "over") throw new DuelError("it's over");
    if (this.players.size >= MAX_PLAYERS) throw new DuelError("full");
    this.players.set(playerId, { id: playerId, name: clean, guesses: [], finish: null });
    this.seen[playerId] = now;
  }

  /** Out of the lobby (they left before it started). Returns true if they were in it. */
  leave(playerId, now) {
    if (this.status(now) !== "lobby") return false;
    if (!this.players.delete(playerId)) return false;
    this.startIfAllReady(now);  // the one who wasn't ready may be the one who left
    return true;
  }

  /** Starts the countdown if two or more are in and all are ready; returns true if it did. */
  startIfAllReady(now) {
    if (this.players.size < 2 || ![...this.players.values()].every((q) => q.ready)) return false;
    this.start(now);
    return true;
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
    return this.startIfAllReady(now);
  }

  /** Compete or collab, in the lobby. A change un-readies everyone, so nobody starts in a mode they didn't agree to. */
  setCollab(playerId, collab, now) {
    if (!this.players.has(playerId)) throw new DuelError("not in this duel");
    if (this.status(now) !== "lobby") throw new DuelError("already started");
    if (this.collab === collab) return;
    this.collab = collab;
    for (const p of this.players.values()) p.ready = false;
  }

  /** Every guess in the room, whoever made it. */
  roomGuesses() {
    return [...this.players.values()].flatMap((p) => p.guesses);
  }

  /** The words that count as already guessed for this player: the room's, in co-op. */
  taken(p) {
    return this.collab ? this.roomGuesses() : p.guesses;
  }

  /** Why this player can't guess this word right now, or null if they can. */
  refusal(playerId, word, now) {
    const p = this.players.get(playerId);
    if (!p) return "not in this duel";
    if (this.status(now) !== "playing" || p.finish) return "not playing";
    if (this.pause()) return "paused";
    if (!/^[a-z][a-z'-]{0,29}$/.test(word)) return "not a word";
    if (this.taken(p).some((g) => g.word === word)) return "already guessed";
    return null;
  }

  /** Why a finished player can't check this word, or null if they can. */
  checkRefusal(playerId, word) {
    const p = this.players.get(playerId);
    if (!p?.finish) return "not finished";
    if (!/^[a-z][a-z'-]{0,29}$/.test(word)) return "not a word";
    if (this.taken(p).some((g) => g.word === word) || p.checks?.some((c) => c.word === word)) return "already guessed";
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

  /** One player's say in a vote of everyone still racing (or of `voters`): the asks after it, and whether that's all of them. */
  vote(asks, playerId, want, now, voters = this.racers(now)) {
    const racing = new Set(voters.map((p) => p.id));
    const next = asks.filter((id) => id !== playerId && racing.has(id));
    if (want) next.push(playerId);
    return [next, racing.size > 0 && [...racing].every((id) => next.includes(id))];
  }

  /** Ask for a hint (or stop asking). Returns true once everyone still racing (or of `voters`) has asked. */
  askHint(playerId, want, now, voters) {
    if (!this.racing(playerId, now)) throw new DuelError("not playing");
    if (this.pause()) throw new DuelError("paused");
    const [asks, all] = this.vote(this.hintAsks, playerId, want, now, voters);
    this.hintAsks = asks;
    return all;
  }

  /** Co-op: ask to give up (or stop asking). Once everyone still racing (or of `voters`) has asked, the round ends for all. */
  askGiveUp(playerId, want, now, voters) {
    if (!this.collab) throw new DuelError("not a co-op round");
    if (!this.racing(playerId, now)) throw new DuelError("not playing");
    const [asks, all] = this.vote(this.giveUpAsks, playerId, want, now, voters);
    this.giveUpAsks = asks;
    if (all) this.finishAll(false, now);
  }

  /**
   * Propose a rematch (`pick`: its puzzle, mode and collab), say yes to the one proposed, or take that back. It's a vote
   * of every player of this round; the proposer taking it back withdraws it. Returns the proposal once all have said yes.
   * A pick while one is already proposed changes nothing: it's no yes to a rematch its sender may not have seen.
   */
  askRematch(playerId, want, pick, now) {
    if (!this.players.has(playerId)) throw new DuelError("not in this duel");
    if (this.next || (pick && this.rematch)) return null;  // already made, or someone proposed first
    if (want && !this.rematch) {
      if (!pick) throw new DuelError("that rematch was withdrawn");
      this.rematch = { by: playerId, ...pick, asks: [] };
    }
    if (!this.rematch) return null;
    const [asks, all] = this.vote(this.rematch.asks, playerId, want, now, [...this.players.values()]);
    this.rematch.asks = asks;
    if (!asks.includes(this.rematch.by)) this.rematch = null;
    return all ? this.rematch : null;
  }

  /** Co-op: the whole room finishes at this moment. */
  finishAll(found, now) {
    for (const p of this.players.values()) p.finish ??= { at: now, found };
    const open = this.pause();
    if (open) open.to = now;
    this.hintAsks = [];
    this.giveUpAsks = [];
  }

  /** The best rank among those still racing (0 if none is in the top 1000): a hint is for them, so it ignores anyone who has solved or given up. Racers can't hold the secret, since guessing it finishes them (co-op: the whole room). */
  bestRank(now) {
    return Math.max(0, ...this.racers(now).flatMap((p) => p.guesses.map((g) => g.rank ?? 0)));
  }

  /** Everyone still racing gets this word as a guess; in co-op, the room's one list gets it once. */
  giveHint(word, { score, rank }, now) {
    if (this.collab) {
      const holder = this.racers(now)[0];  // a hint is nobody's; it has to be stored with someone
      if (holder && !this.roomGuesses().some((g) => g.word === word)) holder.guesses.push({ n: this.roomGuesses().length + 1, word, score, rank, at: now, hint: true });
      this.hintAsks = [];
      return;
    }
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
    p.guesses.push({ n: this.taken(p).length + 1, word, score, rank, at: now });
    if (word !== this.puzzle.secret) return;
    if (this.collab) this.finishAll(true, now);
    else p.finish = { at: now, found: true };
  }

  giveUp(playerId, now) {
    if (this.collab) throw new DuelError("the room votes to give up");
    const p = this.players.get(playerId);
    if (!p || p.finish || this.status(now) !== "playing") throw new DuelError("not playing");
    p.finish = { at: now, found: false };
    const open = this.pause();
    if (open && [...this.players.values()].every((q) => q.finish)) open.to = now;
  }

  /** What one viewer may see: everything once they've finished having played (or it's over), otherwise only scores of others. */
  viewFor(viewerId, now) {
    const status = this.status(now);
    const viewer = this.players.get(viewerId);
    // giving up straight after joining isn't a way to read the word: a give-up counts once you've guessed
    const reveal = status === "over" || this.setter?.id === viewerId || (!!viewer?.finish && (viewer.finish.found || viewer.guesses.some((g) => !g.hint)));
    const ended = status === "over" ? this.endedAt() : now;
    const open = this.pause();
    const mine = new Set(viewer?.guesses.map((g) => g.word));
    return {
      id: this.id,
      number: this.puzzle.number,
      mode: this.puzzle.mode ?? "semantle",
      collab: this.collab,
      setter: this.setter && { name: this.setter.name, you: this.setter.id === viewerId },  // never their id: it would open their view
      status,
      now,
      startsAt: this.startsAt,
      endedAt: status === "over" ? this.endedAt() : null,
      elapsed: this.elapsed(ended),  // the clock as of `now`; it runs on from here unless paused or over
      paused: open ? { by: open.by, from: open.from } : null,
      hintAsks: status === "playing" ? this.hintAsks.filter((id) => !this.players.get(id)?.finish) : [],
      giveUpAsks: status === "playing" ? this.giveUpAsks.filter((id) => !this.players.get(id)?.finish) : [],
      secret: reveal ? this.puzzle.secret : null,
      max: MAX_PLAYERS,
      next: this.next,
      rematch: this.rematch && { by: this.rematch.by, puzzle: this.rematch.puzzle, mode: this.rematch.mode, collab: this.rematch.collab, asks: this.rematch.asks },
      room: this.room,
      you: viewerId,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        ready: !!p.ready,
        finish: p.finish && { ...p.finish, time: this.elapsed(p.finish.at) },
        guesses: p.guesses.map((g) => ({
          n: g.n,
          // an opponent's word shows once you've guessed it too
          word: reveal || this.collab || p.id === viewerId || g.hint || mine.has(g.word) ? g.word : null,
          score: g.score,
          rank: g.rank,
          at: g.at,
          time: this.elapsed(g.at),  // on the round's clock, so the chart leaves out paused time
          hint: !!g.hint,
          // someone else found their own way to this word too (scores give that away anyway)
          shared: !g.hint && [...this.players.values()].some((q) => q !== p && q.guesses.some((h) => h.word === g.word && !h.hint)),
        })),
        checks: reveal || p.id === viewerId ? p.checks ?? [] : [],  // only the finished have any: your own, and everyone's once you see everything
      })),
    };
  }

  toJSON() {
    return { id: this.id, puzzle: this.puzzle, players: [...this.players.values()], startsAt: this.startsAt, createdAt: this.createdAt, next: this.next, rematch: this.rematch, room: this.room, setter: this.setter, pauses: this.pauses, seen: this.seen, hintAsks: this.hintAsks, collab: this.collab, giveUpAsks: this.giveUpAsks };
  }

  static fromJSON(o) {
    const d = new Duel(o.id, o.puzzle, o.createdAt);
    for (const p of o.players) d.players.set(p.id, { finish: null, ...p });
    d.startsAt = o.startsAt;
    d.next = o.next ?? null;
    d.rematch = o.rematch ?? null;
    d.room = o.room ?? o.id;
    d.setter = o.setter ?? null;
    d.pauses = o.pauses ?? [];
    d.seen = o.seen ?? {};
    d.hintAsks = o.hintAsks ?? [];
    d.collab = !!o.collab;
    d.giveUpAsks = o.giveUpAsks ?? [];
    // duels saved before players finished separately: the winner had found it
    if (o.won) {
      const w = d.players.get(o.won.player);
      if (w) w.finish = { at: o.won.at, found: true };
      for (const p of d.players.values()) p.finish ??= { at: o.won.at, found: false };
    }
    return d;
  }
}

/**
 * A room's record over its finished rounds: each player's wins (found it first) and rounds played,
 * and for each pair who played the same round, who placed higher (finding it beats giving up; a faster
 * find beats a slower one; both giving up counts for neither). Co-op rounds are in none of that: they only
 * add to `together`, the words the room has solved as a room. `past` is those finished rounds themselves, co-op
 * too, for the page's list of them: which round of the room, its word, when it started, who found it first.
 * @param {Duel[]} rounds in order
 * @returns {{rounds:number, together:number, players:Record<string,{name:string, wins:number, played:number}>, h2h:Record<string,[number,number]>,
 *   past:{id:string, n:number, number:number|null, secret:string, collab:boolean, start:number, winner:{id:string, name:string, time:number}|null}[]}}
 *   h2h is keyed "a|b" with a < b: [a's wins, b's wins]
 */
export function tally(rounds, now) {
  const players = Object.create(null), h2h = Object.create(null), past = [];  // keyed by player ids, so "__proto__" is just a key
  let n = 0, together = 0;
  for (const [i, d] of rounds.entries()) {
    if (d.status(now) !== "over") continue;  // (so a round still running never gives its word to `past`)
    const ps = [...d.players.values()];
    const found = ps.filter((p) => p.finish?.found).sort((a, b) => a.finish.at - b.finish.at);
    past.push({ id: d.id, n: i + 1, number: d.puzzle.number, secret: d.puzzle.secret, collab: d.collab, start: d.startsAt,
      winner: found[0] ? { id: found[0].id, name: found[0].name, time: d.elapsed(found[0].finish.at) } : null });
    if (d.collab) {
      if (found.length) together++;
      continue;
    }
    n++;
    for (const p of ps) {
      players[p.id] ??= { name: p.name, wins: 0, played: 0 };
      players[p.id].name = p.name;  // the latest
      players[p.id].played++;
    }
    if (found[0]) players[found[0].id].wins++;
    const place = (p) => (p.finish?.found ? found.indexOf(p) : Infinity);
    for (const a of ps) for (const b of ps) {
      if (a.id >= b.id || place(a) === place(b)) continue;
      (h2h[`${a.id}|${b.id}`] ??= [0, 0])[place(a) < place(b) ? 0 : 1]++;
    }
  }
  return { rounds: n, together, players, h2h, past };
}

export class DuelError extends Error {}
