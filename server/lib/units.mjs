// Unit conversion with exact rational factors (1 mi = 1609.344 m exactly),
// compound units (km/h, kg*m^2/s^2, L/100km), SI and binary prefixes,
// absolute temperatures, and ECB currency rates.

import { Q, arith, evaluate, plainNumber } from './calc.mjs';
import { ToolError, fetchJson } from './util.mjs';

const BASE = ['m', 'kg', 's', 'K', 'A', 'mol', 'cd', 'bit', 'rad'];
const ONE = Q.int(1);
const zero = () => new Array(BASE.length).fill(0);

// [aliases, factor, definition, flags]   flags: p = SI prefixes, b = binary prefixes too
// factor is a decimal/fraction string (exact) or a number (irrational, approximate)
const TABLE = [
  // length
  ['m meter metre meters metres', '1', 'm', 'p'],
  ['in inch inches', '0.0254', 'm'],
  ['ft foot feet', '12', 'in'],
  ['yd yard yards', '3', 'ft'],
  ['mi mile miles', '5280', 'ft'],
  ['nmi NM nautical_mile nautical_miles', '1852', 'm'],
  ['au AU astronomical_unit', '149597870700', 'm'],
  ['ly lightyear lightyears light_year light_years', '9460730472580800', 'm'],
  ['pc parsec parsecs', 648000 / Math.PI, 'au', 'p'],
  ['Å angstrom', '1e-10', 'm'],
  ['mil thou', '0.001', 'in'],
  ['hand hands', '4', 'in'],
  ['chain chains', '66', 'ft'],
  ['furlong furlongs', '660', 'ft'],
  ['league leagues', '3', 'mi'],
  ['pica', '1/6', 'in'],
  ['pt_typo point_typo', '1/72', 'in'],
  // mass
  ['kg kilogram kilograms', '1', 'kg'],
  ['g gram grams gramme', '0.001', 'kg', 'p'],
  ['t tonne tonnes metric_ton', '1000', 'kg', 'p'],
  ['lb lbs pound pounds', '0.45359237', 'kg'],
  ['oz ounce ounces', '1/16', 'lb'],
  ['st stone stones', '14', 'lb'],
  ['ton short_ton tons', '2000', 'lb'],
  ['long_ton', '2240', 'lb'],
  ['ct carat carats', '0.2', 'g'],
  ['gr grain grains', '64.79891', 'mg'],
  ['Da u dalton', '1.66053906892e-27', 'kg', 'p'],
  // time
  ['s sec second seconds', '1', 's', 'p'],
  ['min minute minutes', '60', 's'],
  ['h hr hour hours', '60', 'min'],
  ['d day days', '24', 'h'],
  ['wk week weeks', '7', 'd'],
  ['yr year years a', '365.25', 'd'],
  ['month months', '1/12', 'yr'],
  ['fortnight', '14', 'd'],
  // temperature (offsets in K are added for absolute conversions)
  ['K kelvin', '1', 'K', 'p'],
  ['degC celsius °C ℃', '1', 'K'],
  ['degF fahrenheit °F ℉', '5/9', 'K'],
  ['degR rankine °R', '5/9', 'K'],
  // area and volume
  ['ha hectare hectares', '10000', 'm^2'],
  ['are', '100', 'm^2'],
  ['acre acres ac', '4046.8564224', 'm^2'],
  ['L l liter litre liters litres', '0.001', 'm^3', 'p'],
  ['cc', '1', 'cm^3'],
  ['gal gallon gallons us_gal', '3.785411784', 'L'],
  ['qt quart quarts', '1/4', 'gal'],
  ['pt pint pints', '1/2', 'qt'],
  ['cup cups', '1/2', 'pt'],
  ['floz fl_oz fluid_ounce fluid_ounces', '1/8', 'cup'],
  ['tbsp tablespoon tablespoons', '1/2', 'floz'],
  ['tsp teaspoon teaspoons', '1/3', 'tbsp'],
  ['imp_gal uk_gal imperial_gallon', '4.54609', 'L'],
  ['imp_pt uk_pint imperial_pint', '1/8', 'imp_gal'],
  ['imp_floz uk_floz', '1/20', 'imp_pt'],
  ['bbl barrel barrels', '42', 'gal'],
  // speed and acceleration
  ['kn kt knot knots', '1', 'nmi/h'],
  ['mph', '1', 'mi/h'],
  ['kph kmh', '1', 'km/h'],
  ['c speed_of_light', '299792458', 'm/s'],
  ['g0 gee', '9.80665', 'm/s^2'],
  // force, energy, power, pressure
  ['N newton newtons', '1', 'kg*m/s^2', 'p'],
  ['lbf pound_force', '1', 'lb*g0'],
  ['kgf kilogram_force kp', '1', 'kg*g0'],
  ['dyn dyne', '1e-5', 'N'],
  ['Nm newton_metre newton_meter', '1', 'N*m'],
  ['J joule joules', '1', 'N*m', 'p'],
  ['cal calorie calories', '4.184', 'J', 'p'],
  ['Cal kcal_food', '1', 'kcal'],
  ['Wh', '3600', 'J', 'p'],
  ['eV electronvolt', '1.602176634e-19', 'J', 'p'],
  ['BTU btu', '1055.05585262', 'J'],
  ['erg', '1e-7', 'J'],
  ['thm therm', '100000', 'BTU'],
  ['W watt watts', '1', 'J/s', 'p'],
  ['hp horsepower', '745.69987158227022', 'W'],
  ['PS metric_horsepower', '735.49875', 'W'],
  ['Pa pascal pascals', '1', 'N/m^2', 'p'],
  ['bar', '100000', 'Pa', 'p'],
  ['atm atmosphere', '101325', 'Pa'],
  ['psi', '1', 'lbf/in^2'],
  ['mmHg', '133.322387415', 'Pa'],
  ['torr Torr', '1/760', 'atm'],
  ['inHg', '3386.389', 'Pa'],
  // electricity, frequency, amount, light
  ['A amp amps ampere amperes', '1', 'A', 'p'],
  ['C coulomb coulombs', '1', 'A*s', 'p'],
  ['V volt volts', '1', 'W/A', 'p'],
  ['ohm ohms Ω', '1', 'V/A', 'p'],
  ['F farad farads', '1', 'C/V', 'p'],
  ['Ah', '1', 'A*h', 'p'],
  ['Hz hertz', '1', '1/s', 'p'],
  ['rpm', '1', '1/min'],
  ['bpm', '1', '1/min'],
  ['mol mole moles', '1', 'mol', 'p'],
  ['cd candela', '1', 'cd', 'p'],
  // data
  ['bit bits', '1', 'bit', 'pb'],
  ['B byte bytes', '8', 'bit', 'pb'],
  ['bps', '1', 'bit/s', 'p'],
  // angle
  ['rad radian radians', '1', 'rad', 'p'],
  ['deg degree degrees °', Math.PI / 180, 'rad'],
  ['arcmin', '1/60', 'deg'],
  ['arcsec', '1/60', 'arcmin', 'p'],
  ['grad gon', '9/10', 'deg'],
  ['turn turns rev revolution revolutions', 2 * Math.PI, 'rad'],
  ['sr steradian', '1', 'rad^2'],
];

