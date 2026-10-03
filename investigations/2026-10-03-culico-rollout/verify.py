import numpy as np, onnxruntime as ort, csv
from PIL import Image
ONNX="/workspaces/claude-devcontainer/tmp/culico-ship/culico-net-cls-v1-17-embed.onnx"
FEAT="/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/95-distillation/culico_features.npy"
ROWS="/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/50-h14-scale/cache/rows.tsv"
IMAGENET_MEAN=np.array([0.485,0.456,0.406],np.float32); IMAGENET_STD=np.array([0.229,0.224,0.225],np.float32)
def preprocess(path):
    im=Image.open(path).convert("RGB"); w,h=im.size
    s=256/min(w,h); im=im.resize((max(1,round(w*s)),max(1,round(h*s))),Image.BICUBIC)
    w,h=im.size; l,t=(w-224)//2,(h-224)//2
    im=im.crop((l,t,l+224,t+224))
    a=np.asarray(im,np.float32)/255.0; a=(a-IMAGENET_MEAN)/IMAGENET_STD
    return np.ascontiguousarray(a.transpose(2,0,1)[None])
sess=ort.InferenceSession(ONNX,providers=["CPUExecutionProvider"])
print("inputs",[i.name for i in sess.get_inputs()],"outputs",[o.name for o in sess.get_outputs()])
E=np.load(FEAT)
rows=list(csv.DictReader(open(ROWS),delimiter="\t"))
name=sess.get_inputs()[0].name
errs=[]
for i in [0, 100, 3000, 6263]:
    e=sess.run(["culico_embedding"],{name:preprocess(rows[i]["path"])})[0][0]
    ref=E[i]
    d=float(np.abs(e[:1152]-ref).max()); rel=d/float(np.abs(ref).max())
    errs.append(rel)
    print(f"row {i}: max|diff|={d:.3e} rel={rel:.3e} const={e[1152]!r} norm_ref={np.linalg.norm(ref):.3f}")
print("max rel err:", max(errs))
