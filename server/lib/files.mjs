// File tools: disk usage, duplicate finder, batch rename (preview, undo) and
// zip/tar/gz archives without dependencies (zip-slip and zip-bomb safe).

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, writeFile, utimes } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import zlib from 'node:zlib';
import { ToolError, dataDir, statOrNull, fmtBytes, intArg } from './util.mjs';

const VENDOR = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);

async function dirArg(path, name = 'path') {
  if (typeof path !== 'string' || !path.trim()) throw new ToolError(`${name} is required`);
  const full = resolve(path);
  const st = await statOrNull(full);
  if (!st) throw new ToolError(`Not found: ${full}`);
  return { full, st };
}

/** Depth-first walk yielding { full, rel, size, mtimeMs, dir } without following links. */
async function* walk(root, { skipVendor = false, signal } = {}) {
  const stack = [root];
  while (stack.length) {
    if (signal?.aborted) throw new ToolError('Cancelled');
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;  // unreadable folder
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (skipVendor && VENDOR.has(e.name)) continue;
        stack.push(full);
        yield { full, rel: relative(root, full), dir: true };
      } else if (e.isFile()) {
        const st = await lstat(full).catch(() => null);
        if (st) yield { full, rel: relative(root, full), size: st.size, mtimeMs: st.mtimeMs, dir: false };
      }
    }
  }
}

const pct = (part, total) => (total ? `${((part / total) * 100).toFixed(1)}%` : '0%');

// ---- disk_usage ---------------------------------------------------------------

export async function diskUsage(args = {}, ctx = {}) {
  const { full, st } = await dirArg(args.path);
  if (!st.isDirectory()) return `${full}: ${fmtBytes(st.size)} (a single file)`;
  const top = intArg(args.top, 'top', { min: 1, max: 200, def: 15 });
  const depth = intArg(args.depth, 'depth', { min: 1, max: 5, def: 1 });
  const groups = new Map(), exts = new Map(), largest = [];
  let total = 0, files = 0, dirs = 0;
  const minLargest = () => (largest.length < top ? -1 : largest[largest.length - 1].size);
  for await (const f of walk(full, { signal: ctx.signal })) {
    if (f.dir) {
      dirs++;
      continue;
    }
    files++;
    total += f.size;
    const parts = f.rel.split(sep);
    const key = parts.length > depth ? parts.slice(0, depth).join('/') + '/' : parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '(files here)';
    const g = groups.get(key) ?? { size: 0, files: 0 };
    g.size += f.size;
    g.files++;
    groups.set(key, g);
    const ext = extname(f.rel).toLowerCase() || '(none)';
    const e = exts.get(ext) ?? { size: 0, files: 0 };
    e.size += f.size;
    e.files++;
    exts.set(ext, e);
    if (f.size > minLargest()) {
      largest.push({ rel: f.rel, size: f.size });
      largest.sort((a, b) => b.size - a.size);
      if (largest.length > top) largest.pop();
    }
    if (files % 5000 === 0) ctx.progress?.(files, undefined, `${files} files`);
  }
  const rows = (map) => [...map].sort((a, b) => b[1].size - a[1].size).slice(0, top);
  const width = Math.max(...[...groups.keys()].map((k) => k.length).slice(0, 500), 10);
  return [
    `${full}: ${fmtBytes(total)} in ${files} files, ${dirs} folders`,
    '',
    `by folder (depth ${depth}):`,
    ...rows(groups).map(([k, g]) => `  ${fmtBytes(g.size).padStart(10)}  ${pct(g.size, total).padStart(6)}  ${k.padEnd(Math.min(width, 60))}  ${g.files} files`),
    '',
    'by extension:',
    ...rows(exts).map(([k, e]) => `  ${fmtBytes(e.size).padStart(10)}  ${pct(e.size, total).padStart(6)}  ${k}  (${e.files})`),
    '',
    'largest files:',
    ...largest.map((f) => `  ${fmtBytes(f.size).padStart(10)}  ${f.rel}`),
  ].join('\n');
}

// ---- find_duplicates ----------------------------------------------------------

function hashFile(path, limit) {
  return new Promise((done, fail) => {
    const h = createHash('sha256');
    createReadStream(path, limit ? { start: 0, end: limit - 1 } : {}).on('data', (d) => h.update(d)).on('error', fail).on('end', () => done(h.digest('hex')));
  });
}

