// Run with: node test/run.mjs            (offline tests)
//           node test/run.mjs --online   (also hits the web APIs)
// Media tests run when ffmpeg is on PATH.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scratch = await mkdtemp(join(tmpdir(), 'tpp-test-'));
process.env.TOOLS_PP_HOME = join(scratch, 'home');  // keep snapshots out of the real home

const { calculate } = await import('../server/lib/calc.mjs');
const { timeConvert, dateDiff, dateAdd, timeNow, resolveZone } = await import('../server/lib/time.mjs');
const { convertUnits } = await import('../server/lib/units.mjs');
const { stats } = await import('../server/lib/stats.mjs');
const { random } = await import('../server/lib/random.mjs');
const { textStats, diff } = await import('../server/lib/text.mjs');
const { regexTest } = await import('../server/lib/regex.mjs');
const { encode, hash } = await import('../server/lib/encode.mjs');
const { jsonTool } = await import('../server/lib/json.mjs');
const { color } = await import('../server/lib/color.mjs');
const { secretScan } = await import('../server/lib/secrets.mjs');
const { waitFor } = await import('../server/lib/wait.mjs');
const { benchmark } = await import('../server/lib/bench.mjs');
const { snapshot } = await import('../server/lib/snapshot.mjs');
const { packageInfo, weather, wikipedia } = await import('../server/lib/web.mjs');
const { mediaInfo, videoFrames, audioAnalyze, imageCompare } = await import('../server/lib/media.mjs');
const { solve, matrix, numberTheory, finance } = await import('../server/lib/algebra.mjs');
const { table, tableConvert } = await import('../server/lib/table.mjs');
const { holidays, cron, calendar } = await import('../server/lib/calendar.mjs');
const { textTransform, tokenCount, markdown, extract } = await import('../server/lib/textx.mjs');
const { diskUsage, findDuplicates, batchRename, archive } = await import('../server/lib/files.mjs');
const { processes, sysinfo, runParallel, logSummary, envCompare } = await import('../server/lib/system.mjs');
const { httpTool, netTool } = await import('../server/lib/net.mjs');
const { depsCheck } = await import('../server/lib/deps.mjs');
const { sqlite, schemaTool } = await import('../server/lib/data.mjs');
const { pdfText } = await import('../server/lib/pdf.mjs');
const { imageEdit } = await import('../server/lib/media.mjs');
const zlib = await import('node:zlib');
const nodeNet = await import('node:net');
const nodeHttp = await import('node:http');
const { readdir } = await import('node:fs/promises');

const ONLINE = process.argv.includes('--online');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
let failed = 0, passed = 0, section = '';

async function check(label, fn, ...expected) {
  let out;
  try {
    out = String(await fn());
  } catch (err) {
    out = `Error: ${err.message}`;
  }
  const problems = expected.filter((e) => (e instanceof RegExp ? !e.test(out) : e.startsWith('!') ? out.includes(e.slice(1)) : !out.includes(e)));
  if (problems.length) {
    failed++;
    console.log(`FAIL [${section}] ${label}\n  expected: ${problems.map(String).join(' | ')}\n  got:\n${out.replace(/^/gm, '    ')}`);
  } else {
    passed++;
  }
  return out;
}
const group = (name) => { section = name; };
const file = async (name, content) => {
  const p = join(scratch, name);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, content);
  return p;
};

// ---- calc -----------------------------------------------------------------------
group('calc');
const calc = (expr, ...expected) => check(expr, () => calculate(expr), ...expected);
await calc('0.1 + 0.2', '= 0.3', 'exact');
await calc('1/3 + 1/6', '= 0.5', '= 1/2');
await calc('1/7', '= 1/7', 'repeating decimal: 0.(142857)');
await calc('7/6', 'repeating decimal: 1.1(6)');
await calc('-1/3', 'repeating decimal: -0.(3)', '≈ -0.333');
await calc('2^100', '= 1267650600228229401496703205376');
await calc('20!', '= 2432902008176640000');
await calc('0!', '= 1');
await calc('sqrt(2)', '≈ 1.4142135623730951', 'approximate');
await calc('sqrt(16/9)', '= 4/3');
await calc('(-8)^(1/3)', '= -2');
await calc('(-8)^(2/3)', '= 4');
await calc('cbrt(-2)', '≈ -1.259921');
await calc('x = 3; y = 4; sqrt(x^2 + y^2)', 'x = 3', 'y = 4', '= 5');
await calc('2pi', '≈ 6.283185307179586');
await calc('log(1000)', '= 3');
await calc('log(1/8, 2)', '= -3');
await calc('log(0.001)', '= -3');
await calc('ln(e)', '≈ 1');
await calc('floor(log(200!)) + 1', '≈ 375');
await calc('log(2^4000, 2)', '= 4000');
await calc('ln(1/10^500)', '≈ -1151.29');
await calc('nCr(49, 6)', '= 13983816');
await calc('nCr(5, 7)', '= 0');
await calc('gcd(12, 18, 30)', '= 6');
await calc('lcm(4, 6)', '= 12');
await calc('lcm(0, 5)', '= 0');
await calc('round(2.5)', '= 3');
await calc('round(-2.5)', '= -3');
await calc('round(3.14159, 2)', '= 3.14');
await calc('round(1234, -2)', '= 1200');
await calc('-2^2', '= -4');
await calc('2^3^2', '= 512');
await calc('2^-2', '= 0.25');
await calc('-7 % 3', '= 2');
await calc('mod(7, -3)', '= -2');
await calc('50%', '= 0.5');
await calc('50% + 2', '= 2.5');
await calc('200 * 19%', '= 38');
await calc('(10 + 10)%', '= 0.2');
await calc('10 % (3)', '= 1');
await calc('1.5e-3', '= 0.0015');
await calc('0xff + 0b101', '= 260');
await calc('1_000_000 * 3', '= 3000000');
await calc('3(4+1)', '= 15');
await calc('(1+2)(3+4)', '= 21');
await calc('10 ÷ 4 × 2', '= 5');
await calc('3²+4²', '= 25');
await calc('sin(30deg)', '≈ 0.4999999999999999');
await calc('1000!', 'exact integer (2568 digits)');
await calc('1/3', '≈ 0.333333333333333333333333333333');
await calc('0^0', '= 1');
await calc('10^400 / 10^398', '= 100');
await calc('1e400 * 1e-399', '= 10');
await calc('2^0.5 * 2^0.5', '≈ 2');
await calc('floor(-2.5) + ceil(-2.5)', '= -5');
await calc('max(1/3, 0.33, 1/4)', '= 1/3');
await calc('hypot(3, 4)', '= 5');
await calc('abs(-1/2)', '= 0.5');
await calc('1/0', 'Error: Division by zero');
await calc('0^-1', 'Error: Division by zero');
await calc('5 % 0', 'Error: Modulo by zero');
await calc('sqrt(-1)', 'Error: Result is not a real number');
await calc('ln(0)', 'Error: Logarithm of a non-positive number');
await calc('(-3)!', 'Error: Factorial of a negative number');
await calc('2.5!', 'Error: Factorial needs integer');
await calc('10^10^10', 'Error: Exact result would have about 10,000,000,000 digits');
await calc('2^999999', 'exact integer with 301030 digits');
await calc('2^0.5^2', '≈ 1.189');
await calc('foo + 1', 'Error: Unknown name "foo"');
await calc('sin 3', 'Error: sin is a function');
await calc('sin()', 'Error: sin() takes 1 argument');
await calc('2 +', 'Error: Unexpected end of expression');
await calc('(1 + 2', 'Error: Expected ")"');
await calc('1 $ 2', 'Error: Unexpected character "$"');
await calc('pi = 3', 'Error: "pi" is a built-in name');
await calc('', 'Error: Empty expression');
await calc(';;', 'Error: Empty expression');
await calc('2; ans * 10', '= 20');
await calc('1.2.3', 'Error: Unexpected');
await check('digits', () => calculate('1/3', 5), '≈ 0.33333\n');
await check('registry targets exist', async () => {
  const missing = [];
  for (const t of (await import('../server/tools.mjs')).tools) {
    if (!t.run.target) continue;
    const [file, fn] = t.run.target;
    if (typeof (await import(`../server/lib/${file}.mjs`))[fn] !== 'function') missing.push(`${t.name} -> ${file}.${fn}`);
  }
  return missing.length ? `missing: ${missing.join(', ')}` : 'all ok';
}, 'all ok');
await check('digits via registry', async () => (await import('../server/tools.mjs')).tools.find((t) => t.name === 'calc').run({ expression: '1/3', digits: 5 }, {}), '≈ 0.33333\n');
await check('tiny', () => calculate('1/3 * 10^-20'), '≈ 3.33333333333333333333333333333e-21');

// ---- time -----------------------------------------------------------------------
group('time');
await check('zone city', () => resolveZone('new york'), 'America/New_York');
await check('zone abbrev', () => resolveZone('CET'), 'Europe/Berlin');
await check('zone bad', () => resolveZone('Mars/Base'), 'Unknown time zone');
await check('now', () => timeNow({ timezones: ['Tokyo'] }), 'Local:', 'Unix:', 'Asia/Tokyo', 'ISO week');
await check('convert summer', () => timeConvert({ time: '2026-07-01 12:00', from: 'Europe/Berlin', to: ['America/New_York'] }),
  '2026-07-01 12:00:00 Wednesday  Europe/Berlin (UTC+02:00, DST)', '-> 2026-07-01 06:00:00 Wednesday  America/New_York (UTC-04:00, DST)');
