// PDF text extraction without dependencies: object and object-stream
// parsing, Flate decoding, page tree, fonts with ToUnicode CMaps or
// WinAnsi/Differences encodings, form XObjects, and per-page search.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import zlib from 'node:zlib';
import { ToolError, statOrNull, fmtBytes, clip, intArg } from './util.mjs';

// ---- lexer/parser for PDF objects (works on latin1 strings) -------------------

const WS = new Set([' ', '\n', '\r', '\t', '\f', '\0']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

class Lexer {
  constructor(s, pos = 0) {
    this.s = s;
    this.i = pos;
  }
  skip() {
    const s = this.s;
    for (;;) {
      while (this.i < s.length && WS.has(s[this.i])) this.i++;
      if (s[this.i] === '%') {
        while (this.i < s.length && s[this.i] !== '\n' && s[this.i] !== '\r') this.i++;
      } else return;
    }
  }
  token() {
    this.skip();
    const s = this.s;
    if (this.i >= s.length) return null;
    const c = s[this.i];
    if (c === '(') return { t: 'str', v: this.literal() };
    if (c === '<') {
      if (s[this.i + 1] === '<') {
        this.i += 2;
        return { t: '<<' };
      }
      const end = s.indexOf('>', this.i);
      const hex = s.slice(this.i + 1, end < 0 ? s.length : end).replace(/[^0-9a-fA-F]/g, '');
      this.i = end < 0 ? s.length : end + 1;
      let out = '';
      for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      return { t: 'str', v: out, hex: true };
    }
    if (c === '>' && s[this.i + 1] === '>') {
      this.i += 2;
      return { t: '>>' };
    }
    if (c === '[' || c === ']' || c === '{' || c === '}') {
      this.i++;
      return { t: c };
    }
    if (c === '/') {
      let j = this.i + 1;
      while (j < s.length && !WS.has(s[j]) && !DELIM.has(s[j])) j++;
      const name = s.slice(this.i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      this.i = j;
      return { t: 'name', v: name };
    }
    let j = this.i;
    while (j < s.length && !WS.has(s[j]) && !DELIM.has(s[j])) j++;
    if (j === this.i) {
      this.i++;
      return { t: 'op', v: c };
    }
    const word = s.slice(this.i, j);
    this.i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: Number(word) };
    return { t: 'op', v: word };
  }
  literal() {
    const s = this.s;
    let depth = 0, out = '';
    this.i++;
    while (this.i < s.length) {
      const c = s[this.i++];
      if (c === '\\') {
        const e = s[this.i++];
        const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        if (map[e] !== undefined) out += map[e];
        else if (e >= '0' && e <= '7') {
          let oct = e;
          while (oct.length < 3 && s[this.i] >= '0' && s[this.i] <= '7') oct += s[this.i++];
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else if (e === '\r') {
          if (s[this.i] === '\n') this.i++;
        } else if (e !== '\n') out += e;
      } else if (c === '(') {
        depth++;
        out += c;
      } else if (c === ')') {
        if (depth-- === 0) return out;
        out += c;
      } else out += c;
    }
    return out;
  }
}

class Ref {
  constructor(num) {
    this.num = num;
  }
}

/** Parse one value starting at lexer position; handles "n g R" references. */
function parseValue(lx, first = lx.token(), depth = 0) {
  if (!first || depth > 100) return null;
  switch (first.t) {
    case '<<': {
      const d = new Map();
      for (;;) {
        const k = lx.token();
        if (!k || k.t === '>>') return d;
        if (k.t !== 'name') continue;
        d.set(k.v, parseValue(lx, undefined, depth + 1));
      }
    }
    case '[': {
      const a = [];
      for (;;) {
        const t = lx.token();
        if (!t || t.t === ']') return a;
        a.push(parseValue(lx, t, depth + 1));
      }
    }
    case 'num': {
      const save = lx.i;
      const t2 = lx.token();
      if (t2?.t === 'num') {
        const t3 = lx.token();
        if (t3?.t === 'op' && t3.v === 'R') return new Ref(first.v);
      }
      lx.i = save;
      return first.v;
    }
    case 'name':
      return { name: first.v };
    case 'str':
      return first.v;
    case 'op':
      return first.v === 'true' ? true : first.v === 'false' ? false : null;
    default:
      return null;
  }
}

// ---- document -----------------------------------------------------------------

function inflate(buf) {
  for (const fn of [() => zlib.inflateSync(buf), () => zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }), () => zlib.inflateRawSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH })]) {
    try {
      return fn();
    } catch {
      // try the next, more forgiving variant
    }
  }
  return null;
}

