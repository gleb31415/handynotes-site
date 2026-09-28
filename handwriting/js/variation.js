// Smart noise: making one writer's glyphs never look copy-pasted while still
// looking like THAT writer.
//
// Generic jitter makes every hand look like the same shaky hand. Instead,
// every random magnitude here is a multiple of the writer's OWN natural
// variability, measured from the repeats they wrote of the same symbol
// (`estimateProfile`). A knob at 1 means «как вы сами»: a rendered formula
// varies exactly as much as the writer's own repeats do. 0 switches that
// component off, 2 is twice as careless.
//
// Everything is pure and deterministic (no DOM, importable from Node):
//
//   * `Rng` is seeded from a number or a string (xmur3 → sfc32). The same
//     seed + knobs + bank always gives the same page, so a render can be
//     "locked" and exported again later.
//   * STABILITY. Randomness is keyed by position, not by consumption order.
//     The compositor derives one generator per glyph from (seed, index) —
//     `Rng.derive(knobs.seed, 'glyph', i)` — and `fork`s it per purpose, so
//     glyph i's noise never depends on how many draws glyph i−1 used. Every
//     function below also consumes a FIXED number of draws whatever the knobs
//     are, and multiplies a knob into an already-drawn standard normal. So
//     moving the «наклон» slider changes how far each glyph leans, never
//     which way, and never reshuffles size, shape or instance choice. Raising
//     `morph` only turns more glyphs into blends; the base instance of each
//     glyph stays the same.
//
// Units: glyph geometry is in "ex" (1 = the writer's x-height, y down,
// 0 = baseline, see SPEC). `handRule` alone works in px.
//
// Recommended pipeline for one glyph in the compositor:
//
//   const g = Rng.derive(knobs.seed, 'glyph', index);
//   let inst = chooseVariant(instances, g.fork('pick'), knobs, recent);
//   inst = fitInstance(inst, inkBoxEx, knobs.fit);      // or stretchToBox for delimiters
//   inst = perturb(inst, g.fork('shape'), profile, knobs);
//   const d = drift(xEx);                               // drift = lineDrift(Rng.derive(seed,'line',n), …)
//   // then shear by d.slant about the baseline, scale by d.scale, shift by d.dy, × exPx.
//
// Fitting before perturbing keeps the noise even at fit = 1 (an exact
// KaTeX box would otherwise swallow the size / baseline jitter).

import { clamp } from './util.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/// Every knob is a MULTIPLIER of the writer's own variability (0 = off,
/// 1 = «как вы сами», 2 = вдвое небрежнее); `amount` multiplies all of them.
/// `fit` is not a multiplier: 0..1 blends the writer's own metrics (0) with
/// the exact KaTeX ink box (1). `seed` picks the random draw.
export const VARIATION_DEFAULTS = Object.freeze({
  seed: 1, amount: 1, size: 1, slant: 1, baseline: 1,
  spacing: 1, shape: 1, drift: 1, pressure: 1, morph: 1, fit: 0.35,
});

/// Typical within-writer variability, used when the bank has too few repeats
/// to measure it. log-height std, rad, ex, log-aspect std, ex RMS, ex.
export const PROFILE_DEFAULTS = Object.freeze({
  sizeStd: 0.05, slantStd: 0.035, baselineStd: 0.04, widthStd: 0.05,
  shapeStd: 0.025, spacingStd: 0.06, meanSlant: 0,
});

/// Knobs with defaults filled in, numbers coerced, multipliers ≥ 0, fit in
/// 0..1. Every public function goes through this, so partial objects are fine.
export function resolveKnobs(knobs) {
  const out = { ...VARIATION_DEFAULTS };
  if (knobs && typeof knobs === 'object') {
    for (const name of Object.keys(VARIATION_DEFAULTS)) {
      if (name === 'seed') {
        if (knobs.seed !== undefined && knobs.seed !== null) out.seed = knobs.seed;
        continue;
      }
      const value = Number(knobs[name]);
      if (knobs[name] !== undefined && Number.isFinite(value)) out[name] = value;
    }
  }
  for (const name of Object.keys(out)) {
    if (name === 'seed' || name === 'fit') continue;
    out[name] = Math.max(0, out[name]);
  }
  out.fit = clamp(out.fit, 0, 1);
  return out;
}

// MARK: - Rng

function seedString(seed) {
  if (typeof seed === 'string') return seed;
  if (typeof seed === 'number' && Number.isFinite(seed)) return String(seed);
  if (typeof seed === 'bigint') return seed.toString();
  return String(seed ?? '');
}

/// xmur3 string hash: turns a seed string into a stream of 32-bit seeds.
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/// sfc32 seeded through xmur3. Numbers and strings both work; `1` and `'1'`
/// are the same seed. `normal()` is Box–Muller WITHOUT a cached second value,
/// so every call consumes exactly two uniforms — the draw count of a function
/// never depends on what it drew before.
export class Rng {
  constructor(seed = 1) {
    this.seed = seedString(seed);
    const hash = xmur3(this.seed);
    this.a = hash(); this.b = hash(); this.c = hash(); this.d = hash();
    // sfc32 is weak for its first few outputs from correlated seeds.
    for (let i = 0; i < 12; i++) this.next();
  }

  /// A generator keyed by (seed, …parts): `Rng.derive(7, 'glyph', 12)`.
  static derive(seed, ...parts) {
    return new Rng([seedString(seed), ...parts.map(seedString)].join('/'));
  }

  /// An independent child generator named by `label`. It depends only on this
  /// generator's SEED and the label, not on how much of it was consumed.
  fork(label) {
    return new Rng(`${this.seed}/${seedString(label)}`);
  }

  /// Uniform in [0, 1).
  next() {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /// Standard normal (mean 0, std 1).
  normal() {
    const u = 1 - this.next(); // (0, 1] — never log(0)
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  }

  /// Uniform in [a, b).
  range(a, b) {
    return a + (b - a) * this.next();
  }

  /// A uniformly chosen element (undefined for an empty array). One draw.
  pick(arr) {
    const u = this.next();
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.min(arr.length - 1, Math.floor(u * arr.length))];
  }
}

// MARK: - Geometry helpers

function strokeLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return len;
}

