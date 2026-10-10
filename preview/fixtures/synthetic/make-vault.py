# Writes the invented half of the synthetic fixture vault (the other half is
# the repo's demo-vault/, mounted under "guide/"). Everything here is made up:
# no real vault content, no real names beyond Carl's own, no keys.
#   python preview/fixtures/synthetic/make-vault.py
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vault")

FILES = {}

FILES["projects/bitnet-160m/README.md"] = r"""# BitNet 160M — reproduction

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
"""

FILES["projects/bitnet-160m/writeup.md"] = r"""# Reproducing BitNet b1.58 at 160M parameters

*Draft — Carl, October 2026*

## Summary

The 160M reproduction is stable across three seeds (eval loss 1.559 ± 0.001) and sits about 0.13 nat above the reference number. Almost all of that gap is explained by training on 1.7B tokens against a compute-optimal budget of roughly 3.2B.

## Setup

We train a decoder-only transformer with every linear layer replaced by a ternary layer. Weights are quantized to $\{-1, 0, +1\}$ with a per-tensor scale

$$\hat{w} = \alpha \cdot \operatorname{round}\left(\frac{w}{\alpha}\right)_{[-1,1]}, \qquad \alpha = \frac{1}{n}\sum_i |w_i|.$$

Gradients pass through the rounding with the straight-through estimator.

## Results

| seed | tokens | eval loss |
|---|---|---|
| 42 | 1.70B | 1.5576 |
| 43 | 1.70B | 1.5601 |
| 44 | 1.70B | 1.5588 |

The spread across seeds is 0.0025 nat, inside our 0.005 tolerance.

## What went wrong once

Seed 43's first run diverged at step 800. Its worker had inherited the 12M proxy's raw learning rate instead of the muP-transferred one, so it ran about 1.6x too hot. We now assert the effective LR against the transferred target at step 0.

## Next

Closing the gap is a token-count decision, not an architecture one. Extending to 3.2B tokens means re-fitting the cosine schedule to the longer horizon rather than simply training further.
"""

FILES["projects/bitnet-160m/results.csv"] = """seed,tokens,steps,peak_lr,eval_loss,wall_hours,gpu
42,1.70e9,3240,3.0e-3,1.5576,13.6,A10
43,1.70e9,3240,3.0e-3,1.5601,13.9,A10
44,1.70e9,3240,3.0e-3,1.5588,13.5,A10
"""

FILES["projects/bitnet-160m/train.py"] = r'''"""Ternary-weight transformer training loop (BitNet b1.58, 160M)."""
import argparse
import json
import math

import torch
import torch.nn as nn
import torch.nn.functional as F


class TernaryLinear(nn.Linear):
    """Linear layer whose weights are quantized to {-1, 0, +1} * alpha."""

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        w = self.weight
        alpha = w.abs().mean().clamp(min=1e-8)
        w_q = (w / alpha).round().clamp(-1, 1) * alpha
        # straight-through estimator: forward uses w_q, backward sees w
        w_ste = w + (w_q - w).detach()
        return F.linear(x, w_ste, self.bias)


def cosine(step: int, warmup: int, total: int, peak: float, floor: float) -> float:
    if step < warmup:
        return peak * step / max(1, warmup)
    t = (step - warmup) / max(1, total - warmup)
    return floor + 0.5 * (peak - floor) * (1 + math.cos(math.pi * t))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--tokens", type=float, default=1.7e9)
    ap.add_argument("--lr-from", default="mup.json")
    args = ap.parse_args()
    torch.manual_seed(args.seed)
    peak = json.load(open(args.lr_from))["peak_lr"]
    steps = int(args.tokens // (512 * 1024))
    warmup = int(0.02 * steps)
    # Guard added after seed 43: the effective LR must match the transferred target.
    assert abs(cosine(warmup, warmup, steps, peak, 0.1 * peak) - peak) < 1e-9
    print(f"seed={args.seed} steps={steps} warmup={warmup} peak_lr={peak}")


if __name__ == "__main__":
    main()
'''

FILES["notes/spectral-clustering.md"] = r"""# Spectral clustering — why eigenvectors

Build a similarity graph $W$, its degree matrix $D$, and the Laplacian $L = D - W$. The smallest eigenvectors of $L$ (or of the normalized $L_{sym} = I - D^{-1/2} W D^{-1/2}$) embed each node in $\mathbb{R}^k$; then run k-means there.

## Why not the adjacency matrix directly?

- The Laplacian's quadratic form is $f^\top L f = \tfrac12 \sum_{ij} w_{ij} (f_i - f_j)^2$, so small eigenvalues mean *smooth over the graph* — exactly a relaxed min-cut.
- The number of zero eigenvalues equals the number of connected components. Adjacency has no such clean statement.
- Normalizing by degree stops high-degree hubs from dominating (the Ncut relaxation).

## Open questions

- How sensitive is the result to the kernel bandwidth $\sigma$ in $w_{ij} = \exp(-\|x_i - x_j\|^2 / 2\sigma^2)$?
- When does the eigengap heuristic for choosing $k$ fail? (Office hours: when cluster sizes differ a lot.)

From STAT 210 — see [[problem-set-3]].
"""

