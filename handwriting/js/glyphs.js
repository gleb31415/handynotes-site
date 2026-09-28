// Math glyphs: the corpus a writer handwrites, their delivery order, and the
// banks their samples become.
//
// The one contract that ties everything together is the glyph KEY: the single
// Unicode character KaTeX puts in the DOM for a symbol, after `normalizeKey`.
// The capture side labels each glyph sample with its corpus `char` (already a
// key), and the layout side reads KaTeX's DOM, normalises each character the
// same way and looks it up here. `data/math_glyphs.json` is checked against the
// vendored KaTeX by scripts/handwriting-tests/glyph-corpus-katex.test.mjs, so a
// corpus key can never silently drift away from what KaTeX actually emits.
//
// Everything here is pure (and importable from Node) except `loadGlyphCorpus`
// (fetch) and the font loading behind `drawGlyphTemplate` (FontFace).

import { SeededGenerator } from './tasks.js';
import { sha256 } from './util.js';

export const GLYPH_PLAN_VERSION = 'math_glyphs_v1';

/// Capture-sheet guides, as fractions of the sheet height — the same numbers
/// as ink.js `GUIDES`. A sample's x-height in px is always `canvas_h * XH_FRACTION`.
const GUIDE_ASCENDER = 0.20;
const GUIDE_XHEIGHT = 0.46;
const GUIDE_BASELINE = 0.72;
const GUIDE_DESCENDER = 0.90;
const XH_FRACTION = GUIDE_BASELINE - GUIDE_XHEIGHT;

/// KaTeX main-font x-height, in em.
const KATEX_X_HEIGHT = 0.431;

export const DEFAULT_REPEATS = { 1: 3, 2: 2, 3: 1 };

// MARK: Keys

/// Stretchy-delimiter pieces from KaTeX's Size fonts, and the bar glyphs it
/// uses for `|` and `\|`. A tall bracket is still the writer's one bracket.
const DELIMITER_PIECES = {
  '⎛': '(', '⎜': '(', '⎝': '(',
  '⎞': ')', '⎟': ')', '⎠': ')',
  '⎡': '[', '⎢': '[', '⎣': '[',
  '⎤': ']', '⎥': ']', '⎦': ']',
  '⎧': '{', '⎨': '{', '⎩': '{', '⎪': '{',
  '⎫': '}', '⎬': '}', '⎭': '}',
  '∣': '|', '‖': '∥',
};

/// One character, one handwritten shape. Long arrows are the short arrow
/// drawn longer; slanted ≤ is the same ≤ in anyone's hand; KaTeX's accent
/// bodies `^`/`~` are the hat/tilde keys the corpus collects; KaTeX's private-
/// use dotless i/j (\imath, \jmath) become the real code points.
const CHAR_MAP = {
  '°': '∘',
  '^': 'ˆ',
  '~': '˜',
  '’': "'", '‘': "'", 'ʼ': "'",
  '“': '"', '”': '"', '„': '"',
  '⟶': '→', '⟵': '←', '⟷': '↔', '⟹': '⇒', '⟸': '⇐', '⟺': '⇔', '⟼': '↦',
  '⩽': '≤', '⩾': '≥', '≦': '≤', '≧': '≥',
  '·': '⋅', '∙': '⋅',
  '*': '∗',
  'ϒ': 'Υ',
  'ℎ': 'h',
  '': 'ı', '': 'ȷ',
};

/// Upper-case Greek letters whose glyph IS a Latin capital.
const GREEK_LOOKALIKES = {
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K',
  'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Χ': 'X',
};

