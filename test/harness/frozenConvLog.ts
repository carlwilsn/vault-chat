// Test-only old SERVER reader: every bundled local module comes from this exact git tree.
// No source substitution, production monkeypatch, live server, provider or credentials.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ConvLog } from "../../server/convlog/log.ts";

export const OLD_SERVER = "46bb33304233b64739df23fb5b0d520706d8e050";
const root = fileURLToPath(new URL("../../", import.meta.url));
let frozen: Promise<typeof ConvLog> | undefined;
export function frozenConvLog(): Promise<typeof ConvLog> {
  return frozen ??= (async () => {
    const result = await build({
      entryPoints: ["server/convlog/log.ts"], bundle: true, platform: "node", format: "cjs", write: false,
      plugins: [{ name: "frozen-server-git-tree", setup(b) {
        b.onResolve({ filter: /.*/ }, ({ path, importer }) => {
          if (path.startsWith("node:")) return { path, external: true };
          if (importer && !path.startsWith(".")) throw new Error(`Unexpected old-server package: ${path}`);
          const base = importer ? posix.normalize(posix.join(posix.dirname(importer), path)) : path;
          for (const name of [base, `${base}.ts`, `${base}.mjs`]) {
            try {
              execFileSync("git", ["cat-file", "-e", `${OLD_SERVER}:${name}`], { cwd: root, stdio: "ignore" });
              return { path: name, namespace: "frozen" };
            } catch { /* extensionless import: try the next exact git path */ }
          }
          throw new Error(`Missing frozen module: ${base}`);
        });
        b.onLoad({ filter: /.*/, namespace: "frozen" }, ({ path }) => ({
          contents: execFileSync("git", ["show", `${OLD_SERVER}:${path}`], { cwd: root, encoding: "utf8" }),
          loader: path.endsWith(".ts") ? "ts" : "js",
        }));
      } }],
    });
    const dir = mkdtempSync(join(tmpdir(), "vc-old-server-"));
    try {
      const file = join(dir, "server.cjs");
      writeFileSync(file, result.outputFiles![0]!.contents);
      return createRequire(import.meta.url)(file).ConvLog as typeof ConvLog;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  })();
}
