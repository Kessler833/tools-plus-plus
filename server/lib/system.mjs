// System tools: processes and ports, system info, parallel commands, log
// summaries and .env comparison.

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { ToolError, statOrNull, fmtBytes, fmtMs, intArg, readInput, clip } from './util.mjs';
import { killTree } from './bench.mjs';

const WIN = process.platform === 'win32';

function exec(cmd, args, { timeoutMs = 15_000, shell = false, cwd, signal, maxOut = 4e6 } = {}) {
  return new Promise((done) => {
    let child;
    try {
      // with a shell, pass one command line (args + shell is deprecated, DEP0190)
      child = shell ? spawn([cmd, ...args].join(' '), { shell, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return done({ code: -1, stdout: '', stderr: err.message, ms: 0 });
    }
    const t0 = Date.now();
    let stdout = '', stderr = '', killed = false;
    child.stdout.on('data', (d) => { if (stdout.length < maxOut) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < maxOut) stderr += d; });
    const kill = () => { killed = true; killTree(child); };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (err) => { clearTimeout(timer); done({ code: -1, stdout, stderr: err.code === 'ENOENT' ? 'not found' : err.message, ms: Date.now() - t0 }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      done({ code: code ?? -1, stdout, stderr, ms: Date.now() - t0, killed });
    });
  });
}

const ps = (script, timeoutMs) => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs });

// ---- processes ------------------------------------------------------------------