/// `\mathbb` capitals that have their own BMP code point. Anything else in a
/// blackboard font falls back to the plain capital.
export const BLACKBOARD = { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' };

/// KaTeX's `\not` overlay glyph (Main font, private use). KaTeX builds `\ne`,
/// `\not\equiv`, `\not\subset`… as this glyph + the base relation, and
/// `\notin` as `∈` + an `llap`'d `/`. The layout collapses either pair into
/// the negated key through `NEGATIONS`.
export const NOT_OVERLAY = '';

/// Base relation → its negated key.
export const NEGATIONS = {
  '=': '≠', '≡': '≢', '∈': '∉', '∋': '∌', '⊂': '⊄', '⊃': '⊅', '⊆': '⊈', '⊇': '⊉',
  '∼': '≁', '≈': '≉', '≃': '≄', '≅': '≇', '<': '≮', '>': '≯', '≤': '≰', '≥': '≱',
  '|': '∤', '∣': '∤', '∥': '∦', '∃': '∄',
};

/// The negated key for a base relation (itself normalised first), or null.
export function negateKey(base) {
  const key = normalizeKey(base);
  return NEGATIONS[key] ?? null;
}

/// Font classes that mean "this is running text", where an ASCII hyphen is a
/// hyphen and not a minus.
const TEXT_CLASSES = new Set([
  'text', 'textrm', 'textit', 'textbf', 'textsf', 'texttt', 'textnormal',
  'cyrillic_fallback', 'latin_fallback', 'cjk_fallback', 'brahmic_fallback',
  'georgian_fallback',
]);

function classSet(fontClass) {
  if (!fontClass) return new Set();
  const list = Array.isArray(fontClass) ? fontClass : String(fontClass).split(/\s+/);
  return new Set(list.filter(Boolean));
}

/// The bank key for one character KaTeX emitted. `fontClass` is the class
/// string (or array) of the glyph's span — pass the classes of its ancestors
/// too (at least up to the enclosing `.mord`/`.text`), because `\text{-}`
/// marks its hyphen only on the parent, and `\mathbb{R}` only on the glyph.
/// Plain running text should pass `'text'`. Multi-character strings are
/// normalised character by character.
export function normalizeKey(char, fontClass = '') {
  if (char == null) return '';
  const classes = classSet(fontClass);
  const isText = [...classes].some((c) => TEXT_CLASSES.has(c));
  const blackboard = classes.has('mathbb') || classes.has('textbb');
  const ams = classes.has('amsrm');
  let out = '';
  for (let ch of String(char).normalize('NFC')) {
    const cp = ch.codePointAt(0);
    // Mathematical Alphanumeric Symbols (𝑥, 𝐱, 𝔼…) are styled Latin/Greek.
    if (cp >= 0x1d400 && cp <= 0x1d7ff) ch = ch.normalize('NFKC');
    if (DELIMITER_PIECES[ch]) ch = DELIMITER_PIECES[ch];
    else if (CHAR_MAP[ch]) ch = CHAR_MAP[ch];
    else if (GREEK_LOOKALIKES[ch]) ch = GREEK_LOOKALIKES[ch];
    else if (ch === '-' && !isText) ch = '−';
    // KaTeX renders `ℝ` typed as Unicode with class `amsrm` and a plain R.
    if ((blackboard || ams) && /^[A-Z]$/.test(ch)) ch = BLACKBOARD[ch] ?? ch;
    out += ch;
  }
  return out;
}

// MARK: Substitutes

const CASE_SHAPES_LATIN = 'cosuvwxz';
const CASE_SHAPES_CYRILLIC = 'сохжзкэю';

/// Latin ↔ Cyrillic letters that are the same shape in anyone's hand.
const LATIN_CYRILLIC = [
  ['a', 'а'], ['e', 'е'], ['o', 'о'], ['p', 'р'], ['c', 'с'], ['y', 'у'], ['x', 'х'],
  ['A', 'А'], ['B', 'В'], ['E', 'Е'], ['K', 'К'], ['M', 'М'], ['H', 'Н'], ['O', 'О'],
  ['P', 'Р'], ['C', 'С'], ['T', 'Т'], ['X', 'Х'],
];

function buildSubstitutes() {
  const table = {
    'ϵ': ['ε', '∈'], 'ε': ['ϵ'], 'ϕ': ['φ'], 'φ': ['ϕ'], 'ϑ': ['θ'], 'θ': ['ϑ'],
    'ϱ': ['ρ'], 'ρ': ['ϱ'], 'ϰ': ['κ'], 'ς': ['σ'], 'ο': ['o'], 'ϖ': ['π'],
    '∈': ['ϵ', 'ε'],
    '−': ['-', '—'], '-': ['−'], '—': ['−', '-'], '–': ['—', '−', '-'],
    '⋅': ['·'], '∗': ['*'], '′': ["'"], "'": ['′'], '∣': ['|'],
    '…': ['...'], '⋯': ['⋅⋅⋅'], '∥': ['||'],
    'ı': ['i'], 'ȷ': ['j'], 'ℓ': ['l'], 'ℏ': ['h'],
    '×': ['x'], '⟨': ['<'], '⟩': ['>'],
    'ℝ': ['R'], 'ℕ': ['N'], 'ℤ': ['Z'], 'ℚ': ['Q'], 'ℂ': ['C'], 'ℙ': ['P'], 'ℍ': ['H'],
    '∬': ['∫∫'], '∭': ['∫∫∫'],
    '⋃': ['∪'], '⋂': ['∩'], '∪': ['⋃'], '∩': ['⋂'],
  };
  const push = (from, to) => {
    table[from] = table[from] ?? [];
    if (!table[from].includes(to)) table[from].push(to);
  };
  for (const ch of CASE_SHAPES_LATIN + CASE_SHAPES_CYRILLIC) {
    push(ch, ch.toUpperCase());
    push(ch.toUpperCase(), ch);
  }
  for (const [latin, cyrillic] of LATIN_CYRILLIC) {
    push(latin, cyrillic);
    push(cyrillic, latin);
  }
  return table;
}

/// Acceptable stand-ins when a bank lacks a key, best first. An entry of more
/// than one character is a SEQUENCE drawn side by side (`…` → three `.`).
export const SUBSTITUTES = Object.freeze(buildSubstitutes());

/// Capital height over x-height for a case substitute, in the writer's units.
const CASE_SCALE = 1.5;
/// A big operator is written across the whole sheet; its small form is not.
const BIG_OP_SCALE = 2;
const BIG_SMALL = { '⋃': '∪', '⋂': '∩' };

/// The scale a substitute's normalized strokes need to stand in for `key`.
function substituteScale(key, alt) {
  if (alt.length === 1 && key.length === 1 && alt !== key) {
    if (alt === key.toLowerCase() && key !== key.toLowerCase()) return CASE_SCALE;
    if (alt === key.toUpperCase() && key !== key.toUpperCase()) return 1 / CASE_SCALE;
    // A small ∪ standing in for ⋃ grows; a tall ⋃ standing in for ∪ shrinks.
    if (BIG_SMALL[key] === alt) return BIG_OP_SCALE;
    if (BIG_SMALL[alt] === key) return 1 / BIG_OP_SCALE;
  }
  return 1;
}

function instancesOf(bank, key) {
  const list = bank.get(key);
  return Array.isArray(list) && list.length > 0 ? list : null;
}

/// The writer's instances for `key`: exact key, then its normalised form,
/// then `SUBSTITUTES` in order. Result:
///   { instances, key /* what was found */, substituted, scale, parts }
/// `scale` (1 unless a case / big-operator stand-in) multiplies the found
/// instances' ex units. `parts` is null, or for a sequence stand-in the list
/// `[{ key, instances }]` to draw side by side (`instances` = the first part's).
export function lookupGlyph(bank, key) {
  if (!bank || key == null || key === '') return null;
  const raw = String(key).normalize('NFC');
  const candidates = [raw];
  const normalized = normalizeKey(raw);
  if (normalized !== raw) candidates.push(normalized);

  for (const candidate of candidates) {
    const instances = instancesOf(bank, candidate);
    if (instances) return { instances, key: candidate, substituted: false, scale: 1, parts: null };
  }
  for (const candidate of candidates) {
    for (const alt of SUBSTITUTES[candidate] ?? []) {
      const chars = [...alt];
      if (chars.length === 1) {
        const instances = instancesOf(bank, alt);
        if (instances) {
          return { instances, key: alt, substituted: true, scale: substituteScale(candidate, alt), parts: null };
        }
        continue;
      }
      const parts = chars.map((part) => ({ key: part, instances: instancesOf(bank, part) }));
      if (parts.every((part) => part.instances)) {
        return { instances: parts[0].instances, key: alt, substituted: true, scale: 1, parts };
      }
    }
  }
  return null;
}

// MARK: Corpus

/// Raw JSON rows → Glyph[], NFC-normalised, each carrying its `task_index`
/// (its position in the file, which is what samples record). Rows without an
/// id or char are dropped without shifting anyone else's index.
export function parseGlyphCorpus(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((row, index) => {
    if (!row || !row.id || !row.char) return;
    out.push({
      id: String(row.id),
      char: String(row.char).normalize('NFC'),
      latex: String(row.latex ?? row.char),
      category: String(row.category ?? 'misc'),
      round: Number.isFinite(Number(row.round)) ? Number(row.round) : 3,
      name_ru: String(row.name_ru ?? row.char).normalize('NFC'),
      hint: row.hint == null ? null : String(row.hint).normalize('NFC'),
      task_index: index,
    });
  });
  return out;
}

let corpusPromise = null;

/// The bundled corpus, fetched once. Resolved against this module, not the
/// page, so it works from any document that imports it.
export async function loadGlyphCorpus() {
  if (!corpusPromise) {
    corpusPromise = (async () => {
      const url = new URL('../data/math_glyphs.json', import.meta.url);
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`Не удалось загрузить символы (${response.status})`);
      return parseGlyphCorpus(await response.json());
    })();
    // A failed fetch must not poison every later attempt.
    corpusPromise.catch(() => { corpusPromise = null; });
  }
  return corpusPromise;
}

