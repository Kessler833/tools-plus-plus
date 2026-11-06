// Tool registry: MCP definitions plus a lazily loaded `run(args, ctx)` that
// returns plain text (throwing reports an error to Claude). Schemas are kept
// terse on purpose: every character here is context tokens for the model.

// load a tool's module only on its first call; keeps server start fast
const lazy = (file, fn) => Object.assign(async (args, ctx) => (await import(`./lib/${file}.mjs`))[fn](args, ctx), { target: [file, fn] });

// annotations: only what differs from the MCP defaults (not read-only, destructive)
const RO = { readOnlyHint: true };
const WRITES = { destructiveHint: false };

const s = (description) => (description ? { type: 'string', description } : { type: 'string' });
const n = (description) => (description ? { type: 'number', description } : { type: 'number' });
const i = (description) => (description ? { type: 'integer', description } : { type: 'integer' });
const b = (description) => (description ? { type: 'boolean', description } : { type: 'boolean' });
const list = (description, items = { type: 'string' }) => ({ type: 'array', items, ...(description ? { description } : {}) });
const one = (values, description) => ({ type: 'string', enum: values, ...(description ? { description } : {}) });
const io = { text: s(), path: s('or a file') };

const WHEN = 'Times: now, today, YYYY-MM-DD[ HH:MM], DD.MM.YYYY[ HH:MM], HH:MM, unix. Zones: IANA, city, CET/PST; default local.';

function tool(name, description, properties, run, { required, annotations = RO } = {}) {
  const inputSchema = { type: 'object', properties };
  if (required) inputSchema.required = required;
  const def = { name, description, inputSchema, run };
  if (annotations) def.annotations = annotations;
  return def;
}

