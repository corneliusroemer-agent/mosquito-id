#!/usr/bin/env python3
"""Regenerate culico_features.npy from the TorchScript release, in ~40 s.

The ONNX route in ../95-distillation/extract_culico.py needs the graph edited to expose a second
output and runs at 0.12 s/img. The TorchScript release needs no surgery, batches, and reproduces
the existing cache at cosine 1.000000 -- which is what makes it safe to use here: the features this
writes are the features every other arm in this directory reads.
"""
import os
import sys
import time

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

TS = "/workspaces/claude-devcontainer/investigations/2026-10-02-mosquito-id/04-local-models/models/cls/culico-net-cls-v1-17.pt"
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def prep(p):
    im = Image.open(p).convert("RGB")
    w, h = im.size
    s = 256 / min(w, h)
    im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.BICUBIC)
    w, h = im.size
    l, t = (w - 224) // 2, (h - 224) // 2
    a = np.asarray(im.crop((l, t, l + 224, t + 224)), np.float32) / 255.0
    return torch.from_numpy(((a - MEAN) / STD).transpose(2, 0, 1))


def main():
    ts = torch.jit.load(TS, map_location="cpu")
    back, head = getattr(ts, "0"), getattr(ts, "1")
    rows = C.load_rows()
    F = np.zeros((len(rows), 1152), np.float32)
    t0 = time.time()
    with torch.no_grad():
        for i in range(0, len(rows), 32):
            x = torch.stack([prep(rows[j]["path"]) for j in range(i, min(i + 32, len(rows)))])
            f = getattr(head, "2")(getattr(head, "1")(getattr(head, "0")(back(x))))
            F[i:i + len(x)] = f.numpy()
            if (i // 32) % 40 == 0:
                print(f"  {i}/{len(rows)} {time.time()-t0:.0f}s", flush=True)
    F /= np.linalg.norm(F, axis=1, keepdims=True)
    np.save(C.CULICO, F)
    print("wrote", C.CULICO, F.shape, "%.0fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
