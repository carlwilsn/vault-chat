// Live pages' services (src/liveBridge.ts, server/liveProxy.ts): the one place a service a page can name is declared.
// A page's manifest (<meta name="vc-capabilities" content="ask, mic, voice-lab">) names services; the parser keeps the
// registered ones (in their grant spelling), the grant prompt describes them from here, the page's `vc.service(name)`
// finds their function from here, and the box's gateway opens only the routes a granted service declares here.
// Shared by the app, the phone and the box: no imports.

export type LiveRoute = {
  /** The methods this route takes (the gateway passes GET and POST only). */
  methods: readonly ("GET" | "POST")[];
  /** The box path (with its query) this route covers. */
  path: RegExp;
};

export type LiveService = {
  /** The service's name, as a manifest may write it and `vc.service(name)` looks it up. */
  name: string;
  /** One line for Carl's grant prompt. */
  description: string;
  /** "box": its calls go through the box's gateway, only to `routes`. "host": the app or phone supplies it (no box route). */
  supplier: "box" | "host";
  /** The box routes it covers (supplier "box"); empty for a host service or one the box does not open. */
  routes: readonly LiveRoute[];
  /** Whether a box opens anything for it. false: it may be declared and granted, but the box refuses what it would do. */
  grantable: boolean;
  /** Every live page has it without declaring or granting it (it is not in the grant). */
  always?: boolean;
  /** The `vc.<fn>` that implements it in the page; `vc.service(name)` returns that function. */
  page?: string;
  /** The grant spelling of a manifest word, when the word names this service (its name or an older spelling); else null. */
  capOf(word: string): string | null;
  /** Whether a grant entry (a cap, as capOf returns) belongs to this service. */
  owns(cap: string): boolean;
};

/** Whether a tool name is covered by a granted `tool:` capability (exact, or a glob with `*`). */
export function toolAllowed(caps: readonly string[], name: string): boolean {
  return caps.some((c) => {
    if (!c.startsWith("tool:")) return false;
    const g = c.slice(5);
    return g === name || (g.includes("*") && new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(name));
  });
}

/** The voice lab's operations (server/labProxy.ts), as tool names voice-lab.<op>. */
export const VOICE_LAB_OPS = ["engines", "tts", "stt", "voices"] as const;
const TOOL_CAP_RE = /^tool:[A-Za-z0-9_.*-]{1,80}$/;
/** A `tool:` grant that belongs to the voice lab: named in its namespace, or a glob that covers one of its operations. */
const voiceLabCap = (cap: string) => TOOL_CAP_RE.test(cap) && (cap.slice(5).startsWith("voice-lab") || VOICE_LAB_OPS.some((op) => toolAllowed([cap], `voice-lab.${op}`)));

/** A service named by one word, granted under that same word. */
const named = (s: Omit<LiveService, "capOf" | "owns">): LiveService => ({ ...s, capOf: (w) => (w === s.name ? s.name : null), owns: (c) => c === s.name });

