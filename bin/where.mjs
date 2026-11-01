#!/usr/bin/env node
/**
 * where.mjs —— 台词 ↔ 画面 的对照：给一句话/一个秒数，指出它落在哪张分镜的哪一格。
 *
 * 为什么需要它（2026-10-31）：
 *   scan-video 产出两样东西 —— 分镜图（画面）和 subtitles.txt（台词，带 [秒]）。
 *   但「这句台词是谁说的、画面里那个人长什么样」这两个信息分开放，光看台词会认错人
 *   （实际发生过：把金王认成罗曼）。这个工具把两边对上，让人能直接跳到那一格去看脸。
 *
 * 用法：
 *   node bin/where.mjs <scan输出目录> --at 233            # 第 233 秒那格在哪
 *   node bin/where.mjs <scan输出目录> --grep "米格尔"      # 含这句台词的格子
 *   node bin/where.mjs <scan输出目录> --range 200 260      # 这一段的所有台词+格号
 */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = { at: null, grep: null, range: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--at') out.at = Number(argv[++i]);
    else if (a === '--grep') out.grep = argv[++i];
    else if (a === '--range') { out.range = [Number(argv[++i]), Number(argv[++i])]; }
    else rest.push(a);
  }
  out.dir = rest[0];
  return out;
}

function load(dir) {
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const cells = [];
  for (const sh of idx.sheets || []) {
    for (const c of sh.cells || []) cells.push({ ...c, sheet: path.basename(sh.file), file: sh.file });
  }
  cells.sort((a, b) => a.t - b.t);

  let subs = [];
  const sp = path.join(dir, 'subtitles.txt');
  if (fs.existsSync(sp)) {
    for (const line of fs.readFileSync(sp, 'utf8').split('\n')) {
      const m = line.match(/^\[(\d+)s\]\s*(.+)$/);
      if (m) subs.push({ t: Number(m[1]), text: m[2].trim() });
    }
  }
  return { idx, cells, subs };
}

/** 找离 t 最近的格（不超过 3 秒） */
function cellAt(cells, t) {
  let best = null;
  let bestD = Infinity;
  for (const c of cells) {
    const d = Math.abs(c.t - t);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= 3 ? best : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('用法：node bin/where.mjs <scan输出目录> --at 秒 | --grep 关键词 | --range 起 止');
    process.exit(2);
  }
  const { idx, cells, subs } = load(args.dir);
  console.log(`目录 ${args.dir}`);
  console.log(`共 ${idx.sheets.length} 张分镜 / ${cells.length} 格 / ${subs.length} 条台词（${idx.start}s-${idx.end}s）`);
  console.log('');

  if (args.at != null) {
    const c = cellAt(cells, args.at);
    const near = subs.filter((s) => Math.abs(s.t - args.at) <= 4);
    console.log(`第 ${args.at}s：`);
    if (c) console.log(`  看 ${c.sheet} 的第 ${c.n} 格（该格取帧在 ${c.t}s）`);
    else console.log('  这个时间点附近没有保留的格（画面被去重了）');
    for (const s of near) console.log(`  [${s.t}s] ${s.text}`);
    return;
  }

  if (args.grep) {
    const hits = subs.filter((s) => s.text.includes(args.grep));
    if (!hits.length) { console.log(`没有含「${args.grep}」的台词`); return; }
    for (const s of hits) {
      const c = cellAt(cells, s.t);
      console.log(`[${s.t}s] ${s.text}`);
      console.log(`   → ${c ? `${c.sheet} 第 ${c.n} 格` : '（附近没有保留的格）'}`);
    }
    return;
  }

  if (args.range) {
    const [a, b] = args.range;
    for (const s of subs.filter((x) => x.t >= a && x.t <= b)) {
      const c = cellAt(cells, s.t);
      console.log(`[${s.t}s] ${s.text}${c ? `   → ${c.sheet}#${c.n}` : ''}`);
    }
    return;
  }

  // 默认：列出台词密度分段，帮人挑范围
  console.log('台词按 60 秒分段：');
  const buckets = new Map();
  for (const s of subs) {
    const k = Math.floor(s.t / 60) * 60;
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  for (const [k, n] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (n >= 3) console.log(`  ${k}s-${k + 60}s  ${n} 句`);
  }
}

main();
