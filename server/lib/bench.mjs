// Command benchmark: warmup, N timed runs, robust statistics, comparison.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { ToolError, fmtMs, intArg, statOrNull } from './util.mjs';

// With shell: true the child is the shell; on Windows its children survive a
// plain kill, so take down the whole tree.
export function killTree(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
}

function runOnce(command, { cwd, timeoutMs, signal }) {
  return new Promise((done) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '', killed = false;
    child.stderr.on('data', (d) => {
      if (stderr.length < 2000) stderr += d;
    });
    const kill = () => {
      killed = true;
      killTree(child);
    };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ ms: 0, code: -1, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      done({ ms, code: code ?? -1, killed, stderr });
    });
  });
}

function summarize(times) {
  const s = [...times].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const q = (p) => {
    const h = (n - 1) * p, lo = Math.floor(h);
    return lo + 1 < n ? s[lo] + (h - lo) * (s[lo + 1] - s[lo]) : s[lo];
  };
  return { n, mean, sd, median: q(0.5), min: s[0], max: s[n - 1], p95: q(0.95) };
}

export async function benchmark(args = {}, ctx = {}) {
  const commands = Array.isArray(args.commands) ? args.commands : [args.commands];
  if (!commands.length || !commands.every((c) => typeof c === 'string' && c.trim())) throw new ToolError('commands must be a non-empty list of command strings');
  if (commands.length > 10) throw new ToolError('at most 10 commands');
  const runs = intArg(args.runs, 'runs', { min: 1, max: 1000, def: 10 });
  const warmup = intArg(args.warmup, 'warmup', { min: 0, max: 100, def: 1 });
  const timeoutMs = (args.timeout_s ?? 60) * 1000;
  const budgetMs = (args.max_total_s ?? 300) * 1000;
  const cwd = args.cwd ? resolve(args.cwd) : process.cwd();
  if (!(await statOrNull(cwd))?.isDirectory()) throw new ToolError(`cwd is not a directory: ${cwd}`);

  const started = Date.now();
  const results = [];
  const total = commands.length * (runs + warmup);
  let done = 0;
  for (const command of commands) {
    const times = [];
    let failure = null, stopped = false;
    for (let i = 0; i < warmup + runs; i++) {
      if (ctx.signal?.aborted) throw new ToolError('Cancelled');
      if (Date.now() - started > budgetMs) {
        stopped = true;
        break;
      }
      const r = await runOnce(command, { cwd, timeoutMs, signal: ctx.signal });
      done++;
      ctx.progress?.(done, total, command);
      if (r.killed) {
        failure = `timed out after ${timeoutMs / 1000}s`;
        break;
      }
      if (r.code !== 0 && !args.ignore_failure) {
        failure = `exit code ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`;
        break;
      }
      if (i >= warmup) times.push(r.ms);
    }
    results.push({ command, times, failure, stopped });
  }

  const lines = [`${runs} run(s) each after ${warmup} warmup, cwd ${cwd}`, 'times include shell startup', ''];
  for (const r of results) {
    lines.push(`$ ${r.command}`);
    if (r.failure) lines.push(`  ✗ failed: ${r.failure}`);
    if (r.times.length) {
      const s = summarize(r.times);
      lines.push(`  mean ${fmtMs(s.mean)} ± ${fmtMs(s.sd)}   median ${fmtMs(s.median)}   min ${fmtMs(s.min)}   max ${fmtMs(s.max)}   p95 ${fmtMs(s.p95)}   (n=${s.n})`);
      if (s.n > 2 && s.sd / s.mean > 0.25) lines.push('  note: high variance (>25%); results may be noisy, try more runs');
      r.summary = s;
    }
    if (r.stopped) lines.push(`  stopped early: total time budget of ${budgetMs / 1000}s reached`);
  }
  const ok = results.filter((r) => r.summary);
  if (ok.length > 1) {
    const fastest = ok.reduce((a, b) => (a.summary.median <= b.summary.median ? a : b));
    lines.push('', `fastest (by median): ${fastest.command}`);
    for (const r of ok) {
      if (r !== fastest) lines.push(`  ${(r.summary.median / fastest.summary.median).toFixed(2)}× slower: ${r.command}`);
    }
  }
  return lines.join('\n');
}
