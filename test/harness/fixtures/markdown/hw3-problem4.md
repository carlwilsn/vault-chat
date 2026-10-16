Let $m,n\geq N$. WLOG, suppose $m\geq n$. If $m=n$, then $|x_m-x_n|=0<\epsilon$.

For $m>n$, subtracting gives

$$
|x_m-x_n|
=
\left|\frac1{n+1}-\frac1{n+2}+\cdots+\frac{(-1)^{m-n-1}}m\right|.
$$

**Case 1: $m-n$ is even.**
Pairing consecutive terms gives
$$
\left(\frac1{n+1}-\frac1{n+2}\right)
+\cdots+
\left(\frac1{m-1}-\frac1m\right)>0.
$$
Since each pair is positive, we can remove the absolute value. Regrouping gives
$$
|x_m-x_n|
=
\frac1{n+1}
-\left(\frac1{n+2}-\frac1{n+3}\right)
-\cdots
-\left(\frac1{m-2}-\frac1{m-1}\right)
-\frac1m.
$$
Each parenthesized difference is positive, so
$$
|x_m-x_n|<\frac1{n+1}.
$$

**Case 2: $m-n$ is odd.**
If $m=n+1$, then
$$
|x_m-x_n|=\frac1m<\frac1{n+1}+\frac1m.
$$
Otherwise, separating off the last term and applying the triangle inequality gives
$$
|x_m-x_n|
\leq
\left|\frac1{n+1}-\frac1{n+2}+\cdots-\frac1{m-1}\right|
+\frac1m.
$$
The sum inside the absolute value has an even number of terms, so by Case 1,
$$
|x_m-x_n|<\frac1{n+1}+\frac1m.
$$

In either case, since $m,n\geq N$,
$$
|x_m-x_n|
<\frac1{n+1}+\frac1m
\leq\frac1N+\frac1N
=\frac2N<\epsilon.
$$

Therefore, for every $\epsilon>0$, there exists $N\in\mathbb N$ such that for all $m,n\geq N$, $|x_m-x_n|<\epsilon$. Thus, by the definition of Cauchy, $\{x_n\}_{n\in\mathbb N}$ is Cauchy. $\square$
