// JSON validation with precise errors (line, column, code frame, hints),
// duplicate-key and precision-loss warnings, formatting, querying and a
// structure summary.

import { ToolError, readInput, intArg, clip } from './util.mjs';

// ---- validating parser --------------------------------------------------------

class JsonError extends Error {
  constructor(message, pos) {
    super(message);
    this.pos = pos;
  }
}

/** Walks the text like JSON.parse but reports positions and collects warnings. */
function scan(text) {
  let i = 0;
  const warnings = [];
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const fail = (msg) => {
    throw new JsonError(msg, i);
  };

  function string() {
    const start = i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') return text.slice(start, ++i);
      if (ch === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('invalid \\u escape (needs 4 hex digits)');
          i += 6;
        } else if ('"\\/bfnrt'.includes(e) && e !== undefined) i += 2;
        else fail(`invalid escape \\${e ?? ''}`);
      } else if (ch < ' ') {
        fail(ch === '\n' ? 'unescaped newline inside a string (use \\n)' : 'unescaped control character inside a string');
      } else i++;
    }
    i = start;
    fail('unterminated string');
  }

  function number() {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) fail(text[i] === '-' ? 'invalid number' : 'unexpected character');
    if (/^-?0\d/.test(text.slice(i, i + 3))) fail('numbers cannot have leading zeros');
    if (!m[2] && !m[3] && !Number.isSafeInteger(Number(m[0]))) warnings.push({ pos: i, msg: `integer ${clip(m[0], 30)} exceeds 2^53 and loses precision in JavaScript (use a string)` });
    i += m[0].length;
  }

  function value(depth) {
    if (depth > 2000) fail('nesting deeper than 2000 levels');
    ws();
    const ch = text[i];
    if (ch === '{') return object(depth);
    if (ch === '[') return array(depth);
    if (ch === '"') return string();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return number();
    for (const lit of ['true', 'false', 'null']) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return;
      }
    }
    if (ch === undefined) fail('unexpected end of input');
    if (ch === "'") fail("strings must use double quotes, not '");
    if (text.startsWith('NaN', i) || text.startsWith('Infinity', i) || text.startsWith('undefined', i)) fail(`${/^\w+/.exec(text.slice(i))[0]} is not valid JSON (use null or a string)`);
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) fail('comments are not allowed in JSON');
    if (ch === '}' || ch === ']') fail(`unexpected "${ch}" (trailing comma before it?)`);
    fail(`unexpected character ${JSON.stringify(ch)}`);
  }

  function object(depth) {
    i++;
    const keys = new Map();
    ws();
    if (text[i] === '}') {
      i++;
      return;
    }
    for (;;) {
      ws();
      if (text[i] !== '"') {
        if (text[i] === '}') fail('trailing comma before "}"');
        if (/[A-Za-z_$]/.test(text[i] ?? '')) fail('object keys must be double-quoted strings');
        if (text[i] === "'") fail("keys must use double quotes, not '");
        fail('expected a string key');
      }
      const keyPos = i;
      const key = JSON.parse(string());
      if (keys.has(key)) warnings.push({ pos: keyPos, msg: `duplicate key ${JSON.stringify(key)} (JSON.parse keeps the last one)` });
      keys.set(key, true);
      ws();
      if (text[i] !== ':') fail(`expected ":" after key ${JSON.stringify(key)}`);
      i++;
      value(depth + 1);
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === '}') {
        i++;
        return;
      }
      fail(text[i] === undefined ? 'unexpected end of input, missing "}"' : 'expected "," or "}" after a value (missing comma?)');
    }
  }

  function array(depth) {
    i++;
    ws();
    if (text[i] === ']') {
      i++;
      return;
    }
    for (;;) {
      ws();
      if (text[i] === ']') fail('trailing comma before "]"');
      value(depth + 1);
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === ']') {
        i++;
        return;
      }
      fail(text[i] === undefined ? 'unexpected end of input, missing "]"' : 'expected "," or "]" after a value (missing comma?)');
    }
  }

  value(0);
  ws();
  if (i < text.length) fail('unexpected content after the JSON value (several values? use an array, or JSON Lines)');
  return warnings;
}

function position(text, pos) {
  const before = text.slice(0, pos);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = text.indexOf('\n', pos);
  const src = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).replace(/\r$/, '');
  const col = pos - lineStart + 1;
  // keep the frame short for minified one-line files
  const from = Math.max(0, col - 60);
  const frame = `${from ? '…' : ''}${src.slice(from, col + 40)}${src.length > col + 40 ? '…' : ''}`;
  return { line, col, frame: `${frame}\n${' '.repeat(col - from - 1 + (from ? 1 : 0))}^` };
}

// ---- path queries -------------------------------------------------------------

