// The collection app itself: roster → consent → guided writing → export.
//
// Everything is local-first. A sample is durable in IndexedDB the instant it
// is saved; the network is an afterthought that drains a queue when it can.
// A reload at any moment — including mid-word — resumes exactly where it was.

import { uuidv4, escapeHtml, formatBytes, formatDate, debounce, clamp } from './util.js';
import { writers as writerStore, samples as sampleStore, meta, requestPersistence, storageEstimate, wipeEverything } from './store.js';
import { loadCoreRows, buildDelivery, tierCounts, GROUP_TITLES, PACKET_SIZE } from './tasks.js';
import { InkSheet } from './ink.js';
import { SyncEngine, SERVER } from './sync.js';
import { exportWriter, exportAll, deliver, importFile, APP_VERSION } from './exchange.js';

const CONSENT_TEXT_VERSION = '0.1';
/// Task number the profile questions are hung off: late enough that the writer
/// has settled in, early enough that the answers describe the run that follows.
const STYLE_QUESTIONS_AT = 12;

const state = {
  rows: [],
  writers: [],
  active: null,
  delivery: [],
  counts: {},
  sessionIDs: new Map(),
  sheet: null,
  pendingByWriter: new Map(),
  /// Delivery length per writer. It is not simply 759: repeats whose original
  /// landed too close to the tail are dropped, and how many that is varies
  /// with the shuffle, so each writer's own total is what their progress is
  /// measured against.
  deliveryTotals: new Map(),
};

const sync = new SyncEngine();

const el = (id) => document.getElementById(id);

// MARK: - Boot

async function boot() {
  try {
    await sync.loadSettings();
    sync.addEventListener('change', renderSyncChip);

    state.rows = await loadCoreRows();
    state.writers = await writerStore.all();
    await refreshPendingCounts();

    const activeID = await meta.get('active_writer', null);
    // Читается до первого showScreen: тот сам пишет `last_screen`, и после
    // него подсказка о прерванной сессии была бы уже затёрта.
    const resumeScreen = await meta.get('last_screen', null);
    if (activeID && state.writers.some((w) => w.writer_id === activeID)) {
      await activateWriter(activeID, { navigate: false });
    }

    bindChrome();
    renderRoster();
    showScreen('roster');
    el('boot').remove();

    // Перезагрузка посреди сессии не должна выкидывать в список: если человек
    // писал — он возвращается к тому же слову, вместе с недописанными штрихами.
    if (resumeScreen === 'write' && state.active?.consent?.granted) {
      await openWriting();
    }

    requestPersistence();
    sync.drain();
    registerServiceWorker();
  } catch (error) {
    const boot = el('boot');
    if (boot) {
      boot.innerHTML = `<div class="boot-error"><b>Не удалось запустить</b><p>${escapeHtml(error?.message ?? error)}</p></div>`;
    }
  }
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
  meta.set('last_screen', name === 'write' ? 'write' : 'roster');
  if (name === 'write') {
    requestAnimationFrame(() => state.sheet?.resize());
    requestWakeLock();
  } else {
    releaseWakeLock();
  }
}

// MARK: - Roster

async function refreshPendingCounts() {
  state.pendingByWriter = new Map();
  for (const writer of state.writers) {
    state.pendingByWriter.set(writer.writer_id, {
      total: await sampleStore.countForWriter(writer.writer_id),
      pending: await sampleStore.pendingCountForWriter(writer.writer_id),
    });
  }
}

function renderRoster() {
  const list = el('writer-list');
  if (state.writers.length === 0) {
    list.innerHTML = `<div class="empty">
      <p>Пока нет ни одного писателя.</p>
      <p class="muted">Каждый человек, который пишет на этом устройстве, — отдельный писатель со своим набором слов и своим прогрессом.</p>
    </div>`;
  } else {
    list.innerHTML = state.writers.map(writerCard).join('');
  }

  const totals = [...state.pendingByWriter.values()].reduce(
    (acc, v) => ({ total: acc.total + v.total, pending: acc.pending + v.pending }),
    { total: 0, pending: 0 },
  );
  el('roster-stats').innerHTML = state.writers.length === 0 ? '' :
    `${state.writers.length} ${plural(state.writers.length, 'писатель', 'писателя', 'писателей')} ·
     ${totals.total} ${plural(totals.total, 'слово', 'слова', 'слов')} ·
     ${totals.pending > 0 ? `${totals.pending} в очереди` : 'всё отправлено'}`;
}

