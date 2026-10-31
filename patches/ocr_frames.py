#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ocr_frames.py —— 用 PaddleOCR/RapidOCR 批量识别一帧目录里的文字，只留底部的字幕。

为什么这么干（2026-10-31 爸爸要的）：
  · Windows 自带 OCR 会把「在灯管下滴」读成「疒下谪」，错字太多，而且同一帧时好时坏；
  · RapidOCR 对**整帧**识别准确率高（实测「阿维达」100% 对），但喂它**细长字幕条**会直接返回空；
  · 所以这里喂整帧，再按 y 坐标只保留底部那一条（字幕区），顺便丢掉台标/水印。

用法：
  python ocr_frames.py <图片目录> [--out out.json] [--bottom 0.72] [--min-score 0.5] [--quiet]

输出 JSON：
  { "frames": [ { "file": "f00001.png", "lines": [ {"text": "...", "y": 660, "score": 0.98} ] } ] }
"""
import argparse
import json
import os
import sys
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", help="存放 PNG 帧的目录")
    ap.add_argument("--out", default="", help="输出 JSON 路径（默认 <dir>/ocr.json）")
    ap.add_argument("--bottom", type=float, default=0.80,
                    help="只保留 y > 图高*这个比例 的文字（0.85 = 下 15%%，实测字幕就在这一带）")
    ap.add_argument("--min-score", type=float, default=0.45, help="置信度下限")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        print("目录不存在: %s" % args.dir, file=sys.stderr)
        sys.exit(2)

    files = sorted(f for f in os.listdir(args.dir) if f.lower().endswith(".png"))
    if not files:
        print("目录里没有 png: %s" % args.dir, file=sys.stderr)
        sys.exit(2)

    # 延迟导入：让 --help 也能秒开
    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()

    frames = []
    t0 = time.time()
    for i, name in enumerate(files):
        path = os.path.join(args.dir, name)
        try:
            result, _ = engine(path)
        except Exception as e:
            frames.append({"file": name, "lines": [], "error": str(e)[:120]})
            continue

        lines = []
        if result:
            for item in result:
                box, text = item[0], item[1]
                score = float(item[2]) if len(item) > 2 and isinstance(item[2], (int, float)) else 1.0
                if score < args.min_score:
                    continue
                try:
                    ys = [pt[1] for pt in box]
                    xs = [pt[0] for pt in box]
                except Exception:
                    continue
                y_top = min(ys)
                y_bottom = max(ys)
                x_left = min(xs)
                height = max(y_bottom, 1)
                # 高度要用整张图来判断底部区；这里用检测框的绝对坐标 + 图片高度
                lines.append({
                    "text": str(text).strip(),
                    "y": round(float(y_top), 1),
                    "score": round(score, 3),
                    "_bottom": round(float(y_bottom), 1),
                    "_x": round(float(x_left), 1),
                })
        frames.append({"file": name, "lines": lines})

        if not args.quiet and (i + 1) % 50 == 0:
            print("  OCR %d/%d  %.0fs" % (i + 1, len(files), time.time() - t0), file=sys.stderr)

    # 第二遍：按图片实际高度裁掉非字幕区（需要知道图高，用 PIL 读一次尺寸）
    try:
        from PIL import Image
        for fr in frames:
            if not fr["lines"]:
                continue
            path = os.path.join(args.dir, fr["file"])
            try:
                with Image.open(path) as im:
                    H = im.height
            except Exception:
                continue
            cut = H * args.bottom
            fr["lines"] = [ln for ln in fr["lines"] if ln["y"] >= cut]
            for ln in fr["lines"]:
                ln.pop("_bottom", None)
                ln.pop("_x", None)
    except ImportError:
        # 没有 PIL 就不裁，把全部文字留下
        for fr in frames:
            for ln in fr["lines"]:
                ln.pop("_bottom", None)
                ln.pop("_x", None)

    out = args.out or os.path.join(args.dir, "ocr.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"frames": frames}, f, ensure_ascii=False, indent=1)

    kept = sum(1 for fr in frames if fr["lines"])
    print(json.dumps({
        "ok": True, "out": out, "frames": len(frames),
        "withText": kept, "seconds": round(time.time() - t0, 1),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
