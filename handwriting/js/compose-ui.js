// «Решение почерком»: the screen where a pasted ChatGPT answer becomes a
// notebook page in the writer's own hand.
//
// This module is only the screen — parsing (solution.js), layout
// (mathlayout.js via compose.js), variation (variation.js) and rendering
// (compose.js) live elsewhere and are tested on their own. It is loaded with a
// dynamic import the first time the screen opens, so a writer who only
// collects words never downloads KaTeX, the compositor or this file.
//
// Everything the writer sets here — the pasted answer, every knob, paper and
// ink — is persisted per writer in `meta` (key `compose:<writer_id>`), so a
// reload, a trip to the capture screen to write missing symbols, or an iPad
// discarding the tab costs nothing. None of it is uploaded to the dataset.
// The one exception is opt-in: with a handwriting-model URL set in Settings,
// each running-text word goes to that URL (with the writer_id and a seed) —
// the screen says so in #compose-sources whenever it is set.
//
// Every string goes through i18n.js; the compositor's own messages (Russian —
// those modules are shared with the app) are re-worded where they are shown
// (`translateEngineMessage`), and `relocalize()` redraws the screen after a
// RU/EN switch.

import { parseSolution, formulasOf, lintLatex, CHATGPT_PROMPT_RU, CHATGPT_PROMPT_EN } from './solution.js';
import { composeSolution, renderPage, pageToSVG, pageToPNG } from './compose.js';
import { buildBanks, coverage } from './glyphs.js';
import { estimateProfile, VARIATION_DEFAULTS } from './variation.js';
import { debounce, escapeHtml, clamp } from './util.js';
import { samples as sampleStore, meta } from './store.js';
import { deliver, slug, APP_VERSION } from './exchange.js';
import { t, tn, getLang, formatDecimal, translateEngineMessage } from './i18n.js';

/// Live re-render delay after the last keystroke / slider move. Long enough
/// that dragging a slider doesn't queue a composition per pixel, short enough
/// to feel live.
const RENDER_DEBOUNCE_MS = 250;
const SAVE_DEBOUNCE_MS = 300;
/// A text-model request that takes longer than this is abandoned; the word
/// then comes from the writer's own words / letters. textink.js has its own
/// (equal) race; the abort here just stops the socket from lingering.
const MODEL_TIMEOUT_MS = 2500;
const MODEL_MEMO_LIMIT = 4000;
/// Session circuit breaker: textink.js gives up on the model after three
/// failures within ONE composition, but every re-render (a slider move, a
/// keystroke) starts a new one — without this a hanging model would cost
/// 3 × 2.5 s per preview. After this many failures in a row it is left alone
/// for MODEL_PAUSE_MS (or until the URL changes / the screen is reopened).
const MODEL_BREAKER_FAILURES = 3;
const MODEL_PAUSE_MS = 60_000;

/// Page geometry the compositor gets: A4 at 1240 px wide (≈ 150 dpi on
/// screen, PNG export doubles it), 5 mm cells.
const PAGE_WIDTH_PX = 1240;
const CELL_PX = (PAGE_WIDTH_PX * 5) / 210;

const INKS = Object.freeze({
  blue: '#1d2b6b',
  black: '#17181c',
  violet: '#4a2c8f',
});

/// Multiplier knobs (variation.js): 0 = off, 1 = «как вы сами» (the spread
/// measured from the writer's own repeats), 2 = twice as careless. Label and
/// help come from i18n.js as `knob.<key>` / `knob.<key>.help`.
const HAND_KNOBS = [
  { key: 'amount', max: 2 },
  { key: 'size', max: 2 },
  { key: 'slant', max: 2 },
  { key: 'baseline', max: 2 },
  { key: 'shape', max: 2 },
  { key: 'spacing', max: 2 },
  { key: 'drift', max: 2 },
  { key: 'pressure', max: 2 },
  { key: 'morph', max: 2 },
  { key: 'fit', max: 1, fit: true },
];

const PAGE_KNOBS = [
  { key: 'xh', min: 0.3, max: 0.7, step: 0.01 },
];

