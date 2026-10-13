// The chat's math preprocessing: \(…\) and \[…\] become what remark-math reads
// (it knows only dollars), code is left alone, and display math whose line
// starts with `|x|` survives the table-line mask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { preprocessMarkdownMath } from "../../src/mdMath.ts";

test("\\(…\\) is inline math, \\[…\\] display math", () => {
  const out = preprocessMarkdownMath("a cache of \\(n\\) tokens:\n\n\\[ M = 2LHdn \\]\n\ndone");
  assert.match(out, /a cache of \$n\$ tokens/);
  assert.match(out, /\n\$\$\nM = 2LHdn\n\$\$\n/);
});

test("code keeps its backslashes", () => {
  const src = "use `\\(x\\)` literally\n\n```\nprint('\\[not math\\]')\n```";
  assert.equal(preprocessMarkdownMath(src), src);
});

test("display math starting with |x| comes back whole", () => {
  const out = preprocessMarkdownMath("bound:\n\n$$\n|x - y| \\le 1\n$$\n\nend, costs $5");
  assert.match(out, /\$\$\n\|x - y\| \\le 1\n\$\$/);
  assert.ok(!/[\u0001\u0002]/.test(out), "no mask left behind");
});
