// KaTeX → exact placements for handwritten math.
//
// We do not re-implement TeX layout. KaTeX already computes it, so we let it
// render offscreen and read back what the browser laid out: every glyph's
// advance box and baseline, fraction bars, the radical sign and its vinculum,
// stretchy delimiters and accents. The handwriting layer then swaps each of
// those for one of the writer's own instances at exactly that place and size.
//
// Why read the DOM instead of KaTeX's internal tree: the tree has TeX boxes but
// not the final positions (vlists, kerns, italic corrections and struts are
// resolved by CSS), and the DOM is the one thing that is guaranteed to match
// what KaTeX shows on screen.
//
// Coordinates everywhere here: CSS px, origin = the formula's left edge on its
// BASELINE, Y down (above the baseline is negative).
//
// `fontSizePx` is the KaTeX em — the size of ordinary math text. KaTeX's own
// `.katex { font-size: 1.21em }` is neutralised, so a base-size glyph reports
// `emPx === fontSizePx` and its x-height is 0.431 * fontSizePx, the same number
// the text layer uses for the writer's x-height.

const SVG_NS = 'http://www.w3.org/2000/svg';

/// Every face the vendored CSS declares. All are loaded up front: a layout
/// read before a face arrives would measure the fallback font, and that
/// wrong geometry would then sit in the cache forever.
const KATEX_FACES = [
  'normal 400 KaTeX_Main', 'italic 400 KaTeX_Main', 'normal 700 KaTeX_Main', 'italic 700 KaTeX_Main',
  'italic 400 KaTeX_Math', 'italic 700 KaTeX_Math',
  'normal 400 KaTeX_AMS',
  'normal 400 KaTeX_Size1', 'normal 400 KaTeX_Size2', 'normal 400 KaTeX_Size3', 'normal 400 KaTeX_Size4',
  'normal 400 KaTeX_Caligraphic', 'normal 700 KaTeX_Caligraphic',
  'normal 400 KaTeX_Fraktur', 'normal 700 KaTeX_Fraktur',
  'normal 400 KaTeX_SansSerif', 'italic 400 KaTeX_SansSerif', 'normal 700 KaTeX_SansSerif',
  'normal 400 KaTeX_Script', 'normal 400 KaTeX_Typewriter',
];

/// KaTeX classes that pick a font family (vendor/katex/katex.min.css). The
/// nearest one on the ancestor chain is what `normalizeKey` gets as the font.
const FONT_CLASSES = new Set([
  'mathnormal', 'mathit', 'mathrm', 'mathbf', 'boldsymbol', 'amsrm', 'mathbb', 'textbb',
  'mathcal', 'mathscr', 'textscr', 'mathfrak', 'textfrak', 'mathboldfrak', 'textboldfrak',
  'mathtt', 'texttt', 'mathsf', 'textsf', 'mathboldsf', 'textboldsf', 'mathitsf', 'mathsfit',
  'textitsf', 'mainrm', 'textrm', 'textit', 'textbf', 'textmd', 'textup',
]);

/// Pieces of stacked delimiters (Size fonts) → the delimiter they build.
const PIECE_TO_DELIM = {
  '⎛': '(', '⎜': '(', '⎝': '(', '⎞': ')', '⎟': ')', '⎠': ')',
  '⎡': '[', '⎢': '[', '⎣': '[', '⎤': ']', '⎥': ']', '⎦': ']',
  '⎧': '{', '⎨': '{', '⎩': '{', '⎫': '}', '⎬': '}', '⎭': '}', '⎪': '{',
  '∣': '|', '∥': '∥', '⏐': '|',
};

/// Accent characters KaTeX puts in `.accent-body` → the corpus accent key.
/// `ˉ` (\bar) is absent on purpose: it is drawn as a rule, never collected.
const ACCENT_KEYS = {
  '^': 'ˆ', 'ˆ': 'ˆ', '~': '˜', '˜': '˜', '˙': '˙', '¨': '¨', 'ˊ': 'ˊ', 'ˋ': 'ˋ',
  'ˇ': 'ˇ', '˘': '˘', '˚': '˚', '→': '→', '⃗': '→',
};
const BAR_ACCENTS = new Set(['ˉ', '¯']);

/// `\not X` is a private-use slash (U+E020) in an `.rlap` before X, and
/// `\notin` is `∈` followed by an `.llap` '/'. We fold both into the one
/// negated character a writer actually writes.
const NOT_SLASH = '';
const NEGATED = {
  '=': '≠', '∈': '∉', '∋': '∌', '⊂': '⊄', '⊃': '⊅', '⊆': '⊈', '⊇': '⊉', '≡': '≢',
  '<': '≮', '>': '≯', '≤': '≰', '≥': '≱', '∼': '≁', '≈': '≉', '≃': '≄', '≅': '≇',
  '∣': '∤', '∥': '∦', '∃': '∄', '→': '↛', '←': '↚',
};

/// Whitespace and the zero-width characters KaTeX uses as layout props
/// (U+200B in every `.vlist-s`, U+2061 function application…).
const SKIP_CHAR = /[\s ​-‍⁠-⁤﻿]/u;

