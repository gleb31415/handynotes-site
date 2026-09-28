// Pasted solutions: turn whatever a chatbot answered — a full Markdown
// document with LaTeX formulas — into blocks the page compositor lays out in
// the writer's hand: paragraphs of styled text and inline math, display
// formulas, headings, (nested) list items, block quotes, tables, code blocks,
// rules and gaps.
//
// The writer is supposed to append our prompt (CHATGPT_PROMPT_RU/EN), which
// asks for exactly the Markdown + LaTeX subset below. In practice people
// forget it, paste from the copy button (which turns math into `\(…\)` /
// `\[…\]`), or paste text with `x²` and `√2` typed as Unicode. None of that may
// break the page: the worst case is a paragraph of plain text, never an
// exception.
//
// Pure (no DOM, no fetch) and importable from Node.
//
// How it works, in three passes:
//  1. Normalise the text (newlines, NBSP, zero-width, control and private-use
//     chars, HTML entities, <br>), cut out ``` fences (math fences become
//     display formulas, others code blocks) and pipe tables.
//  2. Scan each remaining segment left to right. Every math span (and every
//     piece of text that must stay literal, like `\$` or inline code) is
//     stored in `pieces` and replaced by ONE private-use placeholder char.
//     Multi-line math (`$$` on its own lines, `\[`, bare `\begin{align*}`) is
//     found by searching forward for its closer, so the lines inside a formula
//     are never mistaken for Markdown bullets or headings. Markdown line
//     prefixes (`>`, `#`, `-`, `1.`) and the indentation before them are
//     recorded at each physical line start.
//  3. Per logical line, turn inline Markdown (bold, italics, strikethrough,
//     links, tags, emoji) and Unicode math on the masked string into style
//     markers and pieces — placeholders are opaque single chars, so
//     `**Ответ: $x=2$**` is just `**Ответ: \ue000**` — split it back into
//     styled runs and display blocks, and hang each block in its container:
//     the list item it is indented under (or lazily follows) and its quote.

// MARK: Supported LaTeX

/// Commands our layout draws well and the writer's glyph corpus covers. The
/// prompt steers the chatbot into this subset, and `lintLatex` warns about
/// anything outside it. Everything here renders in the vendored KaTeX
/// (checked by scripts/handwriting-tests/solution.test.mjs).
export const SUPPORTED_COMMANDS = Object.freeze([
  // structure
  '\\frac', '\\dfrac', '\\tfrac', '\\sqrt', '\\binom',
  '\\left', '\\right', '\\middle', '\\big', '\\Big', '\\bigg', '\\Bigg',
  '\\bigl', '\\bigr', '\\Bigl', '\\Bigr',
  '\\begin', '\\end', '\\text', '\\mathrm', '\\mathbf', '\\mathit', '\\mathbb',
  '\\mathcal', '\\operatorname', '\\limits', '\\quad', '\\qquad',
  // accents
  '\\vec', '\\hat', '\\bar', '\\tilde', '\\dot', '\\ddot', '\\overline', '\\underline',
  // functions
  '\\sin', '\\cos', '\\tan', '\\cot', '\\tg', '\\ctg', '\\sec', '\\csc',
  '\\arcsin', '\\arccos', '\\arctan', '\\arctg', '\\arcctg',
  '\\sinh', '\\cosh', '\\tanh', '\\sh', '\\ch', '\\th',
  '\\log', '\\ln', '\\lg', '\\exp', '\\lim', '\\min', '\\max', '\\sup', '\\inf',
  '\\det', '\\gcd', '\\deg', '\\arg', '\\mod', '\\bmod', '\\pmod',
  // Greek
  '\\alpha', '\\beta', '\\gamma', '\\delta', '\\epsilon', '\\varepsilon', '\\zeta',
  '\\eta', '\\theta', '\\vartheta', '\\iota', '\\kappa', '\\lambda', '\\mu', '\\nu',
  '\\xi', '\\pi', '\\varpi', '\\rho', '\\varrho', '\\sigma', '\\varsigma', '\\tau',
  '\\upsilon', '\\phi', '\\varphi', '\\chi', '\\psi', '\\omega',
  '\\Gamma', '\\Delta', '\\Theta', '\\Lambda', '\\Xi', '\\Pi', '\\Sigma',
  '\\Upsilon', '\\Phi', '\\Psi', '\\Omega',
  // operators
  '\\times', '\\cdot', '\\div', '\\pm', '\\mp', '\\circ', '\\oplus', '\\otimes',
  '\\setminus',
  // relations
  '\\ne', '\\neq', '\\approx', '\\equiv', '\\sim', '\\simeq', '\\cong',
  '\\le', '\\leq', '\\ge', '\\geq', '\\leqslant', '\\geqslant', '\\ll', '\\gg',
  '\\propto', '\\mid', '\\nmid', '\\parallel', '\\perp', '\\not',
  '\\in', '\\notin', '\\ni', '\\subset', '\\supset', '\\subseteq', '\\supseteq',
  // arrows
  '\\to', '\\rightarrow', '\\leftarrow', '\\gets', '\\leftrightarrow',
  '\\Rightarrow', '\\Leftarrow', '\\Leftrightarrow', '\\implies', '\\iff',
  '\\longrightarrow', '\\Longrightarrow', '\\mapsto',
  '\\uparrow', '\\downarrow', '\\nearrow', '\\searrow',
  // sets and logic
  '\\cup', '\\cap', '\\bigcup', '\\bigcap', '\\varnothing', '\\emptyset',
  '\\forall', '\\exists', '\\nexists', '\\neg', '\\lnot', '\\land', '\\lor',
  '\\wedge', '\\vee',
  // big operators and calculus
  '\\sum', '\\prod', '\\int', '\\iint', '\\iiint', '\\oint',
  '\\infty', '\\partial', '\\nabla', '\\prime', '\\surd',
  // delimiters
  '\\langle', '\\rangle', '\\lfloor', '\\rfloor', '\\lceil', '\\rceil',
  '\\vert', '\\Vert', '\\lvert', '\\rvert', '\\lVert', '\\rVert',
  // misc
  '\\ldots', '\\cdots', '\\dots', '\\vdots', '\\ddots',
  '\\angle', '\\triangle', '\\degree', '\\ell', '\\hbar',
]);

/// Environments KaTeX renders that our layout handles. `align`/`equation`
/// and friends never reach the layout: `cleanLatex` rewrites them.
export const SUPPORTED_ENVIRONMENTS = Object.freeze([
  'aligned', 'alignedat', 'gathered', 'cases', 'matrix', 'pmatrix', 'bmatrix',
  'vmatrix', 'Bmatrix', 'Vmatrix', 'smallmatrix',
]);

const SUPPORTED_SET = new Set(SUPPORTED_COMMANDS.map((c) => c.slice(1)));
const SUPPORTED_ENV_SET = new Set(SUPPORTED_ENVIRONMENTS);

/// One-character control symbols (`\,`, `\{`, `\\` …) are always fine.
const CONTROL_SYMBOLS = new Set([',', ';', ':', '!', ' ', '{', '}', '|', '\\', '%', '$', '#', '&', '_']);

// MARK: The prompt