const OFFSETS = { K: '0', degC: '273.15', degF: '45967/180', degR: '0' };  // K at zero of the scale

const PREFIXES = {
  Q: 30, R: 27, Y: 24, Z: 21, E: 18, P: 15, T: 12, G: 9, M: 6, k: 3, h: 2, da: 1,
  d: -1, c: -2, m: -3, u: -6, µ: -6, μ: -6, n: -9, p: -12, f: -15, a: -18, z: -21, y: -24, r: -27, q: -30,
};
const LONG_PREFIXES = {
  quetta: 30, ronna: 27, yotta: 24, zetta: 21, exa: 18, peta: 15, tera: 12, giga: 9, mega: 6, kilo: 3, hecto: 2, deca: 1, deka: 1,
  deci: -1, centi: -2, milli: -3, micro: -6, nano: -9, pico: -12, femto: -15, atto: -18, zepto: -21, yocto: -24,
};
const BINARY = { Ki: 10, Mi: 20, Gi: 30, Ti: 40, Pi: 50, Ei: 60, Zi: 70, Yi: 80 };

const DIM_NAMES = {
  'm': 'length', 'kg': 'mass', 's': 'time', 'K': 'temperature', 'A': 'electric current', 'mol': 'amount', 'cd': 'luminous intensity',
  'bit': 'information', 'rad': 'angle', 'm^2': 'area', 'm^3': 'volume', 'm/s': 'speed', 'm/s^2': 'acceleration',
  'm*kg/s^2': 'force', 'm^2*kg/s^2': 'energy or torque', 'm^2*kg/s^3': 'power', 'kg/(m*s^2)': 'pressure', '1/s': 'frequency',
  'bit/s': 'data rate', 'kg/m^3': 'density', 's*A': 'charge', 'm^2*kg/(s^3*A)': 'voltage', 'm^2*kg/(s^3*A^2)': 'resistance',
  '1/m^2': 'inverse area', 'm^3/s': 'volume flow', 'kg/s': 'mass flow', 'rad^2': 'solid angle', 'm^2*kg/s': 'angular momentum',
};

