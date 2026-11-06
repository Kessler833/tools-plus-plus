// Media tools on top of ffmpeg/ffprobe (must be on PATH): file info, video
// frames and contact sheets, audio loudness/silence/clipping analysis with
// waveform or spectrogram images, and pixel-exact image comparison.

import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { ToolError, statOrNull, fmtBytes, intArg } from './util.mjs';
import { killTree } from './bench.mjs';

function run(cmd, args, { signal, input, timeoutMs = 300_000 } = {}) {
  return new Promise((done, fail) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return fail(err);
    }
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > 2e6) err = err.slice(-1e6);
    });
    const kill = () => killTree(child);
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') {
        fail(new ToolError(`${cmd} not found on PATH. Install ffmpeg (Windows: winget install Gyan.FFmpeg, macOS: brew install ffmpeg, Linux: apt install ffmpeg) and restart Claude Code.`));
      } else fail(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return fail(new ToolError('Cancelled'));
      done({ code, stdout: Buffer.concat(out), stderr: err });
    });
    if (input) child.stdin.end(input);
  });
}

async function inputFile(path) {
  if (typeof path !== 'string' || !path.trim()) throw new ToolError('path is required');
  const full = resolve(path);
  const st = await statOrNull(full);
  if (!st?.isFile()) throw new ToolError(`File not found: ${full}`);
  return full;
}

async function outDir(kind, given, source) {
  const dir = given ? resolve(given) : join(tmpdir(), 'tools-plus-plus', `${kind}-${basename(source, extname(source)).replace(/[^\w.-]/g, '_').slice(0, 40)}-${Date.now().toString(36)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function probe(file, signal) {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { signal, timeoutMs: 60_000 });
  if (r.code !== 0) throw new ToolError(`ffprobe could not read ${file}: ${r.stderr.trim().split('\n').pop()}`);
  return JSON.parse(r.stdout.toString('utf8'));
}

const ts = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};
const rate = (r) => {
  const [a, b] = String(r ?? '0/1').split('/').map(Number);
  return b ? a / b : 0;
};

// ---- media_info ---------------------------------------------------------------

export async function mediaInfo({ path } = {}, ctx = {}) {
  const file = await inputFile(path);
  const p = await probe(file, ctx.signal);
  const f = p.format ?? {};
  const lines = [
    `${file}`,
    `container: ${f.format_long_name ?? f.format_name}   size: ${fmtBytes(Number(f.size ?? 0))}${f.duration ? `   duration: ${ts(Number(f.duration))} (${Number(f.duration).toFixed(3)} s)` : ''}${f.bit_rate ? `   bitrate: ${Math.round(f.bit_rate / 1000)} kb/s` : ''}`,
  ];
  for (const s of p.streams ?? []) {
    const lang = s.tags?.language ? ` [${s.tags.language}]` : '';
    if (s.codec_type === 'video') {
      const fps = rate(s.avg_frame_rate) || rate(s.r_frame_rate);
      const rot = s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? s.tags?.rotate;
      const still = (s.disposition?.attached_pic || ['mjpeg', 'png'].includes(s.codec_name)) && !fps;
      lines.push(`video #${s.index}: ${s.codec_name}${s.profile ? ` (${s.profile})` : ''} ${s.width}x${s.height}${s.sample_aspect_ratio && !['1:1', '0:1'].includes(s.sample_aspect_ratio) ? ` (non-square pixels, display ${s.display_aspect_ratio})` : ''}${still ? ' (still image)' : ` ${fps.toFixed(3).replace(/\.?0+$/, '')} fps`}, ${s.pix_fmt}${s.bit_rate ? `, ${Math.round(s.bit_rate / 1000)} kb/s` : ''}${s.nb_frames ? `, ${s.nb_frames} frames` : ''}${rot ? `, rotated ${rot}°` : ''}${s.color_transfer && s.color_transfer !== 'unknown' ? `, ${s.color_transfer}` : ''}${lang}`);
    } else if (s.codec_type === 'audio') {
      lines.push(`audio #${s.index}: ${s.codec_name}, ${s.sample_rate} Hz, ${s.channels} ch${s.channel_layout ? ` (${s.channel_layout})` : ''}${s.bits_per_raw_sample ? `, ${s.bits_per_raw_sample} bit` : ''}${s.bit_rate ? `, ${Math.round(s.bit_rate / 1000)} kb/s` : ''}${lang}`);
    } else {
      lines.push(`${s.codec_type} #${s.index}: ${s.codec_name ?? 'unknown'}${lang}${s.tags?.title ? ` "${s.tags.title}"` : ''}`);
    }
  }
  const tags = Object.entries(f.tags ?? {}).filter(([k]) => !/^(major_brand|minor_version|compatible_brands|encoder)$/i.test(k)).slice(0, 12);
  if (tags.length) lines.push(`tags: ${tags.map(([k, v]) => `${k}=${String(v).slice(0, 80)}`).join('; ')}`);
  return lines.join('\n');
}