/// A probe moving text by more than this means our measurement disturbed the
/// layout it was measuring; that is worth a warning, not silence.
const PROBE_TOLERANCE_PX = 0.05;

const CACHE_LIMIT = 400;

/// Font size ink is measured at (see `inkOf`).
const INK_REF_PX = 1000;

/// KaTeX paints unknown commands in `errorColor` instead of failing the whole
/// formula. A colour nobody types lets us find them.
const ERROR_COLOR = '#cc0001';
const ERROR_RGB = 'rgb(204, 0, 1)';

let katexPromise = null;
let externalNormalizeKey = null;
let normalizeKeyMissing = false;
let host = null;
let measureCtx = null;
const inkCache = new Map();
const layoutCache = new Map();

/// Stand-in used only while glyphs.js (which owns the real key contract) is
/// unavailable: undoes the Size-font piece splitting and the blackboard font,
/// leaves everything else as KaTeX wrote it. Pass `normalizeKey` to
/// `layoutFormula`, or ship glyphs.js, to get the real one.
function defaultNormalizeKey(char, fontClass) {
  if (PIECE_TO_DELIM[char]) return PIECE_TO_DELIM[char];
  if (fontClass === 'mathbb' || fontClass === 'textbb' || fontClass === 'amsrm') {
    const bb = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', H: 'ℍ' }[char];
    if (bb) return bb;
  }
  return char;
}

/// Loads KaTeX, its stylesheet and every KaTeX font face, once. Nothing here
/// runs at app boot: collection-only writers never pay for it.
export async function ensureKatex() {
  if (!katexPromise) {
    katexPromise = loadKatex().catch((error) => {
      katexPromise = null; // a failed load (offline, blocked) may be retried
      throw error;
    });
  }
  return katexPromise;
}

async function loadKatex() {
  const [module] = await Promise.all([
    import('../vendor/katex/katex.mjs'),
    injectStylesheet(),
    // glyphs.js owns `normalizeKey`; it may be absent in a partial checkout,
    // in which case every layout says so in its warnings.
    import('./glyphs.js').then(
      (glyphs) => {
        if (typeof glyphs.normalizeKey === 'function') externalNormalizeKey = glyphs.normalizeKey;
        else normalizeKeyMissing = true;
      },
      () => { normalizeKeyMissing = true; },
    ),
  ]);
  // Faces load only once the @font-face rules exist, hence after the CSS.
  await Promise.all(KATEX_FACES.map((face) => document.fonts.load(`${face.replace(/ (KaTeX_)/, ' 16px $1')}`, 'x')));
  await document.fonts.ready;
  return module.default;
}

function injectStylesheet() {
  const href = new URL('../vendor/katex/katex.min.css', import.meta.url).href;
  const existing = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => l.href === href);
  if (existing && existing.sheet) return Promise.resolve();
  const link = existing || document.createElement('link');
  const loaded = new Promise((resolve, reject) => {
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', () => reject(new Error('Не удалось загрузить стили KaTeX')), { once: true });
  });
  if (!existing) {
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.katex = '';
    document.head.append(link);
  }
  return loaded;
}

/// The one offscreen box every formula is rendered into. It stays laid out
/// (no display:none) because we are measuring layout; it is only moved off
/// the page. Not visibility:hidden either: geometry would survive it, but the
/// walk skips invisible content (that is how \phantom is recognised), so a
/// hidden host would read as an empty formula. `all: initial` keeps app styles
/// (line-height, letter-spacing…) from leaking into KaTeX's geometry.
function offscreenHost() {
  if (host && host.isConnected) return host;
  host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.dataset.mathlayout = '';
  host.style.cssText = 'all:initial;display:block;position:absolute;left:-10000px;top:0;' +
    'width:max-content;white-space:nowrap;pointer-events:none;direction:ltr;';
  document.body.append(host);
  return host;
}

/// Lays `latex` out exactly as KaTeX does and returns what to draw where.
/// Result is a fresh copy — callers may mutate it. See the header comment for
/// units and the SPEC for the Item shapes.
export async function layoutFormula(latex, { display = false, fontSizePx = 40, normalizeKey } = {}) {
  const katex = await ensureKatex();
  const cacheKey = `${display ? 'D' : 'T'}|${fontSizePx}|${latex}`;
  let raw = layoutCache.get(cacheKey);
  if (raw) {
    layoutCache.delete(cacheKey); // refresh LRU position
  } else {
    raw = computeLayout(katex, String(latex ?? ''), display, fontSizePx);
  }
  layoutCache.set(cacheKey, raw);
  if (layoutCache.size > CACHE_LIMIT) layoutCache.delete(layoutCache.keys().next().value);
  return finalize(raw, normalizeKey || externalNormalizeKey || defaultNormalizeKey,
    !normalizeKey && !externalNormalizeKey && normalizeKeyMissing);
}

/// Keys are applied per call, not cached: the geometry is the expensive part
/// and does not depend on which normaliser is in force.
function finalize(raw, normalize, keysUnnormalized) {
  const layout = structuredClone(raw);
  if (!layout.ok) return layout;
  for (const item of layout.items) {
    if (item.type === 'glyph' || item.type === 'delim') item.key = normalize(item.char, item.font);
  }
  if (keysUnnormalized) {
    layout.warnings.push('glyphs.js недоступен: ключи символов не нормализованы');
  }
  return layout;
}

