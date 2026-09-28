// Running text in the writer's own hand: one word at a time, in "ex" units
// (1 = the writer's x-height, y down, 0 = baseline, ink from x = 0 — the same
// units as a GlyphInstance, see SPEC).
//
// A word comes from the best source that has it, in this order:
//
//   1. `model` — a pluggable handwriting-generation hook,
//      async (text, { seed }) → { strokes, width } in ex, or null. It is
//      untrusted: every call is wrapped in try/catch and a timeout, its output
//      is validated, and after a few consecutive failures it is switched off
//      for the rest of the render instead of stalling every word.
//   2. the WordBank — the writer's own sample of exactly this word
//      (case-sensitive; also the word without its punctuation, which is then
//      added as glyphs). A real word beats anything composed.
//   3. letters from the GlyphBank, print-style: each letter one of the
//      writer's instances (chosen, perhaps morphed, perturbed — variation.js),
//      separated by ≈ 0.3 ex (centreline to centreline) ± the writer's
//      spacing noise.
//   4. a fallback item per character nobody has: the compositor draws it in
//      a system font and reports it as missing, so the gap is visible and
//      fixable (write that letter) rather than silently dropped.
//
// Punctuation is split off the word and drawn as glyphs, so «уравнение,» can
// still come from the word bank. Unicode math inside text (≤, →, π…) is just
// a glyph like any other letter.
//
// Pure except `measureFallback` (an optional canvas measurement of the
// fallback font); importable from Node.

import { lookupGlyph, normalizeKey } from './glyphs.js';
import { Rng, chooseVariant, perturb, spacingJitter, resolveKnobs } from './variation.js';

/// Spacing, ex, measured between stroke CENTRELINES (the ink the writer's
/// samples record). The rendered pen is ~0.17 ex wide, so the gap a reader
/// sees is about 0.17 ex less: a 0.3 ex letter gap looks like ~0.13 ex, a
/// 1 ex word space like ~0.83 ex — a tidy print hand. Punctuation hugs the
/// letter before it.
export const TEXT_METRICS = Object.freeze({
  letterGap: 0.3,
  punctGap: 0.2,
  spaceWidth: 1.0,
  /// A pen-lift between letters, ms — keeps synthetic t increasing and plausible.
  letterPauseMs: 110,
});

/// Sans x-height in em when a fallback char is drawn in a system font.
export const FALLBACK_X_HEIGHT = 0.52;
export const FALLBACK_FONT = '"Helvetica Neue", Arial, "Segoe UI", Roboto, sans-serif';

/// Stand-in scale when a capital is drawn from its own lower-case letter.
const CAPITAL_FROM_LOWER = 1.35;

/// Punctuation that attaches to a word without a space.
const LEADING_PUNCT = /^[«"'“„‘(\[{¡¿]+/u;
const TRAILING_PUNCT = /[»"'”’)\]}.,;:!?…]+$/u;
const TIGHT = new Set([...'.,;:!?…»"\')]}']);

const MODEL_TIMEOUT_MS = 2500;
const MODEL_MAX_FAILURES = 3;
/// Prefetched model requests in flight at once. A browser runs about six
/// requests per host anyway; more would only queue there, where the
/// per-word timeout would already be running.
const MODEL_CONCURRENCY = 6;
/// Sanity bounds on a model's answer, in ex. A handwritten letter is about
/// 0.5–1.5 ex wide and ink stays within a couple of ex of the baseline; an
/// answer far outside that (a bug, a unit mix-up) would blow the page up, so
/// it counts as a failure and the word comes from the writer's own ink.
const MODEL_MAX_EX_PER_CHAR = 8;
const MODEL_MAX_ABS_Y = 6;
const MODEL_MAX_POINTS = 20_000;

/// `token` → { lead, core, trail }. A token that is ALL punctuation stays in
/// `core` (a lone «—» or «...» is a word of its own).
export function splitPunctuation(token) {
  const text = String(token ?? '');
  const lead = text.match(LEADING_PUNCT)?.[0] ?? '';
  let rest = text.slice(lead.length);
  const trail = rest.match(TRAILING_PUNCT)?.[0] ?? '';
  const core = rest.slice(0, rest.length - trail.length);
  if (!core) return { lead: '', core: text, trail: '' };
  return { lead, core, trail };
}

// MARK: Geometry helpers (ex units)

function boundsOfStrokes(strokes) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const stroke of strokes) {
    for (const p of stroke) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { minX, maxX, minY, maxY };
}

/// A plain points array from whatever a stroke is ({points} or an array),
/// dropping points without finite x/y; t and p default to 0.
function cleanStroke(stroke) {
  const points = Array.isArray(stroke) ? stroke : Array.isArray(stroke?.points) ? stroke.points : [];
  const out = [];
  for (const p of points) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    out.push([p[0], p[1], Number.isFinite(p[2]) ? p[2] : 0, Number.isFinite(p[3]) ? p[3] : 0]);
  }
  return out;
}