/// Bounding box of strokes in their own frame.
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

/// A copy of `instance` with new strokes and bbox/width recomputed. `anchorX`
/// (a number) shifts x so the ink's left edge lands there — 0 for a normal
/// GlyphInstance; null leaves x alone (a placed instance keeps its frame).
function withStrokes(instance, strokes, anchorX = 0) {
  let box = boundsOf(strokes);
  if (anchorX !== null && box.minX !== anchorX && strokes.length > 0) {
    const dx = anchorX - box.minX;
    for (const stroke of strokes) for (const p of stroke) p[0] += dx;
    box = { ...box, minX: anchorX, maxX: box.maxX + dx };
  }
  return {
    ...instance,
    strokes,
    bbox: { minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY },
    width: box.maxX - box.minX,
  };
}

function copyStrokes(strokes) {
  return strokes.map((stroke) => stroke.map((p) => p.slice()));
}

function instanceBounds(instance) {
  const b = instance.bbox;
  if (b && [b.minX, b.maxX, b.minY, b.maxY].every(Number.isFinite)) return b;
  return boundsOf(instance.strokes ?? []);
}

/// `points` resampled to `n` points evenly spaced by arc length; t and p are
/// interpolated along. A stationary stroke is resampled by index instead.
function resampleStroke(points, n) {
  if (points.length === 0) return [];
  const count = Math.max(1, n | 0);
  const pad = (p) => [p[0], p[1], Number.isFinite(p[2]) ? p[2] : 0, Number.isFinite(p[3]) ? p[3] : 0];
  if (points.length === 1 || count === 1) {
    return Array.from({ length: count }, () => pad(points[0]));
  }
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  const out = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const f = k / (count - 1);
    if (total <= 1e-12) {
      // No length to walk: interpolate by index.
      const pos = f * (points.length - 1);
      const i = Math.min(points.length - 2, Math.floor(pos));
      const u = pos - i;
      out.push(lerpPoint(pad(points[i]), pad(points[i + 1]), u));
      continue;
    }
    const s = f * total;
    while (j < points.length - 2 && cum[j + 1] < s) j++;
    const seg = cum[j + 1] - cum[j];
    const u = seg > 1e-12 ? clamp((s - cum[j]) / seg, 0, 1) : 0;
    out.push(lerpPoint(pad(points[j]), pad(points[j + 1]), u));
  }
  return out;
}

function lerpPoint(a, b, u) {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
}

// MARK: - Profile

/// Keys whose ink sits ON the baseline (no descender) — their bottom edge is
/// where the writer put the baseline this time.
const BASELINE_KEYS = new Set([
  ...'acemnorsuvwxz0123456789',
  ...'ABCDEFGHIKLMNOPRSTUVWXYZ',
  ...'авгеикмнопстхчшыьэюя',
  ...'αικνοσω',
]);

/// Instances beyond this per key don't sharpen a std, only slow the O(n²)
/// pairwise statistics.
const MAX_PER_KEY = 40;
/// Prior strength (in degrees of freedom) pulling a thinly measured std
/// towards the typical one.
const PRIOR_DOF = 3;

function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/// Robust within-group std from pooled pairwise differences: for two draws
/// of the same key (a−b)/√2 has exactly the per-instance std, whatever the
/// key's mean, and needs no bias correction for tiny groups (3 repeats).
/// 1.4826·median|d| is the MAD estimator of a normal std.
function pairwiseStd(groups) {
  const diffs = [];
  let dof = 0;
  for (const values of groups) {
    const list = values.filter(Number.isFinite).slice(0, MAX_PER_KEY);
    if (list.length < 2) continue;
    dof += list.length - 1;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) diffs.push((list[i] - list[j]) / Math.SQRT2);
    }
  }
  if (diffs.length === 0) return { std: NaN, dof: 0 };
  return { std: 1.4826 * median(diffs.map(Math.abs)), dof };
}

/// Slant of one instance as the shear that best explains its ink: regress x
/// on y (x = x0 − y·tan s, y up is negative) over the ink's segments, each
/// weighted by its vertical extent |dy|. A shear leaves y and dy untouched,
/// so with these weights the estimate moves by exactly tan s — whereas
/// weighting by arc length (or by the pen's samples) lets the shear re-weight
/// the ink and loses ~20 % of it on round letters. Horizontal ink (crossbars)
/// carries no weight, as it carries no slant. Asymmetric shapes have a
/// per-key offset, which the pairwise std cancels.
function regressionSlant(instance) {
  let sw = 0, mx = 0, my = 0;
  const segments = [];
  for (const stroke of instance.strokes ?? []) {
    if (stroke.length < 2) continue;
    const n = Math.max(2, Math.ceil(strokeLength(stroke) / 0.04) + 1);
    const pts = resampleStroke(stroke, n);
    for (let i = 1; i < pts.length; i++) {
      const w = Math.abs(pts[i][1] - pts[i - 1][1]);
      if (w === 0) continue;
      const x = (pts[i][0] + pts[i - 1][0]) / 2, y = (pts[i][1] + pts[i - 1][1]) / 2;
      segments.push([x, y, w]);
      sw += w; mx += w * x; my += w * y;
    }
  }
  if (sw < 0.3) return NaN;
  mx /= sw; my /= sw;
  let sxy = 0, syy = 0;
  for (const [x, y, w] of segments) { sxy += w * (x - mx) * (y - my); syy += w * (y - my) ** 2; }
  sxy /= sw; syy /= sw;
  if (syy < 0.03) return NaN; // too flat to have a slant (−, =, ~)
  return Math.atan(-sxy / syy);
}

