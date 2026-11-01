# dsh-video-channel

**Read a whole episode — not a handful of frames.**

A long-form video channel for [DeepSeek Harness](https://github.com/).

> **This is a fork of [`dsh-video-vision`](https://github.com/Destinhue/dsh-video-vision).**
> The upstream work — frame extraction, cut detection, storyboard compositing, on-demand zoom,
> video probing, text reading — is theirs, MIT licensed, and reused here unchanged except for the
> two files listed in [docs/00-改动说明.md](docs/00-改动说明.md).
>
> What this fork adds: a **whole-episode channel**. Upstream's storyboard answers "look at these
> 30 seconds" very well; it does not answer "watch this 26-minute episode", because it returns one
> sheet per call (≤28 cells) and only samples at shot cuts — dialogue inside a long take is lost.
>
> **Renamed on purpose.** Keeping the name `dsh-video-vision` would mean that anyone who installs
> this fork stops receiving upstream updates (same package name, one silently overwrites the other).
> Under its own name it installs beside upstream, or replaces it — it is a superset, all six tools
> are present. Please keep using upstream for the original five.

> ### ⚠️ Install RapidOCR, or the OCR is close to useless
>
> **This is the one step people skip, and skipping it is silent.** Without a RapidOCR python the
> tool falls back to `Windows.Media.Ocr` and still returns "successful" results — the text is just
> wrong. Measured on the same 8 frames of a Chinese-subtitled episode:
>
> | the frame says | Windows.Media.Ocr returns | RapidOCR returns |
> | --- | --- | --- |
> | `4K修复播放室` | `4K 修 复 播 放 室 LiliLi\i` | `4K修复播放室` |
> | `bilibili` | `LiliLili` / `VliLi\i` / `LiIiLiIi` / `LiliLiIi` (4 different wrong readings in 8 frames) | `bilibili`, all 8 |
> | `迈克·庞德史密斯` | `迈 克 到 庞 德 史 密 斯` | `迈克·庞德史密斯` |
> | small on-screen text | `0 噁 0 嶺` | `SAYA ELDER`, `BAR` |
>
> Windows OCR also puts **a space between every CJK character**, which breaks any downstream
> substring matching. So: no RapidOCR ⇒ subtitles and slide text come back garbled, and the model
> reading them gets a wrong idea of the video. It does not error, it just lies quietly.
>
> ```bash
> # Windows
> python -m venv E:\ocr-env
> E:\ocr-env\Scripts\pip install rapidocr-onnxruntime
> setx DSH_OCR_PYTHON E:\ocr-env\Scripts\python.exe
>
> # Linux / macOS
> python3 -m venv ~/ocr-env
> ~/ocr-env/bin/pip install rapidocr-onnxruntime
> export DSH_OCR_PYTHON=~/ocr-env/bin/python
> ```
>
> `DSH_OCR_PYTHON` is not the only way — `src/ocr-python.js` also looks in `vendor/ocr-env`, a
> sibling `ocr-env`, `%LOCALAPPDATA%`, `%USERPROFILE%` and `<drive>:\ocr-env`. But an explicit
> variable is what `bin/selfcheck.mjs` can verify, and **selfcheck fails when the engine is the
> fallback one** — run it after installing and it will tell you which engine you actually got.

It splits a video into two independent streams — **pictures, deduplicated** and **dialogue, every
single second of it** — then joins them back together with timecodes. Install it and you get two
new tools (`video_scan`, `video_where`) beside the existing `video_probe` / `video_storyboard` /
`video_zoom` / `video_read`.

---

## Install

```bash
# 1. dependencies
npm install

# 2. RapidOCR — in its OWN venv (this is not optional, see the warning)
python -m venv /path/to/ocr-env
/path/to/ocr-env/bin/pip install rapidocr-onnxruntime
export DSH_OCR_PYTHON=/path/to/ocr-env/bin/python     # or pass ocrPython per call

# 3. ffmpeg 4.0+
export DSH_FFMPEG_PATH=/path/to/ffmpeg                # or vendor/bin/, or PATH

# 4. register with your harness profile
#    Install this directory as the plugin. cordis.patch.yml is the bundle-patch entry.
```

> ⚠️ **RapidOCR needs its own venv.** Installing it upgrades numpy to 2.x, which breaks any
> `onnxruntime` compiled against numpy 1.x. That combination took a voice service down once.
> Details: [docs/05-环境配置.md](docs/05-环境配置.md).

---

## Usage

```js
// 1. scan
video_scan({
  input: "/path/to/ep01.mp4",
  start: 80,          // skip the opening credits
  end: 1600,          // stop before the next episode auto-plays
  step: 1,            // one frame per second
})
// → the full transcript with per-second timestamps
//   + up to maxSheets storyboard images
//   + an output directory on disk

// 2. locate a line
video_where({ dir: outDir, grep: "your daughter" })
// → [242s] your daughter        → sheet-016.png cell 254

// 3. look at that face
video_zoom({ input: "/path/to/ep01.mp4", start: 242, end: 245, cells: 1 })
```

`input` takes a local file **or a Bilibili link** — a full `https://www.bilibili.com/video/BV...`
URL (with or without `?p=`), a bare `BV...` id, an `av` number, or a `b23.tv` short link.
The link is resolved and downloaded once into `~/.dsh/cache/video-vision/bilibili/<BV>/`,
and every frame is then read from that local copy, so scanning a second window of the same
episode costs nothing extra:

```js
video_scan({ input: "https://www.bilibili.com/video/BV1MMnw6MEtU?p=1", start: 150, end: 180 })
```

Note that a page URL is *not* handed to ffmpeg — ffmpeg reads media streams, not HTML. The
resolution step happens first, and the tool says which file it settled on ("已就绪: ..."),
so you can tell a cached run from a fresh download.

**Read the transcript first; look at sheets only for what words cannot show.**
One episode costs ≈11K tokens this way (~0.01 USD). Reading all 45 sheets costs ~45K and still
tells you nothing about the dialogue.

---

## Cost — read this before you scan anything

The scan itself is free (ffmpeg + local OCR). **The cost is what you feed back to the model.**
Measured on a 27-minute episode (1640 s → 45 sheets, 416 subtitle lines):

| what you read | tokens | ≈ USD |
|---|---|---|
| `subtitles.txt` only | ~4.4K | **0.009** |
| subtitles + 3 sheets | ~7.7K | 0.015 |
| subtitles + 12 sheets | ~17.6K | 0.035 |
| **subtitles + all 45 sheets** | **~54K** | **0.108** |

**Reading all 45 costs 12× more and buys you almost nothing** — the plot lives in the
transcript; the pictures only answer "what does this moment look like".

So the intended reading order is:

```
1. subtitles.txt          ← the plot. Always read this first.
2. index.json             ← the timeline: which sheet covers which seconds. Text, near-free.
3. 1-3 sheets             ← only for what words cannot show.
4. video_zoom on one s    ← when you need to see an actual face.
```

⚠️ **The CLI does not enforce any of this.** `scan-video.mjs` prints
`{ok, outDir, sheets: 45}` and stops — the images are files on disk, and nothing counts
how many you open. If you are wiring this into an agent, **put a hard cap in its system
prompt** (we use 3–5 sheets per scan). A tool cannot decide how much context you can afford.

---

## Don't block your agent for 20 minutes

A full episode takes 10–20 minutes to scan (OCR is ~0.37 s/frame). If you run that
**blocking**, your agent cannot answer anything while it runs — every incoming message
queues up. We learned this the hard way: a 26-minute episode run in the foreground froze
an agent for 25 minutes and piled up 28 queued messages, which then cost far more than
the scan itself when it woke up and re-read everything.

```
scan in the background  →  keep chatting  →  job_output when it is done
```

Rule of thumb: **if you are not sure how long it takes, run it in the background.**
Full write-up (including the "queued messages" trap): [docs/04-踩过的坑.md](docs/04-踩过的坑.md), pitfall 14.

---

## The rule that matters most

> **Never identify a character from a storyboard cell.**

Cells are ~480×270. Two blond characters are indistinguishable at that size — and this is not
hypothetical. During development the same episode was summarized three times with three different
*wrong* character names, because faces were guessed from sheets.

The correct order is always:

```
video_where  →  which cell
video_zoom   →  look at the face
still unsure →  ask the human
```

And when a plot detail does not add up, **suspect that you mixed up two characters before you
suspect the plot.** Full write-up: [docs/03-认人规矩.md](docs/03-认人规矩.md).

---

## The two streams

| stream | what happens | what you get |
|---|---|---|
| **pictures** | adjacent frames differing by less than `diff` are dropped | numbered sheets, 16 cells each |
| **dialogue** | **every second** is OCR-ed, then near-identical neighbours are merged | `[second] text` lines, nothing skipped |

Measured on a 26-minute anime episode:

```
1560 frames → 710 kept (54% dropped) → 45 sheets
416 subtitle lines / 6311 characters
```

Why split them: pictures change slowly (a face can hold for 7 seconds) while dialogue changes fast
(5 lines in those 7 seconds). Sampling at picture rate drops lines; sampling at dialogue rate
wastes cells. So pictures are sampled by *change* and dialogue by *every frame*.

Details: [docs/01-原理.md](docs/01-原理.md).

---

## Subtitle extraction region

Only text below **80% of frame height** counts as dialogue (`bottom=0.80`). Measured on anime:

| element | y | kept? |
|---|---|---|
| watermarks / channel logo | 3–5% | no |
| in-scene signage (`acasaka`) | **79%** | no |
| burned-in subtitle (`我们的人呢`) | **92%** | **yes** |

0.80 keeps real subtitles, drops most scene lettering, and leaves headroom for shows whose
subtitles sit higher. Lower it if lines are missed; raise it if scene text sneaks in.
Full measurements: [docs/02-字幕区域.md](docs/02-字幕区域.md).

---

## Parameters

| parameter | default | when to change it |
|---|---|---|
| `start` / `end` | 0 / EOF | skip credits; stop before auto-play |
| `step` | 1 | 2–3 halves OCR time, loses some lines |
| `perSheet` / `cols` | 16 / 4 | fewer cells per sheet = larger, sharper |
| `width` | 480 | cell width; larger = sharper + more tokens |
| `ocrWidth` | 960 | **do not drop to 480** — subtitles become unreadable |
| `bottom` | 0.80 | see the table above |
| `diff` | 6 | lower keeps more frames |
| `maxSheets` | 12 | cap on returned images; the rest stay on disk |

---

## Limits

| limit | note |
|---|---|
| **Faces unreadable from sheets** | use `video_where` + `video_zoom` |
| **In-frame speech bubbles** | sit mid-frame, so they are read as dialogue; use `video_storyboard` for comic-style video |
| **Next-episode auto-play** | set `end`, or the next episode's lines leak in |
| **Hard subs only** | a real subtitle track (.srt/.ass) is better read with upstream `video_read` |
| **Source resolution matters** | below 720p OCR accuracy drops noticeably |
| **Speed** | RapidOCR ≈0.37 s/frame; a 26-minute episode ≈16 min on a desktop |

---

## Layout

```
├── src/
│   ├── index.js         entry: registers 6 tools
│   ├── tools.js         tool specs (descriptions are paid every request — kept tight)
│   ├── longform.js      ← this project: dedupe pictures + OCR every second
│   ├── scan.js          upstream: one decode pass, cut detection
│   ├── pipeline.js      upstream: storyboard / zoom orchestration
│   ├── read.js ocr.js   upstream: text reading (Windows OCR)
│   ├── frames.js        upstream: frame extraction
│   ├── sheet.js png.js  upstream: sheet compositing, PNG encoding
│   └── media.js         upstream: ffmpeg discovery + probing
├── bin/
│   ├── ocr_frames.py    ← runtime dependency: full-frame OCR, bottom crop
│   ├── scan-video.mjs   ← optional CLI over longform.js
│   ├── where.mjs        ← optional CLI over locateInScan()
│   ├── ocr-batch.ps1    upstream
│   ├── install.mjs      upstream
│   └── selfcheck.mjs    upstream
├── docs/
│   ├── 00-改动说明.md    what was added to upstream, and why
│   ├── 01-原理.md        how and why the streams are split
│   ├── 02-字幕区域.md    the 0.80 measurement and how to adjust
│   ├── 03-认人规矩.md    ⚠️ the three wrong summaries and the protocol
│   ├── 04-踩过的坑.md    13 traps
│   └── 05-环境配置.md    versions, disk, error table, performance
├── patches/DIFF.md      upstream file inventory (auditable diff)
└── test/                upstream tests
```

Files marked *upstream* come from `dsh-video-vision` unchanged except where
[docs/00-改动说明.md](docs/00-改动说明.md) says otherwise.

---

## License

Upstream code keeps `dsh-video-vision`'s license — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Files added by this project are released under the same terms.
