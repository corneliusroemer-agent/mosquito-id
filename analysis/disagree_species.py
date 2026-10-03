"""Species-level scoring of the disagreement gate.

The genus fit said disagreement separates accuracy cleanly (94% when the views
agree, 65% when they do not) but that neither the fused margin nor the weaker
view's confidence identifies WHICH disagreeing rows are the wrong ones. Genus
scoring cannot see the rest of the question, because a species->genus demotion
does not change the genus answer. 94 of the 180 rows have a species-rank truth,
and on those the demotion is measurable.

Truth is genus-rank for the `culex`, `culiseta`, `anopheles` and
`japonicus-koreicus` slugs (four genera' worth, or a two-species set the label
cannot separate), so those 56 rows are excluded from the species readout and
reported separately at genus level. Dropping them is stated, not silent.
"""
import csv, json
import numpy as np
exec(open('analysis/disagree_fit.py').read().split('# ---- Is the fused')[0])

# slug -> the single species it names, where it names one.
SPEC_SLUG = {'albopictus': 'Aedes albopictus', 'aedes_albopictus': 'Aedes albopictus',
             'aegypti': 'Aedes aegypti', 'aedes_aegypti': 'Aedes aegypti',
             'vexans': 'Aedes vexans', 'aedes_vexans': 'Aedes vexans',
             'geniculatus': 'Aedes geniculatus', 'aedes_geniculatus': 'Aedes geniculatus',
             'aedes_koreicus': 'Aedes koreicus',
             'culex_pipiens': 'Culex pipiens',
             'culex_quinquefasciatus': 'Culex quinquefasciatus',
             'culiseta_longiareolata': 'Culiseta longiareolata',
             'culiseta_annulata': 'Culiseta annulata'}
slug = np.array([r['gt_class'] for r, _, _ in rows])
SPMASK = np.array([s in SPEC_SLUG for s in slug])
truth_sp = np.array([SPEC_SLUG.get(s, '') for s in slug])
topspec = np.array([NAMES[i] for i in top])
topgen = np.array([GEN[i] for i in top])

print(f'\nspecies-rank truth on {int(SPMASK.sum())} of {len(rows)} rows; '
      f'{int((~SPMASK).sum())} are genus-rank and excluded from this readout')

def states(rule_drop):
    """The shipped rule, then the same rule with `rule_drop` rows demoted."""
    st = np.where(spP.max(1) >= SPEC_FLOOR, 'species',
         np.where(gP.max(1) >= GENUS_FLOOR, 'genus', 'unsure'))
    st = np.where(rule_drop & (st == 'species'), 'genus', st)   # demote, never silence
    return st

def readout(mask, st, label):
    ans = mask & (st != 'unsure')
    sp_claim = ans & (st == 'species')
    if not ans.sum(): return f'{label:>34}  (nothing answered)'
    acc_gen = (topgen[ans] == truegen[ans]).mean() * 100
    acc_sp = (topspec[sp_claim] == truth_sp[sp_claim]).mean() * 100 if sp_claim.any() else float('nan')
    return (f'{label:>34}  cov={100*ans.sum()/max(int(mask.sum()),1):5.1f}%  '
            f'genus acc|ans={acc_gen:5.1f}%  species acc|sp-claims={acc_sp:5.1f}%  '
            f'({int(sp_claim.sum())} species claims)')

base_st = states(np.zeros(len(rows), bool))
print('\n--- shipped rule, species-rank rows ---')
for nm, m in (('val', VA & SPMASK), ('test', TE & SPMASK), ('all', SPMASK)):
    print(readout(m, base_st, f'{nm} baseline'))
    for nm2, sel in (('  agree', m & agree), ('  disagree', m & ~agree)):
        print(readout(sel, base_st, nm + nm2))

minP = np.minimum(spA.max(1), spD.max(1))
print('\n--- rule: disagree => species claim demoted to genus (T on marginPts) ---')
print(f'{"T":>5} | {"val cov%":>8} {"val sp-acc":>11} {"val sp-cl":>9} | '
      f'{"test cov%":>9} {"test sp-acc":>12} {"test sp-cl":>10} {"genus-acc test":>14}')
for T in (0, 1, 2, 5, 10, 20, 30, 50):
    st = states((~agree) & (margin < T))
    cells = []
    for m in (VA & SPMASK, TE & SPMASK):
        ans = m & (st != 'unsure'); spc = ans & (st == 'species')
        cells += [100 * ans.sum() / max(int(m.sum()), 1),
                  (topspec[spc] == truth_sp[spc]).mean() * 100 if spc.any() else float('nan'),
                  float(spc.sum()),
                  (topgen[ans] == truegen[ans]).mean() * 100 if ans.any() else float('nan')]
    vcov, vsp, vn, _ = cells[:4]; tcov, tsp, tn, tgen_acc = cells[4:]
    print(f'{T:5.0f} | {vcov:8.1f} {vsp:11.1f} {vn:9.0f} | {tcov:9.1f} {tsp:12.1f} {tn:10.0f} {tgen_acc:14.1f}')

print('\n--- rule: disagree AND minP >= T => unsure (full abstention) ---')
print(f'{"T":>5} | {"val cov%":>8} {"val sp-acc":>11} | {"test cov%":>9} {"test sp-acc":>12} {"genus-acc test":>14}')
for T in (0.0, 0.3, 0.373, 0.5, 0.6, 0.7):
    st = states(np.zeros(len(rows), bool))
    st = np.where((~agree) & (minP >= T), 'unsure', st)
    cells = []
    for m in (VA & SPMASK, TE & SPMASK):
        ans = m & (st != 'unsure'); spc = ans & (st == 'species')
        cells += [100 * ans.sum() / max(int(m.sum()), 1),
                  (topspec[spc] == truth_sp[spc]).mean() * 100 if spc.any() else float('nan'),
                  (topgen[ans] == truegen[ans]).mean() * 100 if ans.any() else float('nan')]
    print(f'{T:5.3f} | {cells[0]:8.1f} {cells[1]:11.1f} | {cells[2]:9.1f} {cells[3]:12.1f} {cells[4]:14.1f}')
