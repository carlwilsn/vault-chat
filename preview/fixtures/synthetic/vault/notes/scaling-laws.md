# Scaling laws — the working picture

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