/// Mean lean of near-vertical ink (within ~27° of vertical), length-weighted,
/// positive = top leans right. The writer's habitual slant, as a reader sees it.
function verticalSlant(instance) {
  let sum = 0, weight = 0;
  for (const stroke of instance.strokes ?? []) {
    const n = Math.max(2, Math.ceil(strokeLength(stroke) / 0.08) + 1);
    const pts = resampleStroke(stroke, n);
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      if (Math.abs(dy) < 2 * Math.abs(dx) || dy === 0) continue;
      const len = Math.hypot(dx, dy);
      sum += Math.atan(dx / -dy) * len;
      weight += len;
    }
  }
  return weight >= 0.3 ? sum / weight : NaN;
}

function bankEntries(bank) {
  if (!bank) return [];
  if (bank instanceof Map) return [...bank.entries()];
  if (typeof bank[Symbol.iterator] === 'function') return [...bank];
  return Object.entries(bank);
}

/// The writer's natural variability, learned from their repeats of the same
/// key (`bank`: GlyphBank — Map<key, GlyphInstance[]>, or a plain object):
///
///   sizeStd     std of log(ink height) — how much one symbol's size wanders
///   slantStd    std of the shear angle, rad (regression of x on y per instance)
///   baselineStd std of the ink bottom, ex, over keys that sit on the baseline
///   widthStd    std of log(width/height) — aspect wander NOT explained by size
///   shapeStd    RMS (ex) of what an affine map can't explain between two
///               compatible repeats, /√2 — the "wobble" of the letter shape
///   spacingStd  ex; not learnable from isolated glyphs, the typical value
///   meanSlant   the habitual lean of near-vertical ink, rad (reported, not applied)
///
/// Each std is a robust (median/MAD) estimate from pooled pairwise
/// differences, pulled towards the typical value with a prior worth
/// PRIOR_DOF repeats, and clamped to a sane band. A std with fewer than 2
/// degrees of freedom is the default outright and is listed in `defaulted`;
/// `fromDefaults` is true when any of size/slant/baseline/width was.
/// `samples` = instances in keys that have ≥ 2 repeats.
export function estimateProfile(bank) {
  const size = [], slant = [], base = [], width = [], shapeGroups = [];
  const leans = [];
  let samples = 0;
  for (const [key, list] of bankEntries(bank)) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const instances = list.filter((inst) => inst && Array.isArray(inst.strokes) && inst.strokes.length > 0);
    for (const inst of instances.slice(0, MAX_PER_KEY)) {
      const lean = verticalSlant(inst);
      if (Number.isFinite(lean)) leans.push(lean);
    }
    if (instances.length < 2) continue;
    samples += instances.length;
    const boxes = instances.map(instanceBounds);
    const heights = boxes.map((b) => b.maxY - b.minY);
    const widths = boxes.map((b) => b.maxX - b.minX);
    size.push(heights.map((h) => (h >= 0.2 ? Math.log(h) : NaN)));
    width.push(widths.map((w, i) => (w >= 0.25 && heights[i] >= 0.25 ? Math.log(w / heights[i]) : NaN)));
    slant.push(instances.slice(0, MAX_PER_KEY).map(regressionSlant));
    if (BASELINE_KEYS.has(key)) {
      base.push(boxes.map((b) => (b.maxY > -0.6 && b.maxY < 0.6 ? b.maxY : NaN)));
    }
    shapeGroups.push(instances.slice(0, 12));
  }

  const defaulted = [];
  const fuse = (name, stat, lo, hi) => {
    const prior = PROFILE_DEFAULTS[name];
    if (!(stat.dof >= 2) || !Number.isFinite(stat.std)) {
      defaulted.push(name);
      return prior;
    }
    const observed = clamp(stat.std, lo, hi);
    return Math.sqrt((stat.dof * observed ** 2 + PRIOR_DOF * prior ** 2) / (stat.dof + PRIOR_DOF));
  };

  const profile = {
    sizeStd: fuse('sizeStd', pairwiseStd(size), 0.005, 0.3),
    slantStd: fuse('slantStd', pairwiseStd(slant), 0.003, 0.25),
    baselineStd: fuse('baselineStd', pairwiseStd(base), 0.003, 0.3),
    widthStd: fuse('widthStd', pairwiseStd(width), 0.005, 0.3),
    shapeStd: fuse('shapeStd', shapeResidual(shapeGroups), 0.01, 0.05),
    spacingStd: PROFILE_DEFAULTS.spacingStd,
    meanSlant: leans.length ? median(leans) : PROFILE_DEFAULTS.meanSlant,
    samples,
    defaulted,
    fromDefaults: ['sizeStd', 'slantStd', 'baselineStd', 'widthStd'].some((n) => defaulted.includes(n)),
  };
  return profile;
}

