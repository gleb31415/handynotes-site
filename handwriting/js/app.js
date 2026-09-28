// The collection app itself: roster → consent → guided writing → export,
// plus «Решение почерком» (a pasted solution rewritten in the writer's hand).
//
// Everything is local-first. A sample is durable in IndexedDB the instant it
// is saved; the network is an afterthought that drains a queue when it can.
// A reload at any moment — including mid-word — resumes exactly where it was.
//
// The writing screen has two modes over ONE sheet and ONE save path:
//   * 'words'  — a shared core in the COLLECTION language: Russian
//     (`progress.cursor`, draft `draft:<id>` — exactly what they always were)
//     or English (`progress.cursor_en`, draft `draft:<id>:en`). The language
//     is a page-wide pick (`state.collectLang`, meta `collect_lang`, default
//     `?lang=` then the interface language) and each writer records the one
//     they write in as `task_language`, which travels in the upload envelope;
//   * 'glyphs' — math symbols (glyphs.js), `progress.glyph_cursor`, draft
//     `draft:<id>:glyphs`. A glyph run can also be TARGETED: a short queue of
//     symbols the compose screen found missing, written out of turn without
//     moving the cursor, after which the writer is taken back to the page.
//     A targeted run keeps its own draft (`draft:<id>:glyphs:target`), so it
//     never touches the half-written symbol waiting at the cursor.
//
// Everything collection-related is for adults only: the consent screen asks
// for the writer's own confirmation of being 18 or older, and nothing is
// written, uploaded or counted for a writer without it (`hasFullConsent`).
//
// The interface speaks Russian or English (i18n.js); every string below goes
// through `t`, and a `langchange` re-renders whatever is on screen.

import { uuidv4, escapeHtml, formatBytes, formatDate, debounce, clamp } from './util.js';
import { writers as writerStore, samples as sampleStore, meta, requestPersistence, storageEstimate, wipeEverything, wordLanguage, isGoalWord } from './store.js';
import { loadCoreRows, buildDelivery, tierCounts, groupTitle, normalizeLanguage, PACKET_SIZE } from './tasks.js';
import { InkSheet } from './ink.js';
import { SyncEngine, SERVER, GLYPH_CONSENT_VERSION, ADULT_CONSENT_VERSION, consentCovers, consentAllowsUpload } from './sync.js';
import { exportWriter, exportAll, deliver, importFile, APP_VERSION } from './exchange.js';
import { loadGlyphCorpus, buildGlyphDelivery, drawGlyphTemplate, GLYPH_PLAN_VERSION } from './glyphs.js';
import { t, tn, getLang, bindLangToggles, QUERY_LANG } from './i18n.js';
import { Community, GOAL_WORDS, roundFor } from './community.js';

/// 0.2 added math symbols (collected like words) and their local use for
/// rendering solutions in the writer's hand; 0.3 adds the writer's own
/// confirmation of being 18 or older (`consent.adult`). A writer who agreed
/// to an older text keeps what they wrote, but sees the consent screen again
/// before writing anything more, and nothing of theirs is uploaded until then
/// (sync.js `consentAllowsUpload`). Symbol consent logic is unchanged: 0.3
/// covers everything 0.2 did.
const CONSENT_TEXT_VERSION = ADULT_CONSENT_VERSION;
/// Task number the profile questions are hung off: late enough that the writer
/// has settled in, early enough that the answers describe the run that follows.
const STYLE_QUESTIONS_AT = 12;

const state = {
  /// Core rows per collection language; `en` stays null when its file could
  /// not be loaded (word collection in Russian must never depend on it).
  rowsByLang: { ru: null, en: null },
  /// 'ru' | 'en' — which core the words come from.
  collectLang: 'ru',
  writers: [],
  active: null,
  /// The active writer's delivery in `collectLang`.
  delivery: [],
  counts: {},
  sessionIDs: new Map(),
  sheet: null,
  pendingByWriter: new Map(),
  /// Delivery length per writer and language (`<id>:<lang>`). It is not simply
  /// the row count: repeats whose original landed too close to the tail are
  /// dropped, and how many that is varies with the shuffle, so each writer's
  /// own total is what their progress is measured against.
  deliveryTotals: new Map(),

  /// 'words' | 'glyphs' — which delivery the writing screen is walking.
  mode: 'words',
  /// The math-glyph corpus (null until loaded, or when it failed to load —
  /// then everything symbol-related says so instead of breaking the words).
  glyphCorpus: null,
  glyphDelivery: [],
  glyphDeliveryTotals: new Map(),
  /// Targeted symbol queue: { ids: [glyph_id…], index, returnTo: 'compose' }.
  target: null,
  /// Per writer: { total, words, glyphs, glyphOrders: Set } — words and
  /// symbols counted apart (store.summaryForWriter), refreshed only when the
  /// indexed sample count moves.
  summaries: new Map(),
  /// What «Начать» on the consent screen leads to, and where «←» goes.
  afterConsent: null,
  consentBack: 'roster',
  /// «Образец на листе» — the faint reference symbol under the ink.
  templateOn: true,
  /// The «Решение почерком» controller, imported on first use.
  compose: null,
  /// Whose ink the sheet holds: { writer_id, mode, targeted } from the moment
  /// the writing screen has painted (and restored) a task until it is left.
  /// Drafts are saved only for this owner — never for whoever `state.active`
  /// happens to be by then (another writer's compose screen, say).
  sheetOwner: null,
  /// A save or skip is in flight: a second tap must not store the same ink
  /// twice and advance past a task that was never written.
  saving: false,
  /// The community counter (community.js).
  community: new Community(),
  /// The "you're in" moment is on screen.
  celebrating: false,
};

const sync = new SyncEngine();

const el = (id) => document.getElementById(id);

// MARK: - Boot

async function boot() {
  try {
    await sync.loadSettings();
    sync.addEventListener('change', onSyncChange);

    state.rowsByLang.ru = await loadCoreRows('ru');
    // English is a second core; a failure to load it must never stop the
    // Russian collection — the page falls back to Russian words and says so.
    state.rowsByLang.en = await loadCoreRows('en').catch(() => null);
    state.collectLang = await initialCollectLang();
    let collectFallback = false;
    if (!rowsFor(state.collectLang)) {
      state.collectLang = 'ru';
      collectFallback = true;
    }
    // The symbol corpus is small (no KaTeX involved) and the roster shows
    // every writer's symbol progress, so it loads at boot too — but a failure
    // here must never stop word collection.
    state.glyphCorpus = await loadGlyphCorpus().catch(() => null);
    state.templateOn = await meta.get('glyph_template', true) !== false;
    state.writers = await writerStore.all();
    await refreshPendingCounts();
    await state.community.loadJoins(state.writers.map((w) => w.writer_id));
    state.community.addEventListener('change', renderCommunity);
    // Early, so a writer resumed straight into the writing screen sees (and
    // joins against) real numbers rather than the floor.
    state.community.refresh();

    const activeID = await meta.get('active_writer', null);
    // Читается до первого showScreen: тот сам пишет `last_screen`, и после
    // него подсказка о прерванной сессии была бы уже затёрта.
    const resumeScreen = await meta.get('last_screen', null);
    const resumeMode = await meta.get('write_mode', null);
    if (activeID && state.writers.some((w) => w.writer_id === activeID)) {
      await activateWriter(activeID, { navigate: false });
    }

    bindChrome();
    renderRoster();
    showScreen('roster');
    el('boot').remove();
    if (collectFallback) toast(t('collect.enFailed'), true);

    // Перезагрузка посреди сессии не должна выкидывать в список: если человек
    // писал — он возвращается к тому же слову (или символу), вместе с
    // недописанными штрихами; если собирал решение — к своему решению.
    // Писатель без подтверждения возраста сюда не проходит — он увидит
    // согласие, когда откроет себя из списка.
    if (resumeScreen === 'write' && hasFullConsent(state.active)) {
      if (resumeMode?.mode === 'glyphs') {
        if (state.glyphCorpus) {
          await openWriting('glyphs', { target: resumeMode.target ?? null });
        }
      } else {
        await openWriting('words');
      }
    } else if (resumeScreen === 'compose' && hasFullConsent(state.active)) {
      await openCompose(state.active.writer_id);
    }

    requestPersistence();
    sync.drain();
    registerServiceWorker();
  } catch (error) {
    const boot = el('boot');
    if (boot) {
      const message = error?.code === 'core_load_failed'
        ? t('boot.coreFailed', { status: error.status })
        : (error?.message ?? String(error));
      boot.innerHTML = `<div class="boot-error"><b>${escapeHtml(t('boot.failed'))}</b><p>${escapeHtml(message)}</p></div>`;
    }
  }
}

/// The collection language this visit starts in: the address (`?lang=`, the
/// app's "collect English handwriting" link) wins and is remembered; then
/// the last pick on this device; then the active writer's own language;
/// then the interface language.
async function initialCollectLang() {
  if (QUERY_LANG) {
    await meta.set('collect_lang', QUERY_LANG);
    return QUERY_LANG;
  }
  const saved = await meta.get('collect_lang', null);
  if (saved === 'ru' || saved === 'en') return saved;
  const activeID = await meta.get('active_writer', null);
  const active = activeID ? await writerStore.get(activeID) : null;
  if (active?.task_language === 'ru' || active?.task_language === 'en') return active.task_language;
  return getLang();
}

