// Page composition: a parsed solution (solution.js blocks) → notebook pages of
// the writer's own strokes, plus the renderers that turn a page into pixels,
// SVG or PNG.
//
// The division of labour:
//   * mathlayout.js says where KaTeX puts every glyph, bar, radical, delimiter
//     and accent of a formula — we never second-guess TeX layout;
//   * glyphs.js says which of the writer's samples stands for each glyph;
//   * variation.js makes every occurrence a fresh, plausible copy;
//   * textink.js writes the words between formulas;
//   * this module flows all of it onto paper like a person filling a
//     notebook page: every text baseline sits ON a grid line / ruling, the
//     line pitch is two cells (клетка) or one ruling (линейка), a formula
//     taller than the pitch pushes its line down by whole cells, display
//     formulas are centred on their own line, words wrap, pages break.
//
// Markdown structure is laid out the way it would be copied by hand:
//   * headings — # centred, larger and underlined; ## centred and larger;
//     ### underlined at the margin; #### and deeper pressed harder;
//   * list items hang: the marker (a dash, «1.», «2)» or a drawn check box)
//     sits in a two-cell slot, the text and everything nested under the
//     item — wrapped lines, formulas, sub-items, tables — start at the
//     item's text column; each level indents by two more cells;
//   * **bold** is written with more pressure, *italic* slants further,
//     ~~strikethrough~~ is crossed out by hand;
//   * a block quote is indented and has a hand-drawn bar beside it;
//   * a table is ruled by hand along the grid: columns sized to their
//     content (and narrowed, text wrapping inside cells, when the page is
//     too narrow), a rule under every row, cells aligned as the separator
//     row says, the header pressed harder;
//   * a code block is written out line by line, its indentation kept, in a
//     hand-drawn frame; a --- rule is drawn across the text column.
//
// Determinism: every random draw is keyed by position (the n-th glyph, the
// n-th word, the n-th line) from `knobs.seed`, never by wall-clock or by how
// much randomness something else consumed, so the same blocks + banks +
// knobs always give the same pages, stroke for stroke.
//
// Units: page px (Y down). Glyph geometry inside a formula is converted from
// the writer's ex units with the glyph's own KaTeX x-height, 0.431 × its em,
// so sub/superscripts shrink exactly as KaTeX shrinks them.

import { layoutFormula } from './mathlayout.js';
import { lookupGlyph, normalizeKey } from './glyphs.js';
import {
  Rng, resolveKnobs, estimateProfile, chooseVariant, perturb, lineDrift, handRule,
  stretchToBox, fitInstance,
} from './variation.js';
import { createTextInk, FALLBACK_FONT, FALLBACK_X_HEIGHT } from './textink.js';

/// KaTeX main-font x-height, em.
const KATEX_X_HEIGHT = 0.431;
/// TeX's \thickspace (space around relations), em.
const THICK_SPACE_EM = 5 / 18;
/// Pen-lift pause between two items of writing, ms.
const ITEM_PAUSE_MS = 160;
/// A glyph may be this much wider than its KaTeX slot (advance or ink,
/// whichever is wider) before it is squeezed — overlaps look like a mistake.
const SQUEEZE_RATIO = 1.2;
const SQUEEZE_SLACK_EX = 0.15;
/// Shrinking a formula below this looks like a footnote; break it instead
/// (or accept overflow) — and always say so.
const MIN_SHRINK = 0.55;
/// A formula with no break point that is still too wide at MIN_SHRINK goes
/// on shrinking down to this — small ink on the page beats ink past its edge,
/// which print and the PNG lose. Past this it overflows, and the warning says so.
const OVERFLOW_MIN_SHRINK = 0.3;
/// Inline formulas narrower than this share of the line wrap whole instead of
/// breaking at a relation.
const SPLIT_MIN_SHARE = 0.35;

/// Pen weight (× the nominal line width) of **bold** text and table headers.
const BOLD_WEIGHT = 1.55;
/// Extra slant of *italic* words (shear, x per unit of height above the baseline).
const ITALIC_SHEAR = 0.2;
/// Cells per list level: the marker's slot, and so the indent of what is nested.
const LIST_INDENT_CELLS = 2;
/// Cells per quote level; the bar sits in the first of them.
const QUOTE_INDENT_CELLS = 1.5;
/// Width of one leading space of a code line, in x-heights.
const CODE_SPACE_EX = 0.7;
/// Headings by level (#, ##, ###, #### and deeper).
const HEADING_STYLES = [
  { scale: 1.4, align: 'center', underline: true },
  { scale: 1.2, align: 'center' },
  { scale: 1.1, align: 'left', underline: true },
  { scale: 1, align: 'left', bold: true },
];

/// Keys that must span their KaTeX box whatever `fit` says: a handwritten ∑
/// is as tall as KaTeX's ∑, a bracket encloses what it brackets.
const ALWAYS_FIT_KEYS = new Set([...'∑∏∫∬∭∮⋃⋂∐()[]{}|∥⟨⟩⌊⌋⌈⌉√']);

/// Relations a long formula may break at (control words, without the \).
const REL_COMMANDS = new Set([
  'le', 'leq', 'ge', 'geq', 'ne', 'neq', 'approx', 'equiv', 'sim', 'simeq', 'cong', 'propto',
  'to', 'rightarrow', 'Rightarrow', 'Leftrightarrow', 'iff', 'implies', 'longrightarrow',
  'Longrightarrow', 'mapsto', 'leqslant', 'geqslant', 'll', 'gg', 'in', 'notin', 'subset',
  'subseteq', 'supset', 'supseteq', 'Leftarrow', 'leftarrow',
]);

const PAPERS = new Set(['grid', 'lines', 'blank']);

// MARK: Page settings

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/// Page geometry with every default filled in. Default page: A4 portrait
/// (1 : √2) at 1240 px wide — 5.9 px/mm — with 5 mm cells, x-height 0.42 cell
/// (≈ 2.1 mm, a tidy school hand), two cells per line of writing.
///
///   { widthPx, heightPx, cellPx, rulePx, paper, xHeightPx, fontSizePx,
///     unit /* lattice step baselines snap to */, pitch /* normal line step */,
///     margin: {top,right,bottom,left}, contentLeft, contentRight,
///     marginLine: 'right'|'left'|'none', marginLineX, clearance }
export function resolvePage(page = {}) {
  const p = page ?? {};
  const widthPx = positive(p.widthPx, 1240);
  const heightPx = positive(p.heightPx, Math.round(widthPx * Math.SQRT2));
  const cellPx = positive(p.cellPx, (widthPx * 5) / 210);
  const paper = PAPERS.has(p.paper) ? p.paper : 'grid';
  const rulePx = positive(p.rulePx, cellPx * 1.6); // 8 mm ruling
  const xHeightPx = positive(p.xHeightPx, 0.42 * cellPx);
  const unit = paper === 'lines' ? rulePx : cellPx;
  const pitch = paper === 'lines' ? rulePx : 2 * cellPx;

  const base = { top: 2 * cellPx, right: 2 * cellPx, bottom: 2 * cellPx, left: 2 * cellPx };
  const given = typeof p.marginPx === 'number' ? { top: p.marginPx, right: p.marginPx, bottom: p.marginPx, left: p.marginPx }
    : (p.marginPx && typeof p.marginPx === 'object' ? p.marginPx : {});
  const margin = {};
  for (const side of Object.keys(base)) margin[side] = Number.isFinite(given[side]) && given[side] >= 0 ? given[side] : base[side];

  const marginLine = ['right', 'left', 'none'].includes(p.marginLine) ? p.marginLine : (paper === 'blank' ? 'none' : 'right');
  // Text starts on a grid line, as a person starts writing at a cell edge.
  let contentLeft = Math.ceil(margin.left / cellPx - 1e-6) * cellPx;
  let contentRight = widthPx - margin.right;
  let marginLineX = null;
  if (marginLine === 'right') {
    marginLineX = Math.floor((widthPx - 3 * cellPx) / cellPx + 1e-6) * cellPx;
    contentRight = Math.min(contentRight, marginLineX - 0.5 * cellPx);
  } else if (marginLine === 'left') {
    marginLineX = Math.ceil((3 * cellPx) / cellPx - 1e-6) * cellPx;
    contentLeft = Math.max(contentLeft, marginLineX + cellPx);
  }
  if (!(contentRight - contentLeft > 4 * xHeightPx)) contentRight = contentLeft + 4 * xHeightPx;

  return {
    widthPx, heightPx, cellPx, rulePx, paper, xHeightPx,
    fontSizePx: xHeightPx / KATEX_X_HEIGHT,
    unit, pitch, margin, contentLeft, contentRight, marginLine, marginLineX,
    clearance: 0.35 * xHeightPx,
  };
}

// MARK: Splitting long formulas at relations

/// Cuts `latex` at top-level relations (outside braces, \left…\right and
/// environments). `mode` 'after' keeps the relation at the end of a piece
/// (TeX's inline break: "a =" | "b"); 'before' starts the next piece with it
/// (a broken display: "a = b" | "= c", the signs then align). Returns the
/// pieces (one piece when there is nowhere to break).
export function splitAtRelations(latex, mode = 'after') {
  const s = String(latex ?? '');
  const cuts = [];
  let depth = 0, lr = 0, env = 0;
  let notStart = -1;
  const top = () => depth === 0 && lr === 0 && env === 0;
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\') {
      let j = i + 1;
      if (j < s.length && /[A-Za-z]/.test(s[j])) while (j < s.length && /[A-Za-z]/.test(s[j])) j++;
      else j++;
      const name = s.slice(i + 1, j);
      if (name === 'left') lr++;
      else if (name === 'right') lr = Math.max(0, lr - 1);
      else if (name === 'begin') env++;
      else if (name === 'end') env = Math.max(0, env - 1);
      else if (name === 'not' && top()) { notStart = i; i = j; continue; }
      else if (top() && REL_COMMANDS.has(name)) cuts.push({ start: notStart >= 0 ? notStart : i, end: j });
      notStart = -1;
      i = j;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if ((c === '=' || c === '<' || c === '>') && top()) cuts.push({ start: notStart >= 0 ? notStart : i, end: i + 1 });
    if (!/\s/.test(c)) notStart = -1;
    i++;
  }
  // Adjacent relations (":=", "\le =") are one break point.
  const merged = [];
  for (const cut of cuts) {
    const prev = merged[merged.length - 1];
    if (prev && !s.slice(prev.end, cut.start).trim()) prev.end = cut.end;
    else merged.push({ ...cut });
  }
  const pieces = [];
  let from = 0;
  for (const cut of merged) {
    const at = mode === 'before' ? cut.start : cut.end;
    const piece = s.slice(from, at);
    if (!piece.trim()) continue;
    if (!s.slice(at).trim()) break;
    pieces.push(piece.trim());
    from = at;
  }
  const rest = s.slice(from).trim();
  if (rest) pieces.push(rest);
  return pieces.length ? pieces : [s];
}

