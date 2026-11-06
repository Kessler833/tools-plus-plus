// Randomness from node:crypto (or a seeded PRNG for reproducible results):
// integers of any size, floats, normal samples, choices, shuffles, UUIDs,
// passwords, dice, coins and raw bytes.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ToolError, intArg } from './util.mjs';

// ---- sources ------------------------------------------------------------------

function cryptoSource() {
  let pool = Buffer.alloc(0), at = 0;
  return {
    seeded: false,
    u32() {
      if (at + 4 > pool.length) {
        pool = randomBytes(4096);
        at = 0;
      }
      const v = pool.readUInt32LE(at);
      at += 4;
      return v;
    },
  };
}

// sfc32, seeded from SHA-256 of the seed text
function seededSource(seed) {
  const h = createHash('sha256').update(String(seed)).digest();
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12);
  const next = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  for (let i = 0; i < 12; i++) next();
  return { seeded: true, u32: next };
}

// uniform BigInt in [0, n) by rejection sampling, no modulo bias
function below(src, n) {
  if (n <= 0n) throw new ToolError('Empty range');
  const bits = n.toString(2).length;
  const words = Math.ceil(bits / 32);
  const mask = (1n << BigInt(bits)) - 1n;
  for (;;) {
    let v = 0n;
    for (let i = 0; i < words; i++) v = (v << 32n) | BigInt(src.u32());
    v &= mask;
    if (v < n) return v;
  }
}

const belowInt = (src, n) => Number(below(src, BigInt(n)));
const unit = (src) => (src.u32() * 2 ** 21 + (src.u32() >>> 11)) / 2 ** 53;  // 53 random bits in [0, 1)

function shuffleInPlace(src, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = belowInt(src, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function toBig(v, name) {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  throw new ToolError(`${name} must be an integer (use a string for huge values)`);
}

// ---- generators ---------------------------------------------------------------

function ints(src, { min = 1, max = 100, count, unique }) {
  const lo = toBig(min, 'min'), hi = toBig(max, 'max');
  if (hi < lo) throw new ToolError('max must be >= min');
  const range = hi - lo + 1n;
  if (unique && BigInt(count) > range) throw new ToolError(`Cannot draw ${count} unique values from a range of ${range}`);
  const out = [];
  if (unique && range <= 1_000_000n && BigInt(count) * 2n > range) {
    // dense: partial Fisher-Yates over the whole range
    const pool = Array.from({ length: Number(range) }, (_, i) => i);
    for (let i = 0; i < count; i++) {
      const j = i + belowInt(src, pool.length - i);
      [pool[i], pool[j]] = [pool[j], pool[i]];
      out.push(lo + BigInt(pool[i]));
    }
  } else {
    const seen = new Set();
    while (out.length < count) {
      const v = lo + below(src, range);
      if (unique) {
        if (seen.has(v)) continue;
        seen.add(v);
      }
      out.push(v);
    }
  }
  return `${out.join(', ')}\n(${unique ? 'unique ' : ''}integers in [${lo}, ${hi}])`;
}

function floats(src, { min = 0, max = 1, count, decimals }) {
  if (typeof min !== 'number' || typeof max !== 'number' || !(max > min)) throw new ToolError('float needs numeric min < max');
  const out = Array.from({ length: count }, () => {
    const v = min + unit(src) * (max - min);
    return decimals === undefined ? v : Number(v.toFixed(decimals));
  });
  return `${out.join(', ')}\n(uniform floats in [${min}, ${max}))`;
}

function normals(src, { mean = 0, sd = 1, count, decimals }) {
  if (typeof mean !== 'number' || typeof sd !== 'number' || sd < 0) throw new ToolError('normal needs numeric mean and sd >= 0');
  const out = [];
  while (out.length < count) {
    const u = 1 - unit(src), v = unit(src);  // Box-Muller; u in (0, 1]
    const r = Math.sqrt(-2 * Math.log(u));
    for (const z of [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)]) {
      const x = mean + sd * z;
      if (out.length < count) out.push(decimals === undefined ? x : Number(x.toFixed(decimals)));
    }
  }
  return `${out.join(', ')}\n(normal distribution, mean ${mean}, sd ${sd})`;
}

const show = (item) => (typeof item === 'string' ? item : JSON.stringify(item));

function choose(src, { items, count, unique }) {
  if (!Array.isArray(items) || !items.length) throw new ToolError('choice needs a non-empty items array');
  if (unique && count > items.length) throw new ToolError(`Cannot pick ${count} unique items from ${items.length}`);
  const picked = unique ? shuffleInPlace(src, [...items]).slice(0, count) : Array.from({ length: count }, () => items[belowInt(src, items.length)]);
  return picked.map(show).join('\n');
}

const CLASSES = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!#$%&*+-=?@^_~.,:;',
};