function rowsFor(lang = state.collectLang) {
  return state.rowsByLang[normalizeLanguage(lang)];
}

/// Consent to the current text including the 18+ confirmation — the gate
/// for writing, for «Решение почерком» and (in sync.js) for uploading.
function hasFullConsent(writer) {
  return !!writer && consentAllowsUpload(writer);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline is a bonus, not a requirement */ });
}

// MARK: - Screens

function showScreen(name) {
  for (const screen of document.querySelectorAll('.screen')) {
    screen.classList.toggle('is-active', screen.dataset.screen === name);
  }
  document.body.dataset.screen = name;
  // Куда возвращаться после перезагрузки. Пишется без await: это подсказка,
  // а не состояние, и потеря последней записи ничего не ломает.
  meta.set('last_screen', name === 'write' || name === 'compose' ? name : 'roster');
  if (name === 'write') {
    requestAnimationFrame(() => state.sheet?.resize());
    requestWakeLock();
  } else {
    releaseWakeLock();
  }
}

// MARK: - Roster

async function refreshPendingCounts() {
  // Filled aside and swapped in whole: a drain ending mid-refresh starts a
  // second one, and a render in between must not see a half-empty map.
  const counts = new Map();
  for (const writer of state.writers) {
    const total = await sampleStore.countForWriter(writer.writer_id);
    counts.set(writer.writer_id, {
      total,
      pending: await sampleStore.pendingCountForWriter(writer.writer_id),
    });
    await summaryFor(writer.writer_id, total);
  }
  state.pendingByWriter = counts;
}

/// Words / symbols split for one writer. The walk behind it reads every row,
/// so it is cached and redone only when the (indexed, cheap) total moves —
/// a save in this tab updates the cache in place (`noteSampleSaved`).
async function summaryFor(writerID, total = null) {
  const count = total ?? await sampleStore.countForWriter(writerID);
  const known = state.summaries.get(writerID);
  if (known && known.total === count) return known;
  const fresh = await sampleStore.summaryForWriter(writerID);
  const summary = {
    total: fresh.total,
    words: fresh.words,
    glyphs: fresh.glyphs,
    glyphOrders: new Set(fresh.glyphOrders),
    wordsByLang: { ...fresh.wordsByLang },
    goalByLang: { ...fresh.goalByLang },
  };
  state.summaries.set(writerID, summary);
  return summary;
}

function noteSampleSaved(sample) {
  const summary = state.summaries.get(sample.writer_id);
  if (!summary) return;
  summary.total += 1;
  if (sample.sample_type === 'prompted_glyph') {
    summary.glyphs += 1;
    if (sample.order > 0) summary.glyphOrders.add(sample.order);
  } else {
    summary.words += 1;
    const lang = wordLanguage(sample);
    if (lang) {
      summary.wordsByLang[lang] += 1;
      if (isGoalWord(sample)) summary.goalByLang[lang] += 1;
    }
  }
}

function summaryOf(writerID) {
  return state.summaries.get(writerID) ?? {
    total: 0, words: 0, glyphs: 0, glyphOrders: new Set(),
    wordsByLang: { ru: 0, en: 0 }, goalByLang: { ru: 0, en: 0 },
  };
}

/// Prompted words of `lang` this writer saved — what the community goal
/// (ru 150 / en 200) is measured in.
function goalWordsOf(writerID, lang = state.collectLang) {
  return summaryOf(writerID).goalByLang[lang] ?? 0;
}

function renderRoster() {
  const rows = rowsFor();
  // A plural, not a bare number: «871 слово», not «871 слов».
  el('roster-lead').textContent = t('roster.lead', { words: tn('n.words', rows?.length ?? 0) });
  updateCollectToggles();
  renderCommunity();

  const list = el('writer-list');
  if (state.writers.length === 0) {
    list.innerHTML = `<div class="empty">
      <p>${escapeHtml(t('roster.empty'))}</p>
      <p class="muted">${escapeHtml(t('roster.emptyHint'))}</p>
    </div>`;
  } else {
    list.innerHTML = state.writers.map(writerCard).join('');
  }

  const pending = [...state.pendingByWriter.values()].reduce((n, v) => n + v.pending, 0);
  const { words, glyphs } = sampleTotals();
  el('roster-stats').textContent = state.writers.length === 0 ? '' : [
    tn('n.writers', state.writers.length),
    tn('n.words', words),
    tn('n.symbols', glyphs),
    pending > 0 ? t('roster.queued', { n: pending }) : t('roster.allSent'),
  ].join(' · ');
}

/// Words and symbols on this device, over every writer on the roster.
function sampleTotals() {
  let words = 0;
  let glyphs = 0;
  for (const writer of state.writers) {
    const summary = summaryOf(writer.writer_id);
    words += summary.words;
    glyphs += summary.glyphs;
  }
  return { words, glyphs };
}

/// How many tasks this writer's own delivery in `lang` holds, built once and
/// cached — the roster must not re-shuffle ~800 rows on every render.
function deliveryTotalFor(writerID, lang = state.collectLang) {
  const key = `${writerID}:${lang}`;
  const cached = state.deliveryTotals.get(key);
  if (cached !== undefined) return cached;
  const rows = rowsFor(lang);
  if (!rows) return 0;
  const total = buildDelivery(writerID, rows, lang).length;
  state.deliveryTotals.set(key, total);
  return total;
}

/// Same idea for the symbol delivery (≈ 560 tasks with the default repeats).
function glyphDeliveryTotalFor(writerID) {
  if (!state.glyphCorpus) return null;
  const cached = state.glyphDeliveryTotals.get(writerID);
  if (cached !== undefined) return cached;
  const total = buildGlyphDelivery(writerID, state.glyphCorpus).length;
  state.glyphDeliveryTotals.set(writerID, total);
  return total;
}

function progressTrack(title, done, total, tone = '') {
  const percent = total ? clamp(Math.round((done / total) * 100), 0, 100) : 0;
  return `
      <div class="track ${tone}">
        <span class="track-title">${escapeHtml(title)}</span>
        <div class="bar"><span style="width:${percent}%"></span></div>
        <span class="track-count"><b>${done}</b> / ${total ?? '—'}</span>
      </div>`;
}

/// A number inside a localized phrase, bolded: «<b>12</b> слов».
function boldCount(text, n) {
  return escapeHtml(text).replace(String(n), `<b>${n}</b>`);
}

function writerCard(writer) {
  const stats = state.pendingByWriter.get(writer.writer_id) ?? { total: 0, pending: 0 };
  const summary = summaryOf(writer.writer_id);
  const lang = state.collectLang;
  const cursor = wordCursor(writer, lang);
  const total = deliveryTotalFor(writer.writer_id, lang) || rowsFor(lang)?.length || 0;
  const glyphCursor = writer.progress?.glyph_cursor ?? 0;
  const glyphTotal = glyphDeliveryTotalFor(writer.writer_id);
  const finished = writer.progress?.finished_at;
  const words = summary.wordsByLang[lang] ?? 0;
  const goal = GOAL_WORDS[lang];
  const joined = state.community.hasJoined(writer.writer_id, lang);
  const needsAge = writer.consent?.granted && !hasFullConsent(writer);
  const badges = [
    finished ? `<span class="badge done">${escapeHtml(t('card.finished'))}</span>` : '',
    joined ? `<span class="badge joined">${escapeHtml(t('card.joined'))}</span>` : '',
    needsAge ? `<span class="badge warn">${escapeHtml(t('card.confirmAge'))}</span>` : '',
  ].join('');
  return `
    <article class="card writer" data-writer="${escapeHtml(writer.writer_id)}">
      <div class="writer-head">
        <button class="writer-name" data-action="rename">${escapeHtml(writer.label || t('card.noName'))}</button>
        ${badges}
      </div>
      <div class="tracks">
        ${progressTrack(t('card.words'), cursor, total)}
        ${progressTrack(t('card.symbols'), Math.min(glyphCursor, glyphTotal ?? glyphCursor), glyphTotal, 'glyphs')}
      </div>
      <div class="writer-stats">
        <span>${boldCount(tn('n.words', words), words)}</span>
        <span>${boldCount(tn('n.symbols', summary.glyphs), summary.glyphs)}</span>
        ${joined ? '' : `<span>${escapeHtml(t('card.goal', { have: Math.min(goalWordsOf(writer.writer_id, lang), goal), goal }))}</span>`}
        <span class="${stats.pending > 0 ? 'warn' : 'ok'}">${escapeHtml(stats.pending > 0 ? t('roster.queued', { n: stats.pending }) : t('card.sent'))}</span>
      </div>
      <div class="writer-actions">
        <button class="btn primary" data-action="write">${escapeHtml(cursor > 0 ? t('card.continue') : t('card.start'))}</button>
        <button class="btn" data-action="glyphs" ${state.glyphCorpus ? '' : 'disabled'}>${escapeHtml(t('card.glyphs'))}</button>
        <button class="btn" data-action="compose">${escapeHtml(t('card.compose'))}</button>
        <button class="btn" data-action="export">${escapeHtml(t('card.export'))}</button>
        <button class="btn ghost" data-action="finish" ${finished ? 'disabled' : ''}>${escapeHtml(t('card.finish'))}</button>
        <button class="btn ghost danger" data-action="delete">${escapeHtml(t('card.delete'))}</button>
      </div>
      <div class="writer-id">${escapeHtml(writer.writer_id)}</div>
    </article>`;
}

