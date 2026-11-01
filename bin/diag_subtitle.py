#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
diag_subtitle.py —— 诊断「为什么这条视频抽不到字幕」。

做一件事：抽几帧，把 OCR 认到的**每一行文字**的 y 位置（占图高的比例）全打出来，
按 y 排序。这样一眼能看出：
  · 字幕到底在哪一带（0.92？0.75？0.60？）
  · 现在的 --bottom 0.80 是不是把它切掉了
  · 前 10 分钟是不是真的没有字幕（有文字但都在上方 = OP/标题/招牌）

用法:
  E:\\ocr-env\\Scripts\\python.exe diag_subtitle.py <视频文件> [--start 0] [--end 600] [--every 20]

  --every 20  每 20 秒抽一帧（10 分钟默认抽 30 帧，够看分布）
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--start", type=float, default=0)
    ap.add_argument("--end", type=float, default=600)
    ap.add_argument("--every", type=float, default=20, help="每隔几秒抽一帧")
    ap.add_argument("--width", type=int, default=960)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    if not os.path.exists(args.video):
        print("视频不存在: %s" % args.video, file=sys.stderr)
        sys.exit(2)

    tmp = tempfile.mkdtemp(prefix="diagsub-")
    print("抽帧到: %s" % tmp, file=sys.stderr)

    # 抽帧：每 N 秒一张整帧
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", str(args.start), "-to", str(args.end),
        "-i", args.video,
        "-vf", "fps=1/%g,scale=%d:-2" % (args.every, args.width),
        os.path.join(tmp, "f%04d.png"),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("ffmpeg 失败: %s" % (r.stderr or "")[:400], file=sys.stderr)
        sys.exit(2)

    files = sorted(f for f in os.listdir(tmp) if f.endswith(".png"))
    if not files:
        print("没抽到帧（--start/--end 超出时长？）", file=sys.stderr)
        sys.exit(2)
    print("抽到 %d 帧（每 %g 秒一帧）" % (len(files), args.every), file=sys.stderr)

    from rapidocr_onnxruntime import RapidOCR
    from PIL import Image
    engine = RapidOCR()

    rows = []          # (秒, 文本, y比例, 置信度)
    H = None
    for i, name in enumerate(files):
        path = os.path.join(tmp, name)
        if H is None:
            with Image.open(path) as im:
                H = im.height
        sec = args.start + i * args.every
        try:
            result, _ = engine(path)
        except Exception as e:
            print("  OCR 异常 %s: %s" % (name, str(e)[:80]), file=sys.stderr)
            continue
        if not result:
            continue
        for item in result:
            box, text = item[0], item[1]
            score = float(item[2]) if len(item) > 2 and isinstance(item[2], (int, float)) else 1.0
            if score < 0.45:
                continue
            ys = [pt[1] for pt in box]
            y_top = min(ys)
            rows.append({
                "sec": round(sec, 1),
                "text": str(text).strip()[:40],
                "y": round(y_top / H, 3),
                "score": round(score, 2),
            })
        if (i + 1) % 10 == 0:
            print("  OCR %d/%d" % (i + 1, len(files)), file=sys.stderr)

    out = args.out or os.path.join(os.getcwd(), "diag_subtitle.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"video": args.video, "height": H, "rows": rows}, f, ensure_ascii=False, indent=1)

    # ── 报告 ─────────────────────────────────────────
    print("")
    print("图片高度 %s px，共认出 %d 行文字" % (H, len(rows)))
    if not rows:
        print("⚠️  一帧都没认出文字 —— 可能是：①这段真的没有字 ②分辨率太低 ③全屏画面")
        print("JSON: %s" % out)
        return

    buckets = {}
    for r in rows:
        b = round(r["y"] * 10) / 10     # 0.1 一档
        buckets[b] = buckets.get(b, 0) + 1
    print("")
    print("y 位置分布（占图高比例，1.0=最底边）：")
    for b in sorted(buckets):
        bar = "█" * min(40, buckets[b])
        mark = ""
        if 0.78 <= b < 0.84:
            mark = "  ← 当前 cut=0.80 在附近"
        if b < 0.78:
            mark = "  ← 会被 cut 切掉！"
        print("  y≈%.1f  %3d 行  %s%s" % (b, buckets[b], bar, mark))

    sub = [r for r in rows if r["y"] >= 0.80]
    below = [r for r in rows if r["y"] < 0.80]
    print("")
    print("当前 --bottom 0.80 会保留 %d 行，丢掉 %d 行" % (len(sub), len(below)))
    if below:
        print("被丢掉的最靠下的 8 行（这些可能就是字幕）：")
        for r in sorted(below, key=lambda x: -x["y"])[:8]:
            print("  [%6.1fs] y=%.2f  «%s»" % (r["sec"], r["y"], r["text"]))

    if sub:
        print("")
        print("保留下来、最像字幕的 8 行：")
        for r in sorted(sub, key=lambda x: x["sec"])[:8]:
            print("  [%6.1fs] y=%.2f  «%s»" % (r["sec"], r["y"], r["text"]))

    print("")
    print("JSON: %s" % out)
    print("帧目录: %s（看完可以删）" % tmp)


if __name__ == "__main__":
    main()
