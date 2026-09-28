// Upload queue for the Supabase `samples` Edge Function.
//
// Same endpoint, same envelope and same batching rules as the iOS client:
// small batches, because one bulk upsert of a whole backlog exceeds Postgres'
// 8s statement timeout, gets cancelled, and leaves the client believing
// nothing landed — which is how a queue becomes permanently stuck.
//
// Nothing is ever deleted locally after an upload. A sample that reached the
// server is marked `sent` and stays on the device, exportable and re-sendable.

import { samples as sampleStore, writers as writerStore, meta } from './store.js';
import { t } from './i18n.js';

export const SERVER = {
  projectURL: 'https://mfnnodremhlvdkjjqqew.supabase.co',
  // Public publishable (anon) key — the same rotatable client credential the
  // app ships. The function itself runs with JWT verification off.
  publishableKey: 'sb_publishable_isrN_bmBGuzZ8PakbkvX9Q_tcZ87m_I',
};

const BATCH_SIZE = 25;
const MAX_BATCH_BYTES = 1_200_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 300_000;
/// Consent text that first covers math symbols. Symbol samples of a writer
/// who agreed only to an older text wait in the queue (never dropped) until
/// the writer agrees to this one.
export const GLYPH_CONSENT_VERSION = '0.2';

/// Consent text that adds the age confirmation (18+). Nothing of a writer
/// leaves the device until they agreed to it AND confirmed their age.
export const ADULT_CONSENT_VERSION = '0.3';

/// Has this writer agreed to (at least) this version of the consent text?
/// Versions compare as numbers, so 0.3 covers everything 0.2 covered.
export function consentCovers(writer, version) {
  if (!writer?.consent?.granted) return false;
  const given = parseFloat(writer.consent.text_version ?? '0');
  return Number.isFinite(given) && given >= parseFloat(version);
}

/// The one gate for writing, uploading and joining the community: consent to
/// the current text with the writer's own confirmation of being 18 or older.
/// A writer who agreed before the age question existed keeps everything
/// they wrote, queued, until they confirm.
export function consentAllowsUpload(writer) {
  return consentCovers(writer, ADULT_CONSENT_VERSION) && writer.consent.adult === true;
}

/// Local-only bookkeeping that must not travel to the server or into exports.
const LOCAL_FIELDS = new Set(['sync', 'uploaded_at', 'writer_label']);

export function toWire(sample) {
  const wire = {};
  for (const [key, value] of Object.entries(sample)) {
    if (!LOCAL_FIELDS.has(key)) wire[key] = value;
  }
  return wire;
}

/// The writer half of an envelope. Answers that were never given are left out
/// entirely: sending them as null would erase answers already on the server.
export function writerEnvelopeFields(writer, { retire = false } = {}) {
  const fields = {
    writer_id: writer.writer_id,
    consent_text_version: writer.consent?.text_version ?? '0.1',
    capture_from_notes: false,
  };
  if (writer.can_write_cursive) fields.can_write_cursive = writer.can_write_cursive;
  if (writer.input_device) fields.input_device = writer.input_device;
  if (writer.habitual_script) fields.habitual_script = writer.habitual_script;
  // The collection language the writer is on (the server keeps the latest);
  // every sample also carries its own `language`.
  if (writer.task_language === 'ru' || writer.task_language === 'en') fields.task_language = writer.task_language;
  if (retire) fields.retire_writer = true;
  return fields;
}

export function envelopeFor(writer, rows, options) {
  return { ...writerEnvelopeFields(writer, options), samples: rows.map(toWire) };
}

export class SyncEngine extends EventTarget {
  constructor() {
    super();
    this.enabled = true;
    this.running = false;
    /// { key, vars } of a dictionary message, or { text } of a raw one —
    /// worded on read, so the chip follows a language switch.
    this._error = null;
    this.lastSuccessAt = null;
    this.progress = null;
    this.failures = 0;
    this._retryTimer = null;
    this._rerun = false;

    addEventListener('online', () => this.drain());
  }

  async loadSettings() {
    this.enabled = await meta.get('upload_enabled', true) !== false;
    this.lastSuccessAt = await meta.get('last_upload_at', null);
  }

  async setEnabled(value) {
    this.enabled = value;
    await meta.set('upload_enabled', value);
    this._emit();
    if (value) this.drain();
  }

  get isOnline() { return navigator.onLine !== false; }

  /// The last error in the current interface language, or null.
  get lastError() {
    if (!this._error) return null;
    return this._error.key ? t(this._error.key, this._error.vars) : this._error.text;
  }

  _emit() { this.dispatchEvent(new Event('change')); }

