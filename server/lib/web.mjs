// Small read-only web lookups with free, keyless APIs: package registries,
// weather (Open-Meteo) and Wikipedia summaries.

import { ToolError, fetchJson, clip } from './util.mjs';

// ---- package_info -------------------------------------------------------------

const ago = (iso) => {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days < 1 ? ' (today)' : days < 60 ? ` (${days} days ago)` : days < 730 ? ` (${Math.round(days / 30)} months ago)` : ` (${(days / 365).toFixed(1)} years ago)`;
};

async function npm(name, signal) {
  const enc = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  let doc;
  try {
    doc = await fetchJson(`https://registry.npmjs.org/${enc}`, { signal, headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' } });
  } catch (err) {
    if (err.status === 404) throw new ToolError(`npm package "${name}" does not exist`);
    throw err;
  }
  const latest = doc['dist-tags']?.latest;
  const meta = await fetchJson(`https://registry.npmjs.org/${enc}/${latest}`, { signal }).catch(() => ({}));
  const versions = Object.keys(doc.versions ?? {});
  const deprecated = doc.versions?.[latest]?.deprecated ?? meta.deprecated;
  return [
    `npm: ${name}@${latest}`,
    meta.description ? `description: ${clip(meta.description, 300)}` : null,
    `dist-tags: ${Object.entries(doc['dist-tags'] ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `versions published: ${versions.length}`,
    doc.modified ? `last modified: ${doc.modified.slice(0, 10)}${ago(doc.modified)}` : null,
    meta.license ? `license: ${typeof meta.license === 'string' ? meta.license : meta.license.type}` : null,
    meta.engines ? `engines: ${Object.entries(meta.engines).map(([k, v]) => `${k} ${v}`).join(', ')}` : null,
    meta.dependencies ? `dependencies: ${Object.keys(meta.dependencies).length}` : 'dependencies: 0',
    meta.types || meta.typings ? 'types: bundled' : null,
    meta.repository?.url ? `repository: ${meta.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')}` : null,
    deprecated ? `DEPRECATED: ${deprecated}` : null,
    `install: npm install ${name}`,
  ];
}

async function pypi(name, signal) {
  let doc;
  try {
    doc = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { signal, timeoutMs: 15_000 });
  } catch (err) {
    if (err.status === 404) throw new ToolError(`PyPI package "${name}" does not exist`);
    throw err;
  }
  const info = doc.info;
  const uploaded = doc.urls?.[0]?.upload_time_iso_8601;
  const releases = Object.keys(doc.releases ?? {});
  const license = info.license_expression || (info.license && info.license.length < 60 ? info.license : null) ||
    info.classifiers?.find((c) => c.startsWith('License ::'))?.split('::').pop().trim();
  return [
    `PyPI: ${info.name} ${info.version}`,
    info.summary ? `summary: ${clip(info.summary, 300)}` : null,
    uploaded ? `released: ${uploaded.slice(0, 10)}${ago(uploaded)}` : null,
    `releases: ${releases.length}`,
    info.requires_python ? `requires python: ${info.requires_python}` : null,
    license ? `license: ${license}` : null,
    info.requires_dist ? `dependencies: ${info.requires_dist.filter((d) => !d.includes('extra ==')).length} (+ optional extras)` : 'dependencies: 0',
    info.project_urls?.Source || info.project_urls?.Homepage || info.home_page ? `project: ${info.project_urls?.Source || info.project_urls?.Homepage || info.home_page}` : null,
    info.yanked ? 'YANKED' : null,
    `install: pip install ${info.name}`,
  ];
}

async function crates(name, signal) {
  let doc;
  try {
    doc = await fetchJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, { signal });
  } catch (err) {
    if (err.status === 404) throw new ToolError(`crate "${name}" does not exist`);
    throw err;
  }
  const c = doc.crate;
  const v = doc.versions?.find((x) => x.num === c.max_stable_version) ?? doc.versions?.[0];
  return [
    `crates.io: ${c.name} ${c.max_stable_version ?? c.max_version}`,
    c.description ? `description: ${clip(c.description.trim(), 300)}` : null,
    v?.created_at ? `released: ${v.created_at.slice(0, 10)}${ago(v.created_at)}` : null,
    `downloads: ${c.downloads.toLocaleString('en-US')}`,
    v?.license ? `license: ${v.license}` : null,
    v?.rust_version ? `MSRV: ${v.rust_version}` : null,
    c.repository ? `repository: ${c.repository}` : null,
    `install: cargo add ${c.name}`,
  ];
}

async function github(repo, signal) {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repo.trim());
  if (!m) throw new ToolError('GitHub repo must look like owner/name');
  const base = `https://api.github.com/repos/${m[1]}/${m[2]}`;
  const headers = { accept: 'application/vnd.github+json' };
  let info;
  try {
    info = await fetchJson(base, { signal, headers });
  } catch (err) {
    if (err.status === 404) throw new ToolError(`GitHub repo ${m[1]}/${m[2]} not found (or private)`);
    if (err.status === 403) throw new ToolError('GitHub API rate limit reached (60 requests/hour without a token); try again later');
    throw err;
  }
  const release = await fetchJson(`${base}/releases/latest`, { signal, headers }).catch(() => null);
  const tags = release ? null : await fetchJson(`${base}/tags?per_page=3`, { signal, headers }).catch(() => null);
  return [
    `GitHub: ${info.full_name}${info.archived ? '  (ARCHIVED)' : ''}`,
    info.description ? `description: ${clip(info.description, 300)}` : null,
    release ? `latest release: ${release.tag_name}${release.name && release.name !== release.tag_name ? ` "${release.name}"` : ''} on ${release.published_at?.slice(0, 10)}${ago(release.published_at)}` : tags?.length ? `latest tags: ${tags.map((t) => t.name).join(', ')} (no GitHub releases)` : 'no releases or tags',
    `stars: ${info.stargazers_count.toLocaleString('en-US')}   open issues: ${info.open_issues_count}   default branch: ${info.default_branch}`,
    `last push: ${info.pushed_at?.slice(0, 10)}${ago(info.pushed_at)}`,
    info.license?.spdx_id ? `license: ${info.license.spdx_id}` : null,
    `url: ${info.html_url}`,
  ];
}

