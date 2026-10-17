// Seeds a preview box's inbox (board/INBOX.md) through the real, validated
// send: a lecture PDF's pages, a Cauchy problem set, a generated phase plot
// (SVG), a value-iteration widget (raw TS with a γ slider), and one entry
// still "being made".
//
//   npx tsx board/preview/seed-inbox.ts <vault dir> [http://127.0.0.1:7432]
//
// The files are written into the vault first (the send only takes vault
// paths), then sent; a refusal is printed and the script fails.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePdf } from "../../server/test/pdfgen";

const vault = process.argv[2];
const box = process.argv[3] ?? "http://127.0.0.1:7432";
if (!vault) throw new Error("usage: seed-inbox.ts <vault dir> [box url]");

// ---------------------------------------------------------------- 1. a lecture PDF

const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);
function page(n: number, title: string, body: string[], draw = ""): string {
  let s = `0.12 0.36 0.84 rg 0 762 612 30 re f 1 1 1 rg BT /F2 11 Tf 40 773 Td (IEMS 469  ·  Dynamic Programming  ·  Lecture 7) Tj ET\n0 0 0 rg`;
  s += `\nBT /F2 22 Tf 56 712 Td (${esc(title)}) Tj ET\n0.75 G 0.6 w 56 700 m 556 700 l S 0 G\n`;
  body.forEach((l, i) => {
    const bullet = l.startsWith("- ");
    s += `BT /F1 13 Tf ${bullet ? 74 : 56} ${668 - i * 21} Td (${esc(bullet ? "·  " + l.slice(2) : l)}) Tj ET\n`;
  });
  s += draw;
  s += `0.5 g BT /F1 9 Tf 290 30 Td (${n}) Tj ET\n`;
  return s;
}
// A small MDP diagram: states as circles (Bézier approximations), arrows with probabilities.
function circle(cx: number, cy: number, r: number): string {
  const k = 0.5523 * r;
  return `${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c S\n`;
}
const diagram =
  "1.2 w 0.12 0.36 0.84 RG\n" +
  circle(160, 300, 34) + circle(306, 300, 34) + circle(452, 300, 34) +
  "0 0 0 RG 194 300 m 266 300 l S 266 300 m 258 305 l 258 295 l h f\n340 300 m 412 300 l S 412 300 m 404 305 l 404 295 l h f\n" +
  "306 334 m 306 380 l 160 380 l 160 334 l S 160 334 m 155 342 l 165 342 l h f\n" +
  "BT /F2 14 Tf 150 295 Td (s1) Tj ET BT /F2 14 Tf 296 295 Td (s2) Tj ET BT /F2 14 Tf 442 295 Td (s3) Tj ET\n" +
  "BT /F1 11 Tf 214 308 Td (a: p = 0.8) Tj ET BT /F1 11 Tf 360 308 Td (a: p = 0.8) Tj ET BT /F1 11 Tf 200 388 Td (b: p = 0.2, r = -1) Tj ET\n";
