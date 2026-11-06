// Descriptive statistics, correlation and regression for number lists or CSV
// columns. Uses compensated summation and two-pass variance for accuracy.

import { ToolError, fmtNum, readInput } from './util.mjs';

// ---- parsing ------------------------------------------------------------------

/** One numeric cell: handles 1,234.5 / 1.234,5 / 1,5 (when not CSV comma), 12% and blanks. */
export function parseNumber(cell, decimalComma = false) {
  let s = String(cell ?? '').trim().replace(/[\s  ']/g, '');
  if (!s) return NaN;
  if (/^-?[\d.]+,\d+$/.test(s) && (decimalComma || /\.\d{3},/.test(s))) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  s = s.replace(/^\+/, '').replace(/%$/, '');
  if (!/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}

function detectDelimiter(firstLine) {
  let best = ',', bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    let count = 0, quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) [best, bestCount] = [d, count];
  }
  return best;
}

/** RFC 4180 CSV with quotes, escaped quotes, CRLF and newlines inside quotes. */
export function parseCsv(text, delimiter) {
  const nl = text.indexOf('\n');
  const delim = delimiter || detectDelimiter(nl < 0 ? text : text.slice(0, nl));
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return { rows, delimiter: delim };
}

/** Free text like "1 2 3", "1, 2, 3", "1,5; 2,5" (decimal commas) or one per line. */
function parseList(text) {
  const parts = text.split(/[\s;]+/).filter(Boolean);
  const decimalComma = parts.length > 1 && parts.every((p) => (p.match(/,/g) || []).length <= 1) && !text.includes('.') && /\d,\d/.test(text) && !/,\s/.test(text);
  // split on commas, except inside thousands groups like 1,000.5
  const tokens = decimalComma ? parts : parts.flatMap((p) => (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(p) ? [p] : p.split(','))).filter(Boolean);
  const values = [], bad = [];
  for (const t of tokens) {
    const v = parseNumber(t, decimalComma);
    if (Number.isNaN(v)) bad.push(t);
    else values.push(v);
  }
  return { values, bad, decimalComma };
}

// ---- math ---------------------------------------------------------------------

function sum(xs) {
  let s = 0, c = 0;  // Neumaier compensated summation
  for (const x of xs) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
    s = t;
  }
  return s + c;
}

const mean = (xs) => sum(xs) / xs.length;

// linear interpolation between closest ranks (Excel PERCENTILE.INC, numpy default)
function quantile(sorted, p) {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  return lo + 1 < sorted.length ? sorted[lo] + (h - lo) * (sorted[lo + 1] - sorted[lo]) : sorted[lo];
}

function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;  // ties share the average rank
    i = j + 1;
  }
  return r;
}