// MARK: - Word cursors per collection language
//
// Russian keeps the fields it always had (`progress.cursor`,
// `written_count`), so every writer from before English still resumes at
// the same word; English has its own pair beside them.

function cursorField(lang) {
  return lang === 'en' ? 'cursor_en' : 'cursor';
}

function wordCursor(writer, lang = state.collectLang) {
  return writer?.progress?.[cursorField(lang)] ?? 0;
}

function advanceWordCursor(writer, { written }, lang = state.collectLang) {
  const field = cursorField(lang);
  writer.progress[field] = (writer.progress[field] ?? 0) + 1;
  if (written) {
    const count = lang === 'en' ? 'written_count_en' : 'written_count';
    writer.progress[count] = (writer.progress[count] ?? 0) + 1;
  }
}

// MARK: - Collection language

function updateCollectToggles() {
  for (const button of document.querySelectorAll('[data-collect-toggle] button[data-value]')) {
    button.setAttribute('aria-pressed', String(button.dataset.value === state.collectLang));
  }
}

/// Switches the words everyone on this page writes. On the writing screen
/// the half-written word is saved as the old language's draft first, and the
/// other language picks up at its own cursor with its own draft.
async function switchCollectLang(next) {
  const lang = normalizeLanguage(next);
  if (lang === state.collectLang || state.saving) { updateCollectToggles(); return; }
  if (!rowsFor(lang)) {
    state.rowsByLang[lang] = await loadCoreRows(lang).catch(() => null);
    if (!rowsFor(lang)) {
      toast(t('collect.enFailed'), true);
      updateCollectToggles();
      return;
    }
  }
  const writing = document.body.dataset.screen === 'write' && state.mode === 'words' && state.active;
  if (writing) await leaveWriting();
  state.collectLang = lang;
  await meta.set('collect_lang', lang);
  updateCollectToggles();
  if (state.active) await activateWriter(state.active.writer_id, { navigate: false });
  if (writing) {
    await openWriting('words');
  } else {
    renderRoster();
  }
}

// MARK: - Community

function communityRound(lang = state.collectLang) {
  return state.community.round(lang, state.writers.map((w) => w.writer_id));
}

/// The roster card and the writing screen's one-liner, from the same figure.
function renderCommunity() {
  const lang = state.collectLang;
  const round = communityRound(lang);
  const percent = clamp(Math.round(round.fraction * 100), 0, 100);
  const card = el('community-card');
  if (card) {
    const next = escapeHtml(t('community.next', { target: round.target }));
    const html = `
      <div class="community-top">
        <span class="community-count">${boldCount(tn('n.people', round.count), round.count)}</span>
        <span class="community-next">${next}</span>
      </div>
      <div class="community-bar" role="progressbar" aria-label="${next}" aria-valuemin="0" aria-valuemax="${round.every}"
           aria-valuenow="${round.count - round.windowStart}"><span style="width:${percent}%"></span></div>
      <p class="community-note">${escapeHtml(t('community.note', { goal: GOAL_WORDS[lang] }))}</p>`;
    // The card is a polite live region and the roster re-renders on every
    // sync event: only a real change may reach it, or a screen reader
    // re-reads the whole card after each upload.
    if (html !== renderedCommunityHTML) {
      card.innerHTML = html;
      renderedCommunityHTML = html;
    }
  }
  renderCommunityMini(round, percent);
}

let renderedCommunityHTML = null;

function renderCommunityMini(round = communityRound(), percent = clamp(Math.round(round.fraction * 100), 0, 100)) {
  const node = el('community-write');
  if (!node) return;
  const writer = state.active;
  if (!writer || state.mode !== 'words') {
    node.hidden = true;
    return;
  }
  const lang = state.collectLang;
  const goal = GOAL_WORDS[lang];
  const mine = state.community.hasJoined(writer.writer_id, lang)
    ? t('community.miniJoined')
    : t('community.miniYou', { have: Math.min(goalWordsOf(writer.writer_id, lang), goal), goal });
  node.hidden = false;
  node.innerHTML = `
    <span class="community-mini-bar" aria-hidden="true"><span style="width:${percent}%"></span></span>
    <span>${escapeHtml([tn('n.peopleShort', round.count), t('community.miniNext', { target: round.target }), mine].join(' · '))}</span>`;
}

/// Called after a word is saved and whenever a writer is opened: the first
/// time a writer with full consent and uploading on has the goal's worth of
/// prompted words in a language, they JOIN — recorded first, then the
/// moment is played and the server is told. Afterwards it only re-announces
/// a writer the server has not confirmed yet (rate-limited in community.js)
/// and replays a moment that a reload interrupted.
async function checkGoal(writer = state.active, lang = state.collectLang) {
  if (!writer || !hasFullConsent(writer) || !sync.enabled) return;
  if (goalWordsOf(writer.writer_id, lang) < GOAL_WORDS[lang]) return;
  // One check at a time per writer and language: a word saved while the
  // numbers are being fetched must not join the writer twice.
  const key = `${writer.writer_id}:${lang}`;
  if (goalChecks.has(key)) return;
  goalChecks.add(key);
  try {
    await joinOrReplay(writer, lang);
  } finally {
    goalChecks.delete(key);
  }
}

const goalChecks = new Set();

async function joinOrReplay(writer, lang) {
  const join = state.community.join(writer.writer_id, lang);
  if (!join) {
    // "Your handwriting is #N" should count from real numbers: give a fetch
    // that is under way (or a first one) a moment, never more.
    await Promise.race([state.community.refresh(), new Promise((resolve) => setTimeout(resolve, 2000))]);
    const before = communityRound(lang).count;
    await state.community.recordJoin(writer.writer_id, lang);
    renderRoster();
    // The announcement runs while the moment plays, not after it.
    pingCommunity(writer, lang);
    await showCelebration({ writer, lang, before, after: before + 1 });
    return;
  }
  pingCommunity(writer, lang);
  if (!join.celebrated) {
    const after = communityRound(lang).count;
    await showCelebration({ writer, lang, before: Math.max(0, after - 1), after });
  }
}

/// Uploads first (the server counts only words that arrived), then tells
/// the `community` function. Best effort and never in the writer's way.
async function pingCommunity(writer, lang) {
  if (!sync.enabled || !sync.isOnline || !hasFullConsent(writer)) return;
  if (!state.community.shouldPing(writer.writer_id, lang)) return;
  try {
    // A drain already under way would make this one return at once; wait
    // for it, then push this writer's queue.
    await sync.whenIdle();
    await sync.drain({ writers: [writer] });
    await state.community.ping(writer.writer_id, lang);
  } catch { /* the next drain retries */ }
}

/// "You're in": the counter ticks from `before` to `after`, the bar moves,
/// confetti falls (all skipped under prefers-reduced-motion). Resolves when
/// dismissed; shown once per writer and language (`celebrated`).
function showCelebration({ writer, lang, before, after }) {
  if (state.celebrating || el('modal-root').classList.contains('is-open')) return Promise.resolve();
  state.celebrating = true;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const every = state.community.every(lang);
  const from = roundFor(before, every);
  const to = roundFor(after, every);
  // Reaching a release fills the bar; the line then names the next one.
  const crossed = to.windowStart > from.windowStart;
  const fromPercent = Math.round(from.fraction * 100);
  const toPercent = crossed ? 100 : Math.round(to.fraction * 100);
  const [numberBefore, numberAfter] = t('celebrate.number', { n: '\u0000' }).split('\u0000');
  const confetti = reduce ? '' : Array.from({ length: 18 }, (_, i) =>
    `<i style="--x:${(i * 53) % 100}%;--d:${(i % 6) * 0.09}s;--h:${(i * 47) % 360};--r:${(i * 83) % 360}deg"></i>`).join('');
  return new Promise((resolve) => {
    const shell = modalShell(`
      <div class="celebrate">
        <div class="celebrate-confetti" aria-hidden="true">${confetti}</div>
        <h2>${escapeHtml(t('celebrate.title'))}</h2>
        <p class="celebrate-number">${escapeHtml(numberBefore)}<b class="celebrate-count">${reduce ? after : before}</b>${escapeHtml(numberAfter ?? '')}</p>
        <div class="community-bar big"><span style="width:${reduce ? toPercent : fromPercent}%"></span></div>
        <p class="celebrate-line"><span class="celebrate-people">${escapeHtml(tn('n.people', reduce ? after : before))}</span> · ${escapeHtml(t('community.next', { target: to.target }))}</p>
        <p class="celebrate-body">${escapeHtml(t('celebrate.body', { goal: GOAL_WORDS[lang] }))}</p>
        <div class="modal-actions">
          <button class="btn primary" data-modal="ok">${escapeHtml(t('celebrate.ok'))}</button>
        </div>
      </div>`);
    const root = shell.root;
    const timers = [];
    // The only way out is the button: keyboard and screen-reader users land
    // on it rather than on the page behind the dialog.
    timers.push(setTimeout(() => root.querySelector('.celebrate [data-modal="ok"]')?.focus({ preventScroll: true }), 60));
    if (!reduce) {
      // Two frames so the starting width is laid out before it moves.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const bar = root.querySelector('.community-bar.big span');
        if (bar) bar.style.width = `${toPercent}%`;
      }));
      timers.push(setTimeout(() => {
        const count = root.querySelector('.celebrate-count');
        const people = root.querySelector('.celebrate-people');
        if (count) {
          count.textContent = String(after);
          count.classList.add('is-ticked');
        }
        if (people) people.textContent = tn('n.people', after);
      }, 650));
    }
    // `#modal-root` outlives every modal: the handler goes with this one, so
    // a later dialog's button can't re-run the dismissal (or close it).
    const onClick = async (event) => {
      if (!event.target.closest('[data-modal]')) return;
      root.removeEventListener('click', onClick);
      for (const timer of timers) clearTimeout(timer);
      shell.close();
      state.celebrating = false;
      await state.community.markCelebrated(writer.writer_id, lang);
      renderCommunity();
      resolve();
    };
    root.addEventListener('click', onClick);
  });
}

