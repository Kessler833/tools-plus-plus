// Text work that otherwise needs throwaway scripts: case and line transforms,
// token budgets for files and folders, Markdown checks, and pulling structured
// items (URLs, emails, dates, ...) out of free text.

import { randomInt } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { ToolError, readInput, statOrNull, decodeText } from './util.mjs';

async function output(args, text, source) {
  const target = args.out_path ? resolve(args.out_path) : args.in_place ? source : null;
  if (args.in_place && !source) throw new ToolError('in_place needs path');
  if (!target) return null;
  if (args.out_path && (await statOrNull(target)) && !args.overwrite) throw new ToolError(`${target} exists; pass overwrite: true to replace it`);
  await writeFile(target, text);
  return target;
}

// ---- text_transform -----------------------------------------------------------

const words = (s) => s
  .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
  .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
  .split(/[^\p{L}\p{N}]+/u)
  .filter(Boolean);
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
const perLine = (fn) => (s) => s.split('\n').map(fn).join('\n');

const TRANSLIT = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', æ: 'ae', Æ: 'AE', ø: 'o', Ø: 'O', å: 'a', Å: 'A', œ: 'oe', Œ: 'OE', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', þ: 'th', ð: 'd' };
const stripAccents = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
const ascii = (s) => stripAccents(s.replace(/[äöüÄÖÜßæÆøØåÅœŒłŁđĐþð]/g, (c) => TRANSLIT[c]))
  .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[  ]/g, ' ');

function wrap(text, width) {
  return text.split('\n').map((line) => {
    if (line.length <= width) return line;
    const indent = /^\s*(?:[-*+] |\d+[.)] )?/.exec(line)[0];
    const pad = ' '.repeat(indent.length);
    const out = [];
    let cur = '';
    for (const w of line.slice(indent.length).split(/\s+/)) {
      if (cur && (out.length ? pad : indent).length + cur.length + 1 + w.length > width) {
        out.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
    out.push(cur);
    return out.map((l, i) => (i ? pad : indent) + l).join('\n');
  }).join('\n');
}

const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const OPS = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  title: perLine((l) => l.replace(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu, cap)),
  sentence: (s) => s.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()),
  camel: perLine((l) => words(l).map((w, i) => (i ? cap(w) : w.toLowerCase())).join('')),
  pascal: perLine((l) => words(l).map(cap).join('')),
  snake: perLine((l) => words(l).map((w) => w.toLowerCase()).join('_')),
  kebab: perLine((l) => words(l).map((w) => w.toLowerCase()).join('-')),
  constant: perLine((l) => words(l).map((w) => w.toUpperCase()).join('_')),
  slug: perLine((l) => words(ascii(l)).map((w) => w.toLowerCase()).join('-')),
  trim: (s) => s.trim(),
  trim_lines: perLine((l) => l.trim()),
  trim_trailing: perLine((l) => l.trimEnd()),
  collapse_spaces: perLine((l) => l.replace(/[ \t]+/g, ' ')),
  remove_blank_lines: (s) => s.split('\n').filter((l) => l.trim()).join('\n'),
  squeeze_blank_lines: (s) => s.replace(/\n(\s*\n){2,}/g, '\n\n'),
  dedupe_lines: (s) => [...new Set(s.split('\n'))].join('\n'),
  dedupe_lines_ci: (s) => {
    const seen = new Set();
    return s.split('\n').filter((l) => !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase())).join('\n');
  },
  sort_lines: (s) => s.split('\n').sort(naturalSort).join('\n'),
  sort_lines_desc: (s) => s.split('\n').sort((a, b) => naturalSort(b, a)).join('\n'),
  sort_by_length: (s) => s.split('\n').sort((a, b) => a.length - b.length || naturalSort(a, b)).join('\n'),
  reverse_lines: (s) => s.split('\n').reverse().join('\n'),
  shuffle_lines: (s) => {
    const a = s.split('\n');
    for (let i = a.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.join('\n');
  },
  count_lines: (s) => {
    const freq = new Map();
    for (const l of s.split('\n')) freq.set(l, (freq.get(l) ?? 0) + 1);
    return [...freq].sort((a, b) => b[1] - a[1] || naturalSort(a[0], b[0])).map(([l, n]) => `${String(n).padStart(6)}  ${l}`).join('\n');
  },
  number_lines: (s) => {
    const lines = s.split('\n'), w = String(lines.length).length;
    return lines.map((l, i) => `${String(i + 1).padStart(w)}  ${l}`).join('\n');
  },
  unwrap: (s) => s.split(/\n\s*\n/).map((p) => (/^\s*([-*+]|\d+[.)]|#|```|\|)/m.test(p) ? p : p.replace(/\s*\n\s*/g, ' '))).join('\n\n'),
  nfc: (s) => s.normalize('NFC'),
  nfkc: (s) => s.normalize('NFKC'),
  nfd: (s) => s.normalize('NFD'),
  strip_accents: stripAccents,
  ascii,
  remove_invisible: (s) => s.replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g, ''),
  smart_quotes_to_ascii: (s) => s.replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"'),
  tabs_to_spaces: (s) => s.replace(/\t/g, '    '),
  lf: (s) => s.replace(/\r\n?/g, '\n'),
  crlf: (s) => s.replace(/\r?\n/g, '\r\n'),
  reverse: (s) => [...new Intl.Segmenter().segment(s)].map((x) => x.segment).reverse().join(''),
};

export async function textTransform(args = {}) {
  const { text, path } = await readInput(args);
  const ops = [].concat(args.ops ?? []);
  if (!ops.length) throw new ToolError(`Provide ops, applied in order. Available: ${Object.keys(OPS).join(', ')}, wrap:<width>`);
  const crlf = /\r\n/.test(text) && !ops.includes('lf') && !ops.includes('crlf');
  let s = text.replace(/\r\n/g, '\n');
  const before = s.split('\n').length;
  for (const op of ops) {
    const m = /^wrap(?::(\d+))?$/.exec(op);
    if (m) s = wrap(s, Number(m[1] ?? 80));
    else if (OPS[op]) s = OPS[op](s);
    else throw new ToolError(`Unknown op "${op}". Available: ${Object.keys(OPS).join(', ')}, wrap:<width>`);
  }
  if (crlf) s = s.replace(/\n/g, '\r\n');
  const written = await output(args, s, path);
  const summary = `${ops.join(' → ')}: ${before} → ${s.split(/\r?\n/).length} lines`;
  return written ? `${summary}; written to ${written}` : `${summary}\n\n${s}`;
}

// ---- token_count --------------------------------------------------------------

// pieces a BPE tokenizer roughly maps to one token each: CJK characters, word
// chunks, short digit groups, punctuation runs, a newline with its indentation
const TOKEN_PIECE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{M}]+|\p{N}{1,3}|\n[ \t]*|[^\s\p{L}\p{N}]{1,3}/gu;

