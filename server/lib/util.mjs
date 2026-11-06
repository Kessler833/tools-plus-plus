// Shared helpers: tool errors, reading text/file inputs, HTTP, formatting.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const VERSION = '0.4.0';
export const USER_AGENT = `tools-plus-plus/${VERSION} (Claude Code plugin)`;

/** An expected failure; its message is shown to Claude as-is. */
export class ToolError extends Error {}

/** Where persistent data (snapshots) lives. Override with TOOLS_PP_HOME. */
export function dataDir(...parts) {
  return join(process.env.TOOLS_PP_HOME || join(homedir(), '.tools-plus-plus'), ...parts);
}

export async function statOrNull(path) {
  try {
    return await stat(path);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function decodeText(buffer, label = 'Input') {
  try {
    return utf8.decode(buffer).replace(/^﻿/, '');
  } catch {
    throw new ToolError(`${label} is not valid UTF-8 text (binary file?)`);
  }
}

/**
 * Resolve a `{ text }` or `{ path }` argument pair into text.
 * Returns { text, path, buffer } where path/buffer are set for files.
 */
export async function readInput(args, { text = 'text', path = 'path', maxBytes = 20e6, binary = false } = {}) {
  const t = args[text], p = args[path];
  if (t !== undefined && t !== null && p !== undefined && p !== null) throw new ToolError(`Give either ${text} or ${path}, not both`);
  if (typeof t === 'string') return { text: t.replace(/^﻿/, ''), path: null, buffer: null };
  if (typeof p === 'string' && p.trim()) {
    const full = resolve(p);
    const st = await statOrNull(full);
    if (!st) throw new ToolError(`File not found: ${full}`);
    if (st.isDirectory()) throw new ToolError(`${full} is a directory, expected a file`);
    if (st.size > maxBytes) throw new ToolError(`${full} is ${fmtBytes(st.size)}, limit is ${fmtBytes(maxBytes)}`);
    const buffer = await readFile(full);
    return { text: binary ? null : decodeText(buffer, full), path: full, buffer };
  }
  throw new ToolError(`Provide ${text} or ${path}`);
}

/** fetch() JSON with a timeout, a User-Agent and readable errors. */
export async function fetchJson(url, { signal, timeoutMs = 10_000, headers = {} } = {}) {
  const host = new URL(url).host;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.any(signals), headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers } });
  } catch (err) {
    if (signal?.aborted) throw new ToolError('Cancelled');
    const reason = err.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : (err.cause?.code ?? err.message);
    throw new ToolError(`Network error reaching ${host}: ${reason}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.message ?? body?.error?.message ?? body?.error ?? '';
    } catch {
      // body is not JSON
    }
    const err = new ToolError(`${host} answered HTTP ${res.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function sleep(ms, signal) {
  return new Promise((done, fail) => {
    if (signal?.aborted) return fail(new ToolError('Cancelled'));
    const onAbort = () => {
      clearTimeout(timer);
      fail(new ToolError('Cancelled'));
    };
    // remove the listener when the sleep ends normally, or polling loops pile them up
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      done();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 2 : 1)} ${units[i]}`;
}

export function fmtMs(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} min ${((ms % 60_000) / 1000).toFixed(1)} s`;
}

/** A float rounded to `sig` significant digits, without trailing noise. */
export function fmtNum(x, sig = 10) {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x);
  return String(Number(x.toPrecision(sig)));
}

export function clip(s, max) {
  return s.length <= max ? s : `${s.slice(0, max)}… (${s.length - max} more characters)`;
}

/** Positive integer argument with bounds and default. */
export function intArg(value, name, { min = 1, max = Infinity, def } = {}) {
  if (value === undefined || value === null) return def;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ToolError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