// MARK: - Writer lifecycle

async function addWriter() {
  const fallbackName = t('writer.defaultName', { n: state.writers.length + 1 });
  const label = await promptModal({
    title: t('writer.newTitle'),
    message: t('writer.newMessage'),
    placeholder: fallbackName,
    confirm: t('writer.next'),
  });
  if (label === null) return;

  const writer = {
    writer_id: uuidv4(),
    label: label.trim() || fallbackName,
    created_at: Date.now(),
    consent: { granted: false, granted_at: null, text_version: CONSENT_TEXT_VERSION, adult: false },
    input_device: null,
    can_write_cursive: null,
    habitual_script: null,
    task_language: state.collectLang,
    progress: {
      cursor: 0,
      written_count: 0,
      cursor_en: 0,
      written_count_en: 0,
      glyph_cursor: 0,
      glyph_written_count: 0,
      asked_cursive: false,
      asked_habit: false,
      started_at: Date.now(),
      finished_at: null,
    },
  };
  await writerStore.put(writer);
  state.writers = await writerStore.all();
  await refreshPendingCounts();
  renderRoster();
  await activateWriter(writer.writer_id, { navigate: false });
  state.afterConsent = null;
  state.consentBack = 'roster';
  showConsent();
}

async function activateWriter(writerID, { navigate = true } = {}) {
  const writer = await writerStore.get(writerID);
  if (!writer) return;
  state.active = writer;
  await meta.set('active_writer', writerID);
  if (!state.sessionIDs.has(writerID)) state.sessionIDs.set(writerID, uuidv4());

  const lang = state.collectLang;
  state.delivery = buildDelivery(writerID, rowsFor(lang) ?? [], lang);
  state.counts = tierCounts(state.delivery);
  state.deliveryTotals.set(`${writerID}:${lang}`, state.delivery.length);
  state.glyphDelivery = state.glyphCorpus ? buildGlyphDelivery(writerID, state.glyphCorpus) : [];
  if (state.glyphCorpus) state.glyphDeliveryTotals.set(writerID, state.glyphDelivery.length);

  if (navigate) {
    // No word of anyone who hasn't agreed to the current text and confirmed
    // being 18 or older — a writer from before the age question sees the
    // consent screen again, with a note saying why.
    if (!hasFullConsent(writer)) {
      state.afterConsent = null;
      state.consentBack = 'roster';
      showConsent();
    } else {
      await openWriting('words');
    }
  }
}

/// Symbol capture for a writer: the consent screen first when their consent
/// predates the current text (symbols came with 0.2, the age question with
/// 0.3), then straight on to where they were going.
/// `target` = { ids, index, returnTo } for a targeted queue.
async function openGlyphs(writerID, { target = null } = {}) {
  await activateWriter(writerID, { navigate: false });
  if (!state.active) return;
  if (!state.glyphCorpus) {
    state.glyphCorpus = await loadGlyphCorpus().catch(() => null);
    if (!state.glyphCorpus) {
      toast(t('glyph.loadFailed'), true);
      return;
    }
    await activateWriter(writerID, { navigate: false });
  }
  const go = () => openWriting('glyphs', { target });
  if (!hasFullConsent(state.active)) {
    state.afterConsent = go;
    state.consentBack = target ? 'compose' : 'roster';
    showConsent();
    return;
  }
  await go();
}

async function saveActiveWriter() {
  if (!state.active) return;
  await writerStore.put(state.active);
  state.writers = await writerStore.all();
}

// MARK: - Consent

function showConsent() {
  el('consent-writer').textContent = state.active?.label ?? '';
  // Someone who already agreed to an older text is told why they see it
  // again: symbols (texts before 0.2) and/or the age question (before 0.3).
  const granted = state.active?.consent?.granted === true;
  el('consent-update').hidden = !(granted && !consentCovers(state.active, GLYPH_CONSENT_VERSION));
  el('consent-age-update').hidden = !(granted && !hasFullConsent(state.active));
  el('consent-agree').checked = false;
  el('consent-adult').checked = false;
  updateConsentButton();
  renderConsentTexts();
  showScreen('consent');
}

/// The consent screen's dynamic lines, re-run on a language switch.
function renderConsentTexts() {
  el('consent-version-note').textContent = t('consent.version', { v: CONSENT_TEXT_VERSION });
  el('consent-continue').textContent = state.afterConsent ? t('consent.continue') : t('consent.start');
}

/// Both boxes are required: the consent itself and the writer's own
/// confirmation of being 18 or older.
function updateConsentButton() {
  el('consent-continue').disabled = !(el('consent-agree').checked && el('consent-adult').checked);
}

async function grantConsent() {
  if (!state.active) return;
  if (!el('consent-agree').checked || !el('consent-adult').checked) return;
  state.active.consent = {
    granted: true,
    granted_at: Date.now(),
    text_version: CONSENT_TEXT_VERSION,
    adult: true,
  };
  await saveActiveWriter();
  // Words that waited for the age confirmation may leave now.
  sync.drain();
  const next = state.afterConsent;
  state.afterConsent = null;
  if (next) await next();
  else await openWriting('words');
}

async function leaveConsent() {
  const back = state.consentBack;
  state.afterConsent = null;
  state.consentBack = 'roster';
  if (back === 'compose' && state.active) {
    await openCompose(state.active.writer_id);
    return;
  }
  renderRoster();
  showScreen('roster');
}

// MARK: - Writing

/// A corpus category's title in the interface language, for the prompt line
/// (the corpus itself names its categories only by id).
function glyphCategoryTitle(category) {
  const key = `glyphCat.${category}`;
  const title = t(key);
  return title === key ? String(category ?? '') : title;
}

function currentTask() {
  if (state.mode === 'glyphs') return currentGlyphTask();
  return state.delivery[wordCursor(state.active)] ?? null;
}

function currentGlyphTask() {
  if (!state.active) return null;
  if (state.target) {
    if (!state.target.task || state.target.task.index !== state.target.index) {
      const id = state.target.ids[state.target.index];
      state.target.task = id ? { index: state.target.index, value: targetedTask(id) } : { index: state.target.index, value: null };
    }
    return state.target.task.value;
  }
  const cursor = state.active.progress?.glyph_cursor ?? 0;
  return state.glyphDelivery[cursor] ?? null;
}

/// A symbol written out of turn (targeted from the compose screen). Its
/// `order` is the delivery position of this symbol's next occurrence that is
/// still ahead of the cursor and not written yet — the slot this sample
/// fills. The writing screen steps over a filled slot when the cursor gets
/// there, so the writer is never asked for the same occurrence twice and the
/// delivery stays one list with one numbering. With no such slot left (every
/// occurrence already written or skipped) `order` is 0: a free extra sample.
function targetedTask(glyphID) {
  const glyph = state.glyphCorpus?.find((g) => g.id === glyphID);
  if (!glyph) return null;
  const cursor = state.active.progress?.glyph_cursor ?? 0;
  const filled = summaryOf(state.active.writer_id).glyphOrders;
  const slot = state.glyphDelivery.find((t, i) => i >= cursor && t.glyph_id === glyphID && !filled.has(t.order));
  return {
    glyph_id: glyph.id,
    char: glyph.char,
    latex: glyph.latex,
    category: glyph.category,
    round: glyph.round,
    name_ru: glyph.name_ru,
    hint: glyph.hint ?? null,
    task_index: glyph.task_index,
    order: slot?.order ?? 0,
    prompt_id: `${GLYPH_PLAN_VERSION}/${glyph.id}`,
    rep: slot?.rep ?? 0,
    targeted: true,
  };
}