/// Least-squares affine fit of point set B onto A; returns the RMS residual.
function affineResidual(a, b) {
  // Normal equations for [x y 1]·M ≈ target, solved per output axis.
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0;
  const n = a.length;
  for (const p of b) {
    sxx += p[0] * p[0]; sxy += p[0] * p[1]; sx += p[0];
    syy += p[1] * p[1]; sy += p[1];
  }
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const inv = invert3(M);
  if (!inv) return NaN;
  let err = 0;
  for (let axis = 0; axis < 2; axis++) {
    let rx = 0, ry = 0, r1 = 0;
    for (let i = 0; i < n; i++) {
      rx += b[i][0] * a[i][axis]; ry += b[i][1] * a[i][axis]; r1 += a[i][axis];
    }
    const c = [0, 1, 2].map((r) => inv[r][0] * rx + inv[r][1] * ry + inv[r][2] * r1);
    for (let i = 0; i < n; i++) {
      const pred = c[0] * b[i][0] + c[1] * b[i][1] + c[2];
      err += (pred - a[i][axis]) ** 2;
    }
  }
  return Math.sqrt(err / n);
}

function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

/// Shape wobble: over compatible repeat pairs, the RMS of what the best
/// affine map from one onto the other leaves unexplained, /√2 (the
/// difference of two noisy copies has twice the variance of one).
function shapeResidual(groups) {
  const values = [];
  let dof = 0;
  for (const instances of groups) {
    let used = 0;
    for (let i = 0; i < instances.length; i++) {
      for (let j = i + 1; j < instances.length; j++) {
        if (!compatible(instances[i], instances[j])) continue;
        const a = [], b = [];
        instances[i].strokes.forEach((stroke, k) => {
          const n = stroke.length > 1 && instances[j].strokes[k].length > 1 ? 24 : 1;
          a.push(...resampleStroke(stroke, n));
          b.push(...resampleStroke(instances[j].strokes[k], n));
        });
        if (a.length < 6) continue;
        const rms = affineResidual(a, b);
        if (Number.isFinite(rms)) { values.push(rms / Math.SQRT2); used++; }
      }
    }
    if (used > 0) dof += Math.min(used, instances.length - 1);
  }
  if (values.length === 0) return { std: NaN, dof: 0 };
  return { std: median(values), dof };
}

// MARK: - Choosing and morphing

/// Arc-length fractions at which two strokes must roughly coincide to be
/// "the same stroke". The quarter points catch a loop drawn the other way
/// round (a circle's half-way point is opposite its start either way).
const MATCH_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

function strokeSignature(points) {
  const len = strokeLength(points);
  const samples = points.length > 1 ? resampleStroke(points, 41) : resampleStroke(points, 1);
  const at = MATCH_FRACTIONS.map((f) => samples[Math.round(f * (samples.length - 1))]);
  return { len, at };
}

const compatCache = new WeakMap();

/// Two instances can be blended when they were drawn the same way: same
/// stroke count, and each stroke pair has a comparable length (ratio within
/// [0.6, 1.6]) and passes through roughly the same places in the same order
/// (start, quarter, middle, three-quarter, end — which also pins the drawing
/// direction). Dots (strokes under 0.1 ex) only need to be in the same place.
export function compatible(a, b) {
  if (!a || !b || !Array.isArray(a.strokes) || !Array.isArray(b.strokes)) return false;
  if (a === b) return true;
  let cached = compatCache.get(a);
  if (cached?.has(b)) return cached.get(b);
  const result = computeCompatible(a, b);
  if (!cached) { cached = new Map(); compatCache.set(a, cached); }
  cached.set(b, result);
  return result;
}

function computeCompatible(a, b) {
  if (a.strokes.length === 0 || a.strokes.length !== b.strokes.length) return false;
  const ba = instanceBounds(a), bb = instanceBounds(b);
  const extent = Math.max(ba.maxX - ba.minX, ba.maxY - ba.minY, bb.maxX - bb.minX, bb.maxY - bb.minY, 0.5);
  const tol = 0.12 + 0.2 * extent;
  for (let k = 0; k < a.strokes.length; k++) {
    const sa = strokeSignature(a.strokes[k]);
    const sb = strokeSignature(b.strokes[k]);
    if (sa.at.length === 0 || sb.at.length === 0) return false;
    const dotA = sa.len < 0.1, dotB = sb.len < 0.1;
    if (dotA || dotB) {
      if (dotA !== dotB) return false;
      const ca = sa.at[2], cb = sb.at[2];
      if (Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) > tol * 1.5) return false;
      continue;
    }
    const ratio = sa.len / sb.len;
    if (ratio < 0.6 || ratio > 1.6) return false;
    for (let i = 0; i < sa.at.length; i++) {
      const limit = i === 0 || i === sa.at.length - 1 ? tol : tol * 1.25;
      if (Math.hypot(sa.at[i][0] - sb.at[i][0], sa.at[i][1] - sb.at[i][1]) > limit) return false;
    }
  }
  return true;
}

/// A blend of two compatible instances: stroke k of each resampled by arc
/// length to max(nA, nB) points, then positions, pressure AND time mixed as
/// (1−w)·a + w·b. A convex mix of two non-decreasing clocks is
/// non-decreasing, and a final running max guarantees it; t starts at 0.
export function morphInstances(a, b, w) {
  const strokes = a.strokes.map((sa, k) => {
    const sb = b.strokes[k];
    const n = Math.max(sa.length, sb.length, 1);
    const ra = resampleStroke(sa, n);
    const rb = resampleStroke(sb, n);
    return ra.map((p, i) => [
      p[0] * (1 - w) + rb[i][0] * w,
      p[1] * (1 - w) + rb[i][1] * w,
      p[2] * (1 - w) + rb[i][2] * w,
      p[3] * (1 - w) + rb[i][3] * w,
    ]);
  });
  let last = -Infinity;
  const t0 = strokes[0]?.[0]?.[2] ?? 0;
  for (const stroke of strokes) {
    for (const p of stroke) {
      p[2] -= t0;
      if (p[2] < last) p[2] = last;
      last = p[2];
    }
  }
  const out = withStrokes(a, strokes, 0);
  out.morph = { with: b.sample_id ?? null, w };
  return out;
}

