# Spectral clustering — why eigenvectors

Build a similarity graph $W$, its degree matrix $D$, and the Laplacian $L = D - W$. The smallest eigenvectors of $L$ (or of the normalized $L_{sym} = I - D^{-1/2} W D^{-1/2}$) embed each node in $\mathbb{R}^k$; then run k-means there.

## Why not the adjacency matrix directly?

- The Laplacian's quadratic form is $f^\top L f = \tfrac12 \sum_{ij} w_{ij} (f_i - f_j)^2$, so small eigenvalues mean *smooth over the graph* — exactly a relaxed min-cut.
- The number of zero eigenvalues equals the number of connected components. Adjacency has no such clean statement.
- Normalizing by degree stops high-degree hubs from dominating (the Ncut relaxation).

## Open questions

- How sensitive is the result to the kernel bandwidth $\sigma$ in $w_{ij} = \exp(-\|x_i - x_j\|^2 / 2\sigma^2)$?
- When does the eigengap heuristic for choosing $k$ fail? (Office hours: when cluster sizes differ a lot.)

From STAT 210 — see [[problem-set-3]].