/// Moves the glyph cursor past slots already filled out of turn. Returns
/// true when it moved (the caller persists the writer).
function stepOverFilledGlyphs() {
  const writer = state.active;
  if (!writer || state.target) return false;
  const filled = summaryOf(writer.writer_id).glyphOrders;
  const start = writer.progress.glyph_cursor ?? 0;
  let cursor = start;
  while (state.glyphDelivery[cursor] && filled.has(state.glyphDelivery[cursor].order)) cursor += 1;
  if (cursor === start) return false;
  writer.progress.glyph_cursor = cursor;
  return true;
}

async function persistWriteMode() {
  const target = state.target
    ? { ids: state.target.ids, index: state.target.index, returnTo: state.target.returnTo }
    : null;
  await meta.set('write_mode', { mode: state.mode, target });
}

async function openWriting(mode = 'words', { target = null } = {}) {
  if (!state.active) return;
  state.mode = mode === 'glyphs' ? 'glyphs' : 'words';
  // The writer's collection language is the one they write words in now.
  if (state.mode === 'words' && state.active.task_language !== state.collectLang) {
    state.active.task_language = state.collectLang;
    await saveActiveWriter();
  }
  state.target = state.mode === 'glyphs' && Array.isArray(target?.ids) && target.ids.length > 0
    ? { ids: [...target.ids], index: clamp(target.index ?? 0, 0, target.ids.length), returnTo: target.returnTo ?? 'compose' }
    : null;
  await persistWriteMode();
  showScreen('write');
  if (!state.sheet) {
    state.sheet = new InkSheet(el('ink'), {
      onChange: onInkChange,
      onTouchRejected: warnAboutPalmRejection,
    });
    new ResizeObserver(() => state.sheet.resize()).observe(el('sheet-wrap'));
  }
  // Whatever was on the sheet belongs to nobody until this task is painted
  // and its own draft restored; the clear's autosave must not erase a draft.
  state.sheetOwner = null;
  state.sheet.clear();
  if (!await renderTask()) return;
  renderSyncChip();
  await restoreDraft();
  claimSheet();
  await maybeAskQuestions();
  // A writer who crossed the goal elsewhere (an import, words from before
  // this page counted them) joins here; a moment a reload cut short replays.
  // Not awaited: the celebration resolves only when dismissed, and callers
  // (boot's resume, a collection-language switch) must not wait on a tap —
  // boot still has the upload queue and the service worker to start.
  if (state.mode === 'words') checkGoal().catch(() => { /* the next save retries */ });
}

function claimSheet() {
  state.sheetOwner = state.active
    ? { writer_id: state.active.writer_id, mode: state.mode, targeted: !!state.target }
    : null;
}

/// Leaving the writing screen: the draft is saved for its owner, then the
/// sheet is emptied and disowned, so no later autosave (a hidden tab on the
/// compose screen, a pending debounce) can file this ink under anyone else.
async function leaveWriting() {
  await saveDraft();
  state.sheetOwner = null;
  state.sheet?.clear();
}

/// Paints the prompt for the current task. Returns false when rendering led
/// somewhere else (a finished targeted queue goes back to the compose page).
async function renderTask() {
  el('write-writer').textContent = state.active.label ?? '';
  document.body.dataset.mode = state.mode;
  updateCollectToggles();
  renderCommunityMini();
  if (state.mode === 'glyphs') return renderGlyphTask();

  resetGlyphPrompt();
  const task = currentTask();
  const total = state.delivery.length;
  const cursor = wordCursor(state.active);
  // The word is typeset in its own language (hyphenation, fonts).
  el('prompt-word').lang = state.collectLang;

  if (!task) {
    el('prompt-word').textContent = t('write.allDone');
    el('prompt-word').lang = getLang();
    el('prompt-hint').textContent = t('write.allDoneHint');
    el('write-counter').textContent = `${total} / ${total}`;
    el('progress-fill').style.width = '100%';
    el('btn-save').disabled = true;
    el('btn-skip').disabled = true;
    el('stage-label').textContent = t('write.doneStage');
    return true;
  }

  el('prompt-word').textContent = task.text;
  el('prompt-hint').innerHTML = hintFor(task);
  el('write-counter').textContent = `${cursor + 1} / ${total}`;
  el('progress-fill').style.width = `${((cursor) / total) * 100}%`;
  // Ярус — это обещание писателю: дойдя до конца «Ядра 300», человек уже
  // покрыл весь алфавит, так что показывать позицию внутри яруса важнее,
  // чем абсолютный номер задания.
  const inTier = state.delivery
    .slice(0, cursor)
    .filter((row) => row.word_group === task.word_group).length + 1;
  el('stage-label').textContent = t('write.stage', {
    group: groupTitle(task.word_group, getLang()),
    n: inTier,
    total: state.counts[task.word_group] ?? '?',
    packet: task.packet,
    inPacket: (cursor % PACKET_SIZE) + 1,
    packetSize: PACKET_SIZE,
  });
  el('btn-skip').disabled = false;
  onInkChange();
  return true;
}

async function renderGlyphTask() {
  // Ids that no longer exist in the corpus are passed over, not shown empty.
  while (state.target && !currentGlyphTask() && state.target.index < state.target.ids.length) {
    state.target.index += 1;
  }
  if (stepOverFilledGlyphs()) await saveActiveWriter();

  const task = currentGlyphTask();
  if (state.target && !task) {
    await finishTargeted();
    return false;
  }

  const total = state.glyphDelivery.length;
  const cursor = state.active.progress.glyph_cursor ?? 0;
  el('sheet-hint').textContent = t('write.sheetGlyph');
  el('template-toggle').hidden = false;
  el('opt-template').checked = state.templateOn;
  el('prompt-word').lang = getLang();

  if (!task) {
    resetGlyphPrompt({ keepToggle: true });
    el('prompt-word').textContent = t('glyph.allDone');
    el('prompt-hint').textContent = t('glyph.allDoneHint');
    el('write-counter').textContent = `${total} / ${total}`;
    el('progress-fill').style.width = '100%';
    el('btn-save').disabled = true;
    el('btn-skip').disabled = true;
    el('stage-label').textContent = t('glyph.doneStage');
    applyTemplate();
    return true;
  }

  renderGlyphPrompt(task);
  if (state.target) {
    const n = state.target.ids.length;
    const i = state.target.index;
    el('write-counter').textContent = `${i + 1} / ${n}`;
    el('progress-fill').style.width = `${(i / n) * 100}%`;
    el('stage-label').textContent = t('glyph.targetStage', { i: i + 1, n });
  } else {
    el('write-counter').textContent = `${cursor + 1} / ${total}`;
    el('progress-fill').style.width = `${(cursor / total) * 100}%`;
    el('stage-label').textContent = t('glyph.stage', { round: task.round, rep: task.rep, i: cursor + 1, total });
  }
  el('btn-skip').disabled = false;
  applyTemplate();
  onInkChange();
  return true;
}

let glyphPromptToken = 0;

/// The symbol, big, exactly as KaTeX typesets it — the writer should see the
/// form a textbook uses, not a system-font lookalike. KaTeX is imported only
/// here, on the first symbol; until it arrives (and for text-mode symbols:
/// Cyrillic, «», №…) the plain character stands in.
function renderGlyphPrompt(task) {
  const big = el('prompt-word');
  big.classList.add('is-glyph');
  big.textContent = task.char;
  const token = ++glyphPromptToken;
  const textOnly = /^\\text\b/.test(task.latex ?? '') || String(task.category).startsWith('cyrillic');
  if (!textOnly) {
    import('./mathlayout.js')
      .then((m) => m.ensureKatex())
      .then((katex) => {
        if (token !== glyphPromptToken) return;
        try {
          katex.render(task.latex, big, { throwOnError: false, displayMode: false, strict: 'ignore', output: 'html' });
        } catch {
          big.textContent = task.char;
        }
      })
      .catch(() => { /* offline without the cache: the plain char stays */ });
  }

  const showLatex = !textOnly && task.latex && task.latex !== task.char;
  // The corpus names and describes its symbols in Russian only
  // (`name_ru`, `hint`); in English the prompt shows the symbol itself or
  // its LaTeX, and an English category title.
  const russian = getLang() === 'ru';
  el('prompt-hint').innerHTML = [
    russian ? `<b>${escapeHtml(task.name_ru ?? task.char)}</b>` : (showLatex ? '' : `<b>${escapeHtml(task.char)}</b>`),
    showLatex ? `<code class="mono">${escapeHtml(task.latex)}</code>` : '',
    escapeHtml(glyphCategoryTitle(task.category)),
  ].filter(Boolean).join(' · ');

  const notes = [];
  if (task.hint && russian) notes.push(escapeHtml(task.hint));
  if (task.rep > 1 && !task.targeted) notes.push(escapeHtml(t('glyph.repeat')));
  const note = el('prompt-note');
  note.innerHTML = notes.join(' · ');
  note.hidden = notes.length === 0;
}

