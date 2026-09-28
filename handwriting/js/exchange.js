// Export and import.
//
// An exported file is deliberately *exactly* an upload envelope: the same
// shape the `samples` Edge Function accepts, so a file rescued off a tablet
// can be POSTed later by a one-line script with no reshaping. Extra keys
// (`writer_label`, `exported_at`, `consent_adult`, …) are metadata the
// endpoint ignores.

import { writers as writerStore, samples as sampleStore, wordLanguage } from './store.js';
import { writerEnvelopeFields, toWire, ADULT_CONSENT_VERSION } from './sync.js';
import { PLAN_VERSION, PLAN_VERSIONS } from './tasks.js';
import { UUID_RE } from './util.js';
import { t } from './i18n.js';

export const APP_VERSION = 'web-1.1.0';

export async function envelopeForWriter(writerID) {
  const writer = await writerStore.get(writerID);
  if (!writer) throw new Error(t('import.writerMissing'));
  const rows = await sampleStore.allForWriter(writerID);
  return {
    ...writerEnvelopeFields(writer),
    // Export-only: the writer confirmed being 18+ here, so an import on
    // another device need not ask again. Never part of an upload.
    consent_adult: writer.consent?.adult === true,
    schema_version: 'noto-0.1',
    // `plan_version` stays the Russian plan it always named; a sample's own
    // `prompt_id` says which plan it came from.
    plan_version: PLAN_VERSION,
    plan_versions: PLAN_VERSIONS,
    app_version: APP_VERSION,
    writer_label: writer.label ?? null,
    writer_created_at: writer.created_at ?? null,
    exported_at: Date.now(),
    sample_count: rows.length,
    samples: rows.map(toWire),
  };
}

export async function exportWriter(writerID) {
  const envelope = await envelopeForWriter(writerID);
  const label = slug(envelope.writer_label || 'writer');
  const name = `noto-${label}-${String(writerID).slice(0, 8)}.json`;
  return { name, envelope };
}

export async function exportAll() {
  const roster = await writerStore.all();
  const envelopes = [];
  for (const writer of roster) envelopes.push(await envelopeForWriter(writer.writer_id));
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    name: `noto-collection-${stamp}.json`,
    envelope: {
      schema_version: 'noto-0.1',
      plan_version: PLAN_VERSION,
      plan_versions: PLAN_VERSIONS,
      app_version: APP_VERSION,
      exported_at: Date.now(),
      writer_count: envelopes.length,
      sample_count: envelopes.reduce((n, e) => n + e.samples.length, 0),
      writers: envelopes,
    },
  };
}