// ---- unit records -------------------------------------------------------------

const registry = new Map();  // alias -> { factor, def, flags, name }
for (const [aliases, factor, def, flags = ''] of TABLE) {
  const names = aliases.split(' ');
  for (const alias of names) registry.set(alias, { factor, def, flags, name: names[0] });
}
const lowerIndex = new Map();
for (const alias of registry.keys()) {
  const key = alias.toLowerCase();
  lowerIndex.set(key, lowerIndex.has(key) ? null : alias);  // null = ambiguous (e.g. mm vs Mm)
}

const resolved = new Map();
function resolveDefinition(alias) {
  if (resolved.has(alias)) return resolved.get(alias);
  const entry = registry.get(alias);
  const factor = typeof entry.factor === 'number' ? entry.factor : evaluate(entry.factor);
  let unit;
  if (BASE.includes(alias) && entry.def === alias) {
    unit = { f: ONE, dim: zero() };
    unit.dim[BASE.indexOf(alias)] = 1;
  } else {
    const inner = parseUnit(entry.def, true);
    unit = { f: arith('*', factor, inner.f), dim: inner.dim };
  }
  unit.name = entry.name;
  if (OFFSETS[entry.name] !== undefined) unit.offset = evaluate(OFFSETS[entry.name]);
  resolved.set(alias, unit);
  return unit;
}

function scaled(unit, power10, power2 = 0) {
  let f = unit.f;
  if (power10) f = arith('*', f, arith('^', Q.int(10), Q.int(power10)));
  if (power2) f = arith('*', f, arith('^', Q.int(2), Q.int(power2)));
  return { f, dim: unit.dim };
}

/** Find a single unit name, with prefixes, plurals and case fallback. */
function lookup(name, loose = false) {
  if (/^K(B|bit|bps)$/.test(name)) name = 'k' + name.slice(1);  // KB is common for kB
  const unitAfterPrefix = (rest) => (registry.has(rest) ? rest : loose ? lowerIndex.get(rest.toLowerCase()) : undefined);
  const tries = [name];
  if (name.length > 3 && name.endsWith('es')) tries.push(name.slice(0, -2));
  if (name.length > 2 && name.endsWith('s')) tries.push(name.slice(0, -1));
  for (const n of tries) {
    if (registry.has(n)) return resolveDefinition(n);
    for (const [p, e] of Object.entries(LONG_PREFIXES)) {
      if (n.toLowerCase().startsWith(p) && n.length > p.length) {
        const rest = n.slice(p.length);
        const alias = registry.has(rest) ? rest : lowerIndex.get(rest.toLowerCase());
        if (alias && registry.get(alias).flags.includes('p')) return scaled(resolveDefinition(alias), e);
      }
    }
    for (const [p, e] of Object.entries(BINARY)) {
      const rest = n.slice(p.length);
      if (n.startsWith(p) && registry.has(rest) && registry.get(rest).flags.includes('b')) return scaled(resolveDefinition(rest), 0, e);
    }
    for (const [p, e] of Object.entries(PREFIXES)) {
      const rest = n.startsWith(p) && n.length > p.length ? unitAfterPrefix(n.slice(p.length)) : undefined;
      if (rest && registry.get(rest).flags.includes('p')) return scaled(resolveDefinition(rest), e);
    }
  }
  for (const n of tries) {
    const alias = lowerIndex.get(n.toLowerCase());
    if (alias) return resolveDefinition(alias);
  }
  // all-caps input like KM or KWH: retry lowercase, which then resolves prefixes
  if (!loose && name.length > 1 && name === name.toUpperCase() && name !== name.toLowerCase()) return lookup(name.toLowerCase(), true);
  return null;
}