await check('convert day shift', () => timeConvert({ time: '2026-10-30 22:00', from: 'Europe/Berlin', to: ['Tokyo'] }), '(+1 day)');
await check('convert half-hour zone', () => timeConvert({ time: '2026-01-15 12:00', from: 'UTC', to: ['Asia/Kolkata', 'Asia/Kathmandu'] }), '17:30:00', '17:45:00', 'UTC+05:45');
await check('convert german format', () => timeConvert({ time: '24.12.2026 18:00', from: 'UTC', to: ['UTC'] }), '2026-12-24 18:00:00 Thursday');
await check('convert explicit offset', () => timeConvert({ time: '2026-01-01T00:00:00Z', from: 'Europe/Berlin' }), '2026-01-01 01:00:00 Thursday  Europe/Berlin');
await check('convert unix', () => timeConvert({ time: '1700000000', from: 'UTC' }), '2023-11-14 22:13:20');
await check('convert iso week 53', () => timeConvert({ time: '2027-01-01', from: 'UTC' }), 'ISO week 53 of 2026');
await check('two-digit year', () => timeConvert({ time: '0099-03-01', from: 'UTC' }), '0099-03-01 00:00:00');
await check('negative day shift singular', () => timeConvert({ time: '2026-01-01 00:00', from: 'Europe/Berlin', to: ['UTC'] }), '(-1 day)');
await check('convert leap day', () => timeConvert({ time: '2028-02-29', from: 'UTC' }), 'day 60 of 366');
await check('dst gap', () => dateAdd({ start: '2026-03-29 02:30', timezone: 'Europe/Berlin' }), 'does not exist', 'shifted to 2026-03-29 03:30');
await check('dst ambiguous', () => timeConvert({ time: '2026-10-25 02:30', from: 'Europe/Berlin', to: ['UTC'] }), 'occurs twice', '-> 2026-10-25 00:30:00');
await check('dst add keeps wall', () => dateAdd({ start: '2026-03-28 12:00', timezone: 'Europe/Berlin', days: 1 }), 'Result: 2026-03-29 12:00:00', 'UTC+02:00');
await check('diff', () => dateDiff({ start: '2026-01-01', end: '2026-12-25', timezone: 'UTC' }), 'Calendar days: 358', 'Calendar:      11 months, 24 days');
await check('diff weekdays', () => dateDiff({ start: '2026-10-26', end: '2026-10-31', timezone: 'UTC' }), 'Weekdays Mon-Fri: 5');
await check('diff negative', () => dateDiff({ start: '2026-02-01', end: '2026-01-01', timezone: 'UTC' }), 'Calendar:      -1 month');
await check('diff across DST', () => dateDiff({ start: '2026-03-28 12:00', end: '2026-03-29 12:00', timezone: 'Europe/Berlin' }), 'Calendar:      1 day', 'Exact:         23 hours');
await check('diff age', () => dateDiff({ start: '1990-05-15', end: '2026-05-14', timezone: 'UTC' }), 'Calendar:      35 years, 11 months, 29 days');
await check('diff same', () => dateDiff({ start: '2026-01-01', end: '2026-01-01', timezone: 'UTC' }), 'Calendar:      0 seconds');
await check('add months clamp', () => dateAdd({ start: '2026-01-31', timezone: 'UTC', months: 1 }), 'Result: 2026-02-28', 'clamped');
await check('add leap year', () => dateAdd({ start: '2024-02-29', timezone: 'UTC', years: 1 }), 'Result: 2025-02-28');
await check('add business days', () => dateAdd({ start: '2026-10-30', timezone: 'UTC', business_days: 1 }), 'Result: 2026-11-02 00:00:00 Monday');
await check('add business days back', () => dateAdd({ start: '2026-11-02', timezone: 'UTC', business_days: -1 }), 'Result: 2026-10-30');
await check('add negative', () => dateAdd({ start: '2026-03-01', timezone: 'UTC', days: -1 }), 'Result: 2026-02-28');
await check('add hours', () => dateAdd({ start: '2026-10-30 23:30', timezone: 'UTC', hours: 1.5 }), 'Result: 2026-10-31 01:00:00');
await check('add fractional days', () => dateAdd({ start: '2026-01-01', timezone: 'UTC', days: 1.5 }), 'whole number');
await check('bad date', () => dateAdd({ start: '2026-02-30' }), 'Invalid date');
await check('bad format', () => dateAdd({ start: 'next tuesday' }), 'Cannot parse');

// ---- units ----------------------------------------------------------------------
group('units');
const conv = (args, ...expected) => check(`${args.value ?? 1} ${args.from} -> ${args.to}`, () => convertUnits(args), ...expected);
await conv({ value: 5, from: 'mi', to: 'km' }, '= 8.04672 km', 'exact');
await conv({ value: 100, from: 'degF', to: 'degC' }, '= 37.7777777778 degC', '340/9');
await conv({ value: -40, from: '°C', to: '°F' }, '= -40 °F');
await conv({ value: 0, from: 'K', to: 'degC' }, '= -273.15 degC');
await conv({ value: 10, from: 'K', to: 'degF', difference: true }, '= 18 degF');
await conv({ value: -300, from: 'degC', to: 'K' }, 'below absolute zero');
await conv({ value: 120, from: 'km/h', to: 'm/s' }, '= 33.3333333333 m/s', '100/3');
await conv({ value: 1, from: 'kWh', to: 'MJ' }, '= 3.6 MJ', 'exact');
await conv({ value: 8, from: 'L/100km', to: 'mi/gal' }, '29.4018229167', 'reciprocal');
await conv({ value: 1, from: 'GiB', to: ['MB', 'MiB'] }, '= 1073.741824 MB', '= 1024 MiB');
await conv({ value: 1, from: 'KB', to: 'B' }, '= 1000 B');
await conv({ value: 1, from: 'atm', to: 'bar' }, '= 1.01325 bar');
await conv({ value: 1, from: 'ft^2', to: 'm^2' }, '= 0.09290304 m^2');
await conv({ value: 1, from: 'sq ft', to: 'cm²' }, '= 929.0304 cm²');
await conv({ value: 1, from: 'm^-2', to: '1/cm^2' }, '= 0.0001 1/cm^2');
await conv({ value: 3, from: 'cup', to: 'floz' }, '= 24 floz');
await conv({ value: 1, from: 'N m', to: 'J' }, '= 1 J');
await conv({ value: 1, from: 'µs', to: 'ns' }, '= 1000 ns');
await conv({ value: 2, from: 'kilometers', to: 'miles' }, '1.24274238447');
await conv({ value: '1/3', from: 'h', to: 'min' }, '= 20 min');
await conv({ value: '1,5', from: 'km', to: 'm' }, '= 1500 m');
await conv({ value: 1, from: 'KM', to: 'M' }, '= 1000 M');
await conv({ value: 2, from: 'KWH', to: 'kJ' }, '= 7200 kJ');
await conv({ value: 2, from: 'cup', to: 'tbsp' }, '= 32 tbsp');
await conv({ value: 1, from: 'furlong', to: 'm' }, '= 201.168 m');
await conv({ value: 1, from: 'J/(kg*K)', to: 'cal/(g*K)' }, '0.000239005736138');
await conv({ value: 1, from: 'm2', to: 'cm2' }, '= 10000 cm2');
await conv({ value: 60, from: 'mph' }, 'SI base units', '26.8224');
await conv({ value: 1, from: 'kg', to: 's' }, 'Cannot convert kg (mass: kg) to s (time: s)');
await conv({ value: 20, from: 'C', to: 'F' }, 'write degC / degF');
await conv({ value: 1, from: 'blorp', to: 'm' }, 'Unknown unit "blorp"');
await conv({ value: 1, from: 'm/', to: 'm' }, 'ends unexpectedly');
await conv({ value: 1, from: '(m', to: 'm' }, 'Missing ")"');

// ---- stats ----------------------------------------------------------------------
group('stats');
await check('basic', () => stats({ numbers: [2, 4, 4, 4, 5, 5, 7, 9] }), 'mean: 5', 'median: 4.5', 'mode: 4 (3×)', '2.138089935 (sample', '2 (population');
await check('single', () => stats({ numbers: [42] }), 'n: 1', 'std dev: n/a');
await check('empty', () => stats({ numbers: [] }), 'numbers is empty');
await check('text list', () => stats({ text: '1, 2, 3, 4, foo' }), 'n: 4', 'skipped 1');
await check('decimal comma', () => stats({ text: '1,5 2,5 3,5' }), 'mean: 2.5', 'commas were read as decimal separators');
await check('comma list', () => stats({ text: '1, 5, 2' }), 'n: 3', '!decimal separators');
await check('thousands', () => stats({ text: '1,000.5\n2,000.5' }), 'mean: 1500.5');
await check('precision', () => stats({ numbers: [1e16, 1, -1e16] }), 'sum: 1');
await check('large input', () => stats({ numbers: Array.from({ length: 300000 }, (_, i) => i % 7) }), 'n: 300000', 'mean: 2.99');
await check('outliers', () => stats({ numbers: [1, 2, 3, 4, 5, 100] }), 'outliers (beyond 1.5×IQR): 1 (100)');
await check('percentiles', () => stats({ numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], percentiles: [90] }), 'P90: 9.1');
await check('histogram', () => stats({ numbers: [1, 2, 2, 3, 3, 3, 4, 4, 5], histogram: true }), 'histogram:', '█');
await check('correlation', () => stats({ numbers: [1, 2, 3, 4, 5], y: [2, 4, 6, 8, 10] }), 'Pearson r: 1', 'y = 0 + 2·x');
await check('correlation mismatch', () => stats({ numbers: [1, 2, 3], y: [1, 2] }), 'x has 3 values but y has 2');
const csv = await file('data.csv', 'name;age;score\n"Smith, J";34;"1.234,5"\nDoe;28;99,5\nRoe;;12\n');
await check('csv summary', () => stats({ path: csv }), '3 rows, 3 columns, delimiter ";"', 'name: non-numeric', 'age: n=2 (1 missing)');
await check('csv column', () => stats({ path: csv, column: 'score' }), 'n: 3', 'max: 1234.5');
await check('csv bad column', () => stats({ path: csv, column: 'nope' }), 'No column "nope". Columns: name, age, score');
await check('csv regression', () => stats({ text: 'x,y\n1,1\n2,3\n3,5\n4,7', column: 'x', y_column: 'y' }), 'Pearson r: 1', 'y = -1 + 2·x');
await check('csv quoted newline', () => stats({ text: 'a,b\n"line\nbreak",1\nx,2\n', column: 'b' }), 'n: 2', 'sum: 3');

