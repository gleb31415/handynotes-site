// Interface language of the collector: Russian or English.
//
// One module owns it. The language is resolved once at import:
//   1. `?lang=ru|en` in the address — the link the app shares carries it —
//      and is persisted, because the installed PWA's start_url drops it;
//   2. localStorage `hn-lang` — the same key the main pencora.app site
//      uses, so a choice made there carries over (same origin);
//   3. the browser: a `ru…` language means Russian, anything else English.
//
// Static text lives in index.html in Russian (so the page is readable before
// any script runs) and is tagged: `data-i18n="key"` replaces textContent,
// `data-i18n-html="key"` replaces innerHTML (only for dictionary strings with
// markup, never with interpolated data), `data-i18n-attr="attr:key;attr:key"`
// sets attributes. `setLang` re-applies all of it and dispatches `langchange`
// on window, so each screen re-renders its dynamic text.
//
// Dictionary values are strings, or arrays of plural forms — Russian three
// (one / few / many), English two (one / other) — picked by `vars.n`.
//
// The compositor modules (compose.js, mathlayout.js, solution.js, textink.js,
// glyphs.js, tasks.js, util.js) are also copied into the app's FormulaLab
// bundle and must not import this file; their few Russian messages are
// translated where they are shown, by `translateEngineMessage`.

const STORAGE_KEY = 'hn-lang';
export const LANGUAGES = Object.freeze(['ru', 'en']);

function isLang(value) {
  return value === 'ru' || value === 'en';
}

function readQueryLang() {
  try {
    const value = new URLSearchParams(location.search).get('lang');
    return isLang(value) ? value : null;
  } catch {
    return null;
  }
}

/// The language the address asked for (`?lang=`), or null. The page also
/// takes it as the default COLLECTION language: the app's "collect English
/// handwriting" link is `…/handwriting/?lang=en`.
export const QUERY_LANG = readQueryLang();

function readStoredLang() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLang(value) ? value : null;
  } catch {
    return null;
  }
}

function storeLang(value) {
  try { localStorage.setItem(STORAGE_KEY, value); } catch { /* private mode: this visit only */ }
}

function browserLang() {
  if (typeof navigator === 'undefined') return 'en';
  const list = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language ?? ''];
  return String(list[0] ?? '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

let current = (() => {
  if (QUERY_LANG) {
    storeLang(QUERY_LANG);
    dropQueryLang();
    return QUERY_LANG;
  }
  return readStoredLang() ?? browserLang();
})();

/// Once `?lang=` is persisted it leaves the address: otherwise a reload of
/// the same tab would override a RU/EN switch made since (the parameter
/// wins over everything). Other parameters and the hash are kept.
function dropQueryLang() {
  try {
    const url = new URL(location.href);
    url.searchParams.delete('lang');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch { /* no History API — the parameter simply stays */ }
}

export function getLang() {
  return current;
}

export function isRussian() {
  return current === 'ru';
}

/// BCP 47 locale for dates and numbers in the current language.
export function locale(lang = current) {
  return lang === 'ru' ? 'ru-RU' : 'en-US';
}

/// Index of the plural form of `n`: Russian 0 one / 1 few / 2 many,
/// English 0 one / 1 other.
export function pluralIndex(n, lang = current) {
  const abs = Math.abs(Math.trunc(Number(n) || 0));
  if (lang === 'ru') {
    const mod10 = abs % 10;
    const mod100 = abs % 100;
    if (mod10 === 1 && mod100 !== 11) return 0;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1;
    return 2;
  }
  return abs === 1 ? 0 : 1;
}

function interpolate(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

/// The string for `key` in the current language, `{name}` placeholders
/// filled from `vars`. A plural entry picks its form by `vars.n`. A key the
/// current language lacks falls back to Russian, then to the key itself.
export function t(key, vars) {
  const value = STRINGS[current][key] ?? STRINGS.ru[key];
  if (value === undefined) return key;
  if (Array.isArray(value)) {
    const n = vars?.n ?? 0;
    const form = value[Math.min(pluralIndex(n), value.length - 1)];
    return interpolate(form, { ...vars, n });
  }
  return interpolate(value, vars);
}

/// Shorthand for a plural entry: `tn('n.words', 5)` → «5 слов» / "5 words".
export function tn(key, n, vars) {
  return t(key, { ...vars, n });
}

/// A decimal in the current language: «0,42» / "0.42".
export function formatDecimal(value, digits = 2) {
  const text = Number(value).toFixed(digits);
  return current === 'ru' ? text.replace('.', ',') : text;
}

/// Re-applies every tagged node under `root` and the RU/EN toggles.
export function applyStatic(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll('[data-i18n-html]')) {
    node.innerHTML = t(node.dataset.i18nHtml);
  }
  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of node.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((part) => part.trim());
      if (attr && key) node.setAttribute(attr, t(key));
    }
  }
  for (const button of root.querySelectorAll('[data-lang-toggle] button[data-value]')) {
    button.setAttribute('aria-pressed', String(button.dataset.value === current));
  }
  if (root === document) {
    document.documentElement.lang = current;
    document.title = t('doc.title');
  }
}

/// Switches the interface language, persists it and tells the page.
export function setLang(next) {
  if (!isLang(next) || next === current) return;
  current = next;
  storeLang(next);
  applyStatic();
  window.dispatchEvent(new CustomEvent('langchange', { detail: { lang: next } }));
}

/// Wires every RU/EN toggle (`[data-lang-toggle]` with `button[data-value]`).
export function bindLangToggles(root = document) {
  for (const group of root.querySelectorAll('[data-lang-toggle]')) {
    group.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (button) setLang(button.dataset.value);
    });
  }
}

// MARK: - Compositor messages
//
// The shared compositor modules report in Russian (they are the app's too).
// In English each known message is re-worded here; one that is not in the
// table is shown as it came, which beats showing nothing.

