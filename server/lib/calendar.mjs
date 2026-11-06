// Calendars: public holidays (built-in rules for common countries, Nager.Date
// for the rest), business days that respect them, cron schedules, and month
// views with ISO weeks and "3rd Monday of May" style lookups.

import { ToolError, fetchJson, fmtNum } from './util.mjs';
import { LOCAL_TZ, resolveZone, wallOf, instantOf, utc, wallText, isoWeek, parseMoment } from './time.mjs';

const DAY = 86_400_000;
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (y, m, d) => utc(y, m - 1, d);

// ---- holiday rules ------------------------------------------------------------

function easter(y) {  // anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return dayMs(y, month, day);
}

// n-th weekday (0 = Sunday) of a month; n = -1 for the last one
function nthWeekday(y, m, wd, n) {
  if (n > 0) {
    const first = dayMs(y, m, 1);
    const shift = (wd - new Date(first).getUTCDay() + 7) % 7;
    const r = first + (shift + 7 * (n - 1)) * DAY;
    return new Date(r).getUTCMonth() === m - 1 ? r : null;
  }
  const last = dayMs(y, m + 1, 0);
  const shift = (new Date(last).getUTCDay() - wd + 7) % 7;
  return last - (shift - 7 * (n + 1)) * DAY;
}

const DE_STATES = {
  BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen', HH: 'Hamburg', HE: 'Hessen', MV: 'Mecklenburg-Vorpommern',
  NI: 'Niedersachsen', NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz', SL: 'Saarland', SN: 'Sachsen', ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thüringen',
};

function rulesDE(y) {
  const E = easter(y), d = (m, dd) => dayMs(y, m, dd);
  const bussUndBettag = d(11, 22) - (((new Date(d(11, 22)).getUTCDay() - 3 + 7) % 7) || 7) * DAY;
  return [
    [d(1, 1), 'Neujahr'],
    [d(1, 6), 'Heilige Drei Könige', ['BW', 'BY', 'ST']],
    ...(y >= 2019 ? [[d(3, 8), 'Internationaler Frauentag', y >= 2023 ? ['BE', 'MV'] : ['BE']]] : []),
    [E - 2 * DAY, 'Karfreitag'],
    [E, 'Ostersonntag', ['BB']],
    [E + DAY, 'Ostermontag'],
    [d(5, 1), 'Tag der Arbeit'],
    [E + 39 * DAY, 'Christi Himmelfahrt'],
    [E + 49 * DAY, 'Pfingstsonntag', ['BB']],
    [E + 50 * DAY, 'Pfingstmontag'],
    [E + 60 * DAY, 'Fronleichnam', ['BW', 'BY', 'HE', 'NW', 'RP', 'SL'], 'also some communities in SN and TH'],
    [d(8, 15), 'Mariä Himmelfahrt', ['SL'], 'also in Bavarian communities with a Catholic majority'],
    ...(y >= 2019 ? [[d(9, 20), 'Weltkindertag', ['TH']]] : []),
    [d(10, 3), 'Tag der Deutschen Einheit'],
    [d(10, 31), 'Reformationstag', y >= 2018 ? ['BB', 'MV', 'SN', 'ST', 'TH', 'HB', 'HH', 'NI', 'SH'] : ['BB', 'MV', 'SN', 'ST', 'TH']],
    [d(11, 1), 'Allerheiligen', ['BW', 'BY', 'NW', 'RP', 'SL']],
    [bussUndBettag, 'Buß- und Bettag', ['SN']],
    [d(12, 25), '1. Weihnachtstag'],
    [d(12, 26), '2. Weihnachtstag'],
  ];
}

