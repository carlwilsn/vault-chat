// Change ready on the phone (reports/07 corrected model point 4; the laptop's is src/ChangeReadyNotice.tsx). The drafts
// waiting for Carl come from the box (src/changeCards.ts); his word goes through the same supervisor route, so a Keep
// or Discard here clears the card on the laptop and the iPad too, and theirs clear it here.
//
//   - A vault plugin whose draft names the phone (meta devices) can be tried here: the phone's plugin host mounts the
//     draft in place of the live copy on this phone only (nothing on the box changes until Keep). One that throws or
//     does not load discards itself and the card says why.
//   - Anything else (an app plugin's draft, the preset, Carl's settings) is Keep / Discard here; the card says where
//     it can be tried (the laptop) or that the box applies it.
//
// Nothing pending: no element at all, so the phone looks and loads as before (one small request after boot).
import { changeTitle, startChangeCards, type BoxPendingChange, type ChangeCards } from "../../src/changeCards";
import type { PhoneHost } from "./plugins";

type Api = (path: string, opts?: RequestInit) => Promise<Response>;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const key = (c: BoxPendingChange) => `${c.plugin}@${c.version}`;

export type PhoneChanges = { record(ev: unknown): void; cards: ChangeCards; stop(): void };

export function startPhoneChanges(d: { api: Api; host: () => PhoneHost | null; everyMs?: number; visible?: () => boolean }): PhoneChanges {
  const cards = startChangeCards({ api: d.api, surface: "phone", ...(d.everyMs ? { everyMs: d.everyMs } : {}), ...(d.visible ? { visible: d.visible } : {}) });
  let trying: { plugin: string; version: string } | null = null;
  const later = new Set<string>();
  let el: HTMLElement | null = null;
  /** A word from this phone is on its way: its own answer ends the trying, not the list moving under it. */
  let deciding = false;

  const canTry = (c: BoxPendingChange) => c.tryOn.includes("phone") && typeof c.code === "string";
  function setTrying(c: BoxPendingChange | null) {
    trying = c ? { plugin: c.plugin, version: c.version } : null;
    d.host()?.tryDraft(
      c && c.code !== undefined
        ? {
            id: c.plugin,
            name: c.name,
            version: c.version,
            code: c.code,
            fail: (why) => {
              if (trying?.plugin !== c.plugin || trying.version !== c.version) return;
              trying = null;
              const short = why.split("\n")[0]!.slice(0, 200);
              void cards.decide(c.plugin, "discard", c.version, { by: "auto", reason: short, quiet: true });
              say(c, `Discarded by itself: ${short}`, false);
            },
          }
        : null,
    );
  }
  let own: { name: string; text: string; ok: boolean } | null = null;
  function say(c: BoxPendingChange, text: string, ok: boolean) {
    own = { name: c.name, text, ok };
    cards.clearOutcome();
    draw();
  }

  function draw() {
    const list = cards.list();
    // Decided elsewhere (the laptop, the iPad) or gone: stop trying it here.
    if (trying && !deciding && !list.some((c) => c.plugin === trying!.plugin && c.version === trying!.version)) setTrying(null);
    const shown = cards.off() ? null : (list.find((c) => trying && c.plugin === trying.plugin && c.version === trying.version) ?? list.find((c) => !later.has(key(c))) ?? null);
    const o = cards.outcome() ?? own;
    if (!shown && !o) {
      el?.remove();
      el = null;
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = "vc-change";
      el.setAttribute("data-el", "change-ready");
      el.addEventListener("click", onClick);
      document.body.appendChild(el);
    }
    const isTrying = !!shown && !!trying && trying.plugin === shown.plugin && trying.version === shown.version;
    el.toggleAttribute("data-vc-trying", isTrying);
    const busy = cards.busy() ? " disabled" : "";
    let h = "";
    if (shown) {
      const more = list.length > 1 ? ` · ${list.length - 1} more` : "";
      const note = isTrying
        ? "Trying it on this phone. Nothing on the box changes until you keep it."
        : canTry(shown)
          ? ""
          : shown.tryOn.includes("laptop")
            ? "Try it on the laptop, or keep or discard it from here."
            : "The box applies this, so it can't be tried first. Keep sets it; Switch back undoes it.";
      h += `<div class="chg-top"><div class="chg-t" data-el="change-ready-title">${esc(changeTitle(shown))}</div>${isTrying ? "" : `<button class="chg-x" data-a="later" aria-label="Later">×</button>`}</div>`;
      h += `<div class="chg-sub">${esc(shown.name)} · ${esc(shown.version)}${esc(more)}</div>`;
      if (note) h += `<div class="chg-note" data-el="${isTrying ? "change-trying" : "change-direct"}">${esc(note)}</div>`;
      h += `<div class="chg-row">`;
      if (canTry(shown) && !isTrying) h += `<button class="chg-b pri" data-a="try" data-el="change-try"${busy}>Try</button><button class="chg-b" data-a="discard" data-el="change-discard"${busy}>Discard</button>`;
      else h += `<button class="chg-b pri" data-a="keep" data-el="change-keep"${busy}>Keep</button><button class="chg-b" data-a="discard" data-el="change-discard"${busy}>Discard</button>${isTrying ? `<button class="chg-b" data-a="back" data-el="change-back"${busy}>Back</button>` : ""}`;
      h += `</div>`;
    }
    if (o) {
      const kept = !!(cards.outcome()?.kept && o === cards.outcome());
      h += `<div class="chg-out${o.ok ? "" : " bad"}${shown ? " sep" : ""}" data-el="change-outcome"><span>${esc(o.name)}: ${esc(o.text)}</span>${kept ? `<button class="chg-l" data-a="switch" data-el="change-switch-back">Switch back</button>` : ""}<button class="chg-x" data-a="dismiss" aria-label="Dismiss">×</button></div>`;
    }
    el.innerHTML = h;
    el.dataset.plugin = shown?.plugin ?? "";
    el.dataset.version = shown?.version ?? "";
  }

  function onClick(e: Event) {
    const b = (e.target as HTMLElement).closest("button[data-a]") as HTMLButtonElement | null;
    if (!b || b.disabled || !el) return;
    const shown = cards.list().find((c) => c.plugin === el!.dataset.plugin && c.version === el!.dataset.version) ?? null;
    const a = b.dataset.a;
    if (a === "dismiss") {
      own = null;
      cards.clearOutcome();
      return draw();
    }
    if (a === "switch") {
      const o = cards.outcome();
      if (o) void cards.decide(o.plugin, "switch");
      return;
    }
    if (!shown) return;
    own = null;
    if (a === "later") {
      later.add(key(shown));
      return draw();
    }
    if (a === "try") {
      cards.clearOutcome();
      setTrying(shown);
      return draw();
    }
    if (a === "back") {
      setTrying(null);
      return draw();
    }
    if (a === "keep" || a === "discard") {
      // Discard falls back here at once; Keep stops "trying" once the box has it (the live copy is the kept one then).
      if (a === "discard" && trying?.plugin === shown.plugin) setTrying(null);
      deciding = true;
      void cards.decide(shown.plugin, a, shown.version).then((r) => {
        deciding = false;
        if (!r.ok || trying?.plugin !== shown.plugin) return;
        trying = null;
        if (a === "keep") d.host()?.keptDraft();
        else setTrying(null);
        draw();
      });
    }
  }

  const off = cards.subscribe(draw);
  return {
    cards,
    record: (ev) => cards.record(ev),
    stop() {
      off();
      cards.stop();
      setTrying(null);
      el?.remove();
      el = null;
    },
  };
}
