// Exact calculator. Numbers are rationals on BigInt; IEEE doubles are used only
// where no exact answer exists (trig, logs, irrational roots), and the output
// always says which of the two you got.

export class CalcError extends Error {}

const MAX_BITS = 2_000_000;      // refuse exact powers larger than this (~600k digits)
const MAX_FACTORIAL = 20_000;
const MAX_PRINT = 5_000;         // longest number printed in full
const MAX_SIG_DIGITS = 1_000;

const babs = (n) => (n < 0n ? -n : n);
const bitLen = (n) => (n === 0n ? 0 : babs(n).toString(2).length);

function bgcd(a, b) {
  a = babs(a);
  b = babs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

export class Q {
  constructor(n, d = 1n) {
    if (d === 0n) throw new CalcError('Division by zero');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = bgcd(n, d);
    this.n = n / g;
    this.d = d / g;
  }
  static int(n) { return new Q(BigInt(n)); }
  isInt() { return this.d === 1n; }
  isZero() { return this.n === 0n; }
  neg() { return new Q(-this.n, this.d); }
  abs() { return new Q(babs(this.n), this.d); }
  add(o) { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Q(this.n * o.n, this.d * o.d); }
  div(o) {
    if (o.n === 0n) throw new CalcError('Division by zero');
    return new Q(this.n * o.d, this.d * o.n);
  }
  cmp(o) {
    const x = this.n * o.d - o.n * this.d;
    return x < 0n ? -1 : x > 0n ? 1 : 0;
  }
  floor() {
    const q = this.n / this.d;
    return new Q(this.n < 0n && this.n % this.d !== 0n ? q - 1n : q);
  }
  toNumber() {
    const { n, d } = this;
    const bn = bitLen(n), bd = bitLen(d);
    if (bn < 1000 && bd < 1000) return Number(n) / Number(d);
    const shift = bn - bd - 64;  // keep ~64 significant bits, rescale after
    const scaled = shift >= 0 ? n / (d << BigInt(shift)) : (n << BigInt(-shift)) / d;
    return Number(scaled) * 2 ** shift;
  }
}

const ZERO = Q.int(0), ONE = Q.int(1), TEN = Q.int(10);
const isQ = (v) => v instanceof Q;
const toNum = (v) => (isQ(v) ? v.toNumber() : v);

function approx(x) {
  if (Number.isNaN(x)) throw new CalcError('Result is not a real number');
  if (!Number.isFinite(x)) throw new CalcError('Result is too large for floating point');
  return x;
}

function wantInt(v, what) {
  if (!isQ(v) || !v.isInt()) throw new CalcError(`${what} needs integer arguments`);
  return v.n;
}

// ---- roots and powers -------------------------------------------------------

// floor(n^(1/k)) for n >= 0
function iroot(n, k) {
  if (n < 2n) return n;
  const K = BigInt(k);
  let x = 1n << BigInt(Math.ceil(bitLen(n) / k));
  for (;;) {
    const y = ((K - 1n) * x + n / x ** (K - 1n)) / K;
    if (y >= x) return x;
    x = y;
  }
}

// exact k-th root of a rational, or null when it is irrational
function exactRoot(q, k) {
  if (q.n < 0n && k % 2 === 0) return null;
  const K = BigInt(k);
  const rn = iroot(babs(q.n), k), rd = iroot(q.d, k);
  if (rn ** K !== babs(q.n) || rd ** K !== q.d) return null;
  return new Q(q.n < 0n ? -rn : rn, rd);
}

function powExact(b, e) {
  if (e.isInt()) {
    const k = e.n;
    if (b.isZero()) {
      if (k < 0n) throw new CalcError('Division by zero (0 to a negative power)');
      return k === 0n ? ONE : ZERO;
    }
    if (b.d === 1n && babs(b.n) === 1n) return b.n === 1n || k % 2n === 0n ? ONE : b;
    const big = babs(b.n) > b.d ? babs(b.n) : b.d;
    const bits = (big < 1n << 1000n ? Math.log2(Number(big)) : bitLen(big)) * Number(babs(k));
    if (bits > MAX_BITS) {
      const digits = Math.round(bits * Math.LOG10E * Math.LN2);
      throw new CalcError(`Exact result would have about ${digits.toLocaleString('en-US')} digits; the limit is about 600,000`);
    }
    const m = babs(k);
    const r = new Q(b.n ** m, b.d ** m);
    return k < 0n ? ONE.div(r) : r;
  }
  if (e.d <= 1000n) {
    const root = exactRoot(b, Number(e.d));
    if (root) return powExact(root, new Q(e.n));
  }
  return null;
}

function pow(b, e) {
  if (isQ(b) && isQ(e)) {
    const exact = powExact(b, e);
    if (exact) return exact;
    // odd roots of negative numbers are real: (-2)^(1/3)
    if (b.n < 0n && e.d % 2n === 1n) {
      const r = Math.pow(-b.toNumber(), e.toNumber());
      return approx(e.n % 2n === 0n ? r : -r);
    }
  }
  return approx(Math.pow(toNum(b), toNum(e)));
}

function root(x, k, float) {
  if (isQ(x)) {
    const r = exactRoot(x, k);
    if (r) return r;
  }
  if (k % 2 === 1 && toNum(x) < 0) return approx(-float(-toNum(x)));
  return approx(float(toNum(x)));
}

// ---- arithmetic -------------------------------------------------------------

export function arith(op, a, b) {
  if (op === '^') return pow(a, b);
  if (isQ(a) && isQ(b)) {
    switch (op) {
      case '+': return a.add(b);
      case '-': return a.sub(b);
      case '*': return a.mul(b);
      case '/': return a.div(b);
      case '%':
        if (b.isZero()) throw new CalcError('Modulo by zero');
        return a.sub(b.mul(a.div(b).floor()));
    }
  }
  const x = toNum(a), y = toNum(b);
  switch (op) {
    case '+': return approx(x + y);
    case '-': return approx(x - y);
    case '*': return approx(x * y);
    case '/':
      if (y === 0) throw new CalcError('Division by zero');
      return approx(x / y);
    case '%':
      if (y === 0) throw new CalcError('Modulo by zero');
      return approx(x - y * Math.floor(x / y));
  }
  throw new CalcError(`Unknown operator ${op}`);
}

const neg = (v) => (isQ(v) ? v.neg() : -v);

function factorial(v) {
  const n = wantInt(v, 'Factorial');
  if (n < 0n) throw new CalcError('Factorial of a negative number');
  if (n > BigInt(MAX_FACTORIAL)) throw new CalcError(`Factorial limited to n <= ${MAX_FACTORIAL}`);
  let r = 1n;
  for (let i = 2n; i <= n; i++) r *= i;
  return new Q(r);
}

function perm(nv, kv) {
  const n = wantInt(nv, 'nPr'), k = wantInt(kv, 'nPr');
  if (k < 0n || n < 0n || k > n) return ZERO;
  if (k > BigInt(MAX_FACTORIAL)) throw new CalcError(`nPr limited to k <= ${MAX_FACTORIAL}`);
  let r = 1n;
  for (let i = 0n; i < k; i++) r *= n - i;
  return new Q(r);
}

function binom(nv, kv) {
  const n = wantInt(nv, 'nCr');
  let k = wantInt(kv, 'nCr');
  if (k < 0n || n < 0n || k > n) return ZERO;
  if (n - k < k) k = n - k;
  if (k > BigInt(MAX_FACTORIAL)) throw new CalcError(`nCr limited to min(k, n-k) <= ${MAX_FACTORIAL}`);
  let r = 1n;
  for (let i = 1n; i <= k; i++) r = (r * (n - k + i)) / i;
  return new Q(r);
}

function roundQ(x, digits) {
  const scale = pow(TEN, digits);
  const y = x.mul(scale).abs().add(new Q(1n, 2n)).floor();  // half away from zero
  return (x.n < 0n ? y.neg() : y).div(scale);
}

function round(x, d = ZERO) {
  const digits = wantInt(d, 'round(x, digits)');
  if (isQ(x)) return roundQ(x, new Q(digits));
  const f = 10 ** Number(digits);
  return approx((Math.sign(x) * Math.round(Math.abs(x) * f)) / f);
}

// natural log of a positive BigInt, also beyond the double range (200!, 10^5000)
function lnBig(n) {
  const b = bitLen(n);
  if (b < 1000) return Math.log(Number(n));
  const shift = b - 64;
  return Math.log(Number(n >> BigInt(shift))) + shift * Math.LN2;
}

const sign = (v) => (isQ(v) ? (v.n < 0n ? -1 : v.n > 0n ? 1 : 0) : Math.sign(v));
const lnOf = (v) => (isQ(v) ? lnBig(v.n) - lnBig(v.d) : Math.log(v));

// log with an exact answer when one exists: log(1000) = 3, log(1/8, 2) = -3
function log(x, base) {
  if (sign(x) <= 0) throw new CalcError('Logarithm of a non-positive number');
  if (base !== null && (sign(base) <= 0 || lnOf(base) === 0)) throw new CalcError('Invalid logarithm base');
  const r = base === null ? lnOf(x) : lnOf(x) / lnOf(base);
  if (base !== null && isQ(x) && isQ(base)) {
    const k = Math.round(r);
    if (Math.abs(k) <= 100_000) {
      const back = powExact(base, Q.int(k));
      if (back && back.cmp(x) === 0) return Q.int(k);
    }
  }
  return approx(r);
}

function extreme(sign, args) {
  let best = args[0];
  for (const v of args.slice(1)) {
    const c = isQ(v) && isQ(best) ? v.cmp(best) : Math.sign(toNum(v) - toNum(best));
    if (c * sign > 0) best = v;
  }
  return best;
}

// ---- functions and constants ------------------------------------------------

const FUNCS = {};
function def(names, min, max, fn) {
  for (const name of names.split(' ')) FUNCS[name] = { min, max, fn };
}
const real = (f) => (x) => approx(f(toNum(x)));

def('sqrt', 1, 1, (x) => root(x, 2, Math.sqrt));
def('cbrt', 1, 1, (x) => root(x, 3, Math.cbrt));
def('root', 2, 2, (x, kv) => {
  const k = wantInt(kv, 'root(x, n)');
  if (k < 1n || k > 1000n) throw new CalcError('root(x, n) needs 1 <= n <= 1000');
  return root(x, Number(k), (v) => Math.pow(v, 1 / Number(k)));
});
def('exp', 1, 1, real(Math.exp));
def('ln', 1, 1, (x) => log(x, null));
def('log', 1, 2, (x, b = TEN) => log(x, b));
def('log10', 1, 1, (x) => log(x, TEN));
def('log2', 1, 1, (x) => log(x, Q.int(2)));
for (const f of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh']) {
  def(f, 1, 1, real(Math[f]));
}
def('atan2', 2, 2, (y, x) => approx(Math.atan2(toNum(y), toNum(x))));
def('hypot', 1, Infinity, (...a) => root(a.reduce((s, v) => arith('+', s, arith('*', v, v)), ZERO), 2, Math.sqrt));
def('abs', 1, 1, (x) => (isQ(x) ? x.abs() : Math.abs(x)));
def('sign', 1, 1, (x) => Q.int(Math.sign(toNum(x))));
def('floor', 1, 1, (x) => (isQ(x) ? x.floor() : approx(Math.floor(x))));
def('ceil', 1, 1, (x) => (isQ(x) ? x.neg().floor().neg() : approx(Math.ceil(x))));
def('trunc', 1, 1, (x) => (isQ(x) ? new Q(x.n / x.d) : approx(Math.trunc(x))));
def('round', 1, 2, round);
def('min', 1, Infinity, (...a) => extreme(-1, a));
def('max', 1, Infinity, (...a) => extreme(1, a));
def('mod', 2, 2, (a, b) => arith('%', a, b));
def('gcd', 1, Infinity, (...a) => new Q(a.map((v) => wantInt(v, 'gcd')).reduce(bgcd)));
def('lcm', 1, Infinity, (...a) => new Q(a.map((v) => wantInt(v, 'lcm')).reduce((x, y) => (x && y ? babs(x * y) / bgcd(x, y) : 0n))));
def('fact factorial', 1, 1, factorial);
def('ncr binom choose', 2, 2, binom);
def('npr perm', 2, 2, perm);

const CONSTS = {
  pi: Math.PI,
  tau: 2 * Math.PI,
  e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2,
  deg: Math.PI / 180,
};

// ---- tokenizer and parser ---------------------------------------------------

const TOKEN = /\s*(?:(0x[0-9a-f]+|0b[01]+|0o[0-7]+)|((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)|([a-z_][a-z0-9_]*)|(\*\*|[-+*/^%!(),;=]))/iy;

function parseDecimal(text) {
  const [mant, expPart] = text.toLowerCase().split('e');
  const [int, frac = ''] = mant.split('.');
  const exp = Number(expPart ?? 0) - frac.length;
  if (Math.abs(exp) > 100_000) throw new CalcError(`Exponent too large in ${text}`);
  const digits = BigInt((int || '0') + frac);
  return exp >= 0 ? new Q(digits * 10n ** BigInt(exp)) : new Q(digits, 10n ** BigInt(-exp));
}

function tokenize(src) {
  const s = src
    .replace(/[×·]/g, '*')
    .replace(/÷/g, '/')
    .replace(/[−–]/g, '-')
    .replace(/π/g, ' pi ')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/(\d)_(?=\d)/g, '$1');
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < s.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(s);
    if (!m) {
      if (!s.slice(at).trim()) break;
      const pos = at + (s.slice(at).length - s.slice(at).trimStart().length);
      throw new CalcError(`Unexpected character "${s[pos]}" at position ${pos + 1}`);
    }
    const raw = m[0].trim();
    if (m[1]) tokens.push({ t: 'num', v: new Q(BigInt(m[1].toLowerCase())), raw });
    else if (m[2]) tokens.push({ t: 'num', v: parseDecimal(m[2]), raw });
    else if (m[3]) tokens.push({ t: 'id', v: m[3], raw });
    else tokens.push({ t: 'op', v: m[4] === '**' ? '^' : m[4], raw });
  }
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.i = 0;
    this.vars = {};
  }
  peek() { return this.toks[this.i]; }
  isOp(v) {
    const t = this.peek();
    return t !== undefined && t.t === 'op' && t.v === v;
  }
  expect(v) {
    if (!this.isOp(v)) throw new CalcError(`Expected "${v}" ${this.where()}`);
    this.i++;
  }
  where() {
    const t = this.peek();
    return t ? `near "${t.raw}"` : 'at end of input';
  }

  statement() {
    const [t, t2] = [this.peek(), this.toks[this.i + 1]];
    if (t?.t === 'id' && t2?.t === 'op' && t2.v === '=') {
      const key = t.v.toLowerCase();
      if (FUNCS[key] || key in CONSTS) throw new CalcError(`"${t.v}" is a built-in name and cannot be assigned`);
      this.i += 2;
      const value = this.expr();
      this.vars[t.v] = value;
      return { name: t.v, value };
    }
    return { name: null, value: this.expr() };
  }

  expr() {
    let v = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.toks[this.i++].v;
      v = arith(op, v, this.term());
    }
    return v;
  }

  term() {
    let v = this.unary();
    for (;;) {
      if (this.isOp('%')) {
        // "7 % 3" is modulo; "50%" or "50% + 2" (no operand follows) is percent
        const next = this.toks[this.i + 1];
        if (!next || (next.t === 'op' && next.v !== '(')) {
          this.i++;
          v = arith('/', v, Q.int(100));
          continue;
        }
      }
      if (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
        const op = this.toks[this.i++].v;
        v = arith(op, v, this.unary());
      } else if (this.peek()?.t === 'id' || this.isOp('(')) {
        v = arith('*', v, this.power());  // implicit: 2pi, 3(4+1)
      } else {
        return v;
      }
    }
  }

  unary() {
    if (this.isOp('-')) {
      this.i++;
      return neg(this.unary());
    }
    if (this.isOp('+')) {
      this.i++;
      return this.unary();
    }
    return this.power();
  }

  power() {
    const base = this.postfix();
    if (this.isOp('^')) {
      this.i++;
      return arith('^', base, this.unary());  // right-associative, allows 2^-1
    }
    return base;
  }

  postfix() {
    let v = this.primary();
    while (this.isOp('!')) {
      this.i++;
      v = factorial(v);
    }
    return v;
  }

  primary() {
    const t = this.toks[this.i++];
    if (!t) throw new CalcError('Unexpected end of expression');
    if (t.t === 'num') return t.v;
    if (t.t === 'op' && t.v === '(') {
      const v = this.expr();
      this.expect(')');
      return v;
    }
    if (t.t === 'id') {
      const key = t.v.toLowerCase();
      if (FUNCS[key] && this.isOp('(')) {
        this.i++;
        const args = [];
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.expr());
            if (!this.isOp(',')) break;
            this.i++;
          }
        }
        this.expect(')');
        const f = FUNCS[key];
        if (args.length < f.min || args.length > f.max) {
          const want = f.min === f.max ? f.min : f.max === Infinity ? `at least ${f.min}` : `${f.min}-${f.max}`;
          throw new CalcError(`${t.v}() takes ${want} argument(s), got ${args.length}`);
        }
        return f.fn(...args);
      }
      if (Object.hasOwn(this.vars, t.v)) return this.vars[t.v];
      if (Object.hasOwn(CONSTS, key)) return CONSTS[key];
      if (FUNCS[key]) throw new CalcError(`${t.v} is a function, write ${t.v}(...)`);
      throw new CalcError(`Unknown name "${t.v}"`);
    }
    throw new CalcError(`Unexpected "${t.raw}"`);
  }
}

