#!/usr/bin/env python3
"""Extract culico-net-cls-v1 features for AUGMENTED views of the TRAIN ROWS ONLY.

val/test images are never augmented: they are always scored on the clean features already in
../95-distillation/culico_features.npy.

One pass over the images: decode once, apply every transform to the decoded PIL image, feed each
view through the (batch-1-pinned) released ONNX graph in turn. Reference preprocess() is copied
verbatim from ../95-distillation/extract_culico.py; crop_rrc replaces only its resize+centrecrop.
"""
import json, os, pathlib, sys, time, zlib

import numpy as np
from PIL import Image, ImageFilter, ImageEnhance

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import common  # noqa: E402

ONNX = "/workspaces/claude-devcontainer/investigations/2026-10-02-mosquito-id/04-local-models/models/cls/culico-net-cls-v1-17.onnx"
FEAT = "/1/1.2/BatchNormalization_output_0"
CACHE = HERE.parent / "cache"
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

SEED_AUG = 20261003


def to_chw(im):
    a = np.asarray(im, dtype=np.float32) / 255.0
    a = (a - IMAGENET_MEAN) / IMAGENET_STD
    return np.ascontiguousarray(a.transpose(2, 0, 1)[None])


def preprocess(im):
    """Reference path: Resize(256, bicubic) -> CenterCrop(224) -> normalise. Verbatim."""
    w, h = im.size
    s = 256 / min(w, h)
    im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.BICUBIC)
    w, h = im.size
    l, t = (w - 224) // 2, (h - 224) // 2
    im = im.crop((l, t, l + 224, t + 224))
    return to_chw(im)


def rrc_preprocess(im, rng):
    """RandomResizedCrop-style: scale in [0.7,1.0] of area, aspect in [3/4,4/3], straight to 224."""
    w, h = im.size
    area = w * h
    for _ in range(10):
        target = area * rng.uniform(0.7, 1.0)
        ar = rng.uniform(3 / 4, 4 / 3)
        cw = round((target * ar) ** 0.5)
        ch = round((target / ar) ** 0.5)
        if 0 < cw <= w and 0 < ch <= h:
            l = rng.integers(0, w - cw + 1)
            t = rng.integers(0, h - ch + 1)
            return to_chw(im.crop((l, t, l + cw, t + ch)).resize((224, 224), Image.BICUBIC))
    return preprocess(im)


# ---- transform table. Each entry: name -> f(pil, rng) -> CHW float32 array --------------
def t_rot(p):
    def f(im, rng):
        return preprocess(im.rotate(float(rng.uniform(-p, p)), resample=Image.BICUBIC,
                                   expand=False, fillcolor=None))
    return f


def t_blur(p):
    def f(im, rng):
        return preprocess(im.filter(ImageFilter.GaussianBlur(radius=p)))
    return f


def t_enhance(kind, lo, hi):
    def f(im, rng):
        fac = float(rng.uniform(lo, hi))
        e = ImageEnhance.Contrast(im) if kind == "contrast" else ImageEnhance.Brightness(im)
        return preprocess(e.enhance(fac))
    return f


def t_hflip(im, rng):
    return preprocess(im.transpose(Image.FLIP_LEFT_RIGHT))