// ---- video_frames -------------------------------------------------------------

export async function videoFrames(args = {}, ctx = {}) {
  const file = await inputFile(args.path);
  const p = await probe(file, ctx.signal);
  const video = p.streams?.find((s) => s.codec_type === 'video');
  if (!video) throw new ToolError('No video stream in this file');
  const duration = Number(p.format?.duration ?? video.duration ?? 0);
  const width = intArg(args.width, 'width', { min: 32, max: 7680, def: 960 });
  const format = args.format === 'png' ? 'png' : 'jpg';

  let times;
  if (Array.isArray(args.timestamps) && args.timestamps.length) {
    times = args.timestamps.map((t) => {
      const v = typeof t === 'number' ? t : String(t).split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
      if (!Number.isFinite(v) || v < 0) throw new ToolError(`Bad timestamp "${t}" (seconds or [h:]mm:ss)`);
      return v;
    });
  } else if (args.every_s) {
    if (!(args.every_s > 0)) throw new ToolError('every_s must be > 0');
    times = [];
    for (let t = 0; t < duration; t += args.every_s) times.push(t);
  } else {
    const count = intArg(args.count, 'count', { min: 1, max: 200, def: 9 });
    times = Array.from({ length: count }, (_, i) => (duration * (i + 0.5)) / count);
  }
  if (times.length > 200) throw new ToolError(`${times.length} frames requested; limit is 200 (raise every_s)`);
  if (!duration && !args.timestamps) times = [0];
  const late = times.filter((t) => duration && t > duration);
  if (late.length) throw new ToolError(`Timestamps beyond the video length ${ts(duration)}: ${late.map(ts).join(', ')}`);

  const dir = await outDir('frames', args.out_dir, file);
  const files = [];
  for (const [i, t] of times.entries()) {
    const out = join(dir, `frame_${String(i + 1).padStart(3, '0')}.${format}`);
    // input seeking (-ss before -i) is fast and frame-accurate in modern ffmpeg
    const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, ...(format === 'jpg' ? ['-q:v', '3'] : []), out], { signal: ctx.signal });
    if (r.code !== 0 || !(await statOrNull(out))) {
      // seeking right at the end can yield nothing; retry slightly earlier
      const r2 = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-sseof', '-0.5', '-i', file, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, out], { signal: ctx.signal });
      if (r2.code !== 0 || !(await statOrNull(out))) throw new ToolError(`Could not extract frame at ${ts(t)}: ${(r.stderr || r2.stderr).trim().split('\n').pop()}`);
    }
    files.push({ t, out });
    ctx.progress?.(i + 1, times.length);
  }

  const lines = [`${files.length} frame(s) from ${basename(file)} (${video.width}x${video.height}, ${ts(duration)}) in ${dir}:`];
  files.forEach((f, i) => lines.push(`  ${String(i + 1).padStart(3)}. ${ts(f.t)}  ${f.out}`));

  if (args.contact_sheet && files.length > 1) {
    const cols = Math.ceil(Math.sqrt(files.length)), rows = Math.ceil(files.length / cols);
    const tile = Math.max(160, Math.floor(Math.min(width, 2400 / cols)));
    const sheet = join(dir, `contact_sheet.${format}`);
    const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1', '-start_number', '1', '-i', join(dir, `frame_%03d.${format}`), '-frames:v', '1', '-vf', `scale=${tile}:-2,tile=${cols}x${rows}:padding=4:color=black`, sheet], { signal: ctx.signal }).catch(() => null);
    if (r?.code === 0 && (await statOrNull(sheet))) lines.push(`contact sheet (${cols}x${rows}, left-to-right, top-to-bottom): ${sheet}`);
    else lines.push(`contact sheet failed${r ? `: ${r.stderr.trim().split('\n').pop()}` : ''}`);
  }
  lines.push('View the images with the Read tool.');
  return lines.join('\n');
}

// ---- audio_analyze ------------------------------------------------------------