export const LIVE_SERVICES: readonly LiveService[] = [
  named({
    name: "ask",
    description: "Ask the AI questions (read-only; nothing in your vault or chats changes)",
    supplier: "box",
    // A new ephemeral ask (POST), reading (GET) or stopping (POST …/stop) a session the same token started.
    routes: [{ methods: ["GET", "POST"], path: /^\/api\/v1\/side(?:\/[A-Za-z0-9_-]{1,120}(?:\/stop)?)?(?:\?.*)?$/ }],
    grantable: true,
    page: "ask",
  }),
  named({
    name: "mic",
    description: "Use your microphone while you press its record button",
    supplier: "host",
    routes: [],
    grantable: true,
    page: "mic",
  }),
  // An older word, kept exactly as it was (declared and shown, opens nothing; an ask with `persist` is refused): a page
  // starts real conversations through `converse` (change 1.3).
  named({
    name: "persist",
    description: "Start real conversations in your chat list",
    supplier: "box",
    routes: [],
    grantable: false,
  }),
  {
    name: "voice-lab",
    description: "Use the box's voice lab: text-to-speech and speech-to-text engines running on the box (sends it the text or audio you give the page)",
    supplier: "box",
    routes: [{ methods: ["GET", "POST"], path: /^\/api\/v2\/lab\// }],
    grantable: true,
    page: "tool",
    // `voice-lab` is granted as `tool:voice-lab.*`; the older `tool:<name or glob>` spellings stay as they are written.
    capOf: (w) => (w === "voice-lab" ? "tool:voice-lab.*" : voiceLabCap(w) ? w : null),
    owns: voiceLabCap,
  },
  {
    ...named({
      name: "theme",
      description: "Follow the app's light or dark theme and its colours",
      supplier: "host",
      routes: [],
      grantable: true,
      always: true,
      page: "onTheme",
    }),
    // Every live page follows the theme: naming it is fine, it needs no grant.
    capOf: () => null,
    owns: () => false,
  },
  // The page's own state, kept as records in the one log (src/pluginRecords.ts): every view of the page reads the same.
  named({
    name: "state",
    description: "Keep its own saved state on the box (the same in every place the page is open)",
    supplier: "box",
    // Read it (GET, `?after=<seq>&wait=<ms>` waits for a change: subscribe) or set one key (POST {key, value}).
    routes: [{ methods: ["GET"], path: /^\/api\/v2\/plugin\/state(?:\?[^/]*)?$/ }, { methods: ["POST"], path: /^\/api\/v2\/plugin\/state$/ }],
    grantable: true,
    page: "state",
  }),
  named({
    name: "log",
    description: "Add records of what it does to your vault's log",
    supplier: "box",
    routes: [{ methods: ["POST"], path: /^\/api\/v2\/plugin\/log$/ }],
    grantable: true,
    page: "log",
  }),
  // Real conversations in Carl's chat list (src/pluginConverse.ts): start one, send to one, list them, read one.
  named({
    name: "converse",
    description: "Start conversations in your chat list, send messages to them, and read your chats",
    supplier: "box",
    // start/send (POST an intent: only those two), the chat list, and one chat's records after N.
    routes: [
      { methods: ["POST"], path: /^\/api\/v2\/intent$/ },
      { methods: ["GET"], path: /^\/api\/v2\/conversations$/ },
      { methods: ["GET"], path: /^\/api\/v2\/conversations\/[A-Za-z0-9_-]{1,120}\/events(?:\?[^/]*)?$/ },
    ],
    grantable: true,
    page: "converse",
  }),
];

/** The service a grant entry belongs to, if any is registered. */
export function serviceOfCap(cap: string): LiveService | null {
  return LIVE_SERVICES.find((s) => s.owns(cap)) ?? null;
}

/** The registered service a manifest word names (any spelling), if any. */
export function serviceNamed(word: string): LiveService | null {
  const w = word.trim().toLowerCase();
  return LIVE_SERVICES.find((s) => s.name === w || s.capOf(w) !== null) ?? null;
}

/** What a manifest word becomes: a grant entry, accepted without a grant (an `always` service), or refused (unknown). */
export function readNeed(word: string): { cap: string } | { always: true } | { refused: string } | null {
  if (!word) return null;
  for (const s of LIVE_SERVICES) {
    const cap = s.capOf(word);
    if (cap) return { cap };
    if (s.always && word === s.name) return { always: true };
  }
  // Only something shaped like a service name is reported back; anything else is noise and dropped.
  return /^[a-z0-9][a-z0-9_.:*-]{0,79}$/.test(word) && !/^tool:$/.test(word) ? { refused: word } : null;
}

/** The page's view of its services: the granted ones (and those every page has), by name, with their line. */
export function servicesFor(caps: readonly string[]): { name: string; description: string }[] {
  return LIVE_SERVICES.filter((s) => s.always || caps.some((c) => s.owns(c))).map((s) => ({ name: s.name, description: s.description }));
}

/** name → the page's vc function, for the page script. */
export function pageFunctions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of LIVE_SERVICES) if (s.page) out[s.name] = s.page;
  return out;
}
