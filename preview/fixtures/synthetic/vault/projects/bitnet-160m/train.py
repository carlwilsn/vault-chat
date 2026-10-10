"""Ternary-weight transformer training loop (BitNet b1.58, 160M)."""
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