function unpredict(buf, parms) {
  const predictor = parms?.get?.('Predictor') ?? 1;
  if (predictor < 10) return buf;
  const cols = parms.get('Columns') ?? 1, colors = parms.get('Colors') ?? 1, bpc = parms.get('BitsPerComponent') ?? 8;
  const bpp = Math.max(1, (colors * bpc) >> 3), rowLen = Math.ceil((cols * colors * bpc) / 8);
  const out = Buffer.alloc(Math.floor(buf.length / (rowLen + 1)) * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0, p = 0; p + rowLen < buf.length + 1 && r * rowLen < out.length; r++) {
    const type = buf[p++];
    const row = Buffer.from(buf.subarray(p, p + rowLen));
    p += rowLen;
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? row[i - bpp] : 0, up = prev[i], ul = i >= bpp ? prev[i - bpp] : 0;
      if (type === 1) row[i] = (row[i] + left) & 255;
      else if (type === 2) row[i] = (row[i] + up) & 255;
      else if (type === 3) row[i] = (row[i] + ((left + up) >> 1)) & 255;
      else if (type === 4) {
        const pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2 * ul);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul)) & 255;
      }
    }
    row.copy(out, r * rowLen);
    prev = row;
  }
  return out;
}

class Pdf {
  constructor(buf) {
    this.buf = buf;
    this.s = buf.toString('latin1');
    this.objs = new Map();  // num -> { dict/value, stream: Buffer|null }
    this.scan();
  }

  scan() {
    const s = this.s;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    const streams = [];
    while ((m = re.exec(s))) {
      const num = +m[1];
      const lx = new Lexer(s, re.lastIndex);
      let value;
      try {
        value = parseValue(lx);
      } catch {
        continue;
      }
      let stream = null;
      const after = new Lexer(s, lx.i);
      const kw = after.token();
      if (kw?.t === 'op' && kw.v === 'stream' && value instanceof Map) {
        let start = after.i;
        if (s[start] === '\r') start++;
        if (s[start] === '\n') start++;
        // trust /Length only when "endstream" really follows; indirect lengths fall back to searching
        const len = value.get('Length');
        let end = typeof len === 'number' && /^\s*endstream/.test(s.slice(start + len, start + len + 24)) ? start + len : -1;
        if (end < 0) end = s.indexOf('endstream', start);
        if (end < 0) end = s.length;
        stream = { start, end };
        re.lastIndex = end;
        streams.push(num);
      }
      this.objs.set(num, { value, raw: stream });
    }
    // objects inside object streams
    for (const [num, o] of [...this.objs]) {
      if (!(o.value instanceof Map) || o.value.get('Type')?.name !== 'ObjStm') continue;
      const data = this.streamData(num);
      if (!data) continue;
      const text = data.toString('latin1');
      const n = o.value.get('N') ?? 0, first = o.value.get('First') ?? 0;
      const head = new Lexer(text);
      const pairs = [];
      for (let k = 0; k < n; k++) pairs.push([head.token()?.v, head.token()?.v]);
      for (const [objNum, off] of pairs) {
        if (typeof objNum !== 'number' || this.objs.has(objNum)) continue;
        try {
          this.objs.set(objNum, { value: parseValue(new Lexer(text, first + off)), raw: null });
        } catch {
          // skip broken entry
        }
      }
    }
  }

  get(v, depth = 0) {
    while (v instanceof Ref && depth++ < 32) v = this.objs.get(v.num)?.value;
    return v;
  }