// ---- formatting -------------------------------------------------------------

// floor(log10(|q|)) for q != 0
function log10Floor(q) {
  const n = babs(q.n), d = q.d;
  const e = n.toString().length - d.toString().length;
  const p = 10n ** BigInt(Math.abs(e));
  const atLeast = e >= 0 ? n >= d * p : n * p >= d;
  return atLeast ? e : e - 1;
}

// q rounded to `sig` significant digits, positional or scientific
function toSig(q, sig) {
  if (q.isZero()) return '0';
  let e = log10Floor(q);
  const scale = sig - 1 - e;
  const n = babs(q.n);
  const num = scale >= 0 ? n * 10n ** BigInt(scale) : n;
  const den = scale >= 0 ? q.d : q.d * 10n ** BigInt(-scale);
  let s = ((2n * num + den) / (2n * den)).toString();
  if (s.length > sig) {  // rounding carried: 9.99 -> 10.0
    e += 1;
    s = s.slice(0, sig);
  }
  let out;
  if (e >= sig || e < -7) {
    const frac = s.slice(1).replace(/0+$/, '');
    out = `${s[0]}${frac ? '.' + frac : ''}e${e >= 0 ? '+' : ''}${e}`;
  } else if (e >= 0) {
    const frac = s.slice(e + 1).replace(/0+$/, '');
    out = s.slice(0, e + 1) + (frac ? '.' + frac : '');
  } else {
    out = '0.' + '0'.repeat(-e - 1) + s.replace(/0+$/, '');
  }
  return (q.n < 0n ? '-' : '') + out;
}

