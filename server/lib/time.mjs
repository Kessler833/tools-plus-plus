// Clock, time zone conversion and calendar math on top of Intl, so every IANA
// zone works on every platform without a tz database dependency.
//
// "Wall" values are the local clock reading of a zone encoded as if it were
// UTC (Date.UTC of the wall fields). Calendar math happens on wall values;
// instants are only used for exact durations.

export class TimeError extends Error {}

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const ALIASES = {
  utc: 'UTC', gmt: 'UTC', z: 'UTC', local: LOCAL_TZ,
  pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles',
  mst: 'America/Denver', mdt: 'America/Denver',
  cst: 'America/Chicago', cdt: 'America/Chicago',
  est: 'America/New_York', edt: 'America/New_York',
  bst: 'Europe/London', wet: 'Europe/Lisbon',
  cet: 'Europe/Berlin', cest: 'Europe/Berlin', mez: 'Europe/Berlin', mesz: 'Europe/Berlin',
  eet: 'Europe/Athens', eest: 'Europe/Athens', msk: 'Europe/Moscow',
  ist: 'Asia/Kolkata', sgt: 'Asia/Singapore', hkt: 'Asia/Hong_Kong',
  jst: 'Asia/Tokyo', kst: 'Asia/Seoul',
  aest: 'Australia/Sydney', aedt: 'Australia/Sydney', nzst: 'Pacific/Auckland', nzdt: 'Pacific/Auckland',
};
let zoneList;

/** IANA name, abbreviation (CET, PST), city ("Tokyo", "new york") or "local". */
export function resolveZone(input) {
  if (input === undefined || input === null || String(input).trim() === '') return LOCAL_TZ;
  const raw = String(input).trim();
  const key = raw.toLowerCase();
  if (ALIASES[key]) return ALIASES[key];
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    // fall through to city lookup
  }
  zoneList ??= Intl.supportedValuesOf('timeZone');
  const city = '/' + key.replace(/\s+/g, '_');
  const hit = zoneList.find((z) => z.toLowerCase().endsWith(city));
  if (hit) return hit;
  throw new TimeError(`Unknown time zone "${raw}". Use an IANA name (Europe/Berlin), a city (Tokyo) or UTC.`);
}

// ---- wall <-> instant ---------------------------------------------------------

const formatters = new Map();
export function wallOf(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(ms)) p[type] = Number(value);
  return utc(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + (((ms % SEC) + SEC) % SEC);
}

const offsetAt = (ms, tz) => wallOf(ms, tz) - ms;

/**
 * Instant for a wall-clock time. Around DST changes a wall time can be
 * missing (spring gap: shifted forward) or occur twice (autumn: the earlier
 * one is used); `notes` receives a message in both cases.
 */
export function instantOf(wall, tz, notes) {
  const offsets = new Set([offsetAt(wall - DAY, tz), offsetAt(wall, tz), offsetAt(wall + DAY, tz)]);
  const valid = [...offsets].map((o) => wall - o).filter((t) => wallOf(t, tz) === wall).sort((a, b) => a - b);
  const text = wallText(wall).slice(0, 16);
  if (valid.length > 1) notes?.push(`${text} occurs twice in ${tz} (DST ends); used the first occurrence, UTC${offsetText(wall - valid[0])}`);
  if (valid.length) return valid[0];
  const t = wall - offsetAt(wall - DAY, tz);
  notes?.push(`${text} does not exist in ${tz} (DST gap); shifted to ${wallText(wallOf(t, tz)).slice(0, 16)}`);
  return t;
}

// ---- parsing ------------------------------------------------------------------

// Date.UTC maps years 0-99 to 1900-1999; set the full year explicitly
export function utc(y, m0, d, h = 0, mi = 0, s = 0, ms = 0) {
  const t = new Date(Date.UTC(2000, m0, d, h, mi, s, ms));
  t.setUTCFullYear(y, m0, d);
  return t.getTime();
}

