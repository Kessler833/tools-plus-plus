// Encoders/decoders (base64, hex, URL, HTML, JSON strings, Unicode escapes,
// punycode, JWT) and hashing of text or files of any size.

import { createHash, createHmac, getHashes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { domainToASCII, domainToUnicode } from 'node:url';
import { ToolError, readInput, statOrNull, fmtBytes, clip } from './util.mjs';

const utf8 = new TextDecoder('utf-8', { fatal: true });

function bytesToText(buf) {
  try {
    const text = utf8.decode(buf);
    if (!/[\u0000-\u0008\u000E-\u001F]/.test(text)) return { text };
  } catch {
    // not UTF-8
  }
  return { binary: true };
}

function hexdump(buf, max = 256) {
  const lines = [];
  for (let i = 0; i < Math.min(buf.length, max); i += 16) {
    const chunk = buf.subarray(i, i + 16);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (buf.length > max) lines.push(`… ${buf.length - max} more bytes`);
  return lines.join('\n');
}

const MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], 'PNG image'], [[0xff, 0xd8, 0xff], 'JPEG image'], [[0x47, 0x49, 0x46, 0x38], 'GIF image'],
  [[0x25, 0x50, 0x44, 0x46], 'PDF document'], [[0x50, 0x4b, 0x03, 0x04], 'ZIP archive (also docx/xlsx/jar)'],
  [[0x1f, 0x8b], 'gzip data'], [[0x52, 0x49, 0x46, 0x46], 'RIFF (WAV/WebP/AVI)'], [[0x7f, 0x45, 0x4c, 0x46], 'ELF binary'],
  [[0x4d, 0x5a], 'Windows executable'], [[0x00, 0x00, 0x00], 'possibly MP4/MOV'],
];
const sniff = (buf) => MAGIC.find(([sig]) => sig.every((b, i) => buf[i] === b))?.[1];

async function emitBytes(buf, outPath) {
  if (outPath) {
    const full = resolve(outPath);
    if (await statOrNull(full)) throw new ToolError(`${full} already exists; choose a new out_path`);
    await writeFile(full, buf);
    return `wrote ${buf.length} bytes to ${full}${sniff(buf) ? ` (${sniff(buf)})` : ''}`;
  }
  const t = bytesToText(buf);
  if (t.text !== undefined) return t.text;
  return `binary data, ${buf.length} bytes${sniff(buf) ? ` (looks like ${sniff(buf)})` : ''}; pass out_path to save it\n${hexdump(buf)}`;
}

function decodeBase64(input) {
  const s = input.replace(/\s+/g, '').replace(/^data:[^,]*;base64,/, '');
  if (!/^[A-Za-z0-9+/\-_]*={0,2}$/.test(s)) {
    const bad = s.match(/[^A-Za-z0-9+/\-_=]/);
    throw new ToolError(`Not base64: unexpected character ${JSON.stringify(bad?.[0] ?? '=')} at position ${bad ? s.indexOf(bad[0]) + 1 : s.indexOf('=') + 1}`);
  }
  if (s.replace(/=+$/, '').length % 4 === 1) throw new ToolError('Not base64: length is impossible (one character too many or missing)');
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const HTML_NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', euro: '€', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', deg: '°', times: '×', divide: '÷', middot: '·', bull: '•', trade: '™' };

function htmlUnescape(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return HTML_NAMED[e] ?? m;
  });
}

