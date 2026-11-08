// Finding bubblewrap, which is what the sandbox is built out of.
//
// It lived in pi's installer; the sandbox outlived pi (server/engine/sandbox.ts),
// so this came with it.
import { readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export function findBwrap(): string | null {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const env = process.env.VC_BWRAP;
  if (env) return isFile(env) ? env : null;
  if (process.platform !== "linux") return null;
  for (const d of (process.env.PATH ?? "").split(delimiter)) if (d && isFile(join(d, "bwrap"))) return join(d, "bwrap");
  for (const d of ["/run/current-system/sw/bin", "/usr/bin", "/bin"]) if (isFile(join(d, "bwrap"))) return join(d, "bwrap");
  try {
    const hits = readdirSync("/nix/store")
      .filter((n) => /-bubblewrap-\d[\d.]*$/.test(n))
      .map((n) => ({ p: join("/nix/store", n, "bin", "bwrap"), v: (/-bubblewrap-([\d.]+)$/.exec(n)?.[1] ?? "0").split(".").map(Number) }))
      .filter((h) => isFile(h.p))
      .sort((a, b) => a.v.map((x, i) => x - (b.v[i] ?? 0)).find((d) => d !== 0) ?? 0);
    return hits.length ? hits[hits.length - 1]!.p : null;
  } catch {
    return null;
  }
}
