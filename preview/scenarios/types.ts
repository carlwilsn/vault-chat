// A scenario = one state of vault-chat the harness can boot into: the vault's
// files and history, the conversations, the device's localStorage, the fake
// model's scripts, the sync engine's replies, and (optionally) the UI steps
// that drive the real app to the screen being judged.
import type { LlmConfig } from "../runtime/llm";
import type { HostConfig } from "../runtime/backend/host";
import type { SeedCommit } from "../runtime/backend/memgit";

export type Step =
  | { wait: string; timeout?: number }
  /** optional: a control only one side has — clicked if it shows up, skipped otherwise */
  | { click: string; nth?: number; text?: string | RegExp; optional?: boolean }
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

/** What a caption points at: a selector (the last visible match, i.e. the
 *  newest), or elements of `sel` whose text matches `text` (a RegExp source). */
export type Spot = string | { sel?: string; text: string };

/** One narrated beat: a caption, the steps it explains (part of the
 *  scenario's drive), and narrated-only steps (`show`: open a recap, flip a
 *  toggle) that the check never plays. */
export type Beat<S = Step> = { title: string; text: string; spot?: Spot; steps: S[]; show?: S[] };

/** The phone's narrated steps (plain data: the page gets them as JSON). */
export type PhoneStep =
  | { send: string }
  /** __vcPhoneNext() n times, `ms` after each */
  | { next: number; ms?: number }
  | { tap: string; optional?: boolean }
  /** pick a photo (a small rendered chart) with the photo button's input */
  | { photo: true }
  | { sleep: number };

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
  /** The fake host; a function gets the scenario clock's start (box chats with times). */
  host?: HostConfig | ((now: number) => HostConfig);
  /** invoke overrides: value, function, or {error}. */
  overrides?: Record<string, unknown>;
  /** Timer delays to shorten (e.g. {15000: 1500} speeds the box sync loop). */
  fastTimers?: Record<number, number>;
  build?: (ctx: BuildCtx) => void;
  /** Steps run after the app has mounted. */
  open?: Step[];
  /** Stages a check plays one at a time (__preview.play(i)), asserting
   *  between them; `open` usually runs them all. */
  drive?: Step[][];
  /** Narrated mode (the default when opened directly; `&narrate=0` = `open`
   *  at full speed): the beats played with captions instead of `open`. */
  narrate?: Beat[];
  /** The conversation open on load. */
  activeConversation?: string;
  /** Phone scenario: adjust the phone's MockDB (built from the same world). */
  phone?: { page?: string; clicks?: string[]; db?: (db: any, now: number) => void; narrate?: Beat<PhoneStep>[] };
  /** Console errors the scenario provokes on purpose (regex sources). The
   *  self-test lets these through, and fails if one of them never appears. */
  expectedErrors?: string[];
  /** Surfaces this scenario is meant for. */
  surfaces?: Array<"desktop" | "phone">;
};
