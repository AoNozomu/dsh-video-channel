/**
 * longform.js — 长视频（整集/整场）的扫描实现。
 *
 * 和上游 scan.js 的区别：
 *   · scan.js   做的是「一次解码，抓切点 + 去重」，为**分镜图**服务（≤28 格那种）；
 *   · 本文件    做的是「整集 26 分钟怎么看」，为**读完一整条长视频**服务：
 *              画面按相邻帧差异去重 → 拼成很多张 16 格的分镜；
 *              台词一秒不落地 OCR → 按时间码输出。
 *
 * 由 bin/scan-video.mjs 这个 CLI 改造而来，去掉命令行解析，改成接受参数对象、
 * 支持 AbortSignal，产出的 PNG 直接交回 index.js 走 ctx.attachments.saveImage()。
 *
 * 口径来自 2026-10-31 爸爸的要求：**画面可以省，台词一句都不能少。**
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractFrame } from './frames.js';
import { composeSheet } from './sheet.js';
import { encodePng } from './png.js';
import { run, parseFfmpegBanner } from './media.js';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** OCR 用的 python：由调用方传，或环境变量 DSH_OCR_PYTHON */
export const DEFAULT_OCR_PYTHON = process.env.DSH_OCR_PYTHON || '';

export const LONGFORM_DEFAULTS = {
  start: 0,
  end: null,
  step: 1,
  perSheet: 16,
  cols: 4,
  width: 480,
  gutter: 2,
  diff: 6,
  subtitle: true,
  ocrPython: DEFAULT_OCR_PYTHON,
  bottom: 0.80,
  ocrWidth: 960,
};

/** 时长：解析 ffmpeg -i 的输出（不依赖 ffprobe） */
async function probeDuration(input, ffmpegPath) {
  const res = await run(ffmpegPath, ['-hide_banner', '-nostdin', '-i', input], { timeoutMs: 30_000 });
  const meta = parseFfmpegBanner(res.stderr || '', input);
  if (meta?.duration) return Number(meta.duration);
  throw new Error('无法确定时长：请显式传 end（秒）');
}

/** 抽样比较两帧的差异（0-100）。每 97 个像素采一点（质数，避开规则图案） */
function frameDiff(a, b) {
  if (!a || !b || a.data.length !== b.data.length) return 100;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 97 * 3) {
    sum += Math.abs(a.data[i] - b.data[i])
      + Math.abs(a.data[i + 1] - b.data[i + 1])
      + Math.abs(a.data[i + 2] - b.data[i + 2]);
    n += 1;
  }
  return n ? (sum / (n * 3 * 255)) * 100 : 0;
}

/** 跑 python 脚本，取 stdout 最后一行的 JSON */
function runPython(py, script, args, signal) {
  return new Promise((resolve) => {
    const child = spawn(py, [script, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      let parsed = null;
      for (let i = lines.length - 1; i >= 0 && !parsed; i--) {
        try { parsed = JSON.parse(lines[i]); } catch { /* keep looking */ }
      }
      resolve({ ok: code === 0, code, parsed, stderr: stderr.slice(-600) });
    });
  });
}

/**
 * 相邻相似合并：同一句字幕停留 1-3 秒，每帧 OCR 出来略有不同。
 * 用二元组 Dice 系数比，对单字错误更宽容（「在灯管下滴」vs「疒下谪」仍算同一句）。
 */