  _scheduleRetry() {
    if (this._retryTimer) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(this.failures, 6));
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.drain();
    }, delay);
  }

  /// Walks every writer's backlog. Safe to call from anywhere at any time:
  /// a call while a drain is in flight just asks for one more pass after it.
  async drain({ writers = null } = {}) {
    if (!this.enabled) return;
    if (this.running) { this._rerun = true; return; }
    if (!this.isOnline) {
      this._error = { key: 'sync.noNetwork' };
      this._emit();
      return;
    }

    this.running = true;
    this._error = null;
    this._emit();

    try {
      const roster = writers ?? await writerStore.all();
      for (const writer of roster) {
        // No upload without consent to the current text AND the 18+
        // confirmation; the writer's samples stay queued, never dropped.
        if (!consentAllowsUpload(writer)) continue;
        await this._drainWriter(writer);
      }
    } catch (error) {
      this._error = { text: error?.message ?? String(error) };
    } finally {
      this.running = false;
      this.progress = null;
      this._emit();
    }

    if (this._rerun) {
      this._rerun = false;
      // Samples saved while the drain was running deserve the same trip.
      setTimeout(() => this.drain(), 800);
    }
  }

  async _drainWriter(writer) {
    let pending = await sampleStore.pendingForWriter(writer.writer_id);
    if (!consentCovers(writer, GLYPH_CONSENT_VERSION)) {
      pending = pending.filter((s) => s.sample_type !== 'prompted_glyph');
    }
    if (pending.length === 0) return;

    const total = pending.length;
    let sent = 0;

    while (pending.length > 0) {
      const batch = takeBatch(pending);
      pending = pending.slice(batch.length);

      const outcome = await this._upload(writer, batch);
      if (outcome.ok) {
        const accepted = batch
          .map((s) => s.sample_id)
          .filter((id) => outcome.statuses[id] === 'in_dataset');
        if (accepted.length > 0) await sampleStore.markSent(accepted);
        sent += accepted.length;
        this.failures = 0;
        this.lastSuccessAt = Date.now();
        await meta.set('last_upload_at', this.lastSuccessAt);
        this.progress = { sent, total };
        this._emit();
        if (accepted.length < batch.length) {
          // The server took part of the batch; the rest stays queued and
          // rides the next pass rather than being retried in a tight loop.
          this._error = { key: 'sync.partial' };
          this._scheduleRetry();
          return;
        }
      } else {
        this.failures += 1;
        this._error = outcome.error;
        this._scheduleRetry();
        return;
      }
    }
  }

  async _upload(writer, batch) {
    const url = `${SERVER.projectURL}/functions/v1/samples`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SERVER.publishableKey,
          Authorization: `Bearer ${SERVER.publishableKey}`,
        },
        body: JSON.stringify(envelopeFor(writer, batch)),
      });
      if (!response.ok) {
        return { ok: false, error: { key: 'sync.status', vars: { status: response.status } } };
      }
      const body = await response.json().catch(() => ({}));
      return { ok: true, statuses: body.statuses ?? {} };
    } catch (error) {
      return { ok: false, error: { key: 'sync.unreachable' } };
    }
  }

  /// Resolves once no drain is running (or after `timeoutMs`, whichever is
  /// first) — for a caller that must know the queue went out before it
  /// speaks to the server (the community announcement).
  async whenIdle(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while ((this.running || this._rerun) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /// Best-effort "this writer is done" stamp. A failure costs the server a
  /// `retired_at` and nothing else, so it never blocks the handover.
  async retire(writer) {
    if (!this.enabled || !this.isOnline || !consentAllowsUpload(writer)) return false;
    const url = `${SERVER.projectURL}/functions/v1/samples`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SERVER.publishableKey,
          Authorization: `Bearer ${SERVER.publishableKey}`,
        },
        body: JSON.stringify(envelopeFor(writer, [], { retire: true })),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/// Takes as many samples as fit both caps — count and payload size. Long words
/// are fat rows, and 25 of them can add up to a write slow enough to time out.
function takeBatch(pending) {
  const batch = [];
  let bytes = 0;
  for (const sample of pending) {
    const size = estimateBytes(sample);
    if (batch.length > 0 && (batch.length >= BATCH_SIZE || bytes + size > MAX_BATCH_BYTES)) break;
    batch.push(sample);
    bytes += size;
  }
  return batch;
}

function estimateBytes(sample) {
  // ~26 bytes per point in the JSON encoding, plus room for the metadata.
  let points = 0;
  for (const stroke of sample.strokes ?? []) points += stroke.points.length;
  return 600 + points * 26;
}
