// Read-only SQLite access (node:sqlite, Node 22.5+) and JSON Schema
// validation/inference.

import { resolve } from 'node:path';
import { ToolError, statOrNull, readInput, clip, intArg } from './util.mjs';

// ---- sqlite -------------------------------------------------------------------

let sqliteModule;
async function openDb(path) {
  if (sqliteModule === undefined) {
    try {
      const silence = process.emitWarning;
      process.emitWarning = () => {};  // node:sqlite prints an ExperimentalWarning on older Node versions
      try {
        sqliteModule = await import('node:sqlite');
      } finally {
        process.emitWarning = silence;
      }
    } catch {
      sqliteModule = null;
    }
  }
  if (!sqliteModule) throw new ToolError(`sqlite needs Node.js 22.5 or newer; this server runs ${process.version}`);
  const full = resolve(path);
  const st = await statOrNull(full);
  if (!st?.isFile()) throw new ToolError(`Database not found: ${full}`);
  try {
    return { db: new sqliteModule.DatabaseSync(full, { readOnly: true }), full };
  } catch (err) {
    throw new ToolError(`Cannot open ${full}: ${err.message}`);
  }
}

function render(rows, maxWidth = 60) {
  if (!rows.length) return '(no rows)';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (v instanceof Uint8Array) return `<blob ${v.length} B>`;
    return clip(String(v).replace(/\r?\n/g, '⏎'), maxWidth);
  };
  const data = rows.map((r) => cols.map((c) => cell(r[c])));
  const w = cols.map((c, i) => Math.max(c.length, ...data.map((d) => d[i].length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(w[i])).join(' │ ');
  return [line(cols), w.map((x) => '─'.repeat(x)).join('─┼─'), ...data.map(line)].join('\n');
}

const READ_ONLY = /^\s*(select|with|pragma|explain|values)\b/i;

export async function sqlite(args = {}) {
  const { db, full } = await openDb(args.path ?? '');
  try {
    const op = args.op ?? (args.sql ? 'query' : 'tables');
    if (op === 'tables') {
      const objs = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
      const lines = [`${full}`];
      for (const o of objs.filter((x) => x.type === 'table' || x.type === 'view')) {
        let count = '?';
        try {
          count = db.prepare(`SELECT count(*) AS n FROM "${o.name.replace(/"/g, '""')}"`).get().n;
        } catch {
          // virtual table or broken view
        }
        const cols = db.prepare(`PRAGMA table_info("${o.name.replace(/"/g, '""')}")`).all();
        lines.push(`${o.type} ${o.name} (${count} rows): ${cols.map((c) => `${c.name}${c.type ? ` ${c.type}` : ''}${c.pk ? ' PK' : ''}`).join(', ')}`);
      }
      const idx = objs.filter((x) => x.type === 'index' && x.sql);
      if (idx.length) lines.push(`indexes: ${idx.map((i) => i.name).join(', ')}`);
      return lines.join('\n');
    }
    if (op === 'schema') {
      const where = args.table ? 'AND name = ?' : '';
      const rows = db.prepare(`SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ${where} ORDER BY type DESC, name`).all(...(args.table ? [args.table] : []));
      if (!rows.length) throw new ToolError(args.table ? `No table "${args.table}"` : 'Empty database');
      return rows.map((r) => `${r.sql};`).join('\n\n');
    }
    if (op !== 'query') throw new ToolError('op must be tables, schema or query');
    const sql = String(args.sql ?? '').trim().replace(/;\s*$/, '');
    if (!sql) throw new ToolError('query needs sql');
    if (!READ_ONLY.test(sql)) throw new ToolError('Only read-only statements (SELECT, WITH, PRAGMA, EXPLAIN) are allowed');
    if (/;\s*\S/.test(sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, ''))) throw new ToolError('One statement at a time');
    const limit = intArg(args.limit, 'limit', { min: 1, max: 5000, def: 100 });
    let stmt;
    try {
      stmt = db.prepare(sql);
    } catch (err) {
      throw new ToolError(`SQL error: ${err.message}`);
    }
    const rows = [];
    let total = 0;
    try {
      for (const r of stmt.iterate(...(args.params ?? []))) {
        if (total++ < limit) rows.push(r);
        if (total > 1_000_000) break;
      }
    } catch (err) {
      throw new ToolError(`SQL error: ${err.message}`);
    }
    return `${total}${total > 1_000_000 ? '+' : ''} row(s)${total > limit ? `, showing ${limit}` : ''}\n${render(rows)}`;
  } finally {
    db.close();
  }
}

