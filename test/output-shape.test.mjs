/**
 * 工具返回值必须是 host 能无损 JSON 化的东西。
 *
 * 2026-11-01 为什么加这个文件：`video_scan` 曾经在成功路径上直接把
 * `encodePng()` 产出的 **Buffer** 塞进 `images`，host 校验时报
 *
 *     Error: tool "video_scan" returned invalid output: value is not lossless JSON
 *
 * 于是整个调用失败 —— 连已经 OCR 出来的台词都拿不到。上游的
 * `video_storyboard` / `video_zoom` 一直是对的，因为它们走
 * `attachImages()` → `ctx.attachments.saveImage()`，拿回的是可序列化的引用。
 *
 * 之前的测试没有一条碰到 handler 的返回值，所以这个 bug 一路漏到线上。
 * 这里补两件事：
 *   ① 用假 ctx 把真的 handler 跑一遍**失败路径**，断言返回的每个值都能 JSON 化；
 *   ② 静态扫源码，禁止再把“原始 PNG 数据”直接塞进返回值。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 一个最小的 ctx：只提供 apply() 用到的那几样。 */
function fakeCtx() {
  const registered = [];
  return {
    registered,
    tools: {
      register: (spec) => { registered.push(spec); return () => {}; },
    },
    attachments: {
      // 真 host 返回一个引用对象；这里返回一个明显可序列化的形状，
      // 够用来证明“走 attachImages 的东西是合法的”。
      saveImage: async ({ data, mediaType, name }) => ({
        __ref: 'image',
        name,
        mediaType,
        bytes: typeof data === 'object' && data?.length != null ? data.length : 0,
      }),
    },
    log: () => {},
    // pipeline/media 里偶尔会用到的杂项，缺了会抛，宁可显式给个空壳
    on: () => {},
    config: {},
  };
}

test('every tool returns a value the host can serialise', async (t) => {
  const plugin = await import('../src/index.js');
  const ctx = fakeCtx();
  await plugin.apply(ctx);

  assert.ok(ctx.registered.length >= 6, `expected the 6 tools, got ${ctx.registered.length}`);

  // ⚠️ 只用“文件不存在”的输入是**测不到这个 bug 的**：handler 走 catch，
  // 返回 `images: []`，永远是合法 JSON。当初的 bug 在**成功路径**上。
  // （这一版测试最初就是这么写的，把 bug 放回去也不会变红 —— 等于假的。）
  // 所以下面要真的生成一个极小的视频，让 scan 走完整条成功路径。
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { findFfmpeg } = await import('../src/media.js');

  const ffmpeg = await findFfmpeg();
  const tmp = await mkdtemp(join(tmpdir(), 'vv-shape-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  let realVideo = null;
  if (ffmpeg) {
    // 2 秒纯色测试视频：够 scan 抽几帧、拼一张 sheet，成本可忽略
    const out = join(tmp, 'tiny.mp4');
    const r = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=navy:s=320x240:d=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', out,
    ], { timeout: 30_000 });
    if (r.status === 0) realVideo = out;
  }

  for (const spec of ctx.registered) {
    assert.equal(typeof spec.execute, 'function', `${spec.name} has no execute`);

    // ① 失败路径：任何工具都不许把非法值当返回值交出去
    for (const input of [join(ROOT, 'test', '__nope__.mp4'), null, undefined, '']) {
      let value;
      try {
        value = await spec.execute({ input }, { signal: undefined });
      } catch (error) {
        assert.ok(error instanceof Error, `${spec.name} threw a non-Error`);
        continue;
      }
      if (value === undefined) continue;
      assert.equal(typeof value, 'object', `${spec.name} returned a non-object`);
      assert.doesNotThrow(
        () => JSON.stringify(value),
        `${spec.name} returned a value that is not lossless JSON (input=${JSON.stringify(input)})`,
      );
    }

    // ② 成功路径：真正跑一遍 scan，这才碰得到 images
    if (spec.name === 'video_scan' && realVideo) {
      const value = await spec.execute(
        { input: realVideo, start: 0, end: 2, step: 1, maxSheets: 1, subtitle: false },
        { signal: undefined },
      );
      assert.equal(typeof value, 'object', 'video_scan returned a non-object');
      assert.doesNotThrow(
        () => JSON.stringify(value),
        'video_scan returned a value that is not lossless JSON — raw PNG bytes are '
          + 'probably being handed to the host instead of attachImages() refs',
      );
      for (const [i, img] of (value.images ?? []).entries()) {
        assert.ok(
          !(img?.data instanceof Uint8Array),
          `video_scan images[${i}] carries raw bytes — route it through attachImages()`,
        );
      }
    }
  }

  if (!realVideo) {
    t.diagnostic('ffmpeg/lavfi unavailable — the success-path half of this test was skipped');
  }
});

test('attachImages() is the only door for pictures', () => {
  const src = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  const lines = src.split('\n');

  // 找出每一处 `images:` 赋值，检查同一行里有没有“直接把原始数据塞进去”的形状。
  // 允许的写法只有两种：空数组，或者 attachImages(...) 的结果。
  const suspicious = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\bimages\s*:/.test(line)) continue;
    const ok = /\bimages\s*:\s*(\[\]|images\b)/.test(line)
      || /\bimages\s*:\s*await\s+attachImages\(/.test(line);
    if (!ok) suspicious.push(`${i + 1}: ${line.trim()}`);
  }

  assert.deepEqual(
    suspicious,
    [],
    'a picture is being handed to the host without attachImages():\n'
      + suspicious.join('\n'),
  );
});
