// CONTEXT's test helpers: a temp vault with CONTEXT configured on it.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureContext, resetContextConfig } from "../config";

/** A temp vault with `.vault-chat/`, and a projects home beside it (in no vault), CONTEXT configured on both. */
export function tempVault(): { vault: string; projects: string; cleanup: () => void } {
  const vault = mkdtempSync(join(tmpdir(), "vc-context-"));
  const projects = `${vault}-projects`;
  mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
  mkdirSync(projects, { recursive: true });
  resetContextConfig();
  configureContext({ vault, projectsHome: projects });
  return {
    vault,
    projects,
    cleanup: () => {
      rmSync(vault, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    },
  };
}

export function writeConv(vault: string, meta: Record<string, unknown>, messages: Record<string, unknown>[] = []): void {
  const lines = [JSON.stringify(meta), ...messages.map((m) => JSON.stringify(m))];
  writeFileSync(join(vault, ".vault-chat", "conversations", `${meta.id}.jsonl`), lines.join("\n") + "\n");
}