// ---- JSON Schema --------------------------------------------------------------

const FORMATS = {
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s),
  time: (s) => /^\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/.test(s),
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uri: (s) => /^[a-z][a-z0-9+.-]*:\S+$/i.test(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  ipv4: (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s),
  hostname: (s) => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(s),
};

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeMatches = (v, t) => t === typeOf(v) || (t === 'number' && typeof v === 'number');
const ptr = (path) => (path.length ? '/' + path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : '(root)');
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function resolveRef(root, ref) {
  if (!ref.startsWith('#')) throw new ToolError(`Only local $ref supported, got ${ref}`);
  let node = root;
  for (const part of ref.slice(1).split('/').filter(Boolean)) {
    node = node?.[decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (node === undefined) throw new ToolError(`$ref ${ref} not found`);
  return node;
}

function validate(value, schema, root, path, errors, depth = 0) {
  if (depth > 200) throw new ToolError('Schema recursion too deep');
  if (schema === true) return;
  if (schema === false) return errors.push(`${ptr(path)}: no value allowed here`);
  if (schema.$ref) validate(value, resolveRef(root, schema.$ref), root, path, errors, depth + 1);
  const err = (msg) => errors.push(`${ptr(path)}: ${msg}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => typeMatches(value, t))) return err(`expected ${types.join(' or ')}, got ${typeOf(value)}`);
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) err(`must be one of ${clip(JSON.stringify(schema.enum), 200)}`);
  if ('const' in schema && !deepEqual(schema.const, value)) err(`must equal ${JSON.stringify(schema.const)}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) err(`${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) err(`${value} > maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) err(`${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) err(`${value} >= exclusiveMaximum ${schema.exclusiveMaximum}`);
    if (schema.multipleOf && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) err(`not a multiple of ${schema.multipleOf}`);
  }
  if (typeof value === 'string') {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) err(`shorter than ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && len > schema.maxLength) err(`longer than ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) err(`does not match pattern ${schema.pattern}`);
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format](value)) err(`not a valid ${schema.format}: ${clip(JSON.stringify(value), 80)}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) err(`fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) err(`more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) err('items are not unique');
    const prefix = schema.prefixItems ?? [];
    value.forEach((v, i) => {
      const s = i < prefix.length ? prefix[i] : schema.items;
      if (s !== undefined) validate(v, s, root, [...path, i], errors, depth + 1);
    });
    if (schema.contains && !value.some((v) => { const e = []; validate(v, schema.contains, root, path, e, depth + 1); return !e.length; })) err('no item matches "contains"');
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) err(`missing required property "${k}"`);
    const props = schema.properties ?? {};
    const patterns = Object.entries(schema.patternProperties ?? {}).map(([p, s]) => [new RegExp(p, 'u'), s]);
    for (const [k, v] of Object.entries(value)) {
      let known = false;
      if (k in props) {
        known = true;
        validate(v, props[k], root, [...path, k], errors, depth + 1);
      }
      for (const [re, s] of patterns) {
        if (re.test(k)) {
          known = true;
          validate(v, s, root, [...path, k], errors, depth + 1);
        }
      }
      if (!known && schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) errors.push(`${ptr([...path, k])}: property not allowed`);
        else validate(v, schema.additionalProperties, root, [...path, k], errors, depth + 1);
      }
    }
    const n = Object.keys(value).length;
    if (schema.minProperties !== undefined && n < schema.minProperties) err(`fewer than ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && n > schema.maxProperties) err(`more than ${schema.maxProperties} properties`);
  }
  const sub = (s) => {
    const e = [];
    validate(value, s, root, path, e, depth + 1);
    return e;
  };
  if (schema.allOf) for (const s of schema.allOf) errors.push(...sub(s));
  if (schema.anyOf && !schema.anyOf.some((s) => !sub(s).length)) err(`matches none of anyOf (${schema.anyOf.length} options)`);
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => !sub(s).length).length;
    if (ok !== 1) err(`must match exactly one of oneOf, matches ${ok}`);
  }
  if (schema.not && !sub(schema.not).length) err('must not match "not" schema');
  if (schema.if) {
    const branch = sub(schema.if).length ? schema.else : schema.then;
    if (branch) errors.push(...sub(branch));
  }
}

function detectFormat(values) {
  for (const f of ['date-time', 'date', 'uuid', 'email', 'uri', 'ipv4']) if (values.length && values.every(FORMATS[f])) return f;
  return null;
}

function infer(samples, depth = 0) {
  if (depth > 40) return {};
  const types = new Set(samples.map(typeOf));
  if (types.has('integer') && types.has('number')) types.delete('integer');
  const schema = {};
  const typeList = [...types];
  schema.type = typeList.length === 1 ? typeList[0] : typeList;
  const of = (t) => samples.filter((s) => typeMatches(s, t));
  if (types.has('object')) {
    const objs = of('object');
    const keys = new Map();
    for (const o of objs) for (const k of Object.keys(o)) keys.set(k, (keys.get(k) ?? 0) + 1);
    schema.properties = Object.fromEntries([...keys.keys()].map((k) => [k, infer(objs.filter((o) => k in o).map((o) => o[k]), depth + 1)]));
    const required = [...keys].filter(([, n]) => n === objs.length).map(([k]) => k);
    if (required.length) schema.required = required;
  }
  if (types.has('array')) {
    const items = of('array').flat();
    if (items.length) schema.items = infer(items, depth + 1);
  }
  if (types.has('string')) {
    const strs = of('string');
    const fmt = detectFormat(strs);
    if (fmt) schema.format = fmt;
    const distinct = new Set(strs);
    if (!fmt && strs.length >= 5 && distinct.size <= 6 && distinct.size < strs.length / 2) schema.enum = [...distinct].sort();
  }
  return schema;
}

async function jsonArg(args, textKey, pathKey, what) {
  const { text } = await readInput(args, { text: textKey, path: pathKey });
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ToolError(`${what} is not valid JSON: ${err.message} (use the json tool for details)`);
  }
}

export async function schemaTool(args = {}) {
  const op = args.op ?? (args.schema !== undefined || args.schema_path !== undefined ? 'validate' : 'infer');
  const data = await jsonArg(args, 'data', 'data_path', 'data');
  if (op === 'infer') {
    const samples = args.samples_are_array && Array.isArray(data) ? data : [data];
    const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...infer(samples) };
    return `${JSON.stringify(schema, null, 2)}\n(inferred from ${samples.length} sample(s): properties present in every sample are required; review enums and formats before relying on it)`;
  }
  if (op !== 'validate') throw new ToolError('op must be validate or infer');
  const schema = await jsonArg(args, 'schema', 'schema_path', 'schema');
  const items = args.each && Array.isArray(data) ? data : [data];
  const lines = [];
  let bad = 0;
  items.forEach((item, i) => {
    const errors = [];
    validate(item, schema, schema, args.each ? [i] : [], errors);
    if (errors.length) {
      bad++;
      if (lines.length < 100) lines.push(...errors.slice(0, 50).map((e) => `  ✗ ${e}`));
    }
  });
  const unsupported = JSON.stringify(schema).match(/"(dependentSchemas|dependentRequired|unevaluatedProperties|unevaluatedItems|\$dynamicRef|propertyNames)"/g);
  const note = unsupported ? `\nnote: not checked: ${[...new Set(unsupported)].join(', ')}` : '';
  if (!bad) return `✓ valid${args.each ? ` (${items.length} items)` : ''}${note}`;
  return `✗ ${args.each ? `${bad} of ${items.length} items invalid` : 'invalid'}:\n${lines.join('\n')}${note}`;
}
