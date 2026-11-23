// The alerts noun (report 28, fix 2): Carl's in-app alerts (the phone's Alerts list, the laptop's in-app alerts):
// what Notify and the box wrote to the vault's notifications.jsonl, read, hidden or cleared, and the push
// subscriptions of his devices. Read: the list (unread first count) and the subscriptions (their push service, never
// their keys). Act: what the phone's controls do (mark read, hide, clear the read ones; a device's push off, test),
// through the same records; the phone's routes call these actions. Watched on each line appended and each
// subscription change. Writing an alert stays Notify (it owns the push decision).
import { notificationsFeed } from "../phoneData";
import { notificationAppend, onAlertsChanged, pushEndpointEnding, pushSubsAdd, pushSubsRemove, pushSubsShown } from "../commands/phone";
import { relay } from "../bus";
import { linkStates } from "../deviceLink";
import { signal } from "../convlog/log";
import type { ActResult, Noun } from "./index";

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const ok = (text: string): ActResult => ({ ok: true, text });

type Feed = { unread: number; notifications: Record<string, unknown>[] };
const slim = (n: Record<string, unknown>) => ({
  id: n.id,
  at: n.ts,
  ...(n.title ? { title: n.title } : {}),
  ...(n.body ? { body: String(n.body).slice(0, 300) } : {}),
  ...(n.kind ? { kind: n.kind } : {}),
  read: n.read === true,
  ...(n.answeredWith ? { answered: n.answeredWith } : {}),
});

export function alertsNoun(vault: string): Noun {
  const feed = () => notificationsFeed(vault) as Feed;
  const known = (id: string) => feed().notifications.some((n) => n.id === id);
  return {
    id: "alerts",
    name: "Alerts",
    state: {
      list: {
        description: "Carl's alerts, newest first (the phone's Alerts list, the laptop's in-app alerts): id, at, title, body, kind, read, answered; unread: how many are not read",
        read: () => {
          const f = feed();
          return { unread: f.unread, alerts: f.notifications.slice(0, 40).map(slim) };
        },
      },
      push: {
        description: "his devices' push subscriptions (the push service's host, the endpoint's last characters, refusals in a row); push on or off per device is that device's own subscription",
        read: () => pushSubsShown(),
      },
    },
    actions: {
      markRead: {
        description: "mark an alert read (as opening it on the phone)",
        args: obj({ id: { type: "string" } }, ["id"]),
        run: (a) => {
          const id = String(a.id ?? "");
          if (!known(id)) return { ok: false, text: `No alert ${id}; nothing changed.` };
          notificationAppend(vault, JSON.stringify({ type: "read", id, ts: Date.now() }));
          return ok(`Alert ${id} is read.`);
        },
      },
      hide: {
        description: "hide an alert from the list (the phone's swipe / Hide), only when Carl asks",
        args: obj({ id: { type: "string" } }, ["id"]),
        run: (a) => {
          const id = String(a.id ?? "");
          if (!known(id)) return { ok: false, text: `No alert ${id}; nothing changed.` };
          notificationAppend(vault, JSON.stringify({ type: "hide", id, ts: Date.now() }));
          return ok(`Alert ${id} is hidden.`);
        },
      },
      clear: {
        description: "clear the read alerts from the list (the phone's Clear archive), only when Carl asks",
        run: () => {
          notificationAppend(vault, JSON.stringify({ type: "clear", ts: Date.now() }));
          return ok("The read alerts are cleared from the list.");
        },
      },
      subscribe: {
        description: "keep a device's push subscription (what the phone's Push on sends once its browser made one)",
        args: obj({ subscription: { type: "object" } }, ["subscription"]),
        run: (a) => {
          const sub = a.subscription as { endpoint?: unknown } | undefined;
          if (typeof sub?.endpoint !== "string") return { ok: false, text: "subscription needs its endpoint; nothing changed." };
          pushSubsAdd(sub);
          return ok("The device's push subscription is kept.");
        },
      },
      unsubscribe: {
        description: "turn push off for a device (the phone's Push off): its subscription, by the endpoint's last characters as push lists them. Only when Carl asks",
        args: obj({ endpoint: { type: "string" } }, ["endpoint"]),
        run: (a) => {
          const want = String(a.endpoint ?? "");
          const full = pushEndpointEnding(want);
          if (!full) return { ok: false, text: `No push subscription ending ${want}; nothing changed.` };
          pushSubsRemove(full);
          return ok("Push is off for that device.");
        },
      },
      pushOnPhone: {
        description: "turn push on or off on the phone, as its switch does (the phone app must be open; on needs its notification permission granted once by Carl's tap). Only when Carl asks",
        args: obj({ on: { type: "boolean" } }, ["on"]),
        run: (a) => {
          if (linkStates().phone.control !== "up") return { ok: false, text: "The phone app is not open (its feed is down); nothing changed." };
          signal(vault, { type: "phone.push", on: a.on === true });
          return ok(`Asked the phone to turn push ${a.on === true ? "on" : "off"}; push (this state) shows its subscription once it has.`);
        },
      },
      test: {
        description: "send a test push to every subscribed device (the phone's Test)",
        run: async () => {
          const out = await relay("phone:pushtest", {}, 15_000);
          if (!out) return { ok: false, text: "No answer from the app that sends pushes; nothing was sent." };
          const r = JSON.parse(out) as { ok?: boolean; error?: string };
          return r.ok ? ok("A test push went to every subscribed device.") : { ok: false, text: `Not sent: ${r.error ?? "unknown"}` };
        },
      },
    },
    watch: (fn) => onAlertsChanged(fn),
  };
}