export function mergeSubtitleLines(raw, maxGapSec = 3, threshold = 0.55) {
  const bigrams = (t) => {
    const out = new Set();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const similar = (a, b) => {
    if (!a.length || !b.length) return false;
    const A = bigrams(a);
    const B = bigrams(b);
    if (!A.size || !B.size) return a === b;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter += 1;
    return (2 * inter) / (A.size + B.size) >= threshold;
  };
  const clean = (s) => s.replace(/[丨|•·。、，,]+/g, '').trim();

  const groups = [];
  for (const item of raw) {
    const text = clean(item.text);
    // 2026-10-31 修：原来是 `if (text.length < 2) continue`，把**单字台词全丢了** ——
    //   「嗯」「哦」「喂」「走」「滚」这种在动画里极常见，尤其打斗场景。
    //   第一集 418 格底下明明有个「嗯」，成品台词里一条都没有。
    //   现在只丢空字符串；单字留着，宁可多一条也别漏。
    if (!text) continue;
    const last = groups[groups.length - 1];
    if (last && item.t - last[last.length - 1].t <= maxGapSec
      && similar(text, last[last.length - 1].text)) {
      last.push({ t: item.t, text });
    } else {
      groups.push([{ t: item.t, text }]);
    }
  }
  return groups.map((g) => {
    const best = g.reduce((x, y) => (y.text.length > x.text.length ? y : x), g[0]);
    return { t: g[0].t, text: best.text };
  });
}

/**
 * 扫一条长视频。
 *
 * @param {object} p
 * @param {string} p.input          视频路径（或 ffmpeg 能读的 URL）
 * @param {string} p.ffmpegPath     ffmpeg 路径
 * @param {number} [p.start=0]
 * @param {number} [p.end]          缺省到视频结尾
 * @param {number} [p.step=1]       每隔几秒抽一帧
 * @param {number} [p.perSheet=16]  每张分镜格数
 * @param {number} [p.cols=4]
 * @param {number} [p.width=480]    分镜格宽度
 * @param {number} [p.diff=6]       画面差异阈值
 * @param {boolean} [p.subtitle=true]
 * @param {string} [p.ocrPython]    RapidOCR 所在 python
 * @param {number} [p.bottom=0.80]  只认画面下方这个比例
 * @param {number} [p.ocrWidth=960] 给 OCR 的整帧宽度
 * @param {string} [p.outDir]
 * @param {AbortSignal} [p.signal]
 * @param {(s: string) => void} [p.log]
 */
export async function runLongform(p = {}) {
  // 注意：不能写 `{ ...LONGFORM_DEFAULTS, ...p }` —— 调用方常常把每个参数都显式传一遍
  // （哪怕是 undefined），而 JS 的对象展开会让 undefined **覆盖**默认值，
  // 结果 bottom 变成 undefined、传给 python 就是 `--bottom undefined`，OCR 直接报错退出。
  // 所以只接受「真的给了值」的键。
  const opt = { ...LONGFORM_DEFAULTS };
  for (const k of Object.keys(p)) {
    if (p[k] !== undefined && p[k] !== null) opt[k] = p[k];
  }
  if (!opt.input) throw new Error('input is required');
  if (!opt.ffmpegPath) throw new Error('ffmpeg not found');
  const log = typeof opt.log === 'function' ? opt.log : () => {};

  const duration = opt.end != null ? Number(opt.end) : await probeDuration(opt.input, opt.ffmpegPath);
  const start = Math.max(0, Number(opt.start) || 0);
  const step = Math.max(0.2, Number(opt.step) || 1);
  const outDir = opt.outDir || path.join(HOME, 'cache', 'video-vision', 'longform', `scan-${Date.now()}`);
  await fsp.mkdir(outDir, { recursive: true });

  const times = [];
  for (let t = start; t < duration; t += step) times.push(+t.toFixed(3));

  const cellW = Math.max(160, Number(opt.width) || 480);
  const cellH = Math.round(cellW * 9 / 16);
  const per = Math.max(1, Number(opt.perSheet) || 16);
  const cols = Math.min(Math.max(1, Number(opt.cols) || 4), per);
  const rows = Math.ceil(per / cols);
  const gutter = Number(opt.gutter) ?? 2;
  const grid = {
    width: cols * cellW + (cols + 1) * gutter,
    height: rows * cellH + (rows + 1) * gutter,
    rows, cols, cellW, cellH,
  };

  // ── 1. 抽整帧（960 宽，只给 OCR；认完就删）
  const frameDir = path.join(outDir, '_frames');
  await fsp.mkdir(frameDir, { recursive: true });
  const ocrW = Math.max(480, Number(opt.ocrWidth) || 960);
  const ocrH = Math.round(ocrW * 9 / 16);
  let frameFiles = [];

  if (opt.subtitle) {
    const fps = 1 / step;
    const tpl = path.join(frameDir, 'f%05d.png');
    const res = await run(opt.ffmpegPath, [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-ss', String(start), '-t', String(Math.max(0.5, duration - start)),
      '-i', opt.input,
      '-vf', `fps=${fps},scale=${ocrW}:${ocrH}`,
      '-q:v', '2', '-y', tpl,
    ], { timeoutMs: 1_800_000, signal: opt.signal });
    if (res.code !== 0) log(`抽帧失败：${String(res.stderr || '').slice(-200)}`);
    frameFiles = (await fsp.readdir(frameDir)).filter((n) => n.endsWith('.png')).sort();
    log(`整帧 ${frameFiles.length} 张（${ocrW}px 宽，给 OCR）`);
  }

  // ── 2. OCR（只留底部字幕区）
  const byFrame = new Map();
  let ocrWarned = '';
  if (opt.subtitle && frameFiles.length) {
    const script = path.join(HERE, '..', 'bin', 'ocr_frames.py');
    if (!fs.existsSync(script)) {
      ocrWarned = 'bin/ocr_frames.py 不存在，已跳过台词 OCR';
    } else if (!opt.ocrPython || !fs.existsSync(opt.ocrPython)) {
      ocrWarned = '没有可用的 OCR python（传 ocrPython 或设 DSH_OCR_PYTHON），已跳过台词 OCR';
    } else {
      log('正在 OCR（RapidOCR）…');
      const r = await runPython(opt.ocrPython, script,
        [frameDir, '--bottom', String(opt.bottom), '--quiet'], opt.signal);
      if (!r.ok || !r.parsed) {
        ocrWarned = `OCR 失败：${r.stderr || r.error || `exit ${r.code}`}`;
      } else {
        try {
          const raw = JSON.parse(await fsp.readFile(r.parsed.out, 'utf8'));
          for (const fr of raw.frames || []) byFrame.set(fr.file, fr.lines || []);
          log(`OCR 完成：${r.parsed.withText}/${r.parsed.frames} 帧有字，${r.parsed.seconds}s`);
        } catch (e) {
          ocrWarned = `读 OCR 结果失败：${e.message}`;
        }
      }
    }
    if (ocrWarned) log(ocrWarned);
  }

  // ── 3. 逐帧：抽小图（去重后拼图用）+ 收集台词
  const kept = [];
  let lastKept = null;
  let dropped = 0;
  const rawLines = [];

  for (let i = 0; i < times.length; i++) {
    if (opt.signal?.aborted) throw new Error('scan aborted');
    const t = times[i];
    const frame = await extractFrame({
      input: opt.input, ffmpegPath: opt.ffmpegPath, t, width: cellW, height: cellH,
    });
    if (!frame.data) { dropped += 1; continue; }

    if (opt.subtitle && frameFiles.length) {
      const name = `f${String(i + 1).padStart(5, '0')}.png`;
      const lines = byFrame.get(name) || [];
      const body = lines.map((l) => String(l.text || '')).join('').replace(/[\s\u3000]+/g, '');
      if (body && body.length >= 2) rawLines.push({ t, text: body });
    }

    const d = frameDiff(lastKept, frame);
    if (lastKept == null || d >= Number(opt.diff ?? 6)) {
      kept.push({ t, frame });
      lastKept = frame;
    } else {
      dropped += 1;
    }
  }
  log(`画面：抽 ${times.length} 帧 → 保留 ${kept.length}、丢弃 ${dropped} 重复`);

  // ── 4. 台词合并
  const subtitles = mergeSubtitleLines(rawLines);
  const subtitleFile = path.join(outDir, 'subtitles.txt');
  await fsp.writeFile(subtitleFile,
    subtitles.map((s) => `[${s.t.toFixed(0)}s] ${s.text}`).join('\n'), 'utf8');
  log(`台词：${rawLines.length} 帧 → ${subtitles.length} 条`);

  // ── 5. 拼图
  const sheets = [];
  let batch = 0;
  for (let b = 0; b < kept.length; b += per) {
    batch += 1;
    const chunk = kept.slice(b, b + per);
    const cells = chunk.map((c, k) => ({
      index: b + k + 1,
      frame: c.frame.data,
      width: c.frame.width,
      height: c.frame.height,
    }));
    const pixels = composeSheet({ grid, cells, gutter });
    const png = encodePng(pixels.data, pixels.width, pixels.height);
    const name = `sheet-${String(batch).padStart(3, '0')}.png`;
    await fsp.writeFile(path.join(outDir, name), png);
    sheets.push({
      name,
      png,
      from: chunk[0].t,
      to: chunk[chunk.length - 1].t,
      cells: chunk.map((c, k) => ({ n: b + k + 1, t: c.t })),
    });
    log(`${name}  ${chunk.length} 格  ${chunk[0].t.toFixed(0)}s-${chunk[chunk.length - 1].t.toFixed(0)}s`);
  }

  await fsp.rm(frameDir, { recursive: true, force: true }).catch(() => {});

  const indexFile = path.join(outDir, 'index.json');
  await fsp.writeFile(indexFile, JSON.stringify({
    input: opt.input, start, end: duration, step, perSheet: per, cellW, cellH,
    totalFrames: times.length, keptFrames: kept.length, droppedFrames: dropped,
    sheets: sheets.map(({ png, ...rest }) => rest),
    subtitles: subtitleFile,
  }, null, 2));

  return {
    outDir,
    indexFile,
    subtitleFile,
    duration,
    start,
    totalFrames: times.length,
    keptFrames: kept.length,
    droppedFrames: dropped,
    subtitles,
    sheets,
    ocrWarned,
  };
}

/** 从 `outDir/index.json` + `subtitles.txt` 里查出「某句台词落在哪张图的哪一格」 */
export async function locateInScan(dir, { at, grep, range } = {}) {
  const idxRaw = await fsp.readFile(path.join(dir, 'index.json'), 'utf8');
  const idx = JSON.parse(idxRaw);
  const cells = [];
  for (const sh of idx.sheets || []) {
    for (const c of sh.cells || []) cells.push({ ...c, sheet: sh.name });
  }
  cells.sort((a, b) => a.t - b.t);

  let subs = [];
  const sp = path.join(dir, 'subtitles.txt');
  if (fs.existsSync(sp)) {
    for (const line of (await fsp.readFile(sp, 'utf8')).split('\n')) {
      const m = line.match(/^\[(\d+)s\]\s*(.+)$/);
      if (m) subs.push({ t: Number(m[1]), text: m[2].trim() });
    }
  }

  const cellAt = (t) => {
    let best = null;
    let bestD = Infinity;
    for (const c of cells) {
      const d = Math.abs(c.t - t);
      if (d < bestD) { bestD = d; best = c; }
    }
    return bestD <= 3 ? best : null;
  };

  const out = [];
  if (at != null) {
    const c = cellAt(Number(at));
    const near = subs.filter((s) => Math.abs(s.t - Number(at)) <= 4);
    out.push({
      query: `at ${at}s`,
      cell: c ? { sheet: c.sheet, n: c.n, t: c.t } : null,
      lines: near,
    });
  } else if (grep) {
    for (const s of subs.filter((x) => x.text.includes(grep))) {
      const c = cellAt(s.t);
      out.push({
        query: grep,
        line: s,
        cell: c ? { sheet: c.sheet, n: c.n, t: c.t } : null,
      });
    }
  } else if (Array.isArray(range)) {
    const [a, b] = range;
    for (const s of subs.filter((x) => x.t >= a && x.t <= b)) {
      const c = cellAt(s.t);
      out.push({ line: s, cell: c ? { sheet: c.sheet, n: c.n, t: c.t } : null });
    }
  }

  return { dir, sheets: (idx.sheets || []).length, cells: cells.length, subtitles: subs.length, results: out };
}
