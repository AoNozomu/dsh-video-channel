/**
 * OCR backend.
 *
 * A video of a lecture, a slide deck or a screen recording carries most of its
 * information as *text on the picture*, and text is the cheapest thing a model
 * can be handed: a 2-hour lecture is ~20k characters, while pictures of the same
 * lecture are capped at 1024 vision tokens and are unreadable at that size.
 *
 * TWO backends, RapidOCR first (2026-11-01):
 *
 *   1. **rapidocr** — `E:\ocr-env` (or $DSH_OCR_PYTHON). This is the one to
 *      prefer. Measured on the same 8 frames, Windows Media OCR vs RapidOCR:
 *        「4K修复播放室」  windows: `4K 修 复 播 放 室 LiliLi\i`   rapid: `4K修复播放室`
 *        「bilibili」     windows: LiliLili / VliLi\i / LiIiLiIi / LiliLiIi（8 帧 4 种错法）
 *                                               rapid: `bilibili`（8 帧全对）
 *        「迈克·庞德史密斯」windows: `迈 克 到 庞 德 史 密 斯`（字都错了）
 *                                               rapid: `迈克·庞德史密斯`
 *      Windows OCR also inserts a space between every CJK character, which
 *      wrecks substring matching downstream.
 *
 *   2. **windows-media-ocr** — Windows.Media.Ocr via `bin/ocr-batch.ps1`. Kept as
 *      the fallback: no download, no model, ~100 ms/frame. Good enough for big
 *      printed text (slides), poor for CJK subtitles burned over video.
 *
 * The caller never chooses: `ocrDirectory` picks the best available and reports
 * which one ran, so a silent quality regression is visible in the result.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRapidPython } from './ocr-python.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(HERE, '..', 'bin', 'ocr-batch.ps1');
const SCRIPT_RAPID = join(HERE, '..', 'bin', 'ocr-batch-rapid.py');
const POWERSHELL = process.env.DSH_POWERSHELL || join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// ⚠️ 2026-11-01：原本这里写死 `E:\ocr-env\Scripts\python.exe` —— 那是**一台机器的布局**。
//   这个仓库是公开的，写死路径等于"只有作者那台能用"。改成探测（见 src/ocr-python.js），
//   `$DSH_OCR_PYTHON` 仍然最高优先，一个都找不到才退回 Windows.Media.Ocr。

let cachedBackend = null;

/**
 * Is there an OCR engine we can drive? Prefers RapidOCR; falls back to Windows.
 * @returns {{ok: boolean, engine: string|null, reason?: string, bin?: string, script?: string}}
 */
export function ocrBackend() {
  if (cachedBackend) return cachedBackend;

  // ① RapidOCR —— 准确率高得多，能用就一定用它（路径靠探测，不写死）
  const rapidPython = existsSync(SCRIPT_RAPID) ? findRapidPython() : null;
  if (rapidPython) {
    cachedBackend = {
      ok: true,
      engine: 'rapidocr',
      bin: rapidPython,
      script: SCRIPT_RAPID,
      // Windows 版作兜底：RapidOCR 崩了还能出字，不至于整条链路失败
      fallback: existsSync(SCRIPT) && existsSync(POWERSHELL) ? 'windows-media-ocr' : null,
    };
    return cachedBackend;
  }

  // ② Windows.Media.Ocr
  if (process.platform !== 'win32') {
    cachedBackend = {
      ok: false,
      engine: null,
      reason: 'no OCR engine: RapidOCR needs python + rapidocr_onnxruntime (set DSH_OCR_PYTHON), '
        + 'and the Windows engine is only wired up on win32',
    };
    return cachedBackend;
  }
  if (!existsSync(SCRIPT)) {
    cachedBackend = { ok: false, engine: null, reason: `missing ${SCRIPT}（也没有 RapidOCR python）` };
    return cachedBackend;
  }
  if (!existsSync(POWERSHELL)) {
    cachedBackend = { ok: false, engine: null, reason: `missing ${POWERSHELL}` };
    return cachedBackend;
  }
  cachedBackend = { ok: true, engine: 'windows-media-ocr', script: SCRIPT, bin: POWERSHELL };
  return cachedBackend;
}

