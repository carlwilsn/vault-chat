// A scenario = one state of vault-chat the harness can boot into: the vault's
// files and history, the conversations, the device's localStorage, the fake
// model's scripts, the sync engine's replies, and (optionally) the UI steps
// that drive the real app to the screen being judged.
import type { LlmConfig } from "../runtime/llm";
import type { HostConfig } from "../runtime/backend/host";
import type { SeedCommit } from "../runtime/backend/memgit";

export type Step =
  | { wait: string; timeout?: number }
  | { click: string; nth?: number; text?: string | RegExp }
  | { key: string; target?: string }
  | { type: string; into: string }
  | { sleep: number }
  /** open a vault file in the viewer (vault-relative) */
  | { file: string; mode?: "view" | "edit" }
  /** make sure the chat pane is shown */
  | { chat: true }
  /** wait until the chat pane is idle (no turn in flight) */
  | { waitIdle: true; timeout?: number }
  /** switch the chat pane to a conversation */
  | { conversation: string }
  | { advance: number }
  | { emit: string; payload?: unknown }
  | { run: (api: StepApi) => unknown | Promise<unknown> };

export type StepApi = {
  vault: string;
  q: (sel: string) => HTMLElement | null;
  qa: (sel: string) => HTMLElement[];
  byText: (text: string | RegExp, sel?: string) => HTMLElement | null;
};

export type BuildCtx = {
  vault: string;
  /** fixture base: "synthetic" or a private one built from a real vault */
  base: string;
  now: number;
  /** write a text file (vault-relative) */
  write: (rel: string, text: string) => void;
  read: (rel: string) => string | null;
  conversations: (convs: unknown[]) => void;
  history: (commits: SeedCommit[]) => void;
  ls: Record<string, string>;
};

export type Scenario = {
  id: string;
  title: string;
  group: string;
  /** What to look at / try, shown in the harness. */
  notes: string;
  /** ISO start time of the scenario clock. */
  clock?: string;
  theme?: "graphite" | "light";
  /** Chat model for the desktop pane (localStorage vault_chat_model). */
  model?: string;
  localStorage?: Record<string, string>;
  llm?: LlmConfig;
  host?: HostConfig;
  /** invoke overrides: value, function, or {error}. */
  overrides?: Record<string, unknown>;
  /** Timer delays to shorten (e.g. {15000: 1500} speeds the box sync loop). */
  fastTimers?: Record<number, number>;
  build?: (ctx: BuildCtx) => void;
  /** Steps run after the app has mounted. */
  open?: Step[];
  /** The conversation open on load. */
  activeConversation?: string;
  /** Phone scenario: adjust the phone's MockDB (built from the same world). */
  phone?: { page?: string; clicks?: string[]; db?: (db: any, now: number) => void };
  /** Surfaces this scenario is meant for. */
  surfaces?: Array<"desktop" | "phone">;
};