function resetGlyphPrompt({ keepToggle = false } = {}) {
  glyphPromptToken += 1;
  el('prompt-word').classList.remove('is-glyph');
  el('prompt-note').hidden = true;
  el('prompt-note').textContent = '';
  if (!keepToggle) {
    el('template-toggle').hidden = true;
    el('sheet-hint').textContent = t('write.sheetWord');
    state.sheet?.setTemplate(null);
  }
}

/// The faint reference symbol on the sheet (display only — ink.js keeps it
/// out of every recorded coordinate).
function applyTemplate() {
  if (!state.sheet) return;
  const task = state.mode === 'glyphs' ? currentGlyphTask() : null;
  if (!task || !state.templateOn) {
    state.sheet.setTemplate(null);
    return;
  }
  const glyph = { char: task.char, latex: task.latex, category: task.category };
  state.sheet.setTemplate((ctx, { width, height }) => drawGlyphTemplate(ctx, glyph, {
    canvasW: width,
    canvasH: height,
    onReady: () => state.sheet?.redraw(),
  }));
}

async function finishTargeted() {
  const returnTo = state.target?.returnTo ?? 'compose';
  // The targeted draft key, taken while the run is still targeted.
  const key = draftKey();
  state.sheetOwner = null;
  state.target = null;
  state.sheet?.setTemplate(null);
  await meta.remove(key);
  await meta.set('write_mode', { mode: 'glyphs', target: null });
  toast(t('glyph.filled'));
  if (returnTo === 'compose' && state.active) {
    await openCompose(state.active.writer_id);
  } else {
    renderRoster();
    showScreen('roster');
  }
}

/// Dictionary markup (`<b>`) plus escaped plain phrases.
function hintFor(task) {
  const parts = [];
  parts.push(task.starts_with_uppercase ? t('write.upper') : t('write.lower'));
  if (task.is_exact_repeat) parts.push(escapeHtml(t('write.repeat')));
  if (task.is_case_pair) parts.push(escapeHtml(t('write.casePair')));
  return parts.join(' · ');
}

let palmWarned = false;
function warnAboutPalmRejection() {
  if (palmWarned) return;
  palmWarned = true;
  toast(t('write.palm'));
}

function onInkChange() {
  const empty = state.sheet?.isEmpty !== false;
  el('btn-save').disabled = empty || !currentTask();
  el('btn-undo').disabled = empty;
  el('btn-clear').disabled = empty;
  el('sheet-hint').classList.toggle('is-hidden', !empty);
  // How densely this particular device actually samples the pen. It is the
  // one number that can't be promised in advance — it depends on the browser,
  // the stylus and whether coalesced events are supported — so it is measured
  // and shown instead.
  const stats = el('ink-stats');
  if (stats) {
    const rate = state.sheet?.sampleRate ?? 0;
    stats.textContent = empty ? '' :
      `${tn('n.points', state.sheet.pointCount)}${rate > 0 ? ` · ${t('write.hz', { hz: rate })}` : ''}`;
  }
  scheduleDraftSave();
}

// MARK: Drafts — a reload mid-word must not cost the word

const scheduleDraftSave = debounce(() => { saveDraft(); }, 400);

/// Russian words keep the key they always had, so a draft written before
/// symbols (or English) existed still restores; English words have their
/// own, symbols theirs, and a targeted run yet another — it must leave the
/// half-written symbol at the cursor alone.
function draftKey(writerID = state.active?.writer_id) {
  if (state.mode !== 'glyphs') return state.collectLang === 'en' ? `draft:${writerID}:en` : `draft:${writerID}`;
  return state.target ? `draft:${writerID}:glyphs:target` : `draft:${writerID}:glyphs`;
}

/// True when the sheet's ink belongs to the writer, mode and run that
/// `currentTask()` / `draftKey()` describe right now.
function sheetIsActive() {
  const owner = state.sheetOwner;
  return !!owner && document.body.dataset.screen === 'write' &&
    owner.writer_id === state.active?.writer_id &&
    owner.mode === state.mode && owner.targeted === !!state.target;
}

async function saveDraft() {
  const writer = state.active;
  // Mid-save the cursor has already moved while the sheet still shows the
  // saved ink; that ink is no draft of the next task.
  if (state.saving || !sheetIsActive()) return;
  const task = currentTask();
  if (!writer || !task || !state.sheet) return;
  const draft = state.sheet.draftState();
  if (!draft) {
    await meta.remove(draftKey());
    return;
  }
  const identity = state.mode === 'glyphs'
    ? { order: task.order, glyph_id: task.glyph_id }
    : { order: task.order };
  await meta.set(draftKey(), { ...identity, ...draft });
}

async function restoreDraft() {
  const writer = state.active;
  const task = currentTask();
  if (!writer || !task) return;
  const draft = await meta.get(draftKey(), null);
  if (!draft || draft.order !== task.order) return;
  if (state.mode === 'glyphs' && draft.glyph_id !== task.glyph_id) return;
  state.sheet.resize();
  // The draft carries the space it was recorded in; the sheet keeps those
  // coordinates and fits them to the current box for display only, so a
  // reload on a differently sized screen cannot rewrite recorded geometry.
  state.sheet.restore(draft);
  toast(state.mode === 'glyphs' ? t('write.draftGlyph') : t('write.draftWord'));
}

// MARK: Saving a sample

/// The task half of a sample. Words are exactly what they always were; a
/// symbol is the same record with its own prompt, group and three extra
/// fields (SPEC «Samples for glyphs»).
function taskFields(task) {
  if (state.mode !== 'glyphs') {
    // `prompt_id` is '<plan>/<task_index>' of the task's own language
    // ('ru_core_v1/…' | 'en_core_v1/…', tasks.js).
    return {
      label: task.text,
      prompt_id: task.prompt_id,
      language: normalizeLanguage(task.language),
      is_dictionary_word: true,
      sample_type: 'prompted_word',
      task_index: task.task_index,
      word_group: task.word_group,
      order: task.order,
    };
  }
  const fields = {
    label: task.char,
    prompt_id: task.prompt_id,
    language: 'math',
    is_dictionary_word: false,
    sample_type: 'prompted_glyph',
    task_index: task.task_index,
    word_group: 'math_glyph',
    order: task.order,
    glyph_id: task.glyph_id,
    latex: task.latex,
    glyph_category: task.category,
  };
  // Written out of turn: its `order` names a slot still ahead of the cursor,
  // so imports must not treat it as progress (exchange.importFile).
  if (task.targeted) fields.glyph_targeted = true;
  return fields;
}

async function saveSample() {
  if (state.saving) return;
  const writer = state.active;
  const task = currentTask();
  const capture = state.sheet?.capture();
  if (!writer || !task || !capture) return;
  state.saving = true;
  el('btn-save').disabled = true;
  let stayed = false;
  try {
    stayed = await storeSample(writer, task, capture);
  } finally {
    endSaving();
  }
  if (stayed) await maybeAskQuestions();
  // After the questions (both are modals): the word that reached the goal
  // gets its moment.
  if (stayed && state.mode === 'words') await checkGoal(writer);
}

/// Re-enables the writing controls after a save/skip, from the sheet as it
/// is now (a failed save leaves the ink there to try again).
function endSaving() {
  state.saving = false;
  if (document.body.dataset.screen !== 'write' || !state.sheetOwner) return;
  el('btn-skip').disabled = !currentTask();
  onInkChange();
}

/// Returns false when the writer is no longer on the writing screen (the last
/// symbol of a targeted run took them back to the compose page).
async function storeSample(writer, task, capture) {
  const fields = taskFields(task);

  const sample = {
    schema_version: 'noto-0.1',
    sample_id: uuidv4(),
    writer_id: writer.writer_id,
    session_id: state.sessionIDs.get(writer.writer_id),
    label: fields.label,
    label_source: 'prompt',
    prompt_id: fields.prompt_id,
    recognition_confidence: null,
    recognition_engine: null,
    language: fields.language,
    is_dictionary_word: fields.is_dictionary_word,
    translation: null,
    pointer_type: capture.pointer_type,
    canvas_w: capture.canvas_w,
    canvas_h: capture.canvas_h,
    dpr: capture.dpr,
    baseline_y: capture.baseline_y,
    sample_type: fields.sample_type,
    task_index: fields.task_index,
    word_group: fields.word_group,
    order: fields.order,
    created_at: Date.now(),
    duration_ms: capture.duration_ms,
    is_correction: false,
    app_version: APP_VERSION,
    strokes: capture.strokes,
    sync: 'pending',
  };
  for (const key of ['glyph_id', 'latex', 'glyph_category', 'glyph_targeted']) {
    if (key in fields) sample[key] = fields[key];
  }

  await sampleStore.put(sample);
  noteSampleSaved(sample);
  state.compose?.invalidate(writer.writer_id);

  // The writer's input device is what they actually wrote with, recorded once.
  if (!writer.input_device) {
    writer.input_device = capture.pointer_type === 'pen' ? 'stylus' : 'finger';
  }
  if (state.mode === 'glyphs') {
    if (state.target) state.target.index += 1;
    else writer.progress.glyph_cursor = (writer.progress.glyph_cursor ?? 0) + 1;
    writer.progress.glyph_written_count = (writer.progress.glyph_written_count ?? 0) + 1;
  } else {
    advanceWordCursor(writer, { written: true }, fields.language);
  }
  await saveActiveWriter();
  await meta.remove(draftKey());
  if (state.target) await persistWriteMode();

  state.sheet.clear();
  // False when the last symbol of a targeted run was just written and the
  // writer is already back on the compose page — the upload still goes out.
  const stayed = await renderTask();
  await refreshPendingCounts();
  renderSyncChip();
  sync.drain();
  return stayed;
}

