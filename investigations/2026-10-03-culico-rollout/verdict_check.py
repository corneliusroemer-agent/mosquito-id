"""Species macro-F1 is 0.07 in every arm, and genus argmax is 79%. Those cannot
both be true of the same head. Find out which, by running the app's own three
state rule over the whole corpus rather than the test split."""
import sys, json
import numpy as np
sys.path.insert(0,"/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/99-calibration-ship")
import common as C
d=json.load(open("/workspaces/claude-devcontainer/tmp/mid-ship/public/text_embeds_culico.json"))
S,N,AD,D=len(d["species"]),len(d["nuisance"]),len(d["adjacent"]),d["dim"]
W=np.array(d["species_emb"]).reshape(S,D);NU=np.array(d["nuisance_emb"]).reshape(N,D);A=np.array(d["adjacent_emb"]).reshape(AD,D)
E=np.load("/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/95-distillation/culico_features.npy").astype(np.float64)
E/=np.linalg.norm(E,axis=1,keepdims=True); E=np.concatenate([E,np.ones((len(E),1))],1)
s=np.concatenate([r@E.T for r in [W,NU,A]],0)*(d["logit_scale"]/2.5); s=s.T
p=np.exp(s-s.max(1,keepdims=True)); p/=p.sum(1,keepdims=True)
sp=p[:,:S]
gof=np.array([x.split(" ")[0] for x in d["species"]]);genera=sorted(set(gof))
gidx={g:np.where(gof==g)[0] for g in genera}
gP=np.stack([sp[:,gidx[g]].sum(1) for g in genera],1)
rows,truth=C.load_rows(),C.load_truth()
T=C.truth_arrays(C.Head(),rows,truth)
gi={g:i for i,g in enumerate(genera)}
gt=np.array([gi[s2.split(" ")[0]] for s2 in T["sp"]])
print("species label counts in the head (corpus):")
for i,n in enumerate(d["species"]):
    c=(T["s_i"]==i).sum()
    if c: print(f"   {n:<28} {c}")
print("\nPINNED (never labelled) rows:", [n for i,n in enumerate(d["species"]) if (T["s_i"]==i).sum()==0])
print(f"\ngenus argmax acc (all rows): {100*(gP.argmax(1)==gt).mean():.2f}%")
spm=T["s_i"]>=0
print(f"species argmax acc (labelled rows): {100*(sp[spm].argmax(1)==T['s_i'][spm]).mean():.2f}%  n={int(spm.sum())}")