export function makeWall(y, mo, d, h = 0, mi = 0, s = 0, ms = 0) {
  const w = utc(y, mo - 1, d, h, mi, s, ms);
  const t = new Date(w);
  if (mo < 1 || mo > 12 || t.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw new TimeError(`Invalid date/time: ${y}-${mo}-${d} ${h}:${mi}:${s}`);
  }
  return w;
}

function parseOffset(text) {
  if (/^(z|utc)$/i.test(text)) return 0;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(text);
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return (m[1] === '-' ? -minutes : minutes) * MIN;
}

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?\s*(z|utc|[+-]\d{2}(?::?\d{2})?)?$/i;
const GERMAN = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

const startOfDay = (wall) => wall - (((wall % DAY) + DAY) % DAY);

/** Parse a moment; strings without an explicit offset are wall time in `tz`. */
export function parseMoment(input, tz, notes) {
  const s = String(input ?? 'now').trim();
  const lower = s.toLowerCase();
  if (lower === '' || lower === 'now') return Date.now();
  const relative = { today: 0, tomorrow: 1, yesterday: -1 }[lower];
  if (relative !== undefined) return instantOf(startOfDay(wallOf(Date.now(), tz)) + relative * DAY, tz, notes);

  let m;
  if ((m = /^@?(\d{9,13})$/.exec(s))) {
    const n = Number(m[1]);
    return m[1].length <= 10 ? n * SEC : n;
  }
  if ((m = ISO.exec(s))) {
    const [, y, mo, d, h, mi, sec, frac, off] = m;
    const wall = makeWall(+y, +mo, +d, +(h ?? 0), +(mi ?? 0), +(sec ?? 0), +(frac ?? '0').padEnd(3, '0'));
    return off ? wall - parseOffset(off) : instantOf(wall, tz, notes);
  }
  if ((m = GERMAN.exec(s))) {
    const [, d, mo, y, h, mi, sec] = m;
    return instantOf(makeWall(+y, +mo, +d, +(h ?? 0), +(mi ?? 0), +(sec ?? 0)), tz, notes);
  }
  if ((m = CLOCK.exec(s))) {
    const day = new Date(wallOf(Date.now(), tz));
    const wall = makeWall(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), +m[1], +m[2], +(m[3] ?? 0));
    return instantOf(wall, tz, notes);
  }
  throw new TimeError(
    `Cannot parse "${s}". Use now, today, tomorrow, yesterday, YYYY-MM-DD[ HH:MM[:SS]][Z|±HH:MM], DD.MM.YYYY[ HH:MM], HH:MM or a Unix timestamp.`,
  );
}