const ENGINE_RULES = [
  // solution.js · lintLatex
  [/^лишняя закрывающая скобка «\}»$/, () => 'extra closing brace “}”'],
  [/^неподдерживаемая команда (.+)$/, (m) => `unsupported command ${m[1]}`],
  [/^неподдерживаемое окружение (.+)$/, (m) => `unsupported environment ${m[1]}`],
  [/^(\\end\{[^}]*\}) без (\\begin\{[^}]*\})$/, (m) => `${m[1]} without ${m[2]}`],
  [/^(\\begin\{[^}]*\}) без (\\end\{[^}]*\})$/, (m) => `${m[1]} without ${m[2]}`],
  [/^не закрыта фигурная скобка «\{»$/, () => 'unclosed brace “{”'],
  [/^\\left без парного \\right$/, () => '\\left without a matching \\right'],
  [/^\\right без парного \\left$/, () => '\\right without a matching \\left'],
  // compose.js
  [/^Формула не разобрана и записана как текст: ([\s\S]*?)(?: \((неизвестная команда [^)]*|непарные фигурные скобки|лишний знак \$)\))?$/,
    (m) => `Formula not parsed, written out as text: ${m[1]}${m[2] ? ` (${katexReasonEN(m[2])})` : ''}`],
  [/^Строка выше страницы — она выходит за нижнее поле$/, () => 'A line is taller than the page — it runs past the bottom margin'],
  [/^Формула шире (строки|страницы) даже при уменьшении до (\d+) % и выходит за поле — разбейте её на несколько формул$/,
    (m) => `A formula is wider than the ${m[1] === 'строки' ? 'line' : 'page'} even at ${m[2]}% and runs past the margin — split it into several formulas`],
  [/^Формула не помещается (в строку|по ширине) — уменьшена до (\d+) %$/,
    (m) => `A formula doesn’t fit ${m[1] === 'в строку' ? 'on the line' : 'the width'} — shrunk to ${m[2]}%`],
  [/^Слишком длинное слово перенесено по частям$/, () => 'A very long word was split across lines'],
  [/^Слово не помещается в строку: (.*)$/, (m) => `A word doesn’t fit on the line: ${m[1]}`],
  [/^Таблица шире страницы — столбцы сужены до предела, широкие формулы в ней уменьшены$/,
    () => 'The table is wider than the page — its columns are as narrow as they go and wide formulas in it are shrunk'],
  [/^Длинная формула перенесена на несколько строк$/, () => 'A long formula was split across several lines'],
  [/^Не удалось сохранить PNG$/, () => 'Could not save the PNG'],
  // mathlayout.js
  [/^Не удалось загрузить стили KaTeX$/, () => 'Could not load the KaTeX styles'],
  [/^glyphs\.js недоступен: ключи символов не нормализованы$/, () => 'glyphs.js unavailable: symbol keys are not normalized'],
  [/^KaTeX: неизвестная команда$/, () => 'KaTeX: unknown command'],
  [/^KaTeX ничего не нарисовал$/, () => 'KaTeX drew nothing'],
  [/^Фигурная скобка \\overbrace\/\\underbrace нарисована прямой линией$/, () => 'The \\overbrace/\\underbrace brace is drawn as a straight line'],
  [/^Неизвестный элемент формулы \(svg\) заменён линией$/, () => 'An unknown formula element (svg) was replaced with a line'],
  [/^Необычный знак корня: черта оценена приблизительно$/, () => 'Unusual radical sign: its bar is approximated'],
  [/^Высокая скобка не распознана$/, () => 'A tall bracket was not recognized'],
  [/^Зонд базовой линии сдвинул разметку на (.+) px$/, (m) => `The baseline probe shifted the layout by ${m[1]} px`],
  // textink.js
  [/^Модель почерка отключена после (\d+) ошибок подряд \(([\s\S]*)\)$/,
    (m) => `The handwriting model was switched off after ${m[1]} failures in a row (${m[2]})`],
  // glyphs.js / tasks.js loaders
  [/^Не удалось загрузить символы \((\d+)\)$/, (m) => `Could not load the symbols (${m[1]})`],
  [/^Не удалось загрузить задания \((\d+)\)$/, (m) => `Could not load the tasks (${m[1]})`],
];

function katexReasonEN(reason) {
  const command = /^неизвестная команда (.+)$/.exec(reason);
  if (command) return `unknown command ${command[1]}`;
  if (reason === 'непарные фигурные скобки') return 'unbalanced braces';
  if (reason === 'лишний знак $') return 'stray $ sign';
  return reason;
}

/// A compositor message in the current language (see ENGINE_RULES).
export function translateEngineMessage(text) {
  const message = String(text ?? '');
  if (current === 'ru') return message;
  for (const [pattern, render] of ENGINE_RULES) {
    const match = pattern.exec(message);
    if (match) return render(match);
  }
  return message;
}

// MARK: - Dictionaries