// exact decimal string if the denominator is 2^a * 5^b, else null
function terminatingDecimal(q) {
  let d = q.d, a = 0, b = 0;
  while (d % 2n === 0n) { d /= 2n; a++; }
  while (d % 5n === 0n) { d /= 5n; b++; }
  if (d !== 1n) return null;
  const k = Math.max(a, b);
  const s = ((babs(q.n) * 10n ** BigInt(k)) / q.d).toString().padStart(k + 1, '0');
  return (q.n < 0n ? '-' : '') + s.slice(0, -k) + '.' + s.slice(-k);
}

// "0.1(6)" style notation for repeating decimals with a short period
function repeatingDecimal(q, limit = 2000) {
  const n = babs(q.n);
  let r = n % q.d, digits = '';
  const seen = new Map();
  while (digits.length < limit) {
    if (seen.has(r)) {
      const i = seen.get(r), period = digits.length - i;
      if (period > 60) return { period };
      const sign = q.n < 0n ? '-' : '';
      return { period, text: `${sign}${n / q.d}.${digits.slice(0, i)}(${digits.slice(i)})` };
    }
    seen.set(r, digits.length);
    r *= 10n;
    digits += (r / q.d).toString();
    r %= q.d;
  }
  return null;
}

function shortForm(v, sig) {
  if (!isQ(v)) return `≈ ${v}`;
  const s = v.isInt() ? v.n.toString() : `${v.n}/${v.d}`;
  return s.length <= 60 ? s : `≈ ${toSig(v, sig)}`;
}