export async function packageInfo({ name, registry = 'npm' } = {}, ctx = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new ToolError('name is required');
  const fn = { npm, pypi, crates, github }[registry];
  if (!fn) throw new ToolError('registry must be npm, pypi, crates or github');
  return (await fn(name.trim(), ctx.signal)).filter(Boolean).join('\n');
}

// ---- weather ------------------------------------------------------------------

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle', 56: 'freezing drizzle', 57: 'dense freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};
const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

async function geocode(place, signal) {
  const coords = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(place);
  if (coords) return { name: `${coords[1]}, ${coords[2]}`, latitude: Number(coords[1]), longitude: Number(coords[2]) };
  // "Springfield, US" -> filter by country; Open-Meteo searches the name only
  const [city, country] = place.split(',').map((s) => s.trim());
  const res = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&language=en&format=json`, { signal });
  let hits = res.results ?? [];
  if (country) {
    const c = country.toLowerCase();
    hits = hits.filter((h) => h.country_code?.toLowerCase() === c || h.country?.toLowerCase() === c || h.admin1?.toLowerCase() === c);
  }
  if (!hits.length) throw new ToolError(`Place "${place}" not found. Try "City, Country" or "lat,lon".`);
  const h = hits[0];
  return { name: [h.name, h.admin1, h.country].filter(Boolean).join(', '), latitude: h.latitude, longitude: h.longitude };
}

export async function weather({ place, days = 3, units = 'metric' } = {}, ctx = {}) {
  if (typeof place !== 'string' || !place.trim()) throw new ToolError('place is required');
  if (!Number.isInteger(days) || days < 1 || days > 16) throw new ToolError('days must be 1-16');
  const loc = await geocode(place, ctx.signal);
  const imperial = units === 'imperial';
  const q = new URLSearchParams({
    latitude: loc.latitude, longitude: loc.longitude, timezone: 'auto', forecast_days: days,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset,uv_index_max',
    ...(imperial ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' } : {}),
  });
  const w = await fetchJson(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: ctx.signal });
  const t = imperial ? '°F' : '°C', v = imperial ? 'mph' : 'km/h', p = imperial ? 'in' : 'mm';
  const c = w.current, d = w.daily;
  const lines = [
    `${loc.name} (${loc.latitude.toFixed(2)}, ${loc.longitude.toFixed(2)}), local time ${c.time.replace('T', ' ')} ${w.timezone_abbreviation ?? ''}`,
    `now: ${WMO[c.weather_code] ?? `code ${c.weather_code}`}, ${c.temperature_2m}${t} (feels ${c.apparent_temperature}${t}), humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} ${v} ${compass(c.wind_direction_10m)} (gusts ${c.wind_gusts_10m}), precipitation ${c.precipitation} ${p}`,
    '',
  ];
  d.time.forEach((day, i) => {
    const weekday = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    lines.push(`${weekday} ${day}: ${WMO[d.weather_code[i]] ?? `code ${d.weather_code[i]}`}, ${d.temperature_2m_min[i]}…${d.temperature_2m_max[i]}${t}, rain ${d.precipitation_sum[i]} ${p} (${d.precipitation_probability_max[i] ?? '?'}%), wind up to ${d.wind_speed_10m_max[i]} ${v}, UV ${d.uv_index_max[i] ?? '?'}, sun ${d.sunrise[i].slice(11)}–${d.sunset[i].slice(11)}`);
  });
  lines.push('', 'source: Open-Meteo (open-meteo.com)');
  return lines.join('\n');
}

// ---- wikipedia ----------------------------------------------------------------

export async function wikipedia({ query, lang = 'en', full = false } = {}, ctx = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new ToolError('query is required');
  if (!/^[a-z]{2,3}(?:-[a-z]+)?$/.test(lang)) throw new ToolError('lang must be a Wikipedia language code like en, de, fr');
  const host = `https://${lang}.wikipedia.org`;
  const search = await fetchJson(`${host}/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=5`, { signal: ctx.signal });
  const pages = search.pages ?? [];
  if (!pages.length) return `No ${lang}.wikipedia.org article found for "${query}".`;
  const top = pages[0];
  const summary = await fetchJson(`${host}/api/rest_v1/page/summary/${encodeURIComponent(top.key)}`, { signal: ctx.signal });
  const lines = [`${summary.title}${summary.description ? ` — ${summary.description}` : ''}`];
  if (summary.type === 'disambiguation') lines.push('(disambiguation page; see other results below)');
  let text = summary.extract ?? '';
  if (full) {
    const plain = await fetchJson(`${host}/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&format=json&formatversion=2&titles=${encodeURIComponent(top.key)}`, { signal: ctx.signal }).catch(() => null);
    text = plain?.query?.pages?.[0]?.extract ?? text;
  }
  lines.push('', clip(text, full ? 20_000 : 3000), '', `url: ${summary.content_urls?.desktop?.page ?? `${host}/wiki/${encodeURIComponent(top.key)}`}`);
  if (summary.timestamp) lines.push(`last edited: ${summary.timestamp.slice(0, 10)}`);
  if (pages.length > 1) lines.push(`other results: ${pages.slice(1).map((p) => p.title).join(' | ')}`);
  lines.push('source: Wikipedia (CC BY-SA 4.0)');
  return lines.join('\n');
}