const pdf = makePdf([
  page(1, "Lecture 7: Value iteration", ["Today", "- Bellman optimality equation", "- Value iteration and its convergence", "- Policy extraction", "- Discounting and the contraction argument"]),
  page(2, "Markov decision processes", ["An MDP is (S, A, P, r, gamma):", "- S, A finite sets of states and actions", "- P(s' | s, a) transition probabilities", "- r(s, a) expected one-step reward", "- 0 <= gamma < 1 the discount factor", "", "A policy pi maps states to actions; its value is", "V_pi(s) = E[ sum_t gamma^t r(s_t, a_t) | s_0 = s ]."], diagram),
  page(3, "The Bellman optimality equation", ["The optimal value function satisfies", "", "V*(s) = max_a { r(s, a) + gamma sum_s' P(s' | s, a) V*(s') }.", "", "Write T for the right-hand side as an operator on R^|S|:", "V* is a fixed point, V* = T V*.", "", "- T is monotone: V <= W implies TV <= TW", "- T(V + c 1) = TV + gamma c 1 for every constant c"]),
  page(4, "Value iteration", ["Start from any V_0 (e.g. 0) and repeat", "", "V_{k+1} = T V_k.", "", "Stop when || V_{k+1} - V_k ||_inf < eps (1 - gamma) / (2 gamma);", "then the greedy policy is eps-optimal.", "", "- Each sweep costs O(|S|^2 |A|)", "- Asynchronous (Gauss-Seidel) sweeps converge too"]),
  page(5, "Why it converges: a contraction", ["For any V, W:", "", "|| TV - TW ||_inf <= gamma || V - W ||_inf.", "", "So T is a gamma-contraction on (R^|S|, sup norm), and by Banach's", "fixed point theorem V_k -> V* geometrically:", "", "|| V_k - V* ||_inf <= gamma^k || V_0 - V* ||_inf.", "", "Note: (V_k) is a Cauchy sequence - see problem set 4."]),
  page(6, "Policy extraction", ["Given V, act greedily:", "", "pi(s) = argmax_a { r(s, a) + gamma sum_s' P(s' | s, a) V(s') }.", "", "- If V = V*, the greedy policy is optimal", "- Policy iteration alternates evaluation and improvement", "- Next lecture: policy iteration and linear programming"]),
]);
mkdirSync(join(vault, "IEMS 469"), { recursive: true });
writeFileSync(join(vault, "IEMS 469", "lec7.pdf"), pdf);

// ---------------------------------------------------------------- 3. the phase plot, generated

function phasePlot(): string {
  const W = 760, H = 480, L = 70, R = 24, T = 34, B = 56;
  const t0 = 0, t1 = 6, x0 = -0.4, x1 = 1.5;
  const X = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const Y = (x: number) => T + (1 - (x - x0) / (x1 - x0)) * (H - T - B);
  const f = (x: number) => x * (1 - x);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif">`);
  out.push(`<rect width="${W}" height="${H}" fill="#fff"/>`);
  // Grid and axes.
  for (let t = 0; t <= 6; t++) out.push(`<line x1="${X(t)}" y1="${Y(x0)}" x2="${X(t)}" y2="${Y(x1)}" stroke="#eee"/><text x="${X(t)}" y="${H - B + 20}" font-size="13" text-anchor="middle" fill="#444">${t}</text>`);
  for (let x = -0.25; x <= 1.5001; x += 0.25) out.push(`<line x1="${X(t0)}" y1="${Y(x)}" x2="${X(t1)}" y2="${Y(x)}" stroke="#eee"/><text x="${L - 10}" y="${Y(x) + 4}" font-size="13" text-anchor="end" fill="#444">${x.toFixed(2)}</text>`);
  out.push(`<line x1="${X(t0)}" y1="${Y(0)}" x2="${X(t1)}" y2="${Y(0)}" stroke="#999"/>`);
  out.push(`<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="none" stroke="#bbb"/>`);
  // Slope field.
  const seg: string[] = [];
  for (let t = 0.25; t < 6; t += 0.5)
    for (let x = -0.3; x <= 1.45; x += 0.125) {
      const dx = 1, dy = f(x);
      const sx = (W - L - R) / (t1 - t0), sy = (H - T - B) / (x1 - x0);
      const vx = dx * sx, vy = -dy * sy, n = Math.hypot(vx, vy), len = 9;
      seg.push(`M${(X(t) - (vx / n) * len).toFixed(1)} ${(Y(x) - (vy / n) * len).toFixed(1)}L${(X(t) + (vx / n) * len).toFixed(1)} ${(Y(x) + (vy / n) * len).toFixed(1)}`);
    }
  out.push(`<path d="${seg.join("")}" stroke="#9aa6b8" stroke-width="1.3" stroke-linecap="round"/>`);
  // Equilibria.
  out.push(`<line x1="${X(t0)}" y1="${Y(1)}" x2="${X(t1)}" y2="${Y(1)}" stroke="#1e8a4c" stroke-width="2" stroke-dasharray="6 5"/>`);
  out.push(`<line x1="${X(t0)}" y1="${Y(0)}" x2="${X(t1)}" y2="${Y(0)}" stroke="#d23a2c" stroke-width="2" stroke-dasharray="6 5"/>`);
  // Solutions x(t) = 1 / (1 + C e^{-t}), C = (1 - x0)/x0, integrated with RK4 (also for x0 < 0, until it leaves the window).
  const colors = ["#1f5bd6", "#2a6be0", "#3b7be8", "#5a8ef0", "#8a4bd6", "#a05ad0"];
  [-0.05, 0.02, 0.1, 0.3, 1.3, 1.45].forEach((xs, i) => {
    let x = xs, t = 0;
    const h = 0.02;
    const pts: string[] = [`M${X(t).toFixed(1)} ${Y(x).toFixed(1)}`];
    while (t < t1 && x > x0 - 0.05 && x < x1 + 0.05) {
      const k1 = f(x), k2 = f(x + (h / 2) * k1), k3 = f(x + (h / 2) * k2), k4 = f(x + h * k3);
      x += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      t += h;
      pts.push(`L${X(t).toFixed(1)} ${Y(Math.max(x0, Math.min(x1, x))).toFixed(1)}`);
    }
    out.push(`<path d="${pts.join("")}" fill="none" stroke="${colors[i]}" stroke-width="2.4" stroke-linecap="round"/>`);
  });
  // Labels.
  out.push(`<text x="${X(t1) - 6}" y="${Y(1) - 8}" font-size="14" text-anchor="end" fill="#1e8a4c">x = 1 (stable)</text>`);
  out.push(`<text x="${X(t1) - 6}" y="${Y(0) + 20}" font-size="14" text-anchor="end" fill="#d23a2c">x = 0 (unstable)</text>`);
  out.push(`<text x="${(L + W - R) / 2}" y="${H - 14}" font-size="14" text-anchor="middle" fill="#222">t</text>`);
  out.push(`<text x="18" y="${(T + H - B) / 2}" font-size="14" text-anchor="middle" fill="#222" transform="rotate(-90 18 ${(T + H - B) / 2})">x(t)</text>`);
  out.push(`<text x="${L}" y="22" font-size="16" font-weight="bold" fill="#111">x′ = x(1 − x): slope field and solutions</text>`);
  out.push(`</svg>`);
  return out.join("\n");
}

