# Reproducing BitNet b1.58 at 160M parameters

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
