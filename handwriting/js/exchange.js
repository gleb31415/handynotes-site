// Export and import.
//
// An exported file is deliberately *exactly* an upload envelope: the same
// shape the `samples` Edge Function accepts, so a file rescued off a tablet
// can be POSTed later by a one-line script with no reshaping. Extra keys
// (`writer_label`, `exported_at`, …) are metadata the endpoint ignores.

import { writers as writerStore, samples as sampleStore } from './store.js';
import { writerEnvelopeFields, toWire } from './sync.js';
import { PLAN_VERSION } from './tasks.js';

export const APP_VERSION = 'web-1.0.0';

export async function envelopeForWriter(writerID) {
  const writer = await writerStore.get(writerID);
  if (!writer) throw new Error('Писатель не найден');
  const rows = await sampleStore.allForWriter(writerID);
  return {
    ...writerEnvelopeFields(writer),
    schema_version: 'noto-0.1',
    plan_version: PLAN_VERSION,
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
export async function deliver({ name, envelope }, { preferShare = false } = {}) {
  const json = JSON.stringify(envelope);
  const blob = new Blob([json], { type: 'application/json' });

  if (preferShare && navigator.canShare) {
    try {
      const file = new File([blob], name, { type: 'application/json' });
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
    throw new Error('Файл не является JSON');
  }

  const envelopes = Array.isArray(parsed?.writers)
    ? parsed.writers
    : parsed?.writer_id ? [parsed] : null;
  if (!envelopes) throw new Error('Не похоже на экспорт Noto');

  let writersAdded = 0;
  let samplesAdded = 0;

  for (const envelope of envelopes) {
    const writerID = envelope.writer_id;
    if (!writerID) continue;

    const existing = await writerStore.get(writerID);
    const writer = existing ?? {
      writer_id: writerID,
      label: envelope.writer_label || 'Импортирован',
      created_at: envelope.writer_created_at ?? Date.now(),
      consent: {
        granted: true,
        granted_at: envelope.writer_created_at ?? Date.now(),
        text_version: envelope.consent_text_version ?? '0.1',
      },
      input_device: envelope.input_device ?? null,
      can_write_cursive: envelope.can_write_cursive ?? null,
      habitual_script: envelope.habitual_script ?? null,
      progress: { cursor: 0, written_count: 0, asked_cursive: false, asked_habit: false, started_at: Date.now(), finished_at: null },
    };
    if (!existing) writersAdded += 1;

    const incoming = Array.isArray(envelope.samples) ? envelope.samples : [];
    const known = new Set(await sampleStore.idsForWriter(writerID));
    const fresh = [];
    for (const sample of incoming) {
      if (!sample?.sample_id || known.has(sample.sample_id)) continue;
      fresh.push({ ...sample, writer_id: writerID, sync: 'pending' });
    }
    if (fresh.length > 0) await sampleStore.putMany(fresh);
    samplesAdded += fresh.length;

    // The cursor follows the words: whoever holds the file holds the run, and
    // it must not restart at task 1 while 300 samples already exist.
    const total = (await sampleStore.countForWriter(writerID));
    const highestOrder = incoming.reduce((max, s) => Math.max(max, s.order ?? 0), 0);
    writer.progress = writer.progress ?? {};
    writer.progress.cursor = Math.max(writer.progress.cursor ?? 0, highestOrder);
    writer.progress.written_count = Math.max(writer.progress.written_count ?? 0, total);
    await writerStore.put(writer);
  }

  return { writersAdded, samplesAdded };
}

function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'writer';
}