function rulesAT(y) {
  const E = easter(y), d = (m, dd) => dayMs(y, m, dd);
  return [[d(1, 1), 'Neujahr'], [d(1, 6), 'Heilige Drei Könige'], [E + DAY, 'Ostermontag'], [d(5, 1), 'Staatsfeiertag'], [E + 39 * DAY, 'Christi Himmelfahrt'],
    [E + 50 * DAY, 'Pfingstmontag'], [E + 60 * DAY, 'Fronleichnam'], [d(8, 15), 'Mariä Himmelfahrt'], [d(10, 26), 'Nationalfeiertag'], [d(11, 1), 'Allerheiligen'],
    [d(12, 8), 'Mariä Empfängnis'], [d(12, 25), 'Christtag'], [d(12, 26), 'Stefanitag']];
}

function rulesCH(y) {
  const E = easter(y), d = (m, dd) => dayMs(y, m, dd);
  return [[d(1, 1), 'Neujahr'], [E - 2 * DAY, 'Karfreitag', null, 'not in VS and TI'], [E + DAY, 'Ostermontag', null, 'not in all cantons'], [E + 39 * DAY, 'Auffahrt'],
    [E + 50 * DAY, 'Pfingstmontag', null, 'not in all cantons'], [d(8, 1), 'Bundesfeier (national holiday)'], [d(12, 25), 'Weihnachten'], [d(12, 26), 'Stephanstag', null, 'not in all cantons']];
}

// US federal: weekend holidays are observed on the nearest weekday
function rulesUS(y) {
  const d = (m, dd) => dayMs(y, m, dd);
  const observed = (ms) => {
    const wd = new Date(ms).getUTCDay();
    return wd === 6 ? ms - DAY : wd === 0 ? ms + DAY : ms;
  };
  return [[observed(d(1, 1)), 'New Year\'s Day'], [nthWeekday(y, 1, 1, 3), 'Martin Luther King Jr. Day'], [nthWeekday(y, 2, 1, 3), 'Washington\'s Birthday'],
    [nthWeekday(y, 5, 1, -1), 'Memorial Day'], ...(y >= 2021 ? [[observed(d(6, 19)), 'Juneteenth']] : []), [observed(d(7, 4)), 'Independence Day'],
    [nthWeekday(y, 9, 1, 1), 'Labor Day'], [nthWeekday(y, 10, 1, 2), 'Columbus Day'], [observed(d(11, 11)), 'Veterans Day'],
    [nthWeekday(y, 11, 4, 4), 'Thanksgiving Day'], [observed(d(12, 25)), 'Christmas Day']];
}

// England and Wales bank holidays (one-off royal holidays are not included)
function rulesGB(y) {
  const E = easter(y), d = (m, dd) => dayMs(y, m, dd);
  const sub = (ms) => {
    const wd = new Date(ms).getUTCDay();
    return wd === 6 ? ms + 2 * DAY : wd === 0 ? ms + DAY : ms;
  };
  // [Christmas, Boxing Day] as day of December, by the weekday of 25 Dec
  const [xmas, boxing] = { 5: [25, 28], 6: [27, 28], 0: [27, 26] }[new Date(d(12, 25)).getUTCDay()] ?? [25, 26];
  return [[sub(d(1, 1)), 'New Year\'s Day'], [E - 2 * DAY, 'Good Friday'], [E + DAY, 'Easter Monday'], [nthWeekday(y, 5, 1, 1), 'Early May bank holiday'],
    [nthWeekday(y, 5, 1, -1), 'Spring bank holiday'], [nthWeekday(y, 8, 1, -1), 'Summer bank holiday'], [d(12, xmas), 'Christmas Day'], [d(12, boxing), 'Boxing Day']];
}

function rulesFR(y) {
  const E = easter(y), d = (m, dd) => dayMs(y, m, dd);
  return [[d(1, 1), 'Jour de l\'an'], [E + DAY, 'Lundi de Pâques'], [d(5, 1), 'Fête du Travail'], [d(5, 8), 'Victoire 1945'], [E + 39 * DAY, 'Ascension'],
    [E + 50 * DAY, 'Lundi de Pentecôte'], [d(7, 14), 'Fête nationale'], [d(8, 15), 'Assomption'], [d(11, 1), 'Toussaint'], [d(11, 11), 'Armistice 1918'], [d(12, 25), 'Noël']];
}

