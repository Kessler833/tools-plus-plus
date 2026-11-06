// Exact algebra on top of the calculator's rationals: equation solving,
// matrices, number theory, and the time value of money.

import { Q, compile, evaluate, freeNames, isReserved, toSig, terminatingDecimal } from './calc.mjs';
import { ToolError, fmtNum } from './util.mjs';

const isQ = (v) => v instanceof Q;
const ZERO = Q.int(0), ONE = Q.int(1);

/** Short exact text for a rational: 3, 0.25, 1/3 (≈ 0.333333333333). */
export function fmtQ(q, sig = 12) {
  if (!isQ(q)) return `≈ ${fmtNum(q, sig)}`;
  if (q.isInt()) return q.n.toString();
  const dec = terminatingDecimal(q);
  if (dec && dec.length <= 24) return dec;
  const frac = `${q.n}/${q.d}`;
  return frac.length <= 40 ? `${frac} (≈ ${toSig(q, sig)})` : `≈ ${toSig(q, sig)}`;
}

function toQ(value, what) {
  let v;
  try {
    v = evaluate(typeof value === 'number' ? value : String(value));
  } catch (err) {
    throw new ToolError(`${what}: ${err.message}`);
  }
  return { q: isQ(v) ? v : evaluate(Number(v.toPrecision(17))), exact: isQ(v) };
}

// ---- solve --------------------------------------------------------------------

function splitEquation(text) {
  const s = String(text).replace(/==/g, '=');
  const parts = s.split(/(?<![<>!])=(?!=)/);
  if (parts.length > 2) throw new ToolError(`"${text}" has more than one "="`);
  return parts.length === 2 ? `(${parts[0]}) - (${parts[1]})` : `(${parts[0]})`;
}

// Gauss-Jordan on rationals; returns { rref, pivots }
function rref(rows) {
  const m = rows.map((r) => [...r]);
  const pivots = [];
  let r = 0;
  const cols = m[0]?.length ?? 0;
  for (let c = 0; c < cols && r < m.length; c++) {
    const p = m.findIndex((row, i) => i >= r && !row[c].isZero());
    if (p < 0) continue;
    [m[r], m[p]] = [m[p], m[r]];
    const inv = ONE.div(m[r][c]);
    m[r] = m[r].map((x) => x.mul(inv));
    for (let i = 0; i < m.length; i++) {
      if (i === r || m[i][c].isZero()) continue;
      const f = m[i][c];
      m[i] = m[i].map((x, j) => x.sub(f.mul(m[r][j])));
    }
    pivots.push(c);
    r++;
  }
  return { rref: m, pivots };
}

function evalExact(f, vars) {
  try {
    const v = f(vars);
    return isQ(v) ? v : null;
  } catch {
    return null;
  }
}

// coefficients if every equation is exactly linear in vars, else null
function linearForm(fs, names) {
  const at = (vals) => Object.fromEntries(names.map((n, i) => [n, vals[i]]));
  const rows = [];
  const probes = [names.map((_, i) => Q.int([2, 3, 5, 7, 11, 13, 17, 19][i % 8] + i)), names.map((_, i) => new Q(BigInt(-(i + 1)), BigInt(i + 3)))];
  for (const f of fs) {
    const c0 = evalExact(f, at(names.map(() => ZERO)));
    if (!c0) return null;
    const coef = [];
    for (let i = 0; i < names.length; i++) {
      const v = evalExact(f, at(names.map((_, j) => (j === i ? ONE : ZERO))));
      if (!v) return null;
      coef.push(v.sub(c0));
    }
    for (const p of probes) {
      const v = evalExact(f, at(p));
      const predicted = coef.reduce((s, a, i) => s.add(a.mul(p[i])), c0);
      if (!v || v.cmp(predicted) !== 0) return null;
    }
    rows.push([...coef, c0.neg()]);
  }
  return rows;
}

