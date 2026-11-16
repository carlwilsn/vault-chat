// A conversation log written by the release before this one (REDUCER_VERSION 7, its checkpoint) boots as it is: no
// forced migration. A log over 16 MiB can only be read from a compatible checkpoint (server/convlog/log.ts load), so a
// change to what the fold means must never bump the version; the chat translators' commentary mark (Picture.commentary)
// is kept beside the items: the checkpointed history keeps its items and look, new records are marked (expand, no
// migration). The first chat-translator candidate bumped the version and the box would not boot on the real
// project-vault-chat log (790 MB): this is that case, small.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { ConvLog } from "../../server/convlog/log.ts";
import { MAX_RECOVERY_BYTES } from "../../server/convlog/reader.ts";
import { REDUCER_VERSION } from "../../src/convlog/reduce.ts";
import { makeChatView } from "../../src/convlog/view.ts";

const C = "bigmain";
/** The fold version the release before wrote its checkpoints with (origin/main adc97d22). */
const MAIN_REDUCER_VERSION = 7;

test("a large log with the previous release's checkpoint boots, its items unchanged; only new text beside a tool call is marked", () => {
  assert.equal(REDUCER_VERSION, MAIN_REDUCER_VERSION, "a new REDUCER_VERSION is a forced migration: every log over 16 MiB stops booting");
  const root = fs.mkdtempSync(join(os.tmpdir(), "vc-maincheckpoint-"));
  const dir = join(root, "events");
  fs.mkdirSync(dir);
  const file = join(dir, C + ".jsonl");
  try {
    const writer = new ConvLog(root, null, dir);
    const session = writer.ownSession(C);
    fs.mkdirSync(writer.sessionsDir, { recursive: true });
    const put = (entry: any, extra: Record<string, unknown> = {}) => {
      fs.appendFileSync(session, JSON.stringify(entry) + "\n");
      writer.emit(C, { type: "entry", file: session, entry, ...extra } as any);
    };
    writer.emit(C, { type: "meta", patch: { title: "Big", source: "manual" } });
    put({ type: "message", id: "u1", message: { role: "user", content: "start" } }, { clientId: "u1", shown: "start" });
    // History the old release folded: a reply that called a tool (its text was folded under Thought).
    put({ type: "message", id: "a1", message: { role: "assistant", timestamp: 100, stopReason: "toolUse", content: [{ type: "text", text: "OLD-BESIDE-TOOL" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] } });
    put({ type: "message", id: "r1", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "a.txt" }] } });
    const body = "z".repeat(3 * 1024 ** 2);
    // The log itself grows past 16 MiB (records carry their own data: here a large field, set and set again).
    for (let i = 0; i < 6; i++) writer.emit(C, { type: "meta", patch: { pad: body.slice(i) } } as any);
    writer.emit(C, { type: "meta", patch: { pad: null } } as any);
    assert.ok(fs.statSync(file).size > MAX_RECOVERY_BYTES, "large enough that only a checkpoint can open it");
    writer.checkpointNow(C);
    writer.close();

    // The checkpoint as the previous release wrote it: its version, and no field it did not know.
    const ckFile = file.replace(/\.jsonl$/, ".ckpt.json");
    const ck = JSON.parse(fs.readFileSync(ckFile, "utf8"));
    ck.rv = MAIN_REDUCER_VERSION;
    delete ck.picture.commentary;
    fs.writeFileSync(ckFile, JSON.stringify(ck));
    const mainItems = JSON.stringify(ck.picture.items);

    // Records after it (the box kept writing); no new checkpoint is made before the cold boot.
    const more = new ConvLog(root, null, dir);
    const put2 = (entry: any) => {
      fs.appendFileSync(session, JSON.stringify(entry) + "\n");
      more.emit(C, { type: "entry", file: session, entry } as any);
    };
    put2({ type: "message", id: "a2", message: { role: "assistant", timestamp: 300, stopReason: "toolUse", content: [{ type: "text", text: "NEW-BESIDE-TOOL" }, { type: "toolCall", id: "t2", name: "bash", arguments: { command: "pwd" } }] } });
    more.close();
    assert.equal(JSON.parse(fs.readFileSync(ckFile, "utf8")).rv, MAIN_REDUCER_VERSION, "still the previous release's checkpoint");

    const cold = new ConvLog(root, null, dir);
    try {
      const p = cold.picture(C)!;
      assert.ok(p, "boots: the conversation is there");
      assert.equal(JSON.stringify(p.items.slice(0, ck.picture.items.length)), mainItems, "every item the previous release had, unchanged");
      const oldId = p.items.find((x) => x.text === "OLD-BESIDE-TOOL")!.id;
      const newId = p.items.find((x) => x.text === "NEW-BESIDE-TOOL")!.id;
      assert.ok(!(p.commentary ?? []).includes(oldId), "the checkpointed history is not rewritten");
      assert.ok(p.commentary?.includes(newId), "a new record is marked");
      const ms = makeChatView()(p, { split: false }).messages;
      assert.ok(ms.some((m) => m.thinking === "OLD-BESIDE-TOOL"), "old: as it looked");
      assert.ok(ms.some((m) => m.role === "assistant" && m.content === "NEW-BESIDE-TOOL"), "new: shown as what the agent said");
    } finally {
      cold.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