function pearson(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  const sxy = sum(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  const sxx = sum(xs.map((x) => (x - mx) ** 2));
  const syy = sum(ys.map((y) => (y - my) ** 2));
  return { r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN, slope: sxx ? sxy / sxx : NaN, mx, my };
}

function describe(xs, { percentiles = [], histogram = false } = {}) {
  const n = xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = mean(xs);
  const ss = sum(xs.map((x) => (x - m) ** 2));
  const varS = n > 1 ? ss / (n - 1) : NaN, varP = ss / n;
  const sdS = Math.sqrt(varS), sdP = Math.sqrt(varP);
  const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75), iqr = q3 - q1;
  const f = (x) => (Number.isNaN(x) ? 'n/a' : fmtNum(x));

  const counts = new Map();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let top = 0;  // no Math.max(...spread): it overflows the stack for large inputs
  for (const c of counts.values()) if (c > top) top = c;
  const modes = top > 1 ? [...counts].filter(([, c]) => c === top).map(([v]) => v) : [];

  const lines = [
    `n: ${n}`,
    `sum: ${f(sum(xs))}`,
    `mean: ${f(m)}`,
    `median: ${f(quantile(sorted, 0.5))}`,
    `mode: ${modes.length ? `${modes.slice(0, 5).map(f).join(', ')}${modes.length > 5 ? ` (+${modes.length - 5} more)` : ''} (${top}×)` : 'none (all values unique)'}`,
    `min: ${f(sorted[0])}   max: ${f(sorted[n - 1])}   range: ${f(sorted[n - 1] - sorted[0])}`,
    `std dev: ${f(sdS)} (sample, n-1)   ${f(sdP)} (population, n)`,
    `variance: ${f(varS)} (sample)   ${f(varP)} (population)`,
    `std error of mean: ${f(sdS / Math.sqrt(n))}`,
    `Q1: ${f(q1)}   Q3: ${f(q3)}   IQR: ${f(iqr)}`,
  ];
  if (m !== 0 && n > 1) lines.push(`coefficient of variation: ${fmtNum((sdS / Math.abs(m)) * 100, 4)}%`);
  if (n > 2 && sdS > 0) {
    const skew = (n / ((n - 1) * (n - 2))) * sum(xs.map((x) => ((x - m) / sdS) ** 3));
    lines.push(`skewness: ${fmtNum(skew, 4)}`);
  }
  if (sorted[0] > 0) {
    lines.push(`geometric mean: ${f(Math.exp(mean(xs.map(Math.log))))}   harmonic mean: ${f(n / sum(xs.map((x) => 1 / x)))}`);
  }
  const outliers = xs.filter((x) => x < q1 - 1.5 * iqr || x > q3 + 1.5 * iqr);
  if (outliers.length) lines.push(`outliers (beyond 1.5×IQR): ${outliers.length} (${outliers.slice(0, 10).map(f).join(', ')}${outliers.length > 10 ? ', …' : ''})`);
  for (const p of percentiles) {
    if (typeof p !== 'number' || p < 0 || p > 100) throw new ToolError('percentiles must be numbers from 0 to 100');
    lines.push(`P${p}: ${f(quantile(sorted, p / 100))}`);
  }
  if (histogram) lines.push('', ...histogramLines(sorted));
  return lines;
}

function histogramLines(sorted) {
  const n = sorted.length, lo = sorted[0], hi = sorted[n - 1];
  if (lo === hi) return [`histogram: all ${n} values equal ${fmtNum(lo)}`];
  const bins = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(n))));
  const width = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  for (const x of sorted) counts[Math.min(bins - 1, Math.floor((x - lo) / width))]++;
  const most = Math.max(...counts);
  const labels = counts.map((_, i) => `${fmtNum(lo + i * width, 4)} – ${fmtNum(lo + (i + 1) * width, 4)}`);
  const pad = Math.max(...labels.map((l) => l.length));
  return ['histogram:', ...counts.map((c, i) => `${labels[i].padEnd(pad)} | ${'█'.repeat(Math.round((c / most) * 40))} ${c}`)];
}

function relation(xs, ys) {
  if (xs.length !== ys.length) throw new ToolError(`x has ${xs.length} values but y has ${ys.length}`);
  if (xs.length < 3) throw new ToolError('Correlation needs at least 3 pairs');
  const { r, slope, mx, my } = pearson(xs, ys);
  const rho = pearson(ranks(xs), ranks(ys)).r;
  const intercept = my - slope * mx;
  const f = (x) => (Number.isNaN(x) ? 'n/a (constant series)' : fmtNum(x, 6));
  const strength = Number.isNaN(r) ? '' : Math.abs(r) >= 0.7 ? 'strong' : Math.abs(r) >= 0.4 ? 'moderate' : Math.abs(r) >= 0.2 ? 'weak' : 'negligible';
  return [
    `pairs: ${xs.length}`,
    `Pearson r: ${f(r)}${strength ? ` (${strength} ${r > 0 ? 'positive' : 'negative'} linear relation)` : ''}`,
    `R²: ${f(r * r)}`,
    `Spearman ρ: ${f(rho)}`,
    `linear fit: y = ${fmtNum(intercept, 6)} + ${fmtNum(slope, 6)}·x`,
  ];
}

// ---- tool entry ---------------------------------------------------------------

function columnIndex(header, column, width) {
  if (typeof column === 'number') {
    if (!Number.isInteger(column) || column < 1 || column > width) throw new ToolError(`column must be 1..${width}`);
    return column - 1;
  }
  const i = header.findIndex((h) => h.trim().toLowerCase() === String(column).trim().toLowerCase());
  if (i < 0) throw new ToolError(`No column "${column}". Columns: ${header.map((h) => h.trim()).join(', ')}`);
  return i;
}