function solveLinear(rows, names) {
  const { rref: m, pivots } = rref(rows);
  const n = names.length;
  if (pivots.includes(n)) return ['No solution: the equations contradict each other (inconsistent system).'];
  const free = names.filter((_, i) => !pivots.includes(i));
  const out = [];
  pivots.forEach((c, r) => {
    const terms = [fmtQ(m[r][n])];
    for (let j = 0; j < n; j++) {
      if (j === c || m[r][j].isZero() || pivots.includes(j)) continue;
      const k = m[r][j].neg();
      terms.push(`${k.cmp(ZERO) < 0 ? '- ' : '+ '}${k.abs().cmp(ONE) === 0 ? '' : `${fmtQ(k.abs())}*`}${names[j]}`);
    }
    out.push(`${names[c]} = ${terms.join(' ').replace(/^0 \+ /, '').replace(/^0 - /, '-')}`);
  });
  if (!free.length) return ['Unique solution (exact, linear system):', ...out];
  return [`Infinitely many solutions; free variable(s): ${free.join(', ')}`, ...out, ...free.map((f) => `${f} = any value`)];
}

// best rational approximation with a small denominator, via continued fractions
function smallRational(x, maxDen = 1000) {
  if (!Number.isFinite(x)) return null;
  let [h0, h1, k0, k1] = [0, 1, 1, 0], v = x;
  for (let i = 0; i < 30; i++) {
    const a = Math.floor(v);
    [h0, h1] = [h1, a * h1 + h0];
    [k0, k1] = [k1, a * k1 + k0];
    if (k1 > maxDen) break;
    if (Math.abs(h1 / k1 - x) < 1e-12 * Math.max(1, Math.abs(x))) return new Q(BigInt(h1), BigInt(k1));
    if (v === a) break;
    v = 1 / (v - a);
  }
  return null;
}

function bisect(f, a, b, fa) {
  for (let i = 0; i < 200; i++) {
    const m = (a + b) / 2;
    if (m === a || m === b) break;
    const fm = f(m);
    if (fm === 0) return m;
    if (Math.sign(fm) === Math.sign(fa)) [a, fa] = [m, fm];
    else b = m;
  }
  return (a + b) / 2;
}

function goldenMin(g, a, b) {
  const r = (Math.sqrt(5) - 1) / 2;
  let c = b - r * (b - a), d = a + r * (b - a);
  for (let i = 0; i < 120; i++) {
    if (g(c) < g(d)) b = d;
    else a = c;
    c = b - r * (b - a);
    d = a + r * (b - a);
  }
  return (a + b) / 2;
}

function rootsOneVar(f, fExact, name, range) {
  const F = (x) => {
    try {
      const v = f({ [name]: x });
      return isQ(v) ? v.toNumber() : v;
    } catch {
      return NaN;
    }
  };
  const xs = new Set();
  if (range) {
    const [lo, hi] = range;
    for (let i = 0; i <= 20000; i++) xs.add(lo + ((hi - lo) * i) / 20000);
  } else {
    for (let i = -4000; i <= 4000; i++) xs.add(i / 200);
    for (let e = 1; e <= 6; e += 0.0025) {
      xs.add(10 ** e);
      xs.add(-(10 ** e));
    }
  }
  const pts = [...xs].sort((a, b) => a - b).map((x) => [x, F(x)]);
  const found = [];
  const add = (r) => {
    if (!found.some((x) => Math.abs(x - r) <= 1e-9 * Math.max(1, Math.abs(r)))) found.push(r);
  };
  for (let i = 0; i < pts.length && found.length < 200; i++) {
    const [x, y] = pts[i];
    if (!Number.isFinite(y)) continue;
    if (y === 0) {
      add(x);
      continue;
    }
    const next = pts[i + 1], prev = pts[i - 1];
    if (next && Number.isFinite(next[1]) && next[1] !== 0 && Math.sign(next[1]) !== Math.sign(y)) {
      const r = bisect(F, x, next[0], y);
      const fr = Math.abs(F(r));
      if (fr < 1e-7 || fr < 1e-9 * Math.min(Math.abs(y), Math.abs(next[1])) * 1e3) add(r);  // rejects poles like 1/x
    } else if (prev && next && Math.abs(y) <= Math.abs(prev[1]) && Math.abs(y) <= Math.abs(next[1])) {
      const r = goldenMin((t) => Math.abs(F(t)), prev[0], next[0]);
      if (Math.abs(F(r)) < 1e-10) add(r);  // touching root like x^2 = 0
    }
  }
  found.sort((a, b) => a - b);
  return found.map((r) => {
    const q = smallRational(r) ?? (Number.isInteger(Math.round(r)) && Math.abs(r - Math.round(r)) < 1e-9 ? Q.int(Math.round(r)) : null);
    const v = q ? evalExact(fExact, { [name]: q }) : null;
    return v?.isZero() ? `${name} = ${fmtQ(q)}  (exact)` : `${name} ≈ ${fmtNum(r, 15)}`;
  });
}