// MARK: Instance helpers (ex units)

function boundsOf(strokes) {
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

/// A copy of `inst` with every point mapped through fn([x,y,t,p]) → [x,y],
/// bbox recomputed, the frame kept (no re-anchoring).
function mapInstance(inst, fn) {
  const strokes = inst.strokes.map((stroke) => stroke.map((p) => {
    const [x, y] = fn(p);
    return [x, y, p[2] ?? 0, p[3] ?? 0];
  }));
  const bbox = boundsOf(strokes);
  return { ...inst, strokes, bbox, width: bbox.maxX - bbox.minX };
}

function scaleInstance(inst, sx, sy, cx = 0, cy = 0) {
  return mapInstance(inst, (p) => [cx + (p[0] - cx) * sx, cy + (p[1] - cy) * sy]);
}

function translateInstance(inst, dx, dy) {
  return mapInstance(inst, (p) => [p[0] + dx, p[1] + dy]);
}

/// Several instances side by side (a sequence substitute such as … → ...),
/// one instance with a continuous clock.
function joinInstances(list, gap) {
  const strokes = [];
  let pen = 0, clock = 0;
  for (const inst of list) {
    const box = boundsOf(inst.strokes);
    let last = clock;
    for (const stroke of inst.strokes) {
      strokes.push(stroke.map((p) => {
        const t = clock + (p[2] ?? 0);
        if (t > last) last = t;
        return [pen + p[0] - box.minX, p[1], t, p[3] ?? 0];
      }));
    }
    pen += box.maxX - box.minX + gap;
    clock = last + 90;
  }
  const bbox = boundsOf(strokes);
  return { key: list[0]?.key ?? '', sample_id: null, strokes, bbox, width: bbox.maxX - bbox.minX };
}

// MARK: Procedural shapes (only for symbols the writer has not written)

/// Unit-box polylines (x right, y down, 0..1) for delimiters, the radical
/// check and accents. `smooth` ones are Catmull–Rom curves through the
/// control points. They stand in for a missing sample so a tall bracket
/// still spans its content; the key is still reported as missing.
const SHAPES = {
  '(': { smooth: true, strokes: [[[0.95, 0], [0.3, 0.22], [0.08, 0.5], [0.3, 0.78], [0.95, 1]]] },
  ')': { smooth: true, strokes: [[[0.05, 0], [0.7, 0.22], [0.92, 0.5], [0.7, 0.78], [0.05, 1]]] },
  '[': { strokes: [[[1, 0], [0, 0], [0, 1], [1, 1]]] },
  ']': { strokes: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
  '{': { smooth: true, strokes: [[[1, 0], [0.55, 0.06], [0.5, 0.4], [0, 0.5], [0.5, 0.6], [0.55, 0.94], [1, 1]]] },
  '}': { smooth: true, strokes: [[[0, 0], [0.45, 0.06], [0.5, 0.4], [1, 0.5], [0.5, 0.6], [0.45, 0.94], [0, 1]]] },
  '|': { strokes: [[[0.5, 0], [0.5, 1]]] },
  '∥': { strokes: [[[0.2, 0], [0.2, 1]], [[0.8, 0], [0.8, 1]]] },
  '⌊': { strokes: [[[0, 0], [0, 1], [1, 1]]] },
  '⌋': { strokes: [[[1, 0], [1, 1], [0, 1]]] },
  '⌈': { strokes: [[[1, 0], [0, 0], [0, 1]]] },
  '⌉': { strokes: [[[0, 0], [1, 0], [1, 1]]] },
  '⟨': { strokes: [[[1, 0], [0, 0.5], [1, 1]]] },
  '⟩': { strokes: [[[0, 0], [1, 0.5], [0, 1]]] },
  '√': { strokes: [[[0, 0.6], [0.16, 0.5], [0.45, 1], [1, 0]]] },
  '→': { strokes: [[[0, 0.5], [1, 0.5]], [[0.7, 0.05], [1, 0.5], [0.7, 0.95]]] },
  '←': { strokes: [[[1, 0.5], [0, 0.5]], [[0.3, 0.05], [0, 0.5], [0.3, 0.95]]] },
  '↔': { strokes: [[[0, 0.5], [1, 0.5]], [[0.8, 0.05], [1, 0.5], [0.8, 0.95]], [[0.2, 0.05], [0, 0.5], [0.2, 0.95]]] },
  'ˆ': { strokes: [[[0, 1], [0.5, 0], [1, 1]]] },
  'ˇ': { strokes: [[[0, 0], [0.5, 1], [1, 0]]] },
  '˜': { smooth: true, strokes: [[[0, 0.8], [0.25, 0.1], [0.5, 0.5], [0.75, 0.9], [1, 0.2]]] },
  '˙': { strokes: [[[0.5, 0.5]]] },
  '¨': { strokes: [[[0.15, 0.5]], [[0.85, 0.5]]] },
};

function catmullRom(points, perSegment = 10) {
  if (points.length < 3) return points;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    for (let k = 0; k < perSegment; k++) {
      const t = k / perSegment, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((a) => 0.5 * ((2 * p1[a]) + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3)));
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/// A procedural instance of `key` filling box {left,right,top,bottom} (ex),
/// or null when there is no shape for it.
function proceduralInstance(key, box) {
  const shape = SHAPES[key];
  if (!shape) return null;
  const w = Math.max(0.05, box.right - box.left), h = Math.max(0.05, box.bottom - box.top);
  let clock = 0;
  const strokes = shape.strokes.map((control) => {
    const pts = shape.smooth ? catmullRom(control) : densify(control, 6);
    return pts.map((q, i) => [box.left + q[0] * w, box.top + q[1] * h, (clock += i ? 9 : 120), 0.5]);
  });
  const bbox = boundsOf(strokes);
  return { key, sample_id: null, strokes, bbox, width: bbox.maxX - bbox.minX };
}

function densify(points, per) {
  if (points.length < 2) return points;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    for (let k = 0; k < per; k++) {
      const t = k / per;
      out.push([points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

// MARK: Composition

const profileCache = new WeakMap();

function profileFor(bank) {
  if (!bank || typeof bank !== 'object') return estimateProfile(new Map());
  let profile = profileCache.get(bank);
  if (!profile) {
    profile = estimateProfile(bank);
    profileCache.set(bank, profile);
  }
  return profile;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/// Lays `blocks` (solution.parseSolution) out on notebook pages in the
/// writer's hand. `ctx`:
///   { glyphs: GlyphBank, words: WordBank, profile?, knobs?, textModel?,
///     page?: {widthPx, heightPx, marginPx, cellPx, paper, xHeightPx, rulePx, marginLine} }
/// Characters that are TeX markup rather than symbols (seen only when a
/// formula KaTeX refused is written out as text).
const TEX_SYNTAX = new Set([...'\\{}^_&$#%~']);

/// KaTeX's parse error in a few Russian words, or '' when it is not one of
/// the common cases — the raw English message (with its combining
/// underlines) is not something to show a writer.
function katexReason(error) {
  const text = String(error ?? '').replace(/\u0332/g, '');
  const command = text.match(/Undefined control sequence: (\\[A-Za-z]+|\\.)/);
  if (command) return `неизвестная команда ${command[1]}`;
  if (/Expected '\}'|Unexpected end of input|Extra \}|Expected group/.test(text)) return 'непарные фигурные скобки';
  if (/Missing \$|Can't use function '\$'/.test(text)) return 'лишний знак $';
  return '';
}

/// Returns { pages: Page[], missing: Map<key, count>, warnings: string[], stats }.
/// Page = { width, height, paper, cellPx, rulePx, xHeightPx, marginLineX,
///          strokes: [{points: [[x,y,t,p]…], weight?}], fallbacks: [{char, x, baseline,
///          sizePx, font, width, procedural?}], lines: [{baseline, top, bottom, kind}],
///          formulas: [{latex, display, x, baseline, fontSizePx, width}] }
/// `weight` (× the pen's width) is set on strokes written harder than usual.
/// `ctx.textModelTimeoutMs` overrides the per-word timeout of `textModel`.
export async function composeSolution(blocks, ctx = {}) {
  const started = now();
  // KaTeX loads on the first formula (layoutFormula → ensureKatex), so a
  // text-only page never pays for it — and composes even without a DOM.
  const composer = new Composer(ctx);
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'gap') composer.enterQuote(block.quote);
    switch (block.type) {
      case 'gap': composer.gap(); break;
      case 'display': await composer.display(String(block.latex ?? ''), composer.boxFor(block)); break;
      case 'para': await composer.para(runsOf(block), composer.boxFor(block)); break;
      case 'heading': await composer.heading(block); break;
      case 'item': await composer.item(block); break;
      case 'table': await composer.table(block); break;
      case 'code': await composer.code(block); break;
      case 'rule': composer.rule(block); break;
      default: break;
    }
  }
  return composer.finish(now() - started);
}

function runsOf(block) {
  return Array.isArray(block?.runs) ? block.runs : [];
}

function level(value, max) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
}

/// Width of atoms flowed side by side (spaces between them).
function flowWidth(atoms) {
  return atoms.reduce((w, a, k) => w + a.width + (k ? a.space : 0), 0);
}

/// Right edge of a broken line (entries at x relative to its start).
function lineWidth(line) {
  const tail = line[line.length - 1];
  return tail ? tail.x + tail.atom.width : 0;
}

const identity = (x, y) => [x, y];

class Composer {
  constructor(ctx) {
    this.s = resolvePage(ctx.page);
    this.knobs = resolveKnobs(ctx.knobs);
    this.seed = this.knobs.seed;
    this.glyphs = ctx.glyphs instanceof Map ? ctx.glyphs : new Map();
    this.profile = ctx.profile ?? profileFor(this.glyphs);
    this.recent = new Map();
    this.text = createTextInk({
      glyphs: this.glyphs, words: ctx.words instanceof Map ? ctx.words : new Map(),
      profile: this.profile, knobs: this.knobs, model: ctx.textModel ?? null, recent: this.recent,
      ...(Number.isFinite(ctx.textModelTimeoutMs) ? { modelTimeoutMs: ctx.textModelTimeoutMs } : {}),
    });
    this.pages = [];
    this.page = null;
    this.prev = null;
    this.pendingGap = 0;
    this.missing = new Map();
    this.warningSet = new Set();
    this.n = { glyph: 0, rule: 0, word: 0, line: 0, space: 0, formula: 0 };
    this.layoutMs = 0;
    /// Pen weight of what is being written now (1 = normal).
    this.weight = 1;
    /// Open quote bars, one per level: {page, top, bottom} of the lines so far.
    this.quoteSpans = [];
    this.quoteDepth = 0;
    /// The code block being written: {left, right, span}.
    this.frame = null;
  }

  warn(message) { this.warningSet.add(message); }

  miss(key) { this.missing.set(key, (this.missing.get(key) ?? 0) + 1); }

  finish(ms) {
    this.enterQuote(0);
    for (const page of this.pages) delete page.clock;
    for (const w of this.text.warnings) this.warn(w);
    return {
      pages: this.pages,
      missing: this.missing,
      warnings: [...this.warningSet],
      stats: {
        ms, layoutMs: this.layoutMs, formulas: this.n.formula, glyphs: this.n.glyph, rules: this.n.rule,
        words: this.n.word, lines: this.n.line, sources: { ...this.text.stats },
      },
    };
  }

  // --- vertical flow ------------------------------------------------------------

  newPage() {
    const s = this.s;
    this.page = {
      width: s.widthPx, height: s.heightPx, paper: s.paper, cellPx: s.cellPx, rulePx: s.rulePx,
      xHeightPx: s.xHeightPx, marginLineX: s.marginLineX, marginTop: s.margin.top,
      marginBottom: s.margin.bottom, strokes: [], fallbacks: [], lines: [], formulas: [], clock: 0,
    };
    this.pages.push(this.page);
    this.prev = null;
    this.pendingGap = 0;
  }

  gap() {
    if (this.prev) this.pendingGap += 1;
  }

  /// First lattice line at or below y.
  snapDown(y) {
    const u = this.s.unit;
    return Math.ceil(y / u - 1e-6) * u;
  }

  /// Last lattice line at or above y.
  snapUp(y) {
    const u = this.s.unit;
    return Math.floor(y / u + 1e-6) * u;
  }

  /// Where a line with this ascent/descent goes: its baseline on a lattice
  /// line at least one pitch below the previous line, pushed down by whole
  /// cells until its top clears the previous line's bottom; a new page when
  /// its bottom would cross the bottom margin.
  placeLine(ascent, descent, kind) {
    const s = this.s;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.page) this.newPage();
      let baseline;
      if (this.prev) {
        const min = this.prev.baseline + s.pitch + this.pendingGap * s.unit;
        baseline = Math.max(min, this.snapDown(this.prev.bottom + s.clearance + ascent));
      } else {
        baseline = Math.max(this.snapDown(s.margin.top + s.unit), this.snapDown(s.margin.top + ascent));
      }
      if (baseline + descent > s.heightPx - s.margin.bottom && this.prev && attempt === 0) {
        this.newPage();
        continue;
      }
      if (baseline + descent > s.heightPx - s.margin.bottom) this.warn('Строка выше страницы — она выходит за нижнее поле');
      this.prev = { baseline, bottom: baseline + descent };
      this.pendingGap = 0;
      this.page.lines.push({ baseline: r2(baseline), top: r2(baseline - ascent), bottom: r2(baseline + descent), kind });
      this.noteLine(this.page, baseline - ascent, baseline + descent);
      return { page: this.page, baseline };
    }
    throw new Error('unreachable');
  }

  /// A horizontal rule's place (a table's top edge): the first lattice line
  /// below what is already written (and below a pending gap), on a new page
  /// when there is no room for the rule plus a line under it. What follows is
  /// placed below the rule, as below a line of writing.
  ruleSlot(room = 2 * this.s.pitch) {
    const s = this.s;
    if (!this.page) this.newPage();
    let y = this.prev ? this.snapDown(this.prev.bottom + 0.1 * s.unit + this.pendingGap * s.unit) : this.snapDown(s.margin.top);
    if (y + room > s.heightPx - s.margin.bottom && this.prev) {
      this.newPage();
      y = this.snapDown(s.margin.top);
    }
    this.coverBelow(y);
    return y;
  }

  /// The next line goes below y: at least one lattice step under it.
  coverBelow(y) {
    const s = this.s;
    this.prev = { baseline: y - s.pitch + s.unit, bottom: y };
    this.pendingGap = 0;
  }

  /// A hand-drawn straight line in page px (no line drift: rulings are drawn
  /// along the paper, not along the writing).
  handLine(page, x1, y1, x2, y2) {
    const r = Rng.derive(this.seed, 'rule', this.n.rule++);
    const weight = this.weight;
    this.weight = 1;
    this.emit(page, [handRule(x1, y1, x2, y2, r, this.knobs, { px: this.s.xHeightPx })], identity);
    this.weight = weight;
  }

  // --- containers: where a block hangs, quote bars, code frames ---------------------

  /// The text column of a block: indented by its quote and list levels (an
  /// item's own text starts at its depth), never narrower than half the page.
  boxFor(block, depth = block?.depth) {
    const s = this.s;
    const c = s.cellPx;
    const indent = level(block?.quote, 8) * QUOTE_INDENT_CELLS * c + level(depth, 12) * LIST_INDENT_CELLS * c;
    const maxLeft = s.contentLeft + (s.contentRight - s.contentLeft) / 2;
    return { left: Math.min(s.contentLeft + indent, maxLeft), right: s.contentRight };
  }

  enterQuote(quote) {
    const q = level(quote, 8);
    for (let lv = this.quoteSpans.length; lv > q; lv--) {
      const span = this.quoteSpans[lv - 1];
      if (span) this.drawQuoteBar(lv, span);
    }
    if (this.quoteSpans.length > q) this.quoteSpans.length = q;
    this.quoteDepth = q;
  }

  /// A placed line (page px, top..bottom) extends the open quote bars and
  /// code frame; on a new page they are closed there and restarted.
  noteLine(page, top, bottom) {
    const extend = (span) => {
      if (span && span.page === page) {
        span.top = Math.min(span.top, top);
        span.bottom = Math.max(span.bottom, bottom);
        return span;
      }
      return { page, top, bottom };
    };
    for (let lv = 1; lv <= this.quoteDepth; lv++) {
      const span = this.quoteSpans[lv - 1];
      if (span && span.page !== page) this.drawQuoteBar(lv, span);
      this.quoteSpans[lv - 1] = extend(span);
    }
    if (this.frame) {
      if (this.frame.span && this.frame.span.page !== page) this.drawFrame(this.frame);
      this.frame.span = extend(this.frame.span);
    }
  }

  drawQuoteBar(lv, span) {
    const s = this.s;
    const x = s.contentLeft + ((lv - 1) * QUOTE_INDENT_CELLS + 0.45) * s.cellPx;
    const pad = 0.25 * s.xHeightPx;
    this.handLine(span.page, x, span.top - pad, x, span.bottom + pad);
  }

  /// A code frame around its span, its horizontal edges on lattice lines.
  drawFrame(frame) {
    const { span } = frame;
    if (!span) return null;
    const c = this.s.cellPx;
    const top = this.snapUp(span.top - 0.25 * c);
    const bottom = this.snapDown(span.bottom + 0.25 * c);
    const { left, right } = frame;
    this.handLine(span.page, left, top, right, top);
    this.handLine(span.page, right, top, right, bottom);
    this.handLine(span.page, right, bottom, left, bottom);
    this.handLine(span.page, left, bottom, left, top);
    frame.span = null;
    return { page: span.page, bottom };
  }

  // --- atoms -----------------------------------------------------------------------

  async layout(latex, display, fontSizePx) {
    const t0 = now();
    const layout = await layoutFormula(latex, { display, fontSizePx, normalizeKey });
    this.layoutMs += now() - t0;
    for (const w of layout.warnings ?? []) this.warn(w);
    return layout;
  }

  /// A word, `scale` × the page's handwriting size. `index` is the word's
  /// position (its seed); atomsForMany reserves them before prefetching.
  async wordAtom(token, spaced, scale = 1, index = this.n.word++) {
    const ink = await this.text.renderWord(token, Rng.derive(this.seed, 'word', index));
    const xh = this.s.xHeightPx * scale;
    return {
      kind: 'word', token, ink, xh,
      width: ink.width * xh,
      ascent: Math.max(1, -ink.bbox.minY) * xh,
      descent: Math.max(0, ink.bbox.maxY) * xh,
      breakBefore: spaced,
      space: spaced ? this.text.spaceWidth(Rng.derive(this.seed, 'space', index)) * xh : 0.08 * xh,
      weight: 1,
    };
  }

  mathAtomFrom(latex, layout, fontSizePx, spaced, space) {
    const b = layout.bounds ?? { left: 0, right: layout.width, top: -layout.height, bottom: layout.depth };
    const offset = Math.max(0, -b.left);
    return {
      kind: 'math', latex, layout, fontSizePx, offset,
      xh: fontSizePx * KATEX_X_HEIGHT,
      width: b.right + offset,
      ascent: Math.max(0, -b.top),
      descent: Math.max(0, b.bottom),
      breakBefore: spaced,
      space,
      split: false,
      weight: 1,
    };
  }

  /// Carries a run's look (and a formula's display style) from `from` over to
  /// an atom made from it — a split, shrunk or hyphenated piece.
  restyle(atom, from) {
    atom.weight = from.weight ?? 1;
    atom.italic = !!from.italic;
    atom.strike = !!from.strike;
    if (from.display) atom.display = true;
    return atom;
  }

  spaceFor(spaced, scale = 1) {
    const xh = this.s.xHeightPx * scale;
    return spaced ? this.text.spaceWidth(Rng.derive(this.seed, 'space', `m${this.n.space++}`)) * xh : 0.08 * xh;
  }

  /// A formula that KaTeX refused is written out as text, so nothing silently
  /// disappears; the warning says which one. Its TeX syntax characters are
  /// not «missing symbols» — nobody should be sent to handwrite a backslash.
  async failedMathAtoms(latex, error, spaced, scale = 1) {
    const reason = katexReason(error);
    this.warn(`Формула не разобрана и записана как текст: ${latex}${reason ? ` (${reason})` : ''}`);
    const atoms = [];
    let first = true;
    for (const token of latex.split(/\s+/).filter(Boolean)) {
      const atom = await this.wordAtom(token, first ? spaced : true, scale);
      atom.literalTeX = true;
      atoms.push(atom);
      first = false;
    }
    return atoms;
  }

  /// Runs → atoms. `base`: { scale, bold } for the whole block (a heading, a
  /// table header). A run's bold is pressure, italic extra slant, strike a
  /// line through; a run's `display` math is laid out in display style.
  async atomsFor(runs, base = {}) {
    return (await this.atomsForMany([{ runs, base }]))[0];
  }

  /// atomsFor for several run lists at once (a table's cells, a code block's
  /// lines, an item's marker and text): every word gets its position — and
  /// so its seed — first, the handwriting model is asked for all of them
  /// together, then the atoms are built in order.
  async atomsForMany(items) {
    const plans = items.map(({ runs, base = {} }) => {
      const steps = [];
      let spaced = false;
      for (const run of Array.isArray(runs) ? runs : []) {
        const look = { weight: run?.bold || base.bold ? BOLD_WEIGHT : 1, italic: !!run?.italic, strike: !!run?.strike };
        if (run?.type === 'text') {
          for (const part of String(run.text ?? '').split(/(\s+)/u)) {
            if (!part) continue;
            if (/^\s+$/u.test(part)) { spaced = true; continue; }
            steps.push({ word: part, spaced, look, index: this.n.word++ });
            spaced = false;
          }
        } else if (run?.type === 'math') {
          steps.push({ run, spaced, look });
          spaced = false;
        }
      }
      return { steps, scale: Number.isFinite(base.scale) && base.scale > 0 ? base.scale : 1 };
    });
    this.text.prefetch(plans.flatMap((plan) => plan.steps.filter((step) => step.word)
      .map((step) => ({ text: step.word, rng: Rng.derive(this.seed, 'word', step.index) }))));

    const out = [];
    for (const { steps, scale } of plans) {
      const atoms = [];
      for (const { word, run, spaced, look, index } of steps) {
        if (word) {
          atoms.push(this.restyle(await this.wordAtom(word, spaced, scale, index), look));
          continue;
        }
        const latex = String(run.latex ?? '');
        const display = !!run.display;
        const size = this.s.fontSizePx * scale;
        this.n.formula++;
        const layout = await this.layout(latex, display, size);
        if (!layout.ok) {
          for (const atom of await this.failedMathAtoms(latex, layout.error, spaced, scale)) atoms.push(this.restyle(atom, look));
        } else {
          const atom = this.mathAtomFrom(latex, layout, size, spaced, this.spaceFor(spaced, scale));
          atoms.push(this.restyle(atom, { ...look, italic: false, display }));
        }
      }
      out.push(atoms);
    }
    return out;
  }

  /// An inline formula broken after its top-level relations, as TeX breaks
  /// inline math. The pieces keep KaTeX's own spacing: a relation at the end
  /// of a piece has none after it, so a thick space goes before the next.
  async splitInline(atom) {
    atom.split = true;
    const pieces = splitAtRelations(atom.latex, 'after');
    if (pieces.length < 2) return [atom];
    const out = [];
    for (let i = 0; i < pieces.length; i++) {
      const layout = await this.layout(pieces[i], !!atom.display, atom.fontSizePx);
      if (!layout.ok) return [atom];
      const piece = this.mathAtomFrom(pieces[i], layout, atom.fontSizePx,
        i === 0 ? atom.breakBefore : true, i === 0 ? atom.space : THICK_SPACE_EM * atom.fontSizePx);
      piece.split = true;
      out.push(this.restyle(piece, atom));
    }
    return out;
  }

  /// The formula re-laid out by KaTeX at a smaller size. KaTeX's script sizes
  /// do not scale linearly (they have floors), so when a `target` width is
  /// given the size is refined until it fits or reaches MIN_SHRINK — and,
  /// only if it still doesn't fit there, OVERFLOW_MIN_SHRINK.
  async shrinkMath(atom, factor, target = Infinity) {
    let f = factor;
    let floor = MIN_SHRINK;
    let next = atom;
    for (let attempt = 0; attempt < 6; attempt++) {
      const size = atom.fontSizePx * f;
      const layout = await this.layout(atom.latex, !!atom.display, size);
      if (!layout.ok) return next;
      next = this.restyle(this.mathAtomFrom(atom.latex, layout, size, atom.breakBefore, atom.space), atom);
      next.split = true;
      if (next.width <= target) break;
      if (f <= floor) {
        if (floor <= OVERFLOW_MIN_SHRINK || !Number.isFinite(target)) break;
        floor = OVERFLOW_MIN_SHRINK;
      }
      f = Math.max(floor, f * (target / next.width) * 0.99);
    }
    return next;
  }

  /// The warning for a shrunk formula: the size it actually got, and — when
  /// even that is wider than `room` — that it runs past the margin.
  warnShrunk(before, after, room, where) {
    const percent = Math.round((after.fontSizePx / before.fontSizePx) * 100);
    if (after.width > room + 0.5) {
      this.warn(`Формула шире ${where} даже при уменьшении до ${percent} % и выходит за поле — разбейте её на несколько формул`);
    } else {
      this.warn(`Формула не помещается ${where === 'строки' ? 'в строку' : 'по ширине'} — уменьшена до ${percent} %`);
    }
  }

  /// A word longer than a whole line is broken with a hyphen, as by hand:
  /// the head that fits (estimated from the word's mean letter width) plus
  /// «-», then the rest as the next word.
  async splitWord(atom, avail) {
    const chars = [...atom.token];
    const perChar = atom.width / chars.length;
    const scale = atom.xh / this.s.xHeightPx;
    const n = Math.max(2, Math.min(chars.length - 2, Math.floor((avail - 1.2 * atom.xh) / perChar)));
    const head = this.restyle(await this.wordAtom(`${chars.slice(0, n).join('')}-`, atom.breakBefore, scale), atom);
    head.space = atom.space;
    const tail = this.restyle(await this.wordAtom(chars.slice(n).join(''), true, scale), atom);
    return [head, tail];
  }

  /// A drawn check box for a task item («- [ ]» / «- [x]»).
  checkboxAtom(checked) {
    const xh = this.s.xHeightPx;
    return { kind: 'checkbox', checked, xh, width: 1.05 * xh, ascent: 1.05 * xh, descent: 0, space: 0, breakBefore: false, weight: 1 };
  }

  // --- horizontal flow ---------------------------------------------------------------

  /// Breaks atoms into lines no wider than `avail`: [[{atom, x}]], x from the
  /// line's start. Words wrap at spaces; an inline formula too wide for the
  /// rest of a line breaks after a relation; a lone word longer than a line
  /// is hyphenated; formulas still too wide are shrunk.
  async breakLines(atoms, avail) {
    const lines = [];
    let line = [];
    let x = 0;
    const flush = () => {
      if (line.length) lines.push(line);
      line = [];
      x = 0;
    };
    const place = (group) => {
      for (const atom of group) {
        if (line.length) x += atom.space;
        line.push({ atom, x });
        x += atom.width;
      }
    };
    let i = 0;
    while (i < atoms.length) {
      let j = i + 1;
      while (j < atoms.length && !atoms[j].breakBefore) j++;
      const group = atoms.slice(i, j);
      const inner = flowWidth(group);
      const lead = line.length ? group[0].space : 0;
      if (x + lead + inner <= avail + 0.5) {
        place(group);
        i = j;
        continue;
      }
      const k = group.findIndex((a) => a.kind === 'math' && !a.split &&
        (a.width > SPLIT_MIN_SHARE * avail || inner > avail));
      if (k >= 0) {
        const pieces = await this.splitInline(group[k]);
        atoms.splice(i + k, 1, ...pieces);
        continue;
      }
      if (line.length) {
        flush();
        continue;
      }
      // Alone on a line and still too wide: break a long word, shrink formulas.
      const longWord = group.findIndex((a) => a.kind === 'word' && a.width > avail * 0.6 && [...a.token].length >= 6);
      if (longWord >= 0 && !group[longWord].hyphenated) {
        const parts = await this.splitWord(group[longWord], avail);
        parts[0].hyphenated = true; // an estimate that overshoots a little just overflows
        parts[1].hyphenated = [...parts[1].token].length < 6;
        atoms.splice(i + longWord, 1, ...parts);
        this.warn('Слишком длинное слово перенесено по частям');
        continue;
      }
      const mathWidth = group.reduce((w, a) => w + (a.kind === 'math' ? a.width : 0), 0);
      if (mathWidth > 0) {
        const room = avail - (inner - mathWidth);
        const factor = Math.max(MIN_SHRINK, Math.min(1, room / mathWidth));
        let widest = null;
        for (let m = 0; m < group.length; m++) {
          if (group[m].kind === 'math') {
            const before = group[m];
            // Each formula's share of the room; below MIN_SHRINK only when
            // the group cannot fit otherwise (shrinkMath's second floor).
            // (Words alone overflowing the line are no reason to go below it.)
            const share = room > 0 ? (before.width / mathWidth) * room * 0.99 : before.width * factor * 0.99;
            group[m] = atoms[i + m] = await this.shrinkMath(before, factor * 0.99, share);
            if (!widest || before.width > widest.before.width) widest = { before, after: group[m] };
          }
        }
        this.warnShrunk(widest.before, widest.after, widest.after.width + (avail - flowWidth(group)), 'строки');
      } else {
        this.warn(`Слово не помещается в строку: ${group.map((a) => a.token).join('')}`);
      }
      place(group);
      i = j;
    }
    flush();
    return lines;
  }

  /// A paragraph in `box`. Options: `style` for atomsFor, `align` of every
  /// line in the box, `marker` — an entry {atom, x} (page px) written before
  /// the first line, the list item's dash or number — `underline`, and
  /// `atoms` when the runs were already turned into atoms.
  async para(runs, box = this.boxFor(null), { style = {}, align = 'left', marker = null, kind = 'text', underline = false, atoms: given = null } = {}) {
    const atoms = given ?? await this.atomsFor(runs, style);
    if (!atoms.length && !marker) return;
    const avail = box.right - box.left;
    const lines = atoms.length ? await this.breakLines(atoms, avail) : [[]];
    lines.forEach((line, n) => {
      const width = lineWidth(line);
      const shift = align === 'center' ? Math.max(0, (avail - width) / 2) : align === 'right' ? Math.max(0, avail - width) : 0;
      const entries = line.map((e) => ({ atom: e.atom, x: box.left + shift + e.x }));
      if (n === 0 && marker) entries.unshift({ ...marker, marker: true });
      if (entries.length) this.drawLine(entries, kind, { underline });
    });
  }

  async heading(block) {
    const look = HEADING_STYLES[Math.min(Math.max(level(block.level, 6), 1), HEADING_STYLES.length) - 1];
    await this.para(runsOf(block), this.boxFor(block), {
      style: { scale: look.scale, bold: !!look.bold }, align: look.align, kind: 'heading', underline: !!look.underline,
    });
  }

  /// A list item: the marker in the slot left of the item's text column —
  /// a bullet at the slot's start, a number right-aligned to the text, a
  /// task's check box — and the text hanging at the column, wrapped lines too.
  async item(block) {
    const s = this.s;
    const c = s.cellPx;
    const box = this.boxFor(block, Math.max(1, level(block.depth, 12)));
    const slot = Math.max(s.contentLeft, box.left - LIST_INDENT_CELLS * c);
    const task = block.task === 'open' || block.task === 'done';
    const [markerAtoms, atoms] = await this.atomsForMany([
      { runs: task ? [] : [{ type: 'text', text: String(block.marker || '—').replace(/\s+/g, '') || '—' }] },
      { runs: runsOf(block) },
    ]);
    let marker;
    if (task) {
      marker = { atom: this.checkboxAtom(block.task === 'done'), x: slot + 0.3 * c };
    } else {
      const atom = markerAtoms[0];
      const x = block.ordered ? Math.max(s.contentLeft, box.left - 0.4 * c - atom.width) : slot + 0.2 * c;
      marker = { atom, x };
    }
    await this.para(runsOf(block), box, { marker, kind: 'item', atoms });
  }

  /// A --- rule: a line of its own, drawn across the text column mid-cell.
  rule(block) {
    const s = this.s;
    const box = this.boxFor(block);
    const { page, baseline } = this.placeLine(0.5 * s.xHeightPx, 0, 'rule');
    const y = baseline - 0.5 * s.cellPx;
    this.handLine(page, box.left, y, box.right, y);
  }

  /// A fenced code block, line by line with its indentation, in a frame that
  /// hugs the longest line. Long lines wrap with a deeper indent.
  async code(block) {
    const s = this.s;
    const c = s.cellPx;
    const xh = s.xHeightPx;
    const box = this.boxFor(block);
    const source = (Array.isArray(block.lines) ? block.lines : []).map((l) => String(l ?? '').replace(/\s+$/, ''));
    if (!source.some(Boolean)) return;
    const pad = 0.6 * c;
    const space = CODE_SPACE_EX * xh;
    const lineAtoms = await this.atomsForMany(source.map((text) => ({ runs: [{ type: 'text', text: text.trim() }] })));
    const prepared = [];
    let widest = 0;
    source.forEach((text, n) => {
      const indent = /^ */.exec(text)[0].length * space;
      prepared.push({ indent, atoms: lineAtoms[n] });
      widest = Math.max(widest, indent + flowWidth(lineAtoms[n]));
    });
    // Room for the widest line plus the deeper indent of a wrapped one, so a
    // line that fits the frame is never wrapped by it.
    const right = Math.min(box.right, box.left + Math.ceil((widest + 2 * space + 2 * pad) / c - 1e-6) * c);
    const inner = right - box.left - 2 * pad;
    if (this.prev) this.pendingGap = Math.max(this.pendingGap, 1);
    this.frame = { left: box.left, right, span: null };
    for (const { indent, atoms } of prepared) {
      if (!atoms.length) {
        if (this.prev) this.pendingGap += s.pitch / s.unit;
        continue;
      }
      const room = Math.max(inner * 0.3, inner - indent - 2 * space);
      const lines = await this.breakLines(atoms, room);
      lines.forEach((line, n) => {
        const left = box.left + pad + Math.min(indent, inner - room) + (n ? 2 * space : 0);
        this.drawLine(line.map((e) => ({ atom: e.atom, x: left + e.x })), 'code');
      });
    }
    const closed = this.drawFrame(this.frame);
    this.frame = null;
    if (closed && closed.page === this.page && this.prev) {
      this.prev.bottom = Math.max(this.prev.bottom, closed.bottom);
    }
  }

  /// A table, ruled by hand along the grid. Columns get their content's
  /// width (whole cells, padding on both sides); when the page is too narrow,
  /// each keeps at least its widest word or formula and the rest is shared by
  /// how much each column wanted, text wrapping inside its cell. A row is as
  /// many lines as its fullest cell, a rule goes under every row, and the
  /// vertical rules are drawn per page when the table breaks across pages.
  async table(block) {
    const s = this.s;
    const c = s.cellPx;
    const box = this.boxFor(block);
    const header = Array.isArray(block.header) ? block.header : null;
    const rows = [...(header ? [header] : []), ...(Array.isArray(block.rows) ? block.rows : [])].filter(Array.isArray);
    const cols = Math.max(0, ...rows.map((r) => r.length));
    if (!rows.length || !cols) return;
    const align = Array.isArray(block.align) ? block.align : [];
    const pad = 0.5 * c;
    const snap = (w) => Math.ceil(w / c - 1e-6) * c;
    const sum = (list) => list.reduce((a, b) => a + b, 0);

    const flat = await this.atomsForMany(rows.flatMap((row, r) => Array.from({ length: cols }, (_, k) => ({
      runs: Array.isArray(row[k]) ? row[k] : [],
      base: header && r === 0 ? { bold: true } : {},
    }))));
    const cells = rows.map((_, r) => flat.slice(r * cols, (r + 1) * cols));
    const natural = [];
    const minimum = [];
    for (let k = 0; k < cols; k++) {
      natural.push(Math.max(...cells.map((row) => flowWidth(row[k]))));
      minimum.push(Math.max(...cells.map((row) => Math.max(0, ...row[k].map((a) => a.width)))));
    }
    const avail = box.right - box.left;
    let widths = natural.map((w) => Math.max(2 * c, snap(w + 2 * pad)));
    if (sum(widths) > avail) {
      const mins = minimum.map((w) => Math.max(2 * c, snap(w + 2 * pad)));
      const minTotal = sum(mins);
      if (minTotal >= avail) {
        widths = mins.map((w) => Math.max(c, Math.floor((w * avail) / minTotal / c + 1e-6) * c));
        this.warn('Таблица шире страницы — столбцы сужены до предела, широкие формулы в ней уменьшены');
      } else {
        const want = widths.map((w, k) => w - mins[k]);
        const wantTotal = sum(want);
        widths = mins.map((w, k) => w + Math.floor(((avail - minTotal) * want[k]) / wantTotal / c + 1e-6) * c);
      }
    }
    const xs = [];
    let edge = box.left;
    for (const w of widths) { xs.push(edge); edge += w; }
    const right = edge;

    const cellLines = [];
    for (const row of cells) {
      const out = [];
      for (let k = 0; k < cols; k++) out.push(row[k].length ? await this.breakLines(row[k], widths[k] - 2 * pad) : []);
      cellLines.push(out);
    }

    let seg = null;
    const openSeg = (y) => {
      seg = { page: this.page, top: y, bottom: y };
      this.handLine(this.page, box.left, y, right, y);
    };
    const closeSeg = () => {
      if (!seg || seg.bottom <= seg.top) return;
      for (const x of [...xs, right]) this.handLine(seg.page, x, seg.top, x, seg.bottom);
    };
    openSeg(this.ruleSlot());
    for (let r = 0; r < cellLines.length; r++) {
      const count = Math.max(1, ...cellLines[r].map((l) => l.length));
      // A row that does not fit goes to the next page whole (unless it is the
      // first row there, which then simply runs on).
      if (seg.bottom > seg.top && seg.bottom + count * s.pitch + s.unit > s.heightPx - s.margin.bottom) {
        closeSeg();
        this.newPage();
        openSeg(this.ruleSlot());
      }
      for (let n = 0; n < count; n++) {
        const entries = [];
        for (let k = 0; k < cols; k++) {
          const line = cellLines[r][k][n];
          if (!line) continue;
          const width = lineWidth(line);
          const inner = widths[k] - 2 * pad;
          const how = align[k];
          const shift = how === 'center' ? (inner - width) / 2 : how === 'right' ? inner - width : 0;
          for (const e of line) entries.push({ atom: e.atom, x: xs[k] + pad + Math.max(0, shift) + e.x });
        }
        const pageBefore = this.page;
        if (entries.length) this.drawLine(entries, 'table');
        else this.placeLine(s.xHeightPx, 0, 'table');
        if (this.page !== pageBefore) {
          // A row taller than what was left of the page: rule it off there
          // and start the table again on the new page, above this line.
          closeSeg();
          const line = this.page.lines[this.page.lines.length - 1];
          openSeg(this.snapUp(line.top - 0.2 * c));
        }
      }
      const y = this.snapDown(this.prev.bottom + 0.1 * s.unit);
      this.handLine(this.page, box.left, y, right, y);
      seg.bottom = y;
      this.coverBelow(y);
    }
    closeSeg();
  }

  async display(latex, box = this.boxFor(null)) {
    const s = this.s;
    const L = box.left;
    const R = box.right;
    const avail = R - L;
    this.n.formula++;
    const layout = await this.layout(latex, true, s.fontSizePx);
    if (!layout.ok) {
      const atoms = await this.failedMathAtoms(latex, layout.error, false);
      let x = L;
      const line = [];
      for (const atom of atoms) {
        if (line.length) x += atom.space;
        line.push({ atom, x });
        x += atom.width;
      }
      if (line.length) this.drawLine(line, 'text');
      return;
    }
    const whole = this.mathAtomFrom(latex, layout, s.fontSizePx, false, 0);
    whole.display = true;
    if (whole.width <= avail) {
      this.drawLine([{ atom: whole, x: L + (avail - whole.width) / 2 }], 'display');
      return;
    }

    // Too wide: break before relations, continuation lines start with their
    // relation under the first line's first relation, as written by hand.
    const pieces = splitAtRelations(latex, 'before');
    if (pieces.length < 2) {
      const factor = Math.max(MIN_SHRINK, avail / whole.width);
      const small = await this.shrinkMath(whole, factor * 0.99, avail);
      this.warnShrunk(whole, small, avail, 'страницы');
      this.drawLine([{ atom: small, x: L + Math.max(0, (avail - small.width) / 2) }], 'display');
      return;
    }
    this.warn('Длинная формула перенесена на несколько строк');
    const lhs = await this.layout(pieces[0], true, s.fontSizePx);
    const lhsWidth = lhs.ok ? lhs.width + THICK_SPACE_EM * s.fontSizePx : 0;
    const indent = Math.min(s.cellPx * 2, avail / 4);
    const lines = [];
    let current = [];
    const widthOf = async (list) => {
      const l = await this.layout(list.join(' '), true, s.fontSizePx);
      return l.ok ? this.mathAtomFrom(list.join(' '), l, s.fontSizePx, false, 0) : null;
    };
    for (const piece of pieces) {
      const trial = [...current, piece];
      const atom = await widthOf(trial);
      const room = avail - (lines.length ? Math.min(lhsWidth + indent, avail / 2) : indent);
      if (current.length && (!atom || atom.width > room)) {
        lines.push(current);
        current = [piece];
      } else {
        current = trial;
      }
    }
    if (current.length) lines.push(current);
    for (let n = 0; n < lines.length; n++) {
      let atom = await widthOf(lines[n]);
      if (!atom) continue;
      atom.display = true;
      const left = n === 0 ? L + indent : L + Math.min(lhsWidth + indent, avail / 2);
      if (left + atom.width > R) {
        if (atom.width > avail) {
          const factor = Math.max(MIN_SHRINK, avail / atom.width);
          const before = atom;
          atom = await this.shrinkMath(atom, factor * 0.99, avail);
          this.warnShrunk(before, atom, avail, 'страницы');
        }
        this.drawLine([{ atom, x: Math.max(L, R - atom.width) }], 'display');
      } else {
        this.drawLine([{ atom, x: left }], 'display');
      }
    }
  }

  // --- drawing -----------------------------------------------------------------------

  drawLine(entries, kind, { underline = false } = {}) {
    const ascent = Math.max(this.s.xHeightPx, ...entries.map((e) => e.atom.ascent));
    const descent = Math.max(0, ...entries.map((e) => e.atom.descent));
    const { page, baseline } = this.placeLine(ascent, descent, kind);
    const drift = lineDrift(Rng.derive(this.seed, 'line', this.n.line++), this.profile, this.knobs);
    const xh = this.s.xHeightPx;
    const x0 = entries[0].x;
    // The line's slow walk (drift) bends everything on it the same way — text
    // and formulas alike — so a formula never jumps off the line it is on.
    const warp = (x, y) => {
      const d = drift((x - x0) / xh);
      const rel = y - baseline;
      return [x - rel * Math.tan(d.slant), baseline + rel * d.scale + d.dy * xh];
    };
    for (const { atom, x } of entries) {
      this.weight = atom.weight ?? 1;
      if (atom.kind === 'word') {
        this.drawWord(page, atom, x, baseline, warp);
      } else if (atom.kind === 'checkbox') {
        this.drawCheckbox(page, atom, x, baseline, warp);
      } else {
        // Where KaTeX's own rendering of this formula would sit (before the
        // hand's drift) — for hit-testing in the UI and for overlay checks.
        page.formulas.push({
          latex: atom.latex, display: !!atom.display, x: r2(x + atom.offset), baseline: r2(baseline),
          fontSizePx: r3(atom.fontSizePx), width: r2(atom.layout.width),
        });
        this.drawFormula(page, atom.layout, x + atom.offset, baseline, warp);
      }
    }
    this.weight = 1;
    this.decorate(page, entries, baseline, warp, underline);
  }

  /// Hand-drawn lines through struck-out atoms (one per run of them) and,
  /// for an underlined heading, under the line's text.
  decorate(page, entries, baseline, warp, underline) {
    const ruleAt = (x1, x2, y) => {
      const r = Rng.derive(this.seed, 'rule', this.n.rule++);
      this.emit(page, [handRule(x1, y, x2, y, r, this.knobs, { px: this.s.xHeightPx })], warp);
    };
    let run = null;
    const flush = () => {
      if (run) ruleAt(run.x1, run.x2, run.y);
      run = null;
    };
    for (const { atom, x, marker } of entries) {
      if (!atom.strike || marker) { flush(); continue; }
      const y = baseline - 0.5 * atom.xh;
      if (run) { run.x2 = x + atom.width; run.y = Math.min(run.y, y); }
      else run = { x1: x - 0.15 * atom.xh, x2: x + atom.width + 0.15 * atom.xh, y };
    }
    flush();
    if (underline) {
      const text = entries.filter((e) => !e.marker);
      if (text.length) {
        const last = text[text.length - 1];
        const deepest = Math.max(...text.map((e) => e.atom.descent));
        const xhMax = Math.max(...text.map((e) => e.atom.xh ?? this.s.xHeightPx));
        ruleAt(text[0].x - 0.2 * xhMax, last.x + last.atom.width + 0.2 * xhMax, baseline + Math.min(deepest, 0.45 * xhMax) + 0.15 * xhMax);
      }
    }
  }

  drawCheckbox(page, atom, x, baseline, warp) {
    const w = atom.width;
    const top = baseline - w;
    const r = () => Rng.derive(this.seed, 'rule', this.n.rule++);
    const px = this.s.xHeightPx;
    const sides = [[x, top, x + w, top], [x + w, top, x + w, baseline], [x + w, baseline, x, baseline], [x, baseline, x, top]];
    const strokes = sides.map(([x1, y1, x2, y2]) => handRule(x1, y1, x2, y2, r(), this.knobs, { px }));
    if (atom.checked) {
      const a = handRule(x + 0.18 * w, baseline - 0.5 * w, x + 0.45 * w, baseline - 0.15 * w, r(), this.knobs, { px });
      const b = handRule(x + 0.45 * w, baseline - 0.15 * w, x + 1.1 * w, baseline - 1.15 * w, r(), this.knobs, { px });
      const end = a[a.length - 1][2];
      strokes.push([...a, ...b.map((p) => [p[0], p[1], p[2] + end, p[3]])]);
    }
    let clock = 0;
    this.emit(page, strokes.map((stroke) => {
      const shifted = stroke.map((p) => [p[0], p[1], p[2] + clock, p[3]]);
      clock = shifted[shifted.length - 1][2] + 60;
      return shifted;
    }), warp);
  }

  /// Appends strokes (page px, t relative to the item) to the page, bent by
  /// `warp`, on the page's running clock, in the current pen weight.
  emit(page, strokes, warp) {
    const start = page.clock;
    let last = start;
    for (const stroke of strokes) {
      if (!stroke.length) continue;
      const points = stroke.map((p) => {
        const [x, y] = warp(p[0], p[1]);
        const t = start + (Number.isFinite(p[2]) ? p[2] : 0);
        if (t > last) last = t;
        return [r2(x), r2(y), Math.round(t), r3(Number.isFinite(p[3]) ? p[3] : 0)];
      });
      page.strokes.push(this.weight !== 1 ? { points, weight: r2(this.weight) } : { points });
    }
    page.clock = Math.round(last) + ITEM_PAUSE_MS;
  }

  /// An instance in ex (its own frame, relative to an origin) → page px.
  emitInstance(page, inst, originX, originY, exPx, warp) {
    const t0 = inst.strokes[0]?.[0]?.[2] ?? 0;
    this.emit(page, inst.strokes.map((stroke) => stroke.map((p) => [
      originX + p[0] * exPx, originY + p[1] * exPx, (p[2] ?? 0) - t0, p[3],
    ])), warp);
  }

  drawWord(page, atom, x, baseline, warp) {
    const xh = atom.xh ?? this.s.xHeightPx;
    const { ink } = atom;
    // Italic: the whole word leans further, about its baseline.
    const shear = atom.italic ? ITALIC_SHEAR : 0;
    this.emit(page, ink.strokes.map((stroke) => stroke.map((p) => [x + (p[0] - shear * p[1]) * xh, baseline + p[1] * xh, p[2], p[3]])), warp);
    const sizePx = xh / FALLBACK_X_HEIGHT;
    for (const fb of ink.fallbacks) {
      const [fx, fy] = warp(x + fb.x * xh, baseline);
      page.fallbacks.push({
        char: fb.char, x: r2(fx), baseline: r2(fy), sizePx: r2(sizePx),
        font: `${atom.weight > 1 ? 700 : 400} ${atom.italic ? 'italic ' : ''}${r2(sizePx)}px ${FALLBACK_FONT}`, width: r2(fb.width * xh),
      });
      if (!(atom.literalTeX && TEX_SYNTAX.has(fb.char))) this.miss(fb.char);
    }
  }

  drawFormula(page, layout, ox, by, warp) {
    for (const item of layout.items) {
      switch (item.type) {
        case 'glyph': this.drawGlyph(page, item, ox, by, warp); break;
        case 'rule': this.drawRule(page, item, ox, by, warp); break;
        case 'radical': this.drawRadical(page, item, ox, by, warp); break;
        case 'delim': this.drawDelim(page, item, ox, by, warp); break;
        case 'accent': this.drawAccent(page, item, ox, by, warp); break;
        default: break;
      }
    }
  }

  /// The writer's instance for `look` (glyphs.lookupGlyph result): a sequence
  /// stand-in joined side by side, a case / size stand-in scaled.
  pick(look, g) {
    let inst;
    if (look.parts) {
      const list = look.parts.map((part, i) => chooseVariant(part.instances, g.fork(`pick${i}`), this.knobs, this.recent)).filter(Boolean);
      if (!list.length) return null;
      inst = joinInstances(list, 0.12);
    } else {
      inst = chooseVariant(look.instances, g.fork('pick'), this.knobs, this.recent);
    }
    if (inst && look.scale && look.scale !== 1) inst = scaleInstance(inst, look.scale, look.scale, 0, 0);
    return inst;
  }

  fallback(page, item, ox, by, warp, { procedural = false } = {}) {
    const [x, y] = warp(ox + item.x, by + (item.baseline ?? item.bottom ?? 0));
    page.fallbacks.push({
      char: item.char ?? item.key, key: item.key, x: r2(x), baseline: r2(y), sizePx: r2(item.emPx),
      font: item.cssFont ?? `400 ${r2(item.emPx)}px KaTeX_Main, "Times New Roman", serif`,
      width: r2(item.advance ?? item.width ?? item.emPx * 0.6),
      ...(procedural ? { procedural: true, top: r2(by + (item.top ?? item.baseline - item.emPx * 0.75)), bottom: r2(by + (item.bottom ?? item.baseline + item.emPx * 0.25)) } : {}),
    });
  }

  drawGlyph(page, item, ox, by, warp) {
    const g = Rng.derive(this.seed, 'glyph', this.n.glyph++);
    const ex = KATEX_X_HEIGHT * item.emPx;
    if (!(ex > 0)) return;
    const originX = ox + item.x, originY = by + item.baseline;
    const box = {
      left: (item.ink.left - item.x) / ex, right: (item.ink.right - item.x) / ex,
      top: (item.ink.top - item.baseline) / ex, bottom: (item.ink.bottom - item.baseline) / ex,
    };
    const look = lookupGlyph(this.glyphs, item.key) ?? (item.char && item.char !== item.key ? lookupGlyph(this.glyphs, item.char) : null);
    let inst = look ? this.pick(look, g) : null;
    if (!inst) {
      this.miss(item.key);
      const shape = proceduralInstance(item.key, box);
      if (shape) {
        this.emitInstance(page, perturb(shape, g.fork('shape'), this.profile, this.knobs), originX, originY, ex, warp);
        this.fallback(page, { ...item, top: item.ink.top, bottom: item.ink.bottom }, ox, by, warp, { procedural: true });
      } else {
        this.fallback(page, item, ox, by, warp);
      }
      return;
    }

    const always = item.large || ALWAYS_FIT_KEYS.has(item.key) ||
      item.font === 'large-op' || item.font === 'small-op' || /^size[1-4]$/.test(item.font ?? '');
    const fit = always ? 1 : this.knobs.fit;
    const hasBox = box.right - box.left > 1e-3 || box.bottom - box.top > 1e-3;
    if (hasBox) {
      inst = fitInstance(inst, box, fit, { uniform: true });
      // The writer's own placement sits in the middle of the KaTeX slot (its
      // advance box); the exact fit sits on the ink box (italic overhangs).
      const advance = item.advance / ex;
      const shift = (1 - fit) * (advance / 2 - (box.left + box.right) / 2);
      if (shift) inst = translateInstance(inst, shift, 0);
    } else {
      inst = translateInstance(inst, item.advance / ex / 2 - (inst.bbox.minX + inst.bbox.maxX) / 2, 0);
    }
    const allowed = Math.max(item.advance / ex, box.right - box.left) * SQUEEZE_RATIO + SQUEEZE_SLACK_EX;
    const width = inst.bbox.maxX - inst.bbox.minX;
    if (width > allowed && width > 0) {
      inst = scaleInstance(inst, allowed / width, 1, (inst.bbox.minX + inst.bbox.maxX) / 2, 0);
    }
    inst = perturb(inst, g.fork('shape'), this.profile, this.knobs);
    this.emitInstance(page, inst, originX, originY, ex, warp);
  }

  drawRule(page, item, ox, by, warp) {
    const r = Rng.derive(this.seed, 'rule', this.n.rule++);
    const px = this.s.xHeightPx;
    const x1 = ox + item.x1, y1 = by + item.y1, x2 = ox + item.x2, y2 = by + item.y2;
    if (!item.dashed) {
      this.emit(page, [handRule(x1, y1, x2, y2, r, this.knobs, { px })], warp);
      return;
    }
    const L = Math.hypot(x2 - x1, y2 - y1);
    const dash = 0.6 * px, gapLen = 0.45 * px;
    const strokes = [];
    for (let s = 0, n = 0; s < L; s += dash + gapLen, n++) {
      const e = Math.min(L, s + dash);
      const a = s / L, b = e / L;
      strokes.push(handRule(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a, x1 + (x2 - x1) * b, y1 + (y2 - y1) * b, r.fork(n), this.knobs, { px }));
    }
    let clock = 0;
    this.emit(page, strokes.map((stroke) => {
      const shifted = stroke.map((p) => [p[0], p[1], p[2] + clock, p[3]]);
      clock = shifted[shifted.length - 1][2] + 60;
      return shifted;
    }), warp);
  }

  /// √: the writer's check mark stretched to KaTeX's sign box, its top-right
  /// end on the bar; the bar itself drawn by hand from that end to KaTeX's
  /// vinculum end. The writer collects the check only («без черты сверху»).
  drawRadical(page, item, ox, by, warp) {
    const g = Rng.derive(this.seed, 'glyph', this.n.glyph++);
    const r = Rng.derive(this.seed, 'rule', this.n.rule++);
    const ex = KATEX_X_HEIGHT * item.emPx;
    if (!(ex > 0)) return;
    const originX = ox + item.x, originY = by;
    const top = item.top / ex, bottom = item.bottom / ex;
    const signW = item.signWidth / ex;
    const look = lookupGlyph(this.glyphs, '√');
    let inst = look ? this.pick(look, g) : null;
    if (inst) {
      inst = perturb(inst, g.fork('shape'), this.profile, this.knobs);
      inst = stretchToBox(inst, { top, bottom });
    } else {
      this.miss('√');
      inst = proceduralInstance('√', { left: 0, right: signW, top, bottom });
      inst = perturb(inst, g.fork('shape'), this.profile, { ...this.knobs, baseline: 0, size: 0 });
      this.fallback(page, { key: '√', char: '√', x: item.x, baseline: item.bottom, top: item.top, bottom: item.bottom, emPx: item.emPx, width: item.signWidth }, ox, by, warp, { procedural: true });
    }
    // Width: a tall sign grows a little wider, never wider than 1.3 × KaTeX's.
    let w = inst.bbox.maxX - inst.bbox.minX;
    const maxW = Math.max(signW * 1.3, 0.3);
    if (w > maxW) { inst = scaleInstance(inst, maxW / w, 1, inst.bbox.minX, 0); w = maxW; }
    // Right edge where KaTeX's bar starts, so the check hands over to the bar.
    inst = translateInstance(inst, signW - inst.bbox.maxX, 0);

    // The check's top-right end: the stroke endpoint furthest up-and-right.
    let end = null;
    for (const stroke of inst.strokes) {
      for (const p of [stroke[0], stroke[stroke.length - 1]]) {
        if (!end || p[0] - p[1] > end[0] - end[1]) end = p;
      }
    }
    this.emitInstance(page, inst, originX, originY, ex, warp);
    const ex1 = originX + end[0] * ex;
    const ey = Math.min(originY + end[1] * ex, by + item.vinculumY);
    const x2 = ox + item.vinculumX2;
    if (x2 - ex1 > 1) {
      this.emit(page, [handRule(ex1, ey, x2, ey, r, this.knobs, { px: this.s.xHeightPx })], warp);
    }
  }

  /// Stretchy delimiters: always the full KaTeX height, width growing only
  /// ~√ of the stretch, centred on KaTeX's ink.
  drawDelim(page, item, ox, by, warp) {
    const g = Rng.derive(this.seed, 'glyph', this.n.glyph++);
    const ex = KATEX_X_HEIGHT * item.emPx;
    if (!(ex > 0)) return;
    const top = item.top / ex, bottom = item.bottom / ex;
    const inkL = item.inkLeft / ex, inkR = item.inkRight / ex;
    const look = lookupGlyph(this.glyphs, item.key) ?? (item.char && item.char !== item.key ? lookupGlyph(this.glyphs, item.char) : null);
    let inst = look ? this.pick(look, g) : null;
    if (inst) {
      inst = perturb(inst, g.fork('shape'), this.profile, this.knobs);
      inst = stretchToBox(inst, { top, bottom });
    } else {
      this.miss(item.key);
      const inkW = Math.max(0.3, inkR - inkL);
      inst = proceduralInstance(item.key, { left: 0, right: inkW, top, bottom });
      if (!inst) {
        this.fallback(page, { ...item, x: item.x, baseline: 0 }, ox, by, warp);
        return;
      }
      inst = perturb(inst, g.fork('shape'), this.profile, { ...this.knobs, size: 0, baseline: 0 });
      this.fallback(page, { key: item.key, char: item.char, x: item.inkLeft, baseline: item.bottom, top: item.top, bottom: item.bottom, emPx: item.emPx, width: item.inkRight - item.inkLeft }, ox, by, warp, { procedural: true });
    }
    const inkW = inkR - inkL;
    const maxW = Math.max(inkW * 1.6, inkW + 0.35);
    let w = inst.bbox.maxX - inst.bbox.minX;
    if (w > maxW) { inst = scaleInstance(inst, maxW / w, 1, inst.bbox.minX, 0); w = maxW; }
    inst = translateInstance(inst, (inkL + inkR) / 2 - (inst.bbox.minX + inst.bbox.maxX) / 2, 0);
    this.emitInstance(page, inst, ox, by, ex, warp);
  }

  /// Accents (\vec → the writer's →, \hat → ˆ, …) fitted to KaTeX's accent box.
  drawAccent(page, item, ox, by, warp) {
    const g = Rng.derive(this.seed, 'glyph', this.n.glyph++);
    const ex = KATEX_X_HEIGHT * item.emPx;
    if (!(ex > 0)) return;
    const box = { left: item.x / ex, right: (item.x + item.width) / ex, top: item.top / ex, bottom: item.bottom / ex };
    const look = lookupGlyph(this.glyphs, item.key);
    let inst = look ? this.pick(look, g) : null;
    if (!inst) {
      this.miss(item.key);
      inst = proceduralInstance(item.key, box);
      if (!inst) {
        this.fallback(page, { ...item, char: item.key, baseline: item.bottom }, ox, by, warp);
        return;
      }
      this.fallback(page, { ...item, char: item.key, baseline: item.bottom }, ox, by, warp, { procedural: true });
    } else {
      inst = fitInstance(inst, box, 1);
    }
    inst = perturb(inst, g.fork('shape'), this.profile, { ...this.knobs, baseline: this.knobs.baseline * 0.5 });
    this.emitInstance(page, inst, ox, by, ex, warp);
  }
}

// MARK: Rendering

const PAPER_COLORS = Object.freeze({
  background: '#fffefb',
  grid: 'rgba(96, 138, 190, 0.42)',
  margin: 'rgba(214, 70, 70, 0.62)',
});

/// Nominal pen width (px at pressure 0.5) for a page: a 0.35 mm ballpoint on
/// the default A4 page, i.e. ~0.17 of the x-height.
function nominalPen(page, opts) {
  const w = Number(opts?.penWidth);
  if (Number.isFinite(w) && w > 0) return w;
  return 0.17 * (page.xHeightPx || 12);
}

/// Pressure → width, like ink.js `_widthFor` but scaled to the page's
/// x-height. Pressure 0 (mouse/finger: unknown) reads as 0.5.
function widthFor(pressure, nominal) {
  const p = pressure > 0 ? Math.min(1, pressure) : 0.5;
  return nominal * (0.62 + 0.76 * p);
}

/// Width quantum: runs of segments with the same quantised width are drawn
/// as one path, which is both fast and small in SVG.
function quantize(w) {
  return Math.max(0.1, Math.round(w * 10) / 10);
}

/// Splits one stroke into runs of consecutive segments of equal quantised
/// width: [{ width, points }]. A single-point stroke is one dot run.
function strokeRuns(points, nominal) {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ width: quantize(widthFor(points[0][3], nominal)), points: [points[0]], dot: true }];
  const runs = [];
  let current = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const w = quantize((widthFor(a[3], nominal) + widthFor(b[3], nominal)) / 2);
    if (!current || current.width !== w) {
      current = { width: w, points: [a] };
      runs.push(current);
    }
    current.points.push(b);
  }
  return runs;
}

