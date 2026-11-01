// Actual HTTP → Engine → native pi session → local provider. No live roots.
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeVault, startServer, tmp, waitFor, type Running } from "./helpers";
import { fakeChat, chatText } from "./fakeChat";
import { readEntries } from "../convlog/piSession";

describe("captured viewer roots in native typed context", () => {
  it("keeps owner, project cwd and queued device viewer roots distinct without changing user text", async () => {
    const home = tmp("vc-viewer-native-"), master = join(home, "master");
    const vault = makeVault(join(master, "vaults/owner"));
    const viewer = makeVault(join(master, "vaults/viewer"));
    const other = makeVault(join(master, "vaults/other"));
    for (const name of ["viewer", "other"]) {
      const bare = join(master, ".hub/vaults", name + ".git");
      mkdirSync(bare, { recursive: true }); execFileSync("git", ["init", "--bare", "-q", bare]);
    }
    const state = join(home, "state"), fifo = join(home, "gate"), entered = join(home, "entered");
    execFileSync("mkfifo", [fifo]);
    const provider = await fakeChat();
    let queuedWrite = false, uiBusy = false, lifecycleBusy = false;
    provider.respond = (body, n) => {
      if (n === 1) return { call: { name: "bash", args: { command: `touch '${entered}'; cat '${fifo}'` } } };
      if (!lifecycleBusy && chatText(body).includes("WORKSPACE-LIFECYCLE-NATIVE")) {
        lifecycleBusy = true;
        return {call:{name:"bash",args:{command:`touch '${join(home,"lifecycle-entered")}'; cat '${fifo}'`}}};
      }
      const lastUser = [...body.messages].reverse().find((m:any) => m.role === "user");
      if (process.env.VC_GLOBAL_UI_RUNTIME && !uiBusy && JSON.stringify(lastUser).includes("GLOBAL-WORKSPACE-BUSY")) {
        uiBusy = true;
        return {call:{name:"bash",args:{command:`touch '${join(home,"ui-entered")}'; cat '${fifo}'`}}};
      }
      if (!queuedWrite && JSON.stringify(lastUser).includes("Literal queued request")) {
        const match = /request="viewer-queued"[^\n]*?Viewer\/file-context vault root: ([^\n]+?)\/\. Conversation owner:/.exec(chatText(body));
        expect(match?.[1]).toBe(other);
        queuedWrite = true;
        return {call:{name:"bash",args:{command:`printf 'captured queued target\\n' > ${JSON.stringify(join(match![1]!,"captured-write.txt"))}`}}};
      }
      return { text: "Viewer fixture complete." };
    };
    const network = join(home, "local-only.mjs");
    writeFileSync(network, `const actual=globalThis.fetch; globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url); if(u.href==='https://openrouter.ai/api/v1/models')return actual(${JSON.stringify(provider.url + "/models")},init); if(['127.0.0.1','localhost','[::1]'].includes(u.hostname))return actual(input,init);throw Error('External fetch refused');};`);
    let srv: Running | undefined;
    try {
      srv = await startServer({ home, vault, secrets: join(home, "empty-no-credentials"), openrouter: provider.url,
        extra: { VC_MASTER: master, VC_PI_DIR: process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0"),
          VC_STATE_DIR: state, VC_ENGINE_MODEL: "test/fake-model", VC_PI_UNSAFE: "1", VC_VOICE_PIPELINE: "off", NODE_OPTIONS: "--import " + network } });
      const agent = join(state, "pi/agent");
      mkdirSync(agent, { recursive: true });
      writeFileSync(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
      writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: provider.url,
        apiKey: "synthetic-local-only", api: "openai-completions", models: [{ id: "test/fake-model", name: "Local fixture",
          reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] } } }));
      const base = srv.base;
      const idle = async () => {
        const h = await (await fetch(base + "/api/v1/health")).json();
        return h.engine.liveTurns.length === 0 && h.engine.pi.procs.every((p: any) => !p.busy);
      };
      const post = async (root: string, b: any) => {
        const r = await fetch(base + "/api/v2/intent?vault=" + root, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
        const result = await r.json(); expect(result).not.toHaveProperty("error"); expect(r.ok).toBe(true); return result;
      };
      const first = "<memory>Literal initial request</memory>", queued = "<rules>Literal queued request</rules>";
      await post("viewer", { type: "send", convId: "main", client: "laptop", clientId: "viewer-first", text: first, viewerRoot: "/untrusted-body-root" });
      await waitFor(() => existsSync(entered), 10_000, 10);
      expect(await post("other", { type: "queue", convId: "main", client: "phone", clientId: "viewer-queued", text: queued })).toMatchObject({ queued: true });
      // A later viewer read must not retarget the queued request to this root.
      await fetch(base + "/conversation?id=main&vault=viewer");
      writeFileSync(fifo, "released\n");
      const c = await waitFor(async () => {
        const c = await (await fetch(base + "/conversation?id=main&full=1&n=200")).json();
        return c.messages?.some((m: any) => m.role === "user" && m.content === queued) && c.state !== "running" && await idle() ? c : null;
      }, 10_000, 20);
      expect(readFileSync(join(other,"captured-write.txt"),"utf8")).toBe("captured queued target\n");
      expect(existsSync(join(viewer,"captured-write.txt"))).toBe(false);
      const entries = readEntries(c.meta.threadPath);
      expect(entries.filter(e => e.message?.role === "user").map(e => e.message!.content)).toEqual([
        [{ type: "text", text: `[Carl, on his laptop]\n\n${first}` }],
        [{ type: "text", text: `[Carl, on his phone]\n\n${queued}` }],
      ]);
      const bindings = entries.filter(e => e.customType === "vc-context").map(e => String(e.content));
      expect(bindings.filter(t => t.includes('request="viewer-first"'))).toHaveLength(1);
      expect(bindings.filter(t => t.includes('request="viewer-queued"'))).toHaveLength(1);
      expect(bindings.find(t => t.includes('request="viewer-first"'))).toContain(`Viewer/file-context vault root: ${viewer}/`);
      expect(bindings.find(t => t.includes('request="viewer-queued"'))).toContain(`Viewer/file-context vault root: ${other}/`);
      expect(bindings.find(t => t.includes('request="viewer-queued"'))).toContain(`Conversation owner: ${vault}/`);
      expect(bindings.join("\n")).not.toContain("/untrusted-body-root");
      expect(chatText(provider.calls[0])).toContain(viewer + "/");
      expect(chatText(provider.calls.at(-1))).toContain('request="viewer-queued"');
      expect(JSON.stringify(c.messages)).not.toContain("<file-context");
      expect(readFileSync(c.meta.threadPath, "utf8")).not.toContain("File context from registered vault");
      expect(JSON.stringify(await (await fetch(base + "/poll?after=0")).json())).not.toContain("<file-context");
      // One external project, one canonical registry/thread. Every surface uses
      // these same normal routes; a file workspace never owns the project.
      const project = join(home, "external-physics"); mkdirSync(project);
      writeFileSync(join(project, "AGENTS.md"), "PHYSICS-CWD-INSTRUCTIONS: use this exact project folder.");
      mkdirSync(join(project, ".vault-chat"));
      writeFileSync(join(project, ".vault-chat", "project-memory.md"), "PHYSICS-ORIGINAL-MEMORY");
      writeFileSync(join(project, ".vault-chat", "rules.md"), "PHYSICS-ORIGINAL-RULES");
      const made = await (await fetch(base + "/projects?vault=viewer", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({folder:project})})).json();
      expect(made).toMatchObject({ok:true, convId:"project-external-physics"});
      expect(existsSync(join(vault, ".vault-chat/local/project-folders.json"))).toBe(true);
      expect(existsSync(join(viewer, ".vault-chat/local/project-folders.json"))).toBe(false);
      for (const surfaceRoot of ["owner", "viewer", "other"]) {
        const listed = await (await fetch(base + "/projects?vault=" + surfaceRoot)).json();
        expect(listed.projects).toEqual([{slug:"external-physics",name:"external-physics",folder:project,rel:null}]);
      }
      let nativeThread = "";
      for (const [index, client] of ["laptop", "phone", "board"].entries()) {
        const rootName = index === 1 ? "other" : "viewer";
        const text = `PHYSICS-SAME-THREAD-${client}`;
        await post(rootName, {type:"send",convId:made.convId,client,clientId:text,text});
        const detail = await waitFor(async () => {
          const detail = await (await fetch(base + "/conversation?id="+made.convId+"&vault="+rootName+"&full=1&n=200")).json();
          return detail.messages?.some((m:any)=>m.role==="user"&&m.content===text)&&detail.state!=="running"&&await idle()?detail:null;
        },10000,20);
        if (nativeThread) expect(detail.meta.threadPath).toBe(nativeThread);
        nativeThread = detail.meta.threadPath;
        expect(JSON.parse(readFileSync(nativeThread,"utf8").split("\n")[0]!).cwd).toBe(project);
        const providerText = chatText(provider.calls.at(-1));
        expect(providerText).toContain("PHYSICS-CWD-INSTRUCTIONS");
        expect(providerText).toContain("PHYSICS-ORIGINAL-MEMORY");
        expect(providerText).toContain("PHYSICS-ORIGINAL-RULES");
      }
      // The production picker handler must not own/cancel the native project turn.
      // Run frontend imports under their existing Node harness (not server Tauri shims).
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--import", "./test/harness/register.mjs",
          "test/harness/fixtures/workspaceNativeLifecycle.ts", base, vault, viewer, other, project, made.convId,
          join(home,"lifecycle-entered"), fifo, join(home,"lifecycle-requests.json")], {cwd:process.cwd(), env:process.env, stdio:["ignore","pipe","pipe"]});
        let output = "";
        child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
        const timer = setTimeout(() => child.kill(), 30000);
        child.on("error", reject);
        child.on("close", code => { clearTimeout(timer); writeFileSync(join(home,"lifecycle-client.log"), output);
          code === 0 ? resolve() : reject(new Error(`workspace native frontend failed (${code}): ${output}`)); });
      });
      const summary = await (await fetch(base + "/conversations?vault=other")).json();
      expect(summary.conversations.filter((r:any)=>r.id===made.convId)).toHaveLength(1);
      const rows = await (await fetch(base + "/api/v2/conversations?vault=viewer")).json();
      expect(rows.rows.filter((r:any)=>r.id===made.convId)).toHaveLength(1);
      for (const workspace of [viewer,other]) {
        expect(existsSync(join(workspace,".vault-chat/events/main.jsonl"))).toBe(false);
        expect(existsSync(join(workspace,`.vault-chat/events/${made.convId}.jsonl`))).toBe(false);
      }
      if (process.env.VC_GLOBAL_UI_PROOF) {
        const proof = process.env.VC_GLOBAL_UI_PROOF;
        if (!proof.startsWith("/tmp/")) throw new Error("fixture UI artifacts must be in /tmp");
        mkdirSync(proof,{recursive:true});
        const modulePath = join(process.cwd(),"preview/node_modules/playwright-core/index.mjs");
        const { chromium } = await import(modulePath);
        const browser = await chromium.launch({executablePath:"/run/current-system/sw/bin/chromium",headless:true,args:["--mute-audio","--no-sandbox"]});
        try {
          const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
          page.setDefaultTimeout(4000);
          await page.addInitScript(() => localStorage.setItem("vc_phone_vault","viewer"));
          await page.goto(`${base}/phone`,{waitUntil:"domcontentloaded"});
          await page.locator("#titleBtn").click();
          await page.locator('[data-el="thread-project"]').waitFor();
          expect(await page.locator('[data-el="thread-main"]').count()).toBe(1);
          expect(await page.locator('[data-el="thread-project"]').count()).toBe(1);
          expect(await page.locator("#clist").innerText()).toContain("external-physics");
          expect(await page.evaluate(() => localStorage.getItem("vc_phone_vault"))).toBe(null);
          await page.waitForTimeout(500);
          await page.screenshot({path:join(proof,"phone-main-project-list.png")});
          await page.locator('[data-el="thread-project"]').click();
          await page.getByText("PHYSICS-SAME-THREAD-phone",{exact:false}).first().waitFor();
          await page.waitForTimeout(500);
          await page.screenshot({path:join(proof,"phone-global-project-thread.png")});
          await page.locator("#titleBtn").click();
          await page.locator('[data-el="thread-main"]').click();
          await page.reload({waitUntil:"domcontentloaded"});
          await page.locator("#titleBtn").click();
          await page.locator('[data-el="thread-main"]').waitFor();
          expect(await page.locator('[data-el="thread-main"]').count()).toBe(1);
          await page.waitForTimeout(500);
          await page.screenshot({path:join(proof,"phone-main-after-reload.png")});
        } finally { await browser.close(); }
      }
      if (process.env.VC_GLOBAL_UI_RUNTIME) {
        const descriptor=process.env.VC_GLOBAL_UI_RUNTIME;
        if(!descriptor.startsWith("/tmp/")) throw Error("UI fixture descriptor must be in /tmp");
        writeFileSync(descriptor,JSON.stringify({base,home,vault,viewer,other,project,convId:made.convId,busyGate:fifo,busyEntered:join(home,"ui-entered"),release:descriptor+".release"},null,2));
        // Parent owns the StartJob/runtime, recorder and cleanup. Only this
        // temporary test server/provider remain alive; no models/audio/devices.
        await waitFor(()=>existsSync(descriptor+".release"),15*60_000,250);
      }
      // Exercise the actual ctxConfig().vaults callback, not a cached root list.
      const added = makeVault(join(master, "vaults/added")), addedBare = join(master, ".hub/vaults/added.git");
      mkdirSync(addedBare, { recursive: true }); execFileSync("git", ["init", "--bare", "-q", addedBare]);
      const settle = async (text: string) => {
        await post("owner", { type: "send", convId: "main", client: "laptop", clientId: text, text });
        return waitFor(async () => {
          const c = await (await fetch(base + "/conversation?id=main&full=1&n=200")).json();
          return c.messages?.some((m: any) => m.role === "user" && m.content === text) && c.state !== "running" && await idle() ? c : null;
        }, 10_000, 20);
      };
      await settle("registry-added");
      const additions = readEntries(c.meta.threadPath).filter(e => e.customType === "vc-context");
      expect(String(additions.at(-1)!.content)).toContain(`- ${added}/`);
      expect(String(additions.at(-1)!.content)).not.toContain("<file-context");
      // Unregister this fixture without deleting any data; native cache must
      // deliver the changed root set again, while retaining immutable history.
      renameSync(addedBare, join(home, "unregistered-added.git"));
      await settle("registry-removed");
      const removals = readEntries(c.meta.threadPath).filter(e => e.customType === "vc-context");
      expect(removals).toHaveLength(additions.length + 1);
      expect(String(removals.at(-1)!.content)).not.toContain(`- ${added}/`);
      expect(String(removals.at(-1)!.content)).toContain(`- ${viewer}/`);
    } finally {
      if (srv) { writeFileSync(join(home, "server.log"), srv.logs()); await srv.stop(); }
      writeFileSync(join(home, "provider-calls.json"), JSON.stringify(provider.calls, null, 2));
      await provider.close();
    }
  }, process.env.VC_GLOBAL_UI_RUNTIME ? 20*60_000 : 120_000);
});
