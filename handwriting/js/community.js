// The community counter: how many people already write for the next model,
// and this device's writers joining them.
//
// The same figure the app prints (`HandwritingCommunityStats.round` in
// HandwritingCommunity.swift), computed the same way so the browser and the
// app never disagree:
//
//   count  = FOUNDING_CONTRIBUTORS (3, the people who wrote the first words
//            before the live pipeline existed)
//          + the server's real contributor count (0 whenever the `community`
//            function is unreachable or not deployed — never an error)
//          + 1 for each writer of this device who reached the goal but whom
//            the server has not confirmed yet;
//   every  = `next_model_every` from the server, else ru 20 / en 30;
//   target = (floor(count / every) + 1) · every, and the bar is the position
//            inside the current window of `every`.
//
// The server keeps returning the real number; the offset lives only here.
//
// A writer JOINS a language on first reaching its goal (ru 150 / en 200
// prompted words of that language) with full consent and uploading on. The
// join is persisted per writer and language in `meta`
// (`community:<writer_id>:<lang>`), the page plays the "you're in" moment
// once, and the server is told — POST {writer_id, language} after the queue
// drained; its answer carries fresh numbers and whether it now counts the
// writer. A function that does not take POST (yet) is answered with a
// cache-bypassing GET instead, and the local +1 stays until the server
// confirms.

import { SERVER } from './sync.js';
import { meta } from './store.js';

export const FOUNDING_CONTRIBUTORS = 3;
/// Prompted words of a language that make a writer a contributor — the
/// app's `HandwritingGenerationLanguage.requiredWords` and the server's
/// `community_contributors()` thresholds.
export const GOAL_WORDS = Object.freeze({ ru: 150, en: 200 });
/// Offline copy of the server's `next_model_every`.
export const CONTRIBUTORS_PER_RELEASE = Object.freeze({ ru: 20, en: 30 });

const COMMUNITY_URL = () => `${SERVER.projectURL}/functions/v1/community`;
const FETCH_TIMEOUT_MS = 8_000;
/// An answer is trusted this long before a plain refresh asks again (the
/// function itself caches for five minutes on top).
const CACHE_LIFETIME_MS = 10 * 60 * 1000;
/// A writer the server has not confirmed yet is re-announced at most this
/// often (after every drain that emptied their queue, say).
const PING_INTERVAL_MS = 60 * 1000;

/// The figure one language prints. Mirrors `HandwritingCommunityRound`.
export function roundFor(count, every) {
  const c = Math.max(0, Math.trunc(Number(count) || 0));
  const e = Math.max(1, Math.trunc(Number(every) || 1));
  const target = (Math.floor(c / e) + 1) * e;
  const windowStart = target - e;
  return { count: c, every: e, target, windowStart, fraction: (c - windowStart) / e, remaining: target - c };
}

function joinKey(writerID, language) {
  return `community:${writerID}:${language}`;
}

function authHeaders(extra = {}) {
  return {
    ...extra,
    apikey: SERVER.publishableKey,
    Authorization: `Bearer ${SERVER.publishableKey}`,
  };
}

async function fetchWithTimeout(url, options) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

/// `{ ru: { contributors, every }, en: … }` from a `languages` object; junk
/// in, nothing out — a malformed answer must never become a number on screen.
function parseLanguages(languages) {
  const out = {};
  if (!languages || typeof languages !== 'object') return out;
  for (const lang of ['ru', 'en']) {
    const row = languages[lang];
    if (!row || typeof row !== 'object') continue;
    const contributors = Math.max(0, Math.trunc(Number(row.contributors)) || 0);
    const every = Math.trunc(Number(row.next_model_every));
    out[lang] = { contributors, every: every > 0 ? every : null };
  }
  return out;
}

/// Emits `change` whenever a number any page prints may have moved.
export class Community extends EventTarget {
  constructor() {
    super();
    /// Server numbers by language; empty until a fetch succeeds.
    this.byLanguage = {};
    this.loadedAt = 0;
    this._inflight = null;
    /// `<writer_id>:<lang>` → { joined_at, server_counts_writer, celebrated, last_ping_at }.
    this.joins = new Map();
    this._pinging = new Set();
  }

  _emit() { this.dispatchEvent(new Event('change')); }

  // MARK: Joins (persisted)

  /// Reads the join records of these writers (boot, import).
  async loadJoins(writerIDs) {
    for (const writerID of writerIDs) {
      for (const lang of ['ru', 'en']) {
        const record = await meta.get(joinKey(writerID, lang), null);
        if (record && typeof record === 'object') this.joins.set(`${writerID}:${lang}`, record);
        else this.joins.delete(`${writerID}:${lang}`);
      }
    }
    this._emit();
  }

  join(writerID, language) {
    return this.joins.get(`${writerID}:${language}`) ?? null;
  }

  hasJoined(writerID, language) {
    return this.join(writerID, language) !== null;
  }

  async _save(writerID, language, record) {
    this.joins.set(`${writerID}:${language}`, record);
    try { await meta.set(joinKey(writerID, language), record); } catch { /* kept in memory for this visit */ }
    this._emit();
  }