async function listProcesses() {
  if (WIN) {
    const r = await ps('Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64,StartTime,Path | ConvertTo-Json -Compress', 30_000);
    if (r.code !== 0) throw new ToolError(`Get-Process failed: ${r.stderr.trim().split('\n')[0]}`);
    const list = JSON.parse(r.stdout || '[]');
    return (Array.isArray(list) ? list : [list]).map((p) => ({
      pid: p.Id, name: p.ProcessName, cpuS: p.CPU ?? 0, mem: p.WorkingSet64 ?? 0,
      started: p.StartTime ? new Date(Number(/\d+/.exec(p.StartTime)?.[0] ?? Date.parse(p.StartTime))) : null, cmd: p.Path ?? '',
    }));
  }
  const r = await exec('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etimes=,comm=,args=']);
  if (r.code !== 0) throw new ToolError(`ps failed: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(l);
    if (!m) return null;
    return { pid: +m[1], name: m[6].split('/').pop(), cpuPct: +m[3], mem: +m[4] * 1024, started: new Date(Date.now() - m[5] * 1000), cmd: m[7] };
  }).filter(Boolean);
}

async function listeners() {
  if (WIN) {
    // netstat is ~20x faster than Get-NetTCPConnection. Its state column is localized
    // ("LISTENING", "ABHÖREN"), so a listener is recognized by its empty remote address.
    const r = await exec('netstat', ['-ano']);
    const out = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^\s*(TCP|UDP)\s+(\S+):(\d+)\s+(\S+)\s+(?:\S+\s+)?(\d+)\s*$/.exec(line);
      if (!m) continue;
      const listening = m[1] === 'UDP' || /^(0\.0\.0\.0|\[::\]):0$/.test(m[4]);
      if (listening) out.push({ proto: m[1].toLowerCase(), addr: m[2].replace(/^\[|\]$/g, ''), port: +m[3], pid: +m[5] });
    }
    return out;
  }
  let r = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpcnP']);
  if (r.code === 0 && r.stdout) {
    const out = [];
    let pid;
    for (const line of r.stdout.split('\n')) {
      if (line[0] === 'p') pid = +line.slice(1);
      if (line[0] === 'n') {
        const m = /^(.*):(\d+)$/.exec(line.slice(1));
        if (m) out.push({ proto: 'tcp', addr: m[1], port: +m[2], pid });
      }
    }
    return out;
  }
  r = await exec('ss', ['-ltnupH']);
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const parts = l.trim().split(/\s+/);
    const m = /^(.*):(\d+)$/.exec(parts[4] ?? '');
    const pid = /pid=(\d+)/.exec(l)?.[1];
    return m ? { proto: parts[0], addr: m[1], port: +m[2], pid: pid ? +pid : null } : null;
  }).filter(Boolean);
}

// pid -> name, cheaply (tasklist on Windows instead of Get-Process)
async function processNames() {
  if (!WIN) return new Map((await listProcesses().catch(() => [])).map((p) => [p.pid, p]));
  const r = await exec('tasklist', ['/fo', 'csv', '/nh']);
  const map = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line);
    if (m) map.set(+m[2], { pid: +m[2], name: m[1], cmd: '' });
  }
  return map;
}

const procLine = (p) => `${String(p.pid).padStart(7)}  ${fmtBytes(p.mem).padStart(10)}  ${p.cpuS !== undefined ? `${p.cpuS.toFixed(1)}s cpu`.padStart(12) : `${p.cpuPct}% cpu`.padStart(12)}  ${p.name}${p.cmd ? `  ${clip(p.cmd, 120)}` : ''}`;

export async function processes(args = {}) {
  const op = args.op ?? 'list';
  if (op === 'port') {
    const port = args.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ToolError('port must be 1-65535');
    const ls = await listeners();
    const hits = ls.filter((l) => l.port === port);
    if (!hits.length) return `Nothing is listening on port ${port}.`;
    const byPid = await processNames();
    return [`port ${port}:`, ...hits.map((h) => {
      const p = byPid.get(h.pid);
      return `  ${h.proto} ${h.addr}:${h.port}  PID ${h.pid ?? '?'}  ${p ? `${p.name}${p.cmd ? `  ${clip(p.cmd, 120)}` : ''}` : '(process details unavailable; may need admin rights)'}`;
    }), '', 'To free the port, use op "kill" with this PID.'].join('\n');
  }
  if (op === 'ports') {
    const [ls, byPid] = await Promise.all([listeners(), processNames()]);
    const rows = ls.filter((l) => l.proto === 'tcp').sort((a, b) => a.port - b.port);
    const seen = new Set();
    const lines = rows.filter((r) => !seen.has(`${r.port}/${r.pid}`) && seen.add(`${r.port}/${r.pid}`)).map((r) => `  ${String(r.port).padStart(5)}  ${r.addr.padEnd(15)}  PID ${String(r.pid ?? '?').padEnd(7)} ${byPid.get(r.pid)?.name ?? ''}`);
    return [`${lines.length} listening TCP port(s):`, ...lines].join('\n');
  }
  if (op === 'kill') {
    const pid = args.pid;
    if (!Number.isInteger(pid) || pid <= 0) throw new ToolError('kill needs a numeric pid');
    if (pid === process.pid || pid === process.ppid) throw new ToolError('Refusing to kill this tool server or its parent (Claude Code)');
    const r = WIN ? await exec('taskkill', ['/PID', String(pid), '/T', ...(args.force === false ? [] : ['/F'])]) : await exec('kill', [args.force === false ? '-TERM' : '-KILL', String(pid)]);
    if (r.code !== 0) throw new ToolError(`Could not kill PID ${pid}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
    return `killed PID ${pid}${WIN ? ' and its child processes' : ''}`;
  }
  if (op !== 'list') throw new ToolError('op must be list, port, ports or kill');
  let procs = await listProcesses();
  if (args.name) {
    const q = args.name.toLowerCase();
    procs = procs.filter((p) => p.name.toLowerCase().includes(q) || p.cmd.toLowerCase().includes(q));
  }
  const by = args.sort === 'cpu' ? (p) => p.cpuS ?? p.cpuPct : (p) => p.mem;
  procs.sort((a, b) => by(b) - by(a));
  const top = intArg(args.top, 'top', { min: 1, max: 500, def: 25 });
  const totalMem = procs.reduce((s, p) => s + p.mem, 0);
  return [`${procs.length} process(es)${args.name ? ` matching "${args.name}"` : ''}, ${fmtBytes(totalMem)} memory${WIN ? ' (cpu = total CPU seconds used)' : ''}:`, '    PID      memory           cpu  name', ...procs.slice(0, top).map(procLine)].join('\n');
}

// ---- sysinfo ------------------------------------------------------------------

const TOOLS = [
  ['node', ['--version']], ['npm', ['--version']], ['pnpm', ['--version']], ['yarn', ['--version']], ['bun', ['--version']], ['deno', ['--version']],
  ['python', ['--version']], ['python3', ['--version']], ['uv', ['--version']], ['pip', ['--version']],
  ['git', ['--version']], ['gh', ['--version']], ['docker', ['--version']], ['ffmpeg', ['-version']],
  ['java', ['-version']], ['go', ['version']], ['rustc', ['--version']], ['cargo', ['--version']], ['dotnet', ['--version']], ['gcc', ['--version']], ['clang', ['--version']],
];

