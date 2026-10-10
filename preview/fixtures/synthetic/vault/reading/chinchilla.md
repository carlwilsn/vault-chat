# Chinchilla, revisited

Compute-optimal for a *fixed* training budget. The frontier moved because inference cost changed the objective: if a model is served a lot, over-training a smaller one past its compute-optimal point pays back on every forward pass.

- Hoffmann et al. 2022: ~20 tokens/param
- Later inference-aware analyses push far beyond that for deployed models
