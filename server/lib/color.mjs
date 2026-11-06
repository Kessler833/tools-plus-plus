// Color parsing and conversion (hex, rgb, hsl, hsv, oklab, oklch, CSS names),
// WCAG contrast with a fix suggestion, and OKLCH-based palettes.

import { ToolError } from './util.mjs';

const NAMED = Object.fromEntries(
  ('aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 ' +
  'blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 ' +
  'chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b ' +
  'darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f ' +
  'darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f ' +
  'darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 ' +
  'dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff ' +
  'gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 ' +
  'indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 ' +
  'lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 ' +
  'lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa ' +
  'lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 ' +
  'magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db ' +
  'mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 ' +
  'midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 ' +
  'olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee ' +
  'palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 ' +
  'rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 ' +
  'seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 ' +
  'snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 ' +
  'violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32')
    .split(' ').map((p) => p.split(':')),
);

// ---- conversions (r, g, b in 0..1, gamma-encoded sRGB) -------------------------

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklab({ r, g, b }) {
  const [lr, lg, lb] = [r, g, b].map(toLinear);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb({ L, a, b }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

const oklchToOklab = ({ L, C, H }) => ({ L, a: C * Math.cos((H * Math.PI) / 180), b: C * Math.sin((H * Math.PI) / 180) });
function oklabToOklch({ L, a, b }) {
  const C = Math.hypot(a, b);
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H: C < 1e-4 ? 0 : H };
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { r: f(0), g: f(8), b: f(4) };
}

function rgbToHsl({ r, g, b }) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: hue(r, g, b, max, d), s, l };
}

function rgbToHsv({ r, g, b }) {
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  return { h: hue(r, g, b, max, d), s: max === 0 ? 0 : d / max, v: max };
}

function hue(r, g, b, max, d) {
  if (d === 0) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

const inGamut = ({ r, g, b }) => [r, g, b].every((c) => c >= -1e-4 && c <= 1 + 1e-4);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const clampRgb = ({ r, g, b }) => ({ r: clamp01(r), g: clamp01(g), b: clamp01(b) });

/** OKLCH -> sRGB, reducing chroma until the color fits (keeps hue and lightness). */
function oklchToRgbMapped(lch) {
  let rgb = oklabToRgb(oklchToOklab(lch));
  if (inGamut(rgb)) return clampRgb(rgb);
  let lo = 0, hi = lch.C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToRgb(oklchToOklab({ ...lch, C: mid })))) lo = mid;
    else hi = mid;
  }
  rgb = oklabToRgb(oklchToOklab({ ...lch, C: lo }));
  return clampRgb(rgb);
}

// ---- parsing ------------------------------------------------------------------

function num(token, scale, pctScale = scale) {
  const t = token.trim();
  if (t === 'none') return 0;
  const m = /^(-?\d*\.?\d+(?:e[+-]?\d+)?)(%|deg|rad|turn|grad)?$/i.exec(t);
  if (!m) throw new ToolError(`Cannot read number "${t}"`);
  const v = Number(m[1]);
  switch (m[2]?.toLowerCase()) {
    case '%': return (v / 100) * pctScale;
    case 'rad': return (v * 180) / Math.PI;
    case 'turn': return v * 360;
    case 'grad': return v * 0.9;
    default: return v / scale;
  }
}

