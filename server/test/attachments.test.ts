// A file Carl attaches from outside the vault (a PDF from his laptop's
// Downloads): its bytes come to the box (POST /api/v2/attachment), are kept in
// the vault's hidden attachments area (out of git), and the message names it by
// that path — the agent is told where it is on the box, never a path on the
// laptop, and reads it (PdfRead here). End to end: the real bundle, the engine
// on the fake pi, a fake OpenRouter that records what the model was sent.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makePdf, textPage } from "./pdfgen";
import { tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";

let home: string, vault: string, secrets: string;
let or: FakeOpenRouter;
let srv: Running;

const postRaw = (p: string, b: Record<string, unknown>) => fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const post = async (p: string, b: Record<string, unknown>) => (await (await postRaw(p, b)).json()) as any;

beforeAll(async () => {
  home = tmp("vcattach-");
  vault = makeVault(join(home, "vault"));
  secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
  or = await fakeOpenRouter("Here is the answer.");
  srv = await startServer({ home, vault, secrets, openrouter: or.url });
}, 120_000);

afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await or?.close();
  cleanup(home);
});

describe("attachments from outside the vault", () => {
  it("the PDF's bytes go to the box; the agent gets its box path (no laptop path) and reads its text", async () => {
    const pdf = makePdf([textPage("Discussion 5", ["Gauss law: the flux through a closed surface is Q over epsilon zero."]), textPage("Problem 2", ["A sphere of radius R carries charge Q."])]);
    const up = await post("/api/v2/attachment", { name: "Discussion_5_Supplementary Notes.pdf", dataBase64: pdf.toString("base64") });
    expect(up.ok).toBe(true);
    expect(up.path).toMatch(/^\.vault-chat\/attachments\/\d{4}-\d{2}-\d{2}\/Discussion_5_Supplementary Notes\.pdf$/);
    expect(up.abs).toBe(join(vault, ...up.path.split("/")));
    expect(readFileSync(up.abs).equals(pdf)).toBe(true);
    // Hidden, and out of git (never his front-facing folders, never a 25 MB blob in the repo).
    expect(readFileSync(join(vault, ".vault-chat", "attachments", ".gitignore"), "utf8")).toBe("*\n");
    // The same name again: kept apart.
    const again = await post("/api/v2/attachment", { name: "Discussion_5_Supplementary Notes.pdf", dataBase64: pdf.toString("base64") });
    expect(again.path).toMatch(/Discussion_5_Supplementary Notes \(1\)\.pdf$/);

    const n = or.calls.length;
    or.script.push({ toolCall: { name: "PdfRead", args: { path: up.abs, pages: "1-2" } } }, { text: "It states Gauss's law." });
    const r = await post("/api/v2/intent", { type: "send", clientId: "c-attach-1", text: "what is this about?\n\n[files: Discussion_5_Supplementary Notes.pdf]", files: [up.path], client: "laptop" });
    expect(r.ok).toBe(true);
    await waitFor(async () => or.calls.length >= n + 2, 30_000);
    const first = JSON.stringify(or.calls[n].messages);
    // Told where the file is on the box, and how to read it.
    expect(first).toContain(JSON.stringify(up.abs).slice(1, -1));
    expect(first).toMatch(/PdfRead/);
    // (The laptop's path never reaches the box: the client sends only the box path the upload returned.)
    expect(first).not.toContain("Downloads");
    // The PdfRead result the model got next is the PDF's own text.
    const second = JSON.stringify(or.calls[n + 1].messages);
    expect(second).toContain("Gauss law: the flux through a closed surface");
    expect(second).toContain("A sphere of radius R");
  }, 60_000);

  it("a file over the cap is refused with the reason; a path outside the attachments area is refused", async () => {
    const big = await postRaw("/api/v2/attachment", { name: "huge.pdf", dataBase64: Buffer.alloc(26 * 1024 * 1024).toString("base64") });
    expect(big.status).toBe(413);
    expect(((await big.json()) as any).error).toMatch(/huge\.pdf is 26 MB; an attachment can be at most 25 MB/);
    const empty = await post("/api/v2/attachment", { name: "x.pdf", dataBase64: "" });
    expect(empty.error).toBeTruthy();
    const bad = await post("/api/v2/intent", { type: "send", clientId: "c-attach-bad", text: "read it", files: ["../../etc/passwd"] });
    expect(bad.error).toMatch(/not on the box/);
    expect(existsSync(join(vault, "huge.pdf"))).toBe(false);
  }, 60_000);
});