let versionCache = null;  // { at, lines }: tool versions rarely change within a session

async function toolVersions() {
  if (versionCache && Date.now() - versionCache.at < 600_000) return versionCache.lines;
  const lines = (await Promise.all(TOOLS.map(async ([cmd, a]) => {
    const r = await exec(cmd, a, { timeoutMs: 5000, shell: WIN });
    const text = (r.stdout || r.stderr).trim().split('\n')[0];
    return r.code === 0 && text && !/not recognized|not found/i.test(text) ? `  ${cmd.padEnd(8)} ${clip(text.replace(/^(\w+ )?version /i, ''), 70)}` : null;
  }))).filter(Boolean);
  versionCache = { at: Date.now(), lines };
  return lines;
}

export async function sysinfo(args = {}) {
  const versionsPromise = toolVersions();  // start early, runs while the rest is gathered
  const cpus = os.cpus();
  const lines = [
    `os: ${os.version?.() ?? os.type()} ${os.release()} (${process.platform} ${os.arch()})`,
    `host: ${os.hostname()}   user: ${os.userInfo().username}   uptime: ${fmtMs(os.uptime() * 1000)}`,
    `cpu: ${cpus[0]?.model?.trim() ?? '?'} × ${cpus.length}${process.platform !== 'win32' ? `   load: ${os.loadavg().map((l) => l.toFixed(2)).join(' ')}` : ''}`,
    `memory: ${fmtBytes(os.totalmem() - os.freemem())} used of ${fmtBytes(os.totalmem())} (${fmtBytes(os.freemem())} free)`,
  ];
  const roots = WIN ? 'CDEFGHIJ'.split('').map((d) => `${d}:\\`) : ['/', os.homedir(), '/tmp'];
  const disks = [];
  for (const r of roots) {
    try {
      const s = await statfs(r);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      if (total > 0) disks.push(`  ${r.padEnd(14)} ${fmtBytes(free).padStart(10)} free of ${fmtBytes(total)} (${Math.round((free / total) * 100)}%)`);
    } catch {
      // drive not present
    }
  }
  lines.push('disks:', ...[...new Set(disks)]);
  if (WIN && args.gpu !== false) {
    const g = await ps('Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress', 15_000);
    try {
      const list = JSON.parse(g.stdout);
      for (const v of Array.isArray(list) ? list : [list]) lines.push(`gpu: ${v.Name} (driver ${v.DriverVersion})`);
    } catch {
      // no GPU info
    }
  }
  lines.push('tools on PATH:', ...(await versionsPromise));
  lines.push(`this server: node ${process.version} at ${process.execPath}`);
  return lines.join('\n');
}

// ---- run_parallel -------------------------------------------------------------