/// How many tasks this writer's own delivery holds, built once and cached —
/// the roster must not re-shuffle 759 rows on every render.
function deliveryTotalFor(writerID) {
  const cached = state.deliveryTotals.get(writerID);
  if (cached !== undefined) return cached;
  const total = buildDelivery(writerID, state.rows).length;
  state.deliveryTotals.set(writerID, total);
  return total;
}

function writerCard(writer) {
  const stats = state.pendingByWriter.get(writer.writer_id) ?? { total: 0, pending: 0 };
  const cursor = writer.progress?.cursor ?? 0;
  const total = deliveryTotalFor(writer.writer_id) || state.rows.length || 759;
  const percent = clamp(Math.round((cursor / total) * 100), 0, 100);
  const finished = writer.progress?.finished_at;
  return `
    <article class="card writer" data-writer="${writer.writer_id}">
      <div class="writer-head">
        <button class="writer-name" data-action="rename">${escapeHtml(writer.label || 'Без имени')}</button>
        ${finished ? '<span class="badge done">Завершён</span>' : ''}
      </div>
      <div class="bar"><span style="width:${percent}%"></span></div>
      <div class="writer-stats">
        <span><b>${cursor}</b> / ${total} заданий</span>
        <span><b>${stats.total}</b> ${plural(stats.total, 'слово', 'слова', 'слов')}</span>
        <span class="${stats.pending > 0 ? 'warn' : 'ok'}">${stats.pending > 0 ? `${stats.pending} в очереди` : 'отправлено'}</span>
      </div>
      <div class="writer-actions">
        <button class="btn primary" data-action="write">${cursor > 0 ? 'Продолжить' : 'Начать'}</button>
        <button class="btn" data-action="export">Экспорт</button>
        <button class="btn ghost" data-action="finish" ${finished ? 'disabled' : ''}>Завершить</button>
        <button class="btn ghost danger" data-action="delete">Удалить</button>
      </div>
      <div class="writer-id">${writer.writer_id}</div>
    </article>`;
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// MARK: - Writer lifecycle

async function addWriter() {
  const label = await promptModal({
    title: 'Новый писатель',
    message: 'Имя или метка — только чтобы вы не перепутали людей. В датасет она не уходит, там писатель — это анонимный идентификатор.',
    placeholder: `Писатель ${state.writers.length + 1}`,
    confirm: 'Далее',
  });
  if (label === null) return;

  const writer = {
    writer_id: uuidv4(),
    label: label.trim() || `Писатель ${state.writers.length + 1}`,
    created_at: Date.now(),
    consent: { granted: false, granted_at: null, text_version: CONSENT_TEXT_VERSION },
    input_device: null,
    can_write_cursive: null,
    habitual_script: null,
    progress: {
      cursor: 0,
      written_count: 0,
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
  showConsent();
}

async function activateWriter(writerID, { navigate = true } = {}) {
  const writer = await writerStore.get(writerID);
  if (!writer) return;
  state.active = writer;
  await meta.set('active_writer', writerID);
  if (!state.sessionIDs.has(writerID)) state.sessionIDs.set(writerID, uuidv4());

  state.delivery = buildDelivery(writerID, state.rows);
  state.counts = tierCounts(state.delivery);
  state.deliveryTotals.set(writerID, state.delivery.length);

  if (navigate) {
    if (!writer.consent?.granted) {
      showConsent();
    } else {
      await openWriting();
    }
  }
}

async function saveActiveWriter() {
  if (!state.active) return;
  await writerStore.put(state.active);
  state.writers = await writerStore.all();
}

// MARK: - Consent

function showConsent() {
  el('consent-writer').textContent = state.active?.label ?? '';
  el('consent-agree').checked = false;
  el('consent-continue').disabled = true;
  showScreen('consent');
}

async function grantConsent() {
  if (!state.active) return;
  state.active.consent = {
    granted: true,
    granted_at: Date.now(),
    text_version: CONSENT_TEXT_VERSION,
  };
  await saveActiveWriter();
  await openWriting();
}

// MARK: - Writing

function currentTask() {
  const cursor = state.active?.progress?.cursor ?? 0;
  return state.delivery[cursor] ?? null;
}

async function openWriting() {
  if (!state.active) return;
  showScreen('write');
  if (!state.sheet) {
    state.sheet = new InkSheet(el('ink'), {
      onChange: onInkChange,
      onTouchRejected: warnAboutPalmRejection,
    });
    new ResizeObserver(() => state.sheet.resize()).observe(el('sheet-wrap'));
  }
  state.sheet.clear();
  await renderTask();
  renderSyncChip();
  await restoreDraft();
  await maybeAskQuestions();
}

async function renderTask() {
  const task = currentTask();
  const total = state.delivery.length;
  const cursor = state.active.progress.cursor;

  el('write-writer').textContent = state.active.label ?? '';

  if (!task) {
    el('prompt-word').textContent = 'Все задания пройдены';
    el('prompt-hint').textContent = 'Можно завершить сбор и отправить всё на сервер.';
    el('write-counter').textContent = `${total} / ${total}`;
    el('progress-fill').style.width = '100%';
    el('btn-save').disabled = true;
    el('btn-skip').disabled = true;
    el('stage-label').textContent = 'Готово';
    return;
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
    .filter((t) => t.word_group === task.word_group).length + 1;
  el('stage-label').textContent =
    `${GROUP_TITLES[task.word_group]} · ${inTier} из ${state.counts[task.word_group] ?? '?'} · пачка ${task.packet} (${(cursor % PACKET_SIZE) + 1}/${PACKET_SIZE})`;
  el('btn-skip').disabled = false;
  onInkChange();
}

function hintFor(task) {
  const parts = [];
  parts.push(task.starts_with_uppercase
    ? 'с <b>заглавной</b> буквы'
    : 'со <b>строчной</b> буквы');
  if (task.is_exact_repeat) parts.push('это слово уже было — пишите как обычно, не сверяясь');
  if (task.is_case_pair) parts.push('пара к тому же слову в другом регистре');
  return parts.join(' · ');
}

let palmWarned = false;
function warnAboutPalmRejection() {
  if (palmWarned) return;
  palmWarned = true;
  toast('На этом листе уже писали пером — касания пальцем игнорируются');
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
      `${state.sheet.pointCount} точек${rate > 0 ? ` · ${rate} Гц` : ''}`;
  }
  scheduleDraftSave();
}

// MARK: Drafts — a reload mid-word must not cost the word

const scheduleDraftSave = debounce(() => { saveDraft(); }, 400);

async function saveDraft() {
  const writer = state.active;
  const task = currentTask();
  if (!writer || !task || !state.sheet) return;
  const draft = state.sheet.draftState();
  if (!draft) {
    await meta.remove(`draft:${writer.writer_id}`);
    return;
  }
  await meta.set(`draft:${writer.writer_id}`, { order: task.order, ...draft });
}

async function restoreDraft() {
  const writer = state.active;
  const task = currentTask();
  if (!writer || !task) return;
  const draft = await meta.get(`draft:${writer.writer_id}`, null);
  if (!draft || draft.order !== task.order) return;
  state.sheet.resize();
  // The draft carries the space it was recorded in; the sheet keeps those
  // coordinates and fits them to the current box for display only, so a
  // reload on a differently sized screen cannot rewrite recorded geometry.
  state.sheet.restore(draft);
  toast('Черновик слова восстановлен');
}

// MARK: Saving a sample

async function saveSample() {
  const writer = state.active;
  const task = currentTask();
  const capture = state.sheet?.capture();
  if (!writer || !task || !capture) return;

  const sample = {
    schema_version: 'noto-0.1',
    sample_id: uuidv4(),
    writer_id: writer.writer_id,
    session_id: state.sessionIDs.get(writer.writer_id),
    label: task.text,
    label_source: 'prompt',
    prompt_id: task.prompt_id,
    recognition_confidence: null,
    recognition_engine: null,
    language: 'ru',
    is_dictionary_word: true,
    translation: null,
    pointer_type: capture.pointer_type,
    canvas_w: capture.canvas_w,
    canvas_h: capture.canvas_h,
    dpr: capture.dpr,
    baseline_y: capture.baseline_y,
    sample_type: 'prompted_word',
    task_index: task.task_index,
    word_group: task.word_group,
    order: task.order,
    created_at: Date.now(),
    duration_ms: capture.duration_ms,
    is_correction: false,
    app_version: APP_VERSION,
    strokes: capture.strokes,
    sync: 'pending',
  };

  await sampleStore.put(sample);

  // The writer's input device is what they actually wrote with, recorded once.
  if (!writer.input_device) {
    writer.input_device = capture.pointer_type === 'pen' ? 'stylus' : 'finger';
  }
  writer.progress.cursor += 1;
  writer.progress.written_count += 1;
  await saveActiveWriter();
  await meta.remove(`draft:${writer.writer_id}`);

  state.sheet.clear();
  await renderTask();
  await refreshPendingCounts();
  renderSyncChip();
  sync.drain();
  await maybeAskQuestions();
}

async function skipTask() {
  const writer = state.active;
  if (!writer || !currentTask()) return;
  writer.progress.cursor += 1;
  await saveActiveWriter();
  await meta.remove(`draft:${writer.writer_id}`);
  state.sheet.clear();
  await renderTask();
  await maybeAskQuestions();
}

// MARK: Profile questions

async function maybeAskQuestions() {
  const writer = state.active;
  if (!writer) return;
  if (writer.progress.cursor < STYLE_QUESTIONS_AT) return;

  if (!writer.progress.asked_cursive) {
    const answer = await choiceModal({
      title: 'Один вопрос о вас',
      message: 'Пишете ли вы прописью (связными буквами), не задумываясь?',
      options: [
        { value: 'fluent', label: 'Да, свободно' },
        { value: 'rusty', label: 'Умею, но давно не писал(а)' },
        { value: 'no', label: 'Нет, пишу печатными' },
      ],
    });
    writer.progress.asked_cursive = true;
    if (answer) writer.can_write_cursive = answer;
    await saveActiveWriter();
    return;
  }

  if (!writer.progress.asked_habit) {
    const answer = await choiceModal({
      title: 'И ещё один',
      message: 'Как вы обычно пишете от руки, когда никто не просит?',
      options: [
        { value: 'print_only', label: 'Только печатными' },
        { value: 'cursive_only', label: 'Только прописью' },
        { value: 'combined', label: 'Смешиваю в одном слове' },
        { value: 'both', label: 'И так, и так — по ситуации' },
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
    title: 'Завершить сбор',
    message: `Всё, что написал(а) «${writer.label}», останется на устройстве и будет отправлено на сервер. ${stats.pending > 0 ? `Сейчас в очереди ${stats.pending}.` : ''} Писателя можно открыть снова в любой момент.`,
    confirm: 'Завершить',
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
  toast('Сбор завершён');
}

async function deleteWriter(writerID) {
  const writer = await writerStore.get(writerID);
  if (!writer) return;
  const stats = state.pendingByWriter.get(writerID) ?? { total: 0, pending: 0 };
  const confirmed = await confirmModal({
    title: `Удалить «${writer.label}»?`,
    message: stats.pending > 0
      ? `У этого писателя ${stats.total} ${plural(stats.total, 'слово', 'слова', 'слов')}, из них ${stats.pending} ещё не отправлено на сервер. Они пропадут навсегда. Сначала лучше сделать экспорт.`
      : `${stats.total} ${plural(stats.total, 'слово', 'слова', 'слов')} будут удалены с устройства. На сервере отправленное останется.`,
    confirm: 'Удалить',
    destructive: true,
  });
  if (!confirmed) return;

  await writerStore.remove(writerID);
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
    title: 'Имя писателя',
    message: 'Видно только на этом устройстве.',
    value: writer.label ?? '',
    confirm: 'Сохранить',
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
      toast('Пока нечего экспортировать');
      return;
    }
    const result = await deliver(file, { preferShare: isIOS() });
    if (result.method !== 'cancelled') {
      toast(`Файл ${file.name} · ${formatBytes(result.bytes)}`);
    }
  } catch (error) {
    toast(`Экспорт не удался: ${error.message}`, true);
  }
}

async function runImport(file) {
  try {
    const result = await importFile(file);
    state.writers = await writerStore.all();
    await refreshPendingCounts();
    renderRoster();
    await renderSettings();
    toast(`Импортировано: ${result.writersAdded} писателей, ${result.samplesAdded} слов`);
    sync.drain();
  } catch (error) {
    toast(`Импорт не удался: ${error.message}`, true);
  }
}

// MARK: - Settings

async function renderSettings() {
  el('opt-upload').checked = sync.enabled;
  const estimate = await storageEstimate();
  const total = await sampleStore.totalCount();
  const pending = await sampleStore.pendingCount();
  el('settings-stats').innerHTML = `
    <div><span>Писателей</span><b>${state.writers.length}</b></div>
    <div><span>Слов на устройстве</span><b>${total}</b></div>
    <div><span>Не отправлено</span><b>${pending}</b></div>
    <div><span>Занято в браузере</span><b>${formatBytes(estimate.usage ?? 0)}</b></div>
    <div><span>Последняя отправка</span><b>${formatDate(sync.lastSuccessAt)}</b></div>
    <div><span>Сервер</span><b class="mono">${new URL(SERVER.projectURL).host}</b></div>
    <div><span>Версия</span><b class="mono">${APP_VERSION}</b></div>`;
}

// MARK: - Sync chip

function renderSyncChip() {
  const chip = el('sync-chip');
  if (!chip) return;
  let text;
  let tone = 'ok';
  if (!sync.enabled) {
    text = 'Только локально';
    tone = 'muted';
  } else if (!sync.isOnline) {
    text = 'Офлайн · в очереди';
    tone = 'warn';
  } else if (sync.running) {
    text = sync.progress ? `Отправка ${sync.progress.sent}/${sync.progress.total}` : 'Отправка…';
    tone = 'busy';
  } else if (sync.lastError) {
    text = sync.lastError;
    tone = 'warn';
  } else {
    const stats = state.active ? state.pendingByWriter.get(state.active.writer_id) : null;
    text = stats && stats.pending > 0 ? `${stats.pending} в очереди` : 'Синхронизировано';
  }
  chip.textContent = text;
  chip.dataset.tone = tone;
}

// MARK: - Chrome wiring

function bindChrome() {
  el('btn-add-writer').addEventListener('click', addWriter);
  el('btn-settings').addEventListener('click', async () => {
    await renderSettings();
    showScreen('settings');
  });
  el('btn-settings-back').addEventListener('click', () => {
    renderRoster();
    showScreen('roster');
  });

  el('writer-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const writerID = button.closest('[data-writer]')?.dataset.writer;
    if (!writerID) return;
    switch (button.dataset.action) {
      case 'write': await activateWriter(writerID); break;
      case 'export': await runExport(writerID); break;
      case 'finish': await finishWriter(writerID); break;
      case 'delete': await deleteWriter(writerID); break;
      case 'rename': await renameWriter(writerID); break;
    }
  });

  el('consent-agree').addEventListener('change', (event) => {
    el('consent-continue').disabled = !event.target.checked;
  });
  el('consent-continue').addEventListener('click', grantConsent);
  el('consent-cancel').addEventListener('click', () => {
    renderRoster();
    showScreen('roster');
  });

  el('btn-back').addEventListener('click', async () => {
    await saveDraft();
    await refreshPendingCounts();
    renderRoster();
    showScreen('roster');
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
      title: 'Отправить всё заново',
      message: 'Все слова снова встанут в очередь на отправку. Сервер принимает повторы как обновление той же записи, дублей не будет.',
      confirm: 'Отправить',
    })) return;
    for (const writer of state.writers) await sampleStore.requeueForWriter(writer.writer_id);
    await refreshPendingCounts();
    await renderSettings();
    sync.drain();
    toast('Очередь заполнена заново');
  });
  el('btn-wipe').addEventListener('click', async () => {
    if (!await confirmModal({
      title: 'Стереть все данные',
      message: 'Будут удалены все писатели и все собранные слова на этом устройстве. Отменить нельзя.',
      confirm: 'Стереть всё',
      destructive: true,
    })) return;
    if (!await confirmModal({
      title: 'Точно?',
      message: 'Последняя проверка: неэкспортированные слова исчезнут навсегда.',
      confirm: 'Да, стереть',
      destructive: true,
    })) return;
    await wipeEverything();
    state.writers = [];
    state.active = null;
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

function confirmModal({ title, message, confirm = 'ОК', destructive = false }) {
  return new Promise((resolve) => {
    const shell = modalShell(`
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="btn ghost" data-modal="cancel">Отмена</button>
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

function promptModal({ title, message, value = '', placeholder = '', confirm = 'ОК' }) {
  return new Promise((resolve) => {
    const shell = modalShell(`
      <h2>${escapeHtml(title)}</h2>
      ${message ? `<p>${escapeHtml(message)}</p>` : ''}
      <input type="text" id="modal-input" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"
             autocomplete="off" autocapitalize="words" enterkeyhint="done">
      <div class="modal-actions">
        <button class="btn ghost" data-modal="cancel">Отмена</button>
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
        <button class="btn ghost" data-choice="">Пропустить</button>
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
