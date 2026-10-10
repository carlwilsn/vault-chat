# BitNet 160M — reproduction

Goal: reproduce the 160M-parameter BitNet b1.58 result on our A10 box, three seeds, and write it up.

## Status (2026-10-09)

- [x] Data pipeline: C4 shards 0–11, 1.7B tokens, tokenized once and cached
- [x] Seeds 42 and 44 trained, `eval.loss` committed under `results/`
- [x] Seed 43 rerun at the muP-transferred LR (first run diverged at step 800)
- [ ] Writeup — draft in [[writeup]]
- [ ] Decide: extend to 3.2B tokens or stop here

## Layout

| path | what |
|---|---|
| `train.py` | the training loop (ternary linear layers, STE) |
| `results.csv` | one row per seed |
| `writeup.md` | the paper-style writeup |

## Commands

```bash
python train.py --seed 42 --tokens 1.7e9 --lr-from mup.json
python eval.py results/seed42.ckpt --shard heldout-00
```

See also [[scaling-laws]] and [[mup]].
