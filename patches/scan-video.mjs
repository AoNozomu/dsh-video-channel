#!/usr/bin/env node
/**
 * scan-video.mjs —— 逐秒扫描视频：画面按「变化」保留，台词按「全部」读出。
 *
 * 爸爸定的口径（2026-10-31）：
 *   画面可以省，台词一句都不能少 —— 所以两者分开处理：
 *     · 画面：相邻帧差异小的丢弃（同一张脸不会刷 N 遍），拼成带格号的分镜图；
 *     · 台词：抽出来的整帧交给 RapidOCR（E:\ocr-env）逐帧识别，只取底部字幕区，
 *             按时间码输出，相邻重复合并。
 *
 * 为什么用 RapidOCR 而不是 Windows 自带 OCR（2026-10-31 实测）：
 *   Windows 版会把「在灯管下滴答」读成「疒下谪」，而且同一帧时好时坏；
 *   RapidOCR 对**整帧**识别准确率高（「阿维达」「砸锅了这单黄了」100% 对），
 *   但对**细长字幕条**会直接返回空 —— 所以喂整帧、再按 y 坐标裁出底部字幕。
 *
 * 用法：
 *   node bin/scan-video.mjs <视频文件> [--start 0] [--end 780] [--step 1]
 *                            [--per-sheet 16] [--cols 4] [--width 480]
 *                            [--ocr-python E:\ocr-env\Scripts\python.exe]
 *                            [--no-subtitle] [--out <目录>]
 *
 * 输出：<out>/sheet-001.png ...（画面）+ <out>/subtitles.txt（带 [秒] 的台词）+ <out>/index.json
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractFrame } from '../src/frames.js';
import { composeSheet } from '../src/sheet.js';
import { encodePng } from '../src/png.js';
import { findFfmpeg, findFfprobe, run, parseFfmpegBanner } from '../src/media.js';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OCR_PY = process.env.DSH_OCR_PYTHON || 'E:\\ocr-env\\Scripts\\python.exe';

function parseArgs(argv) {
  const out = {
    start: 0, end: null, step: 1, perSheet: 16, cols: 4, width: 480,
    gutter: 2, subtitle: true, diff: 6, ocrPython: DEFAULT_OCR_PY,
    bottom: 0.80, ocrWidth: 960,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--start') out.start = Number(next());
    else if (a === '--end') out.end = Number(next());
    else if (a === '--step') out.step = Math.max(0.2, Number(next()));
    else if (a === '--per-sheet') out.perSheet = Math.max(1, Number(next()));
    else if (a === '--cols') out.cols = Math.max(1, Number(next()));
    else if (a === '--width') out.width = Math.max(160, Number(next()));
    else if (a === '--diff') out.diff = Math.max(0, Number(next()));
    else if (a === '--bottom') out.bottom = Math.max(0.3, Math.min(0.95, Number(next())));
    else if (a === '--ocr-width') out.ocrWidth = Math.max(480, Number(next()));
    else if (a === '--ocr-python') out.ocrPython = next();
    else if (a === '--out') out.out = next();
    else if (a === '--ffmpeg') out.ffmpeg = next();
    else if (a === '--no-subtitle') out.subtitle = false;
    else rest.push(a);
  }
  out.input = rest[0];
  return out;
}

async function probeDuration(input, ffmpegPath) {
  const probe = await findFfprobe();
  if (probe) {
    const res = await run(probe, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', input,
    ], { timeoutMs: 30_000 });
    const n = Number(String(res.stderr || res.stdout || '').trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  const res = await run(ffmpegPath, ['-hide_banner', '-nostdin', '-i', input], { timeoutMs: 30_000 });
  const meta = parseFfmpegBanner(res.stderr || '', input);
  if (meta?.duration) return Number(meta.duration);
  throw new Error('没法确定时长：请显式传 --end <秒>');
}

function frameDiff(a, b) {
  if (!a || !b || a.data.length !== b.data.length) return 100;
  let sum = 0, n = 0;
  for (let i = 0; i < a.data.length; i += 97 * 3) {
    sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    n += 1;
  }
  return n ? (sum / (n * 3 * 255)) * 100 : 0;
}

/** 跑 python 脚本，返回 stdout 里最后一行的 JSON */
function runPython(py, script, args) {
  return new Promise((resolve) => {
    const child = spawn(py, [script, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('用法：node bin/scan-video.mjs <视频文件> [--start 0] [--end 秒] [--step 1]');
    process.exit(2);
  }

  const ffmpegPath = args.ffmpeg || await findFfmpeg();
  if (!ffmpegPath) { console.error('找不到 ffmpeg'); process.exit(2); }

  const duration = args.end != null ? args.end : await probeDuration(args.input, ffmpegPath);
  const outDir = args.out || path.join(HOME, 'shots', 'scan', `scan-${Date.now()}`);
  await fsp.mkdir(outDir, { recursive: true });

  const start = Math.max(0, args.start);
  const step = args.step;
  const times = [];
  for (let t = start; t < duration; t += step) times.push(+t.toFixed(3));

  const cellW = args.width;
  const cellH = Math.round(cellW * 9 / 16);
  const per = args.perSheet;
  const cols = Math.min(args.cols, per);
  const rows = Math.ceil(per / cols);
  const grid = {
    width: cols * cellW + (cols + 1) * args.gutter,
    height: rows * cellH + (rows + 1) * args.gutter,
    rows, cols, cellW, cellH,
  };

  // ── 1. 抽整帧（给 OCR 用，分辨率高一点）
  const frameDir = path.join(outDir, '_frames');
  await fsp.mkdir(frameDir, { recursive: true });
  const ocrH = Math.round(args.ocrWidth * 9 / 16);
  let frameFiles = [];

  if (args.subtitle) {
    const fps = 1 / step;
    const tpl = path.join(frameDir, 'f%05d.png');
    const res = await run(ffmpegPath, [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-ss', String(start), '-t', String(Math.max(0.5, duration - start)),
      '-i', args.input,
      '-vf', `fps=${fps},scale=${args.ocrWidth}:${ocrH}`,
      '-q:v', '2', '-y', tpl,
    ], { timeoutMs: 1_800_000 });
    if (res.code !== 0) console.error(`  ⚠ 抽帧失败：${String(res.stderr || '').slice(-200)}`);
    frameFiles = (await fsp.readdir(frameDir)).filter((n) => n.endsWith('.png')).sort();
    console.error(`  整帧 ${frameFiles.length} 张（${args.ocrWidth}px 宽，给 OCR）`);
  }

  // ── 2. OCR（RapidOCR，只留底部字幕区）
  const byFrame = new Map();
  if (args.subtitle && frameFiles.length) {
    const script = path.join(HERE, 'ocr_frames.py');
    if (!fs.existsSync(script)) {
      console.error(`  ⚠ 找不到 ${script}`);
    } else if (!fs.existsSync(args.ocrPython)) {
      console.error(`  ⚠ 找不到 OCR 的 python：${args.ocrPython}（用 --ocr-python 指定）`);
    } else {
      console.error('  正在 OCR（RapidOCR）…');
      const r = await runPython(args.ocrPython, script, [frameDir, '--bottom', String(args.bottom), '--quiet']);
      if (!r.ok || !r.parsed) {
        console.error(`  ⚠ OCR 失败：${r.stderr || r.error || `exit ${r.code}`}`);
      } else {
        try {
          const raw = JSON.parse(await fsp.readFile(r.parsed.out, 'utf8'));
          for (const fr of raw.frames || []) byFrame.set(fr.file, fr.lines || []);
          console.error(`  OCR 完成：${r.parsed.withText}/${r.parsed.frames} 帧有字，${r.parsed.seconds}s`);
        } catch (e) {
          console.error(`  ⚠ 读 OCR 结果失败：${e.message}`);
        }
      }
    }
  }

  // ── 3. 逐帧：抽小图（拼图用）+ 收集台词
  const kept = [];
  let lastKept = null;
  let dropped = 0;
  const rawLines = [];

  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const frame = await extractFrame({ input: args.input, ffmpegPath, t, width: cellW, height: cellH });
    if (!frame.data) { dropped += 1; continue; }

    // 台词：用 OCR 结果（帧号对时间）
    if (args.subtitle && frameFiles.length) {
      const name = `f${String(i + 1).padStart(5, '0')}.png`;
      const lines = byFrame.get(name) || [];
      const body = lines.map((l) => String(l.text || '')).join('').replace(/[\s\u3000]+/g, '');
      if (body && body.length >= 2) rawLines.push({ t, text: body });
    }

    // 画面：只保留"变了"的
    const d = frameDiff(lastKept, frame);
    if (lastKept == null || d >= args.diff) {
      kept.push({ t, frame });
      lastKept = frame;
    } else {
      dropped += 1;
    }
  }

  console.error(`  画面：抽 ${times.length} 帧 → 保留 ${kept.length}、丢弃 ${dropped} 重复`);

  // ── 4. 台词：相邻相同的合并（字幕停留 1-3 秒），保留最完整的一版
  let subtitleFile = null;
  if (rawLines.length) {
    const clean = (s) => s.replace(/[丨|•·。、，,]+/g, '').trim();
    const bigrams = (t) => {
      const out = new Set();
      for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
      return out;
    };
    const similar = (a, b) => {
      if (!a.length || !b.length) return false;
      const A = bigrams(a), B = bigrams(b);
      if (!A.size || !B.size) return a === b;
      let inter = 0;
      for (const g of A) if (B.has(g)) inter += 1;
      return (2 * inter) / (A.size + B.size) >= 0.55;
    };
    const groups = [];
    for (const item of rawLines) {
      const text = clean(item.text);
      if (text.length < 2) continue;
      const last = groups[groups.length - 1];
      if (last && item.t - last[last.length - 1].t <= 3 && similar(text, last[last.length - 1].text)) {
        last.push({ t: item.t, text });
      } else {
        groups.push([{ t: item.t, text }]);
      }
    }
    const out = groups.map((g) => {
      const best = g.reduce((x, y) => (y.text.length > x.text.length ? y : x), g[0]);
      return `[${g[0].t.toFixed(0)}s] ${best.text}`;
    });
    subtitleFile = path.join(outDir, 'subtitles.txt');
    await fsp.writeFile(subtitleFile, out.join('\n'), 'utf8');
    console.error(`  台词：${rawLines.length} 帧 → ${out.length} 条 → ${subtitleFile}`);
  }

  // ── 5. 拼图（只放保留下来的画面）
  const sheets = [];
  let batch = 0;
  for (let b = 0; b < kept.length; b += per) {
    batch += 1;
    const chunk = kept.slice(b, b + per);
    const cells = chunk.map((c, k) => ({
      index: b + k + 1,
      frame: c.frame.data, width: c.frame.width, height: c.frame.height,
    }));
    const pixels = composeSheet({ grid, cells, gutter: args.gutter });
    const name = `sheet-${String(batch).padStart(3, '0')}.png`;
    const file = path.join(outDir, name);
    await fsp.writeFile(file, encodePng(pixels.data, pixels.width, pixels.height));
    sheets.push({ file, cells: chunk.map((c, k) => ({ n: b + k + 1, t: c.t })) });
    console.error(`  ${name}  ${chunk.length} 格  ${chunk[0].t.toFixed(0)}s-${chunk[chunk.length - 1].t.toFixed(0)}s`);
  }

  await fsp.rm(frameDir, { recursive: true, force: true }).catch(() => {});

  const indexPath = path.join(outDir, 'index.json');
  await fsp.writeFile(indexPath, JSON.stringify({
    input: args.input, start, end: duration, step, perSheet: per, cellW, cellH,
    totalFrames: times.length, keptFrames: kept.length, droppedFrames: dropped,
    sheets, subtitles: subtitleFile,
  }, null, 2));

  console.log(JSON.stringify({
    ok: true, outDir, indexPath, sheets: sheets.length,
    totalFrames: times.length, keptFrames: kept.length, droppedFrames: dropped,
    subtitles: subtitleFile, first: sheets[0]?.file, last: sheets[sheets.length - 1]?.file,
  }));
}

main().catch((e) => {
  console.error('失败：' + (e?.message ?? e));
  process.exit(1);
});