const BUILT_IN = { DE: rulesDE, AT: rulesAT, CH: rulesCH, US: rulesUS, GB: rulesGB, UK: rulesGB, FR: rulesFR };

/** Holidays of a year as [{ ms, name, note }] for the country/region. */
async function holidaysOf(country, region, y, signal, notes) {
  const cc = country.toUpperCase();
  const rules = BUILT_IN[cc];
  if (rules) {
    const reg = region?.toUpperCase().replace(/^DE-/, '');
    if (cc === 'DE' && reg && !DE_STATES[reg]) throw new ToolError(`Unknown German state "${region}". Use: ${Object.keys(DE_STATES).join(', ')}`);
    return rules(y)
      .filter(([, , regions]) => !regions || !reg || regions.includes(reg))
      .map(([ms, name, regions, note]) => ({ ms, name, note: [regions && !reg ? `only ${regions.join(', ')}` : null, note].filter(Boolean).join('; ') }));
  }
  let data;
  try {
    data = await fetchJson(`https://date.nager.at/api/v3/PublicHolidays/${y}/${encodeURIComponent(cc)}`, { signal });
  } catch (err) {
    if (err.status === 404 || err.status === 400) throw new ToolError(`No holiday data for country "${country}" (use an ISO code like DE, AT, IT, ES, JP)`);
    throw err;
  }
  notes.add('source: date.nager.at');
  const reg = region ? `${cc}-${region.toUpperCase().replace(new RegExp(`^${cc}-`), '')}` : null;
  return data
    .filter((h) => h.global || !reg || h.counties?.includes(reg))
    .filter((h) => h.global || reg)
    .map((h) => ({ ms: Date.parse(`${h.date}T00:00:00Z`), name: h.localName === h.name ? h.name : `${h.localName} (${h.name})`, note: h.global ? '' : `regional: ${h.counties?.join(', ')}` }));
}

function dayArg(s, label) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s ?? '').trim()) ?? /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(s ?? '').trim());
  if (!m) {
    try {
      const w = wallOf(parseMoment(s, LOCAL_TZ), LOCAL_TZ);
      return w - (w % DAY);
    } catch {
      throw new ToolError(`${label}: use YYYY-MM-DD or DD.MM.YYYY`);
    }
  }
  return m[0].includes('-') ? dayMs(+m[1], +m[2], +m[3]) : dayMs(+m[3], +m[2], +m[1]);
}

export async function holidays(args = {}, ctx = {}) {
  const country = args.country ?? 'DE';
  const notes = new Set();
  const out = [];
  if (args.start || args.end) {
    if (!args.start || !args.end) throw new ToolError('Give both start and end for a business-day count');
    const a = dayArg(args.start, 'start'), b = dayArg(args.end, 'end');
    if (b < a) throw new ToolError('end is before start');
    const years = [];
    for (let y = new Date(a).getUTCFullYear(); y <= new Date(b).getUTCFullYear(); y++) years.push(y);
    const hs = (await Promise.all(years.map((y) => holidaysOf(country, args.region, y, ctx.signal, notes)))).flat();
    const byDay = new Map(hs.filter((h) => !h.note?.startsWith('only')).map((h) => [h.ms, h]));
    const lastIncluded = args.include_end === false ? b - DAY : b;
    let weekdays = 0, business = 0;
    const hit = [];
    for (let t = a; t <= lastIncluded; t += DAY) {
      const wd = new Date(t).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      weekdays++;
      if (byDay.has(t)) hit.push(`  ${iso(t)} ${WD[wd].slice(0, 3)}  ${byDay.get(t).name}`);
      else business++;
    }
    out.push(`${iso(a)} to ${iso(b)} (${args.include_end === false ? 'end excluded' : 'both included'}), ${country.toUpperCase()}${args.region ? `-${args.region.toUpperCase()}` : ''}:`,
      `Business days: ${business}`, `Mon-Fri days: ${weekdays}, of which public holidays: ${hit.length}`, ...(hit.length ? ['Holidays on weekdays:', ...hit] : []));
    if (country.toUpperCase() === 'DE' && !args.region) out.push('Note: only nationwide holidays counted; pass region (e.g. BY, NW) for state holidays.');
  } else {
    const y = args.year ?? new Date(wallOf(Date.now(), LOCAL_TZ)).getUTCFullYear();
    const hs = (await holidaysOf(country, args.region, y, ctx.signal, notes)).sort((p, q) => p.ms - q.ms);
    out.push(`Public holidays ${y}, ${country.toUpperCase()}${args.region ? `-${args.region.toUpperCase()}` : ''} (${hs.length}):`);
    for (const h of hs) out.push(`  ${iso(h.ms)} ${WD[new Date(h.ms).getUTCDay()].slice(0, 3)}  ${h.name}${h.note ? `  (${h.note})` : ''}`);
    if (country.toUpperCase() === 'DE' && !args.region) out.push('States differ: pass region (BW, BY, BE, BB, HB, HH, HE, MV, NI, NW, RP, SL, SN, ST, SH, TH) for one state.');
  }
  if (notes.size) out.push([...notes].join('; '));
  return out.join('\n');
}

