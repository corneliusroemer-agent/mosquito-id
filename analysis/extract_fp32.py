"""Re-extract image embeddings in fp32, through the app's own preprocessing.

The 6,264-row positive cache came from an INT8 ONNX quantisation of the same
tower (mean cosine to fp32 0.9907, min 0.947), while the negatives were extracted
in fp32 torch. Mixing the two sides of a comparison is exactly the mistake that
would make a false-positive rate fictional, so this re-extracts either side in
fp32 with one pipeline and lets both be compared on equal terms.

  neg    the 700 verified negative crops
  posN   every Nth row of the 6,264-row positive cache (pos4 = 1,566 rows)

The preprocessing here is `clipEmbed` reproduced exactly: resize the shorter side
to 224, centre-crop 224, divide by 255, then apply the OpenAI CLIP mean/std the
app uses. Note this is the CLIP tower's path, NOT the detector's - the detector's
`chwFromCanvas` divides by 255 and stops, with no mean/std at all. Verifying
negatives through the wrong one of those is how the first attempt at this
benchmark rejected 991 of 991 crops as "containing a mosquito".

Resumable: embeddings are rewritten every 50 rows, and a killed run continues.

Run: HF_HUB_OFFLINE=1 uv run --with open_clip_torch --with torch \
      python analysis/extract_fp32.py neg
"""
import os, csv, sys, time
os.environ.setdefault('HF_HUB_OFFLINE', '1')
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
import torch, open_clip

CACHE = os.environ.get('MOSQ_CACHE', '/workspaces/claude-devcontainer/investigations/'
                        '2026-10-03-rewrite/40-precision/50-h14-scale/cache')
NEG = os.environ.get('MOSQ_NEG', '/workspaces/claude-devcontainer/tmp/adjacent-taxa-work/neg')
MODE = sys.argv[1]                      # 'pos' or 'neg'
OUT = f'fp32_{MODE}.npy'
INDEX = f'fp32_{MODE}_index.tsv'
MODEL = 'hf-hub:imageomics/bioclip-2.5-vith14'

m, _, pre = open_clip.create_model_and_transforms(MODEL)
m.eval()
torch.set_num_threads(int(os.environ.get('TORCH_THREADS', '8')))

if MODE.startswith('pos'):
    # posN = every Nth row, so the fp32 control costs N times less wall clock and
    # still spans the whole corpus (rows are already shuffled within species).
    stride = int(MODE[3:] or 1)
    rows = list(csv.DictReader(open(f'{CACHE}/rows.tsv'), delimiter='\t'))
    paths = [r['path'] for r in rows[::stride]]
else:
    paths = [f'{NEG}/crops/' + r['file'] for r in
             csv.DictReader(open(f'{NEG}/neg_manifest.tsv'), delimiter='\t')]

done = 0
if os.path.exists(OUT) and os.path.getsize(OUT) > 0:
    V = np.load(OUT); done = V.shape[0]
    print(f'resuming after {done}', flush=True)
else:
    V = np.zeros((0, 1024), np.float32)
with open(INDEX, 'w') as f:
    f.write('\n'.join(paths) + '\n')

t0 = time.perf_counter(); buf = []
with torch.inference_mode():
    for i in range(done, len(paths)):
        try:
            im = Image.open(paths[i]).convert('RGB')
        except Exception as e:
            print('BAD', paths[i], e, flush=True); continue
        e = m.encode_image(pre(im).unsqueeze(0)).float().numpy()[0]
        V = np.concatenate([V, (e / np.linalg.norm(e))[None].astype(np.float32)])
        buf.append(paths[i])
        if len(buf) == 50:
            np.save(OUT, V); done += len(buf); buf = []
            el = time.perf_counter() - t0
            print(f'{done}/{len(paths)} {el:.0f}s {el/max(done,1):.3f}s/img', flush=True)
np.save(OUT, V)
print('DONE', V.shape, f'{time.perf_counter()-t0:.0f}s', flush=True)
