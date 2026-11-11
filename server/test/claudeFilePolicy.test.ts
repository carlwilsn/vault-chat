// vault-chat's path policy over Claude Code's own file tools.
//
// This is what has to hold before pi can be removed: pi's core tools are what
// enforce the policy today, so if Claude Code is to use its own file tools, the
// same calls must still be refused for the same reasons.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ruleOnToolUse, touchesOf, wallsOf, WRITING_TOOLS } from "../engine/claude/filePolicy";
import { tmp, cleanup } from "./helpers";

const root = tmp("filepolicy");
const vault = join(root, "vault");
const secret = join(root, "other-vault", ".vault-chat");
mkdirSync(join(vault, "notes"), { recursive: true });
mkdirSync(secret, { recursive: true });
writeFileSync(join(vault, "notes", "ok.md"), "fine");
writeFileSync(join(secret, "keys.json"), "{}");
afterAll(() => cleanup(root));

const walls = { cwd: vault, home: root, denyRead: [secret], denyWrite: [secret] };

describe("which paths a tool call touches", () => {
  it("names them, and says which would write", () => {
    expect(touchesOf("Read", { file_path: "notes/ok.md" })).toEqual([{ path: "notes/ok.md", write: false }]);
    expect(touchesOf("Write", { file_path: "notes/new.md" })).toEqual([{ path: "notes/new.md", write: true }]);
    expect(touchesOf("Edit", { file_path: "notes/ok.md" })).toEqual([{ path: "notes/ok.md", write: true }]);
    expect(touchesOf("Glob", { path: "notes" })).toEqual([{ path: "notes", write: false }]);
    // A call that names no path has nothing to check; a shell line is not a path,
    // and the sandbox is what holds Bash in, as it always was.
    expect(touchesOf("TodoWrite", { todos: [] })).toEqual([]);
    expect(touchesOf("Bash", { command: "cat /etc/shadow" })).toEqual([]);
    // A missing or blank path is not a path.
    expect(touchesOf("Read", {})).toEqual([]);
    expect(touchesOf("Read", { file_path: "   " })).toEqual([]);
  });
});

describe("what vault-chat refuses", () => {
  it("lets a call inside the thread's own folder through", () => {
    expect(ruleOnToolUse("Read", { file_path: "notes/ok.md" }, walls)).toBeNull();
    expect(ruleOnToolUse("Write", { file_path: "notes/new.md" }, walls)).toBeNull();
  });

  it("refuses a walled path, reading or writing, and says why", () => {
    const why = ruleOnToolUse("Read", { file_path: join(secret, "keys.json") }, walls);
    expect(typeof why).toBe("string");
    expect(why).toBeTruthy();
    expect(ruleOnToolUse("Write", { file_path: join(secret, "keys.json") }, walls)).toBeTruthy();
    // Another vault's .vault-chat is private however the path is spelled: the
    // decision is on the resolved path, not on how it looks.
    expect(ruleOnToolUse("Read", { file_path: join(vault, "..", "other-vault", ".vault-chat", "keys.json") }, walls)).toBeTruthy();
  });

  it("refuses the whole call when one of its paths is refused", () => {
    expect(ruleOnToolUse("NotebookEdit", { notebook_path: join(secret, "keys.json") }, walls)).toBeTruthy();
  });
});

describe("the deny lists both engines read", () => {
  it("are the sandbox's, plus the private metadata of Carl's own project repos", () => {
    const project = join(root, "project");
    const w = wallsOf({
      denyRead: ["/secrets"],
      denyWrite: ["/secrets"],
      others: () => ["/other-vault/.vault-chat"],
      readOnly: () => [project],
    });
    // A project folder that is Carl's own git repo: the agent works in its clone,
    // so that project's own .vault-chat is his, not the agent's.
    expect(w.denyRead).toEqual(["/secrets", "/other-vault/.vault-chat", join(project, ".vault-chat", "conversations"), join(project, ".vault-chat", "events"), join(project, ".vault-chat", "local")]);
    // Other vaults are hidden from reads; writes are denied the same private paths.
    expect(w.denyWrite).toEqual(["/secrets", join(project, ".vault-chat", "conversations"), join(project, ".vault-chat", "events"), join(project, ".vault-chat", "local")]);
  });

  it("asks nothing of a sandbox that names no extras", () => {
    expect(wallsOf({ denyRead: ["/a"], denyWrite: ["/b"] })).toEqual({ denyRead: ["/a"], denyWrite: ["/b"] });
  });
});

describe("the voice gate's reach", () => {
  it("covers a shell line as well as a write, because that is the way around it", () => {
    // Not a path rule — a rule about what the agent does at all while Carl is on
    // a call. Bash is in the list for the same reason vault-chat's own tools put
    // it there: without it, `bash -c 'echo … > file'` writes around the write gate.
    expect(WRITING_TOOLS).toContain("Bash");
    expect(WRITING_TOOLS).toEqual(expect.arrayContaining(["Write", "Edit", "NotebookEdit"]));
    // Reading is not gated: the agent may still look things up mid-call.
    expect(WRITING_TOOLS).not.toContain("Read");
    expect(WRITING_TOOLS).not.toContain("Grep");
  });
});