// MARK: Delivery

/// Salted so the glyph order is independent of the word order of the same
/// writer (which seeds from the bare id).
function glyphSeedFor(writerID) {
  const digest = sha256(`${GLYPH_PLAN_VERSION}:${String(writerID).toLowerCase()}`);
  let seed = 0n;
  for (let i = 0; i < 8; i++) seed = (seed << 8n) | BigInt(digest[i]);
  return seed;
}

/// Which (round, repeat) passes run in which order. Wave w introduces round w
/// and then revisits each earlier round once more:
///   w1: r1#1 · w2: r2#1 r1#2 · w3: r3#1 r2#2 r1#3 · w4: r3#2 r2#3 r1#4 …
/// so essentials come first and repeats are spread out rather than bunched.
export function glyphPassOrder(rounds, repeats = DEFAULT_REPEATS) {
  const sorted = [...new Set(rounds)].sort((a, b) => a - b);
  const maxRepeat = Math.max(0, ...sorted.map((r) => repeats[r] ?? 0));
  const passes = [];
  for (let wave = 1; wave <= sorted.length + maxRepeat; wave++) {
    for (let i = Math.min(wave, sorted.length) - 1; i >= 0; i--) {
      const rep = wave - i;
      if (rep >= 1 && rep <= (repeats[sorted[i]] ?? 0)) passes.push({ round: sorted[i], rep });
    }
  }
  return passes;
}