// ---- unit expression parser ---------------------------------------------------

function normalize(text) {
  return text
    .replace(/°\s*C\b|℃/g, 'degC')
    .replace(/°\s*F\b|℉/g, 'degF')
    .replace(/°\s*R\b/g, 'degR')
    .replace(/°/g, 'deg')
    .replace(/Ω/g, 'ohm')
    .replace(/[µμ](?=[A-Za-z])/g, 'u')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/[·×⋅]/g, '*')
    .replace(/\bper\b/gi, '/')
    .replace(/\b(?:sq|square)\s+([A-Za-z_]+)/gi, '$1^2')
    .replace(/\b(?:cu|cubic)\s+([A-Za-z_]+)/gi, '$1^3')
    .trim();
}

const UNIT_TOKEN = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([A-Za-z_Å][A-Za-z_]*\d?)|(\^|\*\*|[-*/()]))/y;

function tokenizeUnit(text) {
  const tokens = [];
  UNIT_TOKEN.lastIndex = 0;
  while (UNIT_TOKEN.lastIndex < text.length) {
    const at = UNIT_TOKEN.lastIndex;
    const m = UNIT_TOKEN.exec(text);
    if (!m) {
      if (!text.slice(at).trim()) break;
      throw new ToolError(`Unexpected "${text.slice(at).trim()[0]}" in unit "${text}"`);
    }
    if (m[1]) tokens.push({ t: 'num', v: m[1] });
    else if (m[2]) tokens.push({ t: 'id', v: m[2] });
    else tokens.push({ t: 'op', v: m[3] === '**' ? '^' : m[3] });
  }
  return tokens;
}

const mulUnit = (a, b, sign = 1) => ({
  f: sign > 0 ? arith('*', a.f, b.f) : arith('/', a.f, b.f),
  dim: a.dim.map((x, i) => x + sign * b.dim[i]),
});

/** Parse "km/h", "kg*m^2/s^2", "L/100km", "N m". Returns { f, dim, offset?, single }. */
export function parseUnit(text, internal = false) {
  const src = internal ? text : normalize(String(text ?? ''));
  if (!src) throw new ToolError('Empty unit');
  const toks = tokenizeUnit(src);
  let i = 0;
  const peekOp = (v) => toks[i]?.t === 'op' && toks[i].v === v;

  function exponent() {
    if (!peekOp('^')) return 1;
    i++;
    const paren = peekOp('(');
    if (paren) i++;
    const sign = peekOp('-') ? (i++, -1) : 1;
    const t = toks[i++];
    if (!t || t.t !== 'num' || !/^\d+$/.test(t.v)) throw new ToolError(`Expected an integer exponent in "${src}"`);
    if (paren) {
      if (!peekOp(')')) throw new ToolError(`Missing ")" in "${src}"`);
      i++;
    }
    return sign * Number(t.v);
  }

  function power(u, e) {
    if (e === 1) return u;
    return { f: arith('^', u.f, Q.int(e)), dim: u.dim.map((x) => x * e) };
  }

  function factor() {
    const t = toks[i++];
    if (!t) throw new ToolError(`Unit "${src}" ends unexpectedly`);
    if (t.t === 'op' && t.v === '(') {
      const u = product();
      if (!peekOp(')')) throw new ToolError(`Missing ")" in "${src}"`);
      i++;
      return power(u, exponent());
    }
    if (t.t === 'num') {
      const n = { f: evaluate(t.v), dim: zero() };
      // a number glued to a unit binds tightly: L/100km
      if (toks[i]?.t === 'id') return mulUnit(n, factor());
      return n;
    }
    if (t.t === 'id') {
      let name = t.v, glued = 1;
      const m = /^(.*?[A-Za-z_])(\d)$/.exec(name);
      if (!lookup(name) && m && lookup(m[1])) {
        name = m[1];
        glued = Number(m[2]);
      }
      const u = lookup(name);
      if (!u) throw new ToolError(`Unknown unit "${t.v}"${suggest(t.v)}`);
      return power({ ...u, name: name }, glued * exponent());
    }
    throw new ToolError(`Unexpected "${t.v}" in unit "${src}"`);
  }

  function product() {
    let u = factor();  // a lone unit keeps its temperature offset; products are deltas
    for (;;) {
      if (peekOp('*')) {
        i++;
        u = mulUnit(u, factor());
      } else if (peekOp('/')) {
        i++;
        u = mulUnit(u, factor(), -1);
      } else if (toks[i] && (toks[i].t === 'id' || toks[i].t === 'num' || peekOp('('))) {
        u = mulUnit(u, factor());  // "N m"
      } else {
        return u;
      }
    }
  }

  const unit = product();
  if (i < toks.length) throw new ToolError(`Unexpected "${toks[i].v}" in unit "${src}"`);
  return unit;
}