function describe(v, sig) {
  if (!isQ(v)) return [`≈ ${v}`, 'approximate (floating point, ~16 significant digits)'];
  if (v.isInt()) {
    const s = v.n.toString(), len = s.replace('-', '').length;
    if (len <= MAX_PRINT) return [`= ${s}`, len > 15 ? `exact integer (${len} digits)` : 'exact'];
    return [`= ${s.slice(0, 50)}…${s.slice(-10)}`, `≈ ${toSig(v, sig)}`, `exact integer with ${len} digits (too long to print in full)`];
  }
  const fraction = `${v.n}/${v.d}`;
  const dec = terminatingDecimal(v);
  if (dec && dec.length <= MAX_PRINT) return [`= ${dec}`, `= ${fraction}`, 'exact'];
  const lines = [fraction.length <= MAX_PRINT ? `= ${fraction}` : `= (fraction, ${fraction.length} characters)`, `≈ ${toSig(v, sig)}`];
  const rep = dec ? null : repeatingDecimal(v);
  if (rep?.text) lines.push(`repeating decimal: ${rep.text}`);
  else if (rep) lines.push(`repeating decimal with period ${rep.period}`);
  lines.push('exact rational (decimal shown rounded)');
  return lines;
}

// all statements of a program, in order: [{ name, value }]
function run(expression) {
  return execute(tokenize(String(expression ?? '')));
}