async function skipTask() {
  if (state.saving) return;
  const writer = state.active;
  if (!writer || !currentTask()) return;
  state.saving = true;
  el('btn-skip').disabled = true;
  let stayed = false;
  try {
    if (state.mode === 'glyphs') {
      if (state.target) state.target.index += 1;
      else writer.progress.glyph_cursor = (writer.progress.glyph_cursor ?? 0) + 1;
    } else {
      advanceWordCursor(writer, { written: false });
    }
    await saveActiveWriter();
    await meta.remove(draftKey());
    if (state.target) await persistWriteMode();
    state.sheet.clear();
    stayed = await renderTask();
  } finally {
    endSaving();
  }
  if (stayed) await maybeAskQuestions();
}

// MARK: Profile questions

async function maybeAskQuestions() {
  const writer = state.active;
  if (!writer) return;
  // The questions describe the WORD run that follows; a symbol session
  // neither triggers them nor gets interrupted by them.
  if (state.mode !== 'words' || document.body.dataset.screen !== 'write') return;
  if (wordCursor(writer) < STYLE_QUESTIONS_AT) return;

  if (!writer.progress.asked_cursive) {
    const answer = await choiceModal({
      title: t('q.cursiveTitle'),
      message: t('q.cursiveMessage'),
      options: [
        { value: 'fluent', label: t('q.fluent') },
        { value: 'rusty', label: t('q.rusty') },
        { value: 'no', label: t('q.no') },
      ],
    });
    writer.progress.asked_cursive = true;
    if (answer) writer.can_write_cursive = answer;
    await saveActiveWriter();
    return;
  }

  if (!writer.progress.asked_habit) {
    const answer = await choiceModal({
      title: t('q.habitTitle'),
      message: t('q.habitMessage'),
      options: [
        { value: 'print_only', label: t('q.printOnly') },
        { value: 'cursive_only', label: t('q.cursiveOnly') },
        { value: 'combined', label: t('q.combined') },
        { value: 'both', label: t('q.both') },
      ],
    });
    writer.progress.asked_habit = true;
    if (answer) writer.habitual_script = answer;
    await saveActiveWriter();
  }
}

// MARK: - Finish / delete / rename

async function finishWriter(writerID) {
  const writer = await writerStore.get(writerID);
  if (!writer) return;
  const stats = state.pendingByWriter.get(writerID) ?? { total: 0, pending: 0 };
  const confirmed = await confirmModal({
    title: t('finish.title'),
    message: t('finish.message', {
      name: writer.label,
      queued: stats.pending > 0 ? t('finish.queued', { n: stats.pending }) : '',
    }),
    confirm: t('finish.confirm'),
  });
  if (!confirmed) return;

  writer.progress.finished_at = Date.now();
  await writerStore.put(writer);
  if (state.active?.writer_id === writerID) state.active = writer;

  await sync.drain({ writers: [writer] });
  await sync.retire(writer);
  state.writers = await writerStore.all();
  await refreshPendingCounts();
  renderRoster();
  toast(t('finish.done'));
}

async function deleteWriter(writerID) {
  const writer = await writerStore.get(writerID);
  if (!writer) return;
  const stats = state.pendingByWriter.get(writerID) ?? { total: 0, pending: 0 };
  const summary = summaryOf(writerID);
  const what = t('delete.what', { words: tn('n.words', summary.words), symbols: tn('n.symbols', summary.glyphs) });
  const confirmed = await confirmModal({
    title: t('delete.title', { name: writer.label }),
    message: stats.pending > 0
      ? t('delete.pending', { what, pending: stats.pending })
      : t('delete.message', { what }),
    confirm: t('delete.confirm'),
    destructive: true,
  });
  if (!confirmed) return;

  await writerStore.remove(writerID);
  state.summaries.delete(writerID);
  state.community.forget(writerID);
  state.compose?.invalidate(writerID);
  if (state.active?.writer_id === writerID) {
    state.active = null;
    await meta.remove('active_writer');
  }
  state.writers = await writerStore.all();
  await refreshPendingCounts();
  renderRoster();
}

async function renameWriter(writerID) {
  const writer = await writerStore.get(writerID);
  if (!writer) return;
  const label = await promptModal({
    title: t('rename.title'),
    message: t('rename.message'),
    value: writer.label ?? '',
    confirm: t('rename.save'),
  });
  if (label === null) return;
  writer.label = label.trim() || writer.label;
  await writerStore.put(writer);
  if (state.active?.writer_id === writerID) state.active = writer;
  state.writers = await writerStore.all();
  renderRoster();
}

// MARK: - Export / import

async function runExport(writerID) {
  try {
    const file = writerID ? await exportWriter(writerID) : await exportAll();
    if (file.envelope.sample_count === 0) {
      toast(t('export.nothing'));
      return;
    }
    const result = await deliver(file, { preferShare: isIOS() });
    if (result.method !== 'cancelled') {
      toast(t('export.file', { name: file.name, size: formatBytes(result.bytes, getLang()) }));
    }
  } catch (error) {
    toast(t('export.failed', { error: error.message }), true);
  }
}

async function runImport(file) {
  try {
    const result = await importFile(file);
    state.writers = await writerStore.all();
    await refreshPendingCounts();
    await state.community.loadJoins(state.writers.map((w) => w.writer_id));
    state.compose?.invalidate();
    // The active writer's cursors may have moved under the open session.
    if (state.active) state.active = await writerStore.get(state.active.writer_id) ?? state.active;
    renderRoster();
    await renderSettings();
    toast(t('import.done', { writers: tn('n.writers', result.writersAdded), samples: tn('n.samples', result.samplesAdded) }));
    sync.drain();
  } catch (error) {
    toast(t('import.failed', { error: error.message }), true);
  }
}

// MARK: - Settings

async function renderSettings() {
  el('opt-upload').checked = sync.enabled;
  el('opt-model-url').value = await meta.get('text_model_url', '') ?? '';
  const estimate = await storageEstimate();
  const pending = await sampleStore.pendingCount();
  const { words, glyphs } = sampleTotals();
  const lang = getLang();
  const row = (key, value, mono = false) =>
    `<div><span>${escapeHtml(t(key))}</span><b${mono ? ' class="mono"' : ''}>${escapeHtml(value)}</b></div>`;
  el('settings-stats').innerHTML = [
    row('stats.writers', state.writers.length),
    row('stats.words', words),
    row('stats.symbols', glyphs),
    row('stats.unsent', pending),
    row('stats.storage', formatBytes(estimate.usage ?? 0, lang)),
    row('stats.lastUpload', formatDate(sync.lastSuccessAt, lang)),
    row('stats.server', new URL(SERVER.projectURL).host, true),
    row('stats.version', APP_VERSION, true),
  ].join('');
}

// MARK: - Sync chip

let syncWasRunning = false;

/// The chip follows every sync event; when a drain ends, the per-writer
/// «в очереди / отправлено» counts are re-read so the roster doesn't keep
/// showing a queue that has already left.
async function onSyncChange() {
  renderSyncChip();
  const finished = syncWasRunning && !sync.running;
  syncWasRunning = sync.running;
  if (!finished) return;
  await refreshPendingCounts();
  renderSyncChip();
  if (document.body.dataset.screen === 'roster') renderRoster();
  // A joined writer whose queue just emptied is announced again, so the
  // server — which counts only words that arrived — can confirm them.
  for (const writer of state.writers) {
    if ((state.pendingByWriter.get(writer.writer_id)?.pending ?? 0) > 0) continue;
    for (const lang of ['ru', 'en']) {
      if (state.community.shouldPing(writer.writer_id, lang)) pingCommunity(writer, lang);
    }
  }
}

function renderSyncChip() {
  const chip = el('sync-chip');
  if (!chip) return;
  let text;
  let tone = 'ok';
  if (!sync.enabled) {
    text = t('sync.localOnly');
    tone = 'muted';
  } else if (!sync.isOnline) {
    text = t('sync.offlineQueued');
    tone = 'warn';
  } else if (sync.running) {
    text = sync.progress ? t('sync.sending', { sent: sync.progress.sent, total: sync.progress.total }) : t('sync.sendingPlain');
    tone = 'busy';
  } else if (sync.lastError) {
    text = sync.lastError;
    tone = 'warn';
  } else {
    const stats = state.active ? state.pendingByWriter.get(state.active.writer_id) : null;
    text = stats && stats.pending > 0 ? t('sync.queued', { n: stats.pending }) : t('sync.synced');
  }
  chip.textContent = text;
  chip.dataset.tone = tone;
}

// MARK: - Chrome wiring

