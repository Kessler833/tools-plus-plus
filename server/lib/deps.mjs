// Dependency check for a whole manifest at once: package.json,
// requirements.txt, pyproject.toml or Cargo.toml against the registries.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { ToolError, fetchJson, statOrNull } from './util.mjs';

// ---- versions -----------------------------------------------------------------

const parseVer = (v) => {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.]?((?:alpha|beta|rc|a|b|pre|dev)[.\d]*))?/i.exec(String(v ?? ''));
  return m ? { major: +m[1], minor: +(m[2] ?? 0), patch: +(m[3] ?? 0), pre: m[4] ?? null, text: m[0] } : null;
};
const cmpVer = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch || (a.pre ? (b.pre ? 0 : -1) : b.pre ? 1 : 0);

/** The version a range at least asks for: "^1.2.3" -> 1.2.3, ">=2,<3" -> 2.0.0. */
function floorOf(range) {
  if (!range || /^(\*|latest|x)$/i.test(range.trim())) return null;
  if (/^(file:|link:|git|github:|https?:|workspace:|npm:|portal:)/.test(range.trim())) return 'nonregistry';
  const parts = range.split(/\|\|/).map((p) => p.trim());
  const lowest = parts.map((p) => parseVer(p.replace(/^[\^~>=<! ]+/, ''))).filter(Boolean).sort(cmpVer)[0];
  return lowest ?? null;
}

function status(spec, installed, latest) {
  const base = installed ? parseVer(installed) : floorOf(spec);
  if (base === 'nonregistry') return { level: 'skip', text: 'not from the registry' };
  if (!latest) return { level: 'error', text: 'no latest version found' };
  const l = parseVer(latest);
  if (!base) return { level: 'ok', text: 'unpinned' };
  if (cmpVer(base, l) >= 0) return { level: 'ok', text: 'up to date' };
  if (base.major !== l.major) return { level: 'major', text: `major update ${base.major} → ${l.major}` };
  if (base.major === 0 && base.minor !== l.minor) return { level: 'major', text: '0.x minor update (may break)' };
  if (base.minor !== l.minor) return { level: 'minor', text: 'minor update' };
  return { level: 'patch', text: 'patch update' };
}

// ---- manifests ----------------------------------------------------------------

function parsePackageJson(text) {
  const pkg = JSON.parse(text);
  const deps = [];
  for (const [kind, field] of [['prod', 'dependencies'], ['dev', 'devDependencies'], ['optional', 'optionalDependencies'], ['peer', 'peerDependencies']]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) deps.push({ name, spec, kind });
  }
  return { registry: 'npm', deps };
}

function parseRequirements(text) {
  const deps = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*?)\s*(;.*)?$/.exec(line);
    if (m) deps.push({ name: m[1], spec: m[3] || '', kind: 'prod' });
  }
  return { registry: 'pypi', deps };
}

function parsePyproject(text) {
  const deps = [];
  const grab = (re, kind) => {
    const m = re.exec(text);
    if (!m) return;
    for (const s of m[1].matchAll(/["']([^"']+)["']/g)) {
      const d = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([^;]*)/.exec(s[1]);
      if (d) deps.push({ name: d[1], spec: d[3].trim(), kind });
    }
  };
  grab(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m, 'prod');
  grab(/^\s*dev\s*=\s*\[([\s\S]*?)\]/m, 'dev');
  // poetry style: [tool.poetry.dependencies] name = "^1.2"
  const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(text);
  if (poetry) {
    for (const m of poetry[1].matchAll(/^\s*([A-Za-z0-9._-]+)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)")/gm)) {
      if (m[1].toLowerCase() !== 'python') deps.push({ name: m[1], spec: m[2] ?? m[3] ?? '', kind: 'prod' });
    }
  }
  return { registry: 'pypi', deps };
}

function parseCargo(text) {
  const deps = [];
  for (const [kind, header] of [['prod', 'dependencies'], ['dev', 'dev-dependencies'], ['build', 'build-dependencies']]) {
    const sec = new RegExp(`\\[${header}\\]([\\s\\S]*?)(?:\\n\\[|$)`).exec(text);
    if (!sec) continue;
    for (const m of sec[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|\{([^}]*)\})/gm)) {
      const inline = m[3] ?? '';
      if (/\b(path|git)\s*=/.test(inline)) deps.push({ name: m[1], spec: 'git:', kind });
      else deps.push({ name: m[1], spec: m[2] ?? /version\s*=\s*"([^"]*)"/.exec(inline)?.[1] ?? '', kind });
    }
  }
  return { registry: 'crates', deps };
}