/// This writer's whole glyph schedule. Pure and deterministic per writer id:
/// each pass is its round shuffled afresh, and a pass never opens with the
/// glyph the previous one closed on (unless a round has a single glyph).
/// `repeats` maps round → how many times each of its glyphs is written;
/// rounds it doesn't mention keep their `DEFAULT_REPEATS` count.
export function buildGlyphDelivery(writerID, corpus, { repeats = {} } = {}) {
  if (!Array.isArray(corpus) || corpus.length === 0) return [];
  repeats = { ...DEFAULT_REPEATS, ...repeats };
  const rng = new SeededGenerator(glyphSeedFor(writerID));
  const byRound = new Map();
  corpus.forEach((glyph, index) => {
    const entry = { glyph, index: Number.isInteger(glyph.task_index) ? glyph.task_index : index };
    if (!byRound.has(glyph.round)) byRound.set(glyph.round, []);
    byRound.get(glyph.round).push(entry);
  });

  const sequence = [];
  for (const { round, rep } of glyphPassOrder([...byRound.keys()], repeats)) {
    const pass = byRound.get(round).slice();
    rng.shuffle(pass);
    const last = sequence[sequence.length - 1];
    if (last && pass.length > 1 && pass[0].glyph.id === last.entry.glyph.id) {
      const swap = 1 + rng.int(pass.length - 1);
      [pass[0], pass[swap]] = [pass[swap], pass[0]];
    }
    for (const entry of pass) sequence.push({ entry, rep });
  }

  return sequence.map(({ entry: { glyph, index }, rep }, position) => ({
    glyph_id: glyph.id,
    char: glyph.char,
    latex: glyph.latex,
    category: glyph.category,
    round: glyph.round,
    name_ru: glyph.name_ru,
    hint: glyph.hint ?? null,
    task_index: index,
    order: position + 1,
    prompt_id: `${GLYPH_PLAN_VERSION}/${glyph.id}`,
    rep,
  }));
}

