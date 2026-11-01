/**
 * Where is the RapidOCR python?
 *
 * Why this file exists (2026-11-01): the first version of `ocr.js` and
 * `bin/scan-video.mjs` both hardcoded `E:\ocr-env\Scripts\python.exe` — that is
 * ONE machine's layout. Published as-is, the plugin would only work on the
 * machine that wrote it, which is exactly the kind of bug that makes a public
 * repo useless to everyone else (and this repo *is* public).
 *
 * So: try, in order,
 *   1. `$DSH_OCR_PYTHON`                    — explicit, always wins
 *   2. `<plugin>/vendor/ocr-env/...`        — self-contained install
 *   3. `<plugin>/../ocr-env/...`            — sibling of the checkout
 *   4. `%LOCALAPPDATA%\ocr-env\...`         — per-user install
 *   5. `%USERPROFILE%\ocr-env\...`          — home install
 *   6. `<drive>:\ocr-env\...`               — the original layout, kept last so
 *                                             the machine that has it still works
 * and let the caller fall back to Windows.Media.Ocr when none exist.
 *
 * The engine itself is optional: without it the plugin still runs, just with
 * the weaker Windows OCR (see src/ocr.js for the measured difference).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');

/** candidate `python.exe` paths, most specific first */
export function rapidPythonCandidates() {
  const out = [];
  const env = process.env.DSH_OCR_PYTHON;
  if (env) out.push(env);

  const rel = join('Scripts', 'python.exe');
  out.push(join(PLUGIN_ROOT, 'vendor', 'ocr-env', rel));
  out.push(join(PLUGIN_ROOT, '..', 'ocr-env', rel));

  const local = process.env.LOCALAPPDATA;
  if (local) out.push(join(local, 'ocr-env', rel));
  try { out.push(join(homedir(), 'ocr-env', rel)); } catch { /* no home */ }

  // the original hardcoded layout, kept as the last resort
  if (process.platform === 'win32') {
    for (const drive of ['E', 'D', 'C']) out.push(`${drive}:\\ocr-env\\${rel}`);
  }
  return [...new Set(out)];
}

/**
 * Pick the first candidate that exists. Does NOT import rapidocr (that would
 * need the interpreter itself), so callers must treat a hit as "probably works"
 * and still handle failure — `ocrDirectory` falls back to Windows OCR.
 * @returns {string|null}
 */
export function findRapidPython() {
  for (const p of rapidPythonCandidates()) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Same, but actually proves `rapidocr_onnxruntime` imports. Costs ~1s once, so
 * cache the answer; a python that exists but lacks the package is worse than no
 * python at all (it would fail on every frame).
 * @returns {string|null}
 */
let probed;
export function findRapidPythonProven() {
  if (probed !== undefined) return probed;
  for (const p of rapidPythonCandidates()) {
    if (!existsSync(p)) continue;
    try {
      execFileSync(p, ['-c', 'import rapidocr_onnxruntime'], {
        stdio: 'ignore',
        timeout: 20_000,
        windowsHide: true,
      });
      probed = p;
      return p;
    } catch { /* try the next candidate */ }
  }
  probed = null;
  return null;
}

/** forget the probe (used by tests) */
export function resetRapidPythonProbe() {
  probed = undefined;
}
