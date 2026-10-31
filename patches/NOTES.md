# 我们改了什么（patches）

这个目录放**原插件里没有、我们自己写的东西**。原插件的完整副本在 `../upstream/`，
两边一比就能看出差异。

---

## 新增的三个文件

### 1. `scan-video.mjs` —— 逐秒扫描，画面去重 + 台词全量 OCR

**为什么写它**

原插件（`dsh-video-vision`）的 `video_storyboard` 一次只出一张分镜图（≤28 格），
而且格子是**放在镜头切换点**上的。这带来两个问题：

- 「30 分钟的视频怎么看」没有答案 —— 得连跑上百次；
- 长镜头中间发生的事看不到（一个 10 秒不动但字幕在换的镜头，只会出一帧）。

爸爸定的口径是：**画面可以省，台词一句都不能少。** 所以拆成两条独立的路：

| | 怎么处理 | 输出 |
|---|---|---|
| 画面 | 相邻帧差异 < 阈值就丢弃（同一张脸不会刷 N 遍） | `sheet-001.png` …（每格带格号） |
| 台词 | 每一秒的那一帧都认，一句不落 | `subtitles.txt`（带 `[秒]` 时间码） |

**实测效果**（26 分钟一集）：
```
1560 帧 → 保留 710 格（省 54%）→ 45 张分镜图
台词 416 条 / 6311 字符，剧情可以完整复述
```

**用法**

```bash
node scan-video.mjs <视频文件> [--start 0] [--end 780] [--step 1] [--per-sheet 16] [--cols 4]
                               [--width 480] [--bottom 0.80] [--ocr-width 960]
                               [--ocr-python <python.exe>] [--no-subtitle] [--out <目录>]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--step` | 1 | 每隔几秒抽一帧。1 = 每秒一格 |
| `--per-sheet` | 16 | 每张分镜放几格 |
| `--cols` | 4 | 每行几格 |
| `--width` | 480 | 分镜格宽度（拼图用，省 token） |
| `--ocr-width` | 960 | **给 OCR 的整帧宽度**，比 `--width` 大很多（见 docs/02） |
| `--bottom` | 0.80 | 只认画面最下面的比例（见 docs/02） |
| `--diff` | 6 | 画面差异阈值，越大丢得越多 |

**输出结构**

```
<out>/
  sheet-001.png …  sheet-045.png   分镜图（格子左上角有编号，编号全局连续）
  subtitles.txt                    [秒] 台词，已合并相邻重复
  index.json                       每张图里每格对应第几秒（where.mjs 靠它）
```

---

### 2. `ocr_frames.py` —— 用 RapidOCR 认整帧，只留底部字幕

**为什么不用 Windows 自带 OCR**

原插件的 OCR 走 `Windows.Media.Ocr`（`bin/ocr-batch.ps1`）。实测对**动画字幕**质量不够：

```
Windows OCR:  「水龙头疒下谪」      ← 错字
              「丁水头在灯管下谪」   ← 错字
              「辶顿骂我跑不掉」     ← 错字
              而且同一帧时好时坏（有时直接 0 识别）

RapidOCR:     「水龙头在灯管下滴答」  ✓
              「这顿骂我跑不掉」      ✓
              「目标已控制箱子到手」  ✓（原来完全读不出）
```

**关键坑：喂什么图**

```
喂整帧         → 识别准确率高 ✓
喂细长字幕条   → 直接返回 None ✗（实测 960×119 的条子一个也认不出）
```

所以流程是：**抽整帧 → OCR 认全部文字 → 按 y 坐标只留底部**（详见 docs/02）。

**依赖**

```bash
# 单独建一个环境，千万别装进有语音/onnxruntime 的那个 venv
# （rapidocr 会把 numpy 升到 2.x，把 onnxruntime 1.18 搞崩）
python -m venv E:\ocr-env
E:\ocr-env\Scripts\python.exe -m pip install rapidocr-onnxruntime
```

**用法**

```bash
python ocr_frames.py <图片目录> [--out ocr.json] [--bottom 0.80] [--min-score 0.45] [--quiet]
```

---

### 3. `where.mjs` —— 台词 ↔ 画面 的对照

**为什么需要它**

`scan-video` 把两样东西分开放：分镜图（画面）和 `subtitles.txt`（台词）。
光看台词会**认错人**（我们真的认错过两次，见 docs/03）。这个工具把两边对上：

```bash
node where.mjs <scan输出目录> --grep "米格尔"
# [181s] 米格尔集中精神   → sheet-004.png 第 62 格
#   ↑ 知道去看哪张图的哪一格，再放大看脸

node where.mjs <目录> --at 233          # 第 233 秒落在哪一格
node where.mjs <目录> --range 860 980   # 这一段所有台词 + 对应格号
```

---

## 我们没改 upstream 代码

`../upstream/` 里的文件**一个字节都没动**。所有新逻辑都在 `patches/` 这三个文件里，
它们通过 import 复用 upstream 的模块：

| 复用自 | 用途 |
|---|---|
| `../src/frames.js` → `extractFrame()` | 抽某一秒的一帧 |
| `../src/sheet.js` → `composeSheet()` | 把多格拼成一张图 |
| `../src/png.js` → `encodePng()` | 编码 PNG |
| `../src/media.js` → `findFfmpeg()` / `run()` / `parseFfmpegBanner()` | 找 ffmpeg、跑命令、解析时长 |

所以三个文件要放在 `upstream/bin/` 里（或改 import 路径）才能跑。
下面 `install.ps1` 干的就是这件事。

---

## ffmpeg 没打包

`upstream/vendor/bin/ffmpeg.exe` 有 77 MB，没有复制进来。三种办法任选：

1. 原插件里已经有 → 直接指过去（`--ffmpeg` 参数或 `DSH_FFMPEG_PATH` 环境变量）
2. 系统 PATH 里有 ffmpeg → 会自动找到
3. 自己下一个放 `upstream/vendor/bin/`
