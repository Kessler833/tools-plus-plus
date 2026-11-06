// Text statistics and diffs.

import { ToolError, fmtNum, readInput, intArg } from './util.mjs';

// ---- text_stats ---------------------------------------------------------------

const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export async function textStats(args = {}) {
  const { text, path, buffer } = await readInput(args);
  const top = intArg(args.top_words, 'top_words', { min: 0, max: 100, def: 0 });
  const locale = args.locale || undefined;

  let graphemes = 0, words = 0, sentences = 0;
  for (const _ of new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(text)) graphemes++;
  const freq = new Map();
  for (const s of new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)) {
    if (!s.isWordLike) continue;
    words++;
    if (top) {
      const w = s.segment.toLowerCase();
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  for (const s of new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(text)) if (s.segment.trim()) sentences++;

  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  const lineList = text.split(/\r\n|\r|\n/);
  const endsWithNewline = /[\r\n]$/.test(text);
  if (endsWithNewline) lineList.pop();
  const lines = text ? lineList.length : 0;
  let longest = 0, longestAt = 0, trailing = 0, tabIndent = 0, spaceIndent = 0, blank = 0;
  lineList.forEach((l, i) => {
    if (l.length > longest) [longest, longestAt] = [l.length, i + 1];
    if (/[ \t]+$/.test(l)) trailing++;
    if (l.startsWith('\t')) tabIndent++;
    else if (l.startsWith('  ')) spaceIndent++;
    if (!l.trim()) blank++;
  });
  const paragraphs = text.split(/(?:\r?\n|\r)\s*(?:\r?\n|\r)/).filter((p) => p.trim()).length;
  const codePoints = [...text].length;
  const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  const invisible = text.match(INVISIBLE) || [];
  const controls = text.match(CONTROL) || [];
  const noSpace = text.replace(/\s/g, '').length;
  const tokens = Math.round((codePoints / 4 + words * 1.33) / 2);

  const endings = [crlf && `CRLF ×${crlf}`, lf && `LF ×${lf}`, cr && `CR ×${cr}`].filter(Boolean);
  const out = [
    path ? `file: ${path}` : null,
    `characters: ${graphemes} (visible units)   code points: ${codePoints}   UTF-16 units: ${text.length}`,
    `characters without whitespace: ${noSpace}`,
    `UTF-8 bytes: ${Buffer.byteLength(text, 'utf8')}${buffer && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? ' (+3 byte BOM)' : ''}`,
    `words: ${words}   sentences: ${sentences}   paragraphs: ${paragraphs}`,
    `lines: ${lines} (${blank} blank)   longest: ${longest} chars (line ${longestAt})`,
    `tokens: ~${tokens} (rough estimate for LLM tokenizers, ±25%)`,
    `reading time: ~${fmtNum(words / 238, 2)} min   speaking: ~${fmtNum(words / 150, 2)} min`,
    `line endings: ${endings.length ? endings.join(', ') + (endings.length > 1 ? '  ← MIXED' : '') : 'none'}${text && !endsWithNewline ? '; no final newline' : ''}`,
  ];
  if (trailing) out.push(`lines with trailing whitespace: ${trailing}`);
  if (tabIndent && spaceIndent) out.push(`indentation: ${tabIndent} lines with tabs, ${spaceIndent} with spaces  ← MIXED`);
  if (nonAscii) out.push(`non-ASCII characters: ${nonAscii}`);
  if (invisible.length) {
    const kinds = [...new Set(invisible)].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    out.push(`invisible/format characters: ${invisible.length} (${kinds.join(', ')})  ← check these`);
  }
  if (controls.length) out.push(`control characters: ${controls.length}  ← unusual in text`);
  if (top && freq.size) {
    const list = [...freq].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
    out.push(`top words: ${list.map(([w, c]) => `${w} ${c}`).join(', ')}`);
  }
  return out.filter((l) => l !== null).join('\n');
}

// ---- diff ---------------------------------------------------------------------

const MAX_EDIT_DISTANCE = 4000;  // Myers memory grows with D²; beyond this, fall back to replace

/**
 * Myers O(ND) diff on integer arrays. Returns [{ t: '=' | '-' | '+', a, b }]
 * where a/b are indices into the inputs.
 */
function myers(A, B) {
  const ops = [];
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) ops.push({ t: '=', a: s, b: s++ });
  let ea = A.length, eb = B.length;
  const tail = [];
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) tail.push({ t: '=', a: --ea, b: --eb });

  const N = ea - s, M = eb - s, max = N + M;
  const a = (i) => A[s + i], b = (j) => B[s + j];
  let fallback = false;
  const trace = [];
  if (max > 0) {
    const off = max + 1;
    const V = new Int32Array(2 * max + 3);
    let found = false;
    for (let d = 0; d <= max && !found; d++) {
      if (d > MAX_EDIT_DISTANCE) {
        fallback = true;
        break;
      }
      trace.push(V.slice(off - d - 1, off + d + 2));  // only the band this step can read
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && a(x) === b(y)) {
          x++;
          y++;
        }
        V[off + k] = x;
        if (x >= N && y >= M) {
          found = true;
          break;
        }
      }
    }
    if (!fallback) {
      const middle = [];
      let x = N, y = M;
      for (let d = trace.length - 1; d >= 0; d--) {
        const band = trace[d];
        const at = (k) => band[k + d + 1];
        const k = x - y;
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const prevX = d === 0 ? 0 : at(prevK), prevY = prevX - prevK;
        while (x > prevX && y > prevY) middle.push({ t: '=', a: s + --x, b: s + --y });
        if (d > 0) {
          if (x === prevX) middle.push({ t: '+', b: s + --y, a: s + x });
          else middle.push({ t: '-', a: s + --x, b: s + y });
        }
      }
      ops.push(...middle.reverse());
    } else {
      for (let i = 0; i < N; i++) ops.push({ t: '-', a: s + i, b: s });
      for (let j = 0; j < M; j++) ops.push({ t: '+', a: ea, b: s + j });
    }
  }
  ops.push(...tail.reverse());
  return { ops, fallback };
}

