// Registers every node-implemented invoke command. See server/COMMANDS.md.
import { registerAll } from "./registry";
import { fsCommands } from "./fs";
import { conversationCommands } from "./conversations";
import { procCommands } from "./proc";
import { gitCommands } from "./gitcmds";
import { netCommands } from "./net";
import { phoneCommands } from "./phone";
import { keychainCommands } from "../keys";
import DEFAULT_SYSTEM_MD from "../../src-tauri/defaults/system.md";
import DEFAULT_VOICE_MD from "../../src-tauri/defaults/voice.md";
import DEFAULT_SUPERVISOR_MD from "../../src-tauri/defaults/supervisor.md";
import DEFAULT_ASSISTANT_MD from "../../src-tauri/defaults/assistant.md";
import DEFAULT_ASK_MD from "../../src-tauri/defaults/ask.md";

let done = false;
export function registerCommands(): void {
  if (done) return;
  done = true;
  registerAll(fsCommands);
  registerAll(conversationCommands);
  registerAll(procCommands);
  registerAll(gitCommands);
  registerAll(netCommands);
  registerAll(phoneCommands);
  registerAll(keychainCommands);
  registerAll({
    // lib.rs:6511-6546 — the bundled default agent prompts (meta.ts seeds
    // .vault-chat/agent/*.md from these).
    default_system_prompt: () => DEFAULT_SYSTEM_MD,
    default_voice_prompt: () => DEFAULT_VOICE_MD,
    default_supervisor_prompt: () => DEFAULT_SUPERVISOR_MD,
    default_assistant_prompt: () => DEFAULT_ASSISTANT_MD,
    default_ask_prompt: () => DEFAULT_ASK_MD,
  });
}
