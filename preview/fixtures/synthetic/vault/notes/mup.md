# muP — hyperparameter transfer

muP makes the optimal learning rate **width-invariant**: tune once on a narrow proxy (12M), transfer to the target width (160M) unchanged.

What does *not* transfer: depth-dependent terms (residual scaling). Keep depth fixed between proxy and target.

Peak LR fit on the proxy: `3.0e-3`.

> The one time it "failed" (seed 43) was plumbing, not theory — the worker read the proxy's raw LR.