export async function runParallel(args = {}, ctx = {}) {
  const commands = args.commands;
  if (!Array.isArray(commands) || !commands.length || !commands.every((c) => typeof c === 'string' && c.trim())) throw new ToolError('commands must be a non-empty list of command strings');
  if (commands.length > 50) throw new ToolError('at most 50 commands');
  const concurrency = intArg(args.concurrency, 'concurrency', { min: 1, max: 16, def: Math.min(4, os.cpus().length) });
  const timeoutMs = (args.timeout_s ?? 300) * 1000;
  const cwd = args.cwd ? resolve(args.cwd) : process.cwd();
  if (!(await statOrNull(cwd))?.isDirectory()) throw new ToolError(`cwd is not a directory: ${cwd}`);
  const tailLines = intArg(args.tail, 'tail', { min: 0, max: 200, def: 15 });
  const results = new Array(commands.length);
  const abort = new AbortController();
  ctx.signal?.addEventListener('abort', () => abort.abort(), { once: true });
  let next = 0, done = 0;
  const t0 = Date.now();
  async function worker() {
    while (next < commands.length && !abort.signal.aborted) {
      const i = next++;
      const r = await exec(commands[i], [], { shell: true, cwd, timeoutMs, signal: abort.signal });
      results[i] = r;
      ctx.progress?.(++done, commands.length, commands[i]);
      if (args.stop_on_failure && r.code !== 0) abort.abort();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const tail = (s) => s.trimEnd().split('\n').slice(-tailLines).join('\n');
  const failed = results.filter((r) => r && r.code !== 0).length;
  const lines = [`${commands.length} command(s), ${concurrency} at a time, ${fmtMs(Date.now() - t0)} wall time: ${commands.length - failed - results.filter((r) => !r).length} ok, ${failed} failed${results.some((r) => !r) ? `, ${results.filter((r) => !r).length} not started` : ''}`];
  commands.forEach((c, i) => {
    const r = results[i];
    lines.push('', `${!r ? '·' : r.code === 0 ? '✓' : '✗'} $ ${c}${r ? `   (${r.killed ? 'TIMEOUT' : `exit ${r.code}`}, ${fmtMs(r.ms)})` : '   (not started)'}`);
    if (r && tailLines) {
      const out = tail(r.stdout), err = tail(r.stderr);
      if (out) lines.push(out.replace(/^/gm, '  │ '));
      if (err) lines.push(err.replace(/^/gm, '  ! '));
    }
  });
  return lines.join('\n');
}

// ---- log_summary --------------------------------------------------------------

const LEVEL = /\b(FATAL|CRITICAL|CRIT|ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i;
const TIMESTAMP = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

/** "user 4711 failed after 23ms" -> "user <n> failed after <n>ms" */
function template(line) {
  return line
    .replace(TIMESTAMP, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/"[^"]{1,200}"|'[^']{1,200}'/g, '<str>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@-]+){2,}/g, '<path>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function logSummary(args = {}, ctx = {}) {
  let lines;
  let label;
  if (typeof args.path === 'string' && args.text === undefined) {
    const full = resolve(args.path);
    const st = await statOrNull(full);
    if (!st?.isFile()) throw new ToolError(`File not found: ${full}`);
    label = `${full} (${fmtBytes(st.size)})`;
    lines = createInterface({ input: createReadStream(full, { encoding: 'utf8' }), crlfDelay: Infinity });
  } else {
    const { text } = await readInput(args);
    label = 'text';
    lines = text.split(/\r?\n/);
  }
  const top = intArg(args.top, 'top', { min: 1, max: 200, def: 20 });
  const levels = {}, groups = new Map();
  let n = 0, first = null, last = null, prev = null;
  for await (const raw of lines) {
    n++;
    if (n % 200_000 === 0) {
      if (ctx.signal?.aborted) throw new ToolError('Cancelled');
      ctx.progress?.(n);
    }
    if (!raw.trim()) continue;
    // stack-trace continuation lines belong to the previous entry
    if (prev && /^\s+(at |\.\.\.|File "|Caused by|\w+Error|Traceback)/.test(raw)) {
      prev.trace ??= raw.trim();
      continue;
    }
    const ts = TIMESTAMP.exec(raw)?.[1];
    if (ts) {
      first ??= ts;
      last = ts;
    }
    const level = (LEVEL.exec(raw)?.[1] ?? 'other').toUpperCase().replace(/^WARNING$/, 'WARN').replace(/^ERR$/, 'ERROR').replace(/^CRIT(ICAL)?$/, 'FATAL');
    levels[level] = (levels[level] ?? 0) + 1;
    const key = `${level}|${template(raw)}`;
    let g = groups.get(key);
    if (!g) {
      if (groups.size >= 50_000) continue;  // pathological variety; keep memory bounded
      groups.set(key, (g = { level, count: 0, firstLine: n, example: clip(raw.trim(), 300) }));
    }
    g.count++;
    g.lastLine = n;
    prev = g;
  }
  const order = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'other'];
  const fmtGroup = (g) => [`  ${String(g.count).padStart(6)}×  lines ${g.firstLine}${g.lastLine !== g.firstLine ? `–${g.lastLine}` : ''}: ${g.example}`, ...(g.trace ? [`          ↳ ${clip(g.trace, 200)}`] : [])];
  const problems = [...groups.values()].filter((g) => g.level === 'FATAL' || g.level === 'ERROR' || g.level === 'WARN').sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level) || b.count - a.count);
  const all = [...groups.values()].sort((a, b) => b.count - a.count);
  const out = [
    `${label}: ${n} lines, ${groups.size} distinct message pattern(s)`,
    first ? `time span: ${first} … ${last}` : null,
    `levels: ${order.filter((l) => levels[l]).map((l) => `${l} ${levels[l]}`).join(', ')}`,
  ].filter(Boolean);
  if (problems.length) {
    out.push('', `errors and warnings (${problems.length} pattern(s), most severe first):`);
    for (const g of problems.slice(0, top)) out.push(`  [${g.level}]`, ...fmtGroup(g));
  }
  out.push('', `most frequent patterns:`);
  for (const g of all.slice(0, top)) out.push(...fmtGroup(g));
  return out.join('\n');
}

// ---- env_compare --------------------------------------------------------------

/** dotenv parser: export, quotes, escapes, inline comments, multi-line double quotes. */
export function parseDotenv(text) {
  const vars = new Map(), dupes = [], errors = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      errors.push(`line ${i + 1}: not KEY=value`);
      continue;
    }
    let [, key, value] = m;
    if (value.startsWith('"')) {
      // read up to the closing unescaped quote, continuing onto following lines
      let buf = value.slice(1), out = '', closed = false;
      const startLine = i + 1;
      for (;;) {
        for (let j = 0; j < buf.length && !closed; j++) {
          const ch = buf[j];
          if (ch === '\\' && j + 1 < buf.length) {
            const e = buf[++j];
            out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          } else if (ch === '"') closed = true;
          else out += ch;
        }
        if (closed || i + 1 >= lines.length) break;
        out += '\n';
        buf = lines[++i];
      }
      if (!closed) errors.push(`line ${startLine}: unclosed double quote for ${key}`);
      value = out;
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = end < 0 ? value.slice(1) : value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (vars.has(key)) dupes.push(key);
    vars.set(key, { value, line: i + 1 });
  }
  return { vars, dupes, errors };
}