function computeLayout(katex, latex, display, fontSizePx) {
  const box = offscreenHost();
  box.style.fontSize = `${fontSizePx}px`;
  try {
    try {
      katex.render(latex, box, {
        displayMode: display, throwOnError: false, output: 'html', strict: 'ignore', trust: false,
        errorColor: ERROR_COLOR,
      });
    } catch (error) {
      return failed(error && error.message ? error.message : String(error));
    }
    // throwOnError:false turns a parse error into a red span with the message.
    const errorSpan = box.querySelector('.katex-error');
    if (errorSpan) return failed(errorSpan.getAttribute('title') || errorSpan.textContent);
    // An unknown \command renders as red literal text inside an otherwise
    // fine formula. Handwriting "\foo" letter by letter would be worse than
    // failing, so it is an error too — with KaTeX's own message.
    if ([...box.querySelectorAll('[style*="color"]')].some((e) => e.style.color === ERROR_RGB)) {
      return failed(strictMessage(katex, latex, display) || 'KaTeX: неизвестная команда');
    }
    const katexEl = box.querySelector('.katex');
    const html = box.querySelector('.katex-html');
    if (!katexEl || !html) return failed('KaTeX ничего не нарисовал');
    katexEl.style.fontSize = `${fontSizePx}px`;
    return measure(html, fontSizePx, display);
  } finally {
    box.textContent = '';
  }
}

function strictMessage(katex, latex, display) {
  try {
    katex.renderToString(latex, { displayMode: display, throwOnError: true, output: 'html', strict: 'ignore', trust: false });
  } catch (error) {
    return error && error.message ? error.message : String(error);
  }
  return null;
}

function failed(error) {
  return { ok: false, error: String(error), width: 0, height: 0, depth: 0, items: [], warnings: [] };
}

// ---------------------------------------------------------------------------
// Measurement

function makeProbe() {
  const probe = document.createElement('span');
  // Zero-size inline-block: its baseline is its bottom edge, which with zero
  // height is its top — so `top` IS the baseline of the line it sits on.
  probe.style.cssText = 'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline;';
  return probe;
}

function measure(html, fontSizePx, display) {
  const warnings = [];

  // Origin: left edge of the formula, on its baseline.
  const originProbe = makeProbe();
  html.append(originProbe);
  const htmlRect = html.getBoundingClientRect();
  const ox = htmlRect.left;
  const oy = originProbe.getBoundingClientRect().top;
  originProbe.remove();

  const rel = (r) => ({ left: r.left - ox, right: r.right - ox, top: r.top - oy, bottom: r.bottom - oy });

  // TeX height/depth come from the struts KaTeX puts at the start of each base.
  let height = 0;
  let depth = 0;
  for (const strut of html.querySelectorAll(':scope > .base > .strut')) {
    const r = rel(strut.getBoundingClientRect());
    height = Math.max(height, -r.top);
    depth = Math.max(depth, r.bottom);
  }

  const st = { seq: 0, texts: [], groups: [], items: [], warnings, rel };
  walk(html, st, null);

  const glyphs = measureTexts(st, ox, oy);

  // Plain glyphs (with \not folded in), then group-built items.
  const plain = foldNegations(glyphs.filter((g) => !g.group));
  for (const g of plain) st.items.push(glyphItem(g));
  for (const group of st.groups) {
    group.glyphs = glyphs.filter((g) => g.group === group);
    const item = group.kind === 'delim' ? delimItem(group, st) : accentItem(group, st);
    if (item) st.items.push(item);
  }
  st.items.sort((a, b) => a.seq - b.seq);

  // Everything that will be drawn, TeX box included: italic overhangs and
  // tall accents can poke out of the TeX box, and a page layout must not
  // let them collide with the next line.
  const bounds = { left: 0, right: htmlRect.width, top: -height, bottom: depth };
  for (const item of st.items) {
    const b = itemBox(item);
    bounds.left = Math.min(bounds.left, b.left);
    bounds.right = Math.max(bounds.right, b.right);
    bounds.top = Math.min(bounds.top, b.top);
    bounds.bottom = Math.max(bounds.bottom, b.bottom);
    delete item.seq;
  }

  return {
    ok: true, display, emPx: fontSizePx, width: htmlRect.width, height, depth,
    bounds: roundItem(bounds), items: st.items.map(roundItem), warnings,
  };
}

/// KaTeX stacks vlists bottom-up in the DOM (a fraction is denominator, bar,
/// numerator). Walking them top-down gives items in the order a person would
/// write them: numerator, bar, denominator; radical before its body. Accents
/// keep DOM order (the letter first, then its hat).
function childrenInWritingOrder(el) {
  const kids = [...el.childNodes];
  if (el.classList && el.classList.contains('vlist')) {
    const owner = el.parentElement?.parentElement?.parentElement;
    if (!owner || !owner.classList.contains('accent')) kids.reverse();
  }
  return kids;
}

