"""Offline vs browser parity on the SAME photo.

The browser runs the ONNX I exported; the offline numbers came from the cached
features. If the ONNX's appended intercept column is handled differently on the
two sides, every offline number does not transfer.
"""
import numpy as np, onnxruntime as ort, csv, json
from PIL import Image
ONNX="/workspaces/claude-devcontainer/tmp/culico-ship/culico-net-cls-v1-17-embed.onnx"
CACHE="/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/95-distillation/culico_features.npy"
ROWS="/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/50-h14-scale/cache/rows.tsv"
d=json.load(open("/workspaces/claude-devcontainer/tmp/mid-ship/public/text_embeds_culico.json"))
S,N,AD,D=len(d["species"]),len(d["nuisance"]),len(d["adjacent"]),d["dim"]
rowsm=(np.array(d["species_emb"]).reshape(S,D),np.array(d["nuisance_emb"]).reshape(N,D),
      np.array(d["adjacent_emb"]).reshape(AD,D))
MEAN=np.array([0.485,0.456,0.406],np.float32); STD=np.array([0.229,0.224,0.225],np.float32)
def pre(path):
    im=Image.open(path).convert("RGB"); w,h=im.size
    s=256/min(w,h); im=im.resize((max(1,round(w*s)),max(1,round(h*s))),Image.BICUBIC)
    w,h=im.size; l,t=(w-224)//2,(h-224)//2; im=im.crop((l,t,l+224,t+224))
    a=np.asarray(im,np.float32)/255.; a=(a-MEAN)/STD
    return np.ascontiguousarray(a.transpose(2,0,1)[None])
sess=ort.InferenceSession(ONNX,providers=["CPUExecutionProvider"])
name=sess.get_inputs()[0].name
C=np.load(CACHE); rows=list(csv.DictReader(open(ROWS),delimiter="\t"))
def post(E):
    E=E.astype(np.float64); E/=np.linalg.norm(E,axis=1,keepdims=True)
    emb=np.concatenate([E,np.ones((len(E),1))],1)
    s=np.concatenate([r@emb.T for r in rowsm],0)*(d["logit_scale"]/2.5)
    s=s.T; p=np.exp(s-s.max(1,keepdims=True)); return p/p.sum(1,keepdims=True)
print(f"{'row':>6} {'genus_off':>10} {'genus_bro':>10} {'adj_off':>9} {'adj_bro':>9}  max|ΔspP|")
gof=np.array([x.split(' ')[0] for x in d['species']]); genera=sorted(set(gof)); gidx={g:np.where(gof==g)[0] for g in genera}
for i in [0, 137, 900, 3011, 5500, 6263]:
    raw=sess.run(["culico_embedding"],{name:pre(rows[i]["path"])})[0][0]
    po=post(C[i:i+1])[0]; pb=post(raw[None,:1152])[0]
    def gp(p): 
        sp=p[:S]; return max(sp[gidx[g]].sum() for g in genera)
    print(f"{i:>6} {gp(po):>10.4f} {gp(pb):>10.4f} {po[S+N:].sum():>9.2e} {pb[S+N:].sum():>9.2e}  {np.abs(po[:S]-pb[:S]).max():.2e}")