// ---- random ---------------------------------------------------------------------
group('random');
await check('int range', () => random({ kind: 'int', min: 5, max: 5, count: 3 }), '5, 5, 5');
await check('int unique full', async () => {
  const out = random({ kind: 'int', min: 1, max: 10, count: 10, unique: true });
  return out.split('\n')[0].split(', ').map(Number).sort((a, b) => a - b).join(',');
}, '1,2,3,4,5,6,7,8,9,10');
await check('int unique too many', () => random({ kind: 'int', min: 1, max: 3, count: 4, unique: true }), 'Cannot draw 4 unique');
await check('bigint', () => random({ kind: 'int', min: '100000000000000000000', max: '100000000000000000000' }), '100000000000000000000');
await check('seeded repeatable', async () => random({ kind: 'int', seed: 'x', count: 5 }) === random({ kind: 'int', seed: 'x', count: 5 }) ? 'same' : 'different', 'same');
await check('float bounds', () => {
  const v = random({ kind: 'float', min: 2, max: 3, count: 1000 }).split('\n')[0].split(', ').map(Number);
  return v.every((x) => x >= 2 && x < 3) ? 'ok' : 'out of range';
}, 'ok');
await check('normal', () => {
  const v = random({ kind: 'normal', mean: 10, sd: 2, count: 5000, seed: 1 }).split('\n')[0].split(', ').map(Number);
  const m = v.reduce((a, b) => a + b) / v.length;
  return Math.abs(m - 10) < 0.15 ? 'ok' : `mean ${m}`;
}, 'ok');
await check('password classes', () => random({ kind: 'password', length: 12, charset: 'digits,upper' }), /^[0-9A-Z]{12}\n/);
await check('password entropy', () => random({ kind: 'password' }), 'bits of entropy');
await check('dice', () => random({ kind: 'dice', dice: '4d6kh3', seed: 3 }), 'kept');
await check('dice bad', () => random({ kind: 'dice', dice: '3x6' }), 'dice notation');
await check('uuid', () => random({ kind: 'uuid' }), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
await check('choice unique', () => random({ kind: 'choice', items: ['a', 'b'], count: 3, unique: true }), 'Cannot pick 3 unique');
await check('coin', () => random({ kind: 'coin', count: 10 }), 'heads');
await check('choice objects', () => random({ kind: 'choice', items: [{ a: 1 }], count: 1 }), '{"a":1}');
await check('bytes', () => random({ kind: 'bytes', length: 4 }), /hex: [0-9a-f]{8}/);
await check('bad count', () => random({ count: 0 }), 'count must be an integer');

// ---- text_stats, diff -----------------------------------------------------------
group('text');
await check('stats basic', () => textStats({ text: 'Hello world. How are you?\n\nNew paragraph.\n' }), 'words: 7', 'sentences: 3', 'paragraphs: 2', 'lines: 3 (1 blank)');
await check('stats emoji', () => textStats({ text: '👍🏽 é' }), 'characters: 3', 'code points: 4');
await check('stats hygiene', () => textStats({ text: 'a  \r\nb\nc' }), 'MIXED', 'no final newline', 'trailing whitespace: 1');
await check('stats invisible', () => textStats({ text: 'pass​word' }), 'U+200B');
await check('stats empty', () => textStats({ text: '' }), 'words: 0', 'lines: 0');
await check('stats both', () => textStats({ text: 'a', path: 'b' }), 'not both');
const bin = await file('bin.dat', Buffer.from([0xff, 0xfe, 0x00, 0x80]));
await check('stats binary', () => textStats({ path: bin }), 'not valid UTF-8');
await check('stats missing file', () => textStats({ path: join(scratch, 'nope.txt') }), 'File not found');
await check('diff identical', () => diff({ a: 'x', b: 'x' }), 'Identical');
await check('diff lines', () => diff({ a: 'a\nb\nc\nd\n', b: 'a\nB\nc\nd\ne\n' }), '-b', '+B', '+e', '@@ -1,4 +1,5 @@', '2 line(s) removed'.replace('2', '1'));
await check('diff insert at top', () => diff({ a: 'b\nc\n', b: 'a\nb\nc\n' }), '@@ -1,2 +1,3 @@', '+a');
await check('diff pure insert no context', () => diff({ a: 'b\nc\n', b: 'a\nb\nc\n', context: 0 }), '@@ -0,0 +1,1 @@');
await check('diff delete all', () => diff({ a: 'a\nb\n', b: '' }), '-a', '-b');
await check('diff crlf', () => diff({ a: 'a\r\nb\r\n', b: 'a\nb\n' }), 'No line differences', 'line endings differ');
await check('diff no final newline', () => diff({ a: 'a\nb', b: 'a\nb\n' }), 'ends with a newline');
await check('diff ignore ws', () => diff({ a: 'a  b\n', b: 'a b\n', ignore_whitespace: true }), 'after normalization');
await check('diff words', () => diff({ a: 'the quick brown fox', b: 'the slow brown dog', mode: 'word' }), 'the [-quick-]{+slow+} brown [-fox-]{+dog+}');
await check('diff chars', () => diff({ a: 'color', b: 'colour', mode: 'char' }), 'colo{+u+}r');
await check('diff hunks', () => {
  const a = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 10', 'LINE 10').replace('line 90', 'LINE 90');
  return diff({ a, b });
}, '2 hunk(s)', '@@ -8,7 +8,7 @@', '@@ -88,7 +88,7 @@');
await check('diff large different', () => {
  const a = Array.from({ length: 6000 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 6000 }, (_, i) => `b${i}`).join('\n');
  return diff({ a, b, context: 0 });
}, '6000 line(s) removed, 6000 added', 'block replacement');
await check('diff minimal', () => {
  // classic Myers example: ABCABBA -> CBABAC has edit distance 5
  return diff({ a: 'ABCABBA'.split('').join('\n'), b: 'CBABAC'.split('').join('\n') });
}, '3 line(s) removed, 2 added');

// ---- regex ----------------------------------------------------------------------
group('regex');
await check('groups', () => regexTest({ pattern: '(\\d{4})-(\\d{2})', text: 'a 2026-10 b\nc 1999-01' }), '2 match(es)', 'line 1, col 3: "2026-10"  $1="2026" $2="10"', 'line 2, col 3');
await check('named', () => regexTest({ pattern: '/(?<y>\\d{4})/g', text: 'x 2026' }), 'y="2026"');
await check('replace', () => regexTest({ pattern: '(\\w+)@(\\w+)', flags: 'g', text: 'a@b c@d', replace: '$2 at $1' }), 'b at a d at c');
await check('replace first', () => regexTest({ pattern: 'a', text: 'aaa', replace: 'b' }), 'first match only', 'baa');
await check('cases', () => regexTest({ pattern: '^\\d+$', cases: ['123', '12a', ''] }), '✓ full match  "123"', '✗ no match  "12a"');
await check('partial case', () => regexTest({ pattern: '\\d+', cases: ['ab12'] }), '~ partial match "12"');
await check('zero-length', () => regexTest({ pattern: '\\b', text: 'ab cd' }), '4 match(es)');
await check('invalid', () => regexTest({ pattern: '(unclosed', text: 'x' }), 'Invalid regex');
await check('bad flags', () => regexTest({ pattern: 'a', flags: 'gg', text: 'x' }), 'Invalid flags');
await check('catastrophic', () => regexTest({ pattern: '^(a+)+$', text: 'a'.repeat(40) + '!', timeout_ms: 500 }), 'timed out', 'catastrophic backtracking');
await check('unicode', () => regexTest({ pattern: '\\p{L}+', flags: 'u', text: 'Grüße 東京' }), '2 match(es)', '"Grüße"', '"東京"');

// ---- encode, hash ---------------------------------------------------------------
group('encode');
const enc = (op, text, ...expected) => check(`${op} ${JSON.stringify(text).slice(0, 30)}`, () => encode({ op, text }), ...expected);
await enc('base64_encode', 'Grüße', 'R3LDvMOfZQ==');
await enc('base64_decode', 'R3LDvMOfZQ==', 'Grüße');
await enc('base64_decode', 'R3LDvMOfZQ', 'Grüße');
await enc('base64_decode', 'R3LD vMOf\nZQ==', 'Grüße');
await enc('base64_decode', 'iVBORw0KGgo=', 'binary data, 8 bytes', 'PNG image', '89 50 4e 47');
await enc('base64_decode', 'abc$', 'Not base64');
await enc('base64_decode', 'abcde', 'length is impossible');
await enc('base64url_encode', 'ÿþ?', 'w7_Dvj8');
await enc('hex_encode', 'AB', '4142');
await enc('hex_decode', '0x41 42', 'AB');
await enc('hex_decode', 'abc', 'Not hex');
await enc('url_encode', 'a b&c=ü', 'a%20b%26c%3D%C3%BC');
await enc('url_decode', 'a+b%20c', 'a b c');
await enc('url_decode', '%E0%A4%A', 'Malformed');
await enc('html_escape', '<a href="x">&</a>', '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
await enc('html_unescape', '&lt;b&gt; &amp;amp; &#x1F600; &auml; &bogus;', '<b> &amp; 😀 ä &bogus;');
await enc('json_escape', 'line\n"q"', '"line\\n\\"q\\""');
await enc('json_unescape', 'a\\tb\\u00e9', 'a\tbé');
await enc('unicode_escape', 'é😀', '\\u00e9\\u{1f600}');
await enc('unicode_unescape', '\\u00e9\\u{1F600}\\x41', 'é😀A');
await enc('punycode_encode', 'münchen.de', 'xn--mnchen-3ya.de');
await enc('punycode_decode', 'xn--mnchen-3ya.de', 'münchen.de');
await enc('rot13', 'Hello', 'Uryyb');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
await enc('jwt_decode', `${b64u({ alg: 'HS256' })}.${b64u({ sub: '1', exp: 1000 })}.sig`, '"alg": "HS256"', 'status: EXPIRED', 'NOT verified');
await enc('jwt_decode', 'a.b', '3 dot-separated parts');
await enc('inspect', 'a​é', 'U+200B', 'FORMAT (invisible)', 'c3 a9');
await check('decode to file', async () => {
  const out = join(scratch, 'decoded.bin');
  const r = await encode({ op: 'base64_decode', text: 'iVBORw0KGgo=', out_path: out });
  return r + ' / ' + (await readFile(out)).length;
}, 'wrote 8 bytes', 'PNG image', '/ 8');
await check('decode no overwrite', () => encode({ op: 'base64_decode', text: 'QQ==', out_path: join(scratch, 'decoded.bin') }), 'already exists');
await check('unknown op', () => encode({ op: 'nope', text: 'x' }), 'Unknown op');
group('hash');
await check('sha256 empty', () => hash({ text: '' }), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
await check('multi', () => hash({ text: 'abc', algorithms: ['md5', 'sha1', 'crc32'] }), 'md5: 900150983cd24fb0d6963f7d28e17f72', 'sha1: a9993e364706816aba3e25717850c26c9cd0d89d', 'crc32: 352441c2');
await check('hmac', () => hash({ text: 'The quick brown fox jumps over the lazy dog', key: 'key', algorithms: ['sha256'] }), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
await check('expected ok', () => hash({ text: 'abc', algorithms: ['sha256'], expected: 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD' }), 'MATCHES expected');
await check('expected bad', () => hash({ text: 'abc', expected: 'deadbeef' }), 'does NOT match');
await check('file stream', () => hash({ path: bin, algorithms: ['sha256'] }), 'bin.dat (4 B)');
await check('bad algo', () => hash({ text: 'x', algorithms: ['sha999'] }), 'Unknown algorithm');

// ---- json -----------------------------------------------------------------------
group('json');
const js = (args, ...expected) => check(`${args.op ?? 'validate'} ${JSON.stringify(args.text ?? '').slice(0, 30)}`, () => jsonTool(args), ...expected);
await js({ text: '{"a": [1, 2, {"b": null}]}' }, '✓ valid JSON (top level: object, 1 keys)');
await js({ text: '{"a": 1,}' }, 'line 1, column 9: trailing comma before "}"', '^');
await js({ text: '[1, 2,]' }, 'trailing comma before "]"');
await js({ text: "{'a': 1}" }, "double quotes, not '");
await js({ text: '{a: 1}' }, 'keys must be double-quoted');
await js({ text: '{"a": 1 "b": 2}' }, 'missing comma?');
await js({ text: '{"a": NaN}' }, 'NaN is not valid JSON');
await js({ text: '// hi\n{}' }, 'comments are not allowed');
await js({ text: '{"a": "x\ny"}' }, 'unescaped newline');
await js({ text: '{"a": 01}' }, 'leading zeros');
await js({ text: '{"a": 1}{"b": 2}' }, 'several values?');
await js({ text: '' }, 'unexpected end of input');
await js({ text: '{"a": 1, "a": 2}' }, '✓ valid', 'duplicate key "a"');
await js({ text: '{"id": 12345678901234567890}' }, 'loses precision');
await js({ text: '\n\n  {"a": [1,\n   2 3]}' }, 'line 4, column 6');
await js({ text: '[' + '['.repeat(3000) + ']'.repeat(3001) }, 'nesting deeper than 2000');
await js({ op: 'format', text: '{"b":1,"a":[1,2]}', sort_keys: true }, '{\n  "a": [\n    1,');
await js({ op: 'minify', text: '{ "a" : [ 1 , 2 ] }' }, '{"a":[1,2]}');
await js({ op: 'format', text: '{"a":1}', indent: 0 }, '{"a":1}');
await js({ text: '﻿{}' }, '✓ valid');
const data = JSON.stringify({ users: [{ name: 'Ann', tags: ['x'] }, { name: 'Bob', age: 3 }], 'odd key': { id: 7 } });
await js({ op: 'query', text: data, path_expr: '$.users[*].name' }, '2 match(es)', '$.users[0].name = "Ann"', '$.users[1].name = "Bob"');
await js({ op: 'query', text: data, path_expr: 'users[-1].age' }, '$.users[1].age = 3');
await js({ op: 'query', text: data, path_expr: '$["odd key"].id' }, '= 7');
await js({ op: 'query', text: data, path_expr: '$..id' }, '1 match(es)');
await js({ op: 'query', text: data, path_expr: '$.nope' }, 'No match');
await js({ op: 'query', text: data, path_expr: '$.users[' }, 'Cannot parse path');
await js({ op: 'structure', text: data }, '$.users: array [2]', '$.users[*].age: number (in 1/2)', '$["odd key"].id: number');
await js({ op: 'validate', lines: true, text: '{"a":1}\n{"b":\n\n[1]' }, '✗ 1 invalid of 3', 'line 2');

// ---- color ----------------------------------------------------------------------
group('color');
await check('hex', () => color({ color: '#3a86ff' }), 'rgb: rgb(58 134 255)', 'hsl: hsl(216.9 100% 61.4%)');
await check('short hex alpha', () => color({ color: '#f008' }), 'hex: #ff000088', '/ 0.533');
await check('named', () => color({ color: 'RebeccaPurple' }), 'hex: #663399', 'CSS name: rebeccapurple');
await check('rgb commas', () => color({ color: 'rgba(255, 0, 0, 0.5)' }), 'hex: #ff000080');
await check('rgb pct', () => color({ color: 'rgb(100% 50% 0%)' }), 'hex: #ff8000');
await check('hsl', () => color({ color: 'hsl(120deg 100% 25%)' }), 'hex: #008000', 'CSS name: green');
await check('hwb', () => color({ color: 'hwb(0 0% 0%)' }), 'hex: #ff0000');
await check('oklch roundtrip', () => color({ color: 'oklch(62.8% 0.2577 29.23)' }), 'hex: #ff0000');
await check('out of gamut', () => color({ color: 'oklch(70% 0.4 150)' }), 'clipped');
await check('triple', () => color({ color: '10, 20, 30' }), 'hex: #0a141e');
await check('contrast pass', () => color({ color: 'black', against: 'white' }), '21.00:1', 'AAA normal text (7): pass');
await check('contrast fail + fix', () => color({ color: '#999999', against: '#ffffff' }), 'AA normal text (4.5): FAIL', 'closest text color passing AA');
await check('contrast alpha', () => color({ color: 'rgba(0,0,0,0.5)', against: 'white' }), 'after alpha compositing');
await check('shades', () => color({ color: '#3a86ff', palette: 'shades' }), ' 50: #', '950: #');
await check('harmony', () => color({ color: 'red', palette: 'harmony' }), 'complementary:', 'triadic:');
await check('bad color', () => color({ color: 'notacolor' }), 'Unknown color');
await check('bad fn', () => color({ color: 'rgb(1 2)' }), 'needs 3 components');

// ---- secret_scan ----------------------------------------------------------------
group('secrets');
const fakeGh = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const fakeAws = 'AKIA' + 'IOSFODNN7EXAMPLQ';
const fakeAnt = 'sk-ant-' + 'api03-' + 'x'.repeat(40) + 'Y7'.repeat(30);
// fixtures are assembled at runtime so the repository itself scans clean
const fakeDbUrl = 'postgres://admin' + ':' + 'S3cr3tPw' + '@db.local/app';
const sampleKeyValue = 'q8Zr2LmX9v' + 'B4nK7pW1sT';
const secretText = `token = "${fakeGh}"\naws_key=${fakeAws}\nANTHROPIC_API_KEY=${fakeAnt}\npassword = "changeme"\nDB=${fakeDbUrl}\napi_key: "${sampleKeyValue}"\n`;
const scanOut = await check('text', () => secretScan({ text: secretText }), 'GitHub token', 'AWS access key ID', 'Anthropic API key', 'URL with password', 'Possible secret in "api_key"', '!changeme', `!${fakeGh}`, `!${fakeAnt}`);
await check('masked', async () => scanOut, /ghp_A1…r8 \(40 chars\)/);
await check('clean', () => secretScan({ text: 'const x = process.env.API_KEY;\npassword = "${PASSWORD}"' }), 'No secrets found');
await check('code is not a secret', () => secretScan({ text: [
  'const token = _meta?.progressToken;',
  'const tokens = Math.round(codePoints / 4);',
  'const UNIT_TOKEN = /\\s*(?:(\\d+)|([A-Za-z_]+))/y;',
  'passwordField.value = getUserInput();',
  'API_KEY=${API_KEY}',
].join('\n') }), 'No secrets found');
await check('config line', () => secretScan({ text: 'export DB_PASSWORD=Hj7kL9mN2pQ4rS6t' }), 'Possible secret in "DB_PASSWORD"');
const repo = join(scratch, 'repo');
await file('repo/src/config.js', `export const key = "${fakeGh}";\n`);
await file('repo/node_modules/dep/index.js', `const k = "${fakeGh}";\n`);
await file('repo/.env', `SECRET_TOKEN=Zx9Qw8Er7Ty6Ui5Op4As3\n`);
await file('repo/img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
await check('folder', () => secretScan({ path: repo }), 'scanned 2 file(s)', 'skipped 1 binary', 'vendor/VCS dirs', /src[\\/]config\.js:1:/, '.env:1:', '!index.js');
await check('high only', () => secretScan({ path: repo, min_confidence: 'high' }), '1 potential secret');

// ---- wait_for -------------------------------------------------------------------
group('wait_for');
const later = join(scratch, 'later.txt');
setTimeout(() => writeFile(later, 'x'), 300);
await check('file appears', () => waitFor({ condition: 'file_exists', target: later, timeout_s: 5, interval_ms: 100 }), '✓ file_exists');
await check('file stable', () => waitFor({ condition: 'file_stable', target: later, stable_s: 0.3, timeout_s: 5, interval_ms: 100 }), '✓ file_stable', 'unchanged for');
await check('timeout', () => waitFor({ condition: 'file_exists', target: join(scratch, 'never'), timeout_s: 0.3, interval_ms: 100 }), 'Timed out after 0.3s', 'missing');
await check('port closed', () => waitFor({ condition: 'port_closed', target: '127.0.0.1:1', timeout_s: 3 }), '✓ port_closed');
await check('process exit', () => waitFor({ condition: 'process_exit', target: 999999, timeout_s: 2 }), '✓ process_exit');
await check('process alive', () => waitFor({ condition: 'process_exit', target: process.pid, timeout_s: 0.2 }), 'Timed out', 'running');
await check('bad condition', () => waitFor({ condition: 'nope', target: 'x' }), 'condition must be');
await check('no listener leak', async () => {
  const { getEventListeners } = await import('node:events');
  const ac = new AbortController();
  await waitFor({ condition: 'file_exists', target: join(scratch, 'never'), timeout_s: 1.2, interval_ms: 100 }, { signal: ac.signal }).catch(() => {});
  return `listeners left: ${getEventListeners(ac.signal, 'abort').length}`;
}, 'listeners left: 0');
await check('cancel', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  return waitFor({ condition: 'file_exists', target: join(scratch, 'never'), timeout_s: 30 }, { signal: ac.signal });
}, 'Cancelled');

// ---- benchmark ------------------------------------------------------------------
group('benchmark');
await check('compare', () => benchmark({ commands: ['node -e "0"', 'node -e "let s=0;for(let i=0;i<3e7;i++)s+=i"'], runs: 3, warmup: 0 }), 'mean', 'median', 'fastest (by median): node -e "0"', '× slower');
await check('failure', () => benchmark({ commands: ['node -e "process.exit(3)"'], runs: 2, warmup: 0 }), 'failed: exit code 3');
await check('timeout', () => benchmark({ commands: ['node -e "setTimeout(()=>{},5000)"'], runs: 1, warmup: 0, timeout_s: 0.5 }), 'timed out after 0.5s');
await check('bad cwd', () => benchmark({ commands: ['echo'], cwd: join(scratch, 'nope') }), 'cwd is not a directory');

// ---- snapshot -------------------------------------------------------------------
group('snapshot');
const proj = join(scratch, 'proj');
await file('proj/a.txt', 'alpha');
await file('proj/sub/b.txt', 'beta');
await file('proj/dup.txt', 'alpha');
await file('proj/node_modules/x.js', 'ignored');
await file('proj/build.log', 'log');
const created = await check('create', () => snapshot({ op: 'create', path: proj, label: 'first', exclude: ['*.log'] }), '3 files', 'rest deduplicated');
const id = /snapshot (\S+)/.exec(created)?.[1];
await check('list', () => snapshot({ op: 'list' }), id, '"first"');
await check('diff clean', () => snapshot({ op: 'diff', id }), 'No changes');
await writeFile(join(proj, 'a.txt'), 'ALPHA changed');
await rm(join(proj, 'sub'), { recursive: true });
await file('proj/new/c.txt', 'new');
await check('diff changes', () => snapshot({ op: 'diff', id }), 'modified (1)', 'a.txt', 'added (1)', 'new/c.txt', 'removed (1)', 'sub/b.txt');
await check('dry run', () => snapshot({ op: 'restore', id, dry_run: true }), 'would:', 'DELETE (not in snapshot)');
await check('still changed after dry run', async () => readFile(join(proj, 'a.txt'), 'utf8'), 'ALPHA changed');
const restored = await check('restore', () => snapshot({ op: 'restore', id }), 'safety snapshot', '1 overwritten, 1 recreated, 1 deleted');
await check('restored content', async () => [await readFile(join(proj, 'a.txt'), 'utf8'), await readFile(join(proj, 'sub/b.txt'), 'utf8'), await readFile(join(proj, 'node_modules/x.js'), 'utf8'), await readFile(join(proj, 'build.log'), 'utf8')].join(','), 'alpha,beta,ignored,log');
await check('new dir removed', async () => (await import('node:fs')).existsSync(join(proj, 'new')) ? 'exists' : 'gone', 'gone');
const safetyId = /safety snapshot of the current state: (\S+)/.exec(restored)?.[1];
await check('undo restore', () => snapshot({ op: 'restore', id: safetyId }), 'restored');
await check('undo content', async () => readFile(join(proj, 'a.txt'), 'utf8'), 'ALPHA changed');
await check('restore elsewhere', () => snapshot({ op: 'restore', id, path: join(scratch, 'copy') }), 'restored 3 files into');
await check('restore elsewhere not empty', () => snapshot({ op: 'restore', id, path: proj + '_x' }).then(() => snapshot({ op: 'restore', id, path: proj + '_x' })), 'not empty');
await check('mtime kept', async () => {
  const t = new Date('2020-01-01T00:00:00Z');
  await utimes(join(proj, 'dup.txt'), t, t);
  const s = await snapshot({ op: 'create', path: proj });
  const sid = /snapshot (\S+)/.exec(s)[1];
  await rm(join(proj, 'dup.txt'));
  await snapshot({ op: 'restore', id: sid });
  return (await import('node:fs')).statSync(join(proj, 'dup.txt')).mtime.toISOString();
}, '2020-01-01T00:00:00');
await check('restore over read-only', async () => {
  const s = await snapshot({ op: 'create', path: proj });
  const sid = /snapshot (\S+)/.exec(s)[1];
  const ro = join(proj, 'a.txt');
  await writeFile(ro, 'modified');
  await (await import('node:fs/promises')).chmod(ro, 0o444);
  await snapshot({ op: 'restore', id: sid });
  return readFile(ro, 'utf8');
}, 'ALPHA changed');
await check('delete + gc', () => snapshot({ op: 'delete', id }), 'deleted snapshot');
await check('unknown id', () => snapshot({ op: 'diff', id: 'nope' }), 'No snapshot "nope"');
await check('path traversal id', () => snapshot({ op: 'diff', id: '../../etc' }), 'id is required');
await check('not a dir', () => snapshot({ op: 'create', path: join(proj, 'a.txt') }), 'Not a directory');
await check('limit', () => snapshot({ op: 'create', path: proj, max_files: 1 }), 'More than 1 files');

// ---- solve, matrix, number_theory, finance ----------------------------------------
group('algebra');
await check('linear', () => solve({ equation: '3x + 2 = 11' }), 'x = 3');
await check('system', () => solve({ equations: ['2x + 3y = 7', 'x - y = 1'] }), 'x = 2');
await check('system fractions', () => solve({ equations: ['x + y = 1', 'x - y = 1/3'] }), 'x = 2/3');
await check('no solution', () => solve({ equations: ['x + y = 1', 'x + y = 2'] }), /no solution|inconsistent/i);
await check('underdetermined', () => solve({ equations: ['x + y = 1'] }), /free|infinitely/i);
await check('quadratic', () => solve({ equation: 'x^2 - 5x + 6 = 0' }), 'x = 2', 'x = 3');
await check('double root', () => solve({ equation: '(x-1)^2 = 0' }), 'x = 1');
await check('trig', () => solve({ equation: 'sin(x) = 0.5', range: [0, 7] }), '0.5235987');
await check('no real root', () => solve({ equation: 'x^2 + 1 = 0' }), /no real/i);
await check('nonlinear system', () => solve({ equations: ['x^2 + y^2 = 25', 'x - y = 1'] }), /x = 4|x ≈ 4/);
await check('det', () => matrix({ op: 'det', a: [[1, 2], [3, 4]] }), '-2');
await check('inverse', () => matrix({ op: 'inverse', a: '1 2; 3 4' }), '3/2');
await check('singular', () => matrix({ op: 'inverse', a: [[1, 2], [2, 4]] }), /singular|not invertible/i);
await check('multiply', () => matrix({ op: 'multiply', a: [[1, 2]], b: [[3], [4]] }), '11');
await check('dim mismatch', () => matrix({ op: 'multiply', a: [[1, 2]], b: [[3, 4]] }), /dimension|size|cannot/i);
await check('power -1', () => matrix({ op: 'power', a: [[2, 0], [0, 4]], k: -1 }), '1/4');
await check('matrix solve', () => matrix({ op: 'solve', a: [[2, 1], [1, 3]], b: [3, 5] }), 'x1 = 0.8', 'x2 = 1.4');
await check('ragged', () => matrix({ op: 'det', a: [[1, 2], [3]] }), 'row 2 has 1 entries');
await check('mersenne prime', () => numberTheory({ n: '2^61-1' }), /prime/i);
await check('factor', () => numberTheory({ n: 360 }), '2^3');
await check('semiprime', () => numberTheory({ n: '1000003 * 1000033' }), '1000003');
await check('carmichael', () => numberTheory({ n: 561 }), '3 × 11 × 17');
await check('from base', () => numberTheory({ n: 'ff', from_base: 16 }), '255');
await check('not integer', () => numberTheory({ n: '1/2' }), /integer/i);
await check('compound', () => finance({ op: 'compound', principal: 1000, rate: 5, years: 10, compounding: 1 }), '1,628.89');
await check('loan', () => finance({ op: 'loan', principal: 200000, rate: 4, years: 30 }), '954.83');
await check('loan 0%', () => finance({ op: 'loan', principal: 12000, rate: 0, years: 1 }), '1,000.00 per period');
await check('npv', () => finance({ op: 'npv', rate: 10, cashflows: [-1000, 300, 400, 500] }), '-21.04');
await check('irr', () => finance({ op: 'irr', cashflows: [-1000, 300, 400, 500] }), '8.896');
await check('cagr', () => finance({ op: 'cagr', start_value: 100, end_value: 200, years: 5 }), '14.86');
await check('doubling', () => finance({ op: 'doubling', rate: 7 }), '10.24');
await check('real rate', () => finance({ op: 'real_rate', rate: 5, inflation: 2 }), '2.94');

// ---- holidays, cron, calendar -------------------------------------------------------
group('calendar');
await check('DE BY', () => holidays({ country: 'DE', region: 'BY', year: 2026 }), 'Fronleichnam');
await check('easter', () => holidays({ country: 'DE', year: 2026 }), '2026-04-05');
await check('business days', () => holidays({ country: 'DE', start: '2026-12-21', end: '2026-12-31' }), 'Business days: 8', '1. Weihnachtstag');
await check('US observed', () => holidays({ country: 'US', year: 2026 }), '2026-07-03');
await check('GB substitute', () => holidays({ country: 'GB', year: 2027 }), '2027-12-28');
await check('bad region', () => holidays({ country: 'DE', region: 'XX', year: 2026 }), 'Unknown German state "XX"');
await check('cron weekdays', () => cron({ expression: '*/15 9-17 * * 1-5', timezone: 'UTC', start: '2026-10-31 00:00', count: 3 }), '2026-11-02 09:00');
await check('cron daily', () => cron({ expression: '@daily', timezone: 'UTC', count: 2, start: '2026-10-31 12:00' }), '2026-11-01 00:00');
await check('cron dom or dow', () => cron({ expression: '0 0 13 * 5', timezone: 'UTC', count: 3, start: '2026-01-01' }), /2026-01-09|Friday/);
await check('cron never', () => cron({ expression: '0 0 30 2 *', timezone: 'UTC' }), /never|no run/i);
await check('cron dst', () => cron({ expression: '30 2 * * *', timezone: 'Europe/Berlin', start: '2026-03-28', count: 3 }), /skip|does not exist|DST/i);
await check('cron bad', () => cron({ expression: '61 * * * *' }), /minute|range|invalid/i);
await check('month', () => calendar({ year: 2026, month: 2 }), 'February 2026');
await check('last friday', () => calendar({ query: 'last friday of november 2026' }), '2026-11-27');
await check('3rd monday', () => calendar({ query: '3rd monday of may 2027' }), '2027-05-17');
await check('iso week', () => calendar({ query: '2027-W12' }), '2027-03-22');

// ---- table, table_convert -----------------------------------------------------------
group('table');
const tcsv = 'name,city,amount\nAnn,Berlin,"1.234,5"\nBob,Paris,20\nCid,Berlin,5\n';
await check('profile', () => table({ text: tcsv }), '3 rows');
await check('group', () => table({ text: tcsv, group_by: ['city'], aggregate: ['count', 'sum(amount) as total'] }), 'Berlin', 'total');
await check('where', () => table({ text: tcsv, where: ['amount > 10'], select: ['name'] }), 'Bob', '!Cid');
await check('sort', () => table({ text: tcsv, sort: ['amount desc'], limit: 1 }), 'Ann', '!Cid');
await check('bad column', () => table({ text: tcsv, where: ['nope > 1'] }), /column/i);
await check('to markdown', () => tableConvert({ text: tcsv, to: 'markdown' }), '| name');
await check('json types', () => tableConvert({ text: 'a,b\n1,true\n,x', to: 'json' }), '"a": null');
await check('csv quoting', () => tableConvert({ text: '[{"a":"x,y","b":"q\\"r"}]', to: 'csv' }), '"x,y"');

// ---- text_transform, token_count, markdown, extract ---------------------------------
group('textx');
await check('camel', () => textTransform({ text: 'hello big world', ops: ['camel'] }), 'helloBigWorld');
await check('slug', () => textTransform({ text: 'Grüße aus München!', ops: ['slug'] }), 'gruesse-aus-muenchen');
await check('natural sort', () => textTransform({ text: 'file10\nfile2\nfile1', ops: ['sort_lines'] }), 'file1\nfile2\nfile10');
await check('dedupe crlf', () => textTransform({ text: 'a\r\nb\r\na\r\n', ops: ['dedupe_lines'] }), 'a\r\nb\r\n');
await check('wrap', () => textTransform({ text: 'aaa bbb ccc ddd', ops: ['wrap:7'] }), 'aaa bbb\nccc ddd');
await check('unknown op', () => textTransform({ text: 'x', ops: ['nope'] }), /unknown/i);
await check('tokens', () => tokenCount({ text: 'hello world '.repeat(100) }), /tokens/);
await check('md lint', () => markdown({ text: '# A\n### B\n# C\n```\ncode' }), /heading|fence/i);
await check('md toc', () => markdown({ op: 'toc', text: '# T\n## Hello World\n## Hello World\n### Ä b' }), '#hello-world-1');
await check('extract', () => extract({ text: 'Mail a@b.de, see https://x.com/a?b=1. Call +49 30 1234567 on 2026-11-02' }), 'a@b.de', 'https://x.com/a?b=1');
await check('extract url punct', () => extract({ text: 'Visit (https://example.com/page).', kinds: ['urls'] }), /https:\/\/example\.com\/page(?![).])/);

// ---- disk_usage, find_duplicates, batch_rename, archive -----------------------------
group('files');
await file('fs/d/a/big.bin', Buffer.alloc(300000, 1));
await file('fs/d/a/dup1.txt', 'same content here');
await file('fs/d/b/dup2.txt', 'same content here');
await file('fs/d/b/other.txt', 'same content herX');
await file('fs/d/c.md', '# hi');
const fsd = join(scratch, 'fs/d');
await check('disk usage', () => diskUsage({ path: fsd }), '5 files', 'a/', 'big.bin');
await check('duplicates', () => findDuplicates({ path: fsd }), '1 duplicate group(s)', 'dup1.txt', 'dup2.txt', '!other.txt', 'Nothing was deleted');
await check('no duplicates', () => findDuplicates({ path: join(fsd, 'a') }), 'no duplicates');
for (const n of ['IMG_001.JPG', 'IMG_002.JPG', 'IMG_010.JPG', 'notes.txt']) await file('fs/r/' + n, n);
const fsr = join(scratch, 'fs/r');
await check('rename preview', () => batchRename({ path: fsr, match: '*.JPG', template: 'urlaub_{n}', extension: 'jpg' }), 'IMG_001.JPG  →  urlaub_1.jpg', 'pass apply: true');
await check('preview changed nothing', async () => (await readdir(fsr)).join(','), 'IMG_001.JPG');
const renamed = await check('rename apply', () => batchRename({ path: fsr, match: '*.JPG', template: 'urlaub_{n}', extension: 'jpg', apply: true }), 'renamed 3 file(s)');
await check('rename result', async () => (await readdir(fsr)).join(','), 'urlaub_3.jpg', 'notes.txt');
await check('rename undo', () => batchRename({ undo: /undo: "([^"]+)"/.exec(renamed)?.[1] }), 'renamed back');
await check('after undo', async () => (await readdir(fsr)).join(','), 'IMG_010.JPG');
await check('rename collision', () => batchRename({ path: fsr, match: 'IMG*', template: 'same' }), 'would both become');
await check('rename case only', () => batchRename({ path: fsr, match: '*.JPG', case: 'lower', apply: true }), 'renamed 3');
await check('rename swap', async () => {
  await file('fs/s/a.txt', 'A');
  await file('fs/s/b.txt', 'B');
  await batchRename({ path: join(scratch, 'fs/s'), find: '^(a|b)$', replace: 'x$1', apply: true });
  return (await readdir(join(scratch, 'fs/s'))).join(',');
}, 'xa.txt,xb.txt');
await check('rename nothing to do', () => batchRename({ path: fsr }), 'Give find/replace');
await check('rename reserved name', () => batchRename({ path: fsr, match: 'notes.txt', template: 'CON' }), 'invalid name "CON.txt"');
const zipPath = join(scratch, 'fs/out/test.zip');
await check('zip create', () => archive({ op: 'create', path: zipPath, inputs: [fsd] }), 'created', '5 file(s)');
await check('zip list', () => archive({ path: zipPath }), 'd/a/big.bin', '5 file(s)');
await check('zip extract', () => archive({ op: 'extract', path: zipPath, out_dir: join(scratch, 'fs/unz') }), 'extracted 5');
await check('zip roundtrip', () => readFile(join(scratch, 'fs/unz/d/b/dup2.txt'), 'utf8'), 'same content here');
await check('zip no overwrite', () => archive({ op: 'extract', path: zipPath, out_dir: join(scratch, 'fs/unz') }), 'not empty');
await check('tgz roundtrip', async () => {
  await archive({ op: 'create', path: join(scratch, 'fs/out/t.tar.gz'), inputs: [fsd] });
  await archive({ op: 'extract', path: join(scratch, 'fs/out/t.tar.gz'), out_dir: join(scratch, 'fs/untar') });
  return (await readFile(join(scratch, 'fs/untar/d/a/big.bin'))).length;
}, '300000');
await check('tar long unicode name', async () => {
  const long = 'x'.repeat(60) + '/' + 'ü'.repeat(70) + '.txt';
  await file('fs/ln/' + long, 'deep');
  await archive({ op: 'create', path: join(scratch, 'fs/out/ln.tar'), inputs: [join(scratch, 'fs/ln')] });
  await archive({ op: 'extract', path: join(scratch, 'fs/out/ln.tar'), out_dir: join(scratch, 'fs/unln') });
  return readFile(join(scratch, 'fs/unln/ln', long), 'utf8');
}, 'deep');
const evilZip = await (async () => {
  // a zip whose single entry is "../evil.txt"
  const name = Buffer.from('../evil.txt'), data = Buffer.from('pwned'), crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(5, 18); local.writeUInt32LE(5, 22); local.writeUInt16LE(name.length, 26);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(5, 20); cen.writeUInt32LE(5, 24); cen.writeUInt16LE(name.length, 28);
  const body = Buffer.concat([local, name, data]), cd = Buffer.concat([cen, name]), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(body.length, 16);
  return file('fs/evil.zip', Buffer.concat([body, cd, end]));
})();
await check('zip slip list', () => archive({ path: evilZip }), 'unsafe paths');
await check('zip slip extract', () => archive({ op: 'extract', path: evilZip, out_dir: join(scratch, 'fs/evilout') }), 'skipped 1', '(unsafe path)');
await check('zip slip contained', async () => ((await readdir(join(scratch, 'fs'))).includes('evil.txt') ? 'ESCAPED' : 'safe'), 'safe');
await check('gz bomb', async () => {
  await writeFile(join(scratch, 'fs/bomb.gz'), zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024)));
  return archive({ op: 'extract', path: join(scratch, 'fs/bomb.gz'), max_mb: 10 });
}, 'exceeds');
await check('not a zip', () => archive({ path: join(fsd, 'c.md'), format: 'zip' }), 'Not a zip');

// ---- processes, sysinfo, run_parallel, log_summary, env_compare ---------------------
group('system');
await check('sysinfo', () => sysinfo({ gpu: false }), 'os:', 'memory:', 'disks:', 'node');
await check('processes', () => processes({ name: 'node', top: 3 }), 'process(es) matching "node"');
const listener = nodeNet.createServer().listen(0, '127.0.0.1');
await new Promise((r) => listener.once('listening', r));
await check('who uses port', () => processes({ op: 'port', port: listener.address().port }), `PID ${process.pid}`);
listener.close();
await check('free port', () => processes({ op: 'port', port: 1 }), 'Nothing is listening');
await check('kill refuses self', () => processes({ op: 'kill', pid: process.pid }), 'Refusing');
await check('parallel', () => runParallel({ commands: ['node -e "console.log(11)"', 'node -e "process.exit(2)"', 'node -e "console.error(\'oops\')"'] }), '2 ok, 1 failed', '│ 11', 'exit 2', '  ! oops');
await check('parallel timeout', () => runParallel({ commands: ['node -e "setTimeout(()=>{},9000)"'], timeout_s: 1 }), 'TIMEOUT');
await check('parallel bad', () => runParallel({ commands: [] }), 'non-empty list');
const logText = Array.from({ length: 300 }, (_, i) => `2026-10-31 10:${String(i % 60).padStart(2, '0')}:00 ${i % 10 === 0 ? 'ERROR' : 'INFO'} user ${i} ${i % 10 === 0 ? `failed to connect to 10.0.0.${i % 250}` : `logged in after ${i}ms`}`).join('\n') +
  '\n2026-10-31 11:00:00 ERROR crash\n    at foo (a.js:1)\n    at bar (b.js:2)';
await check('log summary', () => logSummary({ text: logText }), '303 lines', '3 distinct', 'ERROR 31, INFO 270', '30×', '270×', '↳ at foo');
await check('log file', async () => logSummary({ path: await file('fs/app.log', logText) }), 'app.log', 'time span: 2026-10-31 10:00:00');
await file('fs/e/.env', 'A=1\nB=\nexport C="multi\nline"\nD=your_key_here\nX=2\nA=3\n');
await file('fs/e/.env.example', 'A=\nB=\nC=\nD=your_key_here\nE=\n');
await check('env compare', () => envCompare({ dir: join(scratch, 'fs/e') }), 'missing in .env (1): E', 'empty values (1): B', 'placeholder (1): D', 'not documented in the example (1): X', 'defined twice', '!your_key_here');
await check('env keys hidden', () => envCompare({ dir: join(scratch, 'fs/e'), show_keys: true }), 'C: set (10 chars)', '!multi');
await check('env none', () => envCompare({ dir: fsd }), 'Neither');

// ---- http, net (local parts) ---------------------------------------------------------
group('net');
const web = nodeHttp.createServer((req, res) => {
  if (req.url === '/r') return res.writeHead(302, { location: '/json' }).end();
  if (req.url === '/json') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"n":[1,2]}');
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => res.writeHead(201).end(`got ${req.method} ${b}`));
}).listen(0, '127.0.0.1');
await new Promise((r) => web.once('listening', r));
const webPort = web.address().port;
await check('http redirect', () => httpTool({ url: `http://127.0.0.1:${webPort}/r` }), '→ 200 OK', 'redirects: 302', '"ok": true');
await check('http post json', () => httpTool({ url: `127.0.0.1:${webPort}/x`, json: { a: 1 } }), '201', 'got POST {"a":1}');
await check('http refused', () => httpTool({ url: 'http://127.0.0.1:1/' }), 'connection refused');
await check('net reach local', () => netTool({ op: 'reach', host: '127.0.0.1', port: webPort, attempts: 1 }), 'open');
await check('net reach closed', () => netTool({ op: 'reach', host: '127.0.0.1', port: 1, attempts: 1, timeout_s: 1 }), 'not reachable');
web.close();

// ---- sqlite, schema -------------------------------------------------------------------
group('data');
// node:sqlite exists from Node 22.5; on older Node the tool must explain that instead
const sqliteMod = await import('node:sqlite').catch(() => null);
if (sqliteMod) {
  const dbFile = join(scratch, 'fs/x.db');
  const tdb = new sqliteMod.DatabaseSync(dbFile);
  tdb.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, note TEXT); INSERT INTO users(name, note) VALUES ('Ann', 'a'), ('Bob', NULL), ('Cid', 'line1\nline2'); CREATE VIEW v AS SELECT name FROM users;");
  tdb.close();
  await check('sqlite tables', () => sqlite({ path: dbFile }), 'table users (3 rows)', 'id INTEGER PK', 'view v');
  await check('sqlite query', () => sqlite({ path: dbFile, sql: 'SELECT * FROM users WHERE id > ?', params: [1] }), '2 row(s)', 'Bob', 'NULL', 'line1⏎line2');
  await check('sqlite schema', () => sqlite({ path: dbFile, op: 'schema', table: 'users' }), 'CREATE TABLE users');
  await check('sqlite write refused', () => sqlite({ path: dbFile, sql: 'DELETE FROM users' }), 'read-only');
  await check('sqlite cte write blocked', () => sqlite({ path: dbFile, sql: 'WITH x AS (SELECT 1) DELETE FROM users' }), /readonly|read-only|SQL error/i);
  await check('sqlite one statement', () => sqlite({ path: dbFile, sql: 'SELECT 1; DROP TABLE users' }), 'One statement');
  await check('sqlite intact', () => sqlite({ path: dbFile, sql: 'SELECT count(*) AS n FROM users' }), '3');
  await check('sqlite bad sql', () => sqlite({ path: dbFile, sql: 'SELECT nope FROM users' }), 'SQL error');
} else {
  await check('sqlite needs newer node', async () => sqlite({ path: await file('fs/x.db', 'x') }), 'needs Node.js 22.5');
}
const userSchema = JSON.stringify({ type: 'object', required: ['id', 'email'], properties: { id: { type: 'integer', minimum: 1 }, email: { type: 'string', format: 'email' }, tags: { type: 'array', items: { type: 'string' }, uniqueItems: true } }, additionalProperties: false });
await check('schema valid', () => schemaTool({ data: '{"id":1,"email":"a@b.de","tags":["x"]}', schema: userSchema }), '✓ valid');
await check('schema errors', () => schemaTool({ data: '{"id":0,"email":"nope","tags":["x","x"],"extra":1}', schema: userSchema }), '/id: 0 < minimum 1', '/email: not a valid email', '/tags: items are not unique', '/extra: property not allowed');
await check('schema each', () => schemaTool({ data: '[{"id":1,"email":"a@b.de"},{"id":"2"}]', schema: userSchema, each: true }), '1 of 2 items invalid', '/1/id: expected integer');
await check('schema ref', () => schemaTool({ data: '{"a":{"b":"x"}}', schema: JSON.stringify({ $defs: { s: { type: 'number' } }, properties: { a: { properties: { b: { $ref: '#/$defs/s' } } } } }) }), '/a/b: expected number');
await check('schema oneOf', () => schemaTool({ data: '5', schema: '{"oneOf":[{"type":"integer"},{"minimum":0}]}' }), 'matches 2');
await check('schema infer', () => schemaTool({ data: '[{"id":1,"at":"2026-10-31T10:00:00Z","s":"a"},{"id":2,"at":"2026-10-31T11:00:00Z"}]', samples_are_array: true }), '"format": "date-time"', '"required": [\n    "id",\n    "at"\n  ]');
await check('schema bad json', () => schemaTool({ data: '{nope', schema: '{}' }), 'data is not valid JSON');

// ---- pdf_text ---------------------------------------------------------------------------
group('pdf');
function makePdf(pages, { a85 = false } = {}) {
  const objs = [];
  const add = (s) => (objs.push(s), objs.length);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const dingbats = add('<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>');
  const pagesId = objs.length + 1 + pages.length * 2;
  const kids = [];
  for (const [l1, l2] of pages) {
    let content = zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${l1}) Tj /F2 12 Tf (4) Tj /F1 12 Tf 0 -14 Td [(${l2}) -300 (end)] TJ ET`, 'latin1'));
    let filter = '/FlateDecode';
    if (a85) {
      let s = '';
      for (let i = 0; i < content.length; i += 4) {
        const chunk = content.subarray(i, i + 4);
        let v = 0;
        for (let k = 0; k < 4; k++) v = v * 256 + (chunk[k] ?? 0);
        let enc = '';
        for (let k = 0; k < 5; k++, v = Math.floor(v / 85)) enc = String.fromCharCode(33 + (v % 85)) + enc;
        s += enc.slice(0, chunk.length + 1);
      }
      content = Buffer.from(s + '~>', 'latin1');
      filter = '[/ASCII85Decode /FlateDecode]';
    }
    const c = add(`<< /Length ${content.length} /Filter ${filter} >>\nstream\n${content.toString('latin1')}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /Contents ${c} 0 R >>`));
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} /Resources << /Font << /F1 ${font} 0 R /F2 ${dingbats} 0 R >> >> >>`);
  const cat = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const pdfFile = await file('fs/t.pdf', makePdf([['Hello World', 'Gr\xfc\xdfe aus K\xf6ln'], ['Second page', 'Invoice total 42']]));
await check('pdf text', () => pdfText({ path: pdfFile }), '2 page(s)', '--- page 1 ---\nHello World✔\nGrüße aus Köln end', '--- page 2 ---\nSecond page');
await check('pdf ascii85', async () => pdfText({ path: await file('fs/a85.pdf', makePdf([['Encoded', 'Text']], { a85: true })) }), 'Encoded✔\nText end');
await check('pdf range', () => pdfText({ path: pdfFile, pages: '2-' }), 'Second page', '!Hello');
await check('pdf search', () => pdfText({ path: pdfFile, search: 'TOTAL' }), 'found on 1 page(s)', 'page 2 (1×)', 'Invoice total 42');
await check('pdf bad range', () => pdfText({ path: pdfFile, pages: 'x' }), 'Bad page range');
await check('pdf not pdf', () => pdfText({ path: join(fsd, 'c.md') }), 'not a PDF');
await check('pdf no text', async () => pdfText({ path: await file('fs/empty.pdf', makePdf([['', '']]).toString('latin1').replace(/\(\) Tj|\[\(\) -300 \(end\)\] TJ/g, '').replace(/\(4\) Tj/g, '')) }), /no extractable text|\(no text\)|end/i);

// ---- image_edit ---------------------------------------------------------------------------
if (HAS_FFMPEG) {
  group('image_edit');
  await mkdir(join(scratch, 'fs/img'), { recursive: true });
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=400x300', '-frames:v', '1', join(scratch, 'fs/img/a.png')]);
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480', '-frames:v', '1', join(scratch, 'fs/img/b.jpg')]);
  const img = join(scratch, 'fs/img/a.png');
  await check('resize', () => imageEdit({ path: img, width: 200 }), '200x150');
  await check('no upscale', () => imageEdit({ path: img, width: 2000, suffix: '_big' }), '400x300');
  await check('upscale', () => imageEdit({ path: img, width: 800, upscale: true, suffix: '_up' }), '800x600');
  await check('cover', () => imageEdit({ path: img, width: 100, height: 100, fit: 'cover', suffix: '_sq' }), '100x100');
  await check('contain', () => imageEdit({ path: img, width: 100, height: 100, suffix: '_c' }), '100x75');
  await check('crop rotate', () => imageEdit({ path: img, crop: { x: 10, y: 10, width: 100, height: 50 }, rotate: 90, suffix: '_cr' }), '50x100');
  await check('to webp', () => imageEdit({ path: join(scratch, 'fs/img/b.jpg'), format: 'webp', quality: 70 }), 'b_edited.webp');
  await check('exists', () => imageEdit({ path: img, width: 200 }), 'exists');
  await check('folder', () => imageEdit({ path: join(scratch, 'fs/img'), width: 50, out_dir: join(scratch, 'fs/thumbs') }), /\d+ image\(s\) processed/);
  await check('nothing to do', () => imageEdit({ path: img }), 'Nothing to do');
  await check('bad rotate', () => imageEdit({ path: img, rotate: 45 }), 'rotate must be');
}

// ---- media ----------------------------------------------------------------------
if (HAS_FFMPEG) {
  group('media');
  const vid = join(scratch, 'test.mp4');
  const wav = join(scratch, 'tone.wav');
  const png1 = join(scratch, 'img1.png'), png2 = join(scratch, 'img2.png');
  const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-pix_fmt', 'yuv420p', vid]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-filter_complex', '[1]atrim=0:1[s];[0][s]concat=n=2:v=0:a=1', wav]);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=64x48', '-frames:v', '1', png1]);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=64x48', '-vf', 'drawbox=x=10:y=5:w=4:h=3:color=red:t=fill', '-frames:v', '1', png2]);
  await check('info video', () => mediaInfo({ path: vid }), 'video #0: h264', '320x240 25 fps', '100 frames', 'audio #1: aac');
  await check('info missing', () => mediaInfo({ path: join(scratch, 'nope.mp4') }), 'File not found');
  await check('info not media', () => mediaInfo({ path: csv }), /ffprobe could not read|container: (tty|csv)/);
  await check('frames count', () => videoFrames({ path: vid, count: 4, contact_sheet: true }), '4 frame(s)', 'frame_004.jpg', 'contact sheet (2x2');
  await check('frames timestamps', () => videoFrames({ path: vid, timestamps: ['0:01', 2.5, 3.96] }), '3 frame(s)', '0:01.00', '0:03.96');
  await check('frames beyond end', () => videoFrames({ path: vid, timestamps: [10] }), 'beyond the video length');
  await check('frames every', () => videoFrames({ path: vid, every_s: 1 }), '4 frame(s)');
  await check('frames no video', () => videoFrames({ path: wav }), 'No video stream');
  await check('audio', () => audioAnalyze({ path: wav, image: 'waveform' }), 'integrated loudness:', 'silence (< -50 dB', 'trailing', 'waveform: ');
  await check('audio spectrogram', () => audioAnalyze({ path: vid, image: 'spectrogram' }), 'spectrogram: ');
  await check('compare same', () => imageCompare({ a: png1, b: png1 }), 'identical (pixel-exact)', 'PSNR: ∞');
  await check('compare diff', () => imageCompare({ a: png1, b: png2 }), '16 of 3072 pixels differ', 'box x 10–13, y 4–7', 'diff image');
  await check('compare threshold', () => imageCompare({ a: png1, b: png2, threshold: 255 }), 'identical within threshold 255');
  const big = join(scratch, 'big.png');
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=128x96', '-frames:v', '1', big]);
  await check('compare size', () => imageCompare({ a: png1, b: big }), 'Sizes differ');
  await check('compare resize', () => imageCompare({ a: png1, b: big, resize: true }), 'scaled to 64x48', 'identical');
} else {
  console.log('(skipping media tests: ffmpeg not on PATH)');
}

