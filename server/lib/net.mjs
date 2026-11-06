// HTTP requests with timing and redirect chains, plus DNS, TCP reachability
// and TLS certificate checks.

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { ToolError, USER_AGENT, fmtBytes, clip, intArg } from './util.mjs';

const KEY_HEADERS = /^(content-(type|length|encoding|disposition)|location|cache-control|etag|last-modified|expires|server|set-cookie|www-authenticate|retry-after|x-ratelimit-(remaining|reset)|access-control-allow-(origin|methods|headers|credentials)|allow|x-powered-by)$/i;

const ms = (a, b) => (a !== undefined && b !== undefined ? `${(b - a).toFixed(0)} ms` : '-');

function request(url, { method, headers, body, timeoutMs, insecure, signal }) {
  return new Promise((done, fail) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) return fail(new ToolError(`Unsupported protocol ${u.protocol}`));
    const t = { start: performance.now() };
    const req = lib.request(u, { method, headers, rejectUnauthorized: !insecure, signal, agent: false }, (res) => {
      t.firstByte = performance.now();
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size <= 5e6) chunks.push(d);
      });
      res.on('end', () => {
        t.end = performance.now();
        done({ status: res.statusCode, statusText: res.statusMessage, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks), size, timing: t, httpVersion: res.httpVersion, tls: req.socket?.getProtocol?.() });
      });
      res.on('error', fail);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new ToolError(`Timed out after ${timeoutMs / 1000}s`)));
    req.on('socket', (s) => {
      s.on('lookup', () => { t.dns = performance.now(); });
      s.on('connect', () => { t.connect = performance.now(); });
      s.on('secureConnect', () => { t.tls = performance.now(); });
    });
    req.on('error', (err) => {
      if (err instanceof ToolError) return fail(err);
      if (signal?.aborted) return fail(new ToolError('Cancelled'));
      const hint = { ECONNREFUSED: 'connection refused (nothing listening?)', ENOTFOUND: 'host not found (DNS)', ECONNRESET: 'connection reset', CERT_HAS_EXPIRED: 'TLS certificate expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate (pass insecure: true for local dev)', SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in chain', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate chain cannot be verified', ERR_TLS_CERT_ALTNAME_INVALID: 'certificate does not match the host name' }[err.code];
      fail(new ToolError(`${u.host}: ${hint ?? err.code ?? err.message}`));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function prettyBody(buf, contentType, max) {
  if (!buf.length) return '(empty body)';
  const type = (contentType ?? '').toLowerCase();
  const text = buf.toString('utf8');
  if (type.includes('json') || /^\s*[{[]/.test(text)) {
    try {
      return clip(JSON.stringify(JSON.parse(text), null, 2), max);
    } catch {
      // not JSON after all
    }
  }
  if (/^(image|audio|video|font)\/|octet-stream|zip|pdf/.test(type) || text.includes('��')) return `(binary, ${fmtBytes(buf.length)})`;
  return clip(text, max);
}

export async function httpTool(args = {}, ctx = {}) {
  if (typeof args.url !== 'string') throw new ToolError('url is required');
  let url;
  try {
    url = new URL(/^\w+:\/\//.test(args.url) ? args.url : `http://${args.url}`).href;
  } catch {
    throw new ToolError(`Invalid URL: ${args.url}`);
  }
  const method = (args.method ?? (args.body !== undefined || args.json !== undefined ? 'POST' : 'GET')).toUpperCase();
  const headers = { 'user-agent': USER_AGENT, accept: '*/*', ...(args.headers ?? {}) };
  let body;
  if (args.json !== undefined) {
    body = JSON.stringify(args.json);
    headers['content-type'] ??= 'application/json';
  } else if (args.body !== undefined) body = String(args.body);
  if (body !== undefined) headers['content-length'] = Buffer.byteLength(body);
  const timeoutMs = (args.timeout_s ?? 30) * 1000;
  const maxRedirects = args.follow === false ? 0 : 10;
  const chain = [];
  let res, current = url, m = method, b = body;
  for (let hop = 0; ; hop++) {
    res = await request(current, { method: m, headers, body: b, timeoutMs, insecure: args.insecure, signal: ctx.signal });
    chain.push(`${res.status} ${current}`);
    const loc = res.headers.location;
    if (![301, 302, 303, 307, 308].includes(res.status) || !loc || hop >= maxRedirects) break;
    current = new URL(loc, current).href;
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === 'POST')) {
      m = 'GET';
      b = undefined;
      delete headers['content-length'];
      delete headers['content-type'];
    }
  }
  const t = res.timing;
  const max = intArg(args.max_body, 'max_body', { min: 0, max: 50_000, def: 4000 });
  const show = args.show_headers;
  const out = [
    `${m} ${current}`,
    `→ ${res.status} ${res.statusText}   HTTP/${res.httpVersion}${res.tls ? ` ${res.tls}` : ''}   ${fmtBytes(res.size)}   total ${ms(t.start, t.end)}`,
    `timing: dns ${ms(t.start, t.dns)}, connect ${ms(t.dns ?? t.start, t.connect)}${t.tls ? `, tls ${ms(t.connect, t.tls)}` : ''}, first byte ${ms(t.tls ?? t.connect ?? t.start, t.firstByte)}, download ${ms(t.firstByte, t.end)}`,
  ];
  if (chain.length > 1) out.push(`redirects: ${chain.join(' → ')}`);
  // default: only headers that usually matter; show_headers: true lists all
  const pairs = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
  const shown = show === true ? pairs : pairs.filter(([k]) => KEY_HEADERS.test(k));
  if (shown.length) out.push('headers:', ...shown.map(([k, v]) => `  ${k}: ${clip(v, 300)}`));
  if (shown.length < pairs.length) out.push(`  (${pairs.length - shown.length} more; show_headers: true for all)`);
  if (max && m !== 'HEAD') out.push('body:', prettyBody(res.body, res.headers['content-type'], max));
  return out.join('\n');
}

// ---- net ----------------------------------------------------------------------

function tcpProbe(host, port, timeoutMs) {
  return new Promise((done) => {
    const t0 = performance.now();
    const s = net.connect({ host, port });
    const finish = (ok, why) => {
      s.destroy();
      done({ ok, ms: performance.now() - t0, why });
    };
    s.setTimeout(timeoutMs, () => finish(false, 'timeout'));
    s.once('connect', () => finish(true));
    s.once('error', (e) => finish(false, e.code));
  });
}

function certInfo(host, port, timeoutMs) {
  return new Promise((done, fail) => {
    const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs });
    s.once('secureConnect', () => {
      const c = s.getPeerCertificate(true);
      const info = { authorized: s.authorized, error: s.authorizationError, protocol: s.getProtocol(), cipher: s.getCipher()?.name, cert: c, alpn: s.alpnProtocol };
      s.end();
      done(info);
    });
    s.once('timeout', () => { s.destroy(); fail(new ToolError('TLS handshake timed out')); });
    s.once('error', (e) => fail(new ToolError(`TLS to ${host}:${port} failed: ${e.code ?? e.message}`)));
  });
}

const RECORDS = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'SRV'];

