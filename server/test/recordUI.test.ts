// RecordUI (server/recordUI.ts): the WebM it writes is a valid one-track VP8 file (EBML header, duration, size,
// a cluster per keyframe, cues), and a real recording — the box's headless browser, steps with real input, encoded
// by the browser itself, no ffmpeg — plays as a video of the right length. The recording is skipped on a machine
// without a browser (findBrowser).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmp, cleanup, ROOT } from "./helpers";
import { webm, record, recordUITool, type Chunk } from "../recordUI";
import { findBrowser } from "../headless";

/** A tiny EBML reader: [id hex, size, offset of data] for each element at one level. */
function children(b: Buffer, from: number, to: number): { id: string; size: number; at: number }[] {
  const out: { id: string; size: number; at: number }[] = [];
  let i = from;
  const vint = (keepMarker: boolean) => {
    const first = b[i]!;
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    let v = BigInt(keepMarker ? first : first & (0xff >> len));
    for (let k = 1; k < len; k++) v = (v << 8n) | BigInt(b[i + k]!);
    i += len;
    return { v, len };
  };
  while (i < to) {
    const start = i;
    const id = vint(true);
    const idHex = b.subarray(start, start + id.len).toString("hex");
    const size = Number(vint(false).v);
    out.push({ id: idHex, size, at: i });
    i += size;
  }
  return out;
}

describe("the WebM writer", () => {
  it("writes header, info (duration), the VP8 track, a cluster per keyframe and cues that point at them", () => {
    const frame = (n: number) => Buffer.alloc(50 + n, n);
    const chunks: Chunk[] = [
      { key: true, t: 0, data: frame(1) },
      { key: false, t: 33, data: frame(2) },
      { key: false, t: 66, data: frame(3) },
      { key: true, t: 2100, data: frame(4) },
      { key: false, t: 2133, data: frame(5) },
    ];
    const f = webm(chunks, 640, 360, 2500);
    const top = children(f, 0, f.length);
    expect(top.map((e) => e.id)).toEqual(["1a45dfa3", "18538067"]);
    expect(f.subarray(top[0]!.at, top[0]!.at + top[0]!.size).includes(Buffer.from("webm"))).toBe(true);
    const seg = top[1]!;
    expect(seg.at + seg.size).toBe(f.length);
    const parts = children(f, seg.at, seg.at + seg.size);
    expect(parts.map((e) => e.id)).toEqual(["114d9b74", "1549a966", "1654ae6b", "1f43b675", "1f43b675", "1c53bb6b"]);
    // Duration (float64, ms).
    const info = parts[1]!;
    const dur = children(f, info.at, info.at + info.size).find((e) => e.id === "4489")!;
    expect(f.readDoubleBE(dur.at)).toBe(2500);
    // The track: V_VP8, 640×360.
    const tracks = parts[2]!;
    expect(f.subarray(tracks.at, tracks.at + tracks.size).includes(Buffer.from("V_VP8"))).toBe(true);
    // Clusters: 3 blocks then 2, the first block of each a keyframe at offset 0.
    const blocks = (c: { at: number; size: number }) => children(f, c.at, c.at + c.size).filter((e) => e.id === "a3");
    expect(blocks(parts[3]!).length).toBe(3);
    expect(blocks(parts[4]!).length).toBe(2);
    const b0 = blocks(parts[4]!)[0]!;
    expect([f[b0.at], f.readInt16BE(b0.at + 1), f[b0.at + 3]]).toEqual([0x81, 0, 0x80]);
    const b1 = blocks(parts[4]!)[1]!;
    expect([f.readInt16BE(b1.at + 1), f[b1.at + 3]]).toEqual([33, 0]);
    // Cues: each cluster's position from the segment's data start; the SeekHead points at the cues.
    const cues = children(f, parts[5]!.at, parts[5]!.at + parts[5]!.size);
    const pos = cues.map((cp) => {
      const tp = children(f, cp.at, cp.at + cp.size).find((e) => e.id === "b7")!;
      const cl = children(f, tp.at, tp.at + tp.size).find((e) => e.id === "f1")!;
      return Number(f.readBigUInt64BE(cl.at));
    });
    expect(pos.map((p) => seg.at + p)).toEqual([parts[3]!.at - 12, parts[4]!.at - 12]); // 4-byte id + 8-byte size
    const seek = children(f, parts[0]!.at, parts[0]!.at + parts[0]!.size)[0]!;
    const sp = children(f, seek.at, seek.at + seek.size).find((e) => e.id === "53ac")!;
    expect(seg.at + Number(f.readBigUInt64BE(sp.at))).toBe(parts[5]!.at - 12);
  });
});