// ---- online ---------------------------------------------------------------------
if (ONLINE) {
  group('online');
  await check('currency', () => convertUnits({ value: 100, from: 'EUR', to: ['USD', 'CHF'] }), '100 EUR =', 'USD', 'ECB reference rates');
  await check('currency historical', () => convertUnits({ value: 1, from: 'USD', to: 'EUR', date: '2020-01-01' }), 'closest working day');
  await check('currency lowercase', () => convertUnits({ value: 1, from: 'eur', to: 'usd' }), '1 EUR =', 'USD');
  await check('currency unknown', () => convertUnits({ value: 1, from: 'EUR', to: 'XYZ' }), 'Unknown currency');
  await check('npm', () => packageInfo({ name: 'react' }), 'npm: react@', 'license: MIT');
  await check('npm scoped', () => packageInfo({ name: '@types/node' }), 'npm: @types/node@');
  await check('npm missing', () => packageInfo({ name: 'this-package-does-not-exist-tpp-xyz' }), 'does not exist');
  await check('pypi', () => packageInfo({ name: 'requests', registry: 'pypi' }), 'PyPI: requests', 'requires python');
  await check('crates', () => packageInfo({ name: 'serde', registry: 'crates' }), 'crates.io: serde');
  await check('github', () => packageInfo({ name: 'nodejs/node', registry: 'github' }), 'GitHub: nodejs/node', /latest release|rate limit/);
  await check('weather', () => weather({ place: 'Berlin', days: 2 }), 'Berlin', 'now:', 'source: Open-Meteo');
  await check('weather country', () => weather({ place: 'Paris, US' }), 'United States');
  await check('weather coords', () => weather({ place: '48.14,11.58' }), '48.14');
  await check('weather unknown', () => weather({ place: 'Xyzzyqqq' }), 'not found');
  await check('wikipedia', () => wikipedia({ query: 'Alan Turing' }), 'Alan Turing', 'url: https://en.wikipedia.org');
  await check('wikipedia de', () => wikipedia({ query: 'Berlin', lang: 'de' }), 'de.wikipedia.org');
  await file('fs/pj/package.json', JSON.stringify({ dependencies: { react: '^16.0.0', 'left-pad': '1.0.0', mine: 'file:../x' }, devDependencies: { typescript: '~4.0.0' } }));
  await check('deps npm', () => depsCheck({ path: join(scratch, 'fs/pj') }), 'major update 16 →', 'DEPRECATED', 'not from the registry', '[dev]');
  await file('fs/py/requirements.txt', 'requests>=2.0\nnumpy==1.19.0  # old\n-e .\nflask[async]~=2.0\n');
  await check('deps pypi', () => depsCheck({ path: join(scratch, 'fs/py/requirements.txt') }), '3 dependencies', 'numpy', 'major update 1 →');
  await check('net dns', () => netTool({ host: 'github.com' }), 'DNS for github.com', /A\s+\d+\.\d+/);
  await check('net tls', () => netTool({ op: 'tls', host: 'github.com' }), 'days left', 'trusted: yes');
  await check('net dns missing', () => netTool({ host: 'no-such-host-tpp.invalid' }), 'no records');
}

