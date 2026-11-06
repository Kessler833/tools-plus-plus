// Tabular data without writing a script: load CSV/TSV/JSON/JSON Lines/Markdown
// tables, then filter, group, aggregate, sort and join, or convert formats.

import { writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ToolError, fmtNum, readInput, statOrNull } from './util.mjs';
import { parseCsv, parseNumber } from './stats.mjs';

// ---- loading ------------------------------------------------------------------

function fromObjects(list) {
  if (!list.every((r) => r && typeof r === 'object' && !Array.isArray(r))) throw new ToolError('JSON input must be an array of objects (or an object holding one)');
  const columns = [];
  for (const r of list) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  const rows = list.map((r) => columns.map((c) => (r[c] === undefined || r[c] === null ? '' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])));
  return { columns, rows, format: 'json' };
}

function parseMarkdown(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('|'));
  const cells = (l) => l.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const body = lines.filter((l) => !/^\|?\s*:?-{2,}/.test(l.replace(/^\|\s*/, '|').slice(1)) && !/^\|[\s:|-]+\|?$/.test(l));
  if (body.length < 1) throw new ToolError('No Markdown table found');
  const [head, ...rest] = body.map(cells);
  return { columns: head, rows: rest, format: 'markdown' };
}

/** Load a table from text or a file; format is detected unless given. */
export async function loadTable(args, { text = 'text', path = 'path', format } = {}) {
  const input = await readInput(args, { text, path });
  const src = input.text;
  let fmt = format ?? args.format;
  if (!fmt) {
    const ext = input.path ? extname(input.path).toLowerCase() : '';
    const t = src.trimStart();
    fmt = ext === '.jsonl' || ext === '.ndjson' ? 'jsonl'
      : ext === '.json' || t.startsWith('[') || (t.startsWith('{') && !/}\s*\n\s*{/.test(t)) ? 'json'
        : t.startsWith('{') ? 'jsonl'
          : ext === '.md' || t.startsWith('|') ? 'markdown'
            : ext === '.tsv' ? 'tsv' : 'csv';
  }
  let table;
  if (fmt === 'json') {
    let data;
    try {
      data = JSON.parse(src);
    } catch (err) {
      throw new ToolError(`Invalid JSON: ${err.message}`);
    }
    if (!Array.isArray(data)) {
      const inner = Object.values(data ?? {}).find(Array.isArray);
      if (!inner) throw new ToolError('JSON input must be an array of objects (or an object holding one)');
      data = inner;
    }
    table = fromObjects(data);
  } else if (fmt === 'jsonl') {
    const list = src.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (err) {
        throw new ToolError(`JSON Lines: line ${i + 1}: ${err.message}`);
      }
    });
    table = { ...fromObjects(list), format: 'jsonl' };
  } else if (fmt === 'markdown') {
    table = parseMarkdown(src);
  } else {
    const { rows, delimiter } = parseCsv(src, fmt === 'tsv' ? '\t' : args.delimiter);
    if (!rows.length) throw new ToolError('The table is empty');
    const header = args.no_header ? rows[0].map((_, i) => `col${i + 1}`) : rows[0].map((h, i) => h.trim() || `col${i + 1}`);
    table = { columns: header, rows: args.no_header ? rows : rows.slice(1), format: delimiter === '\t' ? 'tsv' : 'csv', delimiter };
  }
  const width = table.columns.length;
  table.rows = table.rows.map((r) => (r.length >= width ? r.slice(0, width) : [...r, ...new Array(width - r.length).fill('')]));
  table.decimalComma = table.delimiter === ';';
  table.source = input.path;
  return table;
}

const num = (v, dc) => (typeof v === 'number' ? v : parseNumber(v, dc));

function colIndex(t, name) {
  if (typeof name === 'number' || /^\d+$/.test(String(name))) {
    const i = Number(name) - 1;
    if (i >= 0 && i < t.columns.length) return i;
  }
  let i = t.columns.indexOf(String(name));
  if (i < 0) i = t.columns.findIndex((c) => c.toLowerCase() === String(name).toLowerCase());
  if (i < 0) throw new ToolError(`No column "${name}". Columns: ${t.columns.join(', ')}`);
  return i;
}

function columnKind(values, dc) {
  const filled = values.filter((v) => v !== '');
  if (!filled.length) return 'empty';
  if (filled.every((v) => !Number.isNaN(num(v, dc)))) return filled.every((v) => Number.isInteger(num(v, dc))) ? 'integer' : 'number';
  if (filled.every((v) => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(String(v)))) return 'date';
  if (filled.every((v) => /^(true|false|yes|no)$/i.test(String(v)))) return 'boolean';
  return 'text';
}

// ---- rendering ----------------------------------------------------------------