// ---- formatting ---------------------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function wallText(wall) {
  const d = new Date(wall);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function offsetText(off) {
  const m = Math.round(Math.abs(off) / MIN);
  return `${off < 0 ? '-' : '+'}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function isDst(ms, tz) {
  const y = new Date(ms).getUTCFullYear();
  const standard = Math.min(offsetAt(utc(y, 0, 1), tz), offsetAt(utc(y, 6, 1), tz));
  return offsetAt(ms, tz) > standard;
}

export function isoWeek(wall) {
  const d = new Date(startOfDay(wall));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);  // Thursday of this week decides the year
  const yearStart = utc(d.getUTCFullYear(), 0, 1);
  return { year: d.getUTCFullYear(), week: Math.ceil(((d - yearStart) / DAY + 1) / 7) };
}

/** One line: "2026-10-30 14:05:09 Friday  Europe/Berlin (UTC+01:00)". */
function line(ms, tz) {
  const wall = wallOf(ms, tz);
  const dst = isDst(ms, tz) ? ', DST' : '';
  return `${wallText(wall)} ${WEEKDAYS[new Date(wall).getUTCDay()]}  ${tz} (UTC${offsetText(wall - ms)}${dst})`;
}

/** Calendar facts about the day `ms` falls on in `tz`. */
function calendarFacts(ms, tz) {
  const wall = wallOf(ms, tz);
  const d = new Date(wall);
  const y = d.getUTCFullYear();
  const leap = new Date(utc(y, 1, 29)).getUTCMonth() === 1;
  const dayOfYear = (startOfDay(wall) - utc(y, 0, 1)) / DAY + 1;
  const { year, week } = isoWeek(wall);
  const iso = `${wallText(wall).replace(' ', 'T')}${offsetText(wall - ms)}`;
  return [
    `ISO 8601: ${iso}`,
    `ISO week ${week} of ${year}, day ${dayOfYear} of ${leap ? 366 : 365}, Q${Math.floor(d.getUTCMonth() / 3) + 1}`,
  ];
}

// ---- calendar math ------------------------------------------------------------

const daysInMonth = (y, m0) => new Date(utc(y, m0 + 1, 0)).getUTCDate();

function addMonths(wall, months) {
  const d = new Date(wall);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const y = Math.floor(total / 12), m0 = total - y * 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(y, m0));
  return utc(y, m0, day) + (wall - startOfDay(wall));
}

function monthsBetween(a, b) {
  const da = new Date(a), db = new Date(b);
  let m = (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + db.getUTCMonth() - da.getUTCMonth();
  while (m > 0 && addMonths(a, m) > b) m--;
  return Math.max(m, 0);
}

const isWeekday = (wall) => {
  const dow = new Date(wall).getUTCDay();
  return dow !== 0 && dow !== 6;
};

// Mon-Fri days in [dayA, dayB), both start-of-day walls
function weekdaysBetween(dayA, dayB) {
  const total = Math.round((dayB - dayA) / DAY);
  let count = Math.floor(total / 7) * 5;
  for (let i = Math.floor(total / 7) * 7; i < total; i++) if (isWeekday(dayA + i * DAY)) count++;
  return count;
}

function addBusinessDays(wall, n) {
  if (Math.abs(n) > 100_000) throw new TimeError('business_days limited to ±100000');
  const step = Math.sign(n) * DAY;
  for (let left = Math.abs(n); left > 0; ) {
    wall += step;
    if (isWeekday(wall)) left--;
  }
  return wall;
}

function plural(n, unit) {
  return `${n} ${unit}${Math.abs(n) === 1 ? '' : 's'}`;
}

function durationText(ms) {
  const parts = [];
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MIN), s = Math.floor((ms % MIN) / SEC);
  if (d) parts.push(plural(d, 'day'));
  if (h) parts.push(plural(h, 'hour'));
  if (m) parts.push(plural(m, 'minute'));
  if (s || !parts.length) parts.push(plural(s, 'second'));
  return parts.join(', ');
}

const trimNum = (x) => String(Math.round(x * 1e4) / 1e4);

function wantInteger(value, name) {
  if (!Number.isInteger(value)) throw new TimeError(`${name} must be a whole number`);
  return value;
}

// ---- tools --------------------------------------------------------------------

export function timeNow({ timezones = [] } = {}) {
  const now = Date.now();
  const lines = [`Local: ${line(now, LOCAL_TZ)}`, ...calendarFacts(now, LOCAL_TZ).map((l) => `  ${l}`)];
  if (LOCAL_TZ !== 'UTC') lines.push(`UTC:   ${wallText(now)}`);
  lines.push(`Unix:  ${Math.floor(now / SEC)}`);
  for (const z of timezones) lines.push(line(now, resolveZone(z)));
  return lines.join('\n');
}

export function timeConvert({ time = 'now', from, to = [] } = {}) {
  const fromTz = resolveZone(from);
  const notes = [];
  const ms = parseMoment(time, fromTz, notes);
  const targets = (Array.isArray(to) ? to : [to]).map(resolveZone);
  if (!targets.length) targets.push('UTC');
  const fromDay = startOfDay(wallOf(ms, fromTz));
  const lines = [...notes.map((n) => `Note: ${n}`), line(ms, fromTz), ...calendarFacts(ms, fromTz).map((l) => `  ${l}`), ''];
  for (const tz of targets) {
    const shift = Math.round((startOfDay(wallOf(ms, tz)) - fromDay) / DAY);
    lines.push(`-> ${line(ms, tz)}${shift ? `  (${shift > 0 ? '+' : ''}${plural(shift, 'day')})` : ''}`);
  }
  lines.push(`Unix: ${Math.floor(ms / SEC)}`);
  return lines.join('\n');
}

export function dateDiff({ start, end = 'now', timezone } = {}) {
  if (start === undefined) throw new TimeError('start is required');
  const tz = resolveZone(timezone);
  const notes = [];
  let a = parseMoment(start, tz, notes), b = parseMoment(end, tz, notes);
  const sign = b < a ? -1 : 1;
  if (sign < 0) [a, b] = [b, a];
  const neg = sign < 0 ? '-' : '';

  const exact = b - a;
  const wa = wallOf(a, tz), wb = wallOf(b, tz);
  const months = monthsBetween(wa, wb);
  const rest = wb - addMonths(wa, months);
  const calendar = [];
  if (Math.floor(months / 12)) calendar.push(plural(Math.floor(months / 12), 'year'));
  if (months % 12) calendar.push(plural(months % 12, 'month'));
  if (rest || !calendar.length) calendar.push(durationText(rest));

  const dayA = startOfDay(wa), dayB = startOfDay(wb);
  const days = Math.round((dayB - dayA) / DAY);
  const workdays = weekdaysBetween(dayA, dayB);

  return [
    `From: ${line(a, tz)}`,
    `To:   ${line(b, tz)}`,
    sign < 0 ? '(end is before start, so values are negative)' : null,
    '',
    `Calendar:      ${neg}${calendar.join(', ')}`,
    `Exact:         ${neg}${durationText(exact)}`,
    `Totals:        ${neg}${trimNum(exact / DAY)} days = ${neg}${trimNum(exact / HOUR)} hours = ${neg}${trimNum(exact / MIN)} minutes = ${neg}${exact / SEC} seconds`,
    `Calendar days: ${neg}${days} (${neg}${plural(Math.floor(days / 7), 'week')} + ${plural(days % 7, 'day')})`,
    `Weekdays Mon-Fri: ${neg}${workdays} from start date up to but excluding end date (${neg}${workdays + (isWeekday(dayB) ? 1 : 0)} including end date; public holidays not considered)`,
    ...notes.map((n) => `Note: ${n}`),
  ].filter((l) => l !== null).join('\n');
}

export function dateAdd({ start = 'now', timezone, years = 0, months = 0, weeks = 0, days = 0, business_days = 0, hours = 0, minutes = 0, seconds = 0 } = {}) {
  const tz = resolveZone(timezone);
  const notes = [];
  const t0 = parseMoment(start, tz, notes);
  let wall = wallOf(t0, tz);

  const totalMonths = wantInteger(years, 'years') * 12 + wantInteger(months, 'months');
  if (totalMonths) {
    const day = new Date(wall).getUTCDate();
    wall = addMonths(wall, totalMonths);
    if (new Date(wall).getUTCDate() !== day) notes.push('day clamped to the end of the month');
  }
  wall += (wantInteger(weeks, 'weeks') * 7 + wantInteger(days, 'days')) * DAY;
  if (business_days) wall = addBusinessDays(wall, wantInteger(business_days, 'business_days'));

  let t = totalMonths || weeks || days || business_days ? instantOf(wall, tz, notes) : t0;
  for (const [v, name] of [[hours, 'hours'], [minutes, 'minutes'], [seconds, 'seconds']]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TimeError(`${name} must be a number`);
  }
  t += (hours * HOUR) + (minutes * MIN) + (seconds * SEC);

  return [
    `Start:  ${line(t0, tz)}`,
    `Result: ${line(t, tz)}`,
    ...calendarFacts(t, tz).map((l) => `  ${l}`),
    ...notes.map((n) => `Note: ${n}`),
  ].join('\n');
}