export const tools = [
  // ---- math -------------------------------------------------------------------
  tool('calc',
    'Exact calculator; use instead of mental math. Fractions and big integers exact (0.1+0.2=0.3, 100!), floats only for irrational results (marked). ' +
    'Ops + - * / ^ % (mod; postfix = percent: 200*19%) ! ; implicit 2pi; 0xff 1e3 1_000; vars "r=2; pi r^2", ans. ' +
    'Fns sqrt cbrt root(x,n) abs sign floor ceil trunc round(x,d) min max mod gcd lcm fact nCr nPr exp ln log(x,base=10) log2 sin cos tan asin acos atan atan2 sinh cosh tanh hypot; consts pi e tau phi deg (sin(30deg)).',
    { expression: s(), digits: i('significant digits, default 30') },
    async ({ expression, digits }) => (await import('./lib/calc.mjs')).calculate(expression, digits), { required: ['expression'] }),

  tool('solve',
    'Solve equations in calc syntax: linear equations/systems exactly (reports no/infinite solutions), one nonlinear equation (all real roots in range), square nonlinear systems numerically.',
    { equation: s('e.g. "3x+2=11"; no "=" means =0'), equations: list('system'), variables: list(), range: list('[min,max] for one unknown', { type: 'number' }), guess: { type: 'object', description: 'start point {x:1}' } },
    lazy('algebra', 'solve')),

  tool('matrix',
    'Exact matrix math on fractions: info, det, inverse, transpose, rref, multiply, add, subtract, power, solve (a·x=b).',
    { op: one(['info', 'det', 'inverse', 'transpose', 'rref', 'multiply', 'add', 'subtract', 'power', 'solve']), a: { type: ['array', 'string'], description: '[[1,2],[3,4]] or "1 2; 3 4"' }, b: { type: ['array', 'string'] }, k: i('power') },
    lazy('algebra', 'matrix'), { required: ['a'] }),

  tool('number_theory',
    'Integer facts (any size, expressions ok): prime test, factorization, divisors, sigma, phi, prev/next prime, digits, bases 2-36.',
    { n: { type: ['string', 'integer'] }, base: i('also show in base'), from_base: i('parse n in base') },
    lazy('algebra', 'numberTheory'), { required: ['n'] }),

  tool('finance',
    'Money math, rates in %: compound (contributions, inflation), loan (payment, interest, amortization), npv, irr, cagr, real_rate, doubling. Arithmetic, not advice.',
    {
      op: one(['compound', 'loan', 'npv', 'irr', 'cagr', 'real_rate', 'doubling']), principal: n(), rate: n('% per year (npv/irr: per period)'), years: n(), months: i('loan payments'),
      compounding: i('per year, default 12'), periods_per_year: i('loan, default 12'), contribution: n('per period'), contribution_at_start: b(), inflation: n('%'),
      cashflows: list('from t=0', { type: 'number' }), start_value: n(), end_value: n(),
    },
    lazy('algebra', 'finance'), { required: ['op'] }),

  tool('stats',
    'Statistics: mean, median, mode, sd, quartiles, outliers, percentiles, skew, histogram; with y/y_column Pearson, Spearman, linear fit. Input numbers, free text or CSV (column by name or 1-based).',
    {
      numbers: list('', { type: 'number' }), y: list('', { type: 'number' }), ...io, column: { type: ['string', 'integer'] }, y_column: { type: ['string', 'integer'] },
      delimiter: s(), percentiles: list('0-100', { type: 'number' }), histogram: b(),
    },
    lazy('stats', 'stats')),

  tool('convert_units',
    'Exact unit conversion: compound units (km/h, J/(kg*K), L/100km<->mi/gal), SI/binary prefixes, temperatures (degC/degF/K; difference for intervals), currencies (ECB, 3-letter codes). No to = SI base.',
    { value: { type: ['number', 'string'], description: 'default 1; expression ok' }, from: s(), to: { type: ['string', 'array'], items: { type: 'string' } }, digits: i(), difference: b(), date: s('currency rate date') },
    lazy('units', 'convertUnits'), { required: ['from'] }),

  tool('random',
    'Secure random: int (any size, inclusive, unique), float, normal, choice, shuffle, uuid, password, dice ("4d6kh3+2"), coin, bytes. seed = reproducible.',
    {
      kind: one(['int', 'float', 'normal', 'choice', 'shuffle', 'uuid', 'password', 'dice', 'coin', 'bytes']), count: i(), min: { type: ['number', 'string'] }, max: { type: ['number', 'string'] },
      unique: b(), items: { type: 'array' }, mean: n(), sd: n(), decimals: i(), length: i(), charset: s('lower,upper,digits,symbols'), no_ambiguous: b(), dice: s(), seed: { type: ['string', 'number'] },
    },
    lazy('random', 'random'), { annotations: null }),

  // ---- dates ------------------------------------------------------------------
  tool('time_now', 'Current date/time (weekday, ISO week, DST), UTC, unix, other zones. Use instead of guessing today.',
    { timezones: list() }, lazy('time', 'timeNow')),

  tool('time_convert', `Convert a time between zones (DST-aware, day shifts); also weekday/ISO week of a date. ${WHEN}`,
    { time: s(), from: s(), to: list() }, lazy('time', 'timeConvert')),

  tool('date_diff', `Difference between dates: calendar y/m/d, exact duration, totals, Mon-Fri weekdays. ${WHEN}`,
    { start: s(), end: s('default now'), timezone: s() }, lazy('time', 'dateDiff'), { required: ['start'] }),

  tool('date_add', `Add/subtract (negative) years, months (clamped), weeks, days, business_days, hours, minutes, seconds. ${WHEN}`,
    { start: s(), timezone: s(), years: i(), months: i(), weeks: i(), days: i(), business_days: i(), hours: n(), minutes: n(), seconds: n() },
    lazy('time', 'dateAdd')),

  tool('holidays',
    'Public holidays of a year, or business days start..end minus holidays. Built in: DE (+16 states via region, e.g. BY), AT, CH, US, GB, FR; others online.',
    { country: s('default DE'), region: s(), year: i(), start: s(), end: s(), include_end: b('default true') },
    lazy('calendar', 'holidays')),

  tool('calendar',
    'Month calendars with ISO weeks and optional holidays; query: "last friday of november 2026", "3rd monday of may 2027", "2027-W12".',
    { year: i(), month: i(), months: i('count'), country: s(), region: s(), query: s() },
    lazy('calendar', 'calendar')),

  tool('cron', 'Explain a cron expression (5/6 fields, names, @daily) and list next runs in a zone, DST-aware.',
    { expression: s(), timezone: s(), count: i('default 10'), start: s() }, lazy('calendar', 'cron'), { required: ['expression'] }),

  // ---- text and data ----------------------------------------------------------
  tool('text_stats', 'Count chars, words, sentences, lines, tokens (est.), reading time; flags mixed line endings, trailing spaces, invisible chars.',
    { ...io, top_words: i(), locale: s() }, lazy('text', 'textStats')),

  tool('text_transform',
    'Text ops in order: case (upper lower title sentence camel pascal snake kebab constant slug), trim_lines trim_trailing dedupe_lines(_ci) sort_lines(_desc) sort_by_length reverse_lines shuffle_lines ' +
    'number_lines remove_blank_lines squeeze_blank_lines count_lines, wrap:N unwrap collapse_spaces, nfc nfkc nfd strip_accents ascii remove_invisible smart_quotes_to_ascii, tabs_to_spaces lf crlf reverse trim.',
    { ...io, ops: list(), out_path: s(), in_place: b(), overwrite: b() }, lazy('textx', 'textTransform'), { required: ['ops'], annotations: WRITES }),

  tool('token_count', 'Estimate LLM tokens of text, a file or folder vs a budget; per extension and largest files.',
    { ...io, path: s('file or folder'), extensions: list(), budget: i('default 200000'), top: i() }, lazy('textx', 'tokenCount')),

  tool('diff', 'Diff two texts/files: unified line diff, or word/char inline [-old-]{+new+}; ignore whitespace/case.',
    { a: s(), a_path: s(), b: s(), b_path: s(), mode: one(['line', 'word', 'char']), context: i(), ignore_whitespace: b(), ignore_case: b() },
    lazy('text', 'diff')),

  tool('regex', 'Test a JS regex (/x/flags ok): matches with line/col and groups, replace preview, cases (full/partial/none). Timeout catches catastrophic backtracking.',
    { pattern: s(), flags: s(), ...io, replace: s(), cases: list(), max_matches: i(), timeout_ms: i() },
    lazy('regex', 'regexTest'), { required: ['pattern'] }),

  tool('extract', 'Pull items from text, deduped with counts: urls emails ipv4 ipv6 dates times phones money percentages numbers hashtags mentions hex_colors uuids hashes paths ibans versions.',
    { ...io, kinds: list(), sort: one(['first', 'count']), max: i() }, lazy('textx', 'extract')),

  tool('markdown', 'Markdown: lint, outline, toc (GitHub anchors), links (checks files and #anchors), format_tables.',
    { ...io, op: one(['lint', 'outline', 'toc', 'links', 'format_tables']), min_level: i(), max_level: i(), out_path: s(), in_place: b(), overwrite: b() },
    lazy('textx', 'markdown'), { annotations: WRITES }),

  tool('encode',
    'Encode/decode: base64(url), hex, url, html, json string, unicode escapes, punycode, rot13, jwt_decode (unverified), inspect (code points, invisible chars). Binary decode -> hexdump or out_path.',
    {
      op: one(['base64_encode', 'base64_decode', 'base64url_encode', 'hex_encode', 'hex_decode', 'url_encode', 'url_decode', 'html_escape', 'html_unescape', 'json_escape', 'json_unescape', 'unicode_escape', 'unicode_unescape', 'punycode_encode', 'punycode_decode', 'rot13', 'jwt_decode', 'inspect']),
      ...io, out_path: s(),
    },
    lazy('encode', 'encode'), { required: ['op'], annotations: WRITES }),

  tool('hash', 'Hash text or any-size file: md5 sha1 sha256 sha512 sha3-256 blake2b512 crc32; HMAC via key; expected verifies.',
    { ...io, algorithms: list('default sha256'), key: s(), expected: s(), base64: b() }, lazy('encode', 'hash')),

  tool('json', 'JSON: validate (line/col, hints, duplicate keys, precision loss), format, minify, query ($.a[*].b, ..id), structure summary; lines for JSON Lines.',
    { op: one(['validate', 'format', 'minify', 'query', 'structure']), ...io, path_expr: s(), indent: i(), sort_keys: b(), lines: b() },
    lazy('json', 'jsonTool')),

  tool('schema', 'Validate JSON against JSON Schema 2020-12 core (errors as JSON pointers; each = per array item), or infer a schema from samples.',
    { op: one(['validate', 'infer']), data: s(), data_path: s(), schema: s(), schema_path: s(), each: b(), samples_are_array: b() },
    lazy('data', 'schemaTool')),

  tool('table',
    'Query CSV/TSV/JSON/JSONL/Markdown tables. No options = profile. where ["age > 30","city = Berlin","name ~ ^A","x is empty"], select, group_by + aggregate (count sum avg min max median count_distinct list; "sum(x) as t"), sort ["x desc"], distinct, join_path+on, limit, output, out_path.',
    {
      ...io, format: one(['csv', 'tsv', 'json', 'jsonl', 'markdown']), delimiter: s(), no_header: b(), where: list(), select: list(), group_by: list(), aggregate: list(), sort: list(), distinct: b(),
      join_path: s(), on: s('col or left=right'), how: one(['inner', 'left']), limit: i(), output: one(['table', 'csv', 'tsv', 'json', 'jsonl', 'markdown', 'html']), out_path: s(), overwrite: b(),
    },
    lazy('table', 'table'), { annotations: WRITES }),

  tool('table_convert', 'Convert tables between CSV, TSV, JSON, JSONL, Markdown, HTML (JSON output typed).',
    { ...io, from: one(['csv', 'tsv', 'json', 'jsonl', 'markdown']), to: one(['csv', 'tsv', 'json', 'jsonl', 'markdown', 'html']), delimiter: s(), out_path: s(), overwrite: b() },
    lazy('table', 'tableConvert'), { required: ['to'], annotations: WRITES }),

  tool('sqlite', 'Read-only SQLite: tables (rows, columns), schema, query (one SELECT/WITH/PRAGMA, ? params).',
    { path: s(), op: one(['tables', 'schema', 'query']), sql: s(), params: { type: 'array' }, table: s(), limit: i() },
    lazy('data', 'sqlite'), { required: ['path'] }),

  tool('pdf_text', 'Text of a PDF per page (pages "1-3,7"), or search with snippets; scanned pages flagged (need OCR).',
    { path: s(), pages: s(), search: s(), max_chars: i() }, lazy('pdf', 'pdfText'), { required: ['path'] }),

  tool('color', 'Color in all notations (hex rgb hsl hsv oklch oklab, CSS name), WCAG contrast vs against + closest passing color, palette shades/harmony.',
    { color: s(), against: s(), palette: one(['shades', 'harmony']) }, lazy('color', 'color'), { required: ['color'] }),

  // ---- files and system ---------------------------------------------------------
  tool('disk_usage', 'Folder size by subfolder (depth), extension and largest files.',
    { path: s(), depth: i(), top: i() }, lazy('files', 'diskUsage'), { required: ['path'] }),

  tool('find_duplicates', 'Find identical files in a folder, grouped by reclaimable space. Deletes nothing.',
    { path: s(), min_size: i(), extensions: list(), include_vendor: b(), max_groups: i() }, lazy('files', 'findDuplicates'), { required: ['path'] }),

  tool('batch_rename', 'Rename files in a folder: find/replace (regex), case, template ({name} {n} {ext}), extension; match glob. Preview unless apply; collision-checked; undo id.',
    { path: s(), match: s(), find: s(), replace: s(), ignore_case: b(), case: one(['lower', 'upper', 'title', 'slug']), template: s(), start: i(), pad: i(), extension: s(), apply: b(), undo: s() },
    lazy('files', 'batchRename'), { annotations: WRITES }),

  tool('archive', 'List, extract, create zip/tar/tgz/gz safely (no path escape, no links, size limit, CRC check).',
    { op: one(['list', 'extract', 'create']), path: s(), format: one(['zip', 'tar', 'tgz', 'gz']), out_dir: s(), files: list(), inputs: list('create'), cwd: s(), overwrite: b(), max_mb: i() },
    lazy('files', 'archive'), { annotations: WRITES }),

  tool('snapshot', 'Folder undo points: create (dedup; skips .git/node_modules + exclude), list, diff, restore (auto-snapshots first; dry_run; path = restore elsewhere), delete.',
    { op: one(['create', 'list', 'diff', 'restore', 'delete']), path: s(), id: s(), label: s(), exclude: list(), dry_run: b(), max_files: i(), max_mb: i() },
    lazy('snapshot', 'snapshot'), { required: ['op'], annotations: null }),

  tool('secret_scan', 'Find leaked keys/tokens/passwords in text, a file or folder (skips vendor dirs, binaries). Output masked.',
    { text: s(), path: s(), min_confidence: one(['low', 'medium', 'high']), max_findings: i() }, lazy('secrets', 'secretScan')),

  tool('env_compare', '.env vs .env.example: missing, empty, placeholder, extra, duplicate keys. Never prints values.',
    { dir: s(), env: s(), example: s(), show_keys: b() }, lazy('system', 'envCompare')),

  tool('log_summary', 'Summarize a log (any size): levels, time span, errors first, frequent message patterns with lines and stack traces.',
    { ...io, top: i() }, lazy('system', 'logSummary')),

  tool('processes', 'Processes by memory/cpu (name filter), who listens on a port, all listening ports, kill a PID tree.',
    { op: one(['list', 'port', 'ports', 'kill']), name: s(), sort: one(['memory', 'cpu']), top: i(), port: i(), pid: i(), force: b() },
    lazy('system', 'processes'), { annotations: null }),

  tool('sysinfo', 'OS, CPU, memory, free disk, GPU, dev tool versions on PATH.', { gpu: b() }, lazy('system', 'sysinfo')),

  tool('run_parallel', 'Run shell commands concurrently; exit codes, durations, output tails.',
    { commands: list(), concurrency: i(), cwd: s(), timeout_s: n(), tail: i(), stop_on_failure: b() }, lazy('system', 'runParallel'), { required: ['commands'], annotations: null }),

  tool('benchmark', 'Time shell commands: warmup, N runs, mean±sd, median, p95, comparison.',
    { commands: list(), runs: i(), warmup: i(), cwd: s(), timeout_s: n(), max_total_s: n(), ignore_failure: b() }, lazy('bench', 'benchmark'), { required: ['commands'], annotations: null }),

  tool('wait_for', 'Wait until file_exists/file_gone/file_stable, port_open/port_closed, url_ok, process_exit; fails on timeout.',
    { condition: one(['file_exists', 'file_gone', 'file_stable', 'port_open', 'port_closed', 'url_ok', 'process_exit']), target: { type: ['string', 'integer'], description: 'path, host:port, URL or PID' }, timeout_s: n('default 60'), interval_ms: i(), stable_s: n(), status: i(), contains: s() },
    lazy('wait', 'waitFor'), { required: ['condition', 'target'] }),

  tool('deps_check', 'Check all deps of package.json/requirements.txt/pyproject.toml/Cargo.toml vs registries: major/minor/patch behind, deprecated.',
    { path: s('manifest or folder'), include_dev: b(), only_outdated: b() }, lazy('deps', 'depsCheck')),

  // ---- web --------------------------------------------------------------------
  tool('http', 'HTTP request: status, timing (dns/connect/tls/ttfb), redirects, headers, body (JSON pretty).',
    { url: s(), method: s(), headers: { type: 'object' }, json: { description: 'JSON body' }, body: s(), follow: b(), insecure: b('self-signed ok'), timeout_s: n(), show_headers: b(), max_body: i() },
    lazy('net', 'httpTool'), { required: ['url'], annotations: null }),

  tool('net', 'Network: dns records, reach (TCP ports, timing), tls (cert, expiry, chain).',
    { op: one(['dns', 'reach', 'tls']), host: s(), types: list(), port: i(), ports: list('', { type: 'integer' }), attempts: i(), timeout_s: n() }, lazy('net', 'netTool'), { required: ['host'] }),

  tool('package_info', 'Current version and facts of a package (npm, pypi, crates) or GitHub repo (owner/name).',
    { name: s(), registry: one(['npm', 'pypi', 'crates', 'github']) }, lazy('web', 'packageInfo'), { required: ['name'] }),

  tool('weather', 'Current weather and 1-16 day forecast for a place or "lat,lon" (Open-Meteo).',
    { place: s(), days: i(), units: one(['metric', 'imperial']) }, lazy('web', 'weather'), { required: ['place'] }),

  tool('wikipedia', 'Wikipedia summary (or full text) of a topic, any language.',
    { query: s(), lang: s('default en'), full: b() }, lazy('web', 'wikipedia'), { required: ['query'] }),

  // ---- media (ffmpeg) -----------------------------------------------------------
  tool('media_info', 'ffprobe summary: container, duration, codecs, resolution, fps, audio.', { path: s() }, lazy('media', 'mediaInfo'), { required: ['path'] }),

  tool('video_frames', 'Extract video frames (count, every_s or timestamps) + contact sheet, to view with Read.',
    { path: s(), count: i(), every_s: n(), timestamps: list('', { type: ['number', 'string'] }), width: i(), format: one(['jpg', 'png']), contact_sheet: b(), out_dir: s() },
    lazy('media', 'videoFrames'), { required: ['path'], annotations: WRITES }),

  tool('audio_analyze', 'Audio loudness (LUFS), true peak, clipping, silences; optional waveform/spectrogram image.',
    { path: s(), silence_db: n(), silence_min_s: n(), image: one(['waveform', 'spectrogram']), out_dir: s() }, lazy('media', 'audioAnalyze'), { required: ['path'], annotations: WRITES }),

  tool('image_compare', 'Pixel-compare two images: % differing, PSNR, change box, diff image.',
    { a: s(), b: s(), threshold: i('0-255'), resize: b(), out_dir: s() }, lazy('media', 'imageCompare'), { required: ['a', 'b'], annotations: WRITES }),

  tool('image_edit', 'Resize (fit contain/cover/stretch; no upscale unless upscale), crop {x,y,width,height}, rotate, flip, grayscale, convert (quality); file or folder; never overwrites originals.',
    {
      path: s(), width: i(), height: i(), fit: one(['contain', 'cover', 'stretch']), upscale: b(), crop: { type: 'object' }, rotate: i('90/180/270'), flip: one(['horizontal', 'vertical']),
      grayscale: b(), format: one(['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'avif']), quality: i(), out_dir: s(), suffix: s(), overwrite: b(),
    },
    lazy('media', 'imageEdit'), { required: ['path'], annotations: WRITES }),
];
