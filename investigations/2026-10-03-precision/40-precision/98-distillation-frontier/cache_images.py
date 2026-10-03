#!/usr/bin/env python3
"""Decode every corpus image once into a uint8 memmap, so fine-tuning epochs are pure compute.

224x224x3 uint8 over 6,264 rows is 942 MB on disk. The reference preprocessing in
../95-distillation/extract_culico.py is applied here in full (Resize 256 bicubic -> CenterCrop 224),
and ImageNet normalisation is applied per-batch at training time so the cache stays uint8.
"""
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")


def main():
    rows = C.load_rows()
    n = len(rows)
    path = f"{OUT}/images_224_uint8.npy"
    A = np.lib.format.open_memmap(path, mode="w+", dtype=np.uint8, shape=(n, 224, 224, 3))
    t0, bad = time.time(), 0
    for i, r in enumerate(rows):
        try:
            im = Image.open(r["path"]).convert("RGB")
            w, h = im.size
            s = 256 / min(w, h)
            im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.BICUBIC)
            w, h = im.size
            l, t = (w - 224) // 2, (h - 224) // 2
            A[i] = np.asarray(im.crop((l, t, l + 224, t + 224)), dtype=np.uint8)
        except Exception as e:
            bad += 1
            print("FAIL", i, r["path"], e, flush=True)
        if (i + 1) % 1000 == 0:
            print(f"  {i+1}/{n} {time.time()-t0:.0f}s", flush=True)
    A.flush()
    print("done", n, "rows,", bad, "failures, %.0fs" % (time.time() - t0), flush=True)


if __name__ == "__main__":
    main()