// damped Newton from several starts for square nonlinear systems
function newtonSystem(fs, names, guess) {
  const n = names.length;
  const F = (x) => fs.map((f) => {
    try {
      const v = f(Object.fromEntries(names.map((k, i) => [k, x[i]])));
      return isQ(v) ? v.toNumber() : v;
    } catch {
      return NaN;
    }
  });
  const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 20 - 10;
  const starts = [guess ?? names.map(() => 1), names.map(() => 0.5), ...Array.from({ length: 40 }, () => names.map(rnd))];
  const sols = [];
  for (const start of starts) {
    let x = [...start], fx = F(x);
    for (let it = 0; it < 100 && fx.every(Number.isFinite); it++) {
      if (norm(fx) < 1e-13) break;
      const J = fx.map(() => new Array(n).fill(0));
      for (let j = 0; j < n; j++) {
        const h = 1e-7 * Math.max(1, Math.abs(x[j]));
        const xh = [...x];
        xh[j] += h;
        const fh = F(xh);
        for (let i = 0; i < n; i++) J[i][j] = (fh[i] - fx[i]) / h;
      }
      const dx = gaussFloat(J, fx.map((v) => -v));
      if (!dx) break;
      let t = 1, nx, nfx;
      do {
        nx = x.map((v, i) => v + t * dx[i]);
        nfx = F(nx);
        t /= 2;
      } while (t > 1e-6 && !(norm(nfx) < norm(fx)));
      [x, fx] = [nx, nfx];
    }
    if (fx.every(Number.isFinite) && norm(fx) < 1e-9 && !sols.some((s) => norm(s.map((v, i) => v - x[i])) < 1e-6 * Math.max(1, norm(x)))) sols.push(x);
  }
  return sols;
}

function gaussFloat(A, b) {
  const n = A.length;
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(m[i][c]) > Math.abs(m[p][c])) p = i;
    if (Math.abs(m[p][c]) < 1e-300) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let i = c + 1; i < n; i++) {
      const f = m[i][c] / m[c][c];
      for (let j = c; j <= n; j++) m[i][j] -= f * m[c][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = m[i][n];
    for (let j = i + 1; j < n; j++) s -= m[i][j] * x[j];
    x[i] = s / m[i][i];
  }
  return x;
}

export function solve(args = {}) {
  const list = args.equations ?? (args.equation !== undefined ? [args.equation] : null);
  if (!Array.isArray(list) || !list.length) throw new ToolError('Provide equation or equations');
  const exprs = list.map(splitEquation);
  let fs;
  try {
    fs = exprs.map(compile);
  } catch (err) {
    throw new ToolError(err.message);
  }
  const names = args.variables?.length ? args.variables : [...new Set(exprs.flatMap((e) => freeNames(e)))];
  if (!names.length) throw new ToolError('No unknowns found. Name them in variables, e.g. ["x"]');
  const bad = names.filter(isReserved);
  if (bad.length) throw new ToolError(`${bad.join(', ')} is a built-in name (function or constant); rename the variable`);
  const head = `Unknowns: ${names.join(', ')}`;

  const linear = linearForm(fs, names);
  if (linear) return [head, ...solveLinear(linear, names)].join('\n');

  if (names.length === 1 && fs.length === 1) {
    const range = args.range;
    if (range && (range.length !== 2 || !(range[0] < range[1]))) throw new ToolError('range must be [min, max]');
    const roots = rootsOneVar(fs[0], fs[0], names[0], range);
    const where = range ? `in [${range[0]}, ${range[1]}]` : 'in about ±1e6 (finer near 0); pass range to search elsewhere';
    if (!roots.length) return [head, `No real solution found ${where}.`].join('\n');
    return [head, `${roots.length} real solution(s) ${where}:`, ...roots.slice(0, 50), roots.length > 50 ? `… ${roots.length - 50} more` : null, 'Numeric solutions are found by sign changes and refinement; "exact" ones were verified with exact arithmetic.'].filter(Boolean).join('\n');
  }

  if (names.length !== fs.length) throw new ToolError(`Nonlinear systems need as many equations as unknowns (${fs.length} equations, ${names.length} unknowns)`);
  const guess = args.guess ? names.map((n) => Number(args.guess[n] ?? 1)) : null;
  const sols = newtonSystem(fs, names, guess);
  if (!sols.length) return [head, 'No solution found (Newton from 42 starting points). Try a guess close to the expected solution.'].join('\n');
  return [head, `${sols.length} solution(s) found numerically (Newton's method; there may be others):`,
    ...sols.slice(0, 20).map((x) => names.map((n, i) => `${n} ≈ ${fmtNum(x[i], 12)}`).join(', '))].join('\n');
}