/// Whatever is on screen, re-worded after a RU/EN switch (i18n.js has
/// already re-applied the static text).
function onLangChange() {
  renderRoster();
  renderSyncChip();
  const screen = document.body.dataset.screen;
  if (screen === 'write' && state.active && !state.saving) renderTask();
  if (screen === 'consent') renderConsentTexts();
  if (screen === 'settings') renderSettings();
  state.compose?.relocalize?.();
}

function bindChrome() {
  bindLangToggles();
  window.addEventListener('langchange', onLangChange);
  for (const group of document.querySelectorAll('[data-collect-toggle]')) {
    group.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (button) switchCollectLang(button.dataset.value);
    });
  }
  el('btn-add-writer').addEventListener('click', addWriter);
  el('btn-settings').addEventListener('click', async () => {
    await renderSettings();
    showScreen('settings');
  });
  el('btn-settings-back').addEventListener('click', async () => {
    await refreshPendingCounts();
    renderRoster();
    showScreen('roster');
    state.community.refresh();
  });

  el('writer-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const writerID = button.closest('[data-writer]')?.dataset.writer;
    if (!writerID) return;
    switch (button.dataset.action) {
      case 'write': await activateWriter(writerID); break;
      case 'glyphs': await openGlyphs(writerID); break;
      case 'compose': await openCompose(writerID); break;
      case 'export': await runExport(writerID); break;
      case 'finish': await finishWriter(writerID); break;
      case 'delete': await deleteWriter(writerID); break;
      case 'rename': await renameWriter(writerID); break;
    }
  });

  el('consent-agree').addEventListener('change', updateConsentButton);
  el('consent-adult').addEventListener('change', updateConsentButton);
  el('consent-continue').addEventListener('click', grantConsent);
  el('consent-cancel').addEventListener('click', leaveConsent);

  el('btn-back').addEventListener('click', async () => {
    await leaveWriting();
    // Leaving a targeted run returns to the page it was started from; the
    // symbols written so far are already saved and the page re-renders.
    if (state.target && state.active) {
      const returnTo = state.target.returnTo;
      state.target = null;
      await meta.set('write_mode', { mode: 'glyphs', target: null });
      if (returnTo === 'compose') {
        await openCompose(state.active.writer_id);
        return;
      }
    }
    await refreshPendingCounts();
    renderRoster();
    showScreen('roster');
    state.community.refresh();
  });
  el('opt-template').addEventListener('change', (event) => {
    state.templateOn = event.target.checked;
    meta.set('glyph_template', state.templateOn);
    applyTemplate();
  });

  el('compose-back').addEventListener('click', async () => {
    await state.compose?.flush();
    await refreshPendingCounts();
    renderRoster();
    showScreen('roster');
  });

  el('opt-model-url').addEventListener('change', async (event) => {
    const url = event.target.value.trim();
    if (url && !/^https?:\/\//i.test(url)) {
      toast(t('model.badUrl'), true);
      return;
    }
    await meta.set('text_model_url', url);
    state.compose?.setModelURL(url);
    toast(url ? t('model.saved') : t('model.off'));
  });
  el('btn-save').addEventListener('click', saveSample);
  el('btn-skip').addEventListener('click', skipTask);
  el('btn-undo').addEventListener('click', () => state.sheet?.undo());
  el('btn-clear').addEventListener('click', () => state.sheet?.clear());
  el('sync-chip').addEventListener('click', () => sync.drain());

  el('opt-upload').addEventListener('change', (event) => sync.setEnabled(event.target.checked));
  el('btn-export-all').addEventListener('click', () => runExport(null));
  el('btn-import').addEventListener('click', () => el('import-file').click());
  el('import-file').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) runImport(file);
    event.target.value = '';
  });
  el('btn-resend').addEventListener('click', async () => {
    if (!await confirmModal({
      title: t('resend.title'),
      message: t('resend.message'),
      confirm: t('resend.confirm'),
    })) return;
    for (const writer of state.writers) await sampleStore.requeueForWriter(writer.writer_id);
    await refreshPendingCounts();
    await renderSettings();
    sync.drain();
    toast(t('resend.done'));
  });
  el('btn-wipe').addEventListener('click', async () => {
    if (!await confirmModal({
      title: t('wipe.title'),
      message: t('wipe.message'),
      confirm: t('wipe.confirm'),
      destructive: true,
    })) return;
    if (!await confirmModal({
      title: t('wipe.sureTitle'),
      message: t('wipe.sureMessage'),
      confirm: t('wipe.sureConfirm'),
      destructive: true,
    })) return;
    await wipeEverything();
    // `wipeEverything` cleared `meta` too; the page's languages live in
    // memory and localStorage and carry on.
    await meta.set('collect_lang', state.collectLang);
    state.writers = [];
    state.active = null;
    state.summaries.clear();
    state.community.forgetAll();
    state.compose?.invalidate();
    await refreshPendingCounts();
    renderRoster();
    await renderSettings();
    showScreen('roster');
  });

  window.addEventListener('resize', () => state.sheet?.resize());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveDraft();
    } else {
      requestWakeLock();
      sync.drain();
    }
  });
  window.addEventListener('pagehide', () => { saveDraft(); });
}

// MARK: - Решение почерком

/// Opens the compose screen for a writer. Its module (and with it the
/// compositor and, on first render, KaTeX) is imported only now.
async function openCompose(writerID) {
  if (!writerID) return;
  if (state.active?.writer_id !== writerID) await activateWriter(writerID, { navigate: false });
  if (!state.active) return;
  // The page is built from the writer's collected ink: 18+ like the rest.
  if (!hasFullConsent(state.active)) {
    state.afterConsent = () => openCompose(writerID);
    state.consentBack = 'roster';
    showConsent();
    return;
  }
  try {
    if (!state.compose) {
      const { createComposeUI } = await import('./compose-ui.js');
      state.compose = createComposeUI({
        toast,
        isIOS,
        corpus: () => state.glyphCorpus,
        onFillMissing: (ids) => {
          if (state.active) openGlyphs(state.active.writer_id, { target: { ids, index: 0, returnTo: 'compose' } });
        },
      });
    }
  } catch (error) {
    toast(t('compose.openFailed', { error: error?.message ?? error }), true);
    return;
  }
  showScreen('compose');
  await state.compose.open(state.active);
}

// MARK: - Wake lock
//
// A collection run is dozens of minutes of writing with no taps on the page
// chrome, which is exactly the pattern that lets a tablet dim and lock.

let wakeLock = null;

async function requestWakeLock() {
  if (document.body.dataset.screen !== 'write') return;
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* denied or unsupported — not fatal */ }
}

function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* already gone */ }
  wakeLock = null;
}

// MARK: - Modals and toasts

function modalShell(html) {
  const root = el('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  root.classList.add('is-open');
  return {
    root,
    close() {
      root.classList.remove('is-open');
      root.innerHTML = '';
    },
  };
}

function confirmModal({ title, message, confirm = t('modal.ok'), destructive = false }) {
  return new Promise((resolve) => {
    const shell = modalShell(`
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="btn ghost" data-modal="cancel">${escapeHtml(t('modal.cancel'))}</button>
        <button class="btn ${destructive ? 'danger-solid' : 'primary'}" data-modal="ok">${escapeHtml(confirm)}</button>
      </div>`);
    shell.root.addEventListener('click', (event) => {
      const action = event.target.closest('[data-modal]')?.dataset.modal;
      if (!action) return;
      shell.close();
      resolve(action === 'ok');
    });
  });
}

function promptModal({ title, message, value = '', placeholder = '', confirm = t('modal.ok') }) {
  return new Promise((resolve) => {
    const shell = modalShell(`
      <h2>${escapeHtml(title)}</h2>
      ${message ? `<p>${escapeHtml(message)}</p>` : ''}
      <input type="text" id="modal-input" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"
             autocomplete="off" autocapitalize="words" enterkeyhint="done">
      <div class="modal-actions">
        <button class="btn ghost" data-modal="cancel">${escapeHtml(t('modal.cancel'))}</button>
        <button class="btn primary" data-modal="ok">${escapeHtml(confirm)}</button>
      </div>`);
    const input = el('modal-input');
    setTimeout(() => input?.focus(), 50);
    const finish = (ok) => {
      const text = input?.value ?? '';
      shell.close();
      resolve(ok ? text : null);
    };
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
    });
    shell.root.addEventListener('click', (event) => {
      const action = event.target.closest('[data-modal]')?.dataset.modal;
      if (action) finish(action === 'ok');
    });
  });
}

function choiceModal({ title, message, options }) {
  return new Promise((resolve) => {
    const shell = modalShell(`
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="choice-list">
        ${options.map((o) => `<button class="btn choice" data-choice="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn ghost" data-choice="">${escapeHtml(t('modal.skip'))}</button>
      </div>`);
    shell.root.addEventListener('click', (event) => {
      const button = event.target.closest('[data-choice]');
      if (!button) return;
      shell.close();
      resolve(button.dataset.choice || null);
    });
  });
}

let toastTimer = null;
function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.dataset.tone = isError ? 'error' : 'ok';
  node.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 3200);
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

boot();