/// What the writer appends to their own question (ChatGPT, Claude, DeepSeek…).
/// It names exactly what the page renders: the Markdown this parser turns into
/// notebook layout and the LaTeX subset the glyph corpus covers. Every LaTeX
/// command it names is in SUPPORTED_COMMANDS and every environment in
/// SUPPORTED_ENVIRONMENTS (the test checks), and every command it forbids is
/// not. People paste it every time, so it stays short.
export const CHATGPT_PROMPT_RU = [
  'Оформи ответ по этим правилам — его перепишут от руки в тетрадь, сохранив разметку:',
  '— Markdown: заголовки #, ## и ###; **жирный**, *курсив*, ~~зачёркнутый~~; списки «- » и «1. »; вложенный пункт и всё, что относится к пункту (формула, пояснение), — с отступом 3 пробела; цитаты «> »; таблицы | a | b | со строкой |---|; разделитель ---; код в ```;',
  '— формулы в строке пиши в $...$, отдельные формулы — в $$...$$ на отдельной строке;',
  '— в LaTeX используй только: \\frac \\sqrt ^ _ \\cdot \\times \\div \\pm \\le \\ge \\ne \\approx \\equiv \\infty \\int \\sum \\lim \\to \\Rightarrow \\Leftrightarrow \\in \\notin \\subset \\cup \\cap \\varnothing \\forall \\exists \\sin \\cos \\tg \\ctg \\log \\ln \\left( \\right) \\vec \\overline \\mathbb{R} \\text{…}, греческие буквы, \\begin{cases}, \\begin{aligned} и \\begin{pmatrix} (внутри $$);',
  '— не используй \\displaystyle, \\boxed, \\color, \\tag, \\label, \\newcommand, \\begin{align}, длинный \\text{…}, \\( \\) и \\[ \\], HTML, ссылки, картинки и эмодзи;',
  '— в ячейках таблицы — короткий текст и формулы в $...$, без $$ и переносов строк; не больше 5 столбцов;',
  '— не больше двух уровней вложенности списков; короткие строки и абзацы, как в тетради;',
  '— \\cdot ставь только там, где его поставил бы ученик: 2x, а не 2\\cdot x;',
  '— последняя строка: «**Ответ:** …»;',
  '— пиши на русском, если вопрос на русском;',
  '— пиши так, как записал бы решение ученик, без замечаний об оформлении;',
  '— если ответ длинный — не сокращай решение, но не добавляй лишних пояснений.',
].join('\n');

export const CHATGPT_PROMPT_EN = [
  'Format the answer by these rules — it will be copied by hand into a notebook, keeping the layout:',
  '- Markdown: headings #, ## and ###; **bold**, *italic*, ~~strikethrough~~; lists "- " and "1. "; indent a nested item and everything that belongs to an item (a formula, a remark) by 3 spaces; quotes "> "; tables | a | b | with a |---| row; a --- rule; code in ```;',
  '- inline math in $...$, standalone formulas in $$...$$ on their own line;',
  '- in LaTeX use only: \\frac \\sqrt ^ _ \\cdot \\times \\div \\pm \\le \\ge \\ne \\approx \\equiv \\infty \\int \\sum \\lim \\to \\Rightarrow \\Leftrightarrow \\in \\notin \\subset \\cup \\cap \\varnothing \\forall \\exists \\sin \\cos \\tan \\log \\ln \\left( \\right) \\vec \\overline \\mathbb{R} \\text{…}, Greek letters, \\begin{cases}, \\begin{aligned} and \\begin{pmatrix} (inside $$);',
  '- never use \\displaystyle, \\boxed, \\color, \\tag, \\label, \\newcommand, \\begin{align}, long \\text{…}, \\( \\) or \\[ \\], HTML, links, images or emojis;',
  '- table cells hold short text and $...$ math only, no $$ and no line breaks; at most 5 columns;',
  '- at most two levels of nested lists; short lines and paragraphs, like in a notebook;',
  '- use \\cdot only where a student would: 2x, not 2\\cdot x;',
  '- the last line: "**Answer:** …";',
  '- write in the language of my question;',
  '- write it the way a student would, with no remarks about formatting;',
  '- if the answer is long, don\'t shorten the solution, but don\'t add extra explanations.',
].join('\n');

// MARK: Lint

/// Warnings (Russian, shown to the writer) about LaTeX our layout may not
/// draw: commands and environments outside the supported subset, unbalanced
/// braces, `\left` without `\right`. Never throws.
export function lintLatex(latex) {
  const warnings = [];
  const add = (w) => { if (!warnings.includes(w)) warnings.push(w); };
  const s = String(latex ?? '');
  let depth = 0;
  let lefts = 0;
  let rights = 0;
  const envStack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') { depth++; continue; }
    if (c === '}') {
      if (depth === 0) add('лишняя закрывающая скобка «}»');
      else depth--;
      continue;
    }
    if (c !== '\\') continue;
    const m = /^[A-Za-z]+\*?/.exec(s.slice(i + 1));
    if (!m) {
      const sym = s[i + 1];
      if (sym !== undefined && !CONTROL_SYMBOLS.has(sym) && !'()[]'.includes(sym)) {
        add(`неподдерживаемая команда \\${sym}`);
      }
      i++; // skip the escaped char so `\{` isn't counted as a brace
      continue;
    }
    const name = m[0];
    i += name.length;
    if (name === 'left') lefts++;
    else if (name === 'right') rights++;
    if (name === 'begin' || name === 'end') {
      const env = /^\s*\{([^{}]*)\}/.exec(s.slice(i + 1));
      if (!env) continue;
      const envName = env[1].trim();
      if (name === 'begin') {
        envStack.push(envName);
        if (!SUPPORTED_ENV_SET.has(envName)) add(`неподдерживаемое окружение ${envName}`);
      } else if (envStack.length && envStack[envStack.length - 1] === envName) {
        envStack.pop();
      } else {
        add(`\\end{${envName}} без \\begin{${envName}}`);
      }
      i += env[0].length; // the env name is not a brace group to count
      continue;
    }
    if (!SUPPORTED_SET.has(name)) add(`неподдерживаемая команда \\${name}`);
  }
  if (depth > 0) add('не закрыта фигурная скобка «{»');
  if (lefts > rights) add('\\left без парного \\right');
  if (rights > lefts) add('\\right без парного \\left');
  for (const env of envStack) add(`\\begin{${env}} без \\end{${env}}`);
  return warnings;
}

// MARK: Parse

/// Pasted answer → blocks.
///   Block = {type:'para', runs}
///         | {type:'display', latex}
///         | {type:'heading', level /* 1…6 */, runs}
///         | {type:'item', marker /* '—' | '1.' | '2)' … */, ordered, task? /* 'open'|'done' */, runs}
///         | {type:'table', align: ('left'|'center'|'right'|null)[], header: Cell[] | null, rows: Cell[][]}
///         | {type:'code', lang, lines: string[]}
///         | {type:'rule'}
///         | {type:'gap'}
///   Cell  = Run[]
///   Run   = {type:'text', text, bold?, italic?, strike?, code?}
///         | {type:'math', latex, display?, bold?, strike?}
/// Blocks other than gap and rule carry where they hang, when it isn't the
/// page itself: `depth` — how many list items they are nested in (an item
/// counts itself, so a top-level item has depth 1, and a formula indented
/// under it has depth 1 too) — and `quote`, how many `>` they are under.
/// Both are left out when 0; style flags are left out when false.
///
/// Every non-empty source line becomes its own block — a notebook keeps the
/// author's line breaks. Blank lines become ONE gap, never at the start or
/// the end; a heading always gets one before it. Chatbots surround formulas
/// with blank lines inconsistently, so around a display formula the gap
/// follows the notebook instead: none before it (a student writes the formula
/// right under «Найдём дискриминант:»), and after it only when the next line
/// starts something new — a capital letter, a digit or a dash — not when it
/// continues the sentence («где $C$ — …»). A rule separates by itself and
/// needs no gap around it.
export function parseSolution(text) {
  let normalized = '';
  try {
    normalized = normalizeInput(text);
    const pieces = [];
    const lines = [];
    for (const segment of splitFences(normalized)) {
      if (segment.type === 'display') {
        lines.push({ ...emptyLine(segment.indent), s: addPiece(pieces, { type: 'math', latex: segment.latex, display: true }) });
      } else if (segment.type === 'code') {
        lines.push({ ...emptyLine(segment.indent), kind: 'code', code: { lang: segment.lang, lines: segment.lines } });
      } else {
        for (const chunk of splitTables(segment.lines)) {
          if (chunk.type === 'table') lines.push({ ...emptyLine(chunk.indent), kind: 'table', table: chunk });
          else scanSegment(chunk.lines.join('\n'), pieces, lines);
        }
      }
    }
    return buildBlocks(lines, pieces);
  } catch (error) {
    // Never throw: whatever we understood is lost, but the words aren't.
    const plain = (normalized || String(text ?? '')).split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
    const blocks = [];
    for (const line of plain) {
      if (line) blocks.push({ type: 'para', runs: [{ type: 'text', text: line }] });
      else if (blocks.length && blocks[blocks.length - 1].type !== 'gap') blocks.push({ type: 'gap' });
    }
    while (blocks.length && blocks[blocks.length - 1].type === 'gap') blocks.pop();
    return blocks;
  }
}