// ---- matrix -------------------------------------------------------------------

function parseMatrix(value, label) {
  let rows = value;
  if (typeof value === 'string') {
    rows = value.trim().replace(/^\[|\]$/g, '').split(/;|\n|\],\s*\[/).map((r) => r.replace(/[[\]]/g, '').trim()).filter(Boolean).map((r) => r.split(/[\s,]+/).filter(Boolean));
  }
  if (!Array.isArray(rows) || !rows.length) throw new ToolError(`${label} must be a non-empty matrix like [[1,2],[3,4]] or "1 2; 3 4"`);
  if (!Array.isArray(rows[0])) rows = rows.map((x) => [x]);
  const width = rows[0].length;
  let exact = true;
  const m = rows.map((r, i) => {
    if (!Array.isArray(r) || r.length !== width) throw new ToolError(`${label}: row ${i + 1} has ${r?.length} entries, expected ${width}`);
    return r.map((cell) => {
      const { q, exact: e } = toQ(cell, `${label}[${i + 1}]`);
      exact &&= e;
      return q;
    });
  });
  return { m, exact };
}

const dims = (m) => `${m.length}×${m[0].length}`;
const transpose = (m) => m[0].map((_, j) => m.map((r) => r[j]));

function multiply(a, b) {
  if (a[0].length !== b.length) throw new ToolError(`Cannot multiply ${dims(a)} by ${dims(b)}`);
  return a.map((r) => b[0].map((_, j) => r.reduce((s, x, k) => s.add(x.mul(b[k][j])), ZERO)));
}

function det(m) {
  if (m.length !== m[0].length) throw new ToolError(`Determinant needs a square matrix, got ${dims(m)}`);
  const a = m.map((r) => [...r]);
  let d = ONE;
  for (let c = 0; c < a.length; c++) {
    const p = a.findIndex((r, i) => i >= c && !r[c].isZero());
    if (p < 0) return ZERO;
    if (p !== c) {
      [a[c], a[p]] = [a[p], a[c]];
      d = d.neg();
    }
    d = d.mul(a[c][c]);
    for (let i = c + 1; i < a.length; i++) {
      const f = a[i][c].div(a[c][c]);
      if (!f.isZero()) a[i] = a[i].map((x, j) => x.sub(f.mul(a[c][j])));
    }
  }
  return d;
}

function inverse(m) {
  const n = m.length;
  if (n !== m[0].length) throw new ToolError(`Only square matrices have an inverse, got ${dims(m)}`);
  const aug = m.map((r, i) => [...r, ...m.map((_, j) => (i === j ? ONE : ZERO))]);
  const { rref: r, pivots } = rref(aug);
  if (pivots.slice(0, n).length < n || pivots[n - 1] !== n - 1) throw new ToolError('Matrix is singular (determinant 0), no inverse');
  return r.map((row) => row.slice(n));
}