function suggest(name) {
  const lower = name.toLowerCase();
  const near = [...registry.keys()].filter((a) => a.length > 2 && a.toLowerCase().startsWith(lower.slice(0, 3))).slice(0, 4);
  return near.length ? `; did you mean ${near.join(', ')}?` : '';
}

const tempHint = (...names) =>
  names.some((n) => ['C', 'F'].includes(String(n).trim())) ? ' For temperatures write degC / degF (C is coulomb, F is farad).' : '';

export function dimText(dim) {
  const num = [], den = [];
  dim.forEach((e, i) => {
    if (e > 0) num.push(e === 1 ? BASE[i] : `${BASE[i]}^${e}`);
    if (e < 0) den.push(e === -1 ? BASE[i] : `${BASE[i]}^${-e}`);
  });
  if (!num.length && !den.length) return '1';
  const top = num.length ? num.join('*') : '1';
  if (!den.length) return top;
  return `${top}/${den.length > 1 ? `(${den.join('*')})` : den[0]}`;
}

function dimName(dim) {
  const text = dimText(dim);
  return DIM_NAMES[text] ?? text;
}

const dimLabel = (dim) => (DIM_NAMES[dimText(dim)] ? `${DIM_NAMES[dimText(dim)]}: ${dimText(dim)}` : dimText(dim));

const sameDim = (a, b) => a.every((x, i) => x === b[i]);
const inverseDim = (a, b) => a.every((x, i) => x === -b[i]) && a.some((x) => x !== 0);

// ---- conversion ---------------------------------------------------------------

function show(v, sig) {
  const p = plainNumber(v, sig);
  // a fraction only helps while it is short: 340/9 yes, 18677382000000/1270920461503 no
  return { text: p.text, exact: p.exact, fraction: p.fraction && p.fraction.length <= 12 ? p.fraction : null };
}

export function convertValue(value, fromText, toText, { difference = false } = {}) {
  const a = parseUnit(fromText), b = parseUnit(toText);
  const shifted = (u) => u.offset !== undefined && !(u.offset instanceof Q && u.offset.isZero());
  if (sameDim(a.dim, b.dim)) {
    if (!difference && (shifted(a) || shifted(b))) {
      if (a.offset === undefined || b.offset === undefined) {
        throw new ToolError('Absolute temperatures convert only between plain K, degC, degF, degR. For temperature differences set difference: true.');
      }
      const kelvin = arith('+', arith('*', value, a.f), a.offset);
      if ((kelvin instanceof Q ? kelvin.toNumber() : kelvin) < 0) throw new ToolError(`${fromText} value is below absolute zero`);
      return { value: arith('/', arith('-', kelvin, b.offset), b.f), kind: 'temperature' };
    }
    return { value: arith('/', arith('*', value, a.f), b.f), kind: dimName(a.dim) };
  }
  if (inverseDim(a.dim, b.dim)) {
    const base = arith('*', value, a.f);
    return { value: arith('/', arith('/', Q.int(1), base), b.f), kind: `${dimName(a.dim)} -> ${dimName(b.dim)}`, inverse: true };
  }
  throw new ToolError(
    `Cannot convert ${fromText} (${dimLabel(a.dim)}) to ${toText} (${dimLabel(b.dim)}).${tempHint(fromText, toText)}`,
  );
}

