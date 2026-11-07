// Where vault-chat keeps Claude Code's things, per box.
import { join } from "node:path";

export type ClaudePaths = {
  root: string;
  /** Claude Code's own config and HOME, so vault-chat's sessions never see Carl's
   *  plugins, skills or agents (the spike: settingSources:[] still loads them). */
  configDir: string;
  /** The runnable executable, when one had to be wrapped (install.ts). */
  binDir: string;
  /** threadId → Claude Code session id, so a turn after a restart resumes the session. */
  threadsFile: string;
  /** Side-thread sessions and instruction files, as the engine reads them off `paths`. */
  sessionsDir: string;
  instrDir: string;
};

export function claudePaths(stateDir: string): ClaudePaths {
  const root = join(stateDir, "claude");
  return {
    root,
    configDir: join(root, "config"),
    binDir: join(root, "bin"),
    threadsFile: join(root, "threads.json"),
    sessionsDir: join(root, "sessions"),
    instrDir: join(root, "instr"),
  };
}