export async function netTool(args = {}) {
  const op = args.op ?? 'dns';
  let host = String(args.host ?? '').trim();
  if (!host) throw new ToolError('host is required');
  if (/^\w+:\/\//.test(host)) host = new URL(host).hostname;
  const timeoutMs = (args.timeout_s ?? 5) * 1000;

  if (op === 'dns') {
    const types = args.types?.map((t) => t.toUpperCase()) ?? ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];
    const bad = types.filter((t) => !RECORDS.includes(t));
    if (bad.length) throw new ToolError(`Unknown record type(s) ${bad.join(', ')}; use ${RECORDS.join(', ')}`);
    const lines = [`DNS for ${host}:`];
    const results = await Promise.all(types.map(async (t) => {
      try {
        return [t, await dns.resolve(host, t)];
      } catch (e) {
        return [t, e.code === 'ENODATA' || e.code === 'ENOTFOUND' ? null : `error ${e.code}`];
      }
    }));
    let any = false;
    for (const [t, r] of results) {
      if (!r || (Array.isArray(r) && !r.length)) continue;
      any = true;
      const items = typeof r === 'string' ? [r] : Array.isArray(r) ? r : [r];
      for (const v of items) {
        const text = typeof v === 'string' ? v : Array.isArray(v) ? v.join('') : t === 'MX' ? `${v.priority} ${v.exchange}` : t === 'SOA' ? `${v.nsname} ${v.hostmaster} serial ${v.serial}` : JSON.stringify(v);
        lines.push(`  ${t.padEnd(5)} ${clip(text, 300)}`);
      }
    }
    if (!any) {
      const sys = await dns.lookup(host, { all: true }).catch(() => []);
      lines.push(sys.length ? `  (only via the system resolver / hosts file) ${sys.map((a) => a.address).join(', ')}` : '  no records (does the domain exist?)');
    }
    return lines.join('\n');
  }

  if (op === 'reach') {
    const ports = args.ports ?? [args.port ?? 443];
    const addrs = await dns.lookup(host, { all: true }).catch(() => null);
    if (!addrs) throw new ToolError(`${host}: cannot resolve`);
    const lines = [`${host} → ${addrs.map((a) => a.address).join(', ')}`];
    for (const p of ports) {
      const tries = [];
      for (let i = 0; i < (args.attempts ?? 3); i++) tries.push(await tcpProbe(host, p, timeoutMs));
      const ok = tries.filter((t) => t.ok);
      lines.push(`  tcp ${p}: ${ok.length ? `open, connect ${Math.min(...ok.map((t) => t.ms)).toFixed(1)}–${Math.max(...ok.map((t) => t.ms)).toFixed(1)} ms (${ok.length}/${tries.length})` : `not reachable (${tries[0].why})`}`);
    }
    return lines.join('\n');
  }

  if (op === 'tls') {
    const port = args.port ?? 443;
    const info = await certInfo(host, port, timeoutMs);
    const c = info.cert;
    if (!c || !c.valid_to) throw new ToolError('Server sent no certificate');
    const days = Math.floor((Date.parse(c.valid_to) - Date.now()) / 86_400_000);
    const chain = [];
    for (let x = c, i = 0; x && i < 6; x = x.issuerCertificate === x ? null : x.issuerCertificate, i++) chain.push(x.subject?.CN ?? x.subject?.O ?? '?');
    return [
      `${host}:${port}  ${info.protocol}  ${info.cipher}${info.alpn ? `  alpn ${info.alpn}` : ''}`,
      `subject: ${c.subject?.CN ?? JSON.stringify(c.subject)}`,
      `issuer: ${c.issuer?.CN ?? ''}${c.issuer?.O ? ` (${c.issuer.O})` : ''}`,
      `valid: ${new Date(c.valid_from).toISOString().slice(0, 10)} → ${new Date(c.valid_to).toISOString().slice(0, 10)}  ${days < 0 ? `EXPIRED ${-days} days ago` : `${days} days left${days < 21 ? '  ⚠ renew soon' : ''}`}`,
      `names: ${clip((c.subjectaltname ?? '').replace(/DNS:/g, ''), 500)}`,
      `chain: ${chain.join(' ← ')}`,
      `trusted: ${info.authorized ? 'yes' : `NO (${info.error})`}`,
      `sha256 fingerprint: ${c.fingerprint256}`,
    ].join('\n');
  }
  throw new ToolError('op must be dns, reach or tls');
}
