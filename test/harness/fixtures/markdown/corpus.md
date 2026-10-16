# Markdown corpus

Every construct the app's markdown renderers must get right. Each section is one case of `test/harness/markdown.test.ts`; the `preview` scenario `markdown-corpus` shows this file in the viewer, in a chat reply and on the phone.

<!-- case: math-inline -->
## Inline math in every form

Dollars $x^2 + y_1$, parentheses \(\alpha_t = \beta\), a mid-line double $$\sum_i w_i$$ that stays inline, and a number $3.2$.

<!-- case: math-display -->
## Display math in every form

$$
\mathcal{L}(\theta) = -\sum_{t=1}^{T} \log p_\theta(x_t \mid x_{<t})
$$

$$ E = mc^2 $$

\[
\nabla_\theta J = \mathbb{E}\left[\nabla_\theta \log \pi_\theta(a \mid s)\, Q(s, a)\right]
\]

```math
\int_0^1 x^2 \, dx = \tfrac{1}{3}
```

<!-- case: math-aligned -->
## Multi-line environments

$$
\begin{aligned}
V^\pi(s) &= r(s, \pi(s)) + \gamma \sum_{s'} p(s' \mid s, \pi(s)) V^\pi(s') \\
         &= r^\pi + \gamma P^\pi V^\pi
\end{aligned}
$$

$$
\begin{bmatrix} P_{11} & \cdots & P_{1n} \\ \vdots & \ddots & \vdots \\ P_{n1} & \cdots & P_{nn} \end{bmatrix}
$$

<!-- case: math-table -->
## Math inside a table

| Symbol | Meaning | Shape |
|:-------|:-------:|------:|
| $x$ | input, $\|x\|_2 \le 1$ | $d \times 1$ |
| $\lvert x \rvert$ | absolute value $|x|$ | scalar |
| \(W\) | weights | $m \times d$ |
| $\sigma(z) = \dfrac{1}{1+e^{-z}}$ | sigmoid | scalar |
| budget | costs $5 and $10 | ~$4–8 |

<!-- case: math-list -->
## Math inside lists

1. **Direct solution:** solve the linear system
   $$
   (I-\gamma P^\pi)\mathbf V^\pi = \mathbf r^\pi.
   $$
   Equivalently, $\mathbf V^\pi=(I-\gamma P^\pi)^{-1}\mathbf r^\pi$.
2. **Iterate:** start at $\mathbf v_0 = \mathbf 0$ and update
    $$\mathbf v_{k+1}=\mathbf r^\pi+\gamma P^\pi\mathbf v_k$$
3. Done when $\|\mathbf v_{k+1} - \mathbf v_k\|_\infty < \epsilon$.

- A bullet with $a_i$
  - nested with \(b_j\)

<!-- case: math-blockquote -->
## Math inside a blockquote

> **Theorem.** For $0 \le \gamma < 1$ the matrix $I - \gamma P$ is invertible:
>
> $$
> (I - \gamma P)^{-1} = \sum_{k=0}^\infty \gamma^k P^k
> $$

<!-- case: math-heading -->
## The $\alpha$-stable case and \(\beta_1\)

<!-- case: currency -->
## Dollars as currency

The run cost $5 and the rerun $12.50, so about $17.50 in total.
Investor A put in $1 million at 4.79%; investor B: $2.5 million.
A price of $3 next to math $y = x$ still renders the math.

<!-- case: escaped-dollar -->
## Escaped dollars

A literal \$5 and \$x\$ stay text, and so does a lone $ sign.

<!-- case: math-underscores -->
## Underscores and asterisks inside math

$a_1 * b_2 * c_3$ and $x_{i}^{*} + y_{j}^{*}$ then *real emphasis* and __real bold__ after.

$$
f(x)_{\text{snake\_case}} = x * y * z
$$

<!-- case: math-error -->
## Invalid TeX shows its source

An undefined command $\notacommand{x}$ and a bad display block:

$$
\frac{1}{
$$

<!-- case: lists-nested -->
## Nested and mixed lists

1. First
   - unordered child
     1. ordered grandchild
     2. second grandchild
   - another child with code:

     ```python
     def f(x):
         return x ** 2  # $not math$
     ```
2. Second, with $\theta^*$
3. Third
   * star child
   + plus child

<!-- case: table-pipes -->
## Tables: pipes, alignment, empty cells

| Left | Center | Right | Code |
|:-----|:------:|------:|------|
| a    |        | 1     | `a\|b` |
|      | b      |       | `x = y \|\| z` |
| **bold** | *em* | 3 | `\|` |

<!-- case: table-wide -->
## A wide table

| c01 | c02 | c03 | c04 | c05 | c06 | c07 | c08 | c09 | c10 | c11 | c12 |
|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|
| 0.1234 | 0.2345 | 0.3456 | 0.4567 | 0.5678 | 0.6789 | 0.7890 | 0.8901 | 0.9012 | 1.0123 | 1.1234 | 1.2345 |

<!-- case: fences -->
## Fenced code

````markdown
```js
const tick = "`";
```
````

~~~bash
echo "$HOME" && echo $((1 + 2))
~~~

```python title="train.py"
loss = (y_hat - y) ** 2  # $5 per GPU-hour, $$ not math $$
```

```
no language, \(not math\) and $x$
```

<!-- case: inline-code -->
## Inline code with backticks

Use ``a `tick` inside`` and `` ` `` and `$PATH` and `\(x\)` literally.

<!-- case: tasks -->
## Task lists

- [ ] open task with $x$
- [x] done task
  - [ ] nested task

<!-- case: footnotes -->
## Footnotes

A claim with a footnote[^src] and another[^2].

[^src]: The source, with $\epsilon$.
[^2]: Second note.

<!-- case: autolinks -->
## Autolinks and URLs

See https://en.wikipedia.org/wiki/Markov_decision_process_(MDP) and <https://example.com/a_b_c> and www.example.com/x_y_z, snake_case_word and file_name_here.py stay plain.

<!-- case: images -->
## Images

![A relative plot](assets/plot.png)

![Spaces in the name](assets/my plot 1.png)

![Missing file](assets/does-not-exist.png)

A link with spaces: [the week 3 notes](notes/Week 3 notes.md).

<!-- case: wiki -->
## Wiki links

See [[Policy Iteration]], [[lectures/Value Iteration|the VI lecture]], [[Policy Iteration#Convergence]] and ![[diagram.png]].

<!-- case: html -->
## HTML, rendered but harmless

<details><summary>Proof sketch</summary>

By induction on $k$.

</details>

Line one<br>line two, x<sup>2</sup> and H<sub>2</sub>O, <kbd>Ctrl</kbd>+<kbd>K</kbd>.

<img src="x" onerror="window.__mdXss = 1">
<script>window.__mdXss = 1</script>
<iframe src="javascript:window.__mdXss = 1"></iframe>
<style>body { display: none }</style>
<a href="javascript:window.__mdXss = 1">raw js link</a> and <span onclick="window.__mdXss = 1" style="position:fixed;inset:0">overlay</span>.

A [markdown js link](javascript:window.__mdXss=1), a [data link](data:text/html;base64,PHNjcmlwdD4=) and ![a js image](javascript:alert(1)).

<!-- case: headings -->
## Heading Anchors Work

Jump to [the heading](#heading-anchors-work).

<!-- case: hr-setext -->
## Rules and setext headings

A setext heading
---

Text above a rule.

---

***

___

<!-- case: hard-breaks -->
## Hard line breaks

Two trailing spaces  
break here, a backslash\
breaks here.

<!-- case: long-line -->
## Very long lines

Averyveryverylongtokenwithoutanyspacesthatmustwrapratherthanpushthepagesidewaysforeveroverandoveragainaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and https://example.com/a/very/long/path/that/keeps/going/and/going/and/going/and/going/and/going/and/going/and/going?with=query&and=more

<!-- case: unicode -->
## Unicode, emoji and RTL

Emoji 👩‍🔬🧪✅, CJK 数学, combining é, math $α + β = γ$, RTL: שלום עולם and مرحبا بالعالم.

<!-- case: vault-currency-log -->
## From the vaults: a run log full of dollars

Session A: $0.65 + scratch $2.32 = **$2.97**; projection ~$6, lands ~$20.72 / $80 cap.
One box (~$1.29/hr), weights collapse to $\{-\gamma, 0, +\gamma\}$ with $\gamma=0.01598$.

| Phase | Cost |
|-------|------|
| 1. Image JEPA | ~$4–8 |
| **Total** | **~$20–35** |

<!-- case: vault-list-display -->
## From the vaults: displays inside list items

- Why rename functions to variables?
  * **Answer**: with a loss $L$ of $a$, of $z$, of $W$:
    $$\frac{dL}{dW} = L'(\sigma(z(W))) \cdot \sigma'(z(W)) \cdot z'(W)$$
    Name every step instead:
    $$z = Wx + b$$
    $$a = \sigma(z)$$
    so each derivative only sees its own input, like $W$ or $b$.

1. **Evaluate partially:** for $j=0,\ldots,K$, update every state $s$:
   $$
   V'(s)\leftarrow r(s,\pi(s))
   +\gamma\sum_{s'}p(s'\mid s,\pi(s))V(s').
   $$
   After each sweep, set $V\leftarrow V'$.
2. **Improve:** $\pi\leftarrow\operatorname{greedy}(V)$.

<!-- case: vault-table-tuples -->
## From the vaults: tuples and dimensions in a table

| Pair | Dims | Shape |
|------|------|-------|
| 0 | $(0, 1)$ | $d \times 1$ |
| 1 | $(2, 3)$ | $[0, 1)$ |