const DEFAULT_SETTINGS = Object.freeze({
  text: '',
  // The prompt's language; a writer who never picked one gets the page's.
  lang: null,
  knobs: { ...VARIATION_DEFAULTS },
  paper: 'grid',
  ink: 'blue',
  xh: 0.42,
  margin: true,
  showMissing: false,
});

/// Where a running-text word came from, as the sources line names it.
const SOURCE_KEYS = {
  model: 'compose.sourceModel',
  word: 'compose.sourceWord',
  letters: 'compose.sourceLetters',
  fallback: 'compose.sourceFallback',
};

const decimal = (v, digits = 2) => formatDecimal(v, digits);

/// Settings as stored, merged over defaults and sanitised — an old or
/// hand-edited record can never put a NaN into the compositor.
function sanitize(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) };
  s.text = typeof s.text === 'string' ? s.text : '';
  s.lang = s.lang === 'en' || s.lang === 'ru' ? s.lang : getLang();
  const knobs = { ...VARIATION_DEFAULTS };
  for (const def of HAND_KNOBS) {
    const v = Number(s.knobs?.[def.key]);
    if (Number.isFinite(v)) knobs[def.key] = clamp(v, 0, def.max);
  }
  const seed = Number(s.knobs?.seed);
  knobs.seed = Number.isFinite(seed) ? Math.max(0, Math.round(seed)) : VARIATION_DEFAULTS.seed;
  s.knobs = knobs;
  s.paper = ['grid', 'lines', 'blank'].includes(s.paper) ? s.paper : 'grid';
  s.ink = INKS[s.ink] ? s.ink : 'blue';
  const xh = Number(s.xh);
  s.xh = Number.isFinite(xh) ? clamp(xh, 0.3, 0.7) : DEFAULT_SETTINGS.xh;
  s.margin = s.margin !== false;
  s.showMissing = s.showMissing === true;
  return s;
}