// ---- currency -----------------------------------------------------------------

const rateCache = new Map();  // url -> { at, data }
// EUR, usd, Chf; but never a 3-letter unit (cup, bar, gal, mph, ...)
const isCurrency = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z]{3}$/.test(s.trim())) return false;
  return !lookup(s.trim());
};

async function convertCurrency(amount, from, targets, date, signal) {
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ToolError('date must be YYYY-MM-DD');
  const url = `https://api.frankfurter.dev/v1/${date || 'latest'}?base=${from}&symbols=${targets.join(',')}`;
  let cached = rateCache.get(url);
  if (!cached || Date.now() - cached.at > 3_600_000) {
    let data;
    try {
      data = await fetchJson(url, { signal });
    } catch (err) {
      if (err.status === 404 || err.status === 422) {
        throw new ToolError(`Unknown currency in ${from} -> ${targets.join(', ')}. ECB reference rates cover about 30 major currencies (EUR, USD, GBP, CHF, JPY, CNY, ...).`);
      }
      throw err;
    }
    cached = { at: Date.now(), data };
    rateCache.set(url, cached);
  }
  const { rates, date: rateDate } = cached.data;
  const lines = targets.map((t) => {
    const rate = rates[t];
    if (rate === undefined) return `${t}: no rate available`;
    const result = amount * rate;
    return `${amount} ${from} = ${fmtMoney(result)} ${t}   (1 ${from} = ${rate} ${t})`;
  });
  lines.push(`ECB reference rates for ${rateDate}${date && date !== rateDate ? ` (closest working day to ${date})` : ''}, via frankfurter.dev. Not a live trading rate.`);
  return lines.join('\n');
}

function fmtMoney(x) {
  const abs = Math.abs(x);
  if (abs >= 1) return x.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  return String(Number(x.toPrecision(6)));
}

// ---- tool entry ---------------------------------------------------------------

export async function convertUnits({ value = 1, from, to, digits = 12, difference = false, date } = {}, ctx = {}) {
  if (!from) throw new ToolError('from is required');
  const targets = to === undefined || to === null ? [] : Array.isArray(to) ? to : [to];
  if (isCurrency(from)) {
    if (!targets.length || !targets.every(isCurrency)) throw new ToolError('Currency conversion needs 3-letter codes in to, e.g. ["USD", "CHF"]');
    const amount = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
    if (!Number.isFinite(amount)) throw new ToolError('Currency amount must be a number');
    return convertCurrency(amount, from.trim().toUpperCase(), targets.map((t) => t.trim().toUpperCase()), date, ctx.signal);
  }
  const raw = typeof value === 'number' ? value : String(value).trim().replace(/^(-?\d+),(\d+)$/, '$1.$2');  // "1,5" = 1.5
  const v = evaluate(raw);
  const valueText = show(v, digits).text;
  if (!targets.length) {
    const a = parseUnit(from);
    const base = arith('*', v, a.f);
    const lines = [`${valueText} ${from} = ${show(base, digits).text} ${dimText(a.dim)}   (SI base units, ${dimName(a.dim)})`];
    if (a.offset !== undefined && !difference) {
      lines.push('Note: for absolute temperatures give a target unit, e.g. to: "degC"');
    }
    return lines.join('\n');
  }
  const lines = targets.map((t) => {
    const r = convertValue(v, from, t, { difference });
    const s = show(r.value, digits);
    const tags = [s.exact ? 'exact' : 'rounded'];
    if (s.fraction) tags.push(`= ${s.fraction}`);
    if (r.inverse) tags.push('reciprocal conversion');
    return `${valueText} ${from} = ${s.text} ${t}   (${tags.join(', ')}; ${r.kind})`;
  });
  return lines.join('\n');
}