// MARK: Banks

function pointsOf(stroke) {
  if (Array.isArray(stroke)) return stroke;
  if (stroke && Array.isArray(stroke.points)) return stroke.points;
  return [];
}

/// One sample → a GlyphInstance in ex units (1 = the writer's x-height,
/// y down, 0 = baseline, ink starting at x = 0), or null when there is
/// nothing usable. Works for `prompted_glyph` (key = its label, the corpus
/// char) and `prompted_word` (key = the exact word label). A single-point
/// stroke is kept — a dot is a real glyph.
export function normalizeSample(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const type = sample.sample_type;
  if (type !== 'prompted_glyph' && type !== 'prompted_word') return null;
  const label = typeof sample.label === 'string' ? sample.label.normalize('NFC') : '';
  if (!label.trim()) return null;
  const canvasH = Number(sample.canvas_h);
  if (!Number.isFinite(canvasH) || canvasH <= 0) return null;
  const xh = canvasH * XH_FRACTION;
  const baseline = Number.isFinite(sample.baseline_y) ? sample.baseline_y : canvasH * GUIDE_BASELINE;

  const strokes = [];
  let minX = Infinity;
  for (const stroke of Array.isArray(sample.strokes) ? sample.strokes : []) {
    const points = pointsOf(stroke).filter((p) =>
      Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (points.length === 0) continue;
    for (const p of points) if (p[0] < minX) minX = p[0];
    strokes.push(points);
  }
  if (strokes.length === 0) return null;

  const t0 = Number.isFinite(strokes[0][0][2]) ? strokes[0][0][2] : 0;
  let maxX = 0, minY = Infinity, maxY = -Infinity;
  const normalized = strokes.map((points) => points.map((p) => {
    const x = (p[0] - minX) / xh;
    const y = (p[1] - baseline) / xh;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const t = Number.isFinite(p[2]) ? p[2] - t0 : 0;
    const pressure = Number.isFinite(p[3]) ? p[3] : 0;
    return [x, y, t, pressure];
  }));

  return {
    sample_id: sample.sample_id ?? null,
    key: label,
    strokes: normalized,
    bbox: { minX: 0, maxX, minY, maxY },
    width: maxX,
    created_at: sample.created_at ?? null,
  };
}

/// Every usable sample, split into the glyph bank (by key) and the word bank
/// (by exact label). Instances are oldest first; a sample id counts once.
export function buildBanks(samples) {
  const glyphs = new Map();
  const words = new Map();
  const seen = new Set();
  const sorted = [...(samples ?? [])]
    .filter(Boolean)
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  for (const sample of sorted) {
    if (sample.sample_id != null) {
      if (seen.has(sample.sample_id)) continue;
      seen.add(sample.sample_id);
    }
    const instance = normalizeSample(sample);
    if (!instance) continue;
    const bank = sample.sample_type === 'prompted_glyph' ? glyphs : words;
    if (!bank.has(instance.key)) bank.set(instance.key, []);
    bank.get(instance.key).push(instance);
  }
  return { glyphs, words };
}

/// What the writer has and still owes. `have` holds corpus chars with at
/// least one instance (substitutes don't count); `counts` maps every corpus
/// char to its instance count.
export function coverage(bank, corpus) {
  const have = new Set();
  const missing = [];
  const counts = new Map();
  const byRound = {};
  for (const glyph of corpus ?? []) {
    const n = bank?.get(glyph.char)?.length ?? 0;
    counts.set(glyph.char, n);
    const round = (byRound[glyph.round] ??= { have: 0, total: 0 });
    round.total += 1;
    if (n > 0) {
      have.add(glyph.char);
      round.have += 1;
    } else {
      missing.push(glyph);
    }
  }
  return { have, missing, byRound, counts };
}

// MARK: Capture template

/// Chars KaTeX draws from its AMS font (class `amsrm`) in this corpus.
const AMS_CHARS = new Set(['∄', '∅', '∤']);
const TEXT_SANS = '"Helvetica Neue", Arial, "Segoe UI", Roboto, sans-serif';
const SERIF_FALLBACK = '"Times New Roman", Times, serif';
/// Sans x-height when it can't be measured (Helvetica/Arial ≈ 0.52 em).
const SANS_X_HEIGHT = 0.52;

const KATEX_FONTS = {
  main: { family: 'KaTeX_Main', style: 'normal', file: 'KaTeX_Main-Regular.woff2' },
  math: { family: 'KaTeX_Math', style: 'italic', file: 'KaTeX_Math-Italic.woff2' },
  ams: { family: 'KaTeX_AMS', style: 'normal', file: 'KaTeX_AMS-Regular.woff2' },
  size2: { family: 'KaTeX_Size2', style: 'normal', file: 'KaTeX_Size2-Regular.woff2' },
};

const MATH_ITALIC_CATEGORIES = new Set(['latin_lower', 'latin_upper', 'greek_lower']);

/// How a glyph's reference is drawn, the way KaTeX itself would draw it:
///   { font: KATEX_FONTS entry | null (sans), text, overlay: '/'|null,
///     fit: 'xheight'|'tall' }
/// 'xheight' puts the font's x-height on the .46/.72 guides; 'tall' stretches
/// the ink from the ascender to the descender guide (big operators).
export function templateFont(glyph) {
  const char = glyph?.char ?? '';
  const latex = String(glyph?.latex ?? '');
  if (/^\\text\b/.test(latex)) return { font: null, text: char, overlay: null, fit: 'xheight' };
  if (glyph.category === 'big_operator') return { font: KATEX_FONTS.size2, text: char, overlay: null, fit: 'tall' };
  if (glyph.category === 'blackboard') {
    const letter = Object.keys(BLACKBOARD).find((k) => BLACKBOARD[k] === char) ?? char;
    return { font: KATEX_FONTS.ams, text: letter, overlay: null, fit: 'xheight' };
  }
  if (AMS_CHARS.has(char)) return { font: KATEX_FONTS.ams, text: char, overlay: null, fit: 'xheight' };
  // KaTeX has no ≠/∉ glyph: it overlays a slash on the base relation.
  const base = Object.keys(NEGATIONS).find((k) => NEGATIONS[k] === char && k !== '∣');
  if (base && !AMS_CHARS.has(char)) return { font: KATEX_FONTS.main, text: base, overlay: '/', fit: 'xheight' };
  if (MATH_ITALIC_CATEGORIES.has(glyph.category)) return { font: KATEX_FONTS.math, text: char, overlay: null, fit: 'xheight' };
  return { font: KATEX_FONTS.main, text: char, overlay: null, fit: 'xheight' };
}

/// family|style → { status: 'loading'|'loaded'|'failed', promise, waiters }
const fontLoads = new Map();

function fontEntry(font) {
  const id = `${font.family}|${font.style}`;
  let entry = fontLoads.get(id);
  if (entry) return entry;
  entry = { status: 'loading', promise: Promise.resolve(), waiters: new Set() };
  fontLoads.set(id, entry);
  if (typeof FontFace !== 'function' || typeof document === 'undefined' || !document.fonts) {
    entry.status = 'failed';
    return entry;
  }
  const url = new URL(`../vendor/katex/fonts/${font.file}`, import.meta.url);
  const face = new FontFace(font.family, `url("${url.href}") format("woff2")`, { style: font.style, weight: '400' });
  entry.promise = face.load().then(
    (loaded) => { document.fonts.add(loaded); entry.status = 'loaded'; },
    () => { entry.status = 'failed'; },
  ).then(() => {
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const waiter of waiters) {
      try { waiter(); } catch { /* a caller's redraw is its own problem */ }
    }
  });
  return entry;
}