export async function findDuplicates(args = {}, ctx = {}) {
  const { full, st } = await dirArg(args.path);
  if (!st.isDirectory()) throw new ToolError('path must be a folder');
  const minSize = args.min_size ?? 1;
  const exts = args.extensions?.map((e) => '.' + e.replace(/^\./, '').toLowerCase());
  const bySize = new Map();
  let scanned = 0;
  for await (const f of walk(full, { skipVendor: !args.include_vendor, signal: ctx.signal })) {
    if (f.dir || f.size < minSize) continue;
    if (exts && !exts.includes(extname(f.rel).toLowerCase())) continue;
    scanned++;
    const list = bySize.get(f.size) ?? [];
    list.push(f);
    bySize.set(f.size, list);
  }
  // same size -> same first 64 KiB -> same full hash
  const groups = [];
  let hashed = 0;
  for (const [size, list] of bySize) {
    if (list.length < 2) continue;
    const byHead = new Map();
    for (const f of list) {
      const h = await hashFile(f.full, 65536).catch(() => null);
      if (h) byHead.set(h, [...(byHead.get(h) ?? []), f]);
    }
    for (const same of byHead.values()) {
      if (same.length < 2) continue;
      const byFull = new Map();
      for (const f of same) {
        const h = size <= 65536 ? 'head' : await hashFile(f.full).catch(() => null);
        if (h) byFull.set(h, [...(byFull.get(h) ?? []), f]);
        if (++hashed % 100 === 0) ctx.progress?.(hashed);
      }
      for (const dup of byFull.values()) if (dup.length > 1) groups.push({ size, files: dup });
    }
  }
  groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
  const wasted = groups.reduce((s, g) => s + g.size * (g.files.length - 1), 0);
  if (!groups.length) return `scanned ${scanned} files in ${full}: no duplicates${args.include_vendor ? '' : ' (skipped .git, node_modules, venvs)'}`;
  const max = intArg(args.max_groups, 'max_groups', { min: 1, max: 500, def: 30 });
  const lines = [`scanned ${scanned} files: ${groups.length} duplicate group(s), ${fmtBytes(wasted)} reclaimable (keeping one copy each)`];
  for (const g of groups.slice(0, max)) {
    lines.push('', `${g.files.length} × ${fmtBytes(g.size)}:`);
    const sorted = [...g.files].sort((a, b) => a.mtimeMs - b.mtimeMs);
    sorted.forEach((f, i) => lines.push(`  ${i === 0 ? '(oldest) ' : ''}${f.rel}`));
  }
  if (groups.length > max) lines.push('', `… ${groups.length - max} more groups`);
  lines.push('', 'Nothing was deleted.');
  return lines.join('\n');
}

// ---- batch_rename -------------------------------------------------------------