function parsePath(path) {
  const p = path.trim().replace(/^\$/, '');
  const segs = [];
  const re = /\.\.([A-Za-z_$][\w$-]*|\*)|\.([A-Za-z_$][\w$-]*|\*)|\[(-?\d+|\*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\]|^([A-Za-z_$][\w$-]*)/gy;
  let m, at = 0;
  while (at < p.length) {
    re.lastIndex = at;
    m = re.exec(p);
    if (!m || m.index !== at) throw new ToolError(`Cannot parse path at "${p.slice(at)}". Use $.a.b[0], items[*].name, ["key with space"], ..name`);
    at = re.lastIndex;
    if (m[1]) segs.push({ deep: true, key: m[1] });
    else if (m[2] || m[4]) segs.push({ key: m[2] ?? m[4] });
    else {
      const b = m[3];
      if (b === '*') segs.push({ key: '*' });
      else if (/^-?\d+$/.test(b)) segs.push({ index: Number(b) });
      else segs.push({ key: JSON.parse(b[0] === "'" ? `"${b.slice(1, -1).replace(/"/g, '\\"')}"` : b) });
    }
  }
  return segs;
}

function query(root, segs) {
  let nodes = [{ path: '$', v: root }];
  for (const s of segs) {
    const next = [];
    for (const { path, v } of nodes) {
      if (s.deep) {
        const walk = (p, x) => {
          if (x && typeof x === 'object') {
            for (const [k, c] of Object.entries(x)) {
              const cp = Array.isArray(x) ? `${p}[${k}]` : `${p}.${k}`;
              if (s.key === '*' || k === s.key) next.push({ path: cp, v: c });
              walk(cp, c);
            }
          }
        };
        walk(path, v);
      } else if (s.index !== undefined) {
        if (Array.isArray(v)) {
          const idx = s.index < 0 ? v.length + s.index : s.index;
          if (idx >= 0 && idx < v.length) next.push({ path: `${path}[${idx}]`, v: v[idx] });
        }
      } else if (s.key === '*') {
        if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) next.push({ path: Array.isArray(v) ? `${path}[${k}]` : `${path}.${k}`, v: c });
      } else if (v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, s.key)) {
        next.push({ path: /^[A-Za-z_$][\w$]*$/.test(s.key) ? `${path}.${s.key}` : `${path}[${JSON.stringify(s.key)}]`, v: v[s.key] });
      }
    }
    nodes = next;
  }
  return nodes;
}

// ---- structure summary --------------------------------------------------------

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function structure(root, maxLines = 200) {
  const info = new Map();  // path -> { types: Set, count, lengths }
  const visit = (path, v, depth) => {
    let e = info.get(path);
    if (!e) info.set(path, (e = { types: new Set(), count: 0, min: Infinity, max: -Infinity }));
    e.types.add(typeOf(v));
    e.count++;
    if (Array.isArray(v)) {
      e.min = Math.min(e.min, v.length);
      e.max = Math.max(e.max, v.length);
      if (depth < 30) for (const c of v.slice(0, 1000)) visit(`${path}[*]`, c, depth + 1);
    } else if (v && typeof v === 'object' && depth < 30) {
      for (const [k, c] of Object.entries(v)) visit(/^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`, c, depth + 1);
    }
  };
  visit('$', root, 0);
  const lines = [];
  for (const [path, e] of info) {
    if (lines.length >= maxLines) {
      lines.push(`… ${info.size - maxLines} more paths`);
      break;
    }
    const parent = info.get(path.replace(/(\.[^.[\]]+|\[[^\]]*\])$/, ''));
    const optional = parent && !path.endsWith('[*]') && e.count < parent.count ? ` (in ${e.count}/${parent.count})` : '';
    const len = e.types.has('array') ? ` [${e.min === e.max ? e.min : `${e.min}..${e.max}`}]` : '';
    lines.push(`${path}: ${[...e.types].join(' | ')}${len}${optional}`);
  }
  return lines;
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// ---- tool entry ---------------------------------------------------------------

export async function jsonTool(args = {}) {
  const op = args.op ?? 'validate';
  const { text, path } = await readInput(args);
  const indent = intArg(args.indent, 'indent', { min: 0, max: 8, def: 2 });

  if (op === 'validate' && args.lines) {
    // JSON Lines: validate every non-empty line
    const errors = [];
    let count = 0;
    text.split(/\r?\n/).forEach((l, n) => {
      if (!l.trim()) return;
      count++;
      try {
        scan(l);
      } catch (err) {
        if (errors.length < 20) errors.push(`line ${n + 1}, col ${err.pos + 1}: ${err.message}`);
      }
    });
    return errors.length ? `✗ ${errors.length} invalid of ${count} JSON Lines records\n${errors.join('\n')}` : `✓ valid JSON Lines, ${count} records`;
  }

  let warnings;
  try {
    warnings = scan(text);
  } catch (err) {
    if (!(err instanceof JsonError)) throw err;
    const { line, col, frame } = position(text, err.pos);
    throw new ToolError(`Invalid JSON${path ? ` in ${path}` : ''} at line ${line}, column ${col}: ${err.message}\n${frame}`);
  }
  const warnText = warnings.slice(0, 20).map((w) => {
    const { line, col } = position(text, w.pos);
    return `warning (line ${line}, col ${col}): ${w.msg}`;
  });
  if (warnings.length > 20) warnText.push(`… ${warnings.length - 20} more warnings`);
  const data = JSON.parse(text);

  switch (op) {
    case 'validate': {
      const t = typeOf(data);
      const size = Array.isArray(data) ? `, ${data.length} items` : t === 'object' ? `, ${Object.keys(data).length} keys` : '';
      return [`✓ valid JSON (top level: ${t}${size})`, ...warnText].join('\n');
    }
    case 'format':
      return [...warnText, JSON.stringify(args.sort_keys ? sortKeys(data) : data, null, indent)].join('\n');
    case 'minify':
      return [...warnText, JSON.stringify(args.sort_keys ? sortKeys(data) : data)].join('\n');
    case 'query': {
      if (!args.path_expr) throw new ToolError('query needs path_expr, e.g. $.items[*].name');
      const hits = query(data, parsePath(args.path_expr));
      if (!hits.length) return `No match for ${args.path_expr}`;
      const shown = hits.slice(0, 100).map((h) => `${h.path} = ${clip(JSON.stringify(h.v, null, hits.length === 1 ? indent : 0), 4000)}`);
      return [`${hits.length} match(es)`, ...shown, hits.length > 100 ? `… ${hits.length - 100} more` : null, ...warnText].filter(Boolean).join('\n');
    }
    case 'structure':
      return [...structure(data), ...warnText].join('\n');
    default:
      throw new ToolError('op must be validate, format, minify, query or structure');
  }
}