function cellText(v) {
  const s = typeof v === 'number' ? fmtNum(v, 12) : String(v);
  return s.replace(/\r?\n/g, ' ⏎ ');
}

function renderAligned(columns, rows, maxWidth = 40) {
  const clipCell = (s) => (s.length > maxWidth ? `${s.slice(0, maxWidth - 1)}…` : s);
  const head = columns.map((c) => clipCell(String(c)));
  const body = rows.map((r) => r.map((v) => clipCell(cellText(v))));
  const w = head.map((h, j) => Math.max(h.length, ...body.map((r) => r[j].length), 3));
  const line = (cells) => `| ${cells.map((c, j) => c.padEnd(w[j])).join(' | ')} |`;
  return [line(head), `|${w.map((x) => '-'.repeat(x + 2)).join('|')}|`, ...body.map(line)].join('\n');
}

function csvCell(v, delim) {
  const s = typeof v === 'number' ? fmtNum(v, 15) : String(v);
  return s.includes(delim) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function typed(v, dc) {
  if (typeof v !== 'string') return v;
  if (v === '') return null;
  const n = num(v, dc);
  if (!Number.isNaN(n) && /^-?[\d.,]+(e[+-]?\d+)?$/i.test(v.trim()) && !/^0\d/.test(v.trim())) return n;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return v;
}

function render(columns, rows, format, dc = false) {
  switch (format) {
    case 'csv':
    case 'tsv': {
      const d = format === 'tsv' ? '\t' : ',';
      return [columns, ...rows].map((r) => r.map((v) => csvCell(v, d)).join(d)).join('\n');
    }
    case 'json': return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, typed(r[i], dc)]))), null, 2);
    case 'jsonl': return rows.map((r) => JSON.stringify(Object.fromEntries(columns.map((c, i) => [c, typed(r[i], dc)])))).join('\n');
    case 'markdown': {
      const esc = (v) => cellText(v).replace(/\|/g, '\\|');
      return [`| ${columns.map(esc).join(' | ')} |`, `|${columns.map(() => ' --- ').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
    }
    case 'html': {
      const esc = (v) => cellText(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return ['<table>', `  <thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`, '  <tbody>',
        ...rows.map((r) => `    <tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`), '  </tbody>', '</table>'].join('\n');
    }
    default: return renderAligned(columns, rows);
  }
}

// ---- query --------------------------------------------------------------------

const COND = /^\s*(.+?)\s*(>=|<=|!=|!~|=~|==|=|>|<|~|\bcontains\b|\bstarts\b|\bends\b|\bis empty\b|\bnot empty\b)\s*(.*?)\s*$/i;

function makeFilter(t, expr) {
  const m = COND.exec(expr);
  if (!m) throw new ToolError(`Cannot read condition "${expr}". Use e.g. "age > 30", "city = Berlin", "name ~ ^A", "email contains @gmx", "note is empty"`);
  const [, col, rawOp, rawVal] = m;
  const i = colIndex(t, col.replace(/^["'`]|["'`]$/g, ''));
  const op = rawOp.toLowerCase();
  const val = rawVal.replace(/^["']|["']$/g, '');
  const dc = t.decimalComma;
  if (op === 'is empty') return (r) => String(r[i]).trim() === '';
  if (op === 'not empty') return (r) => String(r[i]).trim() !== '';
  if (op === '~' || op === '=~' || op === '!~') {
    let re;
    try {
      re = new RegExp(val, 'i');
    } catch (err) {
      throw new ToolError(`Bad regex in "${expr}": ${err.message}`);
    }
    return op === '!~' ? (r) => !re.test(String(r[i])) : (r) => re.test(String(r[i]));
  }
  const lv = val.toLowerCase();
  if (op === 'contains') return (r) => String(r[i]).toLowerCase().includes(lv);
  if (op === 'starts') return (r) => String(r[i]).toLowerCase().startsWith(lv);
  if (op === 'ends') return (r) => String(r[i]).toLowerCase().endsWith(lv);
  const target = num(val, dc);
  const numeric = !Number.isNaN(target);
  const cmp = (r) => {
    if (numeric) {
      const x = num(r[i], dc);
      if (!Number.isNaN(x)) return x - target;
    }
    return String(r[i]).localeCompare(val, undefined, { sensitivity: 'accent', numeric: true });
  };
  switch (op) {
    case '=': case '==': return (r) => cmp(r) === 0;
    case '!=': return (r) => cmp(r) !== 0;
    case '>': return (r) => String(r[i]) !== '' && cmp(r) > 0;
    case '>=': return (r) => String(r[i]) !== '' && cmp(r) >= 0;
    case '<': return (r) => String(r[i]) !== '' && cmp(r) < 0;
    case '<=': return (r) => String(r[i]) !== '' && cmp(r) <= 0;
  }
  throw new ToolError(`Unknown operator ${op}`);
}

const AGG = /^\s*(count|count_distinct|sum|avg|mean|min|max|median|first|last|list)\s*(?:\(\s*(.*?)\s*\))?\s*(?:as\s+(\w+))?\s*$/i;

function makeAggregate(t, expr) {
  const m = AGG.exec(expr);
  if (!m) throw new ToolError(`Cannot read aggregate "${expr}". Use count, count_distinct(col), sum(col), avg(col), min(col), max(col), median(col), first(col), last(col), list(col)`);
  const fn = m[1].toLowerCase();
  const i = m[2] ? colIndex(t, m[2]) : -1;
  if (i < 0 && fn !== 'count') throw new ToolError(`${fn} needs a column: ${fn}(column)`);
  const name = m[3] ?? (i < 0 ? 'count' : `${fn}(${t.columns[i]})`);
  const dc = t.decimalComma;
  const nums = (rows) => rows.map((r) => num(r[i], dc)).filter((x) => !Number.isNaN(x));
  const run = {
    count: (rows) => (i < 0 ? rows.length : rows.filter((r) => String(r[i]) !== '').length),
    count_distinct: (rows) => new Set(rows.map((r) => r[i])).size,
    sum: (rows) => nums(rows).reduce((a, b) => a + b, 0),
    avg: (rows) => {
      const xs = nums(rows);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : '';
    },
    min: (rows) => {
      const xs = nums(rows);
      return xs.length ? Math.min(...xs) : rows.map((r) => String(r[i])).filter(Boolean).sort()[0] ?? '';
    },
    max: (rows) => {
      const xs = nums(rows);
      return xs.length ? Math.max(...xs) : rows.map((r) => String(r[i])).filter(Boolean).sort().at(-1) ?? '';
    },
    median: (rows) => {
      const xs = nums(rows).sort((a, b) => a - b);
      if (!xs.length) return '';
      const h = Math.floor(xs.length / 2);
      return xs.length % 2 ? xs[h] : (xs[h - 1] + xs[h]) / 2;
    },
    first: (rows) => rows[0]?.[i] ?? '',
    last: (rows) => rows.at(-1)?.[i] ?? '',
    list: (rows) => [...new Set(rows.map((r) => r[i]))].join(', '),
  };
  run.mean = run.avg;
  return { name, fn: run[fn] };
}

function sorter(t, specs) {
  const keys = specs.map((s) => {
    const m = /^\s*(.+?)(?:\s+(asc|desc))?\s*$/i.exec(s);
    return { i: colIndex(t, m[1]), dir: m[2]?.toLowerCase() === 'desc' ? -1 : 1 };
  });
  const dc = t.decimalComma;
  return (a, b) => {
    for (const { i, dir } of keys) {
      const ea = String(a[i]) === '', eb = String(b[i]) === '';
      if (ea || eb) {
        if (ea !== eb) return ea ? 1 : -1;  // blanks last in both directions
        continue;
      }
      const x = num(a[i], dc), y = num(b[i], dc);
      const c = !Number.isNaN(x) && !Number.isNaN(y) ? x - y : String(a[i]).localeCompare(String(b[i]), undefined, { numeric: true });
      if (c) return c * dir;
    }
    return 0;
  };
}

function profile(t) {
  const out = [`${t.rows.length} rows × ${t.columns.length} columns (${t.format}${t.delimiter && t.format === 'csv' && t.delimiter !== ',' ? `, delimiter "${t.delimiter}"` : ''})`, ''];
  const rows = t.columns.map((c, j) => {
    const values = t.rows.map((r) => r[j]);
    const kind = columnKind(values, t.decimalComma);
    const filled = values.filter((v) => v !== '');
    const distinct = new Set(filled).size;
    let range = '';
    if (kind === 'integer' || kind === 'number') {
      const xs = filled.map((v) => num(v, t.decimalComma));
      range = `${fmtNum(Math.min(...xs))} … ${fmtNum(Math.max(...xs))}`;
    } else if (filled.length) {
      const freq = new Map();
      for (const v of filled) freq.set(v, (freq.get(v) ?? 0) + 1);
      range = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v, n]) => `${cellText(v).slice(0, 20)} (${n})`).join(', ');
    }
    return [c, kind, values.length - filled.length, distinct, range];
  });
  out.push(renderAligned(['column', 'type', 'empty', 'distinct', 'range / top values'], rows, 60));
  out.push('', 'First rows:', renderAligned(t.columns, t.rows.slice(0, 5)));
  return out.join('\n');
}