function sameInstance(x, y) {
  if (!x || !y) return false;
  if (x === y) return true;
  return x.sample_id != null && x.sample_id === y.sample_id;
}

/// One of the writer's instances for a key, or a blend of two of them.
///
/// * Picks uniformly; with `recent` (a Map shared across one render, keyed by
///   the instances' `key`) the instance used for the previous occurrence of
///   the same key is skipped when there is any alternative, so two x's in a
///   row never share a source.
/// * With probability clamp(0.5 · morph · amount, 0, 1) blends the pick with a
///   random COMPATIBLE partner (see `compatible`), weight w ∈ [0.25, 0.75].
///   No compatible partner → the pick itself. Incompatible instances are
///   never blended. amount = 0 still picks among instances (choosing is not
///   noise), but never morphs.
///
/// Always consumes exactly 4 draws. The returned object may be the bank's own
/// instance — treat it as read-only (`perturb` copies).
export function chooseVariant(instances, rng, knobs, recent = null) {
  const k = resolveKnobs(knobs);
  const uPick = rng.next(), uMorph = rng.next(), uPartner = rng.next(), uWeight = rng.next();
  const list = (instances ?? []).filter((inst) => inst && Array.isArray(inst.strokes));
  if (list.length === 0) return null;
  const key = list[0].key;
  const previous = recent instanceof Map ? recent.get(key) : null;
  let candidates = list;
  if (previous && list.length > 1) {
    const rest = list.filter((inst) => !sameInstance(inst, previous));
    if (rest.length > 0) candidates = rest;
  }
  const chosen = candidates[Math.min(candidates.length - 1, Math.floor(uPick * candidates.length))];
  if (recent instanceof Map) recent.set(key, chosen);

  const pMorph = clamp(0.5 * k.morph * k.amount, 0, 1);
  if (uMorph >= pMorph || list.length < 2) return chosen;
  const partners = list.filter((inst) => !sameInstance(inst, chosen) && compatible(chosen, inst));
  if (partners.length === 0) return chosen;
  const partner = partners[Math.min(partners.length - 1, Math.floor(uPartner * partners.length))];
  return morphInstances(chosen, partner, 0.25 + 0.5 * uWeight);
}

// MARK: - Perturbation

/// Components of the smooth displacement field, per axis.
const FIELD_COMPONENTS = 3;
/// Shortest wavelength of the field, ex — anything shorter reads as tremor.
const FIELD_MIN_WAVELENGTH = 1.5;

function fullProfile(profile) {
  const out = { ...PROFILE_DEFAULTS };
  if (profile && typeof profile === 'object') {
    for (const name of Object.keys(PROFILE_DEFAULTS)) {
      if (Number.isFinite(profile[name])) out[name] = profile[name];
    }
  }
  return out;
}