// ---------------------------------------------------------------- 4. the widget, raw TS

const WIDGET = `// Value iteration on a 4×4 grid world: +1 at the top-right goal, −1 in the pit,
// a small cost per step; moves succeed with probability 0.8 and slip sideways
// otherwise. The slider sets γ; values and the greedy policy update live.
type Api = { size(): { w: number; h: number }; onResize(fn: () => void): void; theme: { ink: string; accent: string; font: string } };

const N = 4;
const GOAL = [0, 3], PIT = [1, 3], WALL = [1, 1];
const STEP = -0.04;
const MOVES: [number, number][] = [[-1, 0], [0, 1], [1, 0], [0, -1]]; // up, right, down, left
const ARROWS = ["↑", "→", "↓", "←"];

const isTerm = (r: number, c: number) => (r === GOAL[0] && c === GOAL[1]) || (r === PIT[0] && c === PIT[1]);
const isWall = (r: number, c: number) => r === WALL[0] && c === WALL[1];

function step(r: number, c: number, a: number): [number, number] {
  const nr = r + MOVES[a]![0], nc = c + MOVES[a]![1];
  if (nr < 0 || nr >= N || nc < 0 || nc >= N || isWall(nr, nc)) return [r, c];
  return [nr, nc];
}

function q(V: number[][], r: number, c: number, a: number, gamma: number): number {
  let s = 0;
  for (const [p, b] of [[0.8, a], [0.1, (a + 1) % 4], [0.1, (a + 3) % 4]] as [number, number][]) {
    const [nr, nc] = step(r, c, b);
    s += p * (STEP + gamma * V[nr]![nc]!);
  }
  return s;
}

function solve(gamma: number): { V: number[][]; pi: number[][]; iters: number } {
  let V = Array.from({ length: N }, () => new Array(N).fill(0));
  V[GOAL[0]]![GOAL[1]] = 1;
  V[PIT[0]]![PIT[1]] = -1;
  let iters = 0;
  for (; iters < 1000; iters++) {
    const W = V.map((row) => row.slice());
    let delta = 0;
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        if (isTerm(r, c) || isWall(r, c)) continue;
        W[r]![c] = Math.max(...[0, 1, 2, 3].map((a) => q(V, r, c, a, gamma)));
        delta = Math.max(delta, Math.abs(W[r]![c]! - V[r]![c]!));
      }
    V = W;
    if (delta < 1e-6) break;
  }
  const pi = V.map((row, r) => row.map((_, c) => [0, 1, 2, 3].reduce((b, a) => (q(V, r, c, a, gamma) > q(V, r, c, b, gamma) ? a : b), 0)));
  return { V, pi, iters: iters + 1 };
}

function color(v: number): string {
  // −1 red … 0 white … +1 blue
  const t = Math.max(-1, Math.min(1, v));
  return t >= 0 ? \`rgb(\${Math.round(255 - 180 * t)}, \${Math.round(255 - 120 * t)}, 255)\` : \`rgb(255, \${Math.round(255 + 170 * t)}, \${Math.round(255 + 170 * t)})\`;
}

export function mount(el: HTMLElement, api: Api): void {
  el.style.font = \`15px \${api.theme.font}\`;
  el.style.color = api.theme.ink;
  el.innerHTML = \`
    <div style="display:flex;align-items:center;gap:12px;padding:12px 16px 6px">
      <b style="font-size:16px">Value iteration</b>
      <span style="flex:1"></span>
      <label for="g">γ</label>
      <input id="g" type="range" min="0.5" max="0.99" step="0.01" value="0.9" style="width:180px;accent-color:\${api.theme.accent}">
      <span id="gv" style="width:36px;text-align:right;font-variant-numeric:tabular-nums">0.90</span>
    </div>
    <canvas id="c"></canvas>
    <div id="note" style="padding:0 16px;color:#666;font-size:13px"></div>\`;
  const canvas = el.querySelector("#c") as HTMLCanvasElement;
  const slider = el.querySelector("#g") as HTMLInputElement;
  const draw = () => {
    const gamma = Number(slider.value);
    (el.querySelector("#gv") as HTMLElement).textContent = gamma.toFixed(2);
    const { V, pi, iters } = solve(gamma);
    const { w, h } = api.size();
    const side = Math.min(w - 32, h - 90);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = side * dpr;
    canvas.height = side * dpr;
    canvas.style.cssText = \`display:block;margin:4px auto;width:\${side}px;height:\${side}px\`;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const cell = side / N;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const x = c * cell, y = r * cell;
        ctx.fillStyle = isWall(r, c) ? "#555" : color(V[r]![c]!);
        ctx.fillRect(x, y, cell, cell);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, cell, cell);
        if (isWall(r, c)) continue;
        ctx.fillStyle = "#111";
        ctx.font = \`600 \${Math.round(cell * 0.2)}px \${api.theme.font}\`;
        ctx.fillText(V[r]![c]!.toFixed(2), x + cell / 2, y + cell * (isTerm(r, c) ? 0.5 : 0.62));
        if (!isTerm(r, c)) {
          ctx.font = \`\${Math.round(cell * 0.24)}px \${api.theme.font}\`;
          ctx.fillStyle = "#333";
          ctx.fillText(ARROWS[pi[r]![c]!]!, x + cell / 2, y + cell * 0.3);
        }
      }
    (el.querySelector("#note") as HTMLElement).textContent = \`Converged in \${iters} sweeps (‖Vₖ₊₁ − Vₖ‖∞ < 10⁻⁶). Step cost \${STEP}, slip 0.1 each side.\`;
  };
  slider.addEventListener("input", draw);
  api.onResize(draw);
  draw();
}
`;