export async function table(args = {}) {
  const t = await loadTable(args);
  const hasQuery = ['where', 'select', 'group_by', 'aggregate', 'sort', 'join_path', 'distinct'].some((k) => args[k] !== undefined && args[k] !== null && !(Array.isArray(args[k]) && !args[k].length));
  if (!hasQuery && !args.output) return profile(t);

  let columns = [...t.columns], rows = t.rows;
  const notes = [];
  if (args.join_path) {
    const other = await loadTable({ path: args.join_path });
    if (!args.on) throw new ToolError('join needs on: the shared column name (or "left_col=right_col")');
    const [lc, rc = lc] = args.on.split('=').map((s) => s.trim());
    const li = colIndex(t, lc), ri = colIndex(other, rc);
    const index = new Map();
    for (const r of other.rows) {
      const k = String(r[ri]);
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(r);
    }
    const extra = other.columns.map((c, j) => [c, j]).filter(([, j]) => j !== ri);
    const how = args.how ?? 'inner';
    const joined = [];
    let unmatched = 0;
    for (const r of rows) {
      const hits = index.get(String(r[li]));
      if (hits) for (const h of hits) joined.push([...r, ...extra.map(([, j]) => h[j])]);
      else {
        unmatched++;
        if (how === 'left') joined.push([...r, ...extra.map(() => '')]);
      }
    }
    columns = [...columns, ...extra.map(([c]) => (columns.includes(c) ? `${c}_2` : c))];
    rows = joined;
    t.columns = columns;
    notes.push(`joined ${other.rows.length} rows from ${other.source} on ${lc}=${rc} (${how}); ${unmatched} left rows without match`);
  }
  const conds = [].concat(args.where ?? []).map((w) => makeFilter(t, w));
  if (conds.length) rows = rows.filter((r) => conds.every((f) => f(r)));
  const matched = rows.length;

  if (args.group_by?.length || args.aggregate?.length) {
    const keys = [].concat(args.group_by ?? []).map((g) => colIndex(t, g));
    const aggs = [].concat(args.aggregate?.length ? args.aggregate : ['count']).map((a) => makeAggregate(t, a));
    const groups = new Map();
    for (const r of rows) {
      const k = JSON.stringify(keys.map((i) => r[i]));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    if (!keys.length && !groups.size) groups.set('[]', []);
    columns = [...keys.map((i) => t.columns[i]), ...aggs.map((a) => a.name)];
    rows = [...groups].map(([k, rs]) => [...JSON.parse(k), ...aggs.map((a) => a.fn(rs))]);
    t.columns = columns;
  } else if (args.select?.length) {
    const idx = args.select.map((c) => colIndex(t, c));
    columns = idx.map((i) => t.columns[i]);
    rows = rows.map((r) => idx.map((i) => r[i]));
    t.columns = columns;
  }
  if (args.distinct) {
    const seen = new Set();
    rows = rows.filter((r) => {
      const k = JSON.stringify(r);
      return seen.has(k) ? false : seen.add(k);
    });
  }
  if (args.sort?.length) rows = [...rows].sort(sorter(t, [].concat(args.sort)));
  const total = rows.length;
  const limit = args.limit ?? (args.out_path ? Infinity : 50);
  const shown = rows.slice(0, limit);
  const body = render(columns, shown, args.output ?? 'table', t.decimalComma);
  if (args.out_path) {
    const full = resolve(args.out_path);
    if (await statOrNull(full) && !args.overwrite) throw new ToolError(`${full} exists; pass overwrite: true to replace it`);
    await writeFile(full, body + '\n');
    return [...notes, `${t.rows.length} rows read, ${matched} matched, ${shown.length} rows written to ${full}`].join('\n');
  }
  const head = [...notes, `${t.rows.length} rows read${conds.length ? `, ${matched} matched` : ''}, ${total} result rows${total > shown.length ? ` (showing ${shown.length}; raise limit or use out_path)` : ''}`];
  return [...head, '', body].join('\n');
}

export async function tableConvert(args = {}) {
  const t = await loadTable(args, { format: args.from });
  const to = args.to;
  if (!to) throw new ToolError('Provide to: csv, tsv, json, jsonl, markdown or html');
  const body = render(t.columns, t.rows, to, t.decimalComma);
  if (args.out_path) {
    const full = resolve(args.out_path);
    if (await statOrNull(full) && !args.overwrite) throw new ToolError(`${full} exists; pass overwrite: true to replace it`);
    await writeFile(full, body + '\n');
    return `${t.rows.length} rows × ${t.columns.length} columns converted ${t.format} → ${to}, written to ${full}`;
  }
  return `${t.rows.length} rows × ${t.columns.length} columns, ${t.format} → ${to}:\n\n${body}`;
}
