// Block until something happens: a file appears, disappears or stops
// growing, a port opens or closes, a URL answers, or a process exits.

import { connect } from 'node:net';
import { resolve } from 'node:path';
import { ToolError, sleep, statOrNull, fmtMs, fmtBytes, USER_AGENT } from './util.mjs';

function portOpen(host, port, timeoutMs = 1500) {
  return new Promise((done) => {
    const sock = connect({ host, port });
    const finish = (ok) => {
      sock.destroy();
      done(ok);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

function parseHostPort(target) {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(String(target).trim()) ?? /^()()(\d+)$/.exec(String(target).trim());
  if (!m) throw new ToolError('port target must be "host:port" or just a port number');
  const port = Number(m[3]);
  if (port < 1 || port > 65535) throw new ToolError('port must be 1-65535');
  return { host: m[1] || m[2] || '127.0.0.1', port };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';  // exists but belongs to someone else
  }
}

async function urlCheck(url, { status, contains }, signal) {
  try {
    const res = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(5000), signal].filter(Boolean)), headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
    const statusOk = status ? res.status === status : res.status < 400;
    if (!statusOk) return { ok: false, detail: `HTTP ${res.status}` };
    if (contains) {
      const body = await res.text();
      if (!body.includes(contains)) return { ok: false, detail: `HTTP ${res.status}, text not found yet` };
    }
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err.cause?.code ?? err.name };
  }
}

export async function waitFor(args = {}, ctx = {}) {
  const { condition, target } = args;
  if (target === undefined || target === null || target === '') throw new ToolError('target is required');
  const timeoutS = args.timeout_s ?? 60;
  if (typeof timeoutS !== 'number' || timeoutS <= 0 || timeoutS > 3600) throw new ToolError('timeout_s must be between 0 and 3600');
  const intervalMs = Math.max(100, Math.min(args.interval_ms ?? 500, 60_000));
  const stableS = args.stable_s ?? 3;
  const start = Date.now();
  const deadline = start + timeoutS * 1000;

  let check;
  switch (condition) {
    case 'file_exists':
    case 'file_gone': {
      const path = resolve(target);
      check = async () => {
        const st = await statOrNull(path);
        return condition === 'file_exists' ? { ok: !!st, detail: st ? `${path} exists (${fmtBytes(st.size)})` : `${path} missing` } : { ok: !st, detail: st ? `${path} still exists` : `${path} is gone` };
      };
      break;
    }
    case 'file_stable': {
      // done when the file exists and size + mtime did not change for stable_s seconds
      const path = resolve(target);
      let last = null, since = 0;
      check = async () => {
        const st = await statOrNull(path);
        if (!st) {
          last = null;
          return { ok: false, detail: `${path} missing` };
        }
        const sig = `${st.size}:${st.mtimeMs}`;
        if (sig !== last) {
          last = sig;
          since = Date.now();
        }
        const steady = Date.now() - since;
        return { ok: steady >= stableS * 1000, detail: `${path} ${fmtBytes(st.size)}, unchanged for ${fmtMs(steady)}` };
      };
      break;
    }
    case 'port_open':
    case 'port_closed': {
      const { host, port } = parseHostPort(target);
      check = async () => {
        const open = await portOpen(host, port);
        return { ok: condition === 'port_open' ? open : !open, detail: `${host}:${port} ${open ? 'open' : 'closed'}` };
      };
      break;
    }
    case 'url_ok': {
      let url;
      try {
        url = new URL(target).href;
      } catch {
        throw new ToolError('url_ok needs a full URL like http://localhost:3000/health');
      }
      check = () => urlCheck(url, args, ctx.signal);
      break;
    }
    case 'process_exit': {
      const pid = Number(target);
      if (!Number.isInteger(pid) || pid <= 0) throw new ToolError('process_exit needs a numeric PID');
      check = async () => {
        const alive = processAlive(pid);
        return { ok: !alive, detail: `PID ${pid} ${alive ? 'running' : 'not running'}` };
      };
      break;
    }
    default:
      throw new ToolError('condition must be file_exists, file_gone, file_stable, port_open, port_closed, url_ok or process_exit');
  }

  let result, polls = 0, lastReport = start;
  for (;;) {
    result = await check();
    polls++;
    if (result.ok) return `✓ ${condition} after ${fmtMs(Date.now() - start)}: ${result.detail}`;
    if (Date.now() >= deadline) break;
    if (Date.now() - lastReport >= 5000) {
      lastReport = Date.now();
      ctx.progress?.(Math.round((Date.now() - start) / 1000), timeoutS, result.detail);
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), ctx.signal);
  }
  throw new ToolError(`Timed out after ${timeoutS}s waiting for ${condition} (${polls} checks). Last state: ${result.detail}`);
}