async function installedNpm(root, name) {
  try {
    return JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

// ---- registry lookups ---------------------------------------------------------

async function latestOf(registry, name, signal) {
  if (registry === 'npm') {
    const enc = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
    const doc = await fetchJson(`https://registry.npmjs.org/${enc}`, { signal, headers: { accept: 'application/vnd.npm.install-v1+json' } });
    const latest = doc['dist-tags']?.latest;
    return { latest, deprecated: doc.versions?.[latest]?.deprecated ?? null };
  }
  if (registry === 'pypi') {
    const doc = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { signal, timeoutMs: 15_000 });
    return { latest: doc.info.version, deprecated: doc.info.yanked ? 'yanked' : /deprecated/i.test(doc.info.summary ?? '') ? doc.info.summary : null };
  }
  const doc = await fetchJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, { signal });
  return { latest: doc.crate.max_stable_version ?? doc.crate.max_version, deprecated: null };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

export async function depsCheck(args = {}, ctx = {}) {
  let file = resolve(args.path ?? '.');
  const st = await statOrNull(file);
  if (st?.isDirectory()) {
    const found = [];
    for (const n of ['package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml']) if (await statOrNull(join(file, n))) found.push(join(file, n));
    if (!found.length) throw new ToolError(`No package.json, requirements.txt, pyproject.toml or Cargo.toml in ${file}`);
    file = found[0];
  } else if (!st) throw new ToolError(`Not found: ${file}`);
  const text = await readFile(file, 'utf8');
  const name = basename(file).toLowerCase();
  const { registry, deps } = name === 'package.json' ? parsePackageJson(text)
    : name.endsWith('.toml') && name.startsWith('cargo') ? parseCargo(text)
    : name.endsWith('.toml') ? parsePyproject(text)
    : parseRequirements(text);
  const selected = deps.filter((d) => args.include_dev !== false || d.kind !== 'dev');
  if (!selected.length) return `${file}: no dependencies found`;
  if (selected.length > 300) throw new ToolError(`${selected.length} dependencies; limit is 300 per check`);

  let done = 0;
  const rows = await mapLimit(selected, 8, async (d) => {
    const installed = registry === 'npm' ? await installedNpm(dirname(file), d.name) : null;
    let info;
    try {
      info = floorOf(d.spec) === 'nonregistry' ? { latest: null } : await latestOf(registry, d.name, ctx.signal);
    } catch (err) {
      info = { error: err.status === 404 ? 'not found in registry' : err.message };
    }
    ctx.progress?.(++done, selected.length, d.name);
    const s = info.error ? { level: 'error', text: info.error } : status(d.spec, installed, info.latest);
    return { ...d, installed, ...info, s };
  });

  const order = { major: 0, error: 1, minor: 2, patch: 3, ok: 4, skip: 5 };
  rows.sort((a, b) => order[a.s.level] - order[b.s.level] || (a.deprecated ? -1 : 0) - (b.deprecated ? -1 : 0) || a.name.localeCompare(b.name));
  const count = (l) => rows.filter((r) => r.s.level === l).length;
  const width = Math.min(40, Math.max(...rows.map((r) => r.name.length)));
  const lines = [
    `${file} (${registry}): ${rows.length} dependencies — ${count('major')} major, ${count('minor')} minor, ${count('patch')} patch behind, ${count('ok')} up to date${count('error') ? `, ${count('error')} errors` : ''}${count('skip') ? `, ${count('skip')} non-registry` : ''}`,
    registry === 'npm' ? '(compares the installed version from node_modules when present, else the lowest version the range allows)' : '(compares the lowest version the specifier allows)',
    '',
  ];
  for (const r of rows) {
    if (args.only_outdated && (r.s.level === 'ok' || r.s.level === 'skip')) continue;
    const mark = { major: '✗', minor: '↑', patch: '·', ok: '✓', error: '?', skip: '-' }[r.s.level];
    lines.push(`${mark} ${r.name.padEnd(width)}  ${(r.spec || '*').padEnd(14)} ${r.installed ? `installed ${r.installed.padEnd(10)} ` : ''}latest ${String(r.latest ?? '-').padEnd(10)} ${r.s.text}${r.kind !== 'prod' ? ` [${r.kind}]` : ''}${r.deprecated ? `  ⚠ DEPRECATED: ${String(r.deprecated).slice(0, 120)}` : ''}`);
  }
  return lines.join('\n');
}
