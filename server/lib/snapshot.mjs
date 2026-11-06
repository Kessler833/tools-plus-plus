// Folder snapshots with content-addressed, deduplicated storage:
// create, list, diff against the current state, restore (with an automatic
// safety snapshot first) and delete (with blob garbage collection).

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, readFile, rm, rmdir, unlink, utimes, writeFile, rename } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ToolError, dataDir, statOrNull, fmtBytes } from './util.mjs';

const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.DS_Store', 'Thumbs.db'];
const store = () => dataDir('snapshots');
const blobPath = (h) => join(store(), 'blobs', h.slice(0, 2), h);
const manifestPath = (id) => join(store(), 'manifests', `${id}.json`);
const sameRoot = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function hashFile(path) {
  return new Promise((done, fail) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('error', fail).on('end', () => done(h.digest('hex')));
  });
}

// glob-ish exclude: "dist", "*.log", "build/out", "**/tmp"
function excluder(patterns) {
  const res = patterns.map((p) => {
    const body = p.replace(/\\/g, '/').replace(/^\.\/|\/$/g, '').split('**/').map((part) => part.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('(?:.*/)?');
    return body.includes('/') ? new RegExp(`^${body}(?:/|$)`) : new RegExp(`(?:^|/)${body}(?:/|$)`);
  });
  return (rel) => res.some((re) => re.test(rel));
}

async function scanTree(root, isExcluded, limits) {
  const files = [], dirs = [];
  let bytes = 0, skippedLinks = 0;
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join('/');
      if (isExcluded(rel)) continue;
      if (e.isSymbolicLink()) {
        skippedLinks++;
      } else if (e.isDirectory()) {
        dirs.push(rel);
        await walk(full);
      } else if (e.isFile()) {
        const st = await statOrNull(full);
        if (!st) continue;
        bytes += st.size;
        files.push({ rel, full, size: st.size, mtimeMs: st.mtimeMs });
        if (files.length > limits.files) throw new ToolError(`More than ${limits.files} files. Add exclude patterns (e.g. "dist", "*.log") or raise max_files.`);
        if (bytes > limits.bytes) throw new ToolError(`More than ${fmtBytes(limits.bytes)}. Add exclude patterns or raise max_mb.`);
      }
    }
  }
  await walk(root);
  return { files, dirs, bytes, skippedLinks };
}

async function loadManifest(id) {
  if (!/^[\w-]+$/.test(String(id ?? ''))) throw new ToolError('id is required (see op "list")');
  try {
    return JSON.parse(await readFile(manifestPath(id), 'utf8'));
  } catch {
    throw new ToolError(`No snapshot "${id}". Use op "list" to see snapshots.`);
  }
}

async function allManifests() {
  const dir = join(store(), 'manifests');
  const names = await readdir(dir).catch(() => []);
  const list = [];
  for (const n of names.filter((n) => n.endsWith('.json'))) {
    try {
      list.push(JSON.parse(await readFile(join(dir, n), 'utf8')));
    } catch {
      // ignore broken manifest
    }
  }
  return list.sort((a, b) => a.created.localeCompare(b.created));
}