  streamData(num) {
    const o = this.objs.get(num);
    if (!o?.raw) return null;
    if (o.decoded !== undefined) return o.decoded;
    let data = this.buf.subarray(o.raw.start, o.raw.end);
    const filters = [].concat(this.get(o.value.get('Filter')) ?? []).map((f) => this.get(f)?.name);
    const parms = [].concat(this.get(o.value.get('DecodeParms')) ?? []).map((p) => this.get(p));
    for (const [i, f] of filters.entries()) {
      if (f === 'FlateDecode' || f === 'Fl') {
        data = inflate(data);
        if (!data) break;
        data = unpredict(data, parms[i]);
      } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
        data = Buffer.from(data.toString('latin1').replace(/[^0-9a-fA-F]/g, ''), 'hex');
      } else if (f === 'ASCII85Decode' || f === 'A85') {
        data = ascii85(data.toString('latin1'));
      } else {
        data = null;  // images (DCT, JBIG2, ...) are not text
        break;
      }
    }
    o.decoded = data;
    return data;
  }

  refStream(v) {
    return v instanceof Ref ? this.streamData(v.num) : null;
  }

  /** Pages in document order with inherited resources. */
  pages() {
    const s = this.s;
    let root = null;
    const trailers = [...s.matchAll(/trailer\s*<</g)];
    for (const t of trailers.reverse()) {
      const d = parseValue(new Lexer(s, t.index + 7));
      if (d instanceof Map && d.get('Root')) {
        root = d.get('Root');
        break;
      }
      if (d instanceof Map && d.get('Encrypt')) throw new ToolError('This PDF is encrypted; text extraction is not supported');
    }
    if (!root) {
      for (const o of [...this.objs.values()].reverse()) {
        if (o.value instanceof Map && o.value.get('Type')?.name === 'XRef' && o.value.get('Root')) {
          if (o.value.get('Encrypt')) throw new ToolError('This PDF is encrypted; text extraction is not supported');
          root = o.value.get('Root');
          break;
        }
      }
    }
    if ([...s.matchAll(/\/Encrypt\s+\d+\s+\d+\s+R/g)].length) throw new ToolError('This PDF is encrypted; text extraction is not supported');
    const out = [];
    const seen = new Set();
    const walk = (node, inherited, depth) => {
      const d = this.get(node);
      if (!(d instanceof Map) || depth > 50) return;
      const key = node instanceof Ref ? node.num : null;
      if (key !== null) {
        if (seen.has(key)) return;
        seen.add(key);
      }
      const res = d.get('Resources') ?? inherited;
      const type = d.get('Type')?.name;
      if (type === 'Pages' || d.has('Kids')) {
        for (const kid of this.get(d.get('Kids')) ?? []) walk(kid, res, depth + 1);
      } else out.push({ dict: d, resources: res });
    };
    const catalog = this.get(root);
    if (catalog instanceof Map) walk(catalog.get('Pages'), null, 0);
    if (!out.length) {
      for (const o of this.objs.values()) if (o.value instanceof Map && o.value.get('Type')?.name === 'Page') out.push({ dict: o.value, resources: o.value.get('Resources') });
    }
    return out;
  }
}

function ascii85(s) {
  const clean = s.replace(/\s/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
  const out = [];
  for (let i = 0; i < clean.length; ) {
    if (clean[i] === 'z') {
      out.push(0, 0, 0, 0);
      i++;
      continue;
    }
    const chunk = clean.slice(i, i + 5);
    i += 5;
    const padded = chunk.padEnd(5, 'u');
    let v = 0;
    for (const ch of padded) v = v * 85 + (ch.charCodeAt(0) - 33);
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, chunk.length - 1));
  }
  return Buffer.from(out);
}

// ---- fonts --------------------------------------------------------------------

const WIN_ANSI_EXTRA = { 128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ' };
const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", quoteright: '’', quoteleft: '‘',
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/', colon: ':', semicolon: ';',
  less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', underscore: '_', braceleft: '{', bar: '|', braceright: '}',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', bullet: '•', endash: '–', emdash: '—',
  quotedblleft: '“', quotedblright: '”', quotedblbase: '„', ellipsis: '…', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', germandbls: 'ß', Euro: '€', degree: '°',
  adieresis: 'ä', odieresis: 'ö', udieresis: 'ü', Adieresis: 'Ä', Odieresis: 'Ö', Udieresis: 'Ü', eacute: 'é', egrave: 'è', agrave: 'à', ccedilla: 'ç', copyright: '©', registered: '®', trademark: '™', section: '§',
};