function password(src, { length = 20, count, charset, no_ambiguous }) {
  const len = intArg(length, 'length', { min: 4, max: 512 });
  const classes = (charset ?? 'lower,upper,digits,symbols').split(',').map((c) => c.trim()).filter(Boolean);
  const sets = classes.map((c) => {
    if (!CLASSES[c]) throw new ToolError(`Unknown charset "${c}"; use lower, upper, digits, symbols`);
    return no_ambiguous ? CLASSES[c].replace(/[Il1O0o|]/g, '') : CLASSES[c];
  });
  if (len < sets.length) throw new ToolError('length is shorter than the number of character classes');
  const all = sets.join('');
  const bitsEach = Math.log2(all.length);
  const out = Array.from({ length: count }, () => {
    for (;;) {
      const chars = Array.from({ length: len }, () => all[belowInt(src, all.length)]);
      if (sets.every((s) => chars.some((ch) => s.includes(ch)))) return chars.join('');  // every class present
    }
  });
  return `${out.join('\n')}\n(${len} chars from ${all.length} symbols, ~${Math.floor(bitsEach * len)} bits of entropy${src.seeded ? '; SEEDED, NOT SECRET' : ''})`;
}

function dice(src, { dice: notation = '1d6', count }) {
  const m = /^\s*(\d*)\s*d\s*(\d+)\s*(?:(k[hl]?)(\d+))?\s*([+-]\s*\d+)?\s*$/i.exec(String(notation));
  if (!m) throw new ToolError('dice notation like 2d6, d20, 3d8+4 or 4d6kh3 (keep highest 3)');
  const n = m[1] ? Number(m[1]) : 1, sides = Number(m[2]);
  const keepMode = m[3]?.toLowerCase() === 'kl' ? 'low' : m[3] ? 'high' : null;
  const keep = m[4] ? Number(m[4]) : n;
  const mod = m[5] ? Number(m[5].replace(/\s/g, '')) : 0;
  if (n < 1 || n > 1000 || sides < 2 || sides > 1e9) throw new ToolError('1-1000 dice with 2 or more sides');
  if (keep < 1 || keep > n) throw new ToolError('keep count must be between 1 and the number of dice');
  const lines = [];
  for (let r = 0; r < count; r++) {
    const rolls = Array.from({ length: n }, () => belowInt(src, sides) + 1);
    let kept = rolls;
    if (keepMode) kept = [...rolls].sort((a, b) => (keepMode === 'high' ? b - a : a - b)).slice(0, keep);
    const total = kept.reduce((a, b) => a + b, 0) + mod;
    lines.push(`${total}   [${rolls.join(', ')}]${keepMode ? ` kept ${kept.join(', ')}` : ''}${mod ? ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)}` : ''}`);
  }
  return `${notation}:\n${lines.join('\n')}`;
}

function coins(src, { count }) {
  const flips = Array.from({ length: count }, () => (belowInt(src, 2) ? 'H' : 'T'));
  const heads = flips.filter((f) => f === 'H').length;
  return `${count <= 200 ? flips.join(' ') + '\n' : ''}heads ${heads}, tails ${count - heads}`;
}

function bytes(src, { length = 32 }) {
  const len = intArg(length, 'length', { min: 1, max: 4096 });
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = src.u32() & 0xff;
  return `hex: ${buf.toString('hex')}\nbase64: ${buf.toString('base64')}\nbase64url: ${buf.toString('base64url')}`;
}

// ---- tool entry ---------------------------------------------------------------

export function random(args = {}) {
  const kind = args.kind ?? 'int';
  const count = intArg(args.count, 'count', { min: 1, max: 10_000, def: 1 });
  const src = args.seed !== undefined && args.seed !== null ? seededSource(args.seed) : cryptoSource();
  const decimals = intArg(args.decimals, 'decimals', { min: 0, max: 15 });
  const a = { ...args, count, decimals };
  switch (kind) {
    case 'int': return ints(src, a);
    case 'float': return floats(src, a);
    case 'normal': return normals(src, a);
    case 'choice': return choose(src, a);
    case 'shuffle':
      if (!Array.isArray(args.items) || !args.items.length) throw new ToolError('shuffle needs a non-empty items array');
      return shuffleInPlace(src, [...args.items]).map(show).join('\n');
    case 'uuid':
      if (src.seeded) throw new ToolError('uuid ignores seed; omit it');
      return Array.from({ length: count }, () => randomUUID()).join('\n');
    case 'password': return password(src, a);
    case 'dice': return dice(src, a);
    case 'coin': return coins(src, a);
    case 'bytes': return bytes(src, a);
    default: throw new ToolError(`Unknown kind "${kind}"`);
  }
}