function execute(tokens, vars = {}) {
  const p = new Parser(tokens);
  Object.assign(p.vars, vars);
  const statements = [];
  while (p.peek()) {
    if (p.isOp(';')) {
      p.i++;
      continue;
    }
    const st = p.statement();
    p.vars.ans = st.value;
    statements.push(st);
    if (p.peek() && !p.isOp(';')) throw new CalcError(`Unexpected "${p.peek().raw}"`);
  }
  if (!statements.length) throw new CalcError('Empty expression');
  return statements;
}

/** Value of an expression: a Q when exact, a number otherwise. */
export function evaluate(expression) {
  if (typeof expression === 'number') {
    if (!Number.isFinite(expression)) throw new CalcError('Not a finite number');
    return parseDecimal(String(expression).replace('+', ''));
  }
  return run(expression).at(-1).value;
}

/** Function or constant names that cannot be used as variables. */
export function isReserved(name) {
  const key = String(name).toLowerCase();
  return Boolean(FUNCS[key]) || Object.hasOwn(CONSTS, key) || key === 'ans';
}

/** Variable names an expression reads without assigning them, in order of appearance. */
export function freeNames(expression) {
  const tokens = tokenize(String(expression ?? ''));
  const names = [], assigned = new Set();
  tokens.forEach((t, i) => {
    if (t.t !== 'id') return;
    const next = tokens[i + 1];
    if (next?.t === 'op' && next.v === '=') assigned.add(t.v);
    else if (!(next?.t === 'op' && next.v === '(' && FUNCS[t.v.toLowerCase()]) && !isReserved(t.v) && !assigned.has(t.v) && !names.includes(t.v)) names.push(t.v);
  });
  return names;
}

