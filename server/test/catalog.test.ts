// Catalog refresh must bound the whole response, not only its headers: engine
// startup awaits it and must still finish if OpenRouter stalls mid-body.
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { loadCatalog, modelMeta } from "../engine/catalog";
import { tmp, cleanup } from "./helpers";

const realFetch = globalThis.fetch;
let server: Server | undefined;
let home: string | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (home) cleanup(home);
  home = undefined;
});

async function serve(stall: boolean): Promise<void> {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"data":['); // Headers arrive, but a stalled body never finishes.
    if (!stall) res.end('{"id":"test/live","context_length":12345}]}');
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => realFetch(`http://127.0.0.1:${port}/models`, init));
}

function cachePath(): string {
  home = tmp("vc-catalog-");
  return join(home, "catalog.json");
}

describe("catalog refresh deadline", () => {
  it("keeps cached metadata when headers arrive but the body stalls", async () => {
    await serve(true);
    const path = cachePath();
    const cached = JSON.stringify({ data: [{ id: "test/cached", context_length: 8192 }] });
    writeFileSync(path, cached);
    expect(await loadCatalog(path, 100)).toEqual({ models: 1, source: "cache" });
    expect(modelMeta("test/cached")?.contextLength).toBe(8192);
    expect(readFileSync(path, "utf8")).toBe(cached);
  }, 2000);

  it("finishes without metadata when there is no cache and the body stalls", async () => {
    await serve(true);
    expect(await loadCatalog(cachePath(), 100)).toEqual({ models: 0, source: "none" });
  }, 2000);

  it("still reads and persists a complete live catalog", async () => {
    await serve(false);
    const path = cachePath();
    expect(await loadCatalog(path, 1000)).toEqual({ models: 1, source: "live" });
    expect(modelMeta("test/live")?.contextLength).toBe(12345);
    expect(JSON.parse(readFileSync(path, "utf8")).data[0].id).toBe("test/live");
  });
});