function paperLines(page) {
  const lines = [];
  const W = page.width, H = page.height;
  if (page.paper === 'grid') {
    const c = page.cellPx;
    for (let x = c; x < W - 0.5; x += c) lines.push([x, 0, x, H]);
    for (let y = c; y < H - 0.5; y += c) lines.push([0, y, W, y]);
  } else if (page.paper === 'lines') {
    const r = page.rulePx || page.cellPx * 1.6;
    const first = Math.ceil(((page.marginTop ?? 2 * page.cellPx) + r) / r - 1e-6) * r;
    const last = H - (page.marginBottom ?? 2 * page.cellPx) + r * 0.5;
    for (let y = first; y <= last; y += r) lines.push([0, y, W, y]);
  }
  return lines;
}

/// Draws `page` on `canvas` (HTMLCanvasElement or OffscreenCanvas): paper
/// (grid / ruling in light blue-grey, margin line), then every stroke with a
/// pressure-sensitive width and round caps, then fallback characters in the
/// ink colour (KaTeX font for math, a system sans for text). The backing
/// store is page size × `scale` (pass devicePixelRatio for a crisp screen).
/// `showMissing` outlines every fallback with a dashed red box.
export function renderPage(page, canvas, { ink = '#1d2b6b', scale = 1, showMissing = false, paper = true, penWidth } = {}) {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  canvas.width = Math.max(1, Math.round(page.width * k));
  canvas.height = Math.max(1, Math.round(page.height * k));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.fillStyle = PAPER_COLORS.background;
  ctx.fillRect(0, 0, page.width, page.height);

  if (paper) {
    ctx.strokeStyle = PAPER_COLORS.grid;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of paperLines(page)) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    ctx.stroke();
    if (Number.isFinite(page.marginLineX)) {
      ctx.strokeStyle = PAPER_COLORS.margin;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(page.marginLineX, 0);
      ctx.lineTo(page.marginLineX, page.height);
      ctx.stroke();
    }
  }

  const nominal = nominalPen(page, { penWidth });
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of page.strokes) {
    for (const run of strokeRuns(stroke.points ?? [], nominal * (stroke.weight ?? 1))) {
      if (run.dot) {
        const [x, y] = run.points[0];
        ctx.beginPath();
        ctx.arc(x, y, run.width / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.lineWidth = run.width;
      ctx.beginPath();
      ctx.moveTo(run.points[0][0], run.points[0][1]);
      for (let i = 1; i < run.points.length; i++) ctx.lineTo(run.points[i][0], run.points[i][1]);
      ctx.stroke();
    }
  }

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const fb of page.fallbacks ?? []) {
    if (!fb.procedural) {
      ctx.font = fb.font || `${fb.sizePx}px KaTeX_Main, serif`;
      ctx.fillStyle = ink;
      ctx.fillText(fb.char, fb.x, fb.baseline);
    }
    if (showMissing) {
      const box = missingBox(fb);
      ctx.save();
      ctx.strokeStyle = 'rgba(220, 30, 30, 0.9)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.restore();
    }
  }
  return canvas;
}

