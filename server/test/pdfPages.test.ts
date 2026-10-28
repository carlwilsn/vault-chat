// PdfPages: the agent sees PDF pages the way Claude reads a PDF — the pages
// themselves go to the model as a native PDF part (each page's text and image),
// so scans, handwriting and figures are visible. End to end: the real bundle,
// the engine on the fake pi (fakePiCli.mjs, which applies the extension's own
// before_provider_request hook, ext/pdf.mjs), a fake OpenRouter that records
// what the model was sent. The main agent and Ctrl+K / Ctrl+L side threads have it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as pdfjs from "pdfjs-dist";
import { makePdf, textPage } from "./pdfgen";
import { withPdfParts } from "../engine/pi/ext/pdf.mjs";
import { tmp, cleanup, makeVault, makeKeyStore, fakeOpenRouter, startServer, waitFor, type Running, type FakeOpenRouter } from "./helpers";

let home: string, vault: string, secrets: string;
let or: FakeOpenRouter;
let srv: Running;

const get = async (p: string) => (await (await fetch(srv.base + p)).json()) as any;
const post = async (p: string, b: Record<string, unknown>) => (await (await fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json()) as any;
/** The native PDF parts of one model call: the user message after the tool results. */
const fileParts = (c: any) => (c?.messages ?? []).flatMap((m: any) => (m.role === "user" && Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === "file") : []));
/** A PDF part's pages, read back with pdf.js: their count and text. */
async function pagesOf(part: any): Promise<string[]> {
  const url: string = part.file.file_data;
  expect(url.startsWith("data:application/pdf;base64,")).toBe(true);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(Buffer.from(url.split(",")[1]!, "base64")), verbosity: 0 }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) out.push(((await (await doc.getPage(i)).getTextContent()).items as any[]).map((x) => x.str).join(" "));
  await doc.destroy();
  return out;
}

beforeAll(async () => {
  home = tmp("vcpdfpages-");
  vault = makeVault(join(home, "vault"));
  mkdirSync(join(vault, "Real 320-1"), { recursive: true });
  // Page 3 is a drawing with no text layer: PdfRead says so and points at PdfPages.
  writeFileSync(
    join(vault, "Real 320-1", "Exam1.pdf"),
    makePdf([textPage("Exam 1", ["Problem 1."]), textPage("Problem 2", ["Find the area under the curve in the figure."]), "0.6 w 72 600 m 300 700 l 540 600 l S", textPage("Answers", ["none"])]),
  );
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

describe("PdfPages: PDF pages to the model natively", () => {
  it("the agent sees the asked pages as a PDF part (text and images), cut from the vault's PDF and cached", async () => {
    const n = or.calls.length;
    or.script.push(
      { toolCall: { name: "PdfRead", args: { path: "Real 320-1/Exam1.pdf", pages: "2-3" } } },
      { toolCall: { name: "PdfPages", args: { path: "Real 320-1/Exam1.pdf", pages: "2-3" } } },
      { text: "The figure is a tent-shaped curve." },
    );
    const r = await post("/api/v2/intent", { type: "send", clientId: "c-pdfpages-1", text: "what does the figure in problem 2 of my exam show?" });
    expect(r.ok).toBe(true);
    await waitFor(async () => or.calls.slice(n).some((c) => JSON.stringify(c.messages ?? []).includes("tent-shaped")) || or.calls.length >= n + 3, 30_000);
    const calls = or.calls.slice(n);
    // Offered to the main agent, read-only beside PdfRead.
    expect((calls[0].tools ?? []).map((t: any) => t.function?.name)).toEqual(expect.arrayContaining(["mcp__vault_chat__PdfRead", "mcp__vault_chat__PdfPages"]));
    // PdfRead: page 3 has no text layer, and the result says to look with PdfPages.
    expect(JSON.stringify(calls[1].messages)).toMatch(/No text layer on page 3[^"]*PdfPages/);
    expect(fileParts(calls[1])).toEqual([]);
    // PdfPages: the pages go as one native PDF part, exactly the two asked for.
    const parts = fileParts(calls[2]);
    expect(parts.length).toBe(1);
    expect(parts[0].file.filename).toMatch(/^[0-9a-f]{16}-p2-3\.pdf$/);
    const pages = await pagesOf(parts[0]);
    expect(pages.length).toBe(2);
    expect(pages[0]).toContain("Find the area under the curve");
    expect(pages[1]).toBe("");
    // The slice is cached in the vault's local (never-synced) dir.
    expect(readdirSync(join(vault, ".vault-chat", "local", "pdf-pages"))).toEqual([parts[0].file.filename]);
  }, 60_000);

  it("a Ctrl+K side thread has it too (read-only)", async () => {
    const n = or.calls.length;
    or.script.push({ toolCall: { name: "PdfPages", args: { path: "Real 320-1/Exam1.pdf", pages: "1" } } }, { text: "Problem 1 is on page 1." });
    const r = await post("/api/v1/side", { kind: "edit", text: "# Ctrl+K: an inline edit\n\nINSTRUCTION:\nsummarise page 1 of Real 320-1/Exam1.pdf\n\nSELECTION:\n" });
    expect(r.id).toBeTruthy();
    await waitFor(async () => (await get(`/api/v1/side/${r.id}?after=0&wait=2000`)).done, 30_000);
    const calls = or.calls.slice(n);
    expect((calls[0].tools ?? []).map((t: any) => t.function?.name)).toContain("mcp__vault_chat__PdfPages");
    const parts = fileParts(calls[1]);
    expect(parts.length).toBe(1);
    expect(await pagesOf(parts[0])).toEqual([expect.stringContaining("Problem 1.")]);
  }, 60_000);

  it("the hook: Anthropic's shape gets a document block in the tool_result; a path PdfPages did not write is never read", () => {
    const dir = join(vault, ".vault-chat", "local", "pdf-pages");
    const slice = join(dir, readdirSync(dir).find((f) => f.endsWith("-p2-3.pdf"))!);
    const anth = withPdfParts({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `ok\n[PDF pages attached: ${slice}]` }] }] }) as any;
    const block = anth.messages[0].content[0];
    expect(block.content[0]).toEqual({ type: "text", text: `ok\n[PDF pages attached: ${slice}]` });
    expect(block.content[1]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
    // Any other file named in a result (the model could echo a path) is left alone.
    const other = join(vault, "Real 320-1", "Exam1.pdf");
    expect(existsSync(other)).toBe(true);
    expect(withPdfParts({ messages: [{ role: "tool", tool_call_id: "x", content: `[PDF pages attached: ${other}]` }] })).toBeUndefined();
    expect(withPdfParts({ messages: [{ role: "user", content: "hi" }] })).toBeUndefined();
  });
});