export async function stats(args = {}) {
  const { numbers, y, column, y_column, percentiles, histogram, delimiter } = args;
  const opts = { percentiles, histogram };

  if (Array.isArray(numbers)) {
    if (!numbers.length) throw new ToolError('numbers is empty');
    if (!numbers.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new ToolError('numbers must be finite numbers');
    const lines = describe(numbers, opts);
    if (y) lines.push('', ...relation(numbers, y));
    return lines.join('\n');
  }

  const { text, path } = await readInput(args);
  const tabular = path || column !== undefined || (/[,;\t|].*\n.*[,;\t|]/.test(text) && /[A-Za-z]/.test(text.split('\n')[0]));
  if (!tabular) {
    const { values, bad, decimalComma } = parseList(text);
    if (!values.length) throw new ToolError('No numbers found in text');
    const lines = describe(values, opts);
    if (decimalComma) lines.push('note: commas were read as decimal separators (1,5 = 1.5); separate list items with ", " or ";" if they are not');
    if (bad.length) lines.push(`skipped ${bad.length} non-numeric token(s): ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', …' : ''}`);
    return lines.join('\n');
  }

  const { rows, delimiter: delim } = parseCsv(text, delimiter);
  if (rows.length < 2) throw new ToolError('CSV needs a header row and at least one data row');
  const [header, ...data] = rows;
  const width = header.length;
  const decimalComma = delim !== ',';
  const columnValues = (i) => {
    const vals = [];
    let missing = 0;
    for (const r of data) {
      const v = parseNumber(r[i], decimalComma);
      if (Number.isNaN(v)) missing++;
      else vals.push(v);
    }
    return { vals, missing };
  };

  const source = `${path ?? 'text'}: ${data.length} rows, ${width} columns, delimiter ${JSON.stringify(delim)}`;
  if (column === undefined) {
    const lines = [source, ''];
    for (let i = 0; i < width; i++) {
      const { vals, missing } = columnValues(i);
      const name = header[i].trim() || `#${i + 1}`;
      if (vals.length < data.length / 2) {
        lines.push(`${name}: non-numeric`);
        continue;
      }
      const s = [...vals].sort((a, b) => a - b);
      const m = mean(vals);
      const sd = vals.length > 1 ? Math.sqrt(sum(vals.map((x) => (x - m) ** 2)) / (vals.length - 1)) : NaN;
      lines.push(`${name}: n=${vals.length}${missing ? ` (${missing} missing)` : ''} mean=${fmtNum(m)} median=${fmtNum(quantile(s, 0.5))} sd=${fmtNum(sd)} min=${fmtNum(s[0])} max=${fmtNum(s.at(-1))}`);
    }
    lines.push('', 'Pass column (and y_column) for full statistics of one column.');
    return lines.join('\n');
  }

  const xi = columnIndex(header, column, width);
  if (y_column !== undefined) {
    const yi = columnIndex(header, y_column, width);
    const xs = [], ys = [];
    let dropped = 0;
    for (const r of data) {
      const a = parseNumber(r[xi], decimalComma), b = parseNumber(r[yi], decimalComma);
      if (Number.isNaN(a) || Number.isNaN(b)) dropped++;
      else {
        xs.push(a);
        ys.push(b);
      }
    }
    if (!xs.length) throw new ToolError('No rows with numbers in both columns');
    return [source, `x = ${header[xi].trim()}, y = ${header[yi].trim()}${dropped ? ` (${dropped} incomplete rows dropped)` : ''}`, '', ...relation(xs, ys), '', `${header[xi].trim()}:`, ...describe(xs, opts)].join('\n');
  }
  const { vals, missing } = columnValues(xi);
  if (!vals.length) throw new ToolError(`Column "${header[xi].trim()}" has no numeric values`);
  return [source, `column: ${header[xi].trim()}${missing ? ` (${missing} empty/non-numeric cells skipped)` : ''}`, '', ...describe(vals, opts)].join('\n');
}