/** Rough BPE-like token estimate: ±15% for English prose and code. */
export function estimateTokens(text) {
  let n = 0;
  for (const [m] of text.matchAll(TOKEN_PIECE)) n += m.length > 6 && /\p{L}/u.test(m) ? Math.ceil(m.length / 6) : 1;
  return n;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', '.cache', '.idea', '.vscode']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.mp3', '.mp4', '.mov', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.bin', '.class', '.jar', '.pyc', '.sqlite', '.db', '.lock']);

/** Files under a folder, skipping dependency/build folders: [{ full, rel, size }]. */
export async function walkFiles(root, { skipDirs = SKIP_DIRS, limit = 100_000, signal } = {}) {
  const files = [];
  async function walk(dir) {
    if (signal?.aborted) throw new ToolError('Cancelled');
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) await walk(full);
      } else if (e.isFile()) {
        const st = await statOrNull(full);
        if (st) files.push({ full, rel: relative(root, full).split(sep).join('/'), size: st.size, mtimeMs: st.mtimeMs });
        if (files.length >= limit) throw new ToolError(`More than ${limit} files under ${root}; pick a smaller folder`);
      }
    }
  }
  await walk(root);
  return files;
}

export async function tokenCount(args = {}, ctx = {}) {
  const budget = args.budget ?? 200_000;
  if (args.text !== undefined || (args.path && (await statOrNull(resolve(args.path)))?.isFile())) {
    const { text, path } = await readInput(args);
    const t = estimateTokens(text);
    return [`${path ?? 'text'}: ~${t.toLocaleString('en-US')} tokens (${text.length.toLocaleString('en-US')} characters, ${(text.length / Math.max(t, 1)).toFixed(1)} chars/token)`,
      `${((t / budget) * 100).toFixed(1)}% of a ${budget.toLocaleString('en-US')}-token budget`, 'Estimate, ±15% vs. real tokenizers.'].join('\n');
  }
  if (!args.path) throw new ToolError('Provide text or path (file or folder)');
  const root = resolve(args.path);
  const st = await statOrNull(root);
  if (!st) throw new ToolError(`Not found: ${root}`);
  const exts = args.extensions?.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
  const files = (await walkFiles(root, { signal: ctx.signal })).filter((f) => !BINARY_EXT.has(extname(f.full).toLowerCase()) && (!exts || exts.includes(extname(f.full).toLowerCase())) && f.size <= 5e6);
  let total = 0, skipped = 0;
  const per = [];
  for (const f of files) {
    let text;
    try {
      text = decodeText(await readFile(f.full));
    } catch {
      skipped++;
      continue;
    }
    const t = estimateTokens(text);
    total += t;
    per.push({ ...f, t });
  }
  const byExt = new Map();
  for (const f of per) {
    const e = extname(f.full).toLowerCase() || '(none)';
    const cur = byExt.get(e) ?? { t: 0, n: 0 };
    byExt.set(e, { t: cur.t + f.t, n: cur.n + 1 });
  }
  const top = args.top ?? 15;
  return [
    `${root}: ~${total.toLocaleString('en-US')} tokens in ${per.length} text files${skipped ? ` (${skipped} binary/non-UTF-8 skipped)` : ''}`,
    `${((total / budget) * 100).toFixed(1)}% of a ${budget.toLocaleString('en-US')}-token budget${total > budget ? ' — does NOT fit; read selectively' : ''}`,
    'By extension:', ...[...byExt].sort((a, b) => b[1].t - a[1].t).slice(0, 12).map(([e, v]) => `  ${e.padEnd(10)} ~${v.t.toLocaleString('en-US').padStart(9)} tokens  ${v.n} files`),
    `Largest ${Math.min(top, per.length)} files:`, ...per.sort((a, b) => b.t - a.t).slice(0, top).map((f) => `  ~${f.t.toLocaleString('en-US').padStart(9)}  ${f.rel}`),
    `Skipped folders: ${[...SKIP_DIRS].join(', ')}. Estimate, ±15%.`,
  ].join('\n');
}