// ---- cron ---------------------------------------------------------------------

const MACROS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
const NAMES = { month: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], dow: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] };
const FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['day of month', 1, 31], ['month', 1, 12], ['day of week', 0, 7]];

function parseField(text, [label, lo, hi], names) {
  const set = new Set();
  for (const part of text.split(',')) {
    const m = /^(\*|\?|[\w]+(?:-[\w]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new ToolError(`Bad ${label} field "${text}"`);
    const val = (s) => {
      const i = names?.indexOf(s.toUpperCase());
      const n = i >= 0 ? i + (label === 'month' ? 1 : 0) : Number(s);
      if (!Number.isInteger(n) || n < lo || n > hi) throw new ToolError(`${label} value "${s}" out of range ${lo}-${hi}`);
      return n;
    };
    let a = lo, b = hi;
    if (m[1] !== '*' && m[1] !== '?') {
      const [x, y] = m[1].split('-');
      a = val(x);
      b = y !== undefined ? val(y) : m[2] ? hi : a;
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new ToolError(`Bad step in ${label}`);
    if (a > b) throw new ToolError(`${label} range ${a}-${b} is reversed`);
    for (let v = a; v <= b; v += step) set.add(label === 'day of week' && v === 7 ? 0 : v);
  }
  return set;
}

function describeField(text, label, names) {
  if (text === '*' || text === '?') return null;
  const nice = text.replace(/\b\d+\b/g, (n) => (names ? names[Number(n) % names.length] ?? n : n));
  if (/^\*\/\d+$/.test(text)) return `every ${text.slice(2)} ${label}s`;
  return `${label} ${nice}`;
}

export function cron(args = {}) {
  const raw = String(args.expression ?? '').trim();
  if (!raw) throw new ToolError('Provide expression, e.g. "*/15 9-17 * * 1-5"');
  const expr = MACROS[raw.toLowerCase()] ?? raw;
  let parts = expr.split(/\s+/);
  let seconds = null;
  if (parts.length === 6) {
    seconds = parseField(parts[0], ['second', 0, 59]);
    parts = parts.slice(1);
  }
  if (parts.length !== 5) throw new ToolError(`Expected 5 fields (minute hour day month weekday), got ${parts.length}`);
  const [min, hour, dom, mon, dow] = parts.map((p, i) => parseField(p, FIELDS[i], i === 3 ? NAMES.month : i === 4 ? NAMES.dow : null));
  const domStar = parts[2] === '*' || parts[2] === '?', dowStar = parts[4] === '*' || parts[4] === '?';
  const tz = resolveZone(args.timezone);
  const count = Math.min(Math.max(args.count ?? 10, 1), 100);

  const pieces = [
    seconds ? describeField(expr.split(/\s+/)[0], 'second') : null,
    /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) ? `at ${String(parts[1]).padStart(2, '0')}:${String(parts[0]).padStart(2, '0')}` : [describeField(parts[0], 'minute') ?? 'every minute', describeField(parts[1], 'hour')].filter(Boolean).join(', '),
    describeField(parts[2], 'day-of-month'),
    describeField(parts[3], 'month', [null, ...NAMES.month].map((x) => x && MONTHS[NAMES.month.indexOf(x)])),
    describeField(parts[4], 'weekday', WD),
  ].filter(Boolean);
  const out = [`${raw}${raw !== expr ? ` = ${expr}` : ''}`, `Meaning: ${pieces.join('; ')}${!domStar && !dowStar ? ' (day-of-month OR weekday, standard cron rule)' : ''}`, `Next ${count} runs in ${tz}:`];

  const dayMatches = (t) => {
    const d = new Date(t);
    const okDom = dom.has(d.getUTCDate()), okDow = dow.has(d.getUTCDay());
    if (!mon.has(d.getUTCMonth() + 1)) return false;
    if (domStar && dowStar) return true;
    if (domStar) return okDow;
    if (dowStar) return okDom;
    return okDom || okDow;
  };
  const from = args.start ? parseMoment(args.start, tz) : Date.now();
  const nowWall = wallOf(from, tz);
  const notes = [];
  const runs = [];
  const sortedH = [...hour].sort((a, b) => a - b), sortedM = [...min].sort((a, b) => a - b), sortedS = seconds ? [...seconds].sort((a, b) => a - b) : [0];
  for (let day = nowWall - (nowWall % DAY), n = 0; runs.length < count && n < 366 * 30; day += DAY, n++) {
    if (!dayMatches(day)) continue;
    for (const h of sortedH) {
      for (const mi of sortedM) {
        for (const s of sortedS) {
          const wall = day + h * 3_600_000 + mi * 60_000 + s * 1000;
          if (wall <= nowWall) continue;
          const t = instantOf(wall, tz, notes);
          if (runs.length && t <= runs.at(-1)) continue;
          runs.push(t);
          if (runs.length >= count) break;
        }
        if (runs.length >= count) break;
      }
      if (runs.length >= count) break;
    }
  }
  if (!runs.length) out.push('  never (no date matches within 30 years, e.g. 31 in a 30-day month)');
  for (const t of runs) {
    const w = wallOf(t, tz);
    out.push(`  ${wallText(w).slice(0, seconds ? 19 : 16)} ${WD[new Date(w).getUTCDay()].slice(0, 3)}`);
  }
  if (runs.length > 1) {
    const gaps = runs.slice(1).map((t, i) => t - runs[i]);
    const minGap = Math.min(...gaps);
    out.push(`Shortest interval: ${minGap >= DAY ? `${fmtNum(minGap / DAY, 4)} days` : minGap >= 3_600_000 ? `${fmtNum(minGap / 3_600_000, 4)} h` : minGap >= 60_000 ? `${minGap / 60_000} min` : `${minGap / 1000} s`}`);
  }
  out.push(...new Set(notes));
  return out.join('\n');
}

// ---- calendar -----------------------------------------------------------------

function monthGrid(y, m, marks, today) {
  const first = dayMs(y, m, 1), days = new Date(dayMs(y, m + 1, 0)).getUTCDate();
  const lead = (new Date(first).getUTCDay() + 6) % 7;  // Monday first
  const lines = [`${MONTHS[m - 1]} ${y}`.padStart(16 + Math.floor((`${MONTHS[m - 1]} ${y}`.length) / 2)), ' Wk  Mo  Tu  We  Th  Fr  Sa  Su'];
  let cells = new Array(lead).fill('    ');
  let week = isoWeek(first).week;
  for (let d = 1; d <= days; d++) {
    const t = dayMs(y, m, d);
    const mark = t === today ? '*' : marks.has(t) ? '+' : ' ';
    cells.push(`${String(d).padStart(3)}${mark}`);
    if (cells.length === 7 || d === days) {
      lines.push(`${String(week).padStart(3)} ${cells.join('')}`.trimEnd());
      cells = [];
      week = isoWeek(t + DAY).week;
    }
  }
  return lines;
}

const ORD = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1, erster: 1, zweiter: 2, dritter: 3, vierter: 4, letzter: -1 };

export async function calendar(args = {}, ctx = {}) {
  const tz = LOCAL_TZ;
  const nowWall = wallOf(Date.now(), tz);
  const today = nowWall - (nowWall % DAY);
  const out = [];
  if (args.query) {
    const q = args.query.trim().toLowerCase();
    let m;
    if ((m = /^(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\s+(\w+?)s?\s+(?:of\s+|in\s+)?(\w+)\s+(\d{4})$/.exec(q))) {
      const wd = WD.findIndex((w) => w.toLowerCase().startsWith(m[2].slice(0, 3)));
      const mo = MONTHS.findIndex((x) => x.toLowerCase().startsWith(m[3].slice(0, 3))) + 1;
      if (wd < 0 || mo < 1) throw new ToolError('Could not read weekday or month');
      const t = nthWeekday(+m[4], mo, wd, ORD[m[1]]);
      out.push(t === null ? `There is no ${m[1]} ${WD[wd]} in ${MONTHS[mo - 1]} ${m[4]}` : `${m[1]} ${WD[wd]} of ${MONTHS[mo - 1]} ${m[4]}: ${iso(t)} (ISO week ${isoWeek(t).week})`);
    } else if ((m = /^(?:week|kw|w)\s*(\d{1,2})\s+(\d{4})$/.exec(q)) || (m = /^(\d{4})-w(\d{1,2})$/.exec(q))) {
      const [w, y] = q.startsWith('2') || q.startsWith('1') ? [+m[2], +m[1]] : [+m[1], +m[2]];
      const jan4 = dayMs(y, 1, 4);
      const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY + (w - 1) * 7 * DAY;
      if (w < 1 || isoWeek(monday).year !== y) throw new ToolError(`${y} has no ISO week ${w}`);
      out.push(`ISO week ${w} of ${y}: Monday ${iso(monday)} to Sunday ${iso(monday + 6 * DAY)}`);
    } else {
      throw new ToolError('query examples: "last friday of november 2026", "3rd monday of may 2027", "week 12 2027", "2027-W12"');
    }
    return out.join('\n');
  }
  const y = args.year ?? new Date(today).getUTCFullYear();
  const startMonth = args.month ?? (args.year ? 1 : new Date(today).getUTCMonth() + 1);
  const count = Math.min(args.months ?? (args.year && !args.month ? 12 : 1), 24);
  const marks = new Set();
  const listed = [];
  if (args.country) {
    const notes = new Set();
    const years = new Set();
    for (let i = 0; i < count; i++) years.add(y + Math.floor((startMonth - 1 + i) / 12));
    for (const yy of years) {
      for (const h of await holidaysOf(args.country, args.region, yy, ctx.signal, notes)) {
        if (h.note?.startsWith('only')) continue;
        marks.add(h.ms);
        listed.push(h);
      }
    }
  }
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const mm = ((startMonth - 1 + i) % 12) + 1, yy = y + Math.floor((startMonth - 1 + i) / 12);
    blocks.push(monthGrid(yy, mm, marks, today));
  }
  for (let i = 0; i < blocks.length; i += 3) {  // three months side by side
    const row = blocks.slice(i, i + 3);
    const h = Math.max(...row.map((b) => b.length));
    for (let l = 0; l < h; l++) out.push(row.map((b) => (b[l] ?? '').padEnd(34)).join('').trimEnd());
    out.push('');
  }
  out.push(`* today${marks.size ? ', + public holiday' : ''}; weeks are ISO weeks, Monday first`);
  const first = dayMs(y, startMonth, 1), last = dayMs(y, startMonth + count, 0);
  for (const h of listed.filter((x) => x.ms >= first && x.ms <= last).sort((a, b) => a.ms - b.ms)) out.push(`  ${iso(h.ms)} ${h.name}`);
  return out.join('\n');
}
