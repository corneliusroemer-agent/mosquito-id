"""What do the ten public/samples photos actually produce through culico's head?
Run the app's own arithmetic on them via the exported ONNX."""
import sys, glob, os, json
import numpy as np, onnxruntime as ort
sys.path.insert(0,"/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/99-calibration-ship")
from PIL import Image
ONNX="/workspaces/claude-devcontainer/tmp/culico-ship/culico-net-cls-v1-17-embed.onnx"
d=json.load(open("/workspaces/claude-devcontainer/tmp/mid-ship/public/text_embeds_culico.json"))
S,N,A,D=len(d["species"]),len(d["nuisance"]),len(d["adjacent"]),d["dim"]
rowsm=(np.array(d["species_emb"]).reshape(S,D),np.array(d["nuisance_emb"]).reshape(N,D),
      np.array(d["adjacent_emb"]).reshape(A,D))
gof=np.array([x.split(" ")[0] for x in d["species"]]); genera=sorted(set(gof))
gidx={g:np.where(gof==g)[0] for g in genera}
MEAN=np.array([0.485,0.456,0.406],np.float32); STD=np.array([0.229,0.224,0.225],np.float32)
def pre(path):
    im=Image.open(path).convert("RGB"); w,h=im.size
    s=256/min(w,h); im=im.resize((max(1,round(w*s)),max(1,round(h*s))),Image.BICUBIC)
    w,h=im.size; l,t=(w-224)//2,(h-224)//2; im=im.crop((l,t,l+224,t+224))
    a=np.asarray(im,np.float32)/255.; a=(a-MEAN)/STD
    return np.ascontiguousarray(a.transpose(2,0,1)[None])
sess=ort.InferenceSession(ONNX,providers=["CPUExecutionProvider"]); name=sess.get_inputs()[0].name
print(f"{'photo':<34} {'topGenus':<20} {'gP':>7} {'topSp':<24} {'spP':>7} {'adP':>8}")
for f in sorted(glob.glob("/workspaces/claude-devcontainer/tmp/mid-ship/public/samples/*")):
    e=sess.run(["culico_embedding"],{name:pre(f)})[0][0].astype(np.float64)
    e/=np.linalg.norm(e[:1152]); e=np.append(e[:1152],1.0)
    s_=np.concatenate([r@e for r in rowsm])*(d["logit_scale"]/2.5)
    p=np.exp(s_-s_.max()); p/=p.sum()
    sp=p[:S]; gP={g:sp[gidx[g]].sum() for g in genera}
    tg=max(gP,key=gP.get); ti=int(sp.argmax())
    print(f"{os.path.basename(f)[:33]:<34} {tg:<20} {gP[tg]*100:>6.1f}% {d['species'][ti][:23]:<24} {sp[ti]*100:>6.1f}% {p[S+N:].sum():>8.4f}")