// ---- markdown -----------------------------------------------------------------

function slugify(heading, used) {
  const base = heading.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  let slug = base, i = 1;
  while (used.has(slug)) slug = `${base}-${i++}`;
  used.add(slug);
  return slug;
}

function scan(text) {
  const lines = text.split(/\r?\n/);
  const headings = [], links = [], fences = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = { marker: f[1][0], len: f[1].length, line: i + 1 };
      else if (f[1][0] === fence.marker && f[1].length >= fence.len && !/\S/.test(line.slice(line.indexOf(f[1]) + f[1].length))) {
        fences.push(fence);
        fence = null;
      }
      return;
    }
    if (fence) return;
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) headings.push({ level: h[1].length, text: h[2], line: i + 1 });
    else if (/^\S.*$/.test(line) && /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1] ?? '') && !/^\s*([-*+]|\d+\.)\s/.test(line) && line.trim() && !/^\s*\|/.test(line)) {
      headings.push({ level: lines[i + 1].trim()[0] === '=' ? 1 : 2, text: line.trim(), line: i + 1 });
    }
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) links.push({ image: m[1] === '!', text: m[2], url: m[3], line: i + 1 });
  });
  return { lines, headings, links, openFence: fence };
}

function alignTables(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    if (/^\s*\|/.test(lines[i]) && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? '')) {
      const block = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) block.push(lines[i++]);
      const rows = block.map((l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim()));
      const width = Math.max(...rows.map((r) => r.length));
      const align = rows[1].map((c) => (c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : c.startsWith(':') ? 'l' : ''));
      const w = Array.from({ length: width }, (_, j) => Math.max(3, ...rows.filter((_, k) => k !== 1).map((r) => [...(r[j] ?? '')].length)));
      rows.forEach((r, k) => {
        if (k === 1) {
          out.push(`| ${w.map((n, j) => (align[j] === 'c' ? `:${'-'.repeat(n - 2)}:` : align[j] === 'r' ? `${'-'.repeat(n - 1)}:` : align[j] === 'l' ? `:${'-'.repeat(n - 1)}` : '-'.repeat(n))).join(' | ')} |`);
        } else {
          out.push(`| ${w.map((n, j) => {
            const c = r[j] ?? '', pad = n - [...c].length;
            return align[j] === 'r' ? ' '.repeat(pad) + c : align[j] === 'c' ? ' '.repeat(Math.floor(pad / 2)) + c + ' '.repeat(Math.ceil(pad / 2)) : c + ' '.repeat(pad);
          }).join(' | ')} |`);
        }
      });
    } else out.push(lines[i++]);
  }
  return out.join('\n');
}