const STRINGS = {
  ru: {
    'doc.title': 'Pencora · сбор почерка',
    'doc.description': 'Сбор рукописных образцов: слова из общего ядра и математические символы, запись траекторий пера, работа офлайн, экспорт в JSON, решения задач своим почерком.',
    // The name under the icon when the page is added to the home screen.
    'doc.appTitle': 'Pencora сбор',
    'lang.toggle': 'Язык интерфейса',

    // Plurals
    'n.writers': ['{n} писатель', '{n} писателя', '{n} писателей'],
    'n.words': ['{n} слово', '{n} слова', '{n} слов'],
    'n.symbols': ['{n} символ', '{n} символа', '{n} символов'],
    'n.samples': ['{n} образец', '{n} образца', '{n} образцов'],
    'n.pages': ['{n} страница', '{n} страницы', '{n} страниц'],
    'n.points': ['{n} точка', '{n} точки', '{n} точек'],
    'n.times': ['{n} раз', '{n} раза', '{n} раз'],
    'n.people': ['{n} человек уже пишет', '{n} человека уже пишут', '{n} человек уже пишут'],
    'n.peopleShort': ['{n} человек', '{n} человека', '{n} человек'],
    'n.missingSymbols': ['{n} символа', '{n} символов', '{n} символов'],
    'n.fillSymbols': ['Дописать {n} символ из набора', 'Дописать {n} символа из набора', 'Дописать {n} символов из набора'],

    // Boot
    'boot.failed': 'Не удалось запустить',
    'boot.coreFailed': 'Не удалось загрузить задания ({status})',

    // Roster
    'roster.title': 'Сбор почерка',
    'roster.settings': 'Настройки',
    'roster.lead': 'Каждый человек, который пишет на этом устройстве, — отдельный писатель. Задания идут из общего ядра ({words}), порядок у каждого свой и не меняется при перезагрузке страницы. Отдельно собираются математические символы (288 штук, около 560 заданий) — из них потом можно переписать решение задачи вашим почерком.',
    'roster.addWriter': '＋ Новый писатель',
    'roster.empty': 'Пока нет ни одного писателя.',
    'roster.emptyHint': 'Каждый человек, который пишет на этом устройстве, — отдельный писатель со своим набором слов и своим прогрессом.',
    'roster.queued': '{n} в очереди',
    'roster.allSent': 'всё отправлено',

    // Collection language
    'collect.label': 'Какие слова писать',
    'collect.aria': 'Язык слов для сбора',
    'collect.ru': 'Русские слова',
    'collect.en': 'Английские слова',
    'collect.enFailed': 'Не удалось загрузить английские слова — проверьте сеть',

    // Writer card
    'card.noName': 'Без имени',
    'card.finished': 'Завершён',
    'card.joined': 'В команде',
    'card.confirmAge': 'Подтвердите возраст',
    'card.words': 'Слова',
    'card.symbols': 'Символы',
    'card.goal': 'цель: {have} из {goal}',
    'card.sent': 'отправлено',
    'card.start': 'Начать',
    'card.continue': 'Продолжить',
    'card.glyphs': 'Символы',
    'card.compose': 'Решение почерком',
    'card.export': 'Экспорт',
    'card.finish': 'Завершить',
    'card.delete': 'Удалить',

    // Community
    'community.aria': 'Сколько людей уже пишут',
    'community.next': 'следующая модель — при {target}',
    'community.note': 'Напишите {goal} слов — и ваш почерк попадёт в следующую модель.',
    'community.miniNext': 'модель при {target}',
    'community.miniYou': 'ваши слова {have}/{goal}',
    'community.miniJoined': 'вы в команде',

    // Celebration
    'celebrate.title': 'Ты в команде!',
    'celebrate.number': 'Твой почерк — №{n}',
    'celebrate.body': 'Твои {goal} слов уходят в датасет — следующая модель будет учиться и на твоём почерке. Можно писать дальше: каждое слово делает её точнее.',
    'celebrate.ok': 'Дальше',

    // Consent
    'consent.back': 'Назад',
    'consent.title': 'Согласие',
    'consent.writer': 'Писатель:',
    'consent.update': 'Текст согласия обновился: теперь, кроме слов, собираются и математические символы. Прочитайте, пожалуйста, и подтвердите ещё раз — уже написанное остаётся как было.',
    'consent.ageUpdate': 'Подтвердите, пожалуйста, что вам уже исполнилось 18: сбор почерка теперь только для взрослых. Всё, что уже написано, сохранится, но на сервер уйдёт только после подтверждения.',
    'consent.collectedTitle': 'Что собирается',
    'consent.c1': 'Траектория пера: координаты, время, нажим и наклон — то есть <b>как</b> написано слово.',
    'consent.c2': 'Также — рукописные математические символы и буквы (цифры, латиница, греческие буквы, знаки, скобки, кириллица), если вы их пишете.',
    'consent.c3': 'Слово или символ-задание, которое было показано, и техническая информация об экране.',
    'consent.c4': 'Анонимный идентификатор писателя — случайный номер, не связанный с личностью.',
    'consent.notTitle': 'Что не собирается',
    'consent.n1': 'Имя, e-mail, телефон, местоположение, содержимое ваших заметок.',
    'consent.n2': 'Имя писателя из списка остаётся только на этом устройстве.',
    'consent.n3': 'Текст решений, которые вы вставляете в «Решение почерком», — он не отправляется на сервер датасета. Только если в настройках указана внешняя модель почерка, слова решения (без формул) вместе с анонимным идентификатором писателя уходят на её адрес — экран решения об этом предупреждает.',
    'consent.whyTitle': 'Зачем',
    'consent.w1': 'Слова и символы используются для обучения и оценки моделей распознавания и генерации рукописного текста (датасет).',
    'consent.w2': 'Символы и слова также используются <b>локально, на этом устройстве</b>, чтобы переписывать решения задач вашим почерком. Для этого ничего не отправляется на сервер (кроме описанной выше внешней модели почерка, если её включили).',
    'consent.version': 'Версия текста согласия: {v}. Отправку на сервер можно выключить в настройках — тогда всё остаётся на устройстве, и данные можно выгрузить в JSON.',
    'consent.agree': 'Я согласен(на) на сбор и использование этих данных',
    'consent.adult': 'Мне уже исполнилось 18 лет',
    'consent.start': 'Начать писать',
    'consent.continue': 'Продолжить',

    // Writing
    'write.back': 'К списку писателей',
    'write.syncNow': 'Отправить сейчас',
    'write.template': 'Образец на листе',
    'write.sheetWord': 'Напишите слово от руки — как пишете обычно',
    'write.sheetGlyph': 'Напишите символ от руки — так, как пишете его в формулах',
    'write.undo': 'Отменить',
    'write.clear': 'Стереть',
    'write.skip': 'Пропустить',
    'write.save': 'Готово →',
    'write.allDone': 'Все задания пройдены',
    'write.allDoneHint': 'Можно завершить сбор и отправить всё на сервер.',
    'write.doneStage': 'Готово',
    'write.stage': '{group} · {n} из {total} · пачка {packet} ({inPacket}/{packetSize})',
    'write.upper': 'с <b>заглавной</b> буквы',
    'write.lower': 'со <b>строчной</b> буквы',
    'write.repeat': 'это слово уже было — пишите как обычно, не сверяясь',
    'write.casePair': 'пара к тому же слову в другом регистре',
    'write.palm': 'На этом листе уже писали пером — касания пальцем игнорируются',
    'write.hz': '{hz} Гц',
    'write.draftWord': 'Черновик слова восстановлен',
    'write.draftGlyph': 'Черновик символа восстановлен',

    // Symbols
    'glyph.allDone': 'Все символы написаны',
    'glyph.allDoneHint': 'Спасибо! Теперь можно переписать решение задачи своим почерком — «Решение почерком» в списке писателей.',
    'glyph.doneStage': 'Символы · готово',
    'glyph.targetStage': 'Дописываем символы для решения · {i} из {n}',
    'glyph.stage': 'Символы · раунд {round} · повтор {rep} · {i} из {total}',
    'glyph.repeat': 'этот символ уже был — пишите как обычно, не сверяясь',
    'glyph.filled': 'Символы дописаны — собираю решение заново',
    'glyph.loadFailed': 'Не удалось загрузить список символов — проверьте сеть',
    'glyphCat.digit': 'цифра',
    'glyphCat.latin_lower': 'латиница, строчная',
    'glyphCat.latin_upper': 'латиница, заглавная',
    'glyphCat.greek_lower': 'греческая, строчная',
    'glyphCat.greek_upper': 'греческая, заглавная',
    'glyphCat.operator': 'знак действия',
    'glyphCat.relation': 'отношение',
    'glyphCat.delimiter': 'скобка',
    'glyphCat.arrow': 'стрелка',
    'glyphCat.set_logic': 'множества и логика',
    'glyphCat.big_operator': 'большой оператор',
    'glyphCat.calculus': 'анализ',
    'glyphCat.blackboard': 'множество чисел',
    'glyphCat.accent': 'надстрочный знак',
    'glyphCat.punctuation': 'пунктуация',
    'glyphCat.cyrillic_lower': 'кириллица, строчная',
    'glyphCat.cyrillic_upper': 'кириллица, заглавная',
    'glyphCat.misc': 'разное',

    // Profile questions
    'q.cursiveTitle': 'Один вопрос о вас',
    'q.cursiveMessage': 'Пишете ли вы прописью (связными буквами), не задумываясь?',
    'q.fluent': 'Да, свободно',
    'q.rusty': 'Умею, но давно не писал(а)',
    'q.no': 'Нет, пишу печатными',
    'q.habitTitle': 'И ещё один',
    'q.habitMessage': 'Как вы обычно пишете от руки, когда никто не просит?',
    'q.printOnly': 'Только печатными',
    'q.cursiveOnly': 'Только прописью',
    'q.combined': 'Смешиваю в одном слове',
    'q.both': 'И так, и так — по ситуации',

    // Modals
    'modal.ok': 'ОК',
    'modal.cancel': 'Отмена',
    'modal.skip': 'Пропустить',

    // Writer lifecycle
    'writer.newTitle': 'Новый писатель',
    'writer.newMessage': 'Имя или метка — только чтобы вы не перепутали людей. В датасет она не уходит, там писатель — это анонимный идентификатор.',
    'writer.defaultName': 'Писатель {n}',
    'writer.next': 'Далее',
    'finish.title': 'Завершить сбор',
    'finish.message': 'Всё, что написал(а) «{name}», останется на устройстве и будет отправлено на сервер. {queued}Писателя можно открыть снова в любой момент.',
    'finish.queued': 'Сейчас в очереди {n}. ',
    'finish.confirm': 'Завершить',
    'finish.done': 'Сбор завершён',
    'delete.title': 'Удалить «{name}»?',
    'delete.what': '{words} и {symbols}',
    'delete.pending': 'У этого писателя {what}, из них {pending} ещё не отправлено на сервер. Они пропадут навсегда. Сначала лучше сделать экспорт.',
    'delete.message': '{what} будут удалены с устройства. На сервере отправленное останется.',
    'delete.confirm': 'Удалить',
    'rename.title': 'Имя писателя',
    'rename.message': 'Видно только на этом устройстве.',
    'rename.save': 'Сохранить',

    // Export / import
    'export.nothing': 'Пока нечего экспортировать',
    'export.file': 'Файл {name} · {size}',
    'export.failed': 'Экспорт не удался: {error}',
    'import.done': 'Импортировано: {writers}, {samples}',
    'import.failed': 'Импорт не удался: {error}',
    'import.notJson': 'Файл не является JSON',
    'import.notExport': 'Не похоже на экспорт Pencora',
    'import.writerMissing': 'Писатель не найден',
    'import.defaultLabel': 'Импортирован',

    // Settings
    'settings.title': 'Настройки',
    'settings.back': 'Назад',
    'settings.upload': 'Отправлять на сервер',
    'settings.uploadHint': 'Выключите, чтобы собирать только на устройство и выгружать вручную в JSON.',
    'settings.composeTitle': 'Решение почерком',
    'settings.modelUrl': 'Модель почерка (URL)',
    'settings.modelUrlHint': 'Необязательно. Если указан, текст между формулами сначала запрашивается у этой модели (POST, ответ — штрихи в долях x-высоты, см. README). Не ответила за 2,5 с или ошиблась — слово берётся из ваших слов и букв, как без модели. Слова решения (без формул) и анонимный идентификатор писателя уходят на этот адрес.',
    'settings.dataTitle': 'Данные',
    'settings.exportAll': 'Экспорт всех в JSON',
    'settings.import': 'Импорт JSON',
    'settings.resend': 'Отправить всё заново',
    'settings.wipe': 'Стереть всё',
    'settings.offlineTitle': 'Офлайн',
    'settings.offline': 'Страница работает без сети: задания и приложение кешируются, слова копятся в браузере и уходят на сервер сами, когда сеть появится. На iPad и Android можно добавить страницу на домашний экран — она откроется как приложение, во весь экран.',
    'stats.writers': 'Писателей',
    'stats.words': 'Слов на устройстве',
    'stats.symbols': 'Символов на устройстве',
    'stats.unsent': 'Не отправлено',
    'stats.storage': 'Занято в браузере',
    'stats.lastUpload': 'Последняя отправка',
    'stats.server': 'Сервер',
    'stats.version': 'Версия',
    'resend.title': 'Отправить всё заново',
    'resend.message': 'Все слова и символы снова встанут в очередь на отправку. Сервер принимает повторы как обновление той же записи, дублей не будет.',
    'resend.confirm': 'Отправить',
    'resend.done': 'Очередь заполнена заново',
    'wipe.title': 'Стереть все данные',
    'wipe.message': 'Будут удалены все писатели и все собранные слова и символы на этом устройстве. Отменить нельзя.',
    'wipe.confirm': 'Стереть всё',
    'wipe.sureTitle': 'Точно?',
    'wipe.sureMessage': 'Последняя проверка: неэкспортированные слова и символы исчезнут навсегда.',
    'wipe.sureConfirm': 'Да, стереть',
    'model.badUrl': 'Адрес модели должен начинаться с http:// или https://',
    'model.saved': 'Модель почерка сохранена',
    'model.off': 'Модель почерка выключена',

    // Sync
    'sync.localOnly': 'Только локально',
    'sync.offlineQueued': 'Офлайн · в очереди',
    'sync.sending': 'Отправка {sent}/{total}',
    'sync.sendingPlain': 'Отправка…',
    'sync.queued': '{n} в очереди',
    'sync.synced': 'Синхронизировано',
    'sync.noNetwork': 'Нет сети',
    'sync.partial': 'Часть образцов сервер не принял — попробуем позже',
    'sync.status': 'Сервер ответил {status}',
    'sync.unreachable': 'Сервер недоступен',

    // Storage
    'store.blocked': 'База занята другой вкладкой',
    'store.aborted': 'Транзакция прервана',

    // «Решение почерком» — static
    'compose.title': 'Решение почерком',
    'compose.intro': 'Спросите нейросеть (ChatGPT, Claude, DeepSeek…), как решить задачу, и допишите к вопросу наш промпт — тогда ответ придёт в Markdown с формулами LaTeX, ровно в той разметке, которую умеет эта страница. Вставьте ответ сюда: он будет переписан от руки с сохранением вёрстки, формулы расставлены так, как их сверстал бы LaTeX, но каждый символ — из тех, что вы написали сами, и каждый раз немного по-другому.',
    'compose.markup': 'Поддерживается: заголовки <code>#</code> <code>##</code> <code>###</code>, <code>**жирный**</code> (сильнее нажим), <code>*курсив*</code> (сильнее наклон), <code>~~зачёркнутый~~</code>, списки <code>- </code> и <code>1. </code> с вложенностью по отступу, задачи <code>- [ ]</code>, цитаты <code>&gt; </code>, таблицы <code>| a | b |</code>, код в <code>```</code>, разделитель <code>---</code>, формулы <code>$…$</code> и <code>$$…$$</code>.',
    'compose.copyPrompt': 'Скопировать промпт для нейросети',
    'compose.promptLang': 'Язык промпта',
    'compose.promptText': 'Текст промпта',
    'compose.pasteTitle': 'Вставьте ответ',
    'compose.placeholder': 'Сюда — ответ нейросети целиком: Markdown и формулы в $…$ или $$…$$',
    'compose.paste': 'Вставить из буфера',
    'compose.clear': 'Очистить',
    'compose.hand': 'Почерк',
    'compose.seedTitle': 'Случайность (seed)',
    'compose.seedHelp': 'Одно и то же число — одна и та же страница. Другое — другая «попытка» написать то же.',
    'compose.dice': 'Случайный seed',
    'compose.reset': 'Сбросить настройки почерка',
    'compose.page': 'Страница',
    'compose.paper': 'Бумага',
    'compose.paperGrid': 'Клетка',
    'compose.paperLines': 'Линейка',
    'compose.paperBlank': 'Чистый',
    'compose.ink': 'Чернила',
    'compose.inkBlue': 'синие',
    'compose.inkBlack': 'чёрные',
    'compose.inkViolet': 'фиолетовые',
    'compose.margin': 'Поля',
    'compose.marginHelp': 'Красная линия полей справа, как в школьной тетради.',
    'compose.showMissing': 'Показать недостающие',
    'compose.prev': 'Предыдущая страница',
    'compose.next': 'Следующая страница',
    'compose.empty': 'Вставьте ответ — здесь появится страница.',
    'compose.print': 'Печать / PDF',
    'compose.json': 'Штрихи JSON',
    'compose.fillMissing': 'Дописать эти символы',
    'compose.openFailed': 'Не удалось открыть «Решение почерком»: {error}',

    // «Решение почерком» — knobs
    'knob.amount': 'Общая небрежность',
    'knob.amount.help': 'Множитель для всех ползунков ниже: 0 — идеально ровно, 1 — как вы пишете сами, 2 — вдвое небрежнее.',
    'knob.size': 'Размер',
    'knob.size.help': 'Насколько символы гуляют по размеру от раза к разу.',
    'knob.slant': 'Наклон',
    'knob.slant.help': 'Разброс наклона: одни символы чуть круче, другие чуть положе.',
    'knob.baseline': 'Строка',
    'knob.baseline.help': 'Насколько символы подпрыгивают над строкой и проваливаются под неё.',
    'knob.shape': 'Форма букв',
    'knob.shape.help': 'Мелкие плавные искажения формы: каждое вхождение символа — немного другое.',
    'knob.spacing': 'Интервалы',
    'knob.spacing.help': 'Неровность расстояний между буквами и словами.',
    'knob.drift': 'Дрейф строки',
    'knob.drift.help': 'Медленная волна вдоль строки: она уходит вверх-вниз и чуть меняет размер и наклон.',
    'knob.pressure': 'Нажим',
    'knob.pressure.help': 'Разброс нажима — того, насколько толстая линия.',
    'knob.morph': 'Смешивание вариантов',
    'knob.morph.help': 'Как часто символ — смесь двух ваших написаний, а не одно из них как есть.',
    'knob.fit': 'Как я ↔ как LaTeX',
    'knob.fit.help': 'Слева — пропорции ваших собственных символов, справа — каждый символ ровно в рамке, которую ему отвёл LaTeX.',
    'knob.xh': 'Размер почерка',
    'knob.xh.help': 'Высота строчных букв в долях клетки: 0,42 — аккуратный школьный почерк, больше — крупнее.',
    'knob.endMe': 'как я',
    'knob.endLatex': 'точно как LaTeX',
    'knob.cells': '{v} клетки',
    'knob.off': 'выкл.',
    'knob.likeYou': ' · как вы',

    // «Решение почерком» — status and panels
    'compose.busy': 'Собираю…',
    'compose.ready': 'Готово · {pages} · {ms} мс',
    'compose.failed': 'Не получилось собрать: {error}',
    'compose.failedKeep': '. Показана последняя удачная версия.',
    'compose.pageAria': 'Страница {i} из {n}',
    'compose.pageLabel': 'Стр. {i} из {n}',
    'compose.pngPage': 'PNG · стр. {i}',
    'compose.svgPage': 'SVG · стр. {i}',
    'compose.missing': 'Не хватает {count}:',
    'compose.andMore': ' и ещё {n}',
    'compose.missingNote': 'Пока их нет, они нарисованы шрифтом — «Показать недостающие» обведёт их на странице.',
    'compose.foreign': 'Этих знаков нет в наборе, их можно только заменить в тексте: {chars}.',
    'compose.modelSends': 'Слова между формулами отправляются модели почерка: {host}.',
    'compose.modelPaused': 'Модель не отвечает — пока слова берутся из ваших образцов, попробуем снова через минуту.',
    'compose.sourceModel': 'из модели',
    'compose.sourceWord': 'целыми словами из ваших образцов',
    'compose.sourceLetters': 'собрано из ваших букв',
    'compose.sourceFallback': 'не из чего (шрифтом)',
    'compose.modelFailures': 'модель не ответила — {times}',
    'compose.sources': 'Слова между формулами: {parts}.',
    'compose.lintSummary': 'Замечания к формулам: {n}',
    'compose.lintAsText': ', записана как текст',
    'compose.lintIn': '{warning} — в {formula}{tail}',
    'compose.coverage': 'Ваших символов: {have} из {total} ({rounds}). Разброс почерка {spread}.',
    'compose.round': 'раунд {round}: {have}/{total}',
    'compose.spreadDefault': 'пока взят по умолчанию — нужно больше повторов',
    'compose.spreadMeasured': 'измерен по вашим повторам',
    'compose.saved': 'Файл {name}',
    'compose.saveFailed': 'Не удалось сохранить: {error}',
    'compose.printPreparing': 'Готовлю страницы…',
    'compose.printPage': 'Страница {i}',
    'compose.printFailed': 'Печать не удалась: {error}',
    'compose.promptCopied': 'Промпт скопирован — вставьте его после своего вопроса',
    'compose.promptSelected': 'Текст промпта выделен — скопируйте его вручную',
    'compose.clipboardEmpty': 'В буфере пусто',
    'compose.clipboardDenied': 'Браузер не дал прочитать буфер — вставьте вручную',
  },

  en: {
    'doc.title': 'Pencora · handwriting collection',
    'doc.description': 'Handwriting sample collection: words from a shared core and math symbols, pen trajectories recorded, works offline, JSON export, solutions rewritten in your own hand.',
    'doc.appTitle': 'Pencora Collect',
    'lang.toggle': 'Interface language',

    // Plurals
    'n.writers': ['{n} writer', '{n} writers'],
    'n.words': ['{n} word', '{n} words'],
    'n.symbols': ['{n} symbol', '{n} symbols'],
    'n.samples': ['{n} sample', '{n} samples'],
    'n.pages': ['{n} page', '{n} pages'],
    'n.points': ['{n} point', '{n} points'],
    'n.times': ['{n} time', '{n} times'],
    'n.people': ['{n} person is already writing', '{n} people are already writing'],
    'n.peopleShort': ['{n} person', '{n} people'],
    'n.missingSymbols': ['{n} symbol', '{n} symbols'],
    'n.fillSymbols': ['Write {n} symbol from the set', 'Write {n} symbols from the set'],

    // Boot
    'boot.failed': 'Could not start',
    'boot.coreFailed': 'Could not load the tasks ({status})',

    // Roster
    'roster.title': 'Handwriting collection',
    'roster.settings': 'Settings',
    'roster.lead': 'Everyone who writes on this device is a separate writer. The tasks come from a shared core ({words}); each writer gets their own order, and it stays the same when the page reloads. Math symbols are collected separately (288 of them, about 560 tasks) — later they can turn a worked solution into your own handwriting.',
    'roster.addWriter': '＋ New writer',
    'roster.empty': 'No writers yet.',
    'roster.emptyHint': 'Everyone who writes on this device is a separate writer, with their own set of words and their own progress.',
    'roster.queued': '{n} queued',
    'roster.allSent': 'all sent',

    // Collection language
    'collect.label': 'Which words to write',
    'collect.aria': 'Language of the words to collect',
    'collect.ru': 'Russian words',
    'collect.en': 'English words',
    'collect.enFailed': 'Could not load the English words — check your connection',

    // Writer card
    'card.noName': 'Unnamed',
    'card.finished': 'Finished',
    'card.joined': 'On the team',
    'card.confirmAge': 'Confirm your age',
    'card.words': 'Words',
    'card.symbols': 'Symbols',
    'card.goal': 'goal: {have} of {goal}',
    'card.sent': 'sent',
    'card.start': 'Start',
    'card.continue': 'Continue',
    'card.glyphs': 'Symbols',
    'card.compose': 'Handwritten solution',
    'card.export': 'Export',
    'card.finish': 'Finish',
    'card.delete': 'Delete',

    // Community
    'community.aria': 'How many people are writing',
    'community.next': 'next model at {target}',
    'community.note': 'Write {goal} words and your handwriting goes into the next model.',
    'community.miniNext': 'model at {target}',
    'community.miniYou': 'your words {have}/{goal}',
    'community.miniJoined': 'you’re in',

    // Celebration
    'celebrate.title': 'You’re in!',
    'celebrate.number': 'Your handwriting is #{n}',
    'celebrate.body': 'Your {goal} words are going into the dataset — the next model will learn from your handwriting too. Feel free to keep writing: every word makes it better.',
    'celebrate.ok': 'Keep going',

    // Consent
    'consent.back': 'Back',
    'consent.title': 'Consent',
    'consent.writer': 'Writer:',
    'consent.update': 'The consent text has been updated: math symbols are now collected as well as words. Please read it and confirm again — everything already written stays as it is.',
    'consent.ageUpdate': 'Please confirm that you are 18 or older: handwriting collection is now for adults only. Everything already written is kept, but it goes to the server only after you confirm.',
    'consent.collectedTitle': 'What is collected',
    'consent.c1': 'The pen trajectory: coordinates, timing, pressure and tilt — that is, <b>how</b> a word is written.',
    'consent.c2': 'Handwritten math symbols and letters as well (digits, Latin and Greek letters, signs, brackets, Cyrillic), if you write them.',
    'consent.c3': 'The word or symbol you were asked to write, and technical details about the screen.',
    'consent.c4': 'An anonymous writer ID — a random number that is not linked to who you are.',
    'consent.notTitle': 'What is not collected',
    'consent.n1': 'Your name, email, phone number, location or the contents of your notes.',
    'consent.n2': 'The writer name in the list stays on this device only.',
    'consent.n3': 'The text of solutions you paste into “Handwritten solution” is not sent to the dataset server. Only if an external handwriting model is set in Settings do the words of a solution (without formulas) go to that model’s address, together with the anonymous writer ID — the solution screen warns you about it.',
    'consent.whyTitle': 'Why',
    'consent.w1': 'The words and symbols are used to train and evaluate models that recognize and generate handwriting (a dataset).',
    'consent.w2': 'Symbols and words are also used <b>locally, on this device</b>, to rewrite solutions in your handwriting. Nothing is sent to the server for that (except to the external handwriting model described above, if you turned it on).',
    'consent.version': 'Consent text version: {v}. Uploading can be turned off in Settings — then everything stays on the device and can be exported as JSON.',
    'consent.agree': 'I agree to the collection and use of this data',
    'consent.adult': 'I am 18 or older',
    'consent.start': 'Start writing',
    'consent.continue': 'Continue',

    // Writing
    'write.back': 'Back to writers',
    'write.syncNow': 'Upload now',
    'write.template': 'Guide on the sheet',
    'write.sheetWord': 'Write the word by hand — the way you usually do',
    'write.sheetGlyph': 'Write the symbol by hand — the way you write it in formulas',
    'write.undo': 'Undo',
    'write.clear': 'Clear',
    'write.skip': 'Skip',
    'write.save': 'Done →',
    'write.allDone': 'All tasks done',
    'write.allDoneHint': 'You can finish the collection and send everything to the server.',
    'write.doneStage': 'Done',
    'write.stage': '{group} · {n} of {total} · packet {packet} ({inPacket}/{packetSize})',
    'write.upper': 'with a <b>capital</b> first letter',
    'write.lower': 'with a <b>lowercase</b> first letter',
    'write.repeat': 'this word came up before — write it as usual, without looking back',
    'write.casePair': 'pairs with the same word in the other case',
    'write.palm': 'This sheet has been written on with a pen — finger touches are ignored',
    'write.hz': '{hz} Hz',
    'write.draftWord': 'Word draft restored',
    'write.draftGlyph': 'Symbol draft restored',

    // Symbols
    'glyph.allDone': 'All symbols written',
    'glyph.allDoneHint': 'Thank you! Now you can rewrite a solution in your own handwriting — “Handwritten solution” in the writer list.',
    'glyph.doneStage': 'Symbols · done',
    'glyph.targetStage': 'Adding symbols for the solution · {i} of {n}',
    'glyph.stage': 'Symbols · round {round} · repeat {rep} · {i} of {total}',
    'glyph.repeat': 'this symbol came up before — write it as usual, without looking back',
    'glyph.filled': 'Symbols added — rebuilding the solution',
    'glyph.loadFailed': 'Could not load the symbol list — check your connection',
    'glyphCat.digit': 'digit',
    'glyphCat.latin_lower': 'Latin, lowercase',
    'glyphCat.latin_upper': 'Latin, capital',
    'glyphCat.greek_lower': 'Greek, lowercase',
    'glyphCat.greek_upper': 'Greek, capital',
    'glyphCat.operator': 'operator',
    'glyphCat.relation': 'relation',
    'glyphCat.delimiter': 'bracket',
    'glyphCat.arrow': 'arrow',
    'glyphCat.set_logic': 'sets and logic',
    'glyphCat.big_operator': 'large operator',
    'glyphCat.calculus': 'calculus',
    'glyphCat.blackboard': 'number set',
    'glyphCat.accent': 'accent',
    'glyphCat.punctuation': 'punctuation',
    'glyphCat.cyrillic_lower': 'Cyrillic, lowercase',
    'glyphCat.cyrillic_upper': 'Cyrillic, capital',
    'glyphCat.misc': 'other',

    // Profile questions
    'q.cursiveTitle': 'One question about you',
    'q.cursiveMessage': 'Do you write in cursive (joined-up letters) without having to think about it?',
    'q.fluent': 'Yes, fluently',
    'q.rusty': 'I can, but haven’t in a long time',
    'q.no': 'No, I print',
    'q.habitTitle': 'And one more',
    'q.habitMessage': 'How do you usually write by hand when nobody asks for anything in particular?',
    'q.printOnly': 'Print only',
    'q.cursiveOnly': 'Cursive only',
    'q.combined': 'I mix both within a word',
    'q.both': 'Either — it depends',

    // Modals
    'modal.ok': 'OK',
    'modal.cancel': 'Cancel',
    'modal.skip': 'Skip',

    // Writer lifecycle
    'writer.newTitle': 'New writer',
    'writer.newMessage': 'A name or label — just so you don’t mix people up. It never goes into the dataset; there a writer is only an anonymous ID.',
    'writer.defaultName': 'Writer {n}',
    'writer.next': 'Next',
    'finish.title': 'Finish collecting',
    'finish.message': 'Everything “{name}” has written stays on the device and will be sent to the server. {queued}You can reopen this writer at any time.',
    'finish.queued': '{n} still queued. ',
    'finish.confirm': 'Finish',
    'finish.done': 'Collection finished',
    'delete.title': 'Delete “{name}”?',
    'delete.what': '{words} and {symbols}',
    'delete.pending': 'This writer has {what}; {pending} of them have not been sent to the server yet and will be lost for good. Better export first.',
    'delete.message': '{what} will be deleted from this device. Whatever was already sent stays on the server.',
    'delete.confirm': 'Delete',
    'rename.title': 'Writer name',
    'rename.message': 'Only visible on this device.',
    'rename.save': 'Save',

    // Export / import
    'export.nothing': 'Nothing to export yet',
    'export.file': 'File {name} · {size}',
    'export.failed': 'Export failed: {error}',
    'import.done': 'Imported: {writers}, {samples}',
    'import.failed': 'Import failed: {error}',
    'import.notJson': 'The file is not JSON',
    'import.notExport': 'This doesn’t look like a Pencora export',
    'import.writerMissing': 'Writer not found',
    'import.defaultLabel': 'Imported',

    // Settings
    'settings.title': 'Settings',
    'settings.back': 'Back',
    'settings.upload': 'Upload to the server',
    'settings.uploadHint': 'Turn off to keep everything on this device and export it as JSON by hand.',
    'settings.composeTitle': 'Handwritten solution',
    'settings.modelUrl': 'Handwriting model (URL)',
    'settings.modelUrlHint': 'Optional. If set, the text between formulas is first requested from this model (POST; the answer is strokes in x-height units, see README). If it doesn’t answer within 2.5 s or fails, the word comes from your own words and letters, as without a model. The words of the solution (without formulas) and the anonymous writer ID are sent to this address.',
    'settings.dataTitle': 'Data',
    'settings.exportAll': 'Export all as JSON',
    'settings.import': 'Import JSON',
    'settings.resend': 'Send everything again',
    'settings.wipe': 'Erase everything',
    'settings.offlineTitle': 'Offline',
    'settings.offline': 'The page works without a connection: the tasks and the app are cached, words pile up in the browser and go to the server by themselves once the connection is back. On iPad and Android you can add the page to the home screen — it then opens like an app, full screen.',
    'stats.writers': 'Writers',
    'stats.words': 'Words on this device',
    'stats.symbols': 'Symbols on this device',
    'stats.unsent': 'Not sent',
    'stats.storage': 'Browser storage used',
    'stats.lastUpload': 'Last upload',
    'stats.server': 'Server',
    'stats.version': 'Version',
    'resend.title': 'Send everything again',
    'resend.message': 'All words and symbols will be queued for upload again. The server treats a repeat as an update of the same record, so nothing is duplicated.',
    'resend.confirm': 'Send',
    'resend.done': 'Everything is queued again',
    'wipe.title': 'Erase all data',
    'wipe.message': 'All writers and all collected words and symbols on this device will be deleted. This cannot be undone.',
    'wipe.confirm': 'Erase everything',
    'wipe.sureTitle': 'Are you sure?',
    'wipe.sureMessage': 'Last check: words and symbols that were not exported will be gone for good.',
    'wipe.sureConfirm': 'Yes, erase',
    'model.badUrl': 'The model address must start with http:// or https://',
    'model.saved': 'Handwriting model saved',
    'model.off': 'Handwriting model turned off',

    // Sync
    'sync.localOnly': 'Local only',
    'sync.offlineQueued': 'Offline · queued',
    'sync.sending': 'Uploading {sent}/{total}',
    'sync.sendingPlain': 'Uploading…',
    'sync.queued': '{n} queued',
    'sync.synced': 'Synced',
    'sync.noNetwork': 'No connection',
    'sync.partial': 'The server didn’t take some samples — will retry later',
    'sync.status': 'Server responded {status}',
    'sync.unreachable': 'Server unreachable',

    // Storage
    'store.blocked': 'The database is busy in another tab',
    'store.aborted': 'Transaction aborted',

    // «Решение почерком» — static
    'compose.title': 'Handwritten solution',
    'compose.intro': 'Ask an AI (ChatGPT, Claude, DeepSeek…) how to solve a problem and add our prompt to your question — the answer then comes back in Markdown with LaTeX formulas, in exactly the markup this page understands. Paste the answer here: it is rewritten by hand with the layout kept and the formulas placed the way LaTeX would set them, but every symbol comes from the ones you wrote yourself, and a little differently each time.',
    'compose.markup': 'Supported: headings <code>#</code> <code>##</code> <code>###</code>, <code>**bold**</code> (heavier pressure), <code>*italic*</code> (more slant), <code>~~strikethrough~~</code>, lists <code>- </code> and <code>1. </code> nested by indentation, tasks <code>- [ ]</code>, quotes <code>&gt; </code>, tables <code>| a | b |</code>, code in <code>```</code>, a divider <code>---</code>, formulas <code>$…$</code> and <code>$$…$$</code>.',
    'compose.copyPrompt': 'Copy the prompt for the AI',
    'compose.promptLang': 'Prompt language',
    'compose.promptText': 'Prompt text',
    'compose.pasteTitle': 'Paste the answer',
    'compose.placeholder': 'The whole AI answer goes here: Markdown and formulas in $…$ or $$…$$',
    'compose.paste': 'Paste from clipboard',
    'compose.clear': 'Clear',
    'compose.hand': 'Handwriting',
    'compose.seedTitle': 'Randomness (seed)',
    'compose.seedHelp': 'The same number gives the same page. A different one gives another “attempt” at writing the same thing.',
    'compose.dice': 'Random seed',
    'compose.reset': 'Reset handwriting settings',
    'compose.page': 'Page',
    'compose.paper': 'Paper',
    'compose.paperGrid': 'Squared',
    'compose.paperLines': 'Lined',
    'compose.paperBlank': 'Blank',
    'compose.ink': 'Ink',
    'compose.inkBlue': 'blue',
    'compose.inkBlack': 'black',
    'compose.inkViolet': 'violet',
    'compose.margin': 'Margin',
    'compose.marginHelp': 'A red margin line on the right, like in a school exercise book.',
    'compose.showMissing': 'Show missing',
    'compose.prev': 'Previous page',
    'compose.next': 'Next page',
    'compose.empty': 'Paste an answer — the page will appear here.',
    'compose.print': 'Print / PDF',
    'compose.json': 'Strokes JSON',
    'compose.fillMissing': 'Write these symbols',
    'compose.openFailed': 'Could not open “Handwritten solution”: {error}',

    // «Решение почерком» — knobs
    'knob.amount': 'Overall messiness',
    'knob.amount.help': 'A multiplier for every slider below: 0 is perfectly neat, 1 is how you write yourself, 2 is twice as messy.',
    'knob.size': 'Size',
    'knob.size.help': 'How much the symbols vary in size from one to the next.',
    'knob.slant': 'Slant',
    'knob.slant.help': 'Spread of slant: some symbols a little steeper, others a little flatter.',
    'knob.baseline': 'Baseline',
    'knob.baseline.help': 'How much the symbols hop above the line and dip below it.',
    'knob.shape': 'Letter shape',
    'knob.shape.help': 'Small smooth distortions of shape: every occurrence of a symbol is slightly different.',
    'knob.spacing': 'Spacing',
    'knob.spacing.help': 'How uneven the gaps between letters and words are.',
    'knob.drift': 'Line drift',
    'knob.drift.help': 'A slow wave along the line: it drifts up and down and slightly changes size and slant.',
    'knob.pressure': 'Pressure',
    'knob.pressure.help': 'Spread of pressure — that is, of how thick the line is.',
    'knob.morph': 'Blending variants',
    'knob.morph.help': 'How often a symbol is a blend of two of your versions rather than one of them as it is.',
    'knob.fit': 'Me ↔ LaTeX',
    'knob.fit.help': 'Left: the proportions of your own symbols; right: every symbol exactly in the box LaTeX gave it.',
    'knob.xh': 'Handwriting size',
    'knob.xh.help': 'Height of lowercase letters as a fraction of a cell: 0.42 is neat school handwriting; more is larger.',
    'knob.endMe': 'like me',
    'knob.endLatex': 'exactly like LaTeX',
    'knob.cells': '{v} of a cell',
    'knob.off': 'off',
    'knob.likeYou': ' · like you',

    // «Решение почерком» — status and panels
    'compose.busy': 'Composing…',
    'compose.ready': 'Done · {pages} · {ms} ms',
    'compose.failed': 'Couldn’t compose: {error}',
    'compose.failedKeep': '. Showing the last good version.',
    'compose.pageAria': 'Page {i} of {n}',
    'compose.pageLabel': 'Page {i} of {n}',
    'compose.pngPage': 'PNG · p. {i}',
    'compose.svgPage': 'SVG · p. {i}',
    'compose.missing': 'Missing {count}:',
    'compose.andMore': ' and {n} more',
    'compose.missingNote': 'Until you write them they are drawn in a font — “Show missing” circles them on the page.',
    'compose.foreign': 'These characters are not in the set; they can only be replaced in the text: {chars}.',
    'compose.modelSends': 'The words between formulas are sent to the handwriting model: {host}.',
    'compose.modelPaused': 'The model isn’t answering — for now the words come from your samples; it will be tried again in a minute.',
    'compose.sourceModel': 'from the model',
    'compose.sourceWord': 'whole words from your samples',
    'compose.sourceLetters': 'assembled from your letters',
    'compose.sourceFallback': 'nothing to build from (typeset)',
    'compose.modelFailures': 'the model didn’t answer — {times}',
    'compose.sources': 'Words between formulas: {parts}.',
    'compose.lintSummary': 'Notes on formulas: {n}',
    'compose.lintAsText': ', written out as text',
    'compose.lintIn': '{warning} — in {formula}{tail}',
    'compose.coverage': 'Your symbols: {have} of {total} ({rounds}). Handwriting spread {spread}.',
    'compose.round': 'round {round}: {have}/{total}',
    'compose.spreadDefault': 'is the default for now — more repeats needed',
    'compose.spreadMeasured': 'is measured from your repeats',
    'compose.saved': 'File {name}',
    'compose.saveFailed': 'Couldn’t save: {error}',
    'compose.printPreparing': 'Preparing pages…',
    'compose.printPage': 'Page {i}',
    'compose.printFailed': 'Printing failed: {error}',
    'compose.promptCopied': 'Prompt copied — paste it after your question',
    'compose.promptSelected': 'The prompt text is selected — copy it by hand',
    'compose.clipboardEmpty': 'The clipboard is empty',
    'compose.clipboardDenied': 'The browser wouldn’t let the page read the clipboard — paste by hand',
  },
};

// Applied at import, before app.js builds anything: a page that loads in
// English never shows Russian chrome once the boot screen lifts.
if (typeof document !== 'undefined') applyStatic();