/// Appends `instance` (any frame) to `out` with its ink's left edge at `penX`
/// and its clock starting at `clock`; returns { right, clock } after it.
function appendInstance(out, instance, penX, clock, scale = 1) {
  const box = boundsOfStrokes(instance.strokes);
  const dx = penX - box.minX * scale;
  let last = clock;
  for (const stroke of instance.strokes) {
    if (!stroke.length) continue;
    out.push(stroke.map((p) => {
      const t = clock + (Number.isFinite(p[2]) ? p[2] : 0);
      if (t > last) last = t;
      return [dx + p[0] * scale, p[1] * scale, t, p[3] ?? 0];
    }));
  }
  return { right: penX + (box.maxX - box.minX) * scale, clock: last + TEXT_METRICS.letterPauseMs };
}

// MARK: Fallback measurement

let measureCtx;

/// Width of `char` in ex when drawn in the fallback sans at 1 ex = its
/// x-height. Measured once per char with a canvas when there is one; a
/// sensible estimate otherwise (Node, workers without OffscreenCanvas).
export function measureFallback(char) {
  const cache = (measureFallback.cache ??= new Map());
  if (cache.has(char)) return cache.get(char);
  let width = char === char.toLowerCase() ? 1.05 : 1.35;
  try {
    if (measureCtx === undefined) {
      measureCtx = null;
      if (typeof OffscreenCanvas === 'function') measureCtx = new OffscreenCanvas(8, 8).getContext('2d');
      else if (typeof document !== 'undefined') measureCtx = document.createElement('canvas').getContext('2d');
    }
    if (measureCtx) {
      measureCtx.font = `100px ${FALLBACK_FONT}`;
      const measured = measureCtx.measureText(char).width;
      if (measured > 0) width = measured / (100 * FALLBACK_X_HEIGHT);
    }
  } catch { /* keep the estimate */ }
  cache.set(char, width);
  return width;
}

// MARK: The text ink