function fmtMatrix(m) {
  const cells = m.map((r) => r.map((q) => (q.isInt() ? q.n.toString() : `${q.n}/${q.d}`)));
  const w = cells[0].map((_, j) => Math.max(...cells.map((r) => r[j].length)));
  const lines = cells.map((r) => `  [ ${r.map((c, j) => c.padStart(w[j])).join('  ')} ]`);
  if (m.flat().some((q) => !q.isInt())) {
    lines.push('  decimal:');
    const dec = m.map((r) => r.map((q) => toSig(q, 8)));
    const dw = dec[0].map((_, j) => Math.max(...dec.map((r) => r[j].length)));
    lines.push(...dec.map((r) => `  [ ${r.map((c, j) => c.padStart(dw[j])).join('  ')} ]`));
  }
  return lines.join('\n');
}

export function matrix(args = {}) {
  const op = args.op ?? 'info';
  const A = parseMatrix(args.a, 'a');
  const B = args.b !== undefined ? parseMatrix(args.b, 'b') : null;
  const note = A.exact && (B?.exact ?? true) ? 'exact rational arithmetic' : 'some entries were floating point and were converted to exact decimals of their double value';
  const out = [`a: ${dims(A.m)}`];
  const a = A.m;
  switch (op) {
    case 'info': {
      out.push(fmtMatrix(a));
      const { pivots } = rref(a);
      out.push(`rank: ${pivots.length}`);
      if (a.length === a[0].length) {
        const d = det(a);
        out.push(`determinant: ${fmtQ(d)}`, `trace: ${fmtQ(a.reduce((s, r, i) => s.add(r[i]), ZERO))}`, d.isZero() ? 'singular (no inverse)' : 'invertible');
        out.push(`symmetric: ${a.every((r, i) => r.every((x, j) => x.cmp(a[j][i]) === 0)) ? 'yes' : 'no'}`);
      }
      break;
    }
    case 'det': out.push(`determinant = ${fmtQ(det(a))}`); break;
    case 'inverse': out.push('inverse:', fmtMatrix(inverse(a))); break;
    case 'transpose': out.push('transpose:', fmtMatrix(transpose(a))); break;
    case 'rref': {
      const { rref: r, pivots } = rref(a);
      out.push(`rank ${pivots.length}, pivot columns ${pivots.map((p) => p + 1).join(', ') || 'none'}`, fmtMatrix(r));
      break;
    }
    case 'multiply':
      if (!B) throw new ToolError('multiply needs b');
      out.push(`b: ${dims(B.m)}`, 'a × b:', fmtMatrix(multiply(a, B.m)));
      break;
    case 'add':
    case 'subtract': {
      if (!B) throw new ToolError(`${op} needs b`);
      if (dims(a) !== dims(B.m)) throw new ToolError(`Sizes differ: ${dims(a)} vs ${dims(B.m)}`);
      out.push(`a ${op === 'add' ? '+' : '-'} b:`, fmtMatrix(a.map((r, i) => r.map((x, j) => (op === 'add' ? x.add(B.m[i][j]) : x.sub(B.m[i][j]))))));
      break;
    }
    case 'power': {
      const k = args.k;
      if (!Number.isInteger(k) || Math.abs(k) > 10_000) throw new ToolError('power needs an integer k, |k| <= 10000');
      if (a.length !== a[0].length) throw new ToolError('power needs a square matrix');
      let base = k < 0 ? inverse(a) : a, r = a.map((row, i) => row.map((_, j) => (i === j ? ONE : ZERO)));
      for (let e = Math.abs(k); e; e >>= 1) {
        if (e & 1) r = multiply(r, base);
        base = multiply(base, base);
      }
      out.push(`a^${k}:`, fmtMatrix(r));
      break;
    }
    case 'solve': {
      if (!B) throw new ToolError('solve needs b (right-hand side vector or matrix)');
      if (B.m.length !== a.length) throw new ToolError(`b needs ${a.length} rows`);
      const names = a[0].map((_, i) => `x${i + 1}`);
      if (B.m[0].length !== 1) throw new ToolError('solve: b must be a single column');
      out.push(...solveLinear(a.map((r, i) => [...r, B.m[i][0]]), names));
      break;
    }
    default: throw new ToolError(`Unknown op ${op}`);
  }
  out.push(`(${note})`);
  return out.join('\n');
}

// ---- number theory ------------------------------------------------------------

const SMALL_PRIMES = (() => {
  const sieve = new Uint8Array(100_001), ps = [];
  for (let i = 2; i <= 100_000; i++) {
    if (sieve[i]) continue;
    ps.push(i);
    for (let j = i * i; j <= 100_000; j += i) sieve[j] = 1;
  }
  return ps;
})();

