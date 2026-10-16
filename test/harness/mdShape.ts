// A compact, readable shape of rendered markdown HTML for the markdown tests:
// KaTeX output collapses to ⟦tex⟧ (display: ⟦⟦tex⟧⟧, a parse error: ⟦!tex⟧),
// React's image preloads are dropped, everything else stays HTML.
import { fromHtml } from "hast-util-from-html";

type N = { type: string; tagName?: string; value?: string; properties?: Record<string, any>; children?: N[] };

const VOID = new Set(["br", "hr", "img", "input"]);

function cls(n: N): string[] {
  const c = n.properties?.className;
  return Array.isArray(c) ? c.map(String) : [];
}

function texOf(n: N): string {
  let out = "";
  const walk = (x: N) => {
    if (x.type === "element" && x.tagName === "annotation") {
      out = (x.children ?? []).map((t) => t.value ?? "").join("");
      return;
    }
    x.children?.forEach(walk);
  };
  walk(n);
  return out;
}

function textOf(n: N): string {
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(textOf).join("");
}

function attrs(n: N): string {
  const p = n.properties ?? {};
  const keep = ["href", "src", "alt", "id", "className", "dir", "align", "type", "checked", "disabled", "start", "dataWiki", "style", "title", "rel", "target", "dataHref"];
  const parts: string[] = [];
  for (const k of Object.keys(p).sort()) {
    if (!keep.includes(k) && !/^on/i.test(k)) continue;
    let v = p[k];
    if (k === "className") {
      v = (v as string[]).filter((c) => !c.startsWith("hljs")).join(" ");
      if (!v) continue;
    }
    parts.push(v === true ? k : `${k}="${String(v)}"`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

export function shape(html: string): string {
  const tree = fromHtml(html, { fragment: true }) as unknown as N;
  const out: string[] = [];
  const walk = (n: N) => {
    if (n.type === "text") {
      out.push(n.value ?? "");
      return;
    }
    if (n.type !== "element") {
      n.children?.forEach(walk);
      return;
    }
    const c = cls(n);
    if (n.tagName === "link") return;
    if (c.includes("katex-error")) {
      out.push(`⟦!${textOf(n)}⟧`);
      return;
    }
    if (c.includes("katex-display")) {
      out.push(`⟦⟦${texOf(n)}⟧⟧`);
      return;
    }
    if (c.includes("katex")) {
      out.push(`⟦${texOf(n)}⟧`);
      return;
    }
    if (n.tagName === "span" && c.some((x) => x.startsWith("hljs"))) {
      n.children?.forEach(walk);
      return;
    }
    out.push(`<${n.tagName}${attrs(n)}>`);
    if (VOID.has(n.tagName!)) return;
    n.children?.forEach(walk);
    out.push(`</${n.tagName}>`);
  };
  walk(tree);
  return out.join("");
}