const shape = (v) => (v === '' ? 'EMPTY' : `set (${v.length} chars)`);

export async function envCompare(args = {}) {
  const dir = resolve(args.dir ?? '.');
  const envPath = resolve(dir, args.env ?? '.env');
  let examplePath = args.example ? resolve(dir, args.example) : null;
  if (!examplePath) {
    for (const n of ['.env.example', '.env.sample', '.env.template', '.env.dist', 'example.env']) {
      if (await statOrNull(join(dirname(envPath), n))) {
        examplePath = join(dirname(envPath), n);
        break;
      }
    }
  }
  const read = async (p) => {
    const st = await statOrNull(p);
    if (!st?.isFile()) return null;
    return parseDotenv((await readInput({ path: p })).text);
  };
  const env = await read(envPath);
  const ex = examplePath ? await read(examplePath) : null;
  if (!env && !ex) throw new ToolError(`Neither ${envPath} nor an example file found`);
  const lines = [];
  if (!env) {
    lines.push(`✗ ${envPath} is missing. Create it from ${examplePath} (${ex.vars.size} keys).`);
    return lines.join('\n');
  }
  if (!ex) lines.push(`(no example file next to ${envPath}; checking the env file alone)`);
  const missing = ex ? [...ex.vars.keys()].filter((k) => !env.vars.has(k)) : [];
  const extra = ex ? [...env.vars.keys()].filter((k) => !ex.vars.has(k)) : [];
  const empty = [...env.vars].filter(([, v]) => v.value === '').map(([k]) => k);
  const unchanged = ex ? [...env.vars].filter(([k, v]) => v.value && ex.vars.get(k)?.value === v.value && /your|change|example|xxx|placeholder|<|todo/i.test(v.value)).map(([k]) => k) : [];
  lines.unshift(`${envPath}: ${env.vars.size} keys${ex ? `   vs ${examplePath}: ${ex.vars.size} keys` : ''}`);
  if (missing.length) lines.push(`✗ missing in .env (${missing.length}): ${missing.join(', ')}`);
  if (empty.length) lines.push(`⚠ empty values (${empty.length}): ${empty.join(', ')}`);
  if (unchanged.length) lines.push(`⚠ still the example placeholder (${unchanged.length}): ${unchanged.join(', ')}`);
  if (extra.length) lines.push(`• only in .env, not documented in the example (${extra.length}): ${extra.join(', ')}`);
  if (env.dupes.length) lines.push(`⚠ defined twice, the last one wins: ${[...new Set(env.dupes)].join(', ')}`);
  if (env.errors.length) lines.push(`⚠ unparsable lines: ${env.errors.slice(0, 10).join('; ')}`);
  if (lines.length === 1) lines.push('✓ all example keys are present and set');
  if (args.show_keys) lines.push('', 'keys (values hidden):', ...[...env.vars].map(([k, v]) => `  ${k}: ${shape(v.value)}`));
  return lines.join('\n');
}