/// Wires the screen once and returns its controller. `deps` are the app's
/// own helpers, passed in rather than imported so this module never reaches
/// into app.js state:
///   { toast(msg, isError), isIOS(), corpus() → Glyph[]|null,
///     onFillMissing(glyphIDs) — open targeted symbol capture }
export function createComposeUI(deps) {
  const el = (id) => document.getElementById(id);
  const { toast, isIOS, corpus, onFillMissing } = deps;

  let writer = null;
  let settings = sanitize(null);
  let bankCache = null;
  let last = null;           // { result, pages, settings } of the last good render
  let pageIndex = 0;
  let renderToken = 0;
  let running = false;
  let again = false;
  let modelMemo = new Map();
  let modelURL = '';
  let modelBreaker = { failures: 0, pausedUntil: 0 };
  let missingIDs = [];

  // MARK: Persistence

  const saveNow = async () => {
    if (!writer) return;
    try { await meta.set(`compose:${writer.writer_id}`, settings); } catch { /* next change retries */ }
  };
  const scheduleSave = debounce(saveNow, SAVE_DEBOUNCE_MS);

  // MARK: Banks — built once per writer and sample count

  /// The writer's banks and variability profile. Rebuilding means reading
  /// every sample and normalising its strokes, so it is cached and redone
  /// only when the sample count moves (a capture, an import) or the app says
  /// so via `invalidate`. Knob changes never touch it.
  async function banksFor(writerID) {
    const count = await sampleStore.countForWriter(writerID);
    if (bankCache && bankCache.writerID === writerID && bankCache.count === count) return bankCache;
    const rows = await sampleStore.allForWriter(writerID);
    const { glyphs, words } = buildBanks(rows);
    bankCache = { writerID, count, glyphs, words, profile: estimateProfile(glyphs) };
    return bankCache;
  }

  // MARK: Text model hook

  /// The optional handwriting-generation model for running text: a page
  /// script's `window.NotoHandwritingModel` wins, else the URL from Settings
  /// (POST {writer_id, text, seed} → {strokes, width} in ex units). Answers
  /// are memoised by (text, seed) — positions key the seed, so a knob change
  /// re-renders without asking the model again. Failures are not memoised
  /// and fall through to the writer's own words (textink.js counts them);
  /// a run of them pauses the model for the session (`modelBreaker`).
  function textModel() {
    const hook = window.NotoHandwritingModel;
    let call = null;
    if (typeof hook === 'function') {
      call = (text, opts) => hook(text, { ...opts, writer_id: writer.writer_id });
    } else if (hook && typeof hook.generate === 'function') {
      call = (text, opts) => hook.generate(text, { ...opts, writer_id: writer.writer_id });
    } else if (modelURL) {
      const url = modelURL;
      const writerID = writer.writer_id;
      call = (text, { seed }) => postModel(url, { writer_id: writerID, text, seed });
    }
    if (!call) return null;
    return async (text, opts = {}) => {
      const key = `${text}\u0000${opts.seed ?? ''}`;
      if (modelMemo.has(key)) return modelMemo.get(key);
      // Paused: null means «no model answer» — the word comes from the
      // writer's own ink at once, with no timeout to sit through.
      if (modelPaused()) return null;
      let answer;
      try {
        answer = await withTimeout(Promise.resolve().then(() => call(text, opts)), MODEL_TIMEOUT_MS);
        modelBreaker.failures = 0;
      } catch (error) {
        if (++modelBreaker.failures >= MODEL_BREAKER_FAILURES) {
          modelBreaker = { failures: 0, pausedUntil: Date.now() + MODEL_PAUSE_MS };
        }
        throw error;
      }
      if (modelMemo.size > MODEL_MEMO_LIMIT) modelMemo = new Map();
      modelMemo.set(key, answer ?? null);
      return answer ?? null;
    };
  }

  function modelPaused() {
    return Date.now() < modelBreaker.pausedUntil;
  }

  function resetModelBreaker() {
    modelBreaker = { failures: 0, pausedUntil: 0 };
  }

  function withTimeout(promise, ms) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function postModel(url, body) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), MODEL_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // MARK: Controls

  function knobRow(def, value, group) {
    const min = def.min ?? 0;
    const step = def.step ?? 0.05;
    return `
      <div class="knob">
        <label for="knob-${def.key}">
          <span class="knob-head"><b>${escapeHtml(t(`knob.${def.key}`))}</b><output id="knob-${def.key}-value"></output></span>
          <small>${escapeHtml(t(`knob.${def.key}.help`))}</small>
        </label>
        ${def.fit ? `<div class="knob-ends"><span>${escapeHtml(t('knob.endMe'))}</span><span>${escapeHtml(t('knob.endLatex'))}</span></div>` : ''}
        <input type="range" id="knob-${def.key}" data-group="${group}" data-knob="${def.key}"
               min="${min}" max="${def.max}" step="${step}" value="${value}">
      </div>`;
  }

  function formatKnob(def, value) {
    if (def.key === 'xh') return t('knob.cells', { v: decimal(value) });
    if (def.fit) return `${Math.round(value * 100)}%`;
    if (value === 0) return t('knob.off');
    return `${decimal(value)}×${Math.abs(value - 1) < 1e-9 ? t('knob.likeYou') : ''}`;
  }

  function buildControls() {
    el('compose-knobs').innerHTML = HAND_KNOBS.map((d) => knobRow(d, settings.knobs[d.key], 'hand')).join('');
    el('compose-page-knobs').innerHTML = PAGE_KNOBS.map((d) => knobRow(d, settings[d.key], 'page')).join('');
  }

  function syncControls() {
    for (const def of HAND_KNOBS) {
      const input = el(`knob-${def.key}`);
      input.value = settings.knobs[def.key];
      el(`knob-${def.key}-value`).textContent = formatKnob(def, settings.knobs[def.key]);
    }
    for (const def of PAGE_KNOBS) {
      el(`knob-${def.key}`).value = settings[def.key];
      el(`knob-${def.key}-value`).textContent = formatKnob(def, settings[def.key]);
    }
    el('compose-seed').value = settings.knobs.seed;
    setSegmented('compose-paper', settings.paper);
    setSegmented('compose-ink', settings.ink);
    setSegmented('compose-prompt-lang', settings.lang);
    el('compose-margin').checked = settings.margin;
    el('compose-show-missing').checked = settings.showMissing;
    el('compose-prompt-text').value = promptText();
  }

  function setSegmented(id, value) {
    for (const button of el(id).querySelectorAll('button[data-value]')) {
      button.setAttribute('aria-pressed', String(button.dataset.value === value));
    }
  }

  function promptText() {
    return settings.lang === 'en' ? CHATGPT_PROMPT_EN : CHATGPT_PROMPT_RU;
  }

  function changed({ render = true } = {}) {
    scheduleSave();
    if (render) scheduleRender();
  }

  function bind() {
    const knobs = [el('compose-knobs'), el('compose-page-knobs')];
    for (const box of knobs) {
      box.addEventListener('input', (event) => {
        const input = event.target.closest('input[data-knob]');
        if (!input) return;
        const key = input.dataset.knob;
        const value = Number(input.value);
        if (input.dataset.group === 'hand') settings.knobs[key] = value;
        else settings[key] = value;
        const def = [...HAND_KNOBS, ...PAGE_KNOBS].find((d) => d.key === key);
        el(`knob-${key}-value`).textContent = formatKnob(def, value);
        changed();
      });
    }

    el('compose-seed').addEventListener('input', (event) => {
      const seed = Number(event.target.value);
      if (!Number.isFinite(seed)) return;
      settings.knobs.seed = Math.max(0, Math.round(seed));
      changed();
    });
    el('compose-dice').addEventListener('click', () => {
      settings.knobs.seed = 1 + Math.floor(Math.random() * 99_999);
      el('compose-seed').value = settings.knobs.seed;
      changed();
    });
    el('compose-reset').addEventListener('click', () => {
      // The seed stays: resetting the knobs must not also swap the draw the
      // writer may have liked.
      settings.knobs = { ...VARIATION_DEFAULTS, seed: settings.knobs.seed };
      syncControls();
      changed();
    });

    const segmented = (id, apply) => el(id).addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (!button) return;
      apply(button.dataset.value);
      setSegmented(id, button.dataset.value);
    });
    segmented('compose-paper', (v) => { settings.paper = v; changed(); });
    segmented('compose-ink', (v) => { settings.ink = v; changed({ render: false }); drawPreview(); });
    segmented('compose-prompt-lang', (v) => {
      settings.lang = v;
      el('compose-prompt-text').value = promptText();
      changed({ render: false });
    });
    el('compose-margin').addEventListener('change', (event) => { settings.margin = event.target.checked; changed(); });
    el('compose-show-missing').addEventListener('change', (event) => {
      settings.showMissing = event.target.checked;
      changed({ render: false });
      drawPreview();
    });

    const input = el('compose-input');
    input.addEventListener('input', () => {
      settings.text = input.value;
      changed();
    });
    el('compose-clear').addEventListener('click', () => {
      input.value = '';
      settings.text = '';
      changed();
      input.focus();
    });
    // Reading the clipboard needs a secure context; over plain http:// the
    // button simply isn't offered and a long-press «Вставить» does the job.
    const paste = el('compose-paste');
    paste.hidden = !(navigator.clipboard && typeof navigator.clipboard.readText === 'function' && window.isSecureContext);
    paste.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) { toast(t('compose.clipboardEmpty')); return; }
        input.value = text;
        settings.text = text;
        changed();
      } catch {
        toast(t('compose.clipboardDenied'), true);
      }
    });

    el('compose-copy-prompt').addEventListener('click', copyPrompt);

    el('compose-prev').addEventListener('click', () => { pageIndex = Math.max(0, pageIndex - 1); drawPreview(); });
    el('compose-next').addEventListener('click', () => {
      pageIndex = Math.min((last?.pages.length ?? 1) - 1, pageIndex + 1);
      drawPreview();
    });

    el('compose-fill-missing').addEventListener('click', async () => {
      if (missingIDs.length === 0) return;
      await saveNow();
      onFillMissing([...missingIDs]);
    });

    el('compose-png').addEventListener('click', exportPNG);
    el('compose-svg').addEventListener('click', exportSVG);
    el('compose-print').addEventListener('click', printPages);
    el('compose-json').addEventListener('click', exportJSON);

    let frame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (isVisible()) drawPreview(); });
    }).observe(el('compose-preview'));

    // A reload within the save debounce must not cost the last keystrokes.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
    window.addEventListener('pagehide', () => { saveNow(); });
  }

  function isVisible() {
    return document.body.dataset.screen === 'compose';
  }

  // MARK: Prompt copy

  /// navigator.clipboard exists only in a secure context, and the app is also
  /// served over plain http:// on the LAN — there the prompt's own readonly
  /// textarea is opened, selected and copied the old way, and if even that
  /// is refused, it stays selected for the writer to copy by hand.
  async function copyPrompt() {
    const text = promptText();
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        toast(t('compose.promptCopied'));
        return;
      }
    } catch { /* fall through to the selection path */ }
    const details = el('compose-prompt-text').closest('details');
    if (details) details.open = true;
    const area = el('compose-prompt-text');
    area.value = text;
    area.focus();
    area.select();
    try { area.setSelectionRange(0, text.length); } catch { /* not fatal */ }
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    toast(copied ? t('compose.promptCopied') : t('compose.promptSelected'));
  }

  // MARK: Rendering

  const scheduleRender = debounce(() => { run(); }, RENDER_DEBOUNCE_MS);

  function setStatus(tone, text) {
    const node = el('compose-status');
    node.dataset.tone = tone;
    node.textContent = text;
  }

  function pageSettings() {
    return {
      widthPx: PAGE_WIDTH_PX,
      cellPx: CELL_PX,
      paper: settings.paper,
      xHeightPx: settings.xh * CELL_PX,
      marginLine: settings.margin ? 'right' : 'none',
    };
  }

  /// One composition at a time: a request that arrives while one is running
  /// just asks for one more pass after it, with whatever the inputs are by
  /// then — intermediate slider positions are never composed for nothing.
  async function run() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        await renderOnce();
      } while (again);
    } finally {
      running = false;
    }
  }

  async function renderOnce() {
    if (!writer) return;
    const forWriter = writer;
    const token = ++renderToken;
    const text = settings.text;
    if (!text.trim()) {
      last = null;
      pageIndex = 0;
      setStatus('idle', '');
      drawPreview();
      renderPanels(null, []);
      return;
    }
    setStatus('busy', t('compose.busy'));
    try {
      const banks = await banksFor(writer.writer_id);
      const blocks = parseSolution(text);
      const result = await composeSolution(blocks, {
        glyphs: banks.glyphs,
        words: banks.words,
        profile: banks.profile,
        knobs: { ...settings.knobs },
        textModel: textModel(),
        page: pageSettings(),
      });
      // Another writer's screen may have opened meanwhile: their page must
      // never show (or be exported) under this one's name.
      if (token !== renderToken || writer?.writer_id !== forWriter.writer_id) return;
      last = { result, pages: result.pages, banks };
      pageIndex = clamp(pageIndex, 0, Math.max(0, result.pages.length - 1));
      drawPreview();
      renderPanels(result, blocks);
      const n = result.pages.length;
      setStatus('ok', t('compose.ready', { pages: tn('n.pages', n), ms: Math.round(result.stats?.ms ?? 0) }));
    } catch (error) {
      if (token !== renderToken || writer?.writer_id !== forWriter.writer_id) return;
      console.warn('compose failed', error);
      // The last good page stays on screen: a half-typed formula or a
      // hiccup must not blank what the writer was looking at.
      setStatus('error', t('compose.failed', { error: translateEngineMessage(error?.message ?? error) }) +
        (last ? t('compose.failedKeep') : ''));
    }
  }

  /// The current page into a canvas as wide as the preview, sharp at the
  /// device pixel ratio. Only the visible page is rasterised.
  function drawPreview() {
    const preview = el('compose-preview');
    const pages = last?.pages ?? [];
    const has = pages.length > 0;
    el('compose-empty').hidden = has;
    el('compose-pager').hidden = pages.length < 2;
    for (const id of ['compose-png', 'compose-svg', 'compose-print', 'compose-json']) el(id).disabled = !has;
    let canvas = preview.querySelector('canvas');
    if (!has) {
      canvas?.remove();
      return;
    }
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.setAttribute('role', 'img');
      preview.append(canvas);
    }
    pageIndex = clamp(pageIndex, 0, pages.length - 1);
    const page = pages[pageIndex];
    const cssWidth = Math.max(200, preview.clientWidth || 600);
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(3, (cssWidth * dpr) / page.width);
    renderPage(page, canvas, { ink: INKS[settings.ink], scale, showMissing: settings.showMissing });
    canvas.style.width = '100%';
    canvas.style.aspectRatio = `${page.width} / ${page.height}`;
    canvas.setAttribute('aria-label', t('compose.pageAria', { i: pageIndex + 1, n: pages.length }));
    el('compose-page-label').textContent = t('compose.pageLabel', { i: pageIndex + 1, n: pages.length });
    el('compose-prev').disabled = pageIndex === 0;
    el('compose-next').disabled = pageIndex >= pages.length - 1;
    el('compose-png').textContent = pages.length > 1 ? t('compose.pngPage', { i: pageIndex + 1 }) : 'PNG';
    el('compose-svg').textContent = pages.length > 1 ? t('compose.svgPage', { i: pageIndex + 1 }) : 'SVG';
  }

  function renderPanels(result, blocks) {
    renderMissing(result);
    renderSources(result);
    renderLint(result, blocks);
    renderCoverage();
  }

  function renderMissing(result) {
    const card = el('compose-missing-card');
    const missing = result?.missing instanceof Map ? result.missing : new Map();
    if (missing.size === 0) {
      card.hidden = true;
      missingIDs = [];
      return;
    }
    const glyphs = corpus() ?? [];
    const byChar = new Map(glyphs.map((g) => [g.char, g]));
    const writable = [];
    const foreign = [];
    // Map order is first appearance on the page — the order to write them in.
    for (const key of missing.keys()) {
      const glyph = byChar.get(key);
      if (glyph) writable.push(glyph);
      else foreign.push(key);
    }
    missingIDs = writable.map((g) => g.id);
    const n = missing.size;
    const shown = [...missing.keys()].slice(0, 40).join(' ');
    const more = n > 40 ? t('compose.andMore', { n: n - 40 }) : '';
    el('compose-missing-text').innerHTML =
      `${escapeHtml(t('compose.missing', { count: tn('n.missingSymbols', n) }))} <span class="missing-chars">${escapeHtml(shown)}${escapeHtml(more)}</span>`;
    const fill = el('compose-fill-missing');
    fill.hidden = writable.length === 0;
    fill.textContent = writable.length === n
      ? t('compose.fillMissing')
      : tn('n.fillSymbols', writable.length);
    el('compose-missing-note').textContent = [
      t('compose.missingNote'),
      foreign.length ? t('compose.foreign', { chars: foreign.join(' ') }) : '',
    ].filter(Boolean).join(' ');
    card.hidden = false;
  }

  function renderSources(result) {
    const node = el('compose-sources');
    const s = result?.stats?.sources;
    const lines = [];
    // Said whenever a model URL is set, rendered or not: the writer must
    // know their words and pseudonymous id leave the device.
    if (modelURL && !hasPageModel()) {
      lines.push(t('compose.modelSends', { host: hostOf(modelURL) }));
      if (modelPaused()) lines.push(t('compose.modelPaused'));
    }
    if (s) {
      const parts = [];
      for (const key of ['model', 'word', 'letters', 'fallback']) {
        if (s[key] > 0) parts.push(`${t(SOURCE_KEYS[key])} — ${s[key]}`);
      }
      if (s.modelFailures > 0) parts.push(t('compose.modelFailures', { times: tn('n.times', s.modelFailures) }));
      if (parts.length) lines.push(t('compose.sources', { parts: parts.join(' · ') }));
    }
    node.textContent = lines.join(' ');
  }

  function hasPageModel() {
    const hook = window.NotoHandwritingModel;
    return typeof hook === 'function' || typeof hook?.generate === 'function';
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch { return url; }
  }

  function renderLint(result, blocks) {
    const items = [];
    const seen = new Set();
    const add = (text) => { if (!seen.has(text)) { seen.add(text); items.push(text); } };
    // A formula KaTeX refused gets one line, not two: the lint's reason plus
    // what the compositor did about it («записана как текст»).
    const failed = new Set();
    const FAILED_PREFIX = 'Формула не разобрана и записана как текст: ';
    const warnings = result?.warnings ?? [];
    // Every formula of the document: paragraphs, list items, headings, table
    // cells and display blocks alike.
    for (const { latex } of formulasOf(blocks ?? [])) {
      const lint = lintLatex(latex);
      if (lint.length === 0) continue;
      const own = warnings.filter((w) => w === `${FAILED_PREFIX}${latex}` || w.startsWith(`${FAILED_PREFIX}${latex} (`));
      for (const w of own) failed.add(w);
      const tail = own.length ? t('compose.lintAsText') : '';
      const formula = `$${latex.length > 60 ? `${latex.slice(0, 57)}…` : latex}$`;
      for (const warning of lint) add(t('compose.lintIn', { warning: translateEngineMessage(warning), formula, tail }));
    }
    // Matched above on the compositor's own (Russian) text; worded for the
    // writer only here.
    for (const warning of warnings) if (!failed.has(warning)) add(translateEngineMessage(warning));
    const details = el('compose-lint');
    details.hidden = items.length === 0;
    el('compose-lint-summary').textContent = t('compose.lintSummary', { n: items.length });
    el('compose-lint-list').innerHTML = items.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  }

  function renderCoverage() {
    const node = el('compose-coverage');
    const glyphs = corpus();
    if (!glyphs || !bankCache) { node.textContent = ''; return; }
    const cov = coverage(bankCache.glyphs, glyphs);
    const rounds = Object.entries(cov.byRound)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([round, r]) => t('compose.round', { round, have: r.have, total: r.total }));
    node.textContent = t('compose.coverage', {
      have: cov.have.size,
      total: glyphs.length,
      rounds: rounds.join(', '),
      spread: bankCache.profile?.fromDefaults ? t('compose.spreadDefault') : t('compose.spreadMeasured'),
    });
  }

  // MARK: Export

  function fileBase() {
    return `noto-reshenie-${slug(writer?.label || 'writer')}`;
  }

  async function hand(name, blob) {
    try {
      const result = await deliver({ name, blob }, { preferShare: isIOS() });
      if (result.method !== 'cancelled') toast(t('compose.saved', { name }));
    } catch (error) {
      toast(t('compose.saveFailed', { error: translateEngineMessage(error?.message ?? error) }), true);
    }
  }

  function currentPage() {
    return last?.pages?.[pageIndex] ?? null;
  }

  async function exportPNG() {
    const page = currentPage();
    if (!page) return;
    const blob = await pageToPNG(page, { ink: INKS[settings.ink], scale: 2 });
    await hand(`${fileBase()}-${pageIndex + 1}.png`, blob);
  }

  async function exportSVG() {
    const page = currentPage();
    if (!page) return;
    const svg = pageToSVG(page, { ink: INKS[settings.ink] });
    await hand(`${fileBase()}-${pageIndex + 1}.svg`, new Blob([svg], { type: 'image/svg+xml' }));
  }

  async function exportJSON() {
    if (!last) return;
    const doc = {
      schema: 'noto-render-0.1',
      writer_id: writer.writer_id,
      app_version: APP_VERSION,
      generated_at: Date.now(),
      knobs: { ...settings.knobs },
      page: { ...pageSettings(), ink: INKS[settings.ink] },
      source_text: settings.text,
      pages: last.pages,
    };
    await hand(`${fileBase()}.json`, new Blob([JSON.stringify(doc)], { type: 'application/json' }));
  }

  /// Print / «Сохранить как PDF»: every page as a PNG on its own A4 sheet in
  /// a print-only document. The window is opened synchronously inside the
  /// click (later, after the PNGs, a popup blocker would refuse it); if it is
  /// refused anyway, a hidden iframe in this page prints instead.
  async function printPages() {
    if (!last?.pages?.length) return;
    let target = null;
    try { target = window.open('', '_blank'); } catch { target = null; }
    let frame = null;
    if (!target) {
      frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.append(frame);
      target = frame.contentWindow;
    }
    const doc = target.document;
    const title = escapeHtml(t('compose.title'));
    doc.open();
    doc.write(`<!doctype html><meta charset="utf-8"><title>${title}</title><p style="font:16px sans-serif;padding:24px">${escapeHtml(t('compose.printPreparing'))}</p>`);
    doc.close();
    try {
      const urls = [];
      for (const page of last.pages) {
        urls.push(URL.createObjectURL(await pageToPNG(page, { ink: INKS[settings.ink], scale: 2 })));
      }
      doc.open();
      doc.write(`<!doctype html><html lang="${getLang()}"><head><meta charset="utf-8"><title>${title}</title>
<style>
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
img { display: block; width: 210mm; height: 297mm; page-break-after: always; break-after: page; }
img:last-child { page-break-after: auto; break-after: auto; }
@media screen { body { background: #ccc; } img { width: min(210mm, 100vw); height: auto; margin: 12px auto; box-shadow: 0 2px 12px rgba(0,0,0,.25); } }
</style></head><body>${urls.map((u, i) => `<img src="${u}" alt="${escapeHtml(t('compose.printPage', { i: i + 1 }))}">`).join('')}</body></html>`);
      doc.close();
      await Promise.all([...doc.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }))));
      target.focus();
      target.print();
      // Blob URLs are freed once the print dialog has had them; the window
      // may stay open for another print, so give it a generous minute.
      setTimeout(() => { for (const u of urls) URL.revokeObjectURL(u); frame?.remove(); }, 60_000);
    } catch (error) {
      toast(t('compose.printFailed', { error: translateEngineMessage(error?.message ?? error) }), true);
      frame?.remove();
    }
  }

  bind();

  // MARK: Public

  return {
    /// Shows `w`'s screen: their saved answer and knobs, a fresh render.
    async open(w) {
      const switching = writer?.writer_id !== w.writer_id;
      writer = w;
      if (switching) {
        // A render still in flight for the previous writer is now stale.
        renderToken += 1;
        last = null;
        pageIndex = 0;
        modelMemo = new Map();
      }
      resetModelBreaker();
      modelURL = String(await meta.get('text_model_url', '') ?? '').trim();
      settings = sanitize(await meta.get(`compose:${w.writer_id}`, null));
      el('compose-writer').textContent = w.label ?? '';
      el('compose-input').value = settings.text;
      buildControls();
      syncControls();
      drawPreview();
      renderPanels(last?.result ?? null, []);
      run();
    },

    /// Forget cached banks (new samples arrived) — the next render rebuilds.
    invalidate(writerID = null) {
      if (!writerID || bankCache?.writerID === writerID) bankCache = null;
    },

    /// A different model URL was saved in Settings.
    setModelURL(url) {
      modelURL = String(url ?? '').trim();
      modelMemo = new Map();
      resetModelBreaker();
    },

    /// Persist now (leaving the screen).
    flush: saveNow,

    /// The interface language changed: knobs, panels and status are
    /// re-worded — the composition itself is re-run only when on screen,
    /// because its warnings are part of what the writer reads.
    relocalize() {
      if (!writer) return;
      buildControls();
      syncControls();
      drawPreview();
      renderPanels(last?.result ?? null, []);
      if (isVisible()) run();
    },
  };
}
