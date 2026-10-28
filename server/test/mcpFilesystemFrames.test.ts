// Executor wire tests only: real pinned pi schemas, synthetic NDJSON bytes.
// The filesystem implementation itself is exercised by mcpFilesystem.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { filesystemBinding } from "../mcp/filesystem";

const root = mkdtempSync(join(tmpdir(), "vc-fs-frames-"));
const script = join(root, "executor.mjs");
symlinkSync(resolve("server/engine/pi/ext/policy.mjs"), join(root, "policy.mjs"));
writeFileSync(script, `
import {readFileSync, writeSync} from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
const emit=x=>writeSync(1,JSON.stringify(x)+'\\n');
const final={type:'final',ok:true,result:{content:[{type:'text',text:'unchanged final'}]}};
switch(input.args.command){
 case 'split': {
  const bytes=Buffer.from(JSON.stringify({type:'update',text:'π 😀 cumulative\\nnext'})+'\\n'+JSON.stringify(final)+'\\n');
  for(let i=0;i<bytes.length;i++)writeSync(1,bytes.subarray(i,i+1));
  break;
 }
 case 'lifetime': for(let i=0;i<70;i++)emit({type:'update',text:'x'.repeat(512*1024)});emit(final);break;
 case 'oversize': writeSync(1,'x'.repeat(32*1024*1024+1));break;
 case 'malformed': writeSync(1,'{bad json}\\n');break;
 case 'incomplete': writeSync(1,JSON.stringify(final));break;
 case 'after-final': emit(final);emit({type:'update',text:'late'});break;
 case 'nonzero': emit(final);process.exitCode=1;break;
}
`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function binding() {
  const prefix = process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0");
  return filesystemBinding({ cli: join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), node: process.execPath, script,
    cwd: root, home: root, outer: null, shell: null, denyRead: [], denyWrite: [], allowed: ["bash"], env: () => ({}), fileWrite: async () => true });
}
describe("bounded request-local filesystem framing", () => {
  it("parses split UTF-8 and coalesced update/final frames without changing cumulative text", async () => {
    const b = await binding(); const previews: string[] = [];
    expect(await b.call("bash", { command: "split" }, { signal: new AbortController().signal, requestId: 0, progress: async (s) => { previews.push(s); } })).toMatchObject({ ok: true, text: "unchanged final" });
    expect(previews).toEqual(["π 😀 cumulative\nnext"]);
  });
  it("bounds individual frames, not total streamed output; awaits each consumer", async () => {
    const b = await binding(); let count = 0, active = 0;
    await b.call("bash", { command: "lifetime" }, { signal: new AbortController().signal, requestId: 1, progress: async (s) => {
      active++; expect(active).toBe(1); expect(s.length).toBe(512*1024);
      await new Promise((r) => setTimeout(r, 1)); count++; active--;
    } });
    expect(count).toBe(70); // >32 MiB across valid bounded frames
  });
  it.each(["oversize", "malformed", "incomplete", "after-final", "nonzero"])("rejects %s executor output", async (command) => {
    const b = await binding();
    await expect(b.call("bash", { command }, { signal: new AbortController().signal, requestId: command })).rejects.toBeInstanceOf(Error);
  });
  it("cancels a backpressured stream without late callbacks or a final result", async () => {
    const b = await binding(); const controller = new AbortController(); let count = 0;
    await expect(b.call("bash", { command: "lifetime" }, { signal: controller.signal, requestId: 2, progress: async () => {
      count++; controller.abort();
    } })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 50)); expect(count).toBe(1);
  });
});