export async function audioAnalyze(args = {}, ctx = {}) {
  const file = await inputFile(args.path);
  const p = await probe(file, ctx.signal);
  const audio = p.streams?.find((s) => s.codec_type === 'audio');
  if (!audio) throw new ToolError('No audio stream in this file');
  const silenceDb = args.silence_db ?? -50;
  const silenceS = args.silence_min_s ?? 0.5;
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', `0:${audio.index}`, '-af', `silencedetect=noise=${silenceDb}dB:d=${silenceS},volumedetect,ebur128=peak=true:framelog=quiet`, '-f', 'null', '-'], { signal: ctx.signal, timeoutMs: 900_000 });
  if (r.code !== 0) throw new ToolError(`ffmpeg failed: ${r.stderr.trim().split('\n').pop()}`);
  const e = r.stderr;
  const grab = (re) => e.match(re)?.[1];
  const integrated = grab(/Integrated loudness:\s+I:\s+(-?[\d.]+|-inf) LUFS/);
  const lra = grab(/Loudness range:\s+LRA:\s+([\d.]+) LU/);
  const truePeak = grab(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/);
  const mean = grab(/mean_volume: (-?[\d.]+|-inf) dB/);
  const max = grab(/max_volume: (-?[\d.]+|-inf) dB/);
  const silences = [...e.matchAll(/silence_start: (-?[\d.]+)[\s\S]*?silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)].map((m) => ({ start: Math.max(0, Number(m[1])), end: Number(m[2]), dur: Number(m[3]) }));
  const openSilence = /silence_start: ([\d.]+)(?![\s\S]*silence_end)/.exec(e);
  const duration = Number(p.format?.duration ?? 0);
  if (openSilence) silences.push({ start: Number(openSilence[1]), end: duration, dur: duration - Number(openSilence[1]) });

  const lines = [
    `${basename(file)}: ${audio.codec_name}, ${audio.sample_rate} Hz, ${audio.channels} ch, ${ts(duration)}`,
    `integrated loudness: ${integrated ?? '?'} LUFS   loudness range: ${lra ?? '?'} LU   true peak: ${truePeak ?? '?'} dBTP`,
    `mean volume: ${mean ?? '?'} dB   max sample: ${max ?? '?'} dB`,
  ];
  const I = Number(integrated), tp = Number(truePeak);
  if (Number.isFinite(I)) {
    const target = I > -12 ? 'very loud (above typical streaming targets)' : I >= -16 ? 'loud, about streaming level (Spotify/YouTube ~ -14 LUFS)' : I >= -24 ? 'moderate (broadcast ~ -23 LUFS, podcasts ~ -16 LUFS)' : 'quiet';
    lines.push(`assessment: ${target}`);
  }
  if (Number(max) >= -0.1 || tp > 0) lines.push(`⚠ possible clipping: peak reaches ${tp > 0 ? `${tp} dBTP (above 0)` : '0 dBFS'}`);
  else if (tp > -1) lines.push('note: true peak above -1 dBTP; lossy encoding may clip');
  if (mean === '-inf') lines.push('⚠ the track is completely silent');
  if (silences.length) {
    const total = silences.reduce((a, s) => a + s.dur, 0);
    lines.push(`silence (< ${silenceDb} dB for ≥ ${silenceS}s): ${silences.length} section(s), ${total.toFixed(2)} s total`);
    for (const s of silences.slice(0, 20)) lines.push(`  ${ts(s.start)} – ${ts(s.end)} (${s.dur.toFixed(2)} s)${s.start < 0.05 ? ' leading' : Math.abs(s.end - duration) < 0.05 ? ' trailing' : ''}`);
    if (silences.length > 20) lines.push(`  … ${silences.length - 20} more`);
  } else {
    lines.push(`silence: none (< ${silenceDb} dB for ≥ ${silenceS}s)`);
  }

  if (args.image) {
    if (!['waveform', 'spectrogram'].includes(args.image)) throw new ToolError('image must be waveform or spectrogram');
    const dir = await outDir('audio', args.out_dir, file);
    const out = join(dir, `${args.image}.png`);
    const filter = args.image === 'waveform'
      ? 'aformat=channel_layouts=mono,showwavespic=s=1600x400:colors=0x3a86ff'
      : 'showspectrumpic=s=1600x800:legend=1:scale=log:fscale=log';
    const ri = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-filter_complex', `[0:${audio.index}]${filter}[v]`, '-map', '[v]', '-frames:v', '1', out], { signal: ctx.signal });
    lines.push(ri.code === 0 ? `${args.image}: ${out} (view with the Read tool)` : `${args.image} failed: ${ri.stderr.trim().split('\n').pop()}`);
  }
  return lines.join('\n');
}

// ---- image_edit ---------------------------------------------------------------

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i;