export async function markdown(args = {}) {
  const { text, path } = await readInput(args);
  const op = args.op ?? 'lint';
  const doc = scan(text);
  const used = new Set();
  const anchors = doc.headings.map((h) => ({ ...h, slug: slugify(h.text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, ''), used) }));
  switch (op) {
    case 'outline':
      return anchors.length ? anchors.map((h) => `${'  '.repeat(h.level - 1)}${h.text}  (line ${h.line}, #${h.slug})`).join('\n') : 'No headings.';
    case 'toc': {
      const min = args.min_level ?? 2, max = args.max_level ?? 3;
      const hs = anchors.filter((h) => h.level >= min && h.level <= max);
      if (!hs.length) return `No headings between level ${min} and ${max}.`;
      const base = Math.min(...hs.map((h) => h.level));
      return hs.map((h) => `${'  '.repeat(h.level - base)}- [${h.text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')}](#${h.slug})`).join('\n');
    }
    case 'format_tables': {
      const crlf = /\r\n/.test(text);
      let s = alignTables(text.replace(/\r\n/g, '\n'));
      if (crlf) s = s.replace(/\n/g, '\r\n');
      const written = await output(args, s, path);
      return written ? `Tables aligned; written to ${written}` : s;
    }
    case 'links': {
      if (!doc.links.length) return 'No links.';
      const base = path ? dirname(path) : process.cwd();
      const slugs = new Set(anchors.map((h) => h.slug));
      const rows = [];
      for (const l of doc.links) {
        let status = '';
        if (/^[a-z][a-z0-9+.-]*:/i.test(l.url)) status = l.url.startsWith('http:') ? 'external (http, not https)' : 'external';
        else if (l.url.startsWith('#')) status = slugs.has(l.url.slice(1).toLowerCase()) ? 'anchor ok' : 'BROKEN anchor';
        else {
          const target = resolve(base, decodeURIComponent(l.url.split('#')[0]));
          status = (await statOrNull(target)) ? 'file ok' : `BROKEN: ${relative(base, target)} not found`;
        }
        rows.push(`  line ${l.line}: ${l.image ? 'image' : 'link'} ${l.url}  — ${status}`);
      }
      return [`${doc.links.length} links (${rows.filter((r) => r.includes('BROKEN')).length} broken):`, ...rows].join('\n');
    }
    case 'lint': {
      const issues = [];
      const h1 = anchors.filter((h) => h.level === 1);
      if (h1.length > 1) issues.push(`${h1.length} H1 headings (lines ${h1.map((h) => h.line).join(', ')}); usually there is one`);
      anchors.forEach((h, i) => {
        if (i && h.level > anchors[i - 1].level + 1) issues.push(`line ${h.line}: heading jumps from H${anchors[i - 1].level} to H${h.level}`);
      });
      const seen = new Map();
      for (const h of doc.headings) {
        const k = h.text.toLowerCase();
        if (seen.has(k)) issues.push(`line ${h.line}: duplicate heading "${h.text}" (also line ${seen.get(k)})`);
        else seen.set(k, h.line);
      }
      if (doc.openFence) issues.push(`line ${doc.openFence.line}: code fence is never closed`);
      let inFence = false;
      const markers = new Set();
      doc.lines.forEach((line, i) => {
        if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence;
        if (inFence) return;
        if (/[ \t]+$/.test(line) && !/\S {2}$/.test(line)) issues.push(`line ${i + 1}: trailing whitespace`);
        if (/^#{1,6}[^#\s]/.test(line)) issues.push(`line ${i + 1}: no space after # in heading`);
        const lm = /^\s*([-*+])\s/.exec(line);
        if (lm) markers.add(lm[1]);
        if (/(^|\s)https?:\/\/\S+/.test(line.replace(/\[[^\]]*\]\([^)]*\)|<https?:[^>]+>|`[^`]*`/g, ''))) issues.push(`line ${i + 1}: bare URL (wrap in <...> or a link)`);
      });
      if (markers.size > 1) issues.push(`mixed list markers: ${[...markers].join(' ')}`);
      for (const l of doc.links) if (l.image && !l.text.trim()) issues.push(`line ${l.line}: image without alt text`);
      for (const l of doc.links) if (!l.text.trim() && !l.image) issues.push(`line ${l.line}: link without text`);
      if (text.length && !/\n$/.test(text)) issues.push('no newline at end of file');
      return issues.length ? [`${issues.length} issue(s):`, ...issues.slice(0, 200).map((x) => `  ${x}`)].join('\n') : `No issues (${anchors.length} headings, ${doc.links.length} links). Use op links to check link targets.`;
    }
    default: throw new ToolError('op must be lint, outline, toc, links or format_tables');
  }
}

// ---- extract ------------------------------------------------------------------

const EXTRACTORS = {
  urls: /\bhttps?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/gi,
  emails: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi,
  ipv4: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?\b/g,
  ipv6: /(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?![\w:])/gi,
  dates: /\b(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?|\d{1,2}\.\d{1,2}\.\d{2,4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}\.? (?:Jan|Feb|Mär|Mar|Apr|Mai|May|Jun|Jul|Aug|Sep|Okt|Oct|Nov|Dez|Dec)[a-zä]*\.? \d{4})\b/gi,
  times: /\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s?[ap]m)?\b/gi,
  phones: /(?<![\w/-])(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,5}\)?[\s/-]?)\d{3,4}[\s-]?\d{2,6}(?![\w/-])/g,
  money: /(?:[$€£¥]\s?\d[\d.,]*\d?|\b\d[\d.,]*\s?(?:€|EUR|USD|\$|£|GBP|CHF|JPY|¥)(?![a-z]))/gi,
  percentages: /[-+]?\b\d+(?:[.,]\d+)?\s?%/g,
  numbers: /(?<![\w.])[-+]?(?:\d{1,3}(?:[,.']\d{3})+|\d+)(?:[.,]\d+)?(?:e[-+]?\d+)?(?![\w])/gi,
  hashtags: /(?<![\w#])#[\p{L}_][\p{L}\p{N}_]*/gu,
  mentions: /(?<![\w@])@[\w][\w.-]*\w/g,
  hex_colors: /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi,
  uuids: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  hashes: /\b(?:[0-9a-f]{64}|[0-9a-f]{40}|[0-9a-f]{32})\b/gi,
  paths: /(?:\b[a-z]:[\\/](?:[^\\/\s:*?"<>|]+[\\/])*[^\\/\s:*?"<>|]*|(?<![\w.:/])(?:~|\.{1,2})?\/(?:[\w.-]+\/)*[\w.-]+)/gi,
  ibans: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
  versions: /(?<![\d.])v?\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?(?!\.?\d)/g,
};

export async function extract(args = {}) {
  const { text } = await readInput(args);
  const kinds = args.kinds?.length ? args.kinds : ['urls', 'emails', 'ipv4', 'dates', 'times', 'phones', 'money', 'percentages', 'hashtags', 'mentions', 'uuids', 'paths', 'versions'];
  const out = [];
  for (const k of kinds) {
    const re = EXTRACTORS[k];
    if (!re) throw new ToolError(`Unknown kind "${k}". Available: ${Object.keys(EXTRACTORS).join(', ')}`);
    const counts = new Map();
    for (const [m] of text.matchAll(re)) {
      const v = k === 'paths' || k === 'urls' ? m.trim().replace(/[.,;:]+$/, '') : m.trim();
      if (k === 'versions' && /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(v)) continue;
      if (k === 'phones' && v.replace(/\D/g, '').length < 7) continue;
      if (k === 'paths' && v.length < 3) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (!counts.size) continue;
    const list = args.sort === 'count' ? [...counts].sort((a, b) => b[1] - a[1]) : [...counts];
    const max = args.max ?? 100;
    out.push(`${k} (${counts.size} unique):`, ...list.slice(0, max).map(([v, n]) => `  ${v}${n > 1 ? `  ×${n}` : ''}`), ...(list.length > max ? [`  … ${list.length - max} more`] : []));
  }
  return out.length ? out.join('\n') : `Nothing found for: ${kinds.join(', ')}`;
}