/// Every formula in `blocks` — paragraphs, items, headings, table cells and
/// display blocks — as {latex, display}, in reading order.
export function formulasOf(blocks) {
  const out = [];
  const fromRuns = (runs) => {
    for (const r of runs ?? []) if (r?.type === 'math') out.push({ latex: r.latex, display: !!r.display });
  };
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b) continue;
    if (b.type === 'display') out.push({ latex: b.latex, display: true });
    else if (b.type === 'table') [b.header ?? [], ...(b.rows ?? [])].forEach((row) => row.forEach(fromRuns));
    else fromRuns(b.runs);
  }
  return out;
}

function emptyLine(indent = 0) {
  return { s: '', kind: 'text', indent, quote: 0 };
}

// MARK: 1. Normalisation, fences and tables

const ENTITIES = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', minus: '−',
  times: '×', divide: '÷', le: '≤', ge: '≥', ne: '≠', plusmn: '±', middot: '·',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', deg: '°',
  sup2: '²', sup3: '³', radic: '√', infin: '∞', pi: 'π', asymp: '≈',
};

function normalizeInput(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    // One pass, so `&amp;lt;` becomes `&lt;` and not `<`.
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[name.toLowerCase()] ?? m;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[     \t]/g, ' ')
    // Zero-width chars, soft hyphen, BOM, C0 controls — and the private-use
    // range: this module uses controls as style markers and private-use
    // chars as placeholders, so neither can be forged by the text.
    .replace(/[​‌‍⁠﻿­-\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/// ``` or ~~~ fences. Math fences (and unlabeled ones that are clearly LaTeX)
/// become display formulas — one per blank-line-separated chunk; any other
/// fence is a code block, kept verbatim. Both remember how far the fence was
/// indented, so a fence inside a list item stays in it.
function splitFences(text) {
  const out = [];
  const lines = text.split('\n');
  let buffer = [];
  const flush = () => { if (buffer.length) out.push({ type: 'text', lines: buffer }); buffer = []; };
  for (let i = 0; i < lines.length; i++) {
    const open = /^([ \t]*)(`{3,}|~{3,})[ \t]*([\w+#.-]*)/.exec(lines[i]);
    if (!open) { buffer.push(lines[i]); continue; }
    flush();
    const indent = open[1].length;
    const fence = open[2];
    const lang = open[3].toLowerCase();
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break;
      // Dedent by the fence's own indentation, never into the content.
      body.push(lines[j].replace(new RegExp(`^[ \\t]{0,${indent}}`), '').replace(/[ \t]+$/, ''));
    }
    i = j; // the closing fence (or the end, for an unclosed one)
    const content = body.join('\n');
    const isMath = MATH_FENCES.has(lang) ||
      ((lang === '' || lang === 'text' || lang === 'plaintext') && looksLikeLatexBlock(content));
    if (isMath) {
      for (const chunk of content.split(/\n[ \t]*\n/)) {
        const latex = stripMathDelimiters(chunk);
        if (latex) out.push({ type: 'display', latex: cleanLatex(latex, true), indent });
      }
    } else {
      while (body.length && !body[0].trim()) body.shift();
      while (body.length && !body[body.length - 1].trim()) body.pop();
      if (body.length) out.push({ type: 'code', lang, lines: body, indent });
    }
  }
  flush();
  return out;
}

const MATH_FENCES = new Set(['latex', 'tex', 'math', 'katex', 'amsmath', 'mathjax']);

function looksLikeLatexBlock(content) {
  return /\\[A-Za-z]+|[\^_]\{/.test(content) &&
    !/\b(def|return|import|function|console|print)\b|;\s*$/m.test(content);
}

/// A fenced formula sometimes still carries its own `$$`/`\[` delimiters.
function stripMathDelimiters(chunk) {
  let s = chunk.trim();
  for (const [a, b] of [['$$', '$$'], ['\\[', '\\]'], ['\\(', '\\)'], ['$', '$']]) {
    if (s.length > a.length + b.length && s.startsWith(a) && s.endsWith(b)) {
      s = s.slice(a.length, s.length - b.length).trim();
      break;
    }
  }
  return s;
}

const isTableRow = (l) => /^[ \t]*\|/.test(l);
const isTableSep = (l) => /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(l) && l.includes('|') && l.includes('-');

/// Markdown pipe tables are cut out of a text segment: [{type:'text', lines}
/// | {type:'table', indent, align, header, rows}], cells still as source
/// text. The separator row is what makes it a table: a line like `|x| = 2`
/// alone is not one. The row just above the separator is the header.
function splitTables(lines) {
  const out = [];
  let text = [];
  const flush = () => { if (text.length) out.push({ type: 'text', lines: text }); text = []; };
  for (let i = 0; i < lines.length; i++) {
    if (!isTableRow(lines[i])) { text.push(lines[i]); continue; }
    let j = i;
    while (j < lines.length && (isTableRow(lines[j]) || isTableSep(lines[j]))) j++;
    const group = lines.slice(i, j);
    i = j - 1;
    const sep = group.findIndex(isTableSep);
    if (sep < 0) { text.push(...group); continue; }
    flush();
    const cells = (row) => splitCells(row).map((c) => c.trim());
    const align = cells(group[sep]).map((c) => {
      const left = c.startsWith(':'), right = c.endsWith(':');
      return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
    });
    const above = group.slice(0, sep).map(cells);
    const below = group.slice(sep + 1).filter((row) => !isTableSep(row)).map(cells);
    out.push({
      type: 'table', indent: /^[ \t]*/.exec(group[0])[0].length, align,
      header: above.length ? above[above.length - 1] : null,
      rows: [...above.slice(0, -1), ...below],
    });
  }
  flush();
  return out;
}

/// Split a table row on `|`, but not inside `$…$` or on an escaped `\|`.
function splitCells(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inMath = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === '$') inMath = !inMath;
    if (c === '|' && !inMath) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells;
}

// MARK: 2. Scanner

/// Placeholders are single private-use chars, U+E000 + index. Input has had
/// that range stripped, so a placeholder can never be forged by the text.
const PH_BASE = 0xe000;
const PH_MAX = 0xf8ff - PH_BASE;
const PH_RE = /[\ue000-\uf8ff]/;

function addPiece(pieces, piece) {
  if (pieces.length > PH_MAX) {
    // Absurdly long input: stop masking and keep the source text as is.
    return piece.type === 'lit' ? piece.text : piece.display ? ` $$${piece.latex}$$ ` : `$${piece.latex}$`;
  }
  pieces.push(piece);
  return String.fromCharCode(PH_BASE + pieces.length - 1);
}

function mathPiece(pieces, latex, display) {
  const clean = cleanLatex(latex, display);
  return clean ? addPiece(pieces, { type: 'math', latex: clean, display }) : '';
}

function isEscaped(s, i) {
  let n = 0;
  while (i - 1 - n >= 0 && s[i - 1 - n] === '\\') n++;
  return n % 2 === 1;
}

/// Next unescaped `closer` at or after `from`, or -1. Math never spans a
/// blank line (in LaTeX that's a `\par`, an error in math mode), so a closer
/// beyond one belongs to something else.
function findCloser(s, from, closer) {
  let i = from;
  const para = s.slice(from).search(/\n[ \t]*\n/);
  const limit = para < 0 ? s.length : from + para;
  while (i < limit) {
    const k = s.indexOf(closer, i);
    if (k < 0 || k >= limit) return -1;
    // For `\]` / `\)` the backslash itself must not be escaped; for `$` the dollar.
    if (!isEscaped(s, k)) return k;
    i = k + 1;
  }
  return -1;
}

/// The matching `\end{env}` for a `\begin{env}` whose name ends at `from`,
/// counting nested environments of the same name. Returns the index just past
/// it, or -1.
function findEnvEnd(s, from, env) {
  const para = s.slice(from).search(/\n[ \t]*\n/);
  const limit = para < 0 ? s.length : from + para;
  const re = /\\(begin|end)\s*\{([^{}]*)\}/g;
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(s)) && m.index < limit) {
    if (m[2].trim() !== env) continue;
    depth += m[1] === 'begin' ? 1 : -1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/// Commands we rescue as inline math when a chatbot forgot the delimiters
/// ("где \alpha — угол"): anything we support plus the LaTeX that `cleanLatex`
/// knows how to tidy.
const RESCUE = new Set([...SUPPORTED_SET, 'displaystyle', 'boxed']);
for (const structural of ['begin', 'end', 'left', 'right', 'middle', 'limits']) RESCUE.delete(structural);

/// Scans `src` into logical lines appended to `out`:
///   { s /* masked text */, kind: 'text'|'heading'|'item'|'hr', indent, quote,
///     level? (heading), marker?, ordered?, task? (item) }
/// With `prefixes: false` (a table cell) no Markdown line prefix is read.
function scanSegment(src, pieces, out, { prefixes = true } = {}) {
  let cur = emptyLine();
  let quoted = false;
  let pos = 0;
  let lineStart = true;
  const n = src.length;

  while (pos < n) {
    if (lineStart) {
      lineStart = false;
      let eol = src.indexOf('\n', pos);
      if (eol < 0) eol = n;
      const pre = prefixes ? linePrefix(src.slice(pos, eol))
        : { kind: 'text', indent: 0, quote: 0, consumed: /^[ \t]*/.exec(src.slice(pos, eol))[0].length };
      quoted = pre.quote > 0;
      const { consumed, ...info } = pre;
      Object.assign(cur, info);
      if (pre.kind === 'hr') { pos = eol; continue; }
      pos += consumed;
      // A line that is nothing but LaTeX, written without delimiters.
      const rest = src.slice(pos, eol);
      if (isBareLatexLine(rest)) {
        cur.s += mathPiece(pieces, rest, pre.kind === 'text');
        pos = eol;
      }
      continue;
    }

    const c = src[pos];
    if (c === '\n') {
      out.push(cur);
      cur = emptyLine();
      pos++;
      lineStart = true;
      continue;
    }

    if (c === '$') {
      if (src[pos + 1] === '$') {
        const close = findCloser(src, pos + 2, '$$');
        if (close >= 0) {
          cur.s += mathPiece(pieces, unquote(src.slice(pos + 2, close), quoted), true);
          pos = close + 2;
        } else {
          cur.s += addPiece(pieces, { type: 'lit', text: '$$' });
          pos += 2;
        }
        continue;
      }
      const m = inlineDollar(src, pos);
      if (m) {
        cur.s += mathPiece(pieces, m.latex, false);
        pos = m.end;
      } else {
        cur.s += addPiece(pieces, { type: 'lit', text: '$' });
        pos++;
      }
      continue;
    }

    if (c === '`') {
      let ticks = 1;
      while (src[pos + ticks] === '`') ticks++;
      const fence = '`'.repeat(ticks);
      let eol = src.indexOf('\n', pos);
      if (eol < 0) eol = n;
      const close = src.indexOf(fence, pos + ticks);
      if (close >= 0 && close < eol) {
        const code = src.slice(pos + ticks, close).trim();
        const dollars = /^\$\$?([\s\S]+?)\$?\$$/.exec(code);
        if (dollars) cur.s += mathPiece(pieces, dollars[1], false);
        else if (looksLikeMathCode(code)) cur.s += mathPiece(pieces, code, false);
        else if (code) cur.s += addPiece(pieces, { type: 'lit', text: code, code: true });
        pos = close + ticks;
      } else {
        pos += ticks; // a stray backtick can't be handwritten usefully
      }
      continue;
    }

    if (c === '\\') {
      const next = src[pos + 1];
      if (next === '(' || next === '[') {
        const closer = next === '(' ? '\\)' : '\\]';
        const close = findCloser(src, pos + 2, closer);
        if (close >= 0) {
          cur.s += mathPiece(pieces, unquote(src.slice(pos + 2, close), quoted), next === '[');
          pos = close + 2;
        } else {
          cur.s += next;
          pos += 2;
        }
        continue;
      }
      if (next === '\\') { pos += 2; continue; } // a LaTeX line break in running text
      if (next === '$') { cur.s += addPiece(pieces, { type: 'lit', text: '$' }); pos += 2; continue; }
      if (next !== undefined && '*_#>-+.!|[](){}~`&%'.includes(next)) {
        cur.s += addPiece(pieces, { type: 'lit', text: next });
        pos += 2;
        continue;
      }
      const name = /^[A-Za-z]+/.exec(src.slice(pos + 1, pos + 40));
      if (name && name[0] === 'begin') {
        const env = /^\\begin\s*\{([^{}]*)\}/.exec(src.slice(pos, pos + 80));
        if (env) {
          const end = findEnvEnd(src, pos + env[0].length, env[1].trim());
          if (end >= 0) {
            cur.s += mathPiece(pieces, unquote(src.slice(pos, end), quoted), true);
            pos = end;
            continue;
          }
        }
      }
      if (name && RESCUE.has(name[0])) {
        const end = bareCommandEnd(src, pos);
        cur.s += mathPiece(pieces, src.slice(pos, end), false);
        pos = end;
        continue;
      }
      cur.s += c;
      pos++;
      continue;
    }

    cur.s += c;
    pos++;
  }
  out.push(cur);
}

/// Markdown at the start of a physical line (outside math): quote markers
/// (`quote` = how many), then the indentation (`indent`, in spaces) and a
/// heading, rule, bullet (task box), or numbered item marker.
function linePrefix(line) {
  let consumed = 0;
  let quote = 0;
  const q = /^[ \t]*(?:>[ \t]?)+/.exec(line);
  if (q) { consumed = q[0].length; quote = q[0].split('>').length - 1; }
  const rest = line.slice(consumed);
  if (/^[ \t]*([-*_=])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) return { kind: 'hr', indent: 0, quote, consumed: line.length };
  const indent = /^[ \t]*/.exec(rest)[0].length;
  consumed += indent;
  const body = rest.slice(indent);
  let m;
  if ((m = /^(#{1,6})(?:[ \t]+|$)/.exec(body))) {
    return { kind: 'heading', level: m[1].length, indent, quote, consumed: consumed + m[0].length };
  }
  // `+` is not a bullet here: a line starting with «+ 2x» continues an expression.
  if ((m = /^[-*•●▪◦‣](?:[ \t]+\[([ xX])\])?[ \t]+/.exec(body))) {
    const task = m[1] === undefined ? {} : { task: m[1] === ' ' ? 'open' : 'done' };
    return { kind: 'item', marker: '—', ordered: false, ...task, indent, quote, consumed: consumed + m[0].length };
  }
  if ((m = /^(\d{1,3}[.)])[ \t]+/.exec(body))) {
    return { kind: 'item', marker: m[1], ordered: true, indent, quote, consumed: consumed + m[0].length };
  }
  return { kind: 'text', indent, quote, consumed };
}

/// Lines of a multi-line formula inside a Markdown quote carry `>` markers.
function unquote(latex, quoted) {
  return quoted ? latex.replace(/\n[ \t]*(?:>[ \t]?)+/g, '\n') : latex;
}

/// `$…$` starting at `pos` → {latex, end} or null when this `$` is literal.
/// A price ("стоит 5$", "$5 и $10") must stay text: the closer has to be on
/// the same line, not followed by a digit, and the content must not read as
/// words. Tight `$x$` is the norm; `$ x $` with spaces is accepted only when
/// the content is unmistakably LaTeX.
function inlineDollar(src, pos) {
  let eol = src.indexOf('\n', pos);
  if (eol < 0) eol = src.length;
  let k = pos + 1;
  for (;;) {
    k = src.indexOf('$', k);
    if (k < 0 || k >= eol) return null;
    if (!isEscaped(src, k)) break;
    k++;
  }
  const content = src.slice(pos + 1, k);
  if (!content.trim()) return null;
  const tight = !/^\s/.test(content) && !/\s$/.test(content) && !/\d/.test(src[k + 1] ?? '');
  const mathy = /[\\^_{}=]/.test(content);
  if (!(tight || mathy)) return null;
  if (looksLikeProse(content)) return null;
  return { latex: content, end: k + 1 };
}

/// "5 долларов, а вторая 7" or "5 and" — several words, nothing LaTeX about
/// them. A tight single token (`$ABC$`, `$АВ$`) is never prose.
function looksLikeProse(content) {
  if (/[\\^_{}=]/.test(content)) return false;
  const c = content.trim();
  if (!/\s/.test(c)) return false;
  const words = c.match(/[A-Za-zА-Яа-яЁё]+/g) || [];
  return words.some((w) => /[А-Яа-яЁё]/.test(w) || (w.length >= 3 && !FUNCTION_NAMES.has(w.toLowerCase()))) ||
    (/^\d/.test(c) && words.length > 0);
}

/// Inline code that is really a formula (`x^2 + 1`, `\frac{a}{b}`, `f(x)=2x`).
function looksLikeMathCode(code) {
  if (/\\[A-Za-z]+/.test(code) || /[\^_]/.test(code)) {
    return !/\b(def|return|import|print|function)\b|[;"']/.test(code);
  }
  if (!/[=<>+]/.test(code)) return false;
  const words = code.match(/[A-Za-z]+/g) || [];
  return /^[\w\s().,+\-*/=<>]+$/.test(code) && words.every((w) => w.length <= 3);
}

/// A bare `\cmd` in text plus what it obviously owns: `[…]`, `{…}` groups and
/// trailing scripts. Returns the index after it.
function bareCommandEnd(s, pos) {
  let i = pos + 1;
  while (i < s.length && /[A-Za-z]/.test(s[i])) i++;
  for (;;) {
    if (s[i] === '[' && s.slice(pos, i) === '\\sqrt') {
      const close = s.indexOf(']', i);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    if (s[i] === '{') {
      const close = groupEnd(s, i);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    if ((s[i] === '^' || s[i] === '_') && i + 1 < s.length) {
      if (s[i + 1] === '{') {
        const close = groupEnd(s, i + 1);
        if (close < 0) break;
        i = close + 1;
      } else if (/[\w]/.test(s[i + 1])) {
        i += 2;
      } else break;
      continue;
    }
    break;
  }
  return i;
}

/// Index of the `}` closing the group that opens at `open`, or -1.
function groupEnd(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/// A whole line that is LaTeX written without delimiters, e.g.
/// `x = \frac{-b \pm \sqrt{D}}{2a}`: a command or script, a relation, and no
/// prose (no Cyrillic, no Latin word outside commands and \text{}).
function isBareLatexLine(line) {
  const s = line.trim();
  if (!s || /[$`]|\\[([]/.test(s)) return false;
  if (!/\\[A-Za-z]+|[\^_]/.test(s)) return false;
  if (!/[=<>^_]|\\(frac|sqrt|int|sum|lim|le|ge|ne|approx|Rightarrow|to)\b/.test(s)) return false;
  const stripped = s.replace(/\\(text|mathrm|operatorname)\s*\{[^{}]*\}/g, ' ').replace(/\\[A-Za-z]+/g, ' ');
  if (/[А-Яа-яЁё]/.test(stripped)) return false;
  const words = stripped.match(/[A-Za-z]+/g) || [];
  if (words.some((w) => w.length >= 3 && !FUNCTION_NAMES.has(w.toLowerCase()))) return false;
  // At least one real command, or a script on something — not just "a_b".
  return /\\[A-Za-z]{2,}/.test(s) || /[\^_]\{/.test(s) || /\w\^\w/.test(s) || /[A-Za-z]_\w/.test(s);
}

// MARK: LaTeX cleanup

const ENV_RENAME = {
  align: 'aligned', 'align*': 'aligned', eqnarray: 'aligned', 'eqnarray*': 'aligned',
  flalign: 'aligned', 'flalign*': 'aligned', split: 'aligned',
  alignat: 'alignedat', 'alignat*': 'alignedat',
  gather: 'gathered', 'gather*': 'gathered', multline: 'gathered', 'multline*': 'gathered',
};
const ENV_UNWRAP = new Set(['equation', 'equation*', 'displaymath', 'math']);

/// Make a chatbot's LaTeX safe for KaTeX and for a notebook page: `align` →
/// `aligned`, `equation` unwrapped, `\tag`/`\label`/`\boxed`/`\color`/
/// `\displaystyle` removed, a stray `%` escaped (chatbots never mean a
/// comment, and KaTeX would swallow the rest of the formula), top-level `\\`
/// wrapped so the lines actually break.
export function cleanLatex(latex, display = false) {
  let s = String(latex ?? '');
  s = s.replace(/(^|[^\\])((?:\\\\)*)%/g, '$1$2\\%');
  s = s.replace(/\\(begin|end)\s*\{([^{}]*)\}/g, (m, kind, name) => {
    const env = name.trim();
    if (ENV_UNWRAP.has(env)) return ' ';
    if (ENV_RENAME[env]) return `\\${kind}{${ENV_RENAME[env]}}`;
    return m;
  });
  s = removeCommand(s, 'tag*', 1, false);
  s = removeCommand(s, 'tag', 1, false);
  s = removeCommand(s, 'label', 1, false);
  s = removeCommand(s, 'textcolor', 2, true);
  s = removeCommand(s, 'colorbox', 2, true);
  s = removeCommand(s, 'color', 1, false);
  s = removeCommand(s, 'boxed', 1, true);
  s = removeCommand(s, 'fbox', 1, true);
  s = s.replace(/\\(nonumber|notag|displaystyle|textstyle|scriptstyle)(?![A-Za-z])\s*/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  // Trailing `\\` makes an empty last row; a trailing one at the very end
  // does nothing but can trip up the layout.
  s = s.replace(/(?:\\\\\s*)+(\\end\{(?:aligned|alignedat|gathered|cases|[pbvBV]?matrix)\})/g, '$1');
  s = s.replace(/(?:\s*\\\\)+$/, '').trim();
  if (display && hasTopLevel(s, '\\\\')) {
    s = `\\begin{${hasTopLevel(s, '&') ? 'aligned' : 'gathered'}}${s}\\end{${hasTopLevel(s, '&') ? 'aligned' : 'gathered'}}`;
  }
  return s;
}

/// Remove `\name{a}{b}…`; keep the last group's content when `keepLast`.
function removeCommand(s, name, groups, keepLast) {
  const needle = `\\${name}`;
  let out = '';
  let i = 0;
  for (;;) {
    const k = s.indexOf(needle, i);
    if (k < 0) { out += s.slice(i); break; }
    const after = s[k + needle.length];
    if (after !== undefined && /[A-Za-z*]/.test(after) && !name.endsWith('*')) {
      out += s.slice(i, k + needle.length);
      i = k + needle.length;
      continue;
    }
    out += s.slice(i, k);
    let j = k + needle.length;
    let kept = '';
    for (let g = 0; g < groups; g++) {
      while (s[j] === ' ') j++;
      if (s[j] !== '{') break;
      const close = groupEnd(s, j);
      if (close < 0) { j = s.length; break; }
      kept = s.slice(j + 1, close);
      j = close + 1;
    }
    if (keepLast) out += kept;
    i = j;
  }
  return out;
}

/// Does `token` occur outside every brace group and every environment?
function hasTopLevel(s, token) {
  let depth = 0;
  let env = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('\\begin', i)) { env++; i += 5; continue; }
    if (s.startsWith('\\end', i)) { env--; i += 3; continue; }
    if (s.startsWith(token, i) && depth === 0 && env === 0) return true;
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
  }
  return false;
}

// MARK: 3. Lines → blocks

/// Style markers: C0 controls, stripped from the input, written by
/// `cleanInline` around emphasis and consumed by `splitLine`.
const B_ON = '\u0001', B_OFF = '\u0002', I_ON = '\u0003', I_OFF = '\u0004', S_ON = '\u0005', S_OFF = '\u0006';

/// How much deeper than its parent item's marker a line must be indented to
/// stay inside that item. CommonMark wants the item's content column; chatbots
/// indent nested content by 2, 3 or 4 spaces whatever the marker, so any
/// indentation past the marker by 2 counts.
const NEST_INDENT = 2;

function buildBlocks(lines, pieces) {
  const blocks = [];
  let pendingGap = false;
  let stack = [];      // open list items, outermost first: {indent}
  let stackQuote = 0;
  let afterItem = false; // the previous non-blank line was an item or inside one
  const last = () => blocks[blocks.length - 1];
  const where = (depth, quote) => ({ ...(depth ? { depth } : {}), ...(quote ? { quote } : {}) });

  const push = (block) => {
    if (blocks.length) {
      const prev = last();
      let gap;
      if (block.type === 'heading') gap = prev.type !== 'rule';
      else if (!pendingGap || block.type === 'display' || block.type === 'rule' || prev.type === 'rule') gap = false;
      else if (block.type === 'para') gap = prev.type !== 'display' || startsNewThought(block.runs);
      else gap = true;
      if (gap) blocks.push({ type: 'gap' });
    }
    pendingGap = false;
    blocks.push(block);
  };

  /// The list depth a non-item line hangs at: items it isn't indented under
  /// are closed. A formula alone on a line right under an item belongs to it
  /// even unindented («1. Найдём дискриминант:» / «$$D = …$$»).
  const hang = (line, lazy) => {
    if (line.quote !== stackQuote) { stack = []; stackQuote = line.quote; }
    if (!lazy) while (stack.length && line.indent < stack[stack.length - 1].indent + NEST_INDENT) stack.pop();
    return stack.length;
  };

  const emitParts = (parts, depth, quote) => {
    for (const part of parts) {
      if (part.kind === 'display') push({ type: 'display', latex: part.latex, ...where(depth, quote) });
      else push({ type: 'para', runs: part.runs, ...where(depth, quote) });
    }
  };

  for (const line of lines) {
    if (line.kind === 'hr') {
      stack = [];
      afterItem = false;
      if (blocks.length && last().type !== 'rule') push({ type: 'rule' });
      continue;
    }
    if (line.kind === 'code' || line.kind === 'table') {
      const depth = hang(line, false);
      afterItem = depth > 0;
      if (line.kind === 'code') {
        push({ type: 'code', lang: line.code.lang, lines: line.code.lines, ...where(depth, line.quote) });
      } else {
        const { align, header, rows } = line.table;
        const cell = (text) => inlineRuns(text, pieces);
        push({ type: 'table', align, header: header ? header.map(cell) : null, rows: rows.map((row) => row.map(cell)), ...where(depth, line.quote) });
      }
      continue;
    }

    const parts = splitLine(convertUnicodeMath(cleanInline(line.s, line.kind === 'heading'), pieces), pieces);
    if (!parts.length) {
      pendingGap = blocks.length > 0;
      afterItem = false;
      continue;
    }
    if (line.kind === 'heading') {
      stack = [];
      afterItem = false;
      push({ type: 'heading', level: line.level, runs: joinParts(parts), ...where(0, line.quote) });
      continue;
    }
    if (line.kind === 'item') {
      const depth = hang(line, false) + 1;
      stack.push({ indent: line.indent });
      afterItem = true;
      const [first, ...rest] = parts;
      // «- $$x = 1$$»: the item is the formula, drawn at the item's text.
      const runs = first.kind === 'runs' ? first.runs : [{ type: 'math', latex: first.latex, display: true }];
      push({
        type: 'item', marker: line.marker, ordered: line.ordered, ...(line.task ? { task: line.task } : {}),
        runs, depth, ...(line.quote ? { quote: line.quote } : {}),
      });
      emitParts(rest, depth, line.quote);
      continue;
    }
    const depth = hang(line, afterItem && parts.every((p) => p.kind === 'display'));
    afterItem = depth > 0;
    emitParts(parts, depth, line.quote);
  }
  while (blocks.length && (last().type === 'gap' || last().type === 'rule')) blocks.pop();
  return blocks;
}

/// A table cell's source → runs (display math inside a cell is inline).
function inlineRuns(text, pieces) {
  const lines = [];
  scanSegment(String(text ?? '').replace(/\n/g, ' '), pieces, lines, { prefixes: false });
  const s = convertUnicodeMath(cleanInline(lines.map((l) => l.s).join(' '), false), pieces);
  return joinParts(splitLine(s, pieces));
}

/// Parts of a line → one run list; a display formula becomes inline math.
function joinParts(parts) {
  const runs = [];
  parts.forEach((part, i) => {
    if (i) runs.push({ type: 'text', text: ' ' });
    if (part.kind === 'runs') runs.push(...part.runs);
    else runs.push({ type: 'math', latex: part.latex });
  });
  return finishRuns(runs);
}

/// A masked, marked line → [{kind:'runs', runs} | {kind:'display', latex}].
/// Display formulas split the line; punctuation right after one joins it
/// («$$x=2$$.» — the period belongs to the formula, as in LaTeX).
function splitLine(s, pieces) {
  const parts = [];
  let runs = [];
  let afterDisplay = false;
  const on = { bold: 0, italic: 0, strike: 0 };
  const style = () => {
    const out = {};
    for (const k of Object.keys(on)) if (on[k] > 0) out[k] = true;
    return out;
  };
  const flush = () => {
    const done = finishRuns(runs);
    if (done.length) parts.push({ kind: 'runs', runs: done });
    runs = [];
  };
  for (const ch of s) {
    switch (ch) {
      case B_ON: on.bold++; continue;
      case B_OFF: on.bold = Math.max(0, on.bold - 1); continue;
      case I_ON: on.italic++; continue;
      case I_OFF: on.italic = Math.max(0, on.italic - 1); continue;
      case S_ON: on.strike++; continue;
      case S_OFF: on.strike = Math.max(0, on.strike - 1); continue;
      default: break;
    }
    const piece = PH_RE.test(ch) ? pieces[ch.charCodeAt(0) - PH_BASE] : null;
    if (piece && piece.type === 'math' && piece.display) {
      flush();
      parts.push({ kind: 'display', latex: piece.latex });
      afterDisplay = true;
      continue;
    }
    if (afterDisplay && /[.,;:!?]/.test(ch) && !runs.length) {
      parts[parts.length - 1].latex += ch;
      continue;
    }
    if (afterDisplay && /\s/.test(ch) && !runs.length) continue;
    afterDisplay = false;
    if (piece && piece.type === 'math') {
      const { bold, strike } = style();
      runs.push({ type: 'math', latex: piece.latex, ...(bold ? { bold } : {}), ...(strike ? { strike } : {}) });
    } else if (piece) {
      appendText(runs, piece.text, piece.code ? { ...style(), code: true } : style());
    } else {
      appendText(runs, ch, style());
    }
  }
  flush();
  return parts;
}

function startsNewThought(runs) {
  return runs[0].type === 'text' && /^[\p{Lu}\d—]/u.test(runs[0].text);
}

const STYLE_KEYS = ['bold', 'italic', 'strike', 'code'];

function styleOf(run) {
  const out = {};
  for (const k of STYLE_KEYS) if (run[k]) out[k] = true;
  return out;
}

function sameStyle(a, b) {
  return STYLE_KEYS.every((k) => !!a[k] === !!b[k]);
}

function appendText(runs, text, style = {}) {
  const tail = runs[runs.length - 1];
  if (tail && tail.type === 'text' && sameStyle(tail, style)) tail.text += text;
  else runs.push({ type: 'text', text, ...style });
}

/// Collapse whitespace inside text runs (and across two styled runs), trim
/// the paragraph's ends, drop empty runs. Spaces next to math are kept:
/// «$x$,» and «$x$ ,» differ.
function finishRuns(runs) {
  const out = [];
  for (const run of runs) {
    if (run.type === 'text') {
      let text = run.text.replace(/\s+/g, ' ');
      const tail = out[out.length - 1];
      if (tail && tail.type === 'text' && tail.text.endsWith(' ') && text.startsWith(' ')) text = text.slice(1);
      if (text) appendText(out, text, styleOf(run));
    } else if (run.latex) {
      out.push(run);
    }
  }
  if (out.length && out[0].type === 'text') out[0].text = out[0].text.trimStart();
  if (out.length && out[out.length - 1].type === 'text') out[out.length - 1].text = out[out.length - 1].text.trimEnd();
  return out.filter((r) => r.type === 'math' || r.text);
}

/// Inline Markdown and HTML on a masked line: emphasis becomes style markers,
/// links their text; images, other tags and emoji go. Placeholders are opaque
/// chars, so emphasis around a formula works like around a word.
function cleanInline(s, heading) {
  if (heading) s = s.replace(/[ \t]+#+[ \t]*$/, '');
  return s
    .replace(/<sup>([^<]*)<\/sup>/gi, (m, x) => toScript(x, SUPERSCRIPTS) ?? `^${x}`)
    .replace(/<sub>([^<]*)<\/sub>/gi, (m, x) => toScript(x, SUBSCRIPTS) ?? `_${x}`)
    .replace(/<(?:b|strong)(?:\s[^>]*)?>/gi, B_ON).replace(/<\/(?:b|strong)>/gi, B_OFF)
    .replace(/<(?:i|em)(?:\s[^>]*)?>/gi, I_ON).replace(/<\/(?:i|em)>/gi, I_OFF)
    .replace(/<(?:s|del|strike)(?:\s[^>]*)?>/gi, S_ON).replace(/<\/(?:s|del|strike)>/gi, S_OFF)
    .replace(/<\/?(?:u|span|div|p|code|small|mark|ins|font|kbd)(?:\s[^>]*)?>/gi, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))+\)/g, '$1')
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, `${B_ON}$1${B_OFF}`)
    .replace(/(^|[^\p{L}\p{N}_\\])__(?=\S)([^\n]*?\S)__(?![\p{L}\p{N}_])/gu, `$1${B_ON}$2${B_OFF}`)
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, `${S_ON}$1${S_OFF}`)
    // Unpaired markers: dropped, as a person would not copy them either.
    .replace(/\*\*|__(?=\S)|(?<=\S)__|~~/g, '')
    .replace(/(^|[^\p{L}\p{N}*\\])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}*])/gu, `$1${I_ON}$2${I_OFF}`)
    .replace(/(^|[^\p{L}\p{N}_\\])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, `$1${I_ON}$2${I_OFF}`)
    .replace(/[➔➙➛➜➝➞➟➠➡]/gu, '→')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}\u{2B06}\u{2B07}\u{2B05}\u{2B1B}\u{2B1C}\u{FE0F}\u{20E3}\u{E0020}-\u{E007F}]/gu, (ch) =>
      // Keep the few symbols in those ranges that are real math/typography.
      /[✓✗]/u.test(ch) ? ch : '');
}

const SUPERSCRIPTS = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
const SUBSCRIPTS = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', n: 'ₙ', x: 'ₓ' };

function toScript(text, table) {
  let out = '';
  for (const ch of text) {
    if (!table[ch]) return null;
    out += table[ch];
  }
  return out;
}

// MARK: Unicode math

const FROM_SUPER = Object.fromEntries(Object.entries(SUPERSCRIPTS).filter(([k]) => k !== '−').map(([k, v]) => [v, k]));
const FROM_SUB = Object.fromEntries(Object.entries(SUBSCRIPTS).filter(([k]) => k !== '−').map(([k, v]) => [v, k]));

const FUNCTION_NAMES = new Set(['sin', 'cos', 'tan', 'cot', 'tg', 'ctg', 'sec', 'csc', 'arcsin', 'arccos',
  'arctan', 'arctg', 'arcctg', 'sinh', 'cosh', 'tanh', 'sh', 'ch', 'th', 'ln', 'lg', 'log', 'exp',
  'lim', 'min', 'max', 'det', 'gcd', 'deg', 'arg', 'mod', 'sup', 'inf', 'dx', 'dy', 'dt']);

const UNICODE_OPS = {
  '−': '-', '×': '\\times', '·': '\\cdot', '⋅': '\\cdot', '*': '\\cdot', '÷': '\\div',
  '≤': '\\le', '≥': '\\ge', '≠': '\\ne', '≈': '\\approx', '±': '\\pm', '∓': '\\mp',
  '+': '+', '-': '-', '=': '=', '<': '<', '>': '>', '/': '/',
};

const GREEK = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\varepsilon', ζ: '\\zeta',
  η: '\\eta', θ: '\\theta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', ν: '\\nu',
  ξ: '\\xi', π: '\\pi', ρ: '\\rho', σ: '\\sigma', τ: '\\tau', υ: '\\upsilon', φ: '\\varphi',
  χ: '\\chi', ψ: '\\psi', ω: '\\omega', Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta',
  Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi', Σ: '\\Sigma', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega',
  '∞': '\\infty',
};

const TOKEN_RE = new RegExp([
  '(?<sup>[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]+)',
  '(?<sub>[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₙₓ]+)',
  '(?<root>[√∛∜])',
  '(?<num>\\d+(?:[.,]\\d+)?)',
  '(?<lat>[A-Za-z]+)',
  '(?<cyr>[А-Яа-яЁё]+)',
  '(?<greek>[α-ωΑ-Ω∞])',
  '(?<op>[−×·⋅*÷≤≥≠≈±∓+\\-=<>/])',
  '(?<paren>[()|])',
  '(?<space> +)',
  '(?<other>[\\s\\S])',
].join('|'), 'gu');

/// Formulas typed as Unicode ("x² + y² = 25", "√2 ≈ 1,41", "9,8 м/с²") →
/// inline math, but only around a superscript, subscript or root — that's
/// what makes it clearly math. Other Unicode symbols (≤, π, →) stay in text
/// runs; the compositor draws them as glyphs.
function convertUnicodeMath(s, pieces) {
  if (!/[⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ₀₁₂₃₄₅₆₇₈₉√∛∜]/.test(s)) return s;
  const toks = [];
  for (const m of s.matchAll(TOKEN_RE)) {
    const kind = Object.keys(m.groups).find((k) => m.groups[k] !== undefined);
    toks.push({ kind, text: m[0] });
  }
  const isAnchor = (t) => t && (t.kind === 'sup' || t.kind === 'sub' || t.kind === 'root');
  const operandish = (t) => t && ['sup', 'sub', 'root', 'num', 'paren', 'greek'].includes(t.kind);
  const allowed = (i) => {
    const t = toks[i];
    if (!t) return false;
    switch (t.kind) {
      case 'sup': case 'sub': case 'root': case 'num': case 'op': case 'paren': case 'space': case 'greek':
        return true;
      case 'lat':
        return t.text.length === 1 || FUNCTION_NAMES.has(t.text.toLowerCase()) ||
          (t.text.length <= 3 && (operandish(toks[i - 1]) || operandish(toks[i + 1])));
      case 'cyr':
        return isUnit(i);
      default:
        return false;
    }
  };
  // A short Cyrillic word right before a superscript is a unit (м², см³),
  // and so is one joined to such a unit by «/» or «·» (м/с²).
  const isUnit = (i) => {
    const t = toks[i];
    if (!t || t.kind !== 'cyr' || t.text.length > 3) return false;
    const next = toks[i + 1];
    if (next && next.kind === 'sup') return true;
    return !!(next && next.kind === 'op' && /[/·⋅]/.test(next.text) && isUnit(i + 2));
  };

  // Find spans first (each grown from an anchor, never overlapping the
  // previous one), then emit.
  const spans = [];
  for (let i = 0; i < toks.length; i++) {
    if (!isAnchor(toks[i]) && !(toks[i].kind === 'cyr' && isUnit(i))) continue;
    const floor = spans.length ? spans[spans.length - 1][1] + 1 : 0;
    // Grow over allowed tokens, but never past a bracket that closes (or,
    // leftwards, opens) something outside the span.
    let a = i;
    for (let depth = 0; a > floor && allowed(a - 1); a--) {
      const t = toks[a - 1].text;
      if (t === ')') depth++;
      else if (t === '(' && --depth < 0) break;
    }
    let b = i;
    for (let depth = 0; b + 1 < toks.length && allowed(b + 1); b++) {
      const t = toks[b + 1].text;
      if (t === '(') depth++;
      else if (t === ')' && --depth < 0) break;
    }
    // Trim to operands at both ends (a leading minus or root may stay).
    const edgeJunk = (t, next) => t.kind === 'space' ||
      (t.kind === 'op' && !(/[-−]/.test(t.text) && next && next.kind !== 'space'));
    while (a < i && edgeJunk(toks[a], toks[a + 1])) a++;
    while (b > i && (toks[b].kind === 'space' || toks[b].kind === 'op')) b--;
    // Unbalanced parens at the edges belong to the sentence: «(где x² > 0)».
    for (;;) {
      let depth = 0;
      let minDepth = 0;
      for (let k = a; k <= b; k++) {
        if (toks[k].text === '(') depth++;
        else if (toks[k].text === ')') minDepth = Math.min(minDepth, --depth);
      }
      if (a < i && toks[a].text === ')') a++;
      else if (b > i && toks[b].text === '(') b--;
      else if (minDepth < 0 && b > i && toks[b].text === ')') b--;
      else if (depth > 0 && a < i && toks[a].text === '(') a++;
      else break;
      while (a < i && toks[a].kind === 'space') a++;
      while (b > i && toks[b].kind === 'space') b--;
    }
    spans.push([a, b]);
    i = b;
  }
  let out = '';
  let k = 0;
  for (const [a, b] of spans) {
    for (; k < a; k++) out += toks[k].text;
    const latex = unicodeToLatex(toks.slice(a, b + 1));
    out += latex ? addPiece(pieces, { type: 'math', latex, display: false }) : toks.slice(a, b + 1).map((t) => t.text).join('');
    k = b + 1;
  }
  for (; k < toks.length; k++) out += toks[k].text;
  return out;
}

function unicodeToLatex(toks) {
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    switch (t.kind) {
      case 'sup': {
        const x = [...t.text].map((c) => FROM_SUPER[c]).join('');
        out += (out.trim() ? '' : '{}') + (x.length === 1 ? `^${x}` : `^{${x}}`);
        break;
      }
      case 'sub': {
        const x = [...t.text].map((c) => FROM_SUB[c]).join('');
        out += x.length === 1 ? `_${x}` : `_{${x}}`;
        break;
      }
      case 'root': {
        const index = t.text === '∛' ? '[3]' : t.text === '∜' ? '[4]' : '';
        const next = toks[i + 1];
        if (next && next.text === '(') {
          let depth = 0;
          let j = i + 1;
          for (; j < toks.length; j++) {
            if (toks[j].text === '(') depth++;
            else if (toks[j].text === ')' && --depth === 0) break;
          }
          out += `\\sqrt${index}{${unicodeToLatex(toks.slice(i + 2, j))}}`;
          i = j;
        } else if (next && ['num', 'lat', 'greek', 'cyr'].includes(next.kind)) {
          out += `\\sqrt${index}{${unicodeToLatex([next])}}`;
          i++;
        } else {
          out += '\\surd ';
        }
        break;
      }
      case 'num':
        out += t.text.replace(',', '{,}');
        break;
      case 'lat':
        out += FUNCTION_NAMES.has(t.text) && SUPPORTED_SET.has(t.text) ? `\\${t.text} ` : t.text;
        break;
      case 'cyr':
        out += `\\text{${t.text}}`;
        break;
      case 'greek':
        out += `${GREEK[t.text]} `;
        break;
      case 'op':
        out += /^\\/.test(UNICODE_OPS[t.text]) ? ` ${UNICODE_OPS[t.text]} ` : UNICODE_OPS[t.text];
        break;
      case 'space':
        // «5 м²»: KaTeX drops plain spaces, a unit keeps its thin space.
        out += toks[i - 1]?.kind === 'cyr' || toks[i + 1]?.kind === 'cyr' ? '\\, ' : ' ';
        break;
      default:
        out += t.text;
    }
  }
  return out.replace(/\s+/g, ' ').replace(/\s+([\^_])/g, '$1').trim();
}
