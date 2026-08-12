// The shared Russian core and the per-writer delivery order.
//
// A JS port of `HandwritingCoreTaskPlan.swift`, kept line-for-line faithful so
// a writer who starts on the iPad and continues in the browser walks the same
// schedule: the same 758 rows, the same seeded SplitMix64 shuffle, the same
// repeat spacing, the same packets of 22.

import { sha256 } from './util.js';

export const PLAN_VERSION = 'ru_core_v1';
export const PACKET_SIZE = 22;

/// §8.3: a repeat is aimed this far after its original…
const REPEAT_GAP = 100;
/// …and is dropped rather than placed closer than this.
const MIN_REPEAT_GAP = 75;
const REPEAT_JITTER = 40;

export const TIERS = ['core_300', 'core_450', 'core_650'];

export const GROUP_TITLES = {
  core_300: 'Ядро 300',
  core_450: 'Ядро 450',
  core_650: 'Ядро 650',
  exact_repeat: 'Повторы',
};

const MASK64 = (1n << 64n) - 1n;

/// SplitMix64 — reproducible across platforms, unlike any platform RNG.
class SeededGenerator {
  constructor(seed) {
    this.state = seed & MASK64;
  }

  next() {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  }

  /// Uniform in `0..<bound`, rejection-sampled so low values aren't favoured.
  int(bound) {
    if (bound <= 1) return 0;
    const upper = BigInt(bound);
    const limit = MASK64 - (MASK64 % upper);
    let value = this.next();
    while (value >= limit) value = this.next();
    return Number(value % upper);
  }

  /// Fisher–Yates, matching the Swift `shuffle`.
  shuffle(items) {
    for (let index = items.length - 1; index > 0; index--) {
      const target = this.int(index + 1);
      if (target !== index) {
        const tmp = items[index];
        items[index] = items[target];
        items[target] = tmp;
      }
    }
  }
}

function seedFor(writerID) {
  const digest = sha256(String(writerID).toLowerCase());
  let seed = 0n;
  for (let i = 0; i < 8; i++) seed = (seed << 8n) | BigInt(digest[i]);
  return seed;
}

let cachedRows = null;

/// The bundled core, fetched once. Labels are NFC-normalized on the way in,
/// exactly as the iOS decoder does — the label a sample carries has to match
/// byte-for-byte across clients.
export async function loadCoreRows() {
  if (cachedRows) return cachedRows;
  const response = await fetch('./data/russian_core_tasks.json', { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Не удалось загрузить задания (${response.status})`);
  const raw = await response.json();
  cachedRows = raw.map((row) => ({
    task_index: row.task_index,
    text: String(row.text).normalize('NFC'),
    word_group: TIERS.includes(row.word_group) || row.word_group === 'exact_repeat'
      ? row.word_group
      : 'core_650',
    starts_with_uppercase: row.starts_with_uppercase === true,
    repeat_of: row.repeat_of == null ? null : String(row.repeat_of).normalize('NFC'),
    is_case_pair: row.is_case_pair === true,
  }));
  return cachedRows;
}

/// This writer's whole schedule, in the order they will meet it. Pure: same
/// writer id + same file → same list, so a reload can never reshuffle the
/// remaining words out from under a persisted cursor.
export function buildDelivery(writerID, rows) {
  if (!rows || rows.length === 0) return [];
  const rng = new SeededGenerator(seedFor(writerID));

  // 1 · Tiers shuffled independently, order between tiers preserved.
  const sequence = [];
  for (const tier of TIERS) {
    const block = rows.filter((r) => r.word_group === tier);
    rng.shuffle(block);
    sequence.push(...block);
  }

  // 2 · Repeats, late originals first so the tail has room for them.
  const positions = new Map();
  sequence.forEach((row, index) => positions.set(row.text, index));

  const repeats = rows
    .filter((r) => r.word_group === 'exact_repeat')
    .sort((a, b) => (positions.get(b.repeat_of ?? '') ?? 0) - (positions.get(a.repeat_of ?? '') ?? 0));

  for (const repeatRow of repeats) {
    const original = positions.get(repeatRow.repeat_of ?? '') ?? 0;
    const earliest = original + REPEAT_GAP;
    let insertAt;
    if (earliest < sequence.length) {
      insertAt = Math.min(sequence.length, earliest + rng.int(REPEAT_JITTER + 1));
    } else if (sequence.length - original >= MIN_REPEAT_GAP) {
      insertAt = sequence.length;
    } else {
      // Its original sits too close to the end to be a fair repeat.
      continue;
    }
    sequence.splice(insertAt, 0, repeatRow);
    for (const [text, position] of positions) {
      if (position >= insertAt) positions.set(text, position + 1);
    }
  }

  // 3 · Number the walk and cut it into packets.
  return sequence.map((row, index) => ({
    task_index: row.task_index,
    order: index + 1,
    text: row.text,
    word_group: row.word_group,
    starts_with_uppercase: row.starts_with_uppercase,
    is_exact_repeat: row.word_group === 'exact_repeat',
    is_case_pair: row.is_case_pair,
    packet: Math.floor(index / PACKET_SIZE) + 1,
    prompt_id: `${PLAN_VERSION}/${row.task_index}`,
  }));
}

/// How many tasks each tier contributes, for the stage bars.
export function tierCounts(delivery) {
  const counts = { core_300: 0, core_450: 0, core_650: 0, exact_repeat: 0 };
  for (const task of delivery) counts[task.word_group] = (counts[task.word_group] ?? 0) + 1;
  return counts;
}