function isInvisible(el) {
  const cs = getComputedStyle(el);
  // \phantom renders its content with a transparent colour.
  return cs.visibility === 'hidden' || cs.display === 'none' || cs.color === 'rgba(0, 0, 0, 0)' || cs.opacity === '0';
}

function hasInk(text) {
  for (const ch of text) if (!SKIP_CHAR.test(ch)) return true;
  return false;
}

function walk(el, st, group) {
  for (const child of childrenInWritingOrder(el)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (hasInk(child.data)) st.texts.push({ node: child, group, seq: st.seq++ });
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (child.namespaceURI === SVG_NS) {
      if (child.localName !== 'svg') continue;
      if (group) group.svgs.push(child);
      else if (!isInvisible(child)) looseSvg(child, st);
      continue;
    }
    if (isInvisible(child)) continue;
    if (group) { walk(child, st, group); continue; }
    visitElement(child, st);
  }
}

function newGroup(st, kind, el) {
  const group = { kind, el, seq: st.seq++, svgs: [], glyphs: [] };
  st.groups.push(group);
  return group;
}

function visitElement(el, st) {
  const c = el.classList;
  if (c.contains('delimsizing') ||
      (c.contains('delimcenter') && !el.querySelector('.delimsizing'))) {
    walk(el, st, newGroup(st, 'delim', el));
    return;
  }
  if (c.contains('accent-body')) {
    walk(el, st, newGroup(st, 'accent', el));
    return;
  }
  if (c.contains('frac-line')) return void borderRule(el, st, 'frac');
  if (c.contains('overline-line')) return void borderRule(el, st, 'overline');
  if (c.contains('underline-line')) return void borderRule(el, st, 'underline');
  if (c.contains('hline') || c.contains('hdashline')) return void borderRule(el, st, 'hline', c.contains('hdashline'));
  if (c.contains('vertical-separator')) return void separatorRule(el, st);
  if (c.contains('rule')) return void filledRule(el, st);
  if (c.contains('fbox') || c.contains('fcolorbox')) {
    boxRules(el, st);
    walk(el, st, null);
    return;
  }
  if (c.contains('hide-tail') && el.closest('.sqrt') && el.querySelector('svg')) {
    radicalItem(el, st);
    return;
  }
  if (c.contains('stretchy') && el.querySelector(':scope > .halfarrow-left')) {
    svgBoxAccent(el, st, '↔');
    return;
  }
  if (c.contains('stretchy') && el.querySelector(':scope > .brace-left')) {
    const box = svgInkBox(el, st);
    st.warnings.push('Фигурная скобка \\overbrace/\\underbrace нарисована прямой линией');
    pushFallbackRule(st, box, 'unknown');
    return;
  }
  walk(el, st, null);
}

// --- rules ------------------------------------------------------------------

/// The thickness KaTeX asked for (it writes it in em), before Chrome snaps
/// borders to whole device pixels.
function specifiedWidth(el, side, computedPx) {
  const value = el.style[`border${side}Width`] || el.style.borderWidth;
  const m = /^([\d.]+)em$/.exec(value || '');
  if (m) return parseFloat(m[1]) * parseFloat(getComputedStyle(el).fontSize);
  return computedPx;
}

function borderRule(el, st, role, dashed = false) {
  const r = st.rel(el.getBoundingClientRect());
  const cs = getComputedStyle(el);
  const bw = parseFloat(cs.borderBottomWidth) || 0;
  if (r.right - r.left <= 0) return;
  const y = r.bottom - bw / 2; // the line is the bottom border of the box
  const item = {
    type: 'rule', seq: st.seq++, x1: r.left, y1: y, x2: r.right, y2: y,
    thickness: specifiedWidth(el, 'Bottom', bw), role,
  };
  if (dashed) item.dashed = true;
  st.items.push(item);
}

function separatorRule(el, st) {
  const r = st.rel(el.getBoundingClientRect());
  const cs = getComputedStyle(el);
  const bw = parseFloat(cs.borderRightWidth) || 0;
  const x = r.right - bw / 2;
  const item = {
    type: 'rule', seq: st.seq++, x1: x, y1: r.top, x2: x, y2: r.bottom,
    thickness: specifiedWidth(el, 'Right', bw), role: 'vline',
  };
  if (cs.borderRightStyle === 'dashed') item.dashed = true;
  st.items.push(item);
}

/// \rule{w}{h}: a filled box, drawn as a line along its long side.
function filledRule(el, st) {
  const r = st.rel(el.getBoundingClientRect());
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  if (w <= 0 && h <= 0) return;
  if (w >= h) {
    const y = (r.top + r.bottom) / 2;
    st.items.push({ type: 'rule', seq: st.seq++, x1: r.left, y1: y, x2: r.right, y2: y, thickness: h, role: 'hline' });
  } else {
    const x = (r.left + r.right) / 2;
    st.items.push({ type: 'rule', seq: st.seq++, x1: x, y1: r.top, x2: x, y2: r.bottom, thickness: w, role: 'vline' });
  }
}