// ---------------------------------------------------------------- send

async function send(body: unknown): Promise<string> {
  const r = await fetch(`${box}/api/v1/inbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (!j.ok) throw new Error(`refused: ${JSON.stringify(j.refusals ?? j)}`);
  return j.id;
}

const made = join(vault, "boards", ".inbox", "_seed");
mkdirSync(made, { recursive: true });
writeFileSync(join(made, "phase-plot.svg"), phasePlot());
writeFileSync(join(made, "value-iteration.ts"), WIDGET);

const ids: string[] = [];
ids.push(await send({ title: "IEMS 469 — Lecture 7, pp. 3–5", note: "The Bellman equation, value iteration and the contraction argument.", parts: [{ kind: "pdf", path: "IEMS 469/lec7.pdf", pages: [3, 4, 5], label: "Lecture 7" }] }));
const problems = [
  "Let $x_n=\\sum_{k=1}^{n} \\frac{(-1)^{k+1}}{k}$. Show that $(x_n)$ is Cauchy.\n\n*Hint.* For $m>n$,\n\n$$|x_m-x_n| \\le \\frac{1}{n+1}.$$",
  "Show that every convergent sequence in $\\mathbb{R}$ is Cauchy: if $x_n \\to L$, then for every $\\varepsilon>0$ there is $N$ with $|x_m-x_n|<\\varepsilon$ for all $m,n\\ge N$.",
  "Let $H_n=\\sum_{k=1}^{n}\\frac1k$. Prove that $(H_n)$ is **not** Cauchy by showing\n\n$$H_{2n}-H_n \\ge \\tfrac12 \\quad\\text{for all } n.$$",
  "Suppose $|x_{n+1}-x_n|\\le r^n$ for all $n$, with $0<r<1$. Prove that $(x_n)$ is Cauchy, with\n\n$$|x_m-x_n| \\le \\frac{r^n}{1-r} \\quad (m>n).$$\n\nCompare with value iteration: $\\|V_{k+1}-V_k\\|_\\infty \\le \\gamma^k\\|V_1-V_0\\|_\\infty$.",
  "Let $x_1=1$ and $x_{n+1}=\\dfrac{x_n}{2}+\\dfrac{1}{x_n}$. Show that $(x_n)$ is a Cauchy sequence of rationals with no limit in $\\mathbb{Q}$, so $\\mathbb{Q}$ is not complete. (*What is its limit in* $\\mathbb{R}$*?*)",
];
ids.push(await send({ title: "Cauchy sequences — problem set", note: "Five problems, easiest first.", parts: problems.map((markdown, i) => ({ kind: "math", label: `Problem ${i + 1}`, markdown })) }));
ids.push(await send({ title: "Phase plot of x′ = x(1−x)", note: "Slope field, six solutions, the two equilibria.", parts: [{ kind: "image", path: "boards/.inbox/_seed/phase-plot.svg", alt: "Phase plot of x' = x(1-x): slope field over t in [0, 6], solutions from six starting points, x = 0 unstable and x = 1 stable" }] }));
ids.push(await send({ title: "Value iteration on a 4×4 grid", note: "Slide γ to see the values and the greedy policy change.", parts: [{ kind: "widget", path: "boards/.inbox/_seed/value-iteration.ts", alt: "Value iteration on a 4x4 grid world; slider for gamma", layout: { w: 560, h: 620 } }] }));

// 5. One still being made (written directly: there is no route that starts a make; BoardMake does).
const mk = new Date();
const day = `${mk.getFullYear()}-${String(mk.getMonth() + 1).padStart(2, "0")}-${String(mk.getDate()).padStart(2, "0")}`;
const makingId = `${day}-practice-exam-markov-chains`;
mkdirSync(join(vault, "boards", ".inbox", makingId), { recursive: true });
writeFileSync(
  join(vault, "boards", ".inbox", makingId, "entry.json"),
  JSON.stringify({ id: makingId, title: "Practice exam: Markov chains", note: "", createdAt: Date.now(), parts: [], status: "unread", making: { request: "Six exam-style questions on Markov chains, with a transition diagram", startedAt: Date.now() } }, null, 1),
);
ids.push(makingId);
console.log(ids.join("\n"));