function modpow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

// deterministic below 3.3e24 with these bases, a strong probable-prime test above
const MR_BASES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n];
function isPrime(n) {
  if (n < 2n) return false;
  for (const p of SMALL_PRIMES.slice(0, 60)) {
    const P = BigInt(p);
    if (n === P) return true;
    if (n % P === 0n) return false;
  }
  let d = n - 1n, s = 0;
  while (!(d & 1n)) {
    d >>= 1n;
    s++;
  }
  outer: for (const a of MR_BASES) {
    let x = modpow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1; i < s; i++) {
      x = (x * x) % n;
      if (x === n - 1n) continue outer;
    }
    return false;
  }
  return true;
}
const PROVEN_LIMIT = 3_317_044_064_679_887_385_961_981n;

const bgcd = (a, b) => {
  while (b) [a, b] = [b, a % b];
  return a;
};

function pollard(n, deadline) {
  if (n % 2n === 0n) return 2n;
  for (let c = 1n; Date.now() < deadline; c++) {
    let x = 2n, y = 2n, d = 1n, q = 1n, ys = 2n, r = 1n;
    const f = (v) => (v * v + c) % n;
    while (d === 1n) {  // Brent's cycle detection with batched gcds
      x = y;
      for (let i = 0n; i < r; i++) y = f(y);
      for (let k = 0n; k < r && d === 1n; k += 128n) {
        ys = y;
        for (let i = 0n; i < 128n && i < r - k; i++) {
          y = f(y);
          q = (q * (x > y ? x - y : y - x)) % n;
        }
        d = bgcd(q, n);
      }
      r *= 2n;
      if (Date.now() > deadline) return null;
    }
    if (d === n) {
      do {
        ys = f(ys);
        d = bgcd(x > ys ? x - ys : ys - x, n);
      } while (d === 1n);
    }
    if (d !== n) return d;
  }
  return null;
}

function factorize(n, budgetMs = 5000) {
  const factors = new Map();
  const add = (p, k = 1) => factors.set(p, (factors.get(p) ?? 0) + k);
  for (const p of SMALL_PRIMES) {
    const P = BigInt(p);
    if (P * P > n) break;
    while (n % P === 0n) {
      add(P);
      n /= P;
    }
  }
  const unresolved = [];
  const deadline = Date.now() + budgetMs;
  const stack = n > 1n ? [n] : [];
  while (stack.length) {
    const m = stack.pop();
    if (isPrime(m)) {
      add(m);
      continue;
    }
    const r = iroot2(m);
    if (r * r === m) {
      stack.push(r, r);
      continue;
    }
    const d = pollard(m, deadline);
    if (!d) unresolved.push(m);
    else stack.push(d, m / d);
  }
  return { factors: [...factors].sort((a, b) => (a[0] < b[0] ? -1 : 1)), unresolved };
}

