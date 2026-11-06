// Secret scanner for text, files and directories. Findings are always masked:
// the tool must never echo a full credential back into the conversation.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { ToolError, statOrNull, intArg } from './util.mjs';

const RULES = [
  ['Private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['AWS access key ID', /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g],
  ['AWS secret access key', /aws.{0,20}?(?:secret|private).{0,20}?['"=:\s]([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi, 1],
  ['Anthropic API key', /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}/g],
  ['OpenAI API key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,}/g],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{48}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['Slack webhook', /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g],
  ['Discord webhook', /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g],
  ['Stripe key', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{28}\b/g],
  ['Hugging Face token', /\bhf_[A-Za-z]{34}\b/g],
  ['Groq API key', /\bgsk_[A-Za-z0-9]{52}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['PyPI token', /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g],
  ['SendGrid key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g],
  ['Twilio key', /\bSK[0-9a-f]{32}\b/g],
  ['Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
  ['Azure storage key', /AccountKey=[A-Za-z0-9+/]{86}==/g],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['URL with password', /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/'"]{1,64}:([^\s:@/'"]{3,128})@[^\s'"]+/gi, 1],
];

// The key must END in a secret word (api_key, DB_PASSWORD, authToken), so
// code like `const tokens = ...` or `passwordField` does not count.
const KEY = String.raw`[A-Za-z0-9_.-]*?(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)`;
// quoted values anywhere: password = "...", "api_key": '...'
const QUOTED = new RegExp(String.raw`\b(${KEY})["']?\s*[:=]\s*(?:"([^"\n]{8,200})"|'([^'\n]{8,200})')`, 'gi');
// unquoted values only as a whole config line (.env, ini, yaml): SECRET_TOKEN=abc...
const CONFIG_LINE = new RegExp(String.raw`^[ \t]*(?:export[ \t]+)?(${KEY})[ \t]*[:=][ \t]*([^\s'"#]{8,200})[ \t]*$`, 'gim');
const CODE_LIKE = /[(){}[\]$`;,<>]|^\/.*\/[a-z]*$|^(?:process|os|env|this|self)\./i;
const PLACEHOLDER = /^(?:x+|\*+|\.+|<.*>|\{\{.*\}\}|\$\{.*\}|\$[A-Z_]+|%.*%|(?:your|my|example|sample|dummy|test|fake|changeme|placeholder|redacted|replace|insert|todo|none|null|undefined|password|secret|token)[\w-]*|.*(?:_here|-here)|process\.env.*|os\.environ.*|env\(.*)$/i;

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', '.cache', 'target', '.idea', '.vs']);
const MAX_FILE = 2e6;

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) h -= (c / s.length) * Math.log2(c / s.length);
  return h;
}

export function mask(secret) {
  if (secret.length <= 8) return '*'.repeat(secret.length);
  const show = Math.min(6, Math.floor(secret.length / 5));
  return `${secret.slice(0, show)}…${secret.slice(-2)} (${secret.length} chars)`;
}

function scanText(text) {
  const found = [];
  const seen = new Set();
  const lineOf = (index) => {
    const before = text.slice(0, index);
    const line = (before.match(/\n/g) || []).length + 1;
    return { line, col: index - before.lastIndexOf('\n') };
  };
  for (const [name, re, group] of RULES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = group ? m[group] : m[0];
      const index = m.index + (group ? m[0].indexOf(value) : 0);
      if (seen.has(index)) continue;
      seen.add(index);
      found.push({ name, value, ...lineOf(index), confidence: 'high' });
    }
  }
  const candidates = [
    ...[...text.matchAll(QUOTED)].map((m) => ({ m, key: m[1], value: m[2] ?? m[3] })),
    ...[...text.matchAll(CONFIG_LINE)].map((m) => ({ m, key: m[1], value: m[2] })).filter((c) => !CODE_LIKE.test(c.value)),
  ];
  for (const { m, key, value } of candidates) {
    const index = m.index + m[0].lastIndexOf(value);
    if ([...seen].some((s) => Math.abs(s - index) < value.length)) continue;
    if (PLACEHOLDER.test(value.trim()) || /\s/.test(value) || entropy(value) < 3) continue;
    if (/^(?:true|false|\d+)$/i.test(value)) continue;
    seen.add(index);
    found.push({ name: `Possible secret in "${key}"`, value, ...lineOf(index), confidence: entropy(value) > 3.8 ? 'medium' : 'low' });
  }
  return found.sort((a, b) => a.line - b.line || a.col - b.col);
}

async function* walk(dir, root, limits) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) {
        limits.skippedDirs++;
        continue;
      }
      yield* walk(full, root, limits);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function secretScan(args = {}, ctx = {}) {
  const maxFindings = intArg(args.max_findings, 'max_findings', { min: 1, max: 1000, def: 100 });
  const results = [];
  const limits = { files: 0, skippedDirs: 0, skippedBinary: 0, skippedLarge: 0 };

  if (typeof args.text === 'string') {
    results.push(...scanText(args.text).map((f) => ({ ...f, file: 'text' })));
  } else if (typeof args.path === 'string') {
    const root = resolve(args.path);
    const st = await statOrNull(root);
    if (!st) throw new ToolError(`Not found: ${root}`);
    const files = st.isDirectory() ? walk(root, root, limits) : [root];
    for await (const file of files) {
      if (ctx.signal?.aborted) throw new ToolError('Cancelled');
      const fst = await stat(file).catch(() => null);
      if (!fst) continue;
      if (fst.size > MAX_FILE) {
        limits.skippedLarge++;
        continue;
      }
      const buf = await readFile(file).catch(() => null);
      if (!buf) continue;
      if (isBinary(buf)) {
        limits.skippedBinary++;
        continue;
      }
      limits.files++;
      const rel = st.isDirectory() ? relative(root, file) : file;
      results.push(...scanText(buf.toString('utf8')).map((f) => ({ ...f, file: rel })));
      if (results.length >= maxFindings * 2) break;
    }
  } else {
    throw new ToolError('Provide text or path');
  }

  const min = { high: 3, medium: 2, low: 1 }[args.min_confidence ?? 'low'] ?? 1;
  const filtered = results.filter((r) => ({ high: 3, medium: 2, low: 1 })[r.confidence] >= min);
  const header = typeof args.path === 'string'
    ? `scanned ${limits.files} file(s)${limits.skippedBinary ? `, skipped ${limits.skippedBinary} binary` : ''}${limits.skippedLarge ? `, ${limits.skippedLarge} over 2 MB` : ''}${limits.skippedDirs ? `, ${limits.skippedDirs} vendor/VCS dirs (.git, node_modules, ...)` : ''}`
    : 'scanned text';
  if (!filtered.length) return `${header}\nNo secrets found.`;
  const lines = filtered.slice(0, maxFindings).map((r) => `[${r.confidence}] ${r.file}:${r.line}:${r.col}  ${r.name}: ${mask(r.value)}`);
  if (filtered.length > maxFindings) lines.push(`… ${filtered.length - maxFindings} more`);
  return [`${header}\n${filtered.length} potential secret(s), values masked:`, ...lines].join('\n');
}