/// A new instance: the writer's glyph as they might have written it this
/// time. In order, with k = amount × the named knob and N = a standard normal:
///
///  1. smooth displacement field d(x,y) = Σ a·sin(ω·(x,y) + φ), 3 components
///     per axis, wavelengths ≥ max(1.5 ex, 0.9 × glyph extent), RMS amplitude
///     shapeStd × k(shape) × √max(1, extent). It is a function of POSITION,
///     shared by all strokes, so ink that touches stays touching;
///  2. scale about the ink's left edge and the baseline: height × exp(N·sizeStd·k(size)),
///     width additionally × exp(N·widthStd·k(size));
///  3. slant shear about the baseline, angle N·slantStd·k(slant);
///  4. tiny rotation about the ink centre, angle N·0.35·slantStd·k(slant);
///  5. baseline shift N·baselineStd·k(baseline) (ex, y down);
///  6. pressure × exp(N·0.08·k(pressure)), clamped to 0..1 (0 stays 0).
///
/// The left edge stays where it was (0 for a normal instance, the box edge
/// for a `fitInstance` result); bbox and width are recomputed; stroke and
/// point counts and t are untouched. amount = 0 (or all knobs 0) returns an
/// exact copy. Consumes a fixed number of draws.
export function perturb(instance, rng, profile, knobs) {
  const k = resolveKnobs(knobs);
  const prof = fullProfile(profile);
  const nSize = rng.normal(), nAspect = rng.normal(), nSlant = rng.normal();
  const nRot = rng.normal(), nBase = rng.normal(), nPress = rng.normal();
  const field = [];
  for (let axis = 0; axis < 2; axis++) {
    for (let c = 0; c < FIELD_COMPONENTS; c++) {
      field.push({ axis, theta: rng.range(0, TAU), stretch: rng.range(1, 2.2), phase: rng.range(0, TAU), weight: rng.range(0.6, 1) });
    }
  }

  const strokes = copyStrokes(instance.strokes ?? []);
  const box = instanceBounds(instance);
  const anchorX = Number.isFinite(box.minX) ? box.minX : 0;
  const h = box.maxY - box.minY;
  const w = box.maxX - box.minX;
  const extent = Math.max(h, w);

  const kSize = k.amount * k.size, kSlant = k.amount * k.slant, kBase = k.amount * k.baseline;
  const kShape = k.amount * k.shape, kPress = k.amount * k.pressure;

  const sy = Math.exp(nSize * prof.sizeStd * kSize);
  const sx = sy * Math.exp(nAspect * prof.widthStd * kSize);
  const shear = Math.tan(nSlant * prof.slantStd * kSlant);
  const rot = nRot * 0.35 * prof.slantStd * kSlant;
  const shift = nBase * prof.baselineStd * kBase;
  const pressureScale = Math.exp(nPress * 0.08 * kPress);
  const amplitude = prof.shapeStd * kShape * Math.sqrt(Math.max(1, extent));

  const geometric = amplitude !== 0 || sx !== 1 || sy !== 1 || shear !== 0 || rot !== 0 || shift !== 0;
  if (!geometric && pressureScale === 1) return withStrokes(instance, strokes, null);

  if (amplitude !== 0) {
    // Per axis RMS of Σ a·sin(…) is √(Σa²/2); scale so the 2D RMS is `amplitude`.
    const minWave = Math.max(FIELD_MIN_WAVELENGTH, 0.9 * extent);
    for (let axis = 0; axis < 2; axis++) {
      const comps = field.filter((f) => f.axis === axis);
      const norm = Math.sqrt(comps.reduce((s, f) => s + f.weight ** 2, 0));
      for (const f of comps) {
        const omega = TAU / (minWave * f.stretch);
        f.wx = omega * Math.cos(f.theta);
        f.wy = omega * Math.sin(f.theta);
        f.a = (amplitude * f.weight) / norm;
      }
    }
    for (const stroke of strokes) {
      for (const p of stroke) {
        let dx = 0, dy = 0;
        for (const f of field) {
          const v = f.a * Math.sin(f.wx * p[0] + f.wy * p[1] + f.phase);
          if (f.axis === 0) dx += v; else dy += v;
        }
        p[0] += dx;
        p[1] += dy;
      }
    }
  }

  if (geometric) {
    const cx = anchorX + (w * sx) / 2;
    const cy = ((box.minY + box.maxY) / 2) * sy;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    for (const stroke of strokes) {
      for (const p of stroke) {
        let x = anchorX + (p[0] - anchorX) * sx;
        let y = p[1] * sy;
        x -= y * shear;
        if (rot !== 0) {
          const rx = x - cx, ry = y - cy;
          x = cx + rx * cos - ry * sin;
          y = cy + rx * sin + ry * cos;
        }
        p[0] = x;
        p[1] = y + shift;
      }
    }
  }

  if (pressureScale !== 1) {
    for (const stroke of strokes) {
      for (const p of stroke) if (p[3] > 0) p[3] = clamp(p[3] * pressureScale, 0, 1);
    }
  }
  return withStrokes(instance, strokes, geometric ? anchorX : null);
}

/// Spacing noise for one gap between glyphs or words, ex: N·spacingStd·k(spacing).
/// One normal draw.
export function spacingJitter(rng, profile, knobs) {
  const k = resolveKnobs(knobs);
  const n = rng.normal();
  return n * fullProfile(profile).spacingStd * k.amount * k.spacing;
}

// MARK: - Line drift

/// Wavelengths of the drift, ex: a line wanders over a word or three, it
/// doesn't wobble from letter to letter.
const DRIFT_WAVELENGTH = [15, 40];

/// A slow smooth walk along one line of writing: `(xEx) => {dy, scale, slant}`
/// with x measured in ex from the line start. Each channel is a normalised
/// sum of 2 sinusoids (random wavelengths 15–40 ex and phases), so it is
/// bounded by its amplitude and its slope by 2π·amplitude/15 per ex:
///
///   dy    ex, amplitude 0.75 · baselineStd · k   (default ≈ 0.03 ex; ≤ ~1 % of ex per ex)
///   scale multiplier exp(±0.6 · sizeStd · k)
///   slant rad, amplitude 0.6 · slantStd · k (add to the line's shear)
///
/// with k = drift × amount. The function carries `bounds` = {dy, scale, slant}
/// amplitudes. Consumes 18 draws.
export function lineDrift(rng, profile, knobs) {
  const k = resolveKnobs(knobs);
  const prof = fullProfile(profile);
  const channels = [0, 1, 2].map(() => [0, 1].map(() => ({
    wave: rng.range(DRIFT_WAVELENGTH[0], DRIFT_WAVELENGTH[1]),
    phase: rng.range(0, TAU),
    weight: rng.range(0.4, 1),
  })));
  const kd = k.drift * k.amount;
  const amp = { dy: 0.75 * prof.baselineStd * kd, scale: 0.6 * prof.sizeStd * kd, slant: 0.6 * prof.slantStd * kd };
  const noise = (comps, x) => {
    let sum = 0, total = 0;
    for (const c of comps) { sum += c.weight * Math.sin((TAU * x) / c.wave + c.phase); total += c.weight; }
    return sum / total;
  };
  const drift = (xEx) => {
    const x = Number.isFinite(xEx) ? xEx : 0;
    if (kd === 0) return { dy: 0, scale: 1, slant: 0 };
    return {
      dy: amp.dy * noise(channels[0], x),
      scale: Math.exp(amp.scale * noise(channels[1], x)),
      slant: amp.slant * noise(channels[2], x),
    };
  };
  drift.bounds = { dy: amp.dy, scale: Math.exp(amp.scale), slant: amp.slant };
  return drift;
}