/**
 * OCR every PNG in a directory, in ONE process (engine startup dominates the
 * per-image cost, so batching matters more than concurrency).
 *
 * @param {string} dir directory of `*.png` files
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<Map<string,{text:string,lines:object[],width:number,height:number}>>}
 */
export async function ocrDirectory(dir, opts = {}) {
  const backend = ocrBackend();
  if (!backend.ok) throw new Error(`OCR unavailable: ${backend.reason}`);
  const out = join(dir, 'ocr.txt');

  // 按后端拼命令。两个脚本的输出格式**故意做成一样**（`== f0001 ==` / `@@ w h` / `x0 y0 x1 y1\ttext`），
  // 所以下面的 parseSection 只需要一套。
  const build = (eng) => {
    if (eng === 'rapidocr') {
      return {
        bin: backend.bin,
        args: [backend.script, '-Dir', dir, '-Out', out],
      };
    }
    return {
      bin: backend.bin || POWERSHELL,
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
        '-Dir', dir, '-Out', out],
    };
  };

  const attempt = async (eng) => {
    const { bin, args } = build(eng);
    await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], signal: opts.signal });
      let err = '';
      child.stderr.on('data', (c) => { err += c.toString('utf8'); });
      const timer = opts.timeoutMs
        ? setTimeout(() => { child.kill(); reject(new Error(`OCR timed out after ${opts.timeoutMs} ms`)); }, opts.timeoutMs)
        : null;
      child.on('error', reject);
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        // ⚠️ RapidOCR 会把 `ok frames=.. lines=..` 打到 stderr，非 0 退出才当失败
        if (code !== 0) reject(new Error(`OCR(${eng}) failed (${code}): ${err.slice(-400)}`));
        else resolve();
      });
    });
  };

  let used = backend.engine;
  let firstError = null;
  try {
    await attempt(backend.engine);
  } catch (e) {
    firstError = e;
    // 兜底：RapidOCR 挂了就退回 Windows OCR，总比整条链路失败好
    if (backend.engine === 'rapidocr' && backend.fallback) {
      used = backend.fallback;
      await attempt(backend.fallback);
    } else {
      throw e;
    }
  }

  if (!existsSync(out)) throw new Error(`OCR(${used}) 没产出 ${out}${firstError ? `；首选后端报错：${String(firstError.message).slice(0, 200)}` : ''}`);
  const text = readFileSync(out, 'utf8');
  const parts = text.split(/^== (f\d+) ==\r?\n/gm);
  const map = new Map();
  for (let i = 1; i < parts.length; i += 2) map.set(parts[i], parseSection(parts[i + 1]));
  // anything the engine skipped stays empty rather than missing
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.png')) continue;
    const stem = file.slice(0, -4);
    if (!map.has(stem)) map.set(stem, { text: '', lines: [], width: 0, height: 0 });
  }
  // 让"实际用了哪个引擎"跟着结果走 —— 静默降级成 Windows OCR 会明显掉质量，得看得见
  map.engine = used;
  return map;
}

/**
 * A recognised screen: the raw text, and each line with the box it occupied, so
 * the caller can throw away a tab strip without being told which app drew it.
 * @param {string} section one `== stem ==` block
 */
function parseSection(section) {
  const lines = [];
  let width = 0;
  let height = 0;
  for (const raw of section.split(/\r?\n/)) {
    if (!raw) continue;
    if (raw.startsWith('@@ ')) {
      const [w, h] = raw.slice(3).split(' ').map(Number);
      width = w || 0;
      height = h || 0;
      continue;
    }
    const tab = raw.indexOf('\t');
    if (tab > 0) {
      const [x0, y0, x1, y1] = raw.slice(0, tab).split(' ').map(Number);
      lines.push({ text: raw.slice(tab + 1), x0, y0, x1, y1 });
    } else {
      lines.push({ text: raw, x0: 0, y0: 0, x1: 0, y1: 0 });
    }
  }
  return { text: lines.map((l) => l.text).join('\n'), lines, width, height };
}
