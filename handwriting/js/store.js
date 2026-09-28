// Local persistence: IndexedDB, written to on every meaningful edit.
//
// The whole point of this layer is that a reload is a non-event. A sample is
// durable the moment the writer taps "Готово" — before any upload is tried —
// and the half-written word on the canvas is checkpointed too, so a browser
// that reloads (iOS discards backgrounded tabs aggressively) comes back to the
// same ink on the same task.

import { t } from './i18n.js';

const DB_NAME = 'noto-collect';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('writers')) {
        db.createObjectStore('writers', { keyPath: 'writer_id' });
      }
      if (!db.objectStoreNames.contains('samples')) {
        const samples = db.createObjectStore('samples', { keyPath: 'sample_id' });
        samples.createIndex('writer_id', 'writer_id', { unique: false });
        // Composite index: "this writer's still-unsent rows" is the only query
        // the sync queue ever runs, and it must not walk the whole dataset.
        samples.createIndex('writer_sync', ['writer_id', 'sync'], { unique: false });
        samples.createIndex('sync', 'sync', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(t('store.blocked')));
  });
  return dbPromise;
}

/// Runs `fn` inside one transaction and settles when the transaction commits.
/// `fn` may return a promise over a request result; resolving with it adopts
/// the value, so callers get the row rather than the transaction.
function tx(storeName, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    let result;
    try {
      result = fn(transaction.objectStore(storeName));
    } catch (error) {
      try { transaction.abort(); } catch { /* already dead */ }
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error(t('store.aborted')));
  }));
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// MARK: - Writers

export const writers = {
  async all() {
    const list = await tx('writers', 'readonly', (s) => req(s.getAll()));
    return list.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  },

  async get(id) {
    return tx('writers', 'readonly', (s) => req(s.get(id)));
  },

  async put(writer) {
    await tx('writers', 'readwrite', (s) => s.put(writer));
    return writer;
  },

  /// Removing a writer removes their ink with them — there is no orphaned
  /// trajectory left addressable by a `writer_id` nothing points at.
  async remove(id) {
    const ids = await samples.idsForWriter(id);
    await tx('samples', 'readwrite', (s) => { for (const sampleID of ids) s.delete(sampleID); });
    await tx('writers', 'readwrite', (s) => s.delete(id));
    // Everything keyed by the writer in meta goes with them: every draft
    // (Russian words, English words, symbols), the «Решение почерком» screen
    // (pasted answer, knobs) and the community join records.
    const keys = [
      `draft:${id}`, `draft:${id}:en`, `draft:${id}:glyphs`, `draft:${id}:glyphs:target`, `compose:${id}`,
      `community:${id}:ru`, `community:${id}:en`,
    ];
    for (const key of keys) await meta.remove(key);
  },
};

// MARK: - Samples

