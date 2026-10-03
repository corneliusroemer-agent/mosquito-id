"""Re-sweep the background row with SPECIES RECALL as a reported number, not an
afterthought. The earlier sweep reported catch and FP only, which is how a row
that breaks the genus floor could look like a win."""
import sys, json
import numpy as np
sys.path.insert(0,"/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/99-calibration-ship")
import common as C

d=json.load(open("/workspaces/claude-devcontainer/tmp/mid-ship/public/text_embeds_culico.json"))
S,N,AD,D=len(d["species"]),len(d["nuisance"]),len(d["adjacent"]),d["dim"]
scale=d["logit_scale"]/2.5
W=np.array(d["species_emb"]).reshape(S,D); NU=np.array(d["nuisance_emb"]).reshape(N,D)
A=np.array(d["adjacent_emb"]).reshape(AD,D)
POS=np.load("/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/95-distillation/culico_features.npy").astype(np.float64)
NEG=np.load("/workspaces/claude-devcontainer/investigations/2026-10-02-mosquito-id/36-negatives/culico_neg_features.npy").astype(np.float64)

rows,truth=C.load_rows(),C.load_truth()
_,_,te_idx=C.uuid_split(rows); TE=np.zeros(len(rows),bool); TE[te_idx]=True
T=C.truth_arrays(C.Head(),rows,truth)
gof=np.array([x.split(" ")[0] for x in d["species"]]); genera=sorted(set(gof))
gidx={g:np.where(gof==g)[0] for g in genera}; gi={g:i for i,g in enumerate(genera)}
g_true_i=np.array([gi[s.split(" ")[0]] for s in T["sp"]])

def prep(E):
    E=E.copy(); E/=np.linalg.norm(E,axis=1,keepdims=True); return np.concatenate([E,np.ones((len(E),1))],1)
embP,embN=prep(POS),prep(NEG)

def post(rowsm,emb):
    s=np.concatenate([r@emb.T for r in rowsm],0)*scale
    s=s.T; p=np.exp(s-s.max(1,keepdims=True)); return p/p.sum(1,keepdims=True)

print(f"{'mult':>5} {'catch%':>7} {'FP%':>7} {'genF1':>7} {'spF1':>7} {'genAcc':>7} {'cov%':>6} {'adjMax':>8}")
base=None
for mult in [0,1,4,8,12,16,18,24,32,64]:
    Ab=A.copy(); Ab[-1,:D-1]=(A[-1,:D-1]/18.0)*mult if mult else 0.0
    if mult==0: Ab[-1,:D-1]=0.0
    Ab[-1,-1]=0.0
    pP=post([W,NU,Ab],embP); pN=post([W,NU,Ab],embN)
    sp=pP[:,:S]; nu=pP[:,S:S+N].max(1); ad=pP[:,S+N:].sum(1)
    gP=np.stack([sp[:,gidx[g]].sum(1) for g in genera],1)
    catch=100*(pN[:,S+N:].sum(1)>=0.6).mean(); fp=100*(ad>=0.6).mean()
    M=TE; y=T["g_i"]; pg=gP[M].argmax(1)
    genF1=C.macro_f1(y[M],pg,range(len(genera))); genAcc=100*(pg==y[M]).mean()
    SPm=M&(T["s_i"]>=0); inh=SPm
    # species argmax over rows whose truth is a head species
    spm=M&(T["s_i"]>=0)
    spF1=C.macro_f1(T["s_i"][spm],sp[spm].argmax(1),range(S))
    cov=100*(gP[M].max(1)>=0.80).mean()
    print(f"{mult:>5} {catch:>7.2f} {fp:>7.3f} {genF1:>7.2f} {spF1:>7.2f} {genAcc:>7.2f} {cov:>6.1f} {ad.max():>8.3f}")