/// Starts loading every template font; resolves when all have settled.
/// Optional — `drawGlyphTemplate` loads what it needs on its own.
export function preloadTemplateFonts() {
  return Promise.all(Object.values(KATEX_FONTS).map((font) => fontEntry(font).promise));
}

function cssFont(font, sizePx) {
  if (!font) return `400 ${sizePx}px ${TEXT_SANS}`;
  const fallback = font.family === 'KaTeX_Main' || font.family === 'KaTeX_Math' ? SERIF_FALLBACK : 'serif';
  return `${font.style === 'italic' ? 'italic ' : ''}400 ${sizePx}px ${font.family}, ${fallback}`;
}

/// Paints a faint reference of `glyph` on the capture sheet so every writer
/// writes each symbol at the same size and height: for a KaTeX font, its
/// x-height (0.431 em) spans the x-height→baseline guides and its baseline
/// sits on the .72 guide; big operators are stretched from the ascender to
/// the descender guide; text characters use a plain sans with its measured
/// x-height. Horizontally centred. Display only.
///
/// KaTeX fonts load lazily (FontFace, cached per font). While a font is still
/// loading nothing is drawn and `onReady` — typically `() => sheet.redraw()` —
/// is called once it settles; if it fails, a system font stands in.
/// Returns true when the glyph was drawn now.
///
///   sheet.setTemplate((ctx, { width, height }) => drawGlyphTemplate(ctx, glyph,
///     { canvasW: width, canvasH: height, onReady: () => sheet.redraw() }));
export function drawGlyphTemplate(ctx, glyph, { canvasW, canvasH, onReady = null, alpha = 0.12 } = {}) {
  if (!ctx || !glyph || !(canvasW > 0) || !(canvasH > 0)) return false;
  const spec = templateFont(glyph);
  if (spec.font) {
    const entry = fontEntry(spec.font);
    if (entry.status === 'loading') {
      if (typeof onReady === 'function') entry.waiters.add(onReady);
      return false;
    }
  }

  ctx.save();
  ctx.fillStyle = `rgba(20, 30, 60, ${alpha})`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const baselineY = canvasH * GUIDE_BASELINE;
  const xhPx = canvasH * XH_FRACTION;
  let sizePx;
  let y = baselineY;
  if (spec.fit === 'tall') {
    ctx.font = cssFont(spec.font, 100);
    const m = ctx.measureText(spec.text);
    const ascent = m.actualBoundingBoxAscent || 105;
    const descent = m.actualBoundingBoxDescent || 55;
    const scale = (canvasH * (GUIDE_DESCENDER - GUIDE_ASCENDER)) / (ascent + descent);
    sizePx = 100 * scale;
    y = canvasH * GUIDE_ASCENDER + ascent * scale;
  } else if (spec.font) {
    sizePx = xhPx / KATEX_X_HEIGHT;
  } else {
    ctx.font = cssFont(null, 100);
    const measured = ctx.measureText('x').actualBoundingBoxAscent;
    const ratio = measured > 10 && measured < 90 ? measured / 100 : SANS_X_HEIGHT;
    sizePx = xhPx / ratio;
  }

  ctx.font = cssFont(spec.font, sizePx);
  const m = ctx.measureText(spec.text);
  const left = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0;
  const right = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width;
  const x = canvasW / 2 - (right - left) / 2;
  ctx.fillText(spec.text, x, y);
  if (spec.overlay) {
    const o = ctx.measureText(spec.overlay);
    const oLeft = Number.isFinite(o.actualBoundingBoxLeft) ? o.actualBoundingBoxLeft : 0;
    const oRight = Number.isFinite(o.actualBoundingBoxRight) ? o.actualBoundingBoxRight : o.width;
    ctx.fillText(spec.overlay, canvasW / 2 - (oRight - oLeft) / 2, y);
  }
  ctx.restore();
  return true;
}