// ---- end-to-end over stdio ------------------------------------------------------
group('e2e');
const server = spawn(process.execPath, [fileURLToPath(new URL('../server/index.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const pending = new Map();
const notes = [];
let buffer = '';
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
    else notes.push(msg);
  }
});
let nextId = 1;
const send = (msg) => server.stdin.write(JSON.stringify(msg) + '\n');
const rpc = (method, params, id = nextId++) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 15000);
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  send({ jsonrpc: '2.0', id, method, params });
});

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await check('initialize', () => JSON.stringify(init.result), '"protocolVersion":"2025-06-18"', '"tools-plus-plus"');
  const old = await rpc('initialize', { protocolVersion: '1999-01-01' });
  await check('unknown protocol version', () => old.result.protocolVersion, '2025-06-18');
  const list = await rpc('tools/list', {});
  await check('tool count', () => String(list.result.tools.length), '55');
  await check('schemas valid', () => list.result.tools.every((t) => t.inputSchema.type === 'object' && t.description.length > 40 && !('run' in t)) ? 'ok' : 'bad', 'ok');
  const call = await rpc('tools/call', { name: 'calc', arguments: { expression: '6 * 7' } });
  await check('call', () => call.result.content[0].text, '= 42');
  const bad = await rpc('tools/call', { name: 'calc', arguments: { expression: '1/0' } });
  await check('tool error', () => JSON.stringify(bad.result), '"isError":true', 'Division by zero');
  const wrongType = await rpc('tools/call', { name: 'sqlite', arguments: { path: 42 } });
  await check('arg type check', () => wrongType.result.content[0].text, 'path must be string, got number');
  const badEnum = await rpc('tools/call', { name: 'json', arguments: { op: 'nope', text: '{}' } });
  await check('arg enum check', () => badEnum.result.content[0].text, 'op must be one of: validate');
  const missingReq = await rpc('tools/call', { name: 'calc', arguments: { expression: null } });
  await check('null counts as missing', () => missingReq.result.content[0].text, 'expression is required');
  const nullOptional = await rpc('tools/call', { name: 'calc', arguments: { expression: '1+1', digits: null } });
  await check('null optional ignored', () => nullOptional.result.content[0].text, '= 2');
  const noArgs = await rpc('tools/call', { name: 'time_now' });
  await check('missing arguments', () => noArgs.result.content[0].text, 'Local:');
  const unknownTool = await rpc('tools/call', { name: 'nope', arguments: {} });
  await check('unknown tool', () => JSON.stringify(unknownTool.error), '-32602');
  const missing = await rpc('nope', {});
  await check('unknown method', () => JSON.stringify(missing.error), '-32601');
  const big = await rpc('tools/call', { name: 'calc', arguments: { expression: '20000!' } });
  await check('output cap', () => big.result.content[0].text, /exact integer with 77338 digits|truncated/);
  const progressCall = rpc('tools/call', { name: 'wait_for', arguments: { condition: 'file_exists', target: join(scratch, 'never'), timeout_s: 30 }, _meta: { progressToken: 'p1' } }, 'w1');
  await new Promise((r) => setTimeout(r, 5800));
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'w1' } });
  const cancelled = await progressCall;
  await check('progress', () => JSON.stringify(notes), '"progressToken":"p1"');
  await check('cancel', () => cancelled.result.content[0].text, 'Cancelled');
  send('not json');
  server.stdin.write('{broken\n');
  const after = await rpc('ping', {});
  await check('survives garbage', () => JSON.stringify(after.result), '{}');
} catch (err) {
  failed++;
  console.log(`FAIL e2e: ${err.message}`);
} finally {
  server.kill();
}

await rm(scratch, { recursive: true, force: true }).catch(() => {});
console.log(`\n${passed} passed, ${failed} failed${ONLINE ? '' : ' (offline; add --online for web tests)'}`);
process.exit(failed ? 1 : 0);