async function create(root, { label, exclude = [], maxFiles = 50_000, maxMb = 2048 }, ctx) {
  const st = await statOrNull(root);
  if (!st?.isDirectory()) throw new ToolError(`Not a directory: ${root}`);
  const storeRel = relative(root, store());
  if (!storeRel) throw new ToolError('Cannot snapshot the snapshot store itself');
  const excludes = [...DEFAULT_EXCLUDES, ...exclude];
  // never copy the store into itself when snapshotting a parent folder (e.g. home)
  if (!storeRel.startsWith('..') && !/^[A-Za-z]:/.test(storeRel)) excludes.push(storeRel.split(sep).join('/'));
  const isExcluded = excluder(excludes);
  const tree = await scanTree(root, isExcluded, { files: maxFiles, bytes: maxMb * 1024 * 1024 });

  let newBytes = 0, i = 0;
  const files = [];
  for (const f of tree.files) {
    if (ctx.signal?.aborted) throw new ToolError('Cancelled');
    const hash = await hashFile(f.full);
    const blob = blobPath(hash);
    if (!(await statOrNull(blob))) {
      await mkdir(dirname(blob), { recursive: true });
      const tmp = `${blob}.${randomBytes(4).toString('hex')}.tmp`;
      await copyFile(f.full, tmp);
      await rename(tmp, blob);
      newBytes += f.size;
    }
    files.push({ rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, hash });
    if (++i % 200 === 0) ctx.progress?.(i, tree.files.length);
  }

  const now = new Date();
  const id = `${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
  const manifest = { id, root, label: label ?? null, created: now.toISOString(), excludes, files, dirs: tree.dirs, bytes: tree.bytes };
  await mkdir(dirname(manifestPath(id)), { recursive: true });
  await writeFile(manifestPath(id), JSON.stringify(manifest));
  return { manifest, newBytes, skippedLinks: tree.skippedLinks };
}

async function compare(manifest, root) {
  const tree = await scanTree(root, excluder(manifest.excludes), { files: 1e6, bytes: Infinity });
  const current = new Map(tree.files.map((f) => [f.rel, f]));
  const saved = new Map(manifest.files.map((f) => [f.rel, f]));
  const added = [], removed = [], modified = [];
  for (const [rel, f] of saved) {
    const c = current.get(rel);
    if (!c) removed.push(rel);
    else if (c.size !== f.size || (c.mtimeMs !== f.mtimeMs && (await hashFile(c.full)) !== f.hash)) modified.push(rel);
  }
  for (const rel of current.keys()) if (!saved.has(rel)) added.push(rel);
  return { added, removed, modified, current, tree };
}

const listing = (title, items, max = 100) => (items.length ? [`${title} (${items.length}):`, ...items.slice(0, max).map((i) => `  ${i}`), ...(items.length > max ? [`  … ${items.length - max} more`] : [])] : []);

async function restore(manifest, target, dryRun, ctx) {
  const inPlace = sameRoot(target, manifest.root);
  const lines = [];
  if (!inPlace) {
    const existing = await statOrNull(target);
    if (existing && (!existing.isDirectory() || (await readdir(target)).length)) throw new ToolError(`target ${target} exists and is not empty; restore elsewhere into a new or empty folder`);
    if (dryRun) return `would write ${manifest.files.length} files (${fmtBytes(manifest.bytes)}) into ${target}`;
    for (const d of manifest.dirs) await mkdir(join(target, d), { recursive: true });
    for (const f of manifest.files) await writeBack(f, join(target, f.rel));
    return `restored ${manifest.files.length} files into ${target}`;
  }

  if (!(await statOrNull(target))) await mkdir(target, { recursive: true });
  const diff = await compare(manifest, target);
  const changes = diff.added.length + diff.removed.length + diff.modified.length;
  if (!changes) return `Nothing to restore: ${target} already matches snapshot ${manifest.id}.`;
  if (dryRun) {
    return [`dry run, restoring ${manifest.id} would:`, ...listing('overwrite', diff.modified), ...listing('recreate', diff.removed), ...listing('DELETE (not in snapshot)', diff.added)].join('\n');
  }
  const safety = await create(target, { label: `auto: before restoring ${manifest.id}`, exclude: manifest.excludes.filter((e) => !DEFAULT_EXCLUDES.includes(e)) }, ctx);
  lines.push(`safety snapshot of the current state: ${safety.manifest.id} (restore it to undo)`);
  const saved = new Map(manifest.files.map((f) => [f.rel, f]));
  for (const rel of [...diff.modified, ...diff.removed]) await writeBack(saved.get(rel), join(target, rel));
  for (const rel of diff.added) await unlink(join(target, rel)).catch(() => {});
  // remove directories that did not exist in the snapshot, deepest first, if now empty
  const keep = new Set(manifest.dirs);
  for (const d of [...diff.tree.dirs].sort((a, b) => b.length - a.length)) {
    if (!keep.has(d)) await rmdir(join(target, d)).catch(() => {});
  }
  for (const d of manifest.dirs) await mkdir(join(target, d), { recursive: true });
  lines.push(`restored ${manifest.id}: ${diff.modified.length} overwritten, ${diff.removed.length} recreated, ${diff.added.length} deleted`);
  return lines.join('\n');
}

async function writeBack(f, dest) {
  const blob = blobPath(f.hash);
  if (!(await statOrNull(blob))) throw new ToolError(`Snapshot data missing for ${f.rel} (blob ${f.hash.slice(0, 12)}); the store may have been edited`);
  await mkdir(dirname(dest), { recursive: true });
  try {
    await copyFile(blob, dest);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
    await chmod(dest, 0o666);  // read-only file in the way (common on Windows)
    await copyFile(blob, dest);
  }
  const t = new Date(f.mtimeMs);
  await utimes(dest, t, t).catch(() => {});
}

async function gc() {
  const used = new Set((await allManifests()).flatMap((m) => m.files.map((f) => f.hash)));
  let freed = 0, count = 0;
  const root = join(store(), 'blobs');
  for (const sub of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, sub)).catch(() => [])) {
      if (used.has(name)) continue;
      const p = join(root, sub, name);
      const st = await statOrNull(p);
      await rm(p, { force: true });
      freed += st?.size ?? 0;
      count++;
    }
  }
  return { freed, count };
}

export async function snapshot(args = {}, ctx = {}) {
  const op = args.op;
  const root = args.path ? resolve(args.path) : null;
  switch (op) {
    case 'create': {
      if (!root) throw new ToolError('create needs path');
      const { manifest, newBytes, skippedLinks } = await create(root, { label: args.label, exclude: args.exclude ?? [], maxFiles: args.max_files, maxMb: args.max_mb }, ctx);
      return [
        `snapshot ${manifest.id} of ${root}`,
        `${manifest.files.length} files, ${manifest.dirs.length} folders, ${fmtBytes(manifest.bytes)} (${fmtBytes(newBytes)} newly stored, rest deduplicated)`,
        `excluded: ${manifest.excludes.join(', ')}`,
        skippedLinks ? `skipped ${skippedLinks} symbolic link(s)` : null,
        `store: ${store()}`,
      ].filter(Boolean).join('\n');
    }
    case 'list': {
      const all = (await allManifests()).filter((m) => !root || sameRoot(m.root, root));
      if (!all.length) return root ? `No snapshots for ${root}.` : 'No snapshots yet.';
      return all.map((m) => `${m.id}  ${m.created.slice(0, 19).replace('T', ' ')} UTC  ${m.files.length} files ${fmtBytes(m.bytes)}  ${m.root}${m.label ? `  "${m.label}"` : ''}`).join('\n');
    }
    case 'diff': {
      const m = await loadManifest(args.id);
      const target = root ?? m.root;
      if (!(await statOrNull(target))) return `${target} does not exist anymore; all ${m.files.length} files would be recreated by restore.`;
      const d = await compare(m, target);
      if (!d.added.length && !d.removed.length && !d.modified.length) return `No changes since snapshot ${m.id}.`;
      return [`changes in ${target} since ${m.id}:`, ...listing('modified', d.modified), ...listing('added', d.added), ...listing('removed', d.removed)].join('\n');
    }
    case 'restore': {
      const m = await loadManifest(args.id);
      return restore(m, root ?? m.root, args.dry_run === true, ctx);
    }
    case 'delete': {
      const m = await loadManifest(args.id);
      await rm(manifestPath(m.id));
      const { freed, count } = await gc();
      return `deleted snapshot ${m.id}; freed ${fmtBytes(freed)} (${count} unreferenced blobs)`;
    }
    default:
      throw new ToolError('op must be create, list, diff, restore or delete');
  }
}
