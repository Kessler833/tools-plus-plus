// Regex tester: matches with line/column and groups, replacement preview and
// test cases. Each run happens in a worker with a hard timeout.

import { Worker } from 'node:worker_threads';
import { ToolError, readInput, intArg, clip } from './util.mjs';

const WORKER = new URL('./regex-worker.mjs', import.meta.url);

function runWorker(data, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    const finish = (fn, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new ToolError(
      `Regex timed out after ${timeoutMs / 1000}s. This usually means catastrophic backtracking: nested quantifiers like (a+)+ or (.*)* ` +
      'or overlapping alternatives. Make quantified parts mutually exclusive or anchor the pattern.')), timeoutMs);
    const onAbort = () => finish(reject, new ToolError('Cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (msg) => finish(resolve, msg));
    worker.once('error', (err) => finish(reject, new ToolError(`Regex worker failed: ${err.message}`)));
  });
}

// "/ab+c/gi" -> { pattern: 'ab+c', flags: 'gi' }
function splitLiteral(pattern, flags) {
  const m = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(pattern);
  if (m && flags === undefined) return { pattern: m[1], flags: m[2] };
  return { pattern, flags: flags ?? '' };
}

function lineCol(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: index - starts[lo] + 1 };
  };
}

const show = (s) => JSON.stringify(s.length > 200 ? s.slice(0, 200) + '…' : s);

export async function regexTest(args = {}, ctx = {}) {
  if (typeof args.pattern !== 'string' || !args.pattern) throw new ToolError('pattern is required');
  const { pattern, flags } = splitLiteral(args.pattern, args.flags);
  if (/[^dgimsuvy]/.test(flags) || new Set(flags).size !== flags.length) throw new ToolError(`Invalid flags "${flags}" (allowed: d g i m s u v y, each once)`);
  const cases = args.cases;
  if (cases !== undefined && (!Array.isArray(cases) || !cases.every((c) => typeof c === 'string'))) throw new ToolError('cases must be an array of strings');
  let text = '';
  if (args.text !== undefined || args.path !== undefined) text = (await readInput(args)).text;
  else if (!cases) throw new ToolError('Provide text, path or cases');
  const max = intArg(args.max_matches, 'max_matches', { min: 1, max: 1000, def: 50 });
  const timeout = intArg(args.timeout_ms, 'timeout_ms', { min: 100, max: 30_000, def: 2000 });

  const r = await runWorker({ pattern, flags, text, replace: args.replace, max, cases }, timeout, ctx.signal);
  if (!r.ok) throw new ToolError(`Invalid regex: ${r.error}`);

  const out = [`/${pattern}/${flags}`];
  if (args.text !== undefined || args.path !== undefined) {
    const where = lineCol(text);
    out.push(`${r.total}${r.capped ? '+' : ''} match(es)${r.total > r.matches.length ? `, showing first ${r.matches.length}` : ''}`);
    r.matches.forEach((m, i) => {
      const { line, col } = where(m.index);
      let s = `#${i + 1} line ${line}, col ${col}: ${show(m.text)}`;
      if (m.named) s += '  ' + Object.entries(m.named).map(([k, v]) => `${k}=${v === undefined ? '∅' : show(v)}`).join(' ');
      else if (m.groups.length) s += '  ' + m.groups.map((g, j) => `$${j + 1}=${g === undefined ? '∅' : show(g)}`).join(' ');
      out.push(s);
    });
    if (r.total && !flags.includes('g')) out.push('(listing all matches; without the g flag, replace and exec use only the first)');
    if (r.replaced !== undefined) out.push('', `after replace${flags.includes('g') ? ' (all)' : ' (first match only, add g for all)'}:`, clip(r.replaced, 5000));
  }
  if (r.cases) {
    out.push('', 'cases:');
    for (const c of r.cases) {
      const mark = c.full ? '✓ full match' : c.match !== null ? `~ partial match ${show(c.match)}` : '✗ no match';
      out.push(`${mark}  ${show(c.input)}${c.groups.length && c.match !== null ? '  groups: ' + c.groups.map((g) => (g === undefined ? '∅' : show(g))).join(', ') : ''}`);
    }
  }
  return out.join('\n');
}