function intern(lists, key) {
  const ids = new Map();
  return lists.map((list) => Int32Array.from(list, (item) => {
    const k = key(item);
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    return id;
  }));
}

function unified(ops, A, B, context) {
  const changes = ops.map((o, i) => (o.t !== '=' ? i : -1)).filter((i) => i >= 0);
  if (!changes.length) return [];
  const hunks = [];
  let start = Math.max(0, changes[0] - context), end = Math.min(ops.length, changes[0] + context + 1);
  for (const c of changes.slice(1)) {
    if (c - context <= end) end = Math.min(ops.length, c + context + 1);
    else {
      hunks.push([start, end]);
      start = Math.max(0, c - context);
      end = Math.min(ops.length, c + context + 1);
    }
  }
  hunks.push([start, end]);
  const out = [];
  for (const [h0, h1] of hunks) {
    const slice = ops.slice(h0, h1);
    const aLen = slice.filter((o) => o.t !== '+').length, bLen = slice.filter((o) => o.t !== '-').length;
    const aStart = slice[0].a + (aLen ? 1 : 0), bStart = slice[0].b + (bLen ? 1 : 0);
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of slice) out.push(o.t === '=' ? ` ${A[o.a]}` : o.t === '-' ? `-${A[o.a]}` : `+${B[o.b]}`);
  }
  return out;
}

function inline(ops, A, B) {
  let out = '', mode = '=';
  const close = () => {
    if (mode === '-') out += '-]';
    if (mode === '+') out += '+}';
  };
  for (const o of ops) {
    if (o.t !== mode) {
      close();
      if (o.t === '-') out += '[-';
      if (o.t === '+') out += '{+';
      mode = o.t;
    }
    out += o.t === '+' ? B[o.b] : A[o.a];
  }
  close();
  return out;
}

const WORD = /\r\n|\n|[^\S\r\n]+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

export async function diff(args = {}) {
  const a = await readInput(args, { text: 'a', path: 'a_path' });
  const b = await readInput(args, { text: 'b', path: 'b_path' });
  const mode = args.mode ?? 'line';
  const context = intArg(args.context, 'context', { min: 0, max: 100, def: 3 });
  const norm = (s) => {
    let t = s;
    if (args.ignore_whitespace) t = t.replace(/\s+/g, ' ').trim();
    if (args.ignore_case) t = t.toLowerCase();
    return t;
  };
  const labelA = a.path ?? 'a', labelB = b.path ?? 'b';

  if (a.text === b.text) return `Identical (${a.text.length} characters).`;

  if (mode === 'word' || mode === 'char') {
    const split = (t) => (mode === 'word' ? t.match(WORD) ?? [] : Array.from(t));
    const A = split(a.text), B = split(b.text);
    const [ia, ib] = intern([A, B], norm);
    const { ops, fallback } = myers(ia, ib);
    const removed = ops.filter((o) => o.t === '-').length, added = ops.filter((o) => o.t === '+').length;
    if (!removed && !added) return 'Identical after normalization (whitespace/case).';
    return [
      `--- ${labelA}\n+++ ${labelB}`,
      `${mode} diff: ${removed} removed, ${added} added. Notation: [-removed-] {+added+}${fallback ? ' (too different for a minimal diff; shown as replacement)' : ''}`,
      '',
      inline(ops, A, B),
    ].join('\n');
  }
  if (mode !== 'line') throw new ToolError('mode must be line, word or char');

  const lines = (t) => {
    const l = t.split(/\r\n|\r|\n/);
    if (/[\r\n]$/.test(t)) l.pop();
    return t ? l : [];
  };
  const A = lines(a.text), B = lines(b.text);
  const [ia, ib] = intern([A, B], norm);
  const { ops, fallback } = myers(ia, ib);
  const removed = ops.filter((o) => o.t === '-').length, added = ops.filter((o) => o.t === '+').length;
  const notes = [];
  const eol = (t) => (t.includes('\r\n') ? 'CRLF' : t.includes('\n') ? 'LF' : null);
  if (eol(a.text) && eol(b.text) && eol(a.text) !== eol(b.text)) notes.push(`line endings differ (${eol(a.text)} vs ${eol(b.text)}); ignored in the diff`);
  if (/[\r\n]$/.test(a.text) !== /[\r\n]$/.test(b.text)) notes.push(`only ${/[\r\n]$/.test(a.text) ? labelA : labelB} ends with a newline`);
  if (fallback) notes.push('files are very different; shown as a block replacement instead of a minimal diff');
  if (!removed && !added) {
    return [`No line differences${args.ignore_whitespace || args.ignore_case ? ' after normalization' : ''}.`, ...notes].join('\n');
  }
  const body = unified(ops, A, B, context);
  const hunks = body.filter((l) => l.startsWith('@@')).length;
  return [
    `--- ${labelA}`,
    `+++ ${labelB}`,
    `${removed} line(s) removed, ${added} added, ${hunks} hunk(s)`,
    ...notes.map((n) => `note: ${n}`),
    ...body,
  ].join('\n');
}