// MARK: - Ruled lines

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/// A hand-drawn straight line (fraction bar, vinculum, overline) from
/// (x1,y1) to (x2,y2), in px. Returns ONE stroke: an array of [x, y, t, p].
///
/// With kg = amount·shape, kt = amount·slant, kl = amount·size, kp = amount·pressure:
///   * ends: each end moves along the line by N·min(2.2 % of the length,
///     0.15 ex), clamped to ±min(4 %, 0.35 ex), times kl — a slightly short or
///     overshooting bar;
///   * tilt: N·min(0.5°, 0.12 ex of end travel), clamped to ±1.2° and 0.3 ex
///     of end travel, × kt, about the midpoint;
///   * bow: quadratic sag N·min(0.8 % of the length, 0.1 ex), clamped to
///     ±min(1.5 %, 0.25 ex), × kg;
///   * hook: with probability 0.35·min(1, kg), the first 3–4 % of the length
///     (≤ 0.3 ex) curls in from one side, as the pen lands moving;
///   * pressure: base × exp(N·0.1·kp), ramped up over the first 8 % and down
///     over the last 12 % (the ramp is there even at amount = 0);
///   * t from `t0`, points every ~`step` px at ~`speed` px/ms, slower at the ends.
///
/// Options: `px` = px per ex (the writer's x-height on the page, default 20),
/// `step` (2), `speed` (0.6), `t0` (0), `pressure` (0.55). amount = 0 gives
/// the exact straight segment with exact endpoints. Consumes 9 draws.
export function handRule(x1, y1, x2, y2, rng, knobs, { px = 20, step = 2, speed = 0.6, t0 = 0, pressure = 0.55 } = {}) {
  const k = resolveKnobs(knobs);
  const nStart = rng.normal(), nEnd = rng.normal(), nTilt = rng.normal(), nBow = rng.normal();
  const uHook = rng.next(), uSide = rng.next(), uHookLen = rng.next();
  const nPress = rng.normal(), uTempo = rng.next();

  const L = Math.hypot(x2 - x1, y2 - y1);
  const exPx = px > 0 ? px : 20;
  const base = clamp(pressure * Math.exp(nPress * 0.1 * k.amount * k.pressure), 0.05, 1);
  if (!(L > 1e-9)) return [[x1, y1, t0, base], [x2, y2, t0 + 1, base]];

  const kg = k.amount * k.shape, kt = k.amount * k.slant, kl = k.amount * k.size;
  const ux = (x2 - x1) / L, uy = (y2 - y1) / L;
  const nx = -uy, ny = ux;

  // Every relative size is also capped in ex: a page-wide bar is not drawn
  // proportionally sloppier than a short one. The std shrinks with the cap,
  // so long bars vary smoothly instead of piling up at the clamp.
  const endStd = Math.min(0.022 * L, 0.15 * exPx);
  const endCap = Math.min(0.04 * L, 0.35 * exPx);
  const startShift = clamp(nStart * endStd, -endCap, endCap) * kl;
  const endShift = clamp(nEnd * endStd, -endCap, endCap) * kl;
  const sStart = startShift;          // > 0: starts late; < 0: overshoots backwards
  const sEnd = L + endShift;          // > L: overshoots forwards
  const tiltCap = Math.min(1.2 * DEG, Math.atan((0.3 * exPx) / (L / 2)));
  const tiltStd = Math.min(0.5 * DEG, Math.atan((0.12 * exPx) / (L / 2)));
  const tilt = clamp(nTilt * tiltStd, -tiltCap, tiltCap) * kt;
  const sagStd = Math.min(0.008 * L, 0.1 * exPx);
  const sag = clamp(nBow * sagStd, -Math.min(0.015 * L, 0.25 * exPx), Math.min(0.015 * L, 0.25 * exPx)) * kg;
  const hooked = uHook < 0.35 * Math.min(1, kg);
  const hookLen = hooked ? Math.max(1.5, Math.min((0.03 + 0.01 * uHookLen) * L, 0.3 * exPx)) : 0;
  const hookDepth = hooked ? hookLen * 0.5 * (uSide < 0.5 ? -1 : 1) : 0;

  const span = sEnd - sStart;
  // The hook curls, so its ink is a little longer than its span.
  const n = Math.max(2, Math.ceil((Math.abs(span) + hookLen * 0.4) / Math.max(0.5, step)) + 1);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const cos = Math.cos(tilt), sin = Math.sin(tilt);
  const tempo = 0.9 + 0.2 * uTempo;
  const points = [];
  let t = t0, prevX = null, prevY = null;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const s = sStart + span * f;
    const g = s / L;
    // With no noise g is exactly 0 / 1 at the ends: land on the endpoints
    // bit-exactly, and keep a horizontal bar's y exactly y1.
    let x = g === 1 ? x2 : x1 + (x2 - x1) * g;
    let y = g === 1 ? y2 : y1 + (y2 - y1) * g;
    let off = 4 * sag * f * (1 - f);
    const along = s - sStart;
    if (hooked && along < hookLen) off += hookDepth * (1 - along / hookLen) ** 2;
    if (off !== 0) { x += nx * off; y += ny * off; }
    if (tilt !== 0) {
      const rx = x - mx, ry = y - my;
      x = mx + rx * cos - ry * sin;
      y = my + rx * sin + ry * cos;
    }
    if (prevX !== null) {
      const v = speed * tempo * (0.45 + 0.9 * Math.sin(Math.PI * f));
      t += Math.max(0.2, Math.hypot(x - prevX, y - prevY) / Math.max(1e-3, v));
    }
    const ramp = Math.min(smoothstep(0, 0.08, f), smoothstep(1, 0.88, f));
    points.push([x, y, t, base * (0.45 + 0.55 * ramp)]);
    prevX = x; prevY = y;
  }
  return points;
}