export const samples = {
  async put(sample) {
    await tx('samples', 'readwrite', (s) => s.put(sample));
    return sample;
  },

  async putMany(list) {
    await tx('samples', 'readwrite', (s) => { for (const sample of list) s.put(sample); });
  },

  async get(id) {
    return tx('samples', 'readonly', (s) => req(s.get(id)));
  },

  async remove(id) {
    await tx('samples', 'readwrite', (s) => s.delete(id));
  },

  async allForWriter(id) {
    const list = await tx('samples', 'readonly', (s) => req(s.index('writer_id').getAll(id)));
    return list.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  },

  async idsForWriter(id) {
    return tx('samples', 'readonly', (s) => req(s.index('writer_id').getAllKeys(id)));
  },

  async countForWriter(id) {
    return tx('samples', 'readonly', (s) => req(s.index('writer_id').count(id)));
  },

  /// Words and math symbols counted apart, plus the delivery `order`s of the
  /// symbols already written, plus per collection language (ru / en) the
  /// words (`wordsByLang`) and the prompted words that count toward the
  /// community goal (`goalByLang`). A word without `language` predates
  /// English and is Russian. There is deliberately no index on
  /// `sample_type` (it would cost a schema migration on every device in the
  /// field for a number the app needs once per writer per boot): this walks
  /// the writer's rows with a cursor and the caller caches the answer,
  /// re-running it only when the cheap indexed `countForWriter` changes.
  /// A row without `sample_type` predates symbols and is a word.
  async summaryForWriter(id) {
    return tx('samples', 'readonly', (s) => new Promise((resolve, reject) => {
      const summary = {
        total: 0, words: 0, glyphs: 0, glyphOrders: [],
        wordsByLang: { ru: 0, en: 0 }, goalByLang: { ru: 0, en: 0 },
      };
      const request = s.index('writer_id').openCursor(IDBKeyRange.only(id));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(summary); return; }
        const row = cursor.value;
        summary.total += 1;
        if (row.sample_type === 'prompted_glyph') {
          summary.glyphs += 1;
          if (row.order > 0) summary.glyphOrders.push(row.order);
        } else {
          summary.words += 1;
          const lang = wordLanguage(row);
          if (lang) {
            summary.wordsByLang[lang] += 1;
            if (isGoalWord(row)) summary.goalByLang[lang] += 1;
          }
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    }));
  },

  /// Unsent rows for one writer, oldest first — the upload queue in order.
  async pendingForWriter(id, limit = Infinity) {
    const range = IDBKeyRange.only([id, 'pending']);
    const list = await tx('samples', 'readonly', (s) => req(s.index('writer_sync').getAll(range)));
    const rows = list.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
  },

  async pendingCountForWriter(id) {
    return tx('samples', 'readonly', (s) =>
      req(s.index('writer_sync').count(IDBKeyRange.only([id, 'pending']))));
  },

  async pendingCount() {
    return tx('samples', 'readonly', (s) => req(s.index('sync').count('pending')));
  },

  async totalCount() {
    return tx('samples', 'readonly', (s) => req(s.count()));
  },

  /// Flip a batch to `sent` in one transaction, so a crash mid-way can only
  /// ever leave rows queued again — never silently dropped.
  async markSent(ids, at = Date.now()) {
    await tx('samples', 'readwrite', (store) => {
      for (const id of ids) {
        const request = store.get(id);
        request.onsuccess = () => {
          const row = request.result;
          if (!row) return;
          row.sync = 'sent';
          row.uploaded_at = at;
          store.put(row);
        };
      }
    });
  },

  /// Re-queues everything a writer has, for a re-send after a server wipe.
  async requeueForWriter(id) {
    const ids = await samples.idsForWriter(id);
    await tx('samples', 'readwrite', (store) => {
      for (const sampleID of ids) {
        const request = store.get(sampleID);
        request.onsuccess = () => {
          const row = request.result;
          if (!row) return;
          row.sync = 'pending';
          store.put(row);
        };
      }
    });
    return ids.length;
  },
};

/// 'ru' | 'en' for a word sample, null for any other language. A word saved
/// before English existed carries 'ru' or nothing, and is Russian.
export function wordLanguage(row) {
  if (row.language === 'en') return 'en';
  if (row.language == null || row.language === 'ru') return 'ru';
  return null;
}

/// A word that counts toward the community goal: a prompted word — the
/// server's `community_contributors()` counts `sample_type = 'prompted_word'`.
/// A row without `sample_type` predates symbols; it is a prompted word when
/// its label came from the prompt.
export function isGoalWord(row) {
  return row.sample_type === 'prompted_word' || (!row.sample_type && row.label_source === 'prompt');
}

// MARK: - Meta (settings, cursor of the active writer, canvas drafts)

export const meta = {
  async get(key, fallback = null) {
    const row = await tx('meta', 'readonly', (s) => req(s.get(key)));
    return row === undefined || row === null ? fallback : row.value;
  },

  async set(key, value) {
    await tx('meta', 'readwrite', (s) => s.put({ key, value }));
    return value;
  },

  async remove(key) {
    await tx('meta', 'readwrite', (s) => s.delete(key));
  },
};

// MARK: - Housekeeping

/// Best-effort persistent storage: without it a browser under disk pressure
/// may evict the database, and an evicted database is a lost collection run.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* not fatal */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage?.estimate) return await navigator.storage.estimate();
  } catch { /* not fatal */ }
  return { usage: 0, quota: 0 };
}

export async function wipeEverything() {
  await tx('samples', 'readwrite', (s) => s.clear());
  await tx('writers', 'readwrite', (s) => s.clear());
  await tx('meta', 'readwrite', (s) => s.clear());
}