/// Hands the file to the OS. `download` covers desktop and Android; iOS Safari
/// honours it too, but the share sheet is the gesture people there expect, so
/// it is offered when the platform can take a file.
///
/// Takes either `{ name, envelope }` (serialised as JSON — the export path) or
/// `{ name, blob }` for anything already made (PNG/SVG of a rendered page), so
/// every file the app hands out goes through the same share-or-download rule.
export async function deliver({ name, envelope, blob: given = null }, { preferShare = false } = {}) {
  const blob = given instanceof Blob
    ? given
    : new Blob([JSON.stringify(envelope)], { type: 'application/json' });
  const type = blob.type || 'application/octet-stream';

  if (preferShare && navigator.canShare) {
    try {
      const file = new File([blob], name, { type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return { method: 'share', bytes: blob.size };
      }
    } catch (error) {
      // A cancelled share sheet is not a failure worth reporting as one.
      if (error?.name === 'AbortError') return { method: 'cancelled', bytes: blob.size };
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { method: 'download', bytes: blob.size };
}

/// Merges an exported file back in — the path for moving a tablet's run onto
/// another device. Samples arrive queued: an upload is an upsert keyed by
/// `sample_id`, so re-sending one the server already has changes nothing.
export async function importFile(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(t('import.notJson'));
  }

  const envelopes = Array.isArray(parsed?.writers)
    ? parsed.writers
    : parsed?.writer_id ? [parsed] : null;
  if (!envelopes) throw new Error(t('import.notExport'));

  let writersAdded = 0;
  let samplesAdded = 0;

  for (const envelope of envelopes) {
    const writerID = envelope.writer_id;
    // Ids end up in the roster's markup and in IndexedDB keys; a file from a
    // messenger is untrusted, so anything but a real UUID is passed over.
    if (typeof writerID !== 'string' || !UUID_RE.test(writerID)) continue;

    const existing = await writerStore.get(writerID);
    const writer = existing ?? {
      writer_id: writerID,
      label: envelope.writer_label || t('import.defaultLabel'),
      created_at: envelope.writer_created_at ?? Date.now(),
      consent: {
        granted: true,
        granted_at: envelope.writer_created_at ?? Date.now(),
        text_version: envelope.consent_text_version ?? '0.1',
      },
      input_device: envelope.input_device ?? null,
      can_write_cursive: envelope.can_write_cursive ?? null,
      habitual_script: envelope.habitual_script ?? null,
      progress: {
        cursor: 0, written_count: 0, cursor_en: 0, written_count_en: 0,
        glyph_cursor: 0, glyph_written_count: 0,
        asked_cursive: false, asked_habit: false, started_at: Date.now(), finished_at: null,
      },
    };
    if (envelope.task_language === 'ru' || envelope.task_language === 'en') {
      writer.task_language = writer.task_language ?? envelope.task_language;
    }
    if (!existing) writersAdded += 1;
    else raiseConsent(writer, envelope);
    adoptAdult(writer, envelope);

    const incoming = Array.isArray(envelope.samples) ? envelope.samples : [];
    const known = new Set(await sampleStore.idsForWriter(writerID));
    const fresh = [];
    for (const sample of incoming) {
      if (typeof sample?.sample_id !== 'string' || !UUID_RE.test(sample.sample_id) || known.has(sample.sample_id)) continue;
      fresh.push({ ...sample, writer_id: writerID, sync: 'pending' });
    }
    if (fresh.length > 0) await sampleStore.putMany(fresh);
    samplesAdded += fresh.length;

    // The cursors follow the samples: whoever holds the file holds the run,
    // and it must not restart at task 1 while 300 samples already exist.
    // Words and symbols are two separate deliveries with their own `order`
    // numbering, so each cursor is taken only from its own kind — a symbol at
    // order 480 must not push the WORD cursor past 480 words never written.
    // Symbols written out of turn from «Решение почерком» (`glyph_targeted`)
    // carry the order of a slot still AHEAD of the cursor; they don't move it
    // either (the writing screen steps over such a slot when it gets there).
    // Russian and English words are two deliveries as well, each with its
    // own cursor (`cursor` — Russian, as it always was — and `cursor_en`).
    const summary = await sampleStore.summaryForWriter(writerID);
    const isWord = (s) => !s.sample_type || s.sample_type === 'prompted_word';
    const highestWord = highestOrder(incoming, (s) => isWord(s) && wordLanguage(s) === 'ru');
    const highestWordEN = highestOrder(incoming, (s) => isWord(s) && wordLanguage(s) === 'en');
    const highestGlyph = highestOrder(incoming, (s) => s.sample_type === 'prompted_glyph' && !s.glyph_targeted);
    writer.progress = writer.progress ?? {};
    writer.progress.cursor = Math.max(writer.progress.cursor ?? 0, highestWord);
    writer.progress.written_count = Math.max(writer.progress.written_count ?? 0, summary.wordsByLang.ru);
    writer.progress.cursor_en = Math.max(writer.progress.cursor_en ?? 0, highestWordEN);
    writer.progress.written_count_en = Math.max(writer.progress.written_count_en ?? 0, summary.wordsByLang.en);
    writer.progress.glyph_cursor = Math.max(writer.progress.glyph_cursor ?? 0, highestGlyph);
    writer.progress.glyph_written_count = Math.max(writer.progress.glyph_written_count ?? 0, summary.glyphs);
    await writerStore.put(writer);
  }

  return { writersAdded, samplesAdded };
}

/// The same person's consent, given on the other device: a file written
/// under a newer consent text (e.g. 0.2, which covers symbols) raises the
/// writer's recorded version here too — otherwise its symbol samples would
/// travel under the older text. A version is never lowered. The file carries
/// no consent timestamp; it was given by the time the file was exported.
function raiseConsent(writer, envelope) {
  const incoming = envelope.consent_text_version;
  if (typeof incoming !== 'string' || !Number.isFinite(parseFloat(incoming))) return;
  const current = writer.consent?.granted ? parseFloat(writer.consent.text_version ?? '0') : -Infinity;
  if (!(parseFloat(incoming) > current)) return;
  writer.consent = {
    granted: true,
    granted_at: Number(envelope.exported_at) || Date.now(),
    text_version: incoming,
    // Age does not go backwards: a confirmation given here survives a file
    // written under a newer text.
    adult: writer.consent?.adult === true,
  };
}

/// The 18+ confirmation travels with an export (`consent_adult`). It is
/// taken over only together with a consent text that asks for it — a file
/// from before the age question can't vouch for an age nobody was asked.
function adoptAdult(writer, envelope) {
  if (envelope.consent_adult !== true || !writer.consent?.granted) return;
  const version = parseFloat(writer.consent.text_version ?? '0');
  if (Number.isFinite(version) && version >= parseFloat(ADULT_CONSENT_VERSION)) writer.consent.adult = true;
}

function highestOrder(samples, accept) {
  return samples.reduce((max, s) => (accept(s) ? Math.max(max, Number(s.order) || 0) : max), 0);
}

export function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'writer';
}
