// The agent's control link to each device app: what carries Act, Screen, Layout, PluginRead / PluginAct, LaptopBuild,
// Drive and Timing to the laptop (and plugin calls to the phone). It is the app's own feed (/poll, long-polled: each
// poll is the heartbeat, and the app's feed loop reconnects by itself with backoff, src/boxChat.ts) plus the acks it
// posts back (POST /api/v1/show/<id>/ack). Carl's chat rides the same feed, but the control signals once went only to
// the vault the app had open: after a vault switch in the app the tools of a chat in the other vault said "offline"
// for good and their signals went nowhere (2026-11-17). Now the feed carries control signals from every vault
// (server/convlog/log.ts CONTROL_SIGNALS) and this module tracks each device across vaults:
//   - up: a poll from it is open, or ended under LIVE_GRACE_MS ago (the next one starts at once);
//   - down since: when its last poll ended, with why; the chat link (Carl's last message from that device) beside it;
//   - unanswered: requests it was sent and did not ack, since its last answer (a wedged app shows here, not as "offline").
// Pure in-memory state; Health (GET /api/v1/health `links`) shows it.

export type LinkClient = "laptop" | "phone";
const CLIENTS: LinkClient[] = ["laptop", "phone"];
const NAME: Record<LinkClient, string> = { laptop: "laptop", phone: "phone" };

/** A device whose last poll ended this long ago still counts as up (as server/show.ts's presence). */
export const LIVE_GRACE_MS = 8_000;

type Link = {
  open: number;
  /** When a poll last started or ended. */
  last: number;
  /** The vault the newest poll follows (the vault open in that app). */
  vault: string | null;
  /** Every vault a poll follows now, or followed under LIVE_GRACE_MS ago (an app can follow more than one feed). */
  feeds: Map<string, { open: number; last: number }>;
  /** When the link last came up (first poll after being down). */
  upSince: number | null;
  /** Carl's last message (intent) from this device. */
  chatLast: number;
  /** Requests sent since its last answer that it did not answer in time. */
  missed: number;
  missedSince: number | null;
  lastMiss: { type: string; at: number } | null;
  lastAnswer: number;
};

const links = new Map<LinkClient, Link>();
const upFns = new Set<(c: LinkClient) => void>();
/** Hear a device's link come up (its first poll after being down, server/deviceQueue.ts runs what waited). */
export function onLinkUp(fn: (c: LinkClient) => void): () => void {
  upFns.add(fn);
  return () => void upFns.delete(fn);
}
let bootAt = Date.now();

const asClient = (c: string | null | undefined): LinkClient | null => (CLIENTS.includes(c as LinkClient) ? (c as LinkClient) : null);
const linkOf = (c: LinkClient): Link => {
  let l = links.get(c);
  if (!l) {
    l = { open: 0, last: 0, vault: null, feeds: new Map(), upSince: null, chatLast: 0, missed: 0, missedSince: null, lastMiss: null, lastAnswer: 0 };
    links.set(c, l);
  }
  return l;
};
const isUp = (l: Link | undefined, now: number) => !!l && (l.open > 0 || (l.last > 0 && now - l.last < LIVE_GRACE_MS));

/** A feed poll from `client` on `vault` started: call the returned function when it ends. */
export function linkOpened(vault: string, client: string | null | undefined, now = Date.now()): () => void {
  const c = asClient(client);
  if (!c) return () => {};
  const l = linkOf(c);
  if (!isUp(l, now)) {
    l.upSince = now;
    for (const f of [...upFns]) queueMicrotask(() => {
      try {
        f(c);
      } catch {
        /* a listener's own error */
      }
    });
  }
  l.open++;
  l.last = now;
  l.vault = vault;
  const fk = normVault(vault);
  const f = l.feeds.get(fk) ?? { open: 0, last: 0 };
  f.open++;
  f.last = now;
  l.feeds.set(fk, f);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    l.open = Math.max(0, l.open - 1);
    l.last = Date.now();
    f.open = Math.max(0, f.open - 1);
    f.last = l.last;
  };
}

/** Carl sent something from `client` (a chat intent): the chat link is up. */
export function chatSeen(client: string | null | undefined, now = Date.now()): void {
  const c = asClient(client);
  if (c) linkOf(c).chatLast = now;
}

/** A control request to `client` was answered (true) or not answered in time (false). */
export function noteAnswer(client: string | null | undefined, type: string, answered: boolean, now = Date.now()): void {
  const c = asClient(client);
  if (!c) return;
  const l = linkOf(c);
  if (answered) {
    l.missed = 0;
    l.missedSince = null;
    l.lastAnswer = now;
    return;
  }
  if (!l.missed) l.missedSince = now;
  l.missed++;
  l.lastMiss = { type, at: now };
}

/** Is `client`'s control link up (its app follows the feed, whatever vault it has open)? */
export function controlLive(client: LinkClient, now = Date.now()): boolean {
  return isUp(links.get(client), now);
}