function missingBox(fb) {
  const pad = 1.5;
  if (Number.isFinite(fb.top) && Number.isFinite(fb.bottom)) {
    return { x: fb.x - pad, y: fb.top - pad, w: (fb.width || fb.sizePx * 0.6) + 2 * pad, h: fb.bottom - fb.top + 2 * pad };
  }
  return { x: fb.x - pad, y: fb.baseline - fb.sizePx * 0.78 - pad, w: (fb.width || fb.sizePx * 0.6) + 2 * pad, h: fb.sizePx + 2 * pad };
}

function fmt(v) {
  const n = Math.round(v * 10) / 10;
  return Object.is(n, -0) ? '0' : String(n);
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/// A self-contained SVG of the page. Variable pen width is kept: each stroke
/// is cut into runs of equal quantised width (0.1 px), and all runs of one
/// width share a single <path> (round caps and joins hide the seams).
/// Points closer than 0.5 px to the last kept one are dropped and
/// coordinates are rounded to 0.1 px, which keeps a full page in the
/// hundreds of KB. Options: ink, paper, showMissing, penWidth.
export function pageToSVG(page, { ink = '#1d2b6b', paper = true, showMissing = false, penWidth } = {}) {
  const W = page.width, H = page.height;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(W)}" height="${fmt(H)}" viewBox="0 0 ${fmt(W)} ${fmt(H)}">`);
  out.push(`<rect width="${fmt(W)}" height="${fmt(H)}" fill="${PAPER_COLORS.background}"/>`);
  if (paper) {
    const d = paperLines(page).map(([x1, y1, x2, y2]) => (y1 === y2 ? `M0 ${fmt(y1)}H${fmt(x2)}` : `M${fmt(x1)} 0V${fmt(y2)}`)).join('');
    if (d) out.push(`<path d="${d}" stroke="${PAPER_COLORS.grid}" stroke-width="0.8" fill="none"/>`);
    if (Number.isFinite(page.marginLineX)) {
      out.push(`<path d="M${fmt(page.marginLineX)} 0V${fmt(H)}" stroke="${PAPER_COLORS.margin}" stroke-width="1.2" fill="none"/>`);
    }
  }
  const nominal = nominalPen(page, { penWidth });
  const byWidth = new Map();
  for (const stroke of page.strokes) {
    for (const run of strokeRuns(stroke.points ?? [], nominal * (stroke.weight ?? 1))) {
      const pts = run.points;
      let d = `M${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
      if (run.dot) {
        d += 'h0.01';
      } else {
        let lx = pts[0][0], ly = pts[0][1];
        const coords = [];
        for (let i = 1; i < pts.length; i++) {
          const [x, y] = pts[i];
          if (i < pts.length - 1 && Math.hypot(x - lx, y - ly) < 0.5) continue;
          coords.push(`${fmt(x)} ${fmt(y)}`);
          lx = x; ly = y;
        }
        d += coords.length ? `L${coords.join(' ')}` : 'h0.01';
      }
      const key = run.width.toFixed(1);
      if (!byWidth.has(key)) byWidth.set(key, []);
      byWidth.get(key).push(d);
    }
  }
  out.push(`<g fill="none" stroke="${escapeXml(ink)}" stroke-linecap="round" stroke-linejoin="round">`);
  for (const key of [...byWidth.keys()].sort((a, b) => Number(a) - Number(b))) {
    out.push(`<path stroke-width="${key}" d="${byWidth.get(key).join('')}"/>`);
  }
  out.push('</g>');
  const fallbacks = page.fallbacks ?? [];
  if (fallbacks.length) {
    out.push(`<g fill="${escapeXml(ink)}">`);
    for (const fb of fallbacks) {
      if (!fb.procedural) {
        out.push(`<text x="${fmt(fb.x)}" y="${fmt(fb.baseline)}" style="font:${escapeXml(fb.font || `${fb.sizePx}px serif`)}">${escapeXml(fb.char)}</text>`);
      }
      if (showMissing) {
        const b = missingBox(fb);
        out.push(`<rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" fill="none" stroke="#dc1e1e" stroke-width="1" stroke-dasharray="3 2"/>`);
      }
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n');
}

/// The page as a PNG blob, rendered at `scale` (default 2: ≈ 300 dpi for
/// the default A4 page). Uses OffscreenCanvas where available.
export async function pageToPNG(page, opts = {}) {
  const options = { scale: 2, ...opts };
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(1, 1);
    renderPage(page, canvas, options);
    return canvas.convertToBlob({ type: 'image/png' });
  }
  const canvas = document.createElement('canvas');
  renderPage(page, canvas, options);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Не удалось сохранить PNG'))), 'image/png');
  });
}