/** ffmpeg filter chain for the requested edits, in a fixed sensible order. */
function editFilters(a) {
  const vf = [];
  if (a.crop) {
    const { x = 0, y = 0, width, height } = a.crop;
    if (!width || !height) throw new ToolError('crop needs width and height (and optional x, y)');
    vf.push(`crop=${width}:${height}:${x}:${y}`);
  }
  if (a.rotate) {
    const r = ((a.rotate % 360) + 360) % 360;
    if (![90, 180, 270].includes(r)) throw new ToolError('rotate must be 90, 180 or 270');
    vf.push(r === 90 ? 'transpose=1' : r === 270 ? 'transpose=2' : 'transpose=1,transpose=1');
  }
  if (a.flip === 'horizontal') vf.push('hflip');
  else if (a.flip === 'vertical') vf.push('vflip');
  else if (a.flip) throw new ToolError('flip must be horizontal or vertical');
  if (a.width || a.height) {
    const fit = a.fit ?? 'contain';
    if (!['contain', 'cover', 'stretch'].includes(fit)) throw new ToolError('fit must be contain, cover or stretch');
    const enlarge = a.upscale === true;
    if (a.width && a.height) {
      if (fit === 'stretch') vf.push(`scale=${a.width}:${a.height}`);
      else if (fit === 'cover') vf.push(`scale=${a.width}:${a.height}:force_original_aspect_ratio=increase`, `crop=${a.width}:${a.height}`);
      // contain: fit inside the box; without upscale, never larger than the original
      else vf.push(enlarge ? `scale=${a.width}:${a.height}:force_original_aspect_ratio=decrease` : `scale='min(${a.width},iw)':'min(${a.height},ih)':force_original_aspect_ratio=decrease`);
    } else if (a.width) vf.push(`scale='${enlarge ? a.width : `min(${a.width},iw)`}':-2`);
    else vf.push(`scale=-2:'${enlarge ? a.height : `min(${a.height},ih)`}'`);
  }
  if (a.grayscale) vf.push('format=gray');
  return vf;
}

export async function imageEdit(args = {}, ctx = {}) {
  if (typeof args.path !== 'string') throw new ToolError('path is required (an image or a folder of images)');
  const src = resolve(args.path);
  const st = await statOrNull(src);
  if (!st) throw new ToolError(`Not found: ${src}`);
  let inputs = [src];
  if (st.isDirectory()) {
    inputs =(await readdir(src)).filter((n) => IMAGE_EXT.test(n)).sort().map((n) => join(src, n));
    if (!inputs.length) throw new ToolError(`No images in ${src}`);
    if (inputs.length > 500) throw new ToolError(`${inputs.length} images; limit is 500 per call`);
  }
  const vf = editFilters(args);
  const format = args.format?.toLowerCase().replace('jpeg', 'jpg');
  if (format && !['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'avif'].includes(format)) throw new ToolError('format must be png, jpg, webp, gif, bmp, tiff or avif');
  if (!vf.length && !format) throw new ToolError('Nothing to do: give width/height, crop, rotate, flip, grayscale or format');
  const quality = args.quality ?? 85;
  if (quality < 1 || quality > 100) throw new ToolError('quality must be 1-100');
  const dir = args.out_dir ? resolve(args.out_dir) : st.isDirectory() ? join(src, 'edited') : dirname(src);
  await mkdir(dir, { recursive: true });
  const lines = [];
  for (const [i, file] of inputs.entries()) {
    const ext = format ?? extname(file).slice(1).toLowerCase().replace('jpeg', 'jpg');
    const out = join(dir, `${basename(file, extname(file))}${args.suffix ?? (st.isDirectory() && args.out_dir ? '' : '_edited')}.${ext}`);
    if (out === file) throw new ToolError('Output would replace the original; set suffix or out_dir');
    if ((await statOrNull(out)) && !args.overwrite) throw new ToolError(`${out} exists; pass overwrite: true or another out_dir/suffix`);
    const q = ext === 'jpg' ? ['-q:v', String(Math.round(2 + ((100 - quality) / 100) * 29))] : ext === 'webp' ? ['-quality', String(quality)] : ext === 'avif' ? ['-crf', String(Math.round(63 - quality * 0.5))] : [];
    const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, ...(vf.length ? ['-vf', vf.join(',')] : []), '-frames:v', '1', ...q, ...(ext === 'gif' ? [] : ['-update', '1']), out], { signal: ctx.signal });
    if (r.code !== 0) {
      if (/Encoder not found|Unknown encoder/i.test(r.stderr)) {
        throw new ToolError(`This ffmpeg build cannot write ${ext} (encoder missing, e.g. libwebp for webp or libaom for avif). Pick png or jpg, or install a full ffmpeg build.`);
      }
      throw new ToolError(`ffmpeg failed on ${basename(file)}: ${r.stderr.trim().split('\n').pop()}`);
    }
    const [before, after] = await Promise.all([statOrNull(file), statOrNull(out)]);
    const dims = (await probe(out, ctx.signal)).streams?.find((s) => s.codec_type === 'video');
    lines.push(`${basename(file)} → ${out}  ${dims ? `${dims.width}x${dims.height}` : ''}  ${fmtBytes(before.size)} → ${fmtBytes(after.size)}`);
    ctx.progress?.(i + 1, inputs.length);
  }
  return [`${inputs.length} image(s) processed${vf.length ? ` (${vf.join(', ')})` : ''}:`, ...lines.slice(0, 200), lines.length > 200 ? `… ${lines.length - 200} more` : null, 'View results with the Read tool.'].filter(Boolean).join('\n');
}