  /// The writer reached the goal: remembered before anything else happens,
  /// so a reload mid-way still counts them and still owes them the moment.
  async recordJoin(writerID, language) {
    const record = { joined_at: Date.now(), server_counts_writer: false, celebrated: false, last_ping_at: 0 };
    await this._save(writerID, language, record);
    return record;
  }

  async markCelebrated(writerID, language) {
    const record = this.join(writerID, language);
    if (!record || record.celebrated) return;
    await this._save(writerID, language, { ...record, celebrated: true });
  }

  /// A deleted writer's records are gone from `meta` already (store.js);
  /// this drops them from memory.
  forget(writerID) {
    for (const lang of ['ru', 'en']) this.joins.delete(`${writerID}:${lang}`);
    this._emit();
  }

  forgetAll() {
    this.joins.clear();
    this._emit();
  }

  // MARK: The figure

  /// Writers of this device who joined `language` and are not counted by the
  /// server yet — each is a real contributor the server does not show.
  localBonus(language, writerIDs) {
    let bonus = 0;
    for (const writerID of writerIDs) {
      const record = this.join(writerID, language);
      if (record && record.server_counts_writer !== true) bonus += 1;
    }
    return bonus;
  }

  every(language) {
    return this.byLanguage[language]?.every ?? CONTRIBUTORS_PER_RELEASE[language] ?? 20;
  }

  /// What every page prints for `language`, with this device's writers.
  round(language, writerIDs = []) {
    const real = this.byLanguage[language]?.contributors ?? 0;
    return roundFor(FOUNDING_CONTRIBUTORS + real + this.localBonus(language, writerIDs), this.every(language));
  }

  // MARK: Network

  /// GET the numbers unless a fresh answer is here. `force` bypasses both the
  /// age check and the HTTP cache. Never throws: a failure keeps what was
  /// there (nothing, on a first visit — the count is then 3 + locals).
  async refresh({ force = false } = {}) {
    if (!force && this.loadedAt && Date.now() - this.loadedAt < CACHE_LIFETIME_MS) return;
    if (this._inflight) {
      if (!force) return this._inflight;
      // A forced refresh must not ride on a GET that may be answered from
      // the HTTP cache (five minutes stale): it waits for it, then asks
      // again with no-store — unless another forced one started meanwhile.
      const running = this._inflight;
      await running;
      if (this._inflight && this._inflight !== running) return this._inflight;
    }
    this._inflight = (async () => {
      try {
        const response = await fetchWithTimeout(COMMUNITY_URL(), {
          method: 'GET',
          headers: authHeaders(),
          cache: force ? 'no-store' : 'default',
        });
        if (!response.ok) return;
        const body = await response.json().catch(() => null);
        const parsed = parseLanguages(body?.languages);
        if (Object.keys(parsed).length === 0) return;
        this.byLanguage = { ...this.byLanguage, ...parsed };
        this.loadedAt = Date.now();
        this._emit();
      } catch {
        // Offline, not deployed, blocked — the page just shows the floor.
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  }

  /// True when `writerID` should be announced for `language` now.
  shouldPing(writerID, language) {
    const record = this.join(writerID, language);
    if (!record || record.server_counts_writer === true) return false;
    if (this._pinging.has(`${writerID}:${language}`)) return false;
    return Date.now() - (record.last_ping_at ?? 0) >= PING_INTERVAL_MS;
  }

  /// Tells the `community` function this writer reached the goal (the
  /// caller drains the upload queue first — the server counts only words
  /// that arrived). Its answer carries fresh numbers for everyone and
  /// whether it now counts this writer; a function that doesn't take the
  /// POST is replaced by a cache-bypassing GET.
  async ping(writerID, language) {
    const key = `${writerID}:${language}`;
    // Checked again here, not only by the caller: two callers that both
    // waited for a drain must not both announce.
    if (!this.shouldPing(writerID, language)) return;
    const record = this.join(writerID, language);
    this._pinging.add(key);
    try {
      await this._save(writerID, language, { ...record, last_ping_at: Date.now() });
      let answered = false;
      try {
        const response = await fetchWithTimeout(COMMUNITY_URL(), {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ writer_id: writerID, language }),
          cache: 'no-store',
        });
        if (response.ok) {
          const body = await response.json().catch(() => null);
          const parsed = parseLanguages(body?.languages);
          if (Object.keys(parsed).length > 0) {
            this.byLanguage = { ...this.byLanguage, ...parsed };
            this.loadedAt = Date.now();
            answered = true;
          }
          if (body?.writer?.reached === true) {
            const latest = this.join(writerID, language) ?? record;
            await this._save(writerID, language, { ...latest, server_counts_writer: true });
          }
          this._emit();
        }
      } catch {
        // Not deployed / no POST / offline — the GET below still refreshes.
      }
      if (!answered) await this.refresh({ force: true });
    } finally {
      this._pinging.delete(key);
    }
  }
}