function unicodeUnescape(s) {
  return s.replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\U([0-9a-f]{8})/gi, (m, a, b, c, d) => {
    const cp = parseInt(a ?? b ?? c ?? d, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

function jwtDecode(token) {
  const parts = token.trim().replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3) throw new ToolError(`A JWT has 3 dot-separated parts, this has ${parts.length}`);
  const part = (p, name) => {
    try {
      return JSON.parse(decodeBase64(p).toString('utf8'));
    } catch {
      throw new ToolError(`JWT ${name} is not base64url JSON`);
    }
  };
  const header = part(parts[0], 'header'), payload = part(parts[1], 'payload');
  const now = Date.now() / 1000;
  const lines = ['header:', JSON.stringify(header, null, 2), 'payload:', JSON.stringify(payload, null, 2)];
  for (const claim of ['iat', 'nbf', 'exp']) {
    if (typeof payload[claim] === 'number') {
      const rel = payload[claim] - now;
      const when = `${Math.abs(rel) < 172800 ? `${Math.round(Math.abs(rel) / 60)} min` : `${Math.round(Math.abs(rel) / 86400)} days`} ${rel < 0 ? 'ago' : 'from now'}`;
      lines.push(`${claim}: ${new Date(payload[claim] * 1000).toISOString()} (${when})`);
    }
  }
  if (typeof payload.exp === 'number') lines.push(payload.exp < now ? 'status: EXPIRED' : 'status: not expired');
  lines.push('signature: present but NOT verified (decoding only)');
  return lines.join('\n');
}

function inspect(s) {
  const chars = [...s];
  const rows = chars.slice(0, 200).map((ch, i) => {
    const cp = ch.codePointAt(0);
    const bytes = [...Buffer.from(ch, 'utf8')].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const cat = /\p{L}/u.test(ch) ? 'letter' : /\p{N}/u.test(ch) ? 'number' : /\p{Z}|\s/u.test(ch) ? 'space' : /\p{P}/u.test(ch) ? 'punct' : /\p{S}/u.test(ch) ? 'symbol' : /\p{Cf}/u.test(ch) ? 'FORMAT (invisible)' : /\p{Cc}/u.test(ch) ? 'CONTROL' : /\p{M}/u.test(ch) ? 'combining mark' : 'other';
    const shown = /\p{Cc}|\p{Cf}|\s/u.test(ch) ? JSON.stringify(ch).slice(1, -1) || '·' : ch;
    return `${String(i + 1).padStart(4)}  U+${cp.toString(16).toUpperCase().padStart(4, '0')}  ${shown.padEnd(6)} ${cat.padEnd(18)} utf8: ${bytes}`;
  });
  if (chars.length > 200) rows.push(`… ${chars.length - 200} more characters`);
  return `${chars.length} code points, ${Buffer.byteLength(s)} UTF-8 bytes, NFC-normalized: ${s.normalize('NFC') === s ? 'yes' : 'NO'}\n${rows.join('\n')}`;
}

const OPS = {
  base64_encode: (s) => Buffer.from(s, 'utf8').toString('base64'),
  base64url_encode: (s) => Buffer.from(s, 'utf8').toString('base64url'),
  base64_decode: (s, o) => emitBytes(decodeBase64(s), o),
  hex_encode: (s) => Buffer.from(s, 'utf8').toString('hex'),
  hex_decode: (s, o) => {
    const h = s.replace(/^0x/i, '').replace(/[\s:-]/g, '');
    if (!/^([0-9a-f]{2})*$/i.test(h)) throw new ToolError('Not hex: needs an even number of 0-9a-f digits');
    return emitBytes(Buffer.from(h, 'hex'), o);
  },
  url_encode: (s) => encodeURIComponent(s),
  url_decode: (s) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      throw new ToolError('Malformed percent-encoding (an incomplete %XX sequence or invalid UTF-8)');
    }
  },
  html_escape: (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  html_unescape: htmlUnescape,
  json_escape: (s) => JSON.stringify(s),
  json_unescape: (s) => {
    const t = s.trim();
    try {
      return JSON.parse(t.startsWith('"') ? t : `"${t}"`);
    } catch (err) {
      throw new ToolError(`Not a valid JSON string: ${err.message}`);
    }
  },
  unicode_escape: (s) => [...s].map((ch) => {
    const cp = ch.codePointAt(0);
    if (cp < 128) return ch;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
  }).join(''),
  unicode_unescape: unicodeUnescape,
  punycode_encode: (s) => domainToASCII(s.trim()) || (() => { throw new ToolError('Not a valid domain name'); })(),
  punycode_decode: (s) => domainToUnicode(s.trim()) || (() => { throw new ToolError('Not a valid domain name'); })(),
  rot13: (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26) + (c <= 'Z' ? 65 : 97))),
  jwt_decode: jwtDecode,
  inspect,
};

export async function encode(args = {}) {
  const op = args.op;
  if (!OPS[op]) throw new ToolError(`Unknown op "${op}". Options: ${Object.keys(OPS).join(', ')}`);
  const { text } = await readInput(args);
  return OPS[op](text, args.out_path);
}

// ---- hashing ------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32() {
  let crc = 0xffffffff;
  return {
    update(buf) {
      for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
    },
    digest() {
      return Buffer.from(((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0'), 'hex');
    },
  };
}

const ALIASES = { sha3: 'sha3-256', 'sha-256': 'sha256', 'sha-1': 'sha1', 'sha-512': 'sha512', blake2: 'blake2b512' };

function makeHasher(name, key) {
  const algo = ALIASES[name.toLowerCase()] ?? name.toLowerCase();
  if (algo === 'crc32') {
    if (key !== undefined) throw new ToolError('crc32 does not support a key');
    return crc32();
  }
  if (!getHashes().includes(algo)) throw new ToolError(`Unknown algorithm "${name}". Common: md5, sha1, sha256, sha512, sha3-256, blake2b512, crc32`);
  return key !== undefined ? createHmac(algo, key) : createHash(algo);
}

export async function hash(args = {}, ctx = {}) {
  const algorithms = args.algorithms ?? ['sha256'];
  if (!Array.isArray(algorithms) || !algorithms.length) throw new ToolError('algorithms must be a non-empty array');
  const hashers = algorithms.map((a) => [a, makeHasher(a, args.key)]);
  let label;
  if (typeof args.path === 'string' && args.text === undefined) {
    const full = resolve(args.path);
    const st = await statOrNull(full);
    if (!st) throw new ToolError(`File not found: ${full}`);
    if (!st.isFile()) throw new ToolError(`${full} is not a file`);
    label = `${full} (${fmtBytes(st.size)})`;
    let done = 0;
    for await (const chunk of createReadStream(full, { highWaterMark: 1 << 20, signal: ctx.signal })) {
      for (const [, h] of hashers) h.update(chunk);
      done += chunk.length;
      if (st.size > 50e6) ctx.progress?.(done, st.size);
    }
  } else {
    const { text } = await readInput(args);
    label = `text (${Buffer.byteLength(text)} UTF-8 bytes)`;
    for (const [, h] of hashers) h.update(Buffer.from(text, 'utf8'));
  }
  const expected = args.expected?.trim().toLowerCase();
  const lines = [label];
  let matched = false;
  for (const [name, h] of hashers) {
    const d = h.digest();
    const hex = d.toString('hex'), b64 = d.toString('base64');
    const hit = expected && (hex === expected || b64.toLowerCase() === expected);
    matched ||= hit;
    lines.push(`${args.key !== undefined ? 'hmac-' : ''}${name}: ${hex}${args.base64 ? `  base64: ${b64}` : ''}${hit ? '  ✓ MATCHES expected' : ''}`);
  }
  if (expected && !matched) lines.push(`✗ expected ${clip(args.expected.trim(), 140)} does NOT match any computed hash`);
  return lines.join('\n');
}
