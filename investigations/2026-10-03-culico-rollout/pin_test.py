"""Why species argmax is 22%: species the corpus never labels were given the GENUS
row, so on an Aedes photo those three rows carry a strong genus logit and beat the
species-probe rows. Test pinning them low instead."""
import sys, json
import numpy as np
sys.path.insert(0,"/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/99-calibration-ship")
import common as C
d=json.load(open("/workspaces/claude-devcontainer/tmp/mid-ship/public/text_embeds_culico.json"))
S,N,AD,D=len(d["species"]),len(d["nuisance"]),len(d["adjacent"]),d["dim"]
W=np.array(d["species_emb"]).reshape(S,D).copy(); A=np.array(d["adjacent_emb"]).reshape(AD,D).copy()
E=np.load("/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/95-distillation/culico_features.npy").astype(np.float64)
E/=np.linalg.norm(E,axis=1,keepdims=True); E=np.concatenate([E,np.ones((len(E),1))],1)
rows,truth=C.load_rows(),C.load_truth(); T=C.truth_arrays(C.Head(),rows,truth)
gof=np.array([x.split(" ")[0] for x in d["species"]]);genera=sorted(set(gof))
gidx={g:np.where(gof==g)[0] for g in genera}; gi={g:i for i,g in enumerate(genera)}
gt=np.array([gi[x.split(" ")[0]] for x in T["sp"]]); spm=T["s_i"]>=0
NU_LEVEL=float(np.log(1e-9))
unlabelled=[i for i in range(S) if (T["s_i"]==i).sum()==0]
print("unlabelled rows:", [d["species"][i] for i in unlabelled])

def evaluate(tag, Wm):
    Wc=Emm=None
    s=np.concatenate([Wm@E.T, np.array(d["nuisance_emb"]).reshape(N,D)@E.T, A@E.T],0)*(d["logit_scale"]/2.5); s=s.T
    p=np.exp(s-s.max(1,keepdims=True)); p/=p.sum(1,keepdims=True)
    sp=p[:,:S]; gP=np.stack([sp[:,gidx[g]].sum(1) for g in genera],1)
    print(f"{tag:<26} genus {100*(gP.argmax(1)==gt).mean():5.2f}%  species {100*(sp[spm].argmax(1)==T['s_i'][spm]).mean():5.2f}%  "
          f"genCov@0.80 {100*(gP.max(1)>=0.80).mean():5.1f}%  spCov@0.373 {100*(sp.max(1)>=0.373).mean():5.1f}%")

evaluate("genus row on unlabelled", W)
Wp=W.copy()
for i in unlabelled: Wp[i]=0.0; Wp[i,-1]=NU_LEVEL
evaluate("pinned low", Wp)