// built-in encodings of the two standard symbol fonts (codes without an entry pass through)
const SYMBOL = Object.fromEntries([
  ...'ABGDEZHQIKLMNXOPRSTUFCYW'.split('').map((c, i) => [c.charCodeAt(0), 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ'[i]]),
  ...'abgdezhqiklmnxoprstufcyw'.split('').map((c, i) => [c.charCodeAt(0), 'αβγδεζηθικλμνξοπρστυφχψω'[i]]),
  [0x6a, 'φ'], [0x56, 'ς'], [0x4a, 'ϑ'], [0x76, 'ϖ'], [0x22, '∀'], [0x24, '∃'], [0x27, '∋'], [0x2a, '∗'], [0x2d, '−'], [0x40, '≅'], [0x5c, '∴'], [0x5e, '⊥'],
  [0xa1, 'ϒ'], [0xa2, '′'], [0xa3, '≤'], [0xa4, '⁄'], [0xa5, '∞'], [0xa6, 'ƒ'], [0xab, '↔'], [0xac, '←'], [0xad, '↑'], [0xae, '→'], [0xaf, '↓'],
  [0xb0, '°'], [0xb1, '±'], [0xb2, '″'], [0xb3, '≥'], [0xb4, '×'], [0xb5, '∝'], [0xb6, '∂'], [0xb7, '•'], [0xb8, '÷'], [0xb9, '≠'], [0xba, '≡'], [0xbb, '≈'], [0xbc, '…'],
  [0xc4, '⊗'], [0xc5, '⊕'], [0xc6, '∅'], [0xc7, '∩'], [0xc8, '∪'], [0xc9, '⊃'], [0xca, '⊇'], [0xcb, '⊄'], [0xcc, '⊂'], [0xcd, '⊆'], [0xce, '∈'], [0xcf, '∉'],
  [0xd0, '∠'], [0xd1, '∇'], [0xd5, '∏'], [0xd6, '√'], [0xd7, '⋅'], [0xd8, '¬'], [0xd9, '∧'], [0xda, '∨'], [0xdb, '⇔'], [0xdc, '⇐'], [0xdd, '⇑'], [0xde, '⇒'], [0xdf, '⇓'],
  [0xe0, '◊'], [0xe1, '〈'], [0xe5, '∑'], [0xf1, '〉'], [0xf2, '∫'],
]);
const DINGBATS = {
  0x20: ' ', 0x21: '✁', 0x22: '✂', 0x23: '✃', 0x24: '✄', 0x25: '☎', 0x26: '✆', 0x27: '✇', 0x28: '✈', 0x29: '✉', 0x2a: '☛', 0x2b: '☞', 0x2c: '✌', 0x2d: '✍', 0x2e: '✎', 0x2f: '✏',
  0x33: '✓', 0x34: '✔', 0x35: '✕', 0x36: '✖', 0x37: '✗', 0x38: '✘', 0x48: '★', 0x49: '✩', 0x4f: '✯', 0x6c: '●', 0x6d: '❍', 0x6e: '■', 0x6f: '❏', 0x70: '❐', 0x71: '❑', 0x72: '❒',
  0x73: '▲', 0x74: '▼', 0x75: '◆', 0x76: '❖', 0x77: '◗', 0xa8: '♣', 0xa9: '♦', 0xaa: '♥', 0xab: '♠', 0xd4: '➔', 0xe0: '➠', 0xe8: '➨',
};

function parseCMap(text) {
  const map = new Map();
  let bytes = 1;
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  if (cs) bytes = Math.max(1, cs[1].length / 2);
  const hexToStr = (h) => {
    let out = '';
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    if (h.length === 2) out = String.fromCharCode(parseInt(h, 16));
    return out;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), hexToStr(m[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (hi - lo > 65535) continue;
      if (m[3] !== undefined) {
        const base = m[3];
        const last = parseInt(base.slice(-4), 16);
        for (let c = lo; c <= hi; c++) map.set(c, hexToStr(base.slice(0, -4) + (last + c - lo).toString(16).padStart(4, '0')));
      } else {
        const list = [...m[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexToStr(x[1]));
        list.forEach((v, k) => map.set(lo + k, v));
      }
    }
  }
  return { map, bytes };
}

function makeFont(pdf, fontRef) {
  const f = pdf.get(fontRef);
  if (!(f instanceof Map)) return { decode: (s) => s };
  const sub = f.get('Subtype')?.name;
  const tu = pdf.refStream(f.get('ToUnicode'));
  const cmap = tu ? parseCMap(tu.toString('latin1')) : null;
  const twoByte = sub === 'Type0';
  const bytes = twoByte ? 2 : cmap?.bytes ?? 1;
  const enc = pdf.get(f.get('Encoding'));
  const baseFont = f.get('BaseFont')?.name ?? '';
  const builtin = /ZapfDingbats|Dingbats/i.test(baseFont) ? DINGBATS : /^(?:[A-Z]{6}\+)?Symbol(MT)?$/i.test(baseFont) ? SYMBOL : null;
  const diffs = new Map();
  if (enc instanceof Map) {
    let code = 0;
    for (const item of pdf.get(enc.get('Differences')) ?? []) {
      if (typeof item === 'number') code = item;
      else if (item?.name) diffs.set(code++, GLYPHS[item.name] ?? (item.name.length === 1 ? item.name : /^uni([0-9A-F]{4})$/.exec(item.name) ? String.fromCharCode(parseInt(item.name.slice(3), 16)) : ''));
    }
  }
  return {
    decode(raw) {
      let out = '';
      for (let i = 0; i < raw.length; i += bytes) {
        let code = 0;
        for (let b = 0; b < bytes; b++) code = (code << 8) | (raw.charCodeAt(i + b) & 255);
        if (cmap?.map.has(code)) out += cmap.map.get(code);
        else if (diffs.has(code)) out += diffs.get(code);
        else if (builtin) out += builtin[code] ?? (code < 0x80 && builtin === SYMBOL ? String.fromCharCode(code) : '');
        else if (!twoByte) out += WIN_ANSI_EXTRA[code] ?? String.fromCharCode(code);
      }
      return out;
    },
  };
}

// ---- content streams ----------------------------------------------------------

function extractText(pdf, content, resources, depth = 0) {
  if (!content || depth > 8) return '';
  const res = pdf.get(resources);
  const fontDict = res instanceof Map ? pdf.get(res.get('Font')) : null;
  const xobjects = res instanceof Map ? pdf.get(res.get('XObject')) : null;
  const fonts = new Map();
  const fontFor = (name) => {
    if (!fonts.has(name)) fonts.set(name, makeFont(pdf, fontDict instanceof Map ? fontDict.get(name) : null));
    return fonts.get(name);
  };
  const s = content.toString('latin1');
  const lx = new Lexer(s);
  let out = '', font = fontFor(''), lastY = null, operands = [];
  const newline = () => {
    if (out && !out.endsWith('\n')) out += '\n';
  };
  const space = () => {
    if (out && !/\s$/.test(out)) out += ' ';
  };
  for (let guard = 0; guard < 5e6; guard++) {
    const t = lx.token();
    if (!t) break;
    if (t.t !== 'op') {
      if (t.t === '[') {
        const arr = [];
        for (;;) {
          const x = lx.token();
          if (!x || x.t === ']') break;
          arr.push(x);
        }
        operands.push({ t: 'arr', v: arr });
      } else if (t.t === '<<') {
        lx.i = Math.max(lx.i, s.indexOf('>>', lx.i) + 2);
      } else operands.push(t);
      continue;
    }
    const op = t.v;
    const num = (k) => operands[operands.length - k]?.v;
    switch (op) {
      case 'BT':
        break;
      case 'Tf':
        font = fontFor(operands.at(-2)?.v ?? '');
        break;
      case 'Td':
      case 'TD':
        if (Math.abs(num(1)) > 0.5) newline();
        else if (num(2) > 0) space();
        break;
      case 'Tm': {
        const y = num(1);
        if (lastY !== null && Math.abs(y - lastY) > 0.5) newline();
        else space();
        lastY = y;
        break;
      }
      case 'T*':
        newline();
        break;
      case 'Tj':
        out += font.decode(operands.at(-1)?.v ?? '');
        break;
      case "'":
      case '"':
        newline();
        out += font.decode(operands.at(-1)?.v ?? '');
        break;
      case 'TJ':
        for (const x of operands.at(-1)?.v ?? []) {
          if (x.t === 'str') out += font.decode(x.v);
          else if (x.t === 'num' && x.v < -200) space();
        }
        break;
      case 'ET':
        space();
        break;
      case 'Do': {
        const name = operands.at(-1)?.v;
        const ref = xobjects instanceof Map ? xobjects.get(name) : null;
        const x = pdf.get(ref);
        if (ref instanceof Ref && x instanceof Map && x.get('Subtype')?.name === 'Form') {
          newline();
          out += extractText(pdf, pdf.streamData(ref.num), x.get('Resources') ?? resources, depth + 1);
          newline();
        }
        break;
      }
      case 'BI': {
        const end = s.indexOf('EI', s.indexOf('ID', lx.i));
        lx.i = end < 0 ? s.length : end + 2;
        break;
      }
      default:
        break;
    }
    operands = [];
  }
  return out;
}

function pageContent(pdf, page) {
  const c = page.dict.get('Contents');
  const parts = [];
  for (const item of Array.isArray(pdf.get(c)) ? pdf.get(c) : [c]) {
    const data = item instanceof Ref ? pdf.streamData(item.num) : null;
    if (data) parts.push(data);
  }
  return parts.length ? Buffer.concat(parts.flatMap((p) => [p, Buffer.from('\n')])) : null;
}

function cleanup(text) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function parseRange(spec, max) {
  if (!spec) return Array.from({ length: max }, (_, i) => i + 1);
  const pages = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$/.exec(part);
    if (!m) throw new ToolError(`Bad page range "${spec}" (use e.g. "1-3,7,10-")`);
    const a = +m[1], b = m[2] === undefined ? a : m[2] === '' ? max : +m[2];
    for (let p = a; p <= Math.min(b, max); p++) if (p >= 1) pages.add(p);
  }
  return [...pages].sort((x, y) => x - y);
}

export async function pdfText(args = {}, ctx = {}) {
  if (typeof args.path !== 'string') throw new ToolError('path is required');
  const full = resolve(args.path);
  const st = await statOrNull(full);
  if (!st?.isFile()) throw new ToolError(`File not found: ${full}`);
  if (st.size > 300e6) throw new ToolError(`${fmtBytes(st.size)} is over the 300 MB limit`);
  const buf = await readFile(full);
  if (!buf.subarray(0, 1024).toString('latin1').includes('%PDF')) throw new ToolError(`${full} is not a PDF`);
  const pdf = new Pdf(buf);
  const pages = pdf.pages();
  if (!pages.length) throw new ToolError('No pages found (damaged PDF?)');
  const wanted = parseRange(args.pages, pages.length);
  const maxChars = intArg(args.max_chars, 'max_chars', { min: 100, max: 500_000, def: 40_000 });
  const texts = new Map();
  for (const n of wanted) {
    if (ctx.signal?.aborted) throw new ToolError('Cancelled');
    texts.set(n, cleanup(extractText(pdf, pageContent(pdf, pages[n - 1]), pages[n - 1].resources)));
    if (n % 20 === 0) ctx.progress?.(n, pages.length);
  }
  const empty = wanted.filter((n) => !texts.get(n));
  const header = `${full}: ${pages.length} page(s)${wanted.length !== pages.length ? `, showing ${wanted.length}` : ''}`;
  const scanNote = empty.length === wanted.length
    ? '\nNo extractable text: probably a scanned document (needs OCR) or text drawn as shapes.'
    : empty.length ? `\npages without text (scanned images?): ${empty.slice(0, 30).join(', ')}` : '';

  if (args.search) {
    const q = String(args.search).toLowerCase();
    const hits = [];
    for (const [n, t] of texts) {
      const lower = t.toLowerCase();
      let at = lower.indexOf(q), count = 0;
      const snippets = [];
      while (at >= 0) {
        count++;
        if (snippets.length < 3) snippets.push(`…${t.slice(Math.max(0, at - 70), at + q.length + 70).replace(/\s+/g, ' ')}…`);
        at = lower.indexOf(q, at + q.length);
      }
      if (count) hits.push(`page ${n} (${count}×):\n${snippets.map((x) => `  ${x}`).join('\n')}`);
    }
    return `${header}\n"${args.search}" found on ${hits.length} page(s)${scanNote}\n\n${hits.join('\n\n') || '(no matches)'}`;
  }
  const body = [...texts].map(([n, t]) => `--- page ${n} ---\n${t || '(no text)'}`).join('\n\n');
  return `${header}${scanNote}\n\n${clip(body, maxChars)}`;
}