const browser = !!findBrowser();

describe.skipIf(!browser)("a real recording", () => {
  let dir: string;
  beforeAll(() => {
    dir = tmp("vc-rec-");
    writeFileSync(
      join(dir, "app.html"),
      `<!doctype html><body style="font:24px system-ui;padding:40px"><h1>Counter</h1><button id="add">Add one</button> <b id="n">0</b>
       <p><input id="who" placeholder="name"></p><p id="hi"></p>
       <script>document.getElementById("add").onclick=function(){var n=document.getElementById("n");n.textContent=+n.textContent+1};
       document.getElementById("who").onkeydown=function(e){if(e.key==="Enter")document.getElementById("hi").textContent="Hello, "+e.target.value}</script></body>`,
    );
  });
  afterAll(() => cleanup(dir));

  it("drives the page with real input, then writes a playable WebM of at least the asked length", async () => {
    const r = await record(dir, {
      url: "app.html",
      out: "proof/counter.webm",
      seconds: 3,
      width: 800,
      height: 600,
      steps: [{ click: "#add" }, { click: { text: "Add one" } }, { type: "Carl", into: "#who" }, { press: "Enter" }, { waitFor: { text: "Hello, Carl" } }, { run: "node -e \"require('fs').writeFileSync('ran.txt','yes')\"" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.log.filter((l) => /failed/.test(l))).toEqual([]);
    expect(r.seconds).toBeGreaterThanOrEqual(3);
    expect(r.frames).toBeGreaterThan(3);
    expect(readFileSync(join(dir, "ran.txt"), "utf8")).toBe("yes");
    const f = readFileSync(join(dir, "proof", "counter.webm"));
    expect(f.length).toBe(r.bytes);
    expect(f.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  });

  it("refuses what it can't record, with why", async () => {
    expect(await record(dir, { url: "ftp://x" })).toMatchObject({ ok: false, error: expect.stringMatching(/http/) });
    expect(await record(dir, { url: "app.html", out: "../outside.webm" })).toMatchObject({ ok: false, error: expect.stringMatching(/inside the vault/) });
    expect(await record(dir, { url: "app.html", out: "x.mp4" })).toMatchObject({ ok: false, error: expect.stringMatching(/\.webm/) });
  });

  it("the tool: the recorder runs as a child process and the agent gets the path to put in its reply", async () => {
    // As the box runs it (`vault-chat-server.mjs record-ui`), with tsx standing in for the bundle.
    const entry = [process.execPath, "--import", pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "esm", "index.mjs")).href, join(__dirname, "recordEntry.mts")];
    const text = await recordUITool(null, dir, { url: "app.html", out: ".vault-chat/visuals/tool.webm", seconds: 2, width: 640, height: 480 }, { entry });
    expect(text).toMatch(/^Recorded \d+(\.\d)? s \(640×480, \d+ frames, \d+ KB\): \.vault-chat\/visuals\/tool\.webm\. Put it in your reply as !\[what it shows\]\(\.vault-chat\/visuals\/tool\.webm\)/);
    expect(existsSync(join(dir, ".vault-chat", "visuals", "tool.webm"))).toBe(true);
  });
});
