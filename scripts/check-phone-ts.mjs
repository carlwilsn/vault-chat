// Typechecks the TypeScript app source embedded in src-tauri/assets/phone.html
// (the <script id="phone-ts" type="text/typescript"> block).
// Usage:  node scripts/check-phone-ts.mjs
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const html = readFileSync("src-tauri/assets/phone.html", "utf8");
const m = html.match(/<script id="phone-ts" type="text\/typescript">\r?\n([\s\S]*?)\r?\n<\/script>/);
if (!m) throw new Error("phone-ts block not found in phone.html");

const dir = mkdtempSync(join(tmpdir(), "phone-ts-"));
writeFileSync(join(dir, "phone.ts"), m[1]);
writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "bundler",
        noEmit: true,
        skipLibCheck: true,
        types: [],
        // Lenient on purpose: the source predates TS. Interfaces + annotations
        // are checked for real; unannotated code stays implicit-any. Tighten
        // incrementally as more of the file gains types.
        strict: false,
        noImplicitAny: false,
      },
      files: ["phone.ts"],
    },
    null,
    2,
  ),
);
execSync(`npx tsc -p "${join(dir, "tsconfig.json")}"`, { stdio: "inherit" });
console.log("phone.ts typechecks clean (" + m[1].split("\n").length + " lines)");