/**
 * Parse once, evaluate often: returns vars => value. Q variables keep the
 * arithmetic exact; plain JS numbers switch it to fast floating point.
 */
export function compile(expression) {
  const tokens = tokenize(String(expression ?? ''));
  return (vars = {}) => execute(tokens, vars).at(-1).value;
}

export { toSig, terminatingDecimal };

/** Compact number text for other tools: { text, exact }. */
export function plainNumber(v, sig = 12) {
  if (!isQ(v)) return { text: fmtFloat(v, sig), exact: false };
  if (v.isInt()) {
    const s = v.n.toString();
    return s.length <= 40 ? { text: s, exact: true } : { text: toSig(v, sig), exact: false };
  }
  const dec = terminatingDecimal(v);
  if (dec && dec.replace(/^-?0\.0*/, '').length <= sig + 4) return { text: dec, exact: true };
  return { text: toSig(v, sig), exact: false, fraction: `${v.n}/${v.d}`.length <= 30 ? `${v.n}/${v.d}` : null };
}

function fmtFloat(x, sig) {
  return String(Number(x.toPrecision(Math.min(sig, 17))));
}

/** Evaluate `expression` and return a human/Claude-readable result. */
export function calculate(expression, digits = 30) {
  const sig = Math.min(Math.max(Math.trunc(digits) || 30, 1), MAX_SIG_DIGITS);
  const statements = run(expression);
  const last = statements.at(-1);
  const out = statements.slice(0, -1).map((s) => (s.name ? `${s.name} = ${shortForm(s.value, sig)}` : shortForm(s.value, sig)));
  if (last.name) out.push(`${last.name}:`);
  return [...out, ...describe(last.value, sig)].join('\n');
}