function iroot2(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

const sup = (k) => (k === 1 ? '' : `^${k}`);

export function numberTheory(args = {}) {
  let n;
  if (args.from_base) {
    const base = args.from_base;
    if (!Number.isInteger(base) || base < 2 || base > 36) throw new ToolError('from_base must be 2-36');
    const digits = String(args.n).trim().toLowerCase().replace(/^-/, '');
    n = 0n;
    for (const ch of digits) {
      const v = parseInt(ch, 36);
      if (Number.isNaN(v) || v >= base) throw new ToolError(`"${ch}" is not a base-${base} digit`);
      n = n * BigInt(base) + BigInt(v);
    }
    if (String(args.n).trim().startsWith('-')) n = -n;
  } else {
    const v = evaluate(typeof args.n === 'number' ? args.n : String(args.n ?? ''));
    if (!isQ(v) || !v.isInt()) throw new ToolError('n must be an integer (expressions like 2^61-1 or 30! are fine)');
    n = v.n;
  }
  const abs = n < 0n ? -n : n;
  const s = abs.toString();
  const out = [`n = ${s.length > 200 ? `${s.slice(0, 60)}…${s.slice(-20)}` : n}`, `digits: ${s.length}, digit sum: ${[...s].reduce((a, c) => a + Number(c), 0)}`];
  if (abs.toString(2).length <= 256) out.push(`binary: ${n.toString(2)}`, `hex: ${n.toString(16)}`, `octal: ${n.toString(8)}`);
  if (args.base) {
    if (!Number.isInteger(args.base) || args.base < 2 || args.base > 36) throw new ToolError('base must be 2-36');
    out.push(`base ${args.base}: ${n.toString(args.base)}`);
  }
  if (abs < 2n) {
    out.push(`${n} is neither prime nor composite`);
    return out.join('\n');
  }
  const prime = isPrime(abs);
  out.push(prime ? `prime: yes${abs >= PROVEN_LIMIT ? ' (strong probable prime; Miller-Rabin with 13 bases)' : ''}` : 'prime: no');
  if (!prime || args.neighbors !== false) {
    if (abs.toString(2).length <= 512) {
      let p = abs - 1n;
      while (p >= 2n && !isPrime(p)) p--;
      let q = abs + 1n;
      while (!isPrime(q)) q++;
      out.push(`previous prime: ${p >= 2n ? p : 'none'}, next prime: ${q}`);
    }
  }
  if (!prime) {
    const { factors, unresolved } = factorize(abs);
    const parts = factors.map(([p, k]) => `${p}${sup(k)}`).concat(unresolved.map((u) => `${u} (composite, not factored in time)`));
    out.push(`factorization: ${n < 0n ? '-1 × ' : ''}${parts.join(' × ')}`);
    if (!unresolved.length) {
      const count = factors.reduce((c, [, k]) => c * BigInt(k + 1), 1n);
      const sigma = factors.reduce((t, [p, k]) => t * ((p ** BigInt(k + 1) - 1n) / (p - 1n)), 1n);
      const phi = factors.reduce((t, [p, k]) => t * (p - 1n) * p ** BigInt(k - 1), 1n);
      out.push(`divisors: ${count}, sum of divisors: ${sigma}, Euler phi: ${phi}`);
      if (sigma - abs === abs) out.push('perfect number');
      if (count <= 200n) {
        let divs = [1n];
        for (const [p, k] of factors) divs = divs.flatMap((d) => Array.from({ length: k + 1 }, (_, i) => d * p ** BigInt(i)));
        out.push(`all divisors: ${divs.sort((a, b) => (a < b ? -1 : 1)).join(', ')}`);
      }
    }
  } else {
    out.push(`divisors: 2 (1 and itself), Euler phi: ${abs - 1n}`);
  }
  return out.join('\n');
}

// ---- finance ------------------------------------------------------------------

const money = (x) => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (r) => `${fmtNum(r * 100, 6)}%`;

function need(args, ...keys) {
  for (const k of keys) {
    if (typeof args[k] !== 'number' || !Number.isFinite(args[k])) throw new ToolError(`${args.op} needs a number for ${k}`);
  }
}

function npvAt(rate, flows) {
  return flows.reduce((s, c, t) => s + c / (1 + rate) ** t, 0);
}

export function finance(args = {}) {
  const op = args.op;
  const out = [];
  const perYear = args.periods_per_year ?? 12;
  switch (op) {
    case 'compound': {
      need(args, 'principal', 'rate', 'years');
      const n = args.compounding ?? 12;
      const r = args.rate / 100, years = args.years, pmt = args.contribution ?? 0;
      const i = r / n, N = Math.round(years * n);
      const growth = (1 + i) ** N;
      const fvP = args.principal * growth;
      const fvC = i === 0 ? pmt * N : pmt * ((growth - 1) / i) * (args.contribution_at_start ? 1 + i : 1);
      const fv = fvP + fvC, paid = args.principal + pmt * N;
      out.push(`Future value after ${years} years: ${money(fv)}`, `  from principal: ${money(fvP)}`, pmt ? `  from contributions (${money(pmt)} × ${N}): ${money(fvC)}` : null,
        `Paid in: ${money(paid)}, interest earned: ${money(fv - paid)}`, `Effective annual rate: ${pct((1 + i) ** n - 1)} (nominal ${pct(r)}, compounded ${n}×/year)`);
      if (args.inflation) out.push(`In today's money (${args.inflation}% inflation): ${money(fv / (1 + args.inflation / 100) ** years)}`);
      break;
    }
    case 'loan': {
      need(args, 'principal', 'rate');
      const months = args.months ?? (args.years ? Math.round(args.years * perYear) : null);
      if (!months) throw new ToolError('loan needs years or months');
      const i = args.rate / 100 / perYear, P = args.principal;
      const pay = i === 0 ? P / months : (P * i) / (1 - (1 + i) ** -months);
      out.push(`Payment: ${money(pay)} per period (${months} periods, ${perYear} per year)`, `Total paid: ${money(pay * months)}, total interest: ${money(pay * months - P)}`);
      let bal = P, yearInt = 0, yearPrin = 0;
      const rows = [];
      for (let k = 1; k <= months; k++) {
        const int = bal * i, prin = pay - int;
        bal -= prin;
        yearInt += int;
        yearPrin += prin;
        if (k % perYear === 0 || k === months) {
          rows.push(`  year ${Math.ceil(k / perYear)}: interest ${money(yearInt)}, principal ${money(yearPrin)}, balance ${money(Math.max(bal, 0))}`);
          yearInt = yearPrin = 0;
        }
      }
      out.push('Amortization by year:', ...(rows.length > 40 ? [...rows.slice(0, 20), '  …', ...rows.slice(-5)] : rows));
      break;
    }
    case 'npv': {
      need(args, 'rate');
      const flows = args.cashflows;
      if (!Array.isArray(flows) || !flows.length) throw new ToolError('npv needs cashflows, first one at time 0 (usually negative)');
      out.push(`NPV at ${args.rate}%: ${money(npvAt(args.rate / 100, flows))}`);
      break;
    }
    case 'irr': {
      const flows = args.cashflows;
      if (!Array.isArray(flows) || flows.length < 2 || !flows.some((c) => c < 0) || !flows.some((c) => c > 0)) throw new ToolError('irr needs cashflows with at least one negative and one positive value');
      const roots = [];
      let prev = -0.9999, fprev = npvAt(prev, flows);
      for (let k = 1; k <= 4000; k++) {
        const r = -0.9999 + (k / 4000) * 10.9999, fr = npvAt(r, flows);
        if (Math.sign(fr) !== Math.sign(fprev)) {
          let [a, b, fa] = [prev, r, fprev];
          for (let it = 0; it < 200; it++) {
            const m = (a + b) / 2, fm = npvAt(m, flows);
            if (Math.sign(fm) === Math.sign(fa)) [a, fa] = [m, fm];
            else b = m;
          }
          roots.push((a + b) / 2);
        }
        [prev, fprev] = [r, fr];
      }
      if (!roots.length) out.push('No IRR between -99.99% and 1000%.');
      else out.push(`IRR: ${roots.map(pct).join(', ')} per period`, roots.length > 1 ? 'Several IRRs: the cash flows change sign more than once, so IRR is ambiguous; prefer NPV.' : null);
      break;
    }
    case 'cagr': {
      need(args, 'start_value', 'end_value', 'years');
      if (args.start_value <= 0 || args.end_value <= 0) throw new ToolError('cagr needs positive values');
      const g = (args.end_value / args.start_value) ** (1 / args.years) - 1;
      out.push(`CAGR: ${pct(g)} per year`, `Total change: ${pct(args.end_value / args.start_value - 1)}`);
      break;
    }
    case 'real_rate': {
      need(args, 'rate', 'inflation');
      const real = (1 + args.rate / 100) / (1 + args.inflation / 100) - 1;
      out.push(`Real rate: ${pct(real)} (Fisher; the simple difference would be ${fmtNum(args.rate - args.inflation, 6)}%)`);
      break;
    }
    case 'doubling': {
      need(args, 'rate');
      out.push(`Doubling time at ${args.rate}%: ${fmtNum(Math.log(2) / Math.log(1 + args.rate / 100), 6)} periods (rule of 72: ${fmtNum(72 / args.rate, 4)})`);
      break;
    }
    default: throw new ToolError('op must be compound, loan, npv, irr, cagr, real_rate or doubling');
  }
  out.push('Arithmetic only, not financial advice. Rates are percent per year unless noted.');
  return out.filter(Boolean).join('\n');
}

