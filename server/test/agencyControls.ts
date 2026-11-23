// The controls on screen, read from the UI source (server/test/agencyCoverage.test.ts): every button, input, select,
// textarea and clickable element, with the offer it is reached through (`data-offer="<part>.<action>"`) or its
// exemption (`data-offer-exempt="<why>"`), or neither.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export type Control = { file: string; tag: string; offer: string | null; exempt: string | null };

// A tag runs to its first ">" that is not an arrow's "=>" (an onClick={() => …} inside it).
const CTRL = /<(?:button|input|select|textarea)\b(?:=>|[^>])*>|<[A-Za-z][\w.]*\b(?=(?:=>|[^>])*\bonClick=)(?:=>|[^>])*>/gs;

/** The UI source files whose controls count: src/*.tsx, everything under src/plugins, phone/src/*.tsx. */
export function uiControlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(join(root, d))) {
      const p = `${d}/${f}`;
      if (statSync(join(root, p)).isDirectory()) walk(p);
      else if (/\.tsx$/.test(f) && !/\.test\.tsx$/.test(f)) out.push(p);
    }
  };
  for (const f of readdirSync(join(root, "src"))) if (f.endsWith(".tsx")) out.push(`src/${f}`);
  walk("src/plugins");
  if (existsSync(join(root, "phone", "src"))) for (const f of readdirSync(join(root, "phone", "src"))) if (f.endsWith(".tsx")) out.push(`phone/src/${f}`);
  return out.sort();
}

export function controlsIn(root: string, file: string): Control[] {
  const s = readFileSync(join(root, file), "utf8");
  return (s.match(CTRL) ?? []).map((tag) => ({
    file,
    tag: tag.replace(/\s+/g, " ").slice(0, 120),
    offer: /\bdata-offer="([^"]+)"/.exec(tag)?.[1] ?? null,
    exempt: /\bdata-offer-exempt="([^"]+)"/.exec(tag)?.[1] ?? null,
  }));
}