/** The vault `client`'s app has open now (its newest poll), or null when unknown. */
export function linkVault(client: LinkClient): string | null {
  return links.get(client)?.vault ?? null;
}

/** A vault's folder name (how Carl and the vault picker name it). */
export const vaultName = (v: string): string => v.split(/[\\/]/).filter(Boolean).pop() ?? v;

/**
 * The laptop app has another vault open than `vault` (the one a chat, a file or a change belongs to): that open vault,
 * else null (the same vault, or not known). The one answer every tool uses: Show switches the app there, Layout and
 * PluginRead/Act act on the open one, a change applied in `vault` is not on screen until Carl switches, and the "you"
 * layer says it. The truth is the app's newest feed poll (each names the vault it follows).
 */
export function laptopElsewhere(vault: string, now = Date.now()): string | null {
  const l = links.get("laptop");
  const v = l?.vault;
  if (!v || normVault(v) === normVault(vault)) return null;
  // It follows this vault's feed too (now, or a moment ago): this vault is on it.
  const f = l.feeds.get(normVault(vault));
  if (f && (f.open > 0 || now - f.last < LIVE_GRACE_MS)) return null;
  return v;
}

function normVault(x: string): string {
  return x.replace(/[\\/]+$/, "").toLowerCase();
}

const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const ago = (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);

export type LinkState = {
  client: LinkClient;
  control: "up" | "down";
  /** up: since when; down: since when (its last poll ended, or the box started when it never connected). */
  since: string;
  /** Why it is down (null when up). */
  reason: string | null;
  vault: string | null;
  chat: "up" | "down" | "unknown";
  chatLast: string | null;
  /** Requests sent since its last answer that went unanswered (an app that is connected but not answering). */
  unanswered: number;
  unansweredSince: string | null;
  lastUnanswered: { type: string; at: string } | null;
  lastAnswer: string | null;
};

/** The chat link: up when Carl sent something from that device in the last 30 min (or its feed is up). */
const CHAT_RECENT_MS = 30 * 60_000;

export function linkState(client: LinkClient, now = Date.now()): LinkState {
  const l = links.get(client);
  const up = isUp(l, now);
  const chatRecent = !!l?.chatLast && now - l.chatLast < CHAT_RECENT_MS;
  return {
    client,
    control: up ? "up" : "down",
    since: iso(up ? (l!.upSince ?? l!.last) : l?.last || bootAt),
    reason: up
      ? null
      : !l?.last
        ? `the ${NAME[client]} app has not connected since the box started (${iso(bootAt)})`
        : `no feed poll from the ${NAME[client]} app for ${ago(now - l.last)} (the app is closed, asleep, off the network, or the box restarted and it has not reconnected yet)`,
    vault: l?.vault ?? null,
    chat: up || chatRecent ? "up" : l?.chatLast ? "down" : "unknown",
    chatLast: l?.chatLast ? iso(l.chatLast) : null,
    unanswered: l?.missed ?? 0,
    unansweredSince: l?.missedSince ? iso(l.missedSince) : null,
    lastUnanswered: l?.lastMiss ? { type: l.lastMiss.type, at: iso(l.lastMiss.at) } : null,
    lastAnswer: l?.lastAnswer ? iso(l.lastAnswer) : null,
  };
}

/** Every device's link, for Health. */
export function linkStates(now = Date.now()): Record<LinkClient, LinkState> {
  return Object.fromEntries(CLIENTS.map((c) => [c, linkState(c, now)])) as Record<LinkClient, LinkState>;
}

/** Why the control link to `client` is down, as a tool says it ("control link down since <t>: <reason>; chat link
 *  up"), or null when it is up. */
export function controlDown(client: LinkClient, now = Date.now()): string | null {
  const s = linkState(client, now);
  if (s.control === "up") return null;
  const l = links.get(client);
  const chat =
    s.chat === "up"
      ? `chat link up (Carl's last message from the ${NAME[client]} ${ago(now - (l?.chatLast ?? now))} ago): he is there, but its app is not following the feed right now`
      : s.chat === "down"
        ? `chat link down too (Carl's last message from the ${NAME[client]} ${ago(now - (l?.chatLast ?? now))} ago)`
        : "no chat from it either";
  return `The ${NAME[client]} isn't online: control link down since ${s.since}: ${s.reason}; ${chat}.`;
}

/** A note for a tool's "did not answer": the app is connected but has left requests unanswered. */
export function unansweredNote(client: LinkClient, now = Date.now()): string {
  const s = linkState(client, now);
  if (s.control === "down") return ` ${controlDown(client, now)}`;
  return s.unanswered > 1 ? ` The ${NAME[client]}'s feed is up, but it has not answered ${s.unanswered} requests in a row since ${s.unansweredSince} (the app may be busy or stuck; LaptopBuild or Screen tells).` : "";
}

/** Tests: forget every device. */
export function resetLinks(now = Date.now()): void {
  links.clear();
  bootAt = now;
}
