// Math the voice says: LaTeX → MathML (KaTeX) → English (Speech Rule Engine, ClearSpeak), on expressions from
// Carl's courses (Real Analysis, Physics, IEMS 469). The voice hears the words; the chat keeps the LaTeX.
import { describe, it, expect, beforeAll } from "vitest";
import { latexToSpeech, speakMath, speechReady } from "../speakMath";

beforeAll(async () => {
  expect(await speechReady()).toBe(true);
});

const said = (tex: string) => latexToSpeech(tex);

describe("one formula, ClearSpeak", () => {
  const cases: [string, string][] = [
    // Real Analysis
    [String.raw`|x_m - x_n| < \epsilon`, "the absolute value of x sub m minus x sub n is less than epsilon"],
    [String.raw`\sum_{k=1}^n \frac{(-1)^k}{k}`, "the sum from k equals 1 to n of the fraction with numerator open paren negative 1 close paren to the k-th power and denominator k"],
    [String.raw`\lim_{n\to\infty} a_n = L`, "the limit as n approaches infinity of a sub n equals L"],
    [String.raw`\liminf_{n\to\infty} a_n`, "the limit inferior as n approaches infinity of a sub n"],
    [String.raw`\sup_{x\in S} f(x)`, "supremum over x in S of f of x"],
    [String.raw`\inf S`, "infimum of S"],
    [String.raw`x_n \to L`, "x sub n goes to L"],
    [String.raw`\forall \epsilon > 0, \exists N \in \mathbb{N}`, "for all epsilon is greater than 0 comma there exists N is in the natural numbers"],
    [String.raw`\sqrt{x^2+1}`, "the square root of x squared plus 1"],
    [String.raw`\int_0^1 x^2\,dx`, "the integral from 0 to 1 of x squared d x"],
    [String.raw`a_{n+1} \le a_n`, "a sub n plus 1 is less than or equal to a sub n"],
    [String.raw`\mathbb{R}`, "the real numbers"],
    // Physics
    [String.raw`\Delta U = q V`, "Delta U equals q V"],
    [String.raw`\frac{1}{4\pi\epsilon_0}\frac{q}{r^2}`, "1 over 4 pi epsilon sub 0 the fraction with numerator q and denominator r squared"],
    [String.raw`k = \frac{1}{4\pi\varepsilon_0}`, "k equals 1 over 4 pi epsilon sub 0"],
    [String.raw`5\,\mathrm{mV}`, "5 millivolts"],
    [String.raw`3\ \text{C}`, "3 coulombs"],
    [String.raw`2\,\mu\mathrm{C}`, "2 microcoulombs"],
    [String.raw`E = 8.99\times 10^9\,\mathrm{N\,m^2/C^2}`, "E equals 8.99 times 10 to the ninth power Newtons square meters divided by coulombs to the second power"],
    [String.raw`\vec{F} = m\vec{a}`, "vector F equals m vector a"],
    [String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, "the 2 by 2 matrix Row 1: 1 2 Row 2: 3 4"],
    // IEMS 469
    [String.raw`V^*(s) = \max_a \sum_{s'} P(s'|s,a)[R + \gamma V^*(s')]`, "V star of s equals max over a of the sum over s prime of P of s prime given s comma a times open bracket R plus gamma V star of s prime close bracket"],
    [String.raw`Q(s,a)`, "Q of s comma a"],
    [String.raw`\gamma`, "gamma"],
    [String.raw`\pi^*(s) = \arg\max_a Q^*(s,a)`, "pi star of s equals the arg max over a of Q star of s comma a"],
    [String.raw`\mathbb{E}[G_t \mid S_t = s]`, "the expected value of open bracket G sub t given S sub t equals s close bracket"],
    [String.raw`\log_2 n`, "the log base 2 of n"],
  ];
  for (const [tex, words] of cases) it(tex, () => expect(said(tex)).toBe(words));
});

describe("math in a text: delimited, bare and plain-text, everything else as it was", () => {
  it("inline $…$ and display $$…$$ become words; prose stays", () => {
    expect(speakMath(String.raw`Cauchy: for every $\epsilon > 0$ there is $N$ with $|x_m - x_n| < \epsilon$ for $m, n > N$.`)).toBe(
      "Cauchy: for every epsilon is greater than 0 there is N with the absolute value of x sub m minus x sub n is less than epsilon for m comma n is greater than N.",
    );
    expect(speakMath(String.raw`The answer is \(x = 2\) and \[y^2 = 4.\]`)).toBe("The answer is x equals 2 and y squared equals 4.");
  });

  it("bare LaTeX in prose", () => {
    expect(speakMath(String.raw`Use \frac{1}{4\pi\epsilon_0}\frac{q}{r^2} for the field.`)).toBe(
      "Use 1 over 4 pi epsilon sub 0 the fraction with numerator q and denominator r squared for the field.",
    );
    expect(speakMath(String.raw`with discount \gamma = 0.9.`)).toBe("with discount gamma equals 0.9.");
  });

  it("plain-text math without $: x^2, a_n, symbols, f(x)", () => {
    expect(speakMath("So x^2 + y^2 = 1 and a_n converges.")).toBe("So x squared plus y squared equals 1 and a sub n converges.");
    expect(speakMath("Then ΔU = qV, and ε → 0.")).toBe("Then Delta U equals q V, and epsilon goes to 0.");
    expect(speakMath("Q(s,a) is the action value, and x_n -> L.")).toBe("Q of s comma a is the action value, and x sub n goes to L.");
  });

  it("units after a number: 5 mV, 3 C, 2.5 kΩ", () => {
    expect(speakMath("The potential drops by 5 mV and the charge is 3 C.")).toBe("The potential drops by 5 millivolts and the charge is 3 coulombs.");
    expect(speakMath("A 2.5 kΩ resistor.")).toBe("A 2.5 kilohms resistor.");
  });

  it("leaves money, paths, links and plain talk alone", () => {
    for (const t of [
      "It costs $5 and $10 today.",
      "I'll check notes/week_3.md and http://x.com/a_b then.",
      "Is 2(b) the one from Tuesday? Yes, part a is done.",
      "I wrote file(s) to the inbox.",
      "Saved week_3.md; the setting is `max_len` and voice_id is set.",
      'Replaced "We use a detector that..." → "We use YOLOv8..."',
    ])
      expect(speakMath(t)).toBe(t);
  });

  it("never a backslash, a brace or a dollar aloud, even for LaTeX KaTeX can't parse", () => {
    const out = speakMath(String.raw`Try $\foo{x}^2 + \frac{a}{b}$ now.`);
    expect(out).not.toMatch(/[\\{}$]/);
    expect(out).toContain("a over b");
  });
});