def t_downres(im, rng):
    w, h = im.size
    small = im.resize((max(1, w // 2), max(1, h // 2)), Image.BICUBIC)
    return preprocess(small.resize((w, h), Image.BICUBIC))


def t_rrc(im, rng):
    return rrc_preprocess(im, rng)


def t_identity(im, rng):
    return preprocess(im)


def build(seed):
    """name -> callable. `union` is a *composite* transform (one sample of each member, seeded)."""
    T = {
        "rot_p10": t_rot(10),
        "rot_p20": t_rot(20),
        "blur_r1": t_blur(1),
        "blur_r2": t_blur(2),
        "contrast": t_enhance("contrast", 0.6, 1.4),
        "brightness": t_enhance("brightness", 0.7, 1.3),
        "crop_rrc": t_rrc,
        "hflip": t_hflip,
        "downres": t_downres,
        "identity": t_identity,
    }
    members = ["rot_p10", "blur_r1", "contrast", "crop_rrc", "downres"]

    def union(im, rng):
        """One sample of each member transform, in a fixed order, from one per-image rng."""
        for m in members:
            im = apply_named(im, rng, m)
        return preprocess(im)

    def apply_named(im, rng, name):
        if name in ("rot_p10", "rot_p20"):
            p = 10 if name == "rot_p10" else 20
            return im.rotate(float(rng.uniform(-p, p)), resample=Image.BICUBIC, expand=False)
        if name in ("blur_r1", "blur_r2"):
            return im.filter(ImageFilter.GaussianBlur(radius=int(name[-1])))
        if name == "contrast":
            return ImageEnhance.Contrast(im).enhance(float(rng.uniform(0.6, 1.4)))
        if name == "brightness":
            return ImageEnhance.Brightness(im).enhance(float(rng.uniform(0.7, 1.3)))
        if name == "crop_rrc":
            w, h = im.size
            area = w * h
            for _ in range(10):
                target = area * rng.uniform(0.7, 1.0)
                ar = rng.uniform(3 / 4, 4 / 3)
                cw, ch = round((target * ar) ** 0.5), round((target / ar) ** 0.5)
                if 0 < cw <= w and 0 < ch <= h:
                    l, t = int(rng.integers(0, w - cw + 1)), int(rng.integers(0, h - ch + 1))
                    return im.crop((l, t, l + cw, t + ch))
            return im
        if name == "hflip":
            return im.transpose(Image.FLIP_LEFT_RIGHT)
        if name == "downres":
            w, h = im.size
            return im.resize((max(1, w // 2), max(1, h // 2)), Image.BICUBIC
                             ).resize((w, h), Image.BICUBIC)
        raise KeyError(name)

    T["union"] = union
    T["hflip_s2"] = lambda im, rng: preprocess(
        im.transpose(Image.FLIP_LEFT_RIGHT).rotate(float(rng.uniform(-10, 10)),
                                                    resample=Image.BICUBIC))
    return T


def main():
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else SEED_AUG
    suffix = sys.argv[2] if len(sys.argv) > 2 else ""
    import onnx, onnxruntime as ort
    from onnx import helper

    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    so.inter_op_num_threads = 1
    m = onnx.load(ONNX)
    for vi in list(m.graph.input) + list(m.graph.output):
        d0 = vi.type.tensor_type.shape.dim[0]
        d0.ClearField("dim_value")
        d0.dim_param = "N"
    w = None
    for n in m.graph.node:
        if n.output and n.output[0] == FEAT:
            init = [t for t in m.graph.initializer if t.name == n.input[1]]
            if init:
                w = int(init[0].dims[-1])
    assert w
    if any(o.name == FEAT for o in m.graph.output):
        m.graph.output.pop([o.name for o in m.graph.output].index(FEAT))
    m.graph.output.append(helper.make_tensor_value_info(FEAT, onnx.TensorProto.FLOAT, [None, w]))
    sess = ort.InferenceSession(m.SerializeToString(), so, providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name

    rows = common.load_rows()
    tr, va, te = common.uuid_split(rows)
    print("split", len(tr), len(va), len(te), "leak", common.leak_check(rows, tr, va, te), flush=True)

    T = build(seed)
    names = list(T)
    if len(sys.argv) > 3:
        names = sys.argv[3].split(",")
        for n in names:
            assert n in T, n
    F = {n: np.zeros((len(tr), w), dtype=np.float32) for n in names}
    t0 = time.time()
    t_dec = t_inf = 0.0
    for j, i in enumerate(tr):
        d0 = time.time()
        im = Image.open(rows[i]["path"]).convert("RGB")
        t_dec += time.time() - d0
        for n in names:
            rng = np.random.default_rng((seed, int(i), zlib.crc32(n.encode()) % (2 ** 31)))
            a = T[n](im, rng)
            d1 = time.time()
            F[n][j] = sess.run([FEAT], {name: a})[0][0]
            t_inf += time.time() - d1
        if (j + 1) % 500 == 0:
            print(f"  {j+1}/{len(tr)}  {time.time()-t0:.0f}s", flush=True)
    for n in names:
        np.save(CACHE / f"aug_{n}{suffix}.npy", F[n])
    total = time.time() - t0
    meta = {"seed": seed, "suffix": suffix, "n_train_rows": int(len(tr)), "views": names,
            "dim": w, "wall_s_total_s": round(total, 1),
            "s_per_row_all_views": round(total / len(tr), 3),
            "s_per_row_decode": round(t_dec / len(tr), 4),
            "s_per_row_inference_all_views": round(t_inf / len(tr), 4),
            "threads": 4, "cpu_affinity": "taskset -c 0-6", "omp_num_threads": 4,
            "transform_params": {
                "rot_p10": "rotate angle~U(-10,10) deg, BICUBIC, expand=False",
                "rot_p20": "rotate angle~U(-20,20) deg, BICUBIC, expand=False",
                "blur_r1": "ImageFilter.GaussianBlur(radius=1)", "blur_r2": "radius=2",
                "contrast": "ImageEnhance.Contrast, f~U(0.6,1.4)",
                "brightness": "ImageEnhance.Brightness, f~U(0.7,1.3)",
                "crop_rrc": "area~U(0.7,1.0), aspect~U(3/4,4/3), 10 retries, resize->224 BICUBIC",
                "hflip": "PIL FLIP_LEFT_RIGHT", "downres": "half-size BICUBIC then back to original BICUBIC",
                "identity": "no transform (control: measures a duplicate pass through the graph)",
                "union": "rot_p10 -> blur_r1 -> contrast -> crop_rrc -> downres, one sample each",
                "hflip_s2": "hflip + rotate U(-10,10), the second-seed weak view",
            }}
    json.dump(meta, open(CACHE / f"aug_meta{suffix}.json", "w"), indent=2)
    print(json.dumps({k: v for k, v in meta.items() if k != "transform_params"}, indent=2))


if __name__ == "__main__":
    main()