/// \boxed: four sides, each on the centreline of its border.
function boxRules(el, st) {
  const r = st.rel(el.getBoundingClientRect());
  const bw = parseFloat(getComputedStyle(el).borderTopWidth) || 0;
  const t = specifiedWidth(el, 'Top', bw);
  const h = bw / 2;
  const sides = [
    [r.left, r.top + h, r.right, r.top + h, 'hline'],
    [r.right - h, r.top, r.right - h, r.bottom, 'vline'],
    [r.right, r.bottom - h, r.left, r.bottom - h, 'hline'],
    [r.left + h, r.bottom, r.left + h, r.top, 'vline'],
  ];
  for (const [x1, y1, x2, y2, role] of sides) {
    st.items.push({ type: 'rule', seq: st.seq++, x1, y1, x2, y2, thickness: t, role });
  }
}

function pushFallbackRule(st, box, role) {
  if (!box) return;
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  if (w >= h) {
    const y = (box.top + box.bottom) / 2;
    st.items.push({ type: 'rule', seq: st.seq++, x1: box.left, y1: y, x2: box.right, y2: y, thickness: Math.max(1, Math.min(h, 3)), role });
  } else {
    const x = (box.left + box.right) / 2;
    st.items.push({ type: 'rule', seq: st.seq++, x1: x, y1: box.top, x2: x, y2: box.bottom, thickness: Math.max(1, Math.min(w, 3)), role });
  }
}

// --- svg --------------------------------------------------------------------

/// Tight ink box of an svg's paths, clipped horizontally to the wrapper that
/// clips it: KaTeX draws stretchy shapes 400em wide and lets an
/// `overflow:hidden` span (.hide-tail, .halfarrow-*, .brace-*) cut them to
/// length. Only such a wrapper counts — a `width:100%` svg often sits in a
/// zero-width inline-block that clips nothing.
function clippedPathBox(svg, st) {
  let clip = null;
  for (let e = svg.parentElement, i = 0; e && i < 3; e = e.parentElement, i++) {
    if (getComputedStyle(e).overflowX === 'hidden') { clip = e.getBoundingClientRect(); break; }
  }
  let box = null;
  for (const shape of svg.querySelectorAll('path, line, rect')) {
    const r = shape.getBoundingClientRect();
    const b = {
      left: clip ? Math.max(r.left, clip.left) : r.left, right: clip ? Math.min(r.right, clip.right) : r.right,
      top: r.top, bottom: r.bottom,
    };
    if (b.right < b.left) continue;
    box = box ? unionBox(box, b) : b;
  }
  if (!box) return null;
  return st.rel(box);
}

function svgInkBox(el, st) {
  let box = null;
  for (const svg of el.querySelectorAll('svg')) {
    const b = clippedPathBox(svg, st);
    if (b) box = box ? unionBox(box, b) : b;
  }
  return box;
}

function unionBox(a, b) {
  return {
    left: Math.min(a.left, b.left), right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom),
  };
}

function svgBoxAccent(el, st, key) {
  const box = svgInkBox(el, st);
  if (!box) return;
  st.items.push({
    type: 'accent', seq: st.seq++, key, x: box.left, width: box.right - box.left,
    top: box.top, bottom: box.bottom, emPx: emOf(el),
  });
}

/// An svg met outside any construct we recognise by class.
function looseSvg(svg, st) {
  const holder = svg.parentElement;
  // \cancel, \bcancel, \xcancel: <line>s spanning the box.
  const lines = svg.querySelectorAll('line');
  if (lines.length && !svg.querySelector('path')) {
    const r = svg.getBoundingClientRect();
    for (const line of lines) {
      const p = (len, base) => base + len.baseVal.value;
      const a = st.rel({ left: p(line.x1, r.left), right: p(line.x1, r.left), top: p(line.y1, r.top), bottom: p(line.y1, r.top) });
      const b = st.rel({ left: p(line.x2, r.left), right: p(line.x2, r.left), top: p(line.y2, r.top), bottom: p(line.y2, r.top) });
      const sw = parseFloat(getComputedStyle(line).strokeWidth) || 1;
      st.items.push({ type: 'rule', seq: st.seq++, x1: a.left, y1: a.top, x2: b.left, y2: b.top, thickness: sw, role: 'strike' });
    }
    return;
  }
  const box = clippedPathBox(svg, st);
  if (!box) return;
  const aspect = svg.getAttribute('preserveAspectRatio') || '';
  let key = null;
  if (holder.classList.contains('hide-tail')) {
    // \overrightarrow, \xrightarrow… anchor the arrow head at the clipped end.
    key = aspect.startsWith('xMax') ? '→' : '←';
  } else if (aspect === 'none') {
    key = wideAccentKey(svg);
  }
  if (key) {
    st.items.push({
      type: 'accent', seq: st.seq++, key, x: box.left, width: box.right - box.left,
      top: box.top, bottom: box.bottom, emPx: emOf(holder),
    });
    return;
  }
  st.warnings.push('Неизвестный элемент формулы (svg) заменён линией');
  pushFallbackRule(st, box, 'unknown');
}

/// Is (x, y) — in the path's own user units — inside its fill? False when the
/// browser cannot say.
function filled(path, x, y) {
  try { return path.isPointInFill(new DOMPoint(x, y)); } catch { return false; }
}