/** Returns { r, g, b, alpha, clipped } with r/g/b in 0..1. */
export function parseColor(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) throw new ToolError('Empty color');
  if (s === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 };
  if (NAMED[s]) return parseColor('#' + NAMED[s]);
  let m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const v = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: v(0), g: v(2), b: v(4), alpha: h.length === 8 ? v(6) : 1 };
  }
  m = /^([a-z]+)\((.*)\)$/.exec(s);
  const fn = m?.[1];
  let parts, alphaPart;
  if (m) {
    const body = m[2].trim();
    if (body.includes('/')) [parts, alphaPart] = [body.split('/')[0].trim().split(/[\s,]+/), body.split('/')[1]];
    else {
      parts = body.split(/\s*,\s*|\s+/).filter(Boolean);
      if (parts.length === 4) alphaPart = parts.pop();
    }
  } else if (/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(s)) {
    return parseColor(`rgb(${s})`);
  } else {
    throw new ToolError(`Unknown color "${input}". Use #hex, rgb(), hsl(), oklch(), oklab() or a CSS color name`);
  }
  if (parts.length !== 3) throw new ToolError(`${fn}() needs 3 components`);
  const alpha = alphaPart === undefined ? 1 : clamp01(num(alphaPart, 1, 1));
  let rgb;
  switch (fn) {
    case 'rgb': case 'rgba':
      rgb = { r: num(parts[0], 255, 1), g: num(parts[1], 255, 1), b: num(parts[2], 255, 1) };
      break;
    case 'hsl': case 'hsla':
      rgb = hslToRgb(((num(parts[0], 1) % 360) + 360) % 360, clamp01(num(parts[1], 100, 1)), clamp01(num(parts[2], 100, 1)));
      break;
    case 'hwb': {
      let w = clamp01(num(parts[1], 100, 1)), bl = clamp01(num(parts[2], 100, 1));
      if (w + bl > 1) [w, bl] = [w / (w + bl), bl / (w + bl)];
      const base = hslToRgb(((num(parts[0], 1) % 360) + 360) % 360, 1, 0.5);
      rgb = Object.fromEntries(Object.entries(base).map(([k, c]) => [k, c * (1 - w - bl) + w]));
      break;
    }
    case 'oklab':
      rgb = oklabToRgb({ L: num(parts[0], 1, 1), a: num(parts[1], 1, 0.4), b: num(parts[2], 1, 0.4) });
      break;
    case 'oklch':
      rgb = oklabToRgb(oklchToOklab({ L: num(parts[0], 1, 1), C: num(parts[1], 1, 0.4), H: num(parts[2], 1) }));
      break;
    default:
      throw new ToolError(`Unsupported color function ${fn}()`);
  }
  const clipped = !inGamut(rgb);
  return { ...clampRgb(rgb), alpha, clipped };
}

// ---- output -------------------------------------------------------------------

const to255 = (c) => Math.round(clamp01(c) * 255);
const hex = ({ r, g, b }, alpha = 1) =>
  '#' + [r, g, b].map((c) => to255(c).toString(16).padStart(2, '0')).join('') + (alpha < 1 ? to255(alpha).toString(16).padStart(2, '0') : '');
const r1 = (x, d = 1) => Number(x.toFixed(d));
const luminance = ({ r, g, b }) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fg, bg) => ({ r: fg.r * fg.alpha + bg.r * (1 - fg.alpha), g: fg.g * fg.alpha + bg.g * (1 - fg.alpha), b: fg.b * fg.alpha + bg.b * (1 - fg.alpha), alpha: 1 });

function nearestName(c) {
  const lab = rgbToOklab(c);
  let best, dist = Infinity;
  for (const [name, h] of Object.entries(NAMED)) {
    const o = rgbToOklab(parseColor('#' + h));
    const d = Math.hypot(lab.L - o.L, lab.a - o.a, lab.b - o.b);
    if (d < dist) [best, dist] = [name, d];
  }
  return { name: best, exact: dist < 0.002 };
}

function describe(c) {
  const hsl = rgbToHsl(c), hsv = rgbToHsv(c), lab = rgbToOklab(c), lch = oklabToOklch(lab);
  const a = c.alpha < 1 ? ` / ${r1(c.alpha, 3)}` : '';
  const near = nearestName(c);
  return [
    `hex: ${hex(c, c.alpha)}`,
    `rgb: rgb(${to255(c.r)} ${to255(c.g)} ${to255(c.b)}${a})`,
    `hsl: hsl(${r1(hsl.h)} ${r1(hsl.s * 100)}% ${r1(hsl.l * 100)}%${a})`,
    `hsv: ${r1(hsv.h)}°, ${r1(hsv.s * 100)}%, ${r1(hsv.v * 100)}%`,
    `oklch: oklch(${r1(lch.L * 100, 2)}% ${r1(lch.C, 4)} ${r1(lch.H)}${a})`,
    `oklab: oklab(${r1(lab.L * 100, 2)}% ${r1(lab.a, 4)} ${r1(lab.b, 4)})`,
    `relative luminance: ${r1(luminance(c), 4)}   ${luminance(c) > 0.179 ? 'light (dark text reads better on it)' : 'dark (light text reads better on it)'}`,
    `CSS name: ${near.exact ? near.name : `none (closest: ${near.name})`}`,
    c.clipped ? 'note: input was outside the sRGB gamut and has been clipped' : null,
  ].filter(Boolean);
}

