# STAT 210 — Problem set 3

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