/// Filled samples along one row (y fixed) or column (x fixed) of a viewBox:
/// {n, min, max, mean} of the varying coordinate.
function scanFill(path, vb, { x = null, y = null }, steps = 80) {
  let n = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const v = x === null ? vb.x + (vb.width * i) / steps : vb.y + (vb.height * i) / steps;
    if (filled(path, x === null ? v : x, x === null ? y : v)) {
      n++; sum += v; min = Math.min(min, v); max = Math.max(max, v);
    }
  }
  return { n, min, max, mean: n ? sum / n : NaN };
}

/// \widehat / \widetilde / \widecheck are all `preserveAspectRatio="none"`
/// paths with no name in the DOM. Their shape tells them apart: compared with
/// its two ends, the middle of a hat is higher, of a check lower, and a
/// tilde's middle lies between its (unequal) ends.
function wideAccentKey(svg) {
  const path = svg.querySelector('path');
  const vb = svg.viewBox && svg.viewBox.baseVal;
  if (!path || !vb || !vb.height || typeof path.isPointInFill !== 'function') return 'ˆ';
  const at = (f) => scanFill(path, vb, { x: vb.x + vb.width * f }, 60).mean;
  const [l, m, r] = [at(0.1), at(0.5), at(0.9)];
  if ([l, m, r].some(Number.isNaN)) return '˜';
  const margin = vb.height * 0.08;
  if (m < Math.min(l, r) - margin) return 'ˆ';
  if (m > Math.max(l, r) + margin) return 'ˇ';
  return '˜';
}

/// \sqrt: one svg draws the check sign AND the vinculum (a 400em bar clipped
/// by `.hide-tail`). The sign box is the path's ink left of where the bar
/// starts; the bar is the path's last sub-path, "M x y h400000 v t …".
function radicalItem(tail, st) {
  const svg = tail.querySelector('svg');
  const path = svg.querySelector('path');
  if (!path) return;
  const svgRect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  // preserveAspectRatio "xMinYMin slice": uniform scale, the larger ratio.
  const scale = Math.max(svgRect.width / vb.width, svgRect.height / vb.height);
  const ink = st.rel(path.getBoundingClientRect());
  const tailRect = st.rel(tail.getBoundingClientRect());
  const d = path.getAttribute('d') || '';
  const bars = [...d.matchAll(/M\s*([\d.]+)[\s,]+([\d.]+)\s*[hH]\s*400000\s*v\s*([\d.]+)/g)];
  const svgLeft = st.rel(svgRect).left;
  let barX;
  let barTop;
  let thickness;
  if (bars.length) {
    const [, bx, by, bt] = bars[bars.length - 1];
    barX = svgLeft + parseFloat(bx) * scale;
    barTop = st.rel(svgRect).top + parseFloat(by) * scale;
    thickness = parseFloat(bt) * scale;
  } else {
    // Unknown surd path: assume the classic proportions (sign ≈ 0.833em).
    st.warnings.push('Необычный знак корня: черта оценена приблизительно');
    barX = Math.min(tailRect.right, ink.left + 0.833 * emOf(tail));
    thickness = 40 * scale;
    barTop = ink.top;
  }
  st.items.push({
    type: 'radical', seq: st.seq++,
    x: ink.left, top: barTop, bottom: ink.bottom, signWidth: barX - ink.left,
    vinculumY: barTop + thickness / 2, vinculumX2: tailRect.right,
    thickness, emPx: emOf(tail.closest('.sqrt') || tail),
  });
}

function emOf(el) {
  return parseFloat(getComputedStyle(el).fontSize) || 0;
}

// --- delimiters and accents built from groups ----------------------------------

function delimItem(group, st) {
  const el = group.el;
  const r = st.rel(el.getBoundingClientRect());
  let box = null;
  for (const g of group.glyphs) box = box ? unionBox(box, g.ink) : { ...g.ink };
  for (const svg of group.svgs) {
    const b = clippedPathBox(svg, st);
    if (b) box = box ? unionBox(box, b) : b;
  }
  if (!box) return null;

  let char = null;
  let font = 'delimsizing';
  const first = group.glyphs[0];
  if (first) {
    // Pieces of a stack (⎧⎨⎩⎪) all name the same delimiter.
    const pieceChar = group.glyphs.map((g) => g.char).find((ch) => PIECE_TO_DELIM[ch] && ch !== '⎪') || first.char;
    char = PIECE_TO_DELIM[pieceChar] || pieceChar;
    font = first.font;
  } else {
    char = svgDelimChar(group.svgs[0], el, st);
    font = 'size4'; // tall svg delimiters are drawn from the Size4 outlines
  }
  if (!char) return null;
  const single = group.glyphs.length === 1 && !group.svgs.length;
  return {
    type: 'delim', seq: group.seq, char, font,
    x: single ? first.x : r.left, advance: single ? first.advance : r.right - r.left,
    top: box.top, bottom: box.bottom, emPx: first ? first.emPx : emOf(el),
    inkLeft: box.left, inkRight: box.right,
  };
}

