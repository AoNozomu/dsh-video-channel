#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ocr-batch-rapid.py —— RapidOCR 版的 ocr-batch，**输出格式与 ocr-batch.ps1 完全一致**。

为什么要有这一版（2026-11-01 爸爸要求的）：
  QQ 侧没有命令行，只能用 DSH 的 video_read，而 video_read 固定走 Windows.Media.Ocr。
  实测 Windows OCR 会把「在灯管下滴答」读成「疒下谪」，而且同一帧时好时坏 ——
  拿它读番剧字幕（白字描边压画面）基本失效，实测前 10 分钟一条都抽不到。
  RapidOCR 对整帧识别准确率高得多（「阿维达」「砸锅了这单黄了」100% 对），
  B站 侧的 scan-video 一直用它，所以这边也换成它。

输出格式（与 ocr-batch.ps1 一致，让 src/ocr.js 的 parseSection 无需改动）：
  == f00001 ==
  @@ 960 540
  12 680 640 710	这句台词
  ...

用法（由 src/ocr.js 调用）：
  python ocr-batch-rapid.py -Dir <png目录> -Out <输出txt>
"""
import argparse
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--Dir", "-Dir", dest="dir", required=True, help="PNG 目录")
    ap.add_argument("--Out", "-Out", dest="out", required=True, help="输出 txt")
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        print("目录不存在: %s" % args.dir, file=sys.stderr)
        return 2

    from rapidocr_onnxruntime import RapidOCR
    from PIL import Image

    engine = RapidOCR()
    files = sorted(f for f in os.listdir(args.dir) if f.lower().endswith(".png"))

    lines_out = []
    for name in files:
        stem = os.path.splitext(name)[0]
        path = os.path.join(args.dir, name)
        lines_out.append("== %s ==" % stem)
        try:
            with Image.open(path) as im:
                W, H = im.size
            lines_out.append("@@ %d %d" % (W, H))
        except Exception:
            lines_out.append("@@ 0 0")
            continue

        try:
            result, _ = engine(path)
        except Exception as e:
            lines_out.append("[ocr-error] %s" % str(e)[:200])
            continue

        if not result:
            continue
        for item in result:
            try:
                box, text = item[0], item[1]
                score = float(item[2]) if len(item) > 2 and isinstance(item[2], (int, float)) else 1.0
            except Exception:
                continue
            # 与 Windows 版对齐：低置信度丢掉，避免把画面噪声当文字
            if score < 0.45:
                continue
            t = str(text).strip()
            if not t:
                continue
            try:
                xs = [pt[0] for pt in box]
                ys = [pt[1] for pt in box]
            except Exception:
                continue
            x0, y0 = int(min(xs)), int(min(ys))
            x1, y1 = int(max(xs)), int(max(ys))
            if x1 <= x0 or y1 <= y0:
                x0 = y0 = x1 = y1 = 0
            lines_out.append("%d %d %d %d\t%s" % (x0, y0, x1, y1, t))

    with open(args.out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines_out) + "\n")

    got = sum(1 for l in lines_out if "\t" in l)
    print("ok frames=%d lines=%d" % (len(files), got), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