function contrast(fgIn, bgIn) {
  const bg = bgIn.alpha < 1 ? over(bgIn, { r: 1, g: 1, b: 1, alpha: 1 }) : bgIn;
  const fg = fgIn.alpha < 1 ? over(fgIn, bg) : fgIn;
  const cr = ratio(fg, bg);
  const pass = (t) => (cr >= t ? 'pass' : 'FAIL');
  const lines = [
    `contrast ${hex(fg)} on ${hex(bg)}: ${cr.toFixed(2)}:1${fgIn.alpha < 1 || bgIn.alpha < 1 ? ' (after alpha compositing)' : ''}`,
    `WCAG AA normal text (4.5): ${pass(4.5)}   AA large text (3): ${pass(3)}`,
    `WCAG AAA normal text (7): ${pass(7)}   AAA large text (4.5): ${pass(4.5)}   UI components (3): ${pass(3)}`,
  ];
  if (cr < 4.5) {
    // nearest OKLCH lightness that reaches 4.5:1, keeping hue and chroma
    const lch = oklabToOklch(rgbToOklab(fg));
    const fix = (dir) => {
      let lo = lch.L, hi = dir > 0 ? 1 : 0;
      if (ratio(oklchToRgbMapped({ ...lch, L: hi }), bg) < 4.5) return null;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (ratio(oklchToRgbMapped({ ...lch, L: mid }), bg) >= 4.5) hi = mid;
        else lo = mid;
      }
      return { L: hi, rgb: oklchToRgbMapped({ ...lch, L: hi }) };
    };
    const options = [fix(-1), fix(1)].filter(Boolean).sort((x, y) => Math.abs(x.L - lch.L) - Math.abs(y.L - lch.L));
    if (options.length) lines.push(`closest text color passing AA: ${hex(options[0].rgb)} (${ratio(options[0].rgb, bg).toFixed(2)}:1, same hue, ${options[0].L < lch.L ? 'darker' : 'lighter'})`);
  }
  return lines;
}

const SHADE_STEPS = [[50, 0.97], [100, 0.93], [200, 0.87], [300, 0.79], [400, 0.7], [500, 0.62], [600, 0.54], [700, 0.46], [800, 0.38], [900, 0.3], [950, 0.23]];

function palette(c, kind) {
  const lch = oklabToOklch(rgbToOklab(c));
  if (kind === 'shades') {
    const lines = SHADE_STEPS.map(([step, L]) => {
      const C = lch.C * (1 - Math.abs(L - 0.6) * 0.6);  // ease chroma toward the ends
      const rgb = oklchToRgbMapped({ L, C, H: lch.H });
      return `${String(step).padStart(3)}: ${hex(rgb)}  (on white ${ratio(rgb, { r: 1, g: 1, b: 1 }).toFixed(1)}:1, on black ${ratio(rgb, { r: 0, g: 0, b: 0 }).toFixed(1)}:1)`;
    });
    return ['shades (OKLCH lightness scale, same hue):', ...lines];
  }
  const rot = (deg) => hex(oklchToRgbMapped({ ...lch, H: (lch.H + deg + 360) % 360 }));
  return [
    'harmonies (OKLCH hue rotation, same lightness and chroma):',
    `complementary: ${rot(180)}`,
    `analogous: ${rot(-30)} ${hex(c)} ${rot(30)}`,
    `triadic: ${hex(c)} ${rot(120)} ${rot(240)}`,
    `split complementary: ${rot(150)} ${rot(210)}`,
    `tetradic: ${hex(c)} ${rot(90)} ${rot(180)} ${rot(270)}`,
  ];
}

export function color(args = {}) {
  const c = parseColor(args.color);
  const out = describe(c);
  if (args.against !== undefined) out.push('', ...contrast(c, parseColor(args.against)));
  if (args.palette) {
    if (!['shades', 'harmony'].includes(args.palette)) throw new ToolError('palette must be "shades" or "harmony"');
    out.push('', ...palette(c, args.palette));
  }
  return out.join('\n');
}