const CASES = {
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  title: (s) => s.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  slug: (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
};

function globToRegex(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

async function planRenames(args, dir) {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  const match = args.match ? globToRegex(args.match) : null;
  let find = null;
  if (args.find !== undefined) {
    try {
      find = new RegExp(args.find, args.ignore_case ? 'gi' : 'g');
    } catch (err) {
      throw new ToolError(`Invalid find regex: ${err.message}`);
    }
  }
  if (args.case && !CASES[args.case]) throw new ToolError(`case must be ${Object.keys(CASES).join(', ')}`);
  const selected = entries.filter((n) => !match || match.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const start = args.start ?? 1;
  const pad = args.pad ?? String(start + selected.length - 1).length;
  const plan = [];
  selected.forEach((name, i) => {
    const ext = extname(name), stem = basename(name, ext);
    let newStem = stem;
    if (find) newStem = newStem.replace(find, args.replace ?? '');
    if (args.case) newStem = CASES[args.case](newStem);
    if (args.template) {
      newStem = args.template.replace(/\{name\}/g, newStem).replace(/\{n\}/g, String(start + i).padStart(pad, '0')).replace(/\{ext\}/g, ext.slice(1));
    }
    const newExt = args.extension !== undefined ? (args.extension ? '.' + args.extension.replace(/^\./, '') : '') : args.case ? CASES[args.case === 'slug' ? 'lower' : args.case](ext) : ext;
    const to = newStem + newExt;
    if (to !== name) plan.push({ from: name, to });
  });
  return { plan, total: selected.length };
}

function checkPlan(plan, existing) {
  const problems = [];
  const targets = new Map();
  const moving = new Set(plan.map((p) => p.from.toLowerCase()));
  for (const p of plan) {
    // also invalid on Windows: device names (CON, NUL.txt, COM1) and a trailing dot or space
    if (!p.to || /[<>:"/\\|?*\u0000-\u001f]/.test(p.to) || /^\.+$/.test(p.to) || /[. ]$/.test(p.to) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p.to)) problems.push(`invalid name "${p.to}" (from ${p.from})`);
    const key = p.to.toLowerCase();  // case-insensitive file systems
    if (targets.has(key)) problems.push(`${targets.get(key)} and ${p.from} would both become ${p.to}`);
    targets.set(key, p.from);
    if (existing.has(key) && !moving.has(key) && key !== p.from.toLowerCase()) problems.push(`${p.to} already exists`);
  }
  return problems;
}

export async function batchRename(args = {}) {
  if (args.undo) {
    if (!/^[\w-]+$/.test(args.undo)) throw new ToolError('Invalid undo id');
    let log;
    try {
      log = JSON.parse(await readFile(dataDir('renames', `${args.undo}.json`), 'utf8'));
    } catch {
      throw new ToolError(`No rename log "${args.undo}"`);
    }
    const reverse = log.plan.map((p) => ({ from: p.to, to: p.from }));
    await applyPlan(log.dir, reverse);
    return `undone: ${reverse.length} file(s) renamed back in ${log.dir}`;
  }
  const { full: dir, st } = await dirArg(args.path);
  if (!st.isDirectory()) throw new ToolError('path must be a folder');
  if (args.find === undefined && !args.case && !args.template && args.extension === undefined) throw new ToolError('Give find/replace, case, template or extension');
  const { plan, total } = await planRenames(args, dir);
  const existing = new Set((await readdir(dir)).map((n) => n.toLowerCase()));
  const problems = checkPlan(plan, existing);
  const preview = plan.slice(0, 200).map((p) => `  ${p.from}  →  ${p.to}`);
  if (plan.length > 200) preview.push(`  … ${plan.length - 200} more`);
  if (!plan.length) return `${total} file(s) matched; no name would change.`;
  if (problems.length) return [`✗ not renaming, ${problems.length} problem(s):`, ...problems.slice(0, 30).map((p) => `  ${p}`), '', 'planned:', ...preview].join('\n');
  if (!args.apply) return [`preview: ${plan.length} of ${total} file(s) would be renamed (pass apply: true to do it):`, ...preview].join('\n');
  await applyPlan(dir, plan);
  const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
  await mkdir(dataDir('renames'), { recursive: true });
  await writeFile(dataDir('renames', `${id}.json`), JSON.stringify({ dir, plan }));
  return [`renamed ${plan.length} file(s). Undo with undo: "${id}"`, ...preview].join('\n');
}

// two phases through temporary names, so swaps (a→b, b→a) and case-only changes work
async function applyPlan(dir, plan) {
  const tag = `.tpp-${randomBytes(3).toString('hex')}`;
  const done = [];
  try {
    for (const p of plan) {
      await rename(join(dir, p.from), join(dir, p.from + tag));
      done.push(p);
    }
    for (const p of plan) await rename(join(dir, p.from + tag), join(dir, p.to));
  } catch (err) {
    for (const p of done) await rename(join(dir, p.from + tag), join(dir, p.from)).catch(() => {});
    throw new ToolError(`Rename failed (${err.code ?? err.message}); restored original names where possible`);
  }
}

// ---- archive ------------------------------------------------------------------

const crc32 = zlib.crc32 ?? ((buf) => {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
});

function kindOf(path, given) {
  if (given) return given;
  const p = path.toLowerCase();
  if (p.endsWith('.zip') || p.endsWith('.jar') || p.endsWith('.docx') || p.endsWith('.xlsx') || p.endsWith('.pptx') || p.endsWith('.epub')) return 'zip';
  if (p.endsWith('.tar.gz') || p.endsWith('.tgz')) return 'tgz';
  if (p.endsWith('.tar')) return 'tar';
  if (p.endsWith('.gz')) return 'gz';
  throw new ToolError('Cannot tell the archive type from the name; pass format zip, tar, tgz or gz');
}

/** Safe destination for an archive entry, or null if it would escape the folder. */
function safeTarget(dest, name) {
  const clean = name.replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean.split('/').includes('..') || /[:*?"<>|]/.test(clean)) return null;
  const target = resolve(dest, clean);
  return target === dest || target.startsWith(dest + sep) ? target : null;
}

// --- zip

async function readZipEntries(fh, size) {
  const tailLen = Math.min(size, 65557);
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ToolError('Not a zip file (no end-of-central-directory record)');
  let count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new ToolError('Broken zip64 archive');
    const z64 = Buffer.alloc(56);
    await fh.read(z64, 0, 56, Number(tail.readBigUInt64LE(loc + 8)));
    count = Number(z64.readBigUInt64LE(32));
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOffset = Number(z64.readBigUInt64LE(48));
  }
  const cd = Buffer.alloc(cdSize);
  await fh.read(cd, 0, cdSize, cdOffset);
  const entries = [];
  for (let p = 0, i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new ToolError('Corrupt zip central directory');
    const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
    const dosTime = cd.readUInt16LE(p + 12), dosDate = cd.readUInt16LE(p + 14);
    let comp = cd.readUInt32LE(p + 20), uncomp = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const rawName = cd.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1');
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e), len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncomp === 0xffffffff) { uncomp = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (comp === 0xffffffff) { comp = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (offset === 0xffffffff) offset = Number(extra.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    const mtime = new Date(1980 + (dosDate >> 9), ((dosDate >> 5) & 15) - 1, dosDate & 31, dosTime >> 11, (dosTime >> 5) & 63, (dosTime & 31) * 2);
    entries.push({ name, dir: name.endsWith('/'), method, encrypted: !!(flags & 1), crc: cd.readUInt32LE(p + 16), comp, size: uncomp, offset, mtime });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function zipEntryData(fh, e, maxOut) {
  const head = Buffer.alloc(30);
  await fh.read(head, 0, 30, e.offset);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new ToolError(`Corrupt local header for ${e.name}`);
  const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const raw = Buffer.alloc(e.comp);
  await fh.read(raw, 0, e.comp, start);
  let data;
  if (e.method === 0) data = raw;
  else if (e.method === 8) {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(maxOut, e.size + 1)) });
    } catch (err) {
      throw new ToolError(err.code === 'ERR_BUFFER_TOO_LARGE' ? `${e.name} expands beyond its declared size (zip bomb?)` : `Cannot inflate ${e.name}: ${err.message}`);
    }
  } else throw new ToolError(`${e.name} uses unsupported compression method ${e.method}`);
  if (data.length !== e.size || crc32(data) !== e.crc) throw new ToolError(`CRC/size mismatch in ${e.name}; archive is corrupt`);
  return data;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

function buildZip(items) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const it of items) {
    const name = Buffer.from(it.name, 'utf8');
    const data = it.data ?? Buffer.alloc(0);
    const deflated = data.length > 64 ? zlib.deflateRawSync(data, { level: 6 }) : null;
    const useDeflate = deflated && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    if (offset > 0xfffffff0 || body.length > 0xfffffff0) throw new ToolError('Archives over 4 GiB are not supported for writing');
    const { time, date } = dosDateTime(it.mtime ?? new Date());
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(it.dir ? 0x10 : 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  if (items.length > 0xfffe) throw new ToolError('Too many entries for a zip (max 65534)');
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// --- tar

function parseTar(buf) {
  const entries = [];
  let p = 0, longName = null, pax = {};
  const str = (b) => b.toString('utf8').replace(/\0.*$/s, '');
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h.subarray(345, 500));
    let name = (prefix ? prefix + '/' : '') + str(h.subarray(0, 100));
    const data = buf.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(data); continue; }
    if (type === 'x') {
      for (const rec of data.toString('utf8').split('\n')) {
        const m = /^\d+ ([^=]+)=(.*)$/.exec(rec);
        if (m) pax[m[1]] = m[2];
      }
      continue;
    }
    if (type === 'g') continue;
    name = pax.path ?? longName ?? name;
    longName = null;
    pax = {};
    const mtime = new Date(parseInt(str(h.subarray(136, 148)).trim() || '0', 8) * 1000);
    entries.push({ name, type, dir: type === '5', link: type === '1' || type === '2', size, data, mtime });
  }
  return entries;
}

function buildTar(items) {
  const blocks = [];
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  for (const it of items) {
    const name = it.name + (it.dir && !it.name.endsWith('/') ? '/' : '');
    const data = it.data ?? Buffer.alloc(0);
    const header = (nm, type, size) => {
      const h = Buffer.alloc(512);
      h.write(nm, 0, 99, 'utf8');  // length-limited: multi-byte names must not spill into the mode field
      h.write(octal(it.dir ? 0o755 : 0o644, 8), 100);
      h.write(octal(0, 8), 108);
      h.write(octal(0, 8), 116);
      h.write(octal(size, 12), 124);
      h.write(octal(Math.floor((it.mtime ?? new Date()).getTime() / 1000), 12), 136);
      h.write('        ', 148);
      h.write(type, 156);
      h.write('ustar\0', 257);
      h.write('00', 263);
      let sum = 0;
      for (const b of h) sum += b;
      h.write(octal(sum, 7) + ' ', 148);
      return h;
    };
    if (Buffer.byteLength(name) > 99) {
      // PAX extended header carries the long name
      const rec = (k, v) => {
        const body = ` ${k}=${v}\n`;
        let len = body.length + 1;
        while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
        return `${len}${body}`;
      };
      const paxData = Buffer.from(rec('path', name), 'utf8');
      blocks.push(header('PaxHeader', 'x', paxData.length), paxData, Buffer.alloc((512 - (paxData.length % 512)) % 512));
    }
    blocks.push(header(name, it.dir ? '5' : '0', it.dir ? 0 : data.length));
    if (!it.dir) blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

async function collectInputs(paths, base) {
  const items = [];
  let total = 0;
  for (const p of paths) {
    const full = resolve(base, p);
    const st = await statOrNull(full);
    if (!st) throw new ToolError(`Not found: ${full}`);
    if (st.isFile()) {
      items.push({ name: basename(full), data: await readFile(full), mtime: st.mtime });
      total += st.size;
      continue;
    }
    const root = basename(full);
    items.push({ name: root + '/', dir: true, mtime: st.mtime });
    for await (const f of walk(full, { skipVendor: true })) {
      const name = `${root}/${f.rel.split(sep).join('/')}`;
      if (f.dir) items.push({ name: name + '/', dir: true });
      else {
        total += f.size;
        if (total > 2 * 1024 ** 3) throw new ToolError('Inputs exceed 2 GiB');
        items.push({ name, data: await readFile(f.full), mtime: new Date(f.mtimeMs) });
      }
    }
  }
  return items;
}

export async function archive(args = {}, ctx = {}) {
  const op = args.op ?? 'list';
  const maxBytes = (args.max_mb ?? 2048) * 1024 * 1024;

  if (op === 'create') {
    if (!Array.isArray(args.inputs) || !args.inputs.length) throw new ToolError('create needs inputs (files or folders)');
    if (typeof args.path !== 'string') throw new ToolError('create needs path for the new archive');
    const out = resolve(args.path);
    if ((await statOrNull(out)) && !args.overwrite) throw new ToolError(`${out} exists; pass overwrite: true to replace it`);
    const kind = kindOf(out, args.format);
    const items = await collectInputs(args.inputs, args.cwd ? resolve(args.cwd) : process.cwd());
    const files = items.filter((i) => !i.dir);
    let buf;
    if (kind === 'zip') buf = buildZip(items);
    else if (kind === 'tar') buf = buildTar(items);
    else if (kind === 'tgz') buf = zlib.gzipSync(buildTar(items));
    else {
      if (files.length !== 1 || items.length !== 1) throw new ToolError('gz holds exactly one file; use tgz for several');
      buf = zlib.gzipSync(files[0].data);
    }
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, buf);
    const raw = files.reduce((s, f) => s + f.data.length, 0);
    return `created ${out}: ${files.length} file(s), ${fmtBytes(raw)} → ${fmtBytes(buf.length)} (${raw ? Math.round((buf.length / raw) * 100) : 100}%)  [vendor folders like node_modules and .git were skipped]`;
  }

  const { full, st } = await dirArg(args.path);
  if (!st.isFile()) throw new ToolError('path must be an archive file');
  const kind = kindOf(full, args.format);

  // load entries: [{ name, dir, size, mtime, get(): Buffer }]
  let entries, fh;
  try {
    if (kind === 'zip') {
      fh = await open(full, 'r');
      const zipEntries = await readZipEntries(fh, st.size);
      entries = zipEntries.map((e) => ({ ...e, get: () => (e.encrypted ? Promise.reject(new ToolError(`${e.name} is encrypted (password-protected zip)`)) : zipEntryData(fh, e, maxBytes)) }));
    } else {
      let raw = await readFile(full);
      if (kind !== 'tar') {
        try {
          raw = zlib.gunzipSync(raw, { maxOutputLength: maxBytes });
        } catch (err) {
          throw new ToolError(err.code === 'ERR_BUFFER_TOO_LARGE' ? `Decompressed size exceeds ${fmtBytes(maxBytes)} (raise max_mb)` : `Not valid gzip: ${err.message}`);
        }
      }
      if (kind === 'gz') {
        const name = basename(full).replace(/\.gz$/i, '') || 'data';
        entries = [{ name, dir: false, size: raw.length, mtime: st.mtime, get: async () => raw }];
      } else {
        entries = parseTar(raw).map((e) => ({ ...e, get: async () => e.data }));
      }
    }

    const files = entries.filter((e) => !e.dir && !e.link);
    const total = files.reduce((s, e) => s + e.size, 0);
    if (op === 'list') {
      const unsafe = entries.filter((e) => !safeTarget(resolve('/x'), e.name));
      const lines = [`${full} (${kind}): ${files.length} file(s), ${entries.length - files.length} folder/link entr(ies), ${fmtBytes(total)} unpacked`];
      for (const e of entries.slice(0, 500)) lines.push(`  ${e.dir ? '      dir' : e.link ? '     link' : fmtBytes(e.size).padStart(9)}  ${e.mtime?.toISOString?.().slice(0, 16).replace('T', ' ') ?? ''}  ${e.name}${e.encrypted ? '  (encrypted)' : ''}`);
      if (entries.length > 500) lines.push(`  … ${entries.length - 500} more`);
      if (unsafe.length) lines.push(`⚠ ${unsafe.length} entr(ies) with unsafe paths (absolute or ..): would be skipped on extract`);
      if (st.size && total / st.size > 200) lines.push(`⚠ compression ratio ${Math.round(total / st.size)}:1 is suspicious (zip bomb?)`);
      return lines.join('\n');
    }
    if (op !== 'extract') throw new ToolError('op must be list, extract or create');

    if (total > maxBytes) throw new ToolError(`Archive would unpack to ${fmtBytes(total)}, over the ${fmtBytes(maxBytes)} limit (raise max_mb)`);
    const dest = resolve(args.out_dir ?? join(dirname(full), basename(full).replace(/\.(zip|tar\.gz|tgz|tar|gz)$/i, '')));
    const existing = await statOrNull(dest);
    if (existing && (!existing.isDirectory() || ((await readdir(dest)).length && !args.overwrite))) {
      throw new ToolError(`${dest} exists and is not empty; pass overwrite: true or another out_dir`);
    }
    const only = args.files ? new Set(args.files) : null;
    let written = 0, skipped = [], bytes = 0;
    for (const e of entries) {
      if (only && !only.has(e.name)) continue;
      const target = safeTarget(dest, e.name);
      if (!target || e.link) {
        skipped.push(`${e.name}${e.link ? ' (link)' : ' (unsafe path)'}`);
        continue;
      }
      if (e.dir) {
        await mkdir(target, { recursive: true });
        continue;
      }
      const data = await e.get();
      bytes += data.length;
      if (bytes > maxBytes) throw new ToolError(`Stopped: unpacked data exceeds ${fmtBytes(maxBytes)}`);
      await mkdir(dirname(target), { recursive: true });
      if (!args.overwrite && (await statOrNull(target))) {
        skipped.push(`${e.name} (exists)`);
        continue;
      }
      await writeFile(target, data);
      if (e.mtime && !Number.isNaN(e.mtime.getTime())) await utimes(target, e.mtime, e.mtime).catch(() => {});
      written++;
      if (written % 200 === 0) ctx.progress?.(written, files.length);
    }
    return [`extracted ${written} file(s), ${fmtBytes(bytes)} to ${dest}`, ...(skipped.length ? [`skipped ${skipped.length}:`, ...skipped.slice(0, 30).map((s) => `  ${s}`)] : [])].join('\n');
  } finally {
    await fh?.close();
  }
}