// ---- image_compare ------------------------------------------------------------

async function decodeRgba(file, size, signal) {
  const vf = size ? ['-vf', `scale=${size.w}:${size.h}:flags=bicubic`] : [];
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', ...vf, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { signal });
  if (r.code !== 0) throw new ToolError(`Cannot decode ${file}: ${r.stderr.trim().split('\n').pop()}`);
  return r.stdout;
}

export async function imageCompare(args = {}, ctx = {}) {
  const a = await inputFile(args.a), b = await inputFile(args.b);
  const dims = async (f) => {
    const s = (await probe(f, ctx.signal)).streams?.find((x) => x.codec_type === 'video');
    if (!s) throw new ToolError(`${f} is not an image`);
    return { w: s.width, h: s.height };
  };
  const da = await dims(a), db = await dims(b);
  const sizeDiffers = da.w !== db.w || da.h !== db.h;
  if (sizeDiffers && !args.resize) throw new ToolError(`Sizes differ: ${da.w}x${da.h} vs ${db.w}x${db.h}. Set resize: true to scale b to a's size.`);
  if (da.w * da.h > 40e6) throw new ToolError('Images over 40 megapixels are not supported');
  const pa = await decodeRgba(a, null, ctx.signal);
  const pb = await decodeRgba(b, sizeDiffers ? da : null, ctx.signal);
  const threshold = args.threshold ?? 0;
  const { w, h } = da;

  let diffPixels = 0, maxDiff = 0, sumSq = 0, sumAbs = 0;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  const heat = Buffer.alloc(w * h * 4);
  for (let i = 0, px = 0; i < pa.length; i += 4, px++) {
    let d = 0;
    for (let c = 0; c < 4; c++) {
      const v = Math.abs(pa[i + c] - pb[i + c]);
      if (c < 3) {
        sumSq += v * v;
        sumAbs += v;
      }
      if (v > d) d = v;
    }
    if (d > maxDiff) maxDiff = d;
    const gray = Math.round((pa[i] * 0.299 + pa[i + 1] * 0.587 + pa[i + 2] * 0.114) * 0.35);
    if (d > threshold) {
      diffPixels++;
      const x = px % w, y = (px / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      heat[i] = 255;
      heat[i + 1] = Math.max(0, 200 - d);
      heat[i + 2] = 0;
    } else {
      heat[i] = heat[i + 1] = heat[i + 2] = gray;
    }
    heat[i + 3] = 255;
  }
  const total = w * h;
  const mse = sumSq / (total * 3);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  const lines = [
    `a: ${a} (${da.w}x${da.h})`,
    `b: ${b} (${db.w}x${db.h}${sizeDiffers ? `, scaled to ${w}x${h}` : ''})`,
    diffPixels === 0
      ? `identical${threshold ? ` within threshold ${threshold}` : ' (pixel-exact)'}`
      : `${diffPixels} of ${total} pixels differ (${((diffPixels / total) * 100).toFixed(3)}%) beyond threshold ${threshold}`,
    `max channel difference: ${maxDiff}/255   mean abs difference: ${(sumAbs / (total * 3)).toFixed(3)}   PSNR: ${psnr === Infinity ? '∞' : `${psnr.toFixed(2)} dB`}`,
  ];
  if (diffPixels) {
    lines.push(`differences inside box x ${x0}–${x1}, y ${y0}–${y1} (${x1 - x0 + 1}x${y1 - y0 + 1})`);
    const dir = await outDir('compare', args.out_dir, a);
    const out = join(dir, 'diff.png');
    const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', '-', '-frames:v', '1', out], { signal: ctx.signal, input: heat });
    lines.push(r.code === 0 ? `diff image (differences red/orange on dimmed a): ${out}` : `diff image failed: ${r.stderr.trim().split('\n').pop()}`);
  }
  return lines.join('\n');
}