FILES["notes/scaling-laws.md"] = r"""# Scaling laws — the working picture

Three levers set the loss: parameters $N$, tokens $D$, and compute $C \approx 6ND$.

- Compute-optimal ratio is about **20 tokens per parameter** (Chinchilla regime).
- At $N = 160\text{M}$ that is ~3.2B tokens; our runs used 1.7B (10.6 tok/param), so they are under-trained by ~2x.
- If inference cost matters, over-train a smaller model past its compute-optimal point.

## The LR schedule is coupled to D

Cosine decay is set to reach its floor at the *planned* last step. Extending $D$ without re-planning the schedule wastes the tail at near-zero LR, or never decays enough.

| tokens | steps | warmup | floor |
|---|---|---|---|
| 1.7B | 3240 | 65 | 0.1 x peak |
| 3.2B | 6100 | 122 | 0.1 x peak |
"""

FILES["notes/mup.md"] = r"""# muP — hyperparameter transfer

muP makes the optimal learning rate **width-invariant**: tune once on a narrow proxy (12M), transfer to the target width (160M) unchanged.

What does *not* transfer: depth-dependent terms (residual scaling). Keep depth fixed between proxy and target.

Peak LR fit on the proxy: `3.0e-3`.

> The one time it "failed" (seed 43) was plumbing, not theory — the worker read the proxy's raw LR.
"""

FILES["daily/2026-10-08.md"] = r"""# Wed 8 Oct

- Seed 43 diverged at step 800 — flagged by the mission, rerunning at matched LR
- STAT 210 PS3 problem 2 done; problem 4 still stuck on the eigengap bound
- Read: Chinchilla revisited (notes in [[chinchilla]])

## Tomorrow
- [ ] writeup table
- [ ] office hours 2pm
"""

FILES["daily/2026-10-09.md"] = r"""# Thu 9 Oct

- All three seeds in tolerance. Writeup draft started.
- Office hours: the eigengap heuristic fails when clusters have very different sizes — added to [[spectral-clustering]].
- Box spend this week: A10 x 41h, A100 x 6h.

## Tomorrow
- [ ] decide on 3.2B extension
- [ ] PS3 problem 4
"""

FILES["daily/2026-10-10.md"] = r"""# Fri 10 Oct

- [ ] PS3 problem 4 — due Monday
- [ ] reply about the Thursday reading group
- [ ] decide: extend BitNet to 3.2B tokens?
"""

FILES["courses/stat-210/problem-set-3.md"] = r"""# STAT 210 — Problem set 3

Due Monday 13 Oct.

## Problem 1
Show that the graph Laplacian $L = D - W$ is positive semidefinite.

**Solution.** For any $f \in \mathbb{R}^n$,
$$f^\top L f = \sum_i d_i f_i^2 - \sum_{ij} w_{ij} f_i f_j = \frac12 \sum_{ij} w_{ij} (f_i - f_j)^2 \ge 0.$$

## Problem 2
Prove the multiplicity of eigenvalue 0 equals the number of connected components.

**Solution.** (done — see notebook p. 14)

## Problem 3
Implement spectral clustering on the two-moons dataset and compare with k-means.

## Problem 4
Bound the misclustering rate in terms of the eigengap $\lambda_{k+1} - \lambda_k$.

*Stuck: Davis–Kahan gives the subspace angle, but how do I get from the angle to the k-means error?*
"""

FILES["courses/stat-210/syllabus.md"] = r"""# STAT 210 — Statistical learning on graphs

- Lectures Tue/Thu 10:30, office hours Thu 2pm
- Grading: 4 problem sets (40%), project (40%), participation (20%)

| week | topic |
|---|---|
| 1 | graphs, Laplacians |
| 2 | spectral clustering |
| 3 | random walks, PageRank |
| 4 | graph neural networks |
"""

FILES["reading/chinchilla.md"] = r"""# Chinchilla, revisited

Compute-optimal for a *fixed* training budget. The frontier moved because inference cost changed the objective: if a model is served a lot, over-training a smaller one past its compute-optimal point pays back on every forward pass.

- Hoffmann et al. 2022: ~20 tokens/param
- Later inference-aware analyses push far beyond that for deployed models
"""

FILES["reading/README.md"] = r"""# Reading list

- [[chinchilla]]
- Attention survey (long PDF) — `papers/attention-survey.pdf`, 320 pages
"""

FILES[".vaultchatignore"] = "papers/old/\n"

for rel, text in FILES.items():
    p = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
print(f"wrote {len(FILES)} files under {ROOT}")