// MARK: - Fitting to boxes

/// Below this (ex) a dimension is a line, not a box: scaling it to match
/// would magnify pen tremor, so it keeps the other axis' scale.
const MIN_EXTENT = 0.15;

/// Vertical stretch for stretchy delimiters and radical signs: the ink is
/// mapped so its top/bottom land exactly on `top`/`bottom` (ex, same frame as
/// the instance — y down, 0 = baseline), while the width grows only by
/// ratio^widthPower (default √ratio) — a tall bracket is drawn taller, not
/// fatter. x is re-anchored at 0; t and pressure are kept. An instance with
/// no height (a flat stroke) is only moved to the box's centre.
export function stretchToBox(instance, { top, bottom }, { widthPower = 0.5 } = {}) {
  const box = instanceBounds(instance);
  const h = box.maxY - box.minY;
  const target = bottom - top;
  const strokes = copyStrokes(instance.strokes ?? []);
  if (!(h > 1e-6) || !Number.isFinite(target)) {
    const dy = (top + bottom) / 2 - (box.minY + box.maxY) / 2;
    for (const stroke of strokes) for (const p of stroke) p[1] += Number.isFinite(dy) ? dy : 0;
    return withStrokes(instance, strokes, 0);
  }
  const ratio = target / h;
  const sx = Math.abs(ratio) ** widthPower;
  for (const stroke of strokes) {
    for (const p of stroke) {
      p[0] = (p[0] - box.minX) * sx;
      p[1] = top + (p[1] - box.minY) * ratio;
    }
  }
  return withStrokes(instance, strokes, 0);
}

/// Places an instance into a KaTeX glyph's ink box with the `fit` knob.
///
/// `box` = {left, right, top, bottom}: the KaTeX ink box in the glyph's own
/// ex (its exPx = 0.431·emPx), x from the glyph's pen origin, y from the
/// baseline, y down. The result's strokes are in THAT frame (so its
/// bbox.minX is generally not 0 and width = maxX − minX): multiply by exPx
/// and add the pen position to draw it.
///
///   fit = 0  the writer's own metrics — natural size (1 ex = 1 ex), own
///            baseline, ink centred horizontally on the box;
///   fit = 1  the ink box exactly: bbox edges land on the box edges (a
///            non-uniform scale unless `uniform`);
///   between  every bbox EDGE is linearly interpolated between the two
///            placements, and the ink is mapped onto the interpolated box.
///
/// Degenerate axes: when the instance or the box is thinner than 0.15 ex on
/// an axis (−, |, 1, a dot), that axis is not stretched — it takes the other
/// axis' scale and is centred on the interpolated centre. `uniform: true`
/// uses the vertical scale for both axes (letter shape preserved, centred).
export function fitInstance(instance, box, fit = VARIATION_DEFAULTS.fit, { uniform = false } = {}) {
  const f = clamp(Number.isFinite(fit) ? fit : VARIATION_DEFAULTS.fit, 0, 1);
  const own = instanceBounds(instance);
  const w = own.maxX - own.minX, h = own.maxY - own.minY;
  const cx = (box.left + box.right) / 2;
  // The writer's own placement, in the box frame.
  const ownBox = { left: cx - w / 2, right: cx + w / 2, top: own.minY, bottom: own.maxY };
  const lerp = (a, b) => a + (b - a) * f;
  const target = {
    left: lerp(ownBox.left, box.left), right: lerp(ownBox.right, box.right),
    top: lerp(ownBox.top, box.top), bottom: lerp(ownBox.bottom, box.bottom),
  };
  const tw = target.right - target.left, th = target.bottom - target.top;
  const flatX = w < MIN_EXTENT || box.right - box.left < MIN_EXTENT;
  const flatY = h < MIN_EXTENT || box.bottom - box.top < MIN_EXTENT;

  let sx = flatX ? NaN : tw / w;
  let sy = flatY ? NaN : th / h;
  if (uniform && !flatY) sx = sy;
  // A flat axis borrows the other axis' scale (a minus keeps its wobble in
  // proportion) — but never grows past the target box on that axis: a wide
  // accent stretched 18× across must not also become 18× taller.
  const borrow = (scale, extent, targetExtent) => (uniform ? scale
    : Math.min(scale, Math.max(targetExtent, extent, MIN_EXTENT) / Math.max(extent, 1e-9)));
  if (Number.isNaN(sx) && Number.isNaN(sy)) { sx = 1; sy = 1; } // a dot: move only
  else if (Number.isNaN(sx)) sx = borrow(sy, w, tw);
  else if (Number.isNaN(sy)) sy = borrow(sx, h, th);

  // Anchor: stretched axes map edge to edge; the others centre on the target centre.
  const stretchX = !flatX && !uniform;
  const ox = stretchX ? target.left - own.minX * sx : (target.left + target.right) / 2 - ((own.minX + own.maxX) / 2) * sx;
  const oy = !flatY ? target.top - own.minY * sy : (target.top + target.bottom) / 2 - ((own.minY + own.maxY) / 2) * sy;

  const strokes = copyStrokes(instance.strokes ?? []);
  for (const stroke of strokes) {
    for (const p of stroke) {
      p[0] = ox + p[0] * sx;
      p[1] = oy + p[1] * sy;
    }
  }
  return withStrokes(instance, strokes, null);
}