/// Tall (, ), [, ], ⌊, ⌋, ⌈, ⌉, |, ‖ are single svgs without a name. The
/// viewBox width says the family; where the ink sits says which one.
function svgDelimChar(svg, el, st) {
  const opening = !!el.closest('.mopen');
  const guess = opening ? '(' : ')';
  const path = svg && svg.querySelector('path');
  const vb = svg && svg.viewBox && svg.viewBox.baseVal;
  if (!path || !vb || typeof path.isPointInFill !== 'function') {
    st.warnings.push('Высокая скобка не распознана');
    return guess;
  }
  const w = Math.round(vb.width);
  const mid = scanFill(path, vb, { y: vb.y + vb.height / 2 });
  if (w === 333) return '|';
  if (w === 556) return '∥';
  // A paren's belly is on its open side's opposite: ( bulges left.
  if (w === 875 && mid.n) return mid.mean < vb.x + vb.width / 2 ? '(' : ')';
  if (w === 667 && mid.n) {
    // Brackets, floors, ceilings: a vertical stem plus a horizontal foot at
    // the top and/or bottom. The foot points into the formula, which tells
    // left from right; which feet exist tells [ from ⌊ from ⌈.
    const stem = mid.max - mid.min;
    const top = scanFill(path, vb, { y: vb.y + 42 });
    const bottom = scanFill(path, vb, { y: vb.y + vb.height - 42 });
    const hasTop = top.n > 0 && top.max - top.min > 2 * stem;
    const hasBottom = bottom.n > 0 && bottom.max - bottom.min > 2 * stem;
    const foot = hasTop ? top : hasBottom ? bottom : null;
    if (foot) {
      const opening = foot.mean > mid.mean;
      if (opening) return hasTop && hasBottom ? '[' : hasTop ? '⌈' : '⌊';
      return hasTop && hasBottom ? ']' : hasTop ? '⌉' : '⌋';
    }
  }
  st.warnings.push('Высокая скобка не распознана');
  return guess;
}

function accentItem(group, st) {
  if (group.svgs.length) {
    // \vec in KaTeX 0.16 is an svg arrow in `.overlay`.
    let box = null;
    for (const svg of group.svgs) {
      const b = clippedPathBox(svg, st);
      if (b) box = box ? unionBox(box, b) : b;
    }
    if (!box) return null;
    return {
      type: 'accent', seq: group.seq, key: '→', x: box.left, width: box.right - box.left,
      top: box.top, bottom: box.bottom, emPx: emOf(group.el),
    };
  }
  const g = group.glyphs[0];
  if (!g) return null;
  if (BAR_ACCENTS.has(g.char)) {
    const y = (g.ink.top + g.ink.bottom) / 2;
    return {
      type: 'rule', seq: group.seq, x1: g.ink.left, y1: y, x2: g.ink.right, y2: y,
      thickness: Math.max(0.5, g.ink.bottom - g.ink.top), role: 'overline',
    };
  }
  return {
    type: 'accent', seq: group.seq, key: ACCENT_KEYS[g.char] || g.char,
    x: g.ink.left, width: g.ink.right - g.ink.left, top: g.ink.top, bottom: g.ink.bottom, emPx: g.emPx,
  };
}

// --- glyphs ---------------------------------------------------------------------

/// The KaTeX font class of the nearest span that sets one. Inside \text{…}
/// without an explicit font it is `textrm`, so the key layer can tell a text
/// hyphen from a minus.
function fontClassOf(el) {
  let inText = false;
  for (let e = el; e && !e.classList.contains('katex-html'); e = e.parentElement) {
    const c = e.classList;
    if (c.contains('delimsizing')) {
      for (let n = 1; n <= 4; n++) if (c.contains(`size${n}`)) return `size${n}`;
    }
    if (c.contains('delimsizinginner')) {
      if (c.contains('delim-size1')) return 'size1';
      if (c.contains('delim-size4')) return 'size4';
    }
    if (c.contains('op-symbol')) {
      if (c.contains('large-op')) return 'large-op';
      if (c.contains('small-op')) return 'small-op';
    }
    for (const name of c) if (FONT_CLASSES.has(name)) return name;
    if (c.contains('text')) inText = true;
  }
  return inText ? 'textrm' : 'main';
}

/// Ink extents of one character, per 1px of font size. Measured once per
/// face at a large reference size: some platforms report whole-pixel ink
/// bounds, which at 40px would be a 2% error and at 1000px is noise.
function inkOf(face, char) {
  const font = `${face.style} ${face.weight} ${INK_REF_PX}px ${face.family}`;
  const cacheKey = `${font}\u0000${char}`;
  let m = inkCache.get(cacheKey);
  if (!m) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    const t = measureCtx.measureText(char);
    m = {
      left: (t.actualBoundingBoxLeft || 0) / INK_REF_PX, right: (t.actualBoundingBoxRight || 0) / INK_REF_PX,
      ascent: (t.actualBoundingBoxAscent || 0) / INK_REF_PX, descent: (t.actualBoundingBoxDescent || 0) / INK_REF_PX,
    };
    inkCache.set(cacheKey, m);
  }
  return m;
}

