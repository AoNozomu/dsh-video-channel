# 改动清单（相对上游 dsh-video-vision 1.3.2）

本项目的所有改动都可审计：**上游文件只改了 3 个，新增 2 个文件，其余原样**。

## 新增文件

| 文件 | 说明 |
|---|---|
| `src/longform.js` | **核心**：长视频扫描（画面去重 + 台词逐秒 OCR） |
| `bin/scan-video.mjs` | 同一逻辑的 CLI 包装（可选） |
| `bin/where.mjs` | 台词↔画面格定位的 CLI 包装（可选） |

## 修改的上游文件

| 文件 | 改了什么 |
|---|---|
| `src/tools.js` | 加 `SCAN_TOOL` / `WHERE_TOOL` 常量 + `scanSpec()` / `whereSpec()` |
| `src/index.js` | import longform、加 `handlers.scan` / `handlers.where`、注册两个新工具 |
| `dsh.plugin.json` | version 1.3.2 → 1.4.0，description 更新 |

## 上游原有、未改动的文件

`src/` 下的 scan.js / pipeline.js / read.js / ocr.js / frames.js / sheet.js / png.js /
media.js / layout.js / timeline.js / transcript.js / asr.js / bili.js / manifest.js / index.js（除上述注册），
`bin/` 下的 ocr-batch.ps1 / install.mjs / selfcheck.mjs，以及 test/、bench/、assets/。

## 怎么自己验

```bash
# 上游原始版本对比：从 dsh-video-vision 1.3.2 解包后 diff
diff -r upstream-1.3.2/src ./src   # 应该只看到 tools.js / index.js 的差异
```

## 三个改动的原因（一句话版）

- `longform.js`：上游的 video_storyboard 一次 ≤28 格、格子放在切点上，看整集要跑上百次，
  长镜头中间的台词全丢。所以要一条「画面按变化留、台词每帧都认」的路。
- `scanSpec`：把这条路暴露成正式工具，装完就有，不用开命令行。
- `whereSpec`：台词和画面是分开产的，光读台词会认错人（我们认错过三次），
  所以要一个「这句话在哪一格」的定位器，配合 video_zoom 看脸。