/// Builds a word renderer for one composition. `glyphs`/`words` are the
/// writer's banks, `profile` their variability (variation.estimateProfile),
/// `knobs` the user's randomisation settings, `model` the optional
/// generation hook. `recent` (a Map) is shared with the math layer so two
/// neighbouring x's never come from the same sample.
export function createTextInk({
  glyphs = new Map(), words = new Map(), profile = null, knobs = null, model = null,
  modelTimeoutMs = MODEL_TIMEOUT_MS, recent = new Map(),
} = {}) {
  const k = resolveKnobs(knobs);
  const stats = { model: 0, word: 0, letters: 0, fallback: 0, modelFailures: 0 };
  const warnings = [];
  let modelFailures = 0;
  let modelOff = typeof model !== 'function';
  /// Prefetched model answers: key (seed, text) → Promise<ink | null>.
  const pending = new Map();
  const queue = [];
  let inFlight = 0;
  const modelKey = (text, seed) => `${seed}\u0000${text}`;

  async function fromModel(text, rng) {
    if (modelOff) return null;
    let timer = null;
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), modelTimeoutMs);
      });
      const result = await Promise.race([Promise.resolve().then(() => model(text, { seed: rng.seed })), timeout]);
      if (result === 'timeout') throw new Error('timeout');
      if (result == null) { modelFailures = 0; return null; }
      const strokes = (Array.isArray(result.strokes) ? result.strokes : []).map(cleanStroke).filter((s) => s.length);
      if (!strokes.length) throw new Error('empty');
      const box = boundsOfStrokes(strokes);
      const maxWidth = MODEL_MAX_EX_PER_CHAR * Math.max(1, [...text].length) + 4;
      const points = strokes.reduce((n, stroke) => n + stroke.length, 0);
      if (box.maxX - box.minX > maxWidth || box.minY < -MODEL_MAX_ABS_Y || box.maxY > MODEL_MAX_ABS_Y ||
          points > MODEL_MAX_POINTS || (Number.isFinite(result.width) && result.width > maxWidth)) {
        throw new Error('implausible ink');
      }
      // A model may not start its ink at 0; the contract says ink from x = 0.
      for (const stroke of strokes) for (const p of stroke) p[0] -= box.minX;
      const width = Number.isFinite(result.width) && result.width > 0 ? result.width : box.maxX - box.minX;
      modelFailures = 0;
      return { strokes, width };
    } catch (error) {
      stats.modelFailures++;
      if (++modelFailures >= MODEL_MAX_FAILURES) {
        modelOff = true;
        warnings.push(`Модель почерка отключена после ${MODEL_MAX_FAILURES} ошибок подряд (${error?.message ?? error})`);
      }
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function pump() {
    while (inFlight < MODEL_CONCURRENCY && queue.length) {
      const job = queue.shift();
      inFlight++;
      fromModel(job.text, job.rng).then(job.resolve, () => job.resolve(null)).finally(() => {
        inFlight--;
        pump();
      });
    }
  }

  /// Asks the model, ahead of time, for words about to be rendered — a few
  /// requests at a time, in the order given — so a page costs a handful of
  /// round trips instead of one per word. `items`: [{ text, rng }] with the
  /// very rng renderWord will get for that word. The answers wait here;
  /// renderWord still builds every word in order, so the page does not
  /// depend on which answer came first.
  function prefetch(items) {
    if (modelOff) return;
    for (const { text, rng } of items ?? []) {
      const t = String(text ?? '').normalize('NFC').trim();
      if (!t || !rng) continue;
      const r = rng.fork('model');
      const key = modelKey(t, r.seed);
      if (!pending.has(key)) pending.set(key, new Promise((resolve) => queue.push({ text: t, rng: r, resolve })));
    }
    pump();
  }

  /// One of the writer's samples of exactly `label` from the word bank,
  /// perturbed like a glyph, or null.
  function fromWordBank(label, rng) {
    const list = words?.get?.(label);
    if (!Array.isArray(list) || list.length === 0) return null;
    const chosen = chooseVariant(list, rng.fork('pick'), k, recent);
    if (!chosen) return null;
    return perturb(chosen, rng.fork('shape'), profile, k);
  }

  /// The instance for one character (with its stand-in scale), or null.
  function glyphFor(char, rng) {
    let look = lookupGlyph(glyphs, char);
    const textKey = normalizeKey(char, 'text');
    if (!look && textKey !== char) look = lookupGlyph(glyphs, textKey);
    let scale = look?.scale ?? 1;
    let substituted = !!look?.substituted;
    if (!look) {
      const lower = char.toLowerCase();
      if (lower !== char) {
        look = lookupGlyph(glyphs, lower);
        if (look) { scale = CAPITAL_FROM_LOWER * (look.scale ?? 1); substituted = true; }
      }
    }
    if (!look) return null;
    let instance;
    if (look.parts) {
      // A sequence stand-in (… → three dots): side by side, tight.
      const strokes = [];
      let pen = 0, clock = 0;
      look.parts.forEach((part, i) => {
        const inst = chooseVariant(part.instances, rng.fork(`pick${i}`), k, recent);
        if (!inst) return;
        const placed = appendInstance(strokes, inst, pen, clock);
        pen = placed.right + TEXT_METRICS.punctGap;
        clock = placed.clock;
      });
      const box = boundsOfStrokes(strokes);
      instance = { key: look.key, strokes, bbox: box, width: box.maxX - box.minX };
    } else {
      instance = chooseVariant(look.instances, rng.fork('pick'), k, recent);
    }
    if (!instance) return null;
    instance = perturb(instance, rng.fork('shape'), profile, k);
    return { instance, scale, substituted };
  }

  /// Letters of `text`, one glyph each, from pen position `pen`. Appends to
  /// `out` and returns the new pen / clock plus what was missing.
  function composeLetters(text, rng, out, pen, clock, result) {
    const chars = [...text];
    const gapRng = rng.fork('gaps');
    chars.forEach((char, i) => {
      const jitter = spacingJitter(gapRng, profile, k);
      if (/\s/u.test(char)) {
        pen += TEXT_METRICS.spaceWidth + jitter;
        return;
      }
      const found = glyphFor(char, rng.fork(`c${i}/${char}`));
      const next = chars[i + 1];
      const gap = (TIGHT.has(next) || TIGHT.has(char) ? TEXT_METRICS.punctGap : TEXT_METRICS.letterGap) + jitter;
      if (!found) {
        const width = measureFallback(char);
        result.fallbacks.push({ char, x: pen, width });
        result.missing.push(char);
        pen += width + Math.max(0.05, gap);
        return;
      }
      if (found.substituted) result.substituted.push(char);
      const placed = appendInstance(out, found.instance, pen, clock, found.scale);
      pen = placed.right + Math.max(0.04, gap);
      clock = placed.clock;
    });
    return { pen, clock };
  }

  /// One whitespace-free token → WordInk:
  ///   { strokes: [[x,y,t,p]…] in ex (ink from x=0, 0 = baseline), width,
  ///     source: 'model'|'word'|'letters'|'fallback', missing: [chars],
  ///     substituted: [chars], fallbacks: [{char, x, width}] (ex),
  ///     bbox: {minX,maxX,minY,maxY} }
  /// `rng` should be keyed by the word's position (Rng.derive(seed,'word',i)).
  async function renderWord(word, rng = new Rng(k.seed)) {
    const text = String(word ?? '').normalize('NFC').trim();
    const result = { strokes: [], width: 0, source: 'letters', missing: [], substituted: [], fallbacks: [] };
    if (!text) return finish(result);

    const modelRng = rng.fork('model');
    const key = modelKey(text, modelRng.seed);
    let modelInk;
    if (pending.has(key)) {
      modelInk = await pending.get(key);
      pending.delete(key);
    } else {
      modelInk = await fromModel(text, modelRng);
    }
    if (modelInk) {
      result.strokes = modelInk.strokes;
      result.width = modelInk.width;
      result.source = 'model';
      stats.model++;
      return finish(result);
    }

    const whole = fromWordBank(text, rng.fork('word'));
    if (whole) {
      appendInstance(result.strokes, whole, 0, 0);
      result.width = whole.bbox.maxX - whole.bbox.minX;
      result.source = 'word';
      stats.word++;
      return finish(result);
    }

    const { lead, core, trail } = splitPunctuation(text);
    let pen = 0, clock = 0;
    if (lead) ({ pen, clock } = composeLetters(lead, rng.fork('lead'), result.strokes, pen, clock, result));
    const coreInk = core !== text ? fromWordBank(core, rng.fork('core')) : null;
    if (coreInk) {
      const placed = appendInstance(result.strokes, coreInk, pen, clock);
      pen = placed.right + (trail ? TEXT_METRICS.punctGap : 0);
      clock = placed.clock;
      result.source = 'word';
    } else {
      ({ pen, clock } = composeLetters(core, rng.fork('core'), result.strokes, pen, clock, result));
    }
    if (trail) ({ pen, clock } = composeLetters(trail, rng.fork('trail'), result.strokes, pen, clock, result));

    if (result.source !== 'word') {
      result.source = result.strokes.length === 0 ? 'fallback' : 'letters';
    }
    stats[result.source]++;
    const box = boundsOfStrokes(result.strokes);
    const fbRight = result.fallbacks.reduce((m, f) => Math.max(m, f.x + f.width), 0);
    result.width = Math.max(result.strokes.length ? box.maxX : 0, fbRight);
    return finish(result);
  }

  function finish(result) {
    const box = boundsOfStrokes(result.strokes);
    if (result.fallbacks.length) {
      // A fallback char spans roughly cap height, nothing below the baseline.
      box.minY = Math.min(box.minY, -1.4);
      box.maxY = Math.max(box.maxY, 0);
    }
    result.bbox = box;
    return result;
  }

  /// The gap for one word space, ex (the writer's own spacing noise included).
  function spaceWidth(rng) {
    return TEXT_METRICS.spaceWidth + spacingJitter(rng, profile, k);
  }

  return { renderWord, prefetch, spaceWidth, stats, warnings };
}