/// Per-character advance boxes (Range rects), per-text-node baselines (one
/// probe each) and ink (canvas measureText in the computed font). Reads are
/// batched around a single insertion of all probes so the page lays out once.
function measureTexts(st, ox, oy) {
  const jobs = st.texts;
  const range = document.createRange();
  const glyphs = [];

  // Pass 1 — read, no mutation.
  for (const job of jobs) {
    const el = job.node.parentElement;
    const cs = getComputedStyle(el);
    job.cssFont = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    job.face = { style: cs.fontStyle, weight: cs.fontWeight, family: cs.fontFamily };
    job.emPx = parseFloat(cs.fontSize);
    job.font = fontClassOf(el);
    job.large = /KaTeX_Size[1-4]/.test(cs.fontFamily);
    const lap = el.closest('.rlap, .llap');
    job.lap = lap ? (lap.classList.contains('rlap') ? 'r' : 'l') : null;
    range.selectNodeContents(job.node);
    job.before = range.getBoundingClientRect();
    job.chars = [];
    const text = job.node.data;
    let offset = 0;
    for (const ch of text) {
      const len = ch.length;
      if (!SKIP_CHAR.test(ch)) {
        range.setStart(job.node, offset);
        range.setEnd(job.node, offset + len);
        const r = range.getBoundingClientRect();
        job.chars.push({ ch, left: r.left, width: r.width });
      }
      offset += len;
    }
  }

  // Pass 2 — one probe after every text node, then read baselines.
  const probes = jobs.map((job) => {
    const probe = makeProbe();
    job.node.parentNode.insertBefore(probe, job.node.nextSibling);
    return probe;
  });
  let shift = 0;
  jobs.forEach((job, i) => {
    job.baseline = probes[i].getBoundingClientRect().top - oy;
    range.selectNodeContents(job.node);
    const after = range.getBoundingClientRect();
    shift = Math.max(shift, Math.abs(after.left - job.before.left), Math.abs(after.top - job.before.top));
  });
  for (const probe of probes) probe.remove();
  if (shift > PROBE_TOLERANCE_PX) {
    st.warnings.push(`Зонд базовой линии сдвинул разметку на ${shift.toFixed(2)} px`);
  }

  // Pass 3 — pure arithmetic.
  for (const job of jobs) {
    for (const c of job.chars) {
      const m = inkOf(job.face, c.ch);
      const k = job.emPx;
      const x = c.left - ox;
      glyphs.push({
        group: job.group, seq: job.seq, char: c.ch, font: job.font, x, advance: c.width,
        baseline: job.baseline, emPx: job.emPx, large: job.large, lap: job.lap, cssFont: job.cssFont,
        ink: {
          left: x - m.left * k, right: x + m.right * k,
          top: job.baseline - m.ascent * k, bottom: job.baseline + m.descent * k,
        },
      });
    }
  }
  return glyphs;
}

/// Folds `\not =`, `\not\in`, `\notin` into ≠, ∉ … (see NEGATED).
function foldNegations(glyphs) {
  const out = [];
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    if (g.char === NOT_SLASH) {
      const next = glyphs[i + 1];
      if (next && NEGATED[next.char]) {
        out.push({ ...next, char: NEGATED[next.char], seq: g.seq, ink: unionBox(next.ink, g.ink) });
        i++;
      } else {
        out.push({ ...g, char: '/' });
      }
      continue;
    }
    if (g.char === '/' && g.lap === 'l' && out.length) {
      const prev = out[out.length - 1];
      if (NEGATED[prev.char]) {
        out[out.length - 1] = { ...prev, char: NEGATED[prev.char], ink: unionBox(prev.ink, g.ink) };
        continue;
      }
    }
    out.push(g);
  }
  return out;
}

function glyphItem(g) {
  return {
    type: 'glyph', seq: g.seq, key: g.char, char: g.char, font: g.font,
    x: g.x, advance: g.advance, baseline: g.baseline, emPx: g.emPx,
    ink: g.ink, large: g.large, cssFont: g.cssFont,
  };
}

function itemBox(item) {
  switch (item.type) {
    case 'glyph': return item.ink;
    case 'rule': {
      const h = item.thickness / 2;
      return {
        left: Math.min(item.x1, item.x2) - (item.x1 === item.x2 ? h : 0),
        right: Math.max(item.x1, item.x2) + (item.x1 === item.x2 ? h : 0),
        top: Math.min(item.y1, item.y2) - (item.y1 === item.y2 ? h : 0),
        bottom: Math.max(item.y1, item.y2) + (item.y1 === item.y2 ? h : 0),
      };
    }
    case 'radical': return { left: item.x, right: item.vinculumX2, top: item.top, bottom: item.bottom };
    case 'delim': return { left: Math.min(item.x, item.inkLeft), right: Math.max(item.x + item.advance, item.inkRight), top: item.top, bottom: item.bottom };
    case 'accent': return { left: item.x, right: item.x + item.width, top: item.top, bottom: item.bottom };
    default: return { left: 0, right: 0, top: 0, bottom: 0 };
  }
}

/// 1/1000 px is far below anything drawable and keeps cached layouts small.
function roundItem(item) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (typeof v === 'number') out[k] = Math.round(v * 1000) / 1000;
    else if (v && typeof v === 'object') out[k] = roundItem(v);
    else out[k] = v;
  }
  return out;
}
