// The composer plugin (Track 1; src/appPlugins.ts COMPOSER_PLUGIN_ID): the chat's text box with its menus, attachments,
// Send / Stop and the model / effort labels (./Composer.tsx), mounted through the plugin host (src/mountHost.ts) with
// the widget contract mount(el, api), under the supervisor's records like Notes and the chat list. The chat pane mounts
// it (src/ComposerPanel.tsx ComposerSlot); turned off or failing, a minimal built-in composer stands in there.
//
// Unchanged for Carl: the composer itself, its keys, its send. Its draft is module state (./draft.ts), shared with the
// fallback and the agent.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): the draft (text, @-references, pictures, files), the
// model and effort, and whether a message can go (and whether one is going) as readable state; set the draft, attach a
// vault file, detach, clear, pick the model or effort, send, stop and focus as actions; `sent` and `attached` events.
// The agent reaches them through PluginRead / PluginAct (server/pluginOffersTool.ts); nothing here is agent-specific.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PluginApi } from "../../mountHost";
import { useStore } from "../../store";
import { aiBlockedNow, chatGateOf } from "../../chatGate";
import { EFFORTS, EFFORT_LABEL, chatModelsNow, isEffort, labelFor, setChatModel } from "../../chatModels";
import { Composer } from "./Composer";
import { attachPaths, clearDraft, hasDraft, onDraftEvent, sendDraft, setFiles, setImages, setInput, setMentions, stopAgent, useDraft } from "./draft";

const S = () => useStore.getState();
const D = () => useDraft.getState();

const draftState = () => {
  const d = D();
  return {
    text: d.input,
    references: d.mentions.map((m) => ({ name: m.name, path: m.rel })),
    images: d.images.map((i) => ({ ...(i.sourcePath ? { name: i.sourcePath.split("/").pop(), source: i.sourcePath } : {}), ...(i.sourceAnchor ? { anchor: i.sourceAnchor } : {}), ...(i.capturedFilePath ? { saved: i.capturedFilePath } : {}) })),
    files: d.files.map((f) => ({ name: f.name, size: f.size })),
    ...(d.attachError ? { attachError: d.attachError } : {}),
  };
};

const modelState = () => {
  const { models, model, effort } = chatModelsNow();
  const on = model || models[0]?.id || "";
  const found = models.find((m) => m.id === on);
  return {
    model: on || null,
    name: found?.name ?? labelFor(models, on) ?? null,
    effort,
    effortLabel: effort ? EFFORT_LABEL[effort] : null,
    models: models.map((m) => ({ id: m.id, name: m.name, efforts: m.efforts })),
  };
};

const sendState = () => {
  const s = S();
  const g = chatGateOf(s);
  const blocked = aiBlockedNow();
  const why = blocked
    ? "signed out of Claude"
    : g.starting
      ? "the box is starting"
      : g.noBox
        ? "no box is connected"
        : g.boxDown
          ? `the box is out of reach${g.reason ? ` (${g.reason})` : ""}`
          : g.archived
            ? "this chat is read-only (an older chat)"
            : !s.vaultPath
              ? "no vault is open"
              : !g.ready
                ? "connecting to the box"
                : null;
  return {
    ready: g.ready && !blocked,
    ...(why ? { why } : {}),
    sending: D().sending > 0,
    busy: s.busy,
    held: g.held,
    waiting: s.messages.filter((m) => m.waiting).length,
    canSend: g.ready && !blocked && hasDraft(),
    button: (s.busy || g.held) && !hasDraft() ? "stop" : "send",
  };
};

/** The plugin's offers (exported for tests). */
export function composerOffers() {
  return {
    state: {
      draft: {
        description: "What is in the composer now: text, references (vault files @-mentioned: name, path), images (attached pictures: name?, source?, anchor?, saved?), files (uploads from outside the vault: name, size) and attachError when the last attach failed.",
        read: draftState,
      },
      model: {
        description: "The model and effort every chat runs on (the labels under the composer): model id, name, effort (low | medium | high | max | null = the model decides), effortLabel, and models (the list: id, name, efforts).",
        read: modelState,
      },
      send: {
        description: "Whether a message can go: ready (and why not), sending (a send still reading its files), busy (the agent is working: a message goes to it at its next step), held (waiting for the usage limit's reset), waiting (messages sent but not read yet), canSend (ready with something in the draft) and button (send | stop: what the composer's button is).",
        read: sendState,
      },
    },
    actions: {
      setDraft: {
        description: "Put text in the composer (replaces the draft's text; append: true adds it after what is there). Nothing is sent.",
        args: { type: "object", properties: { text: { type: "string" }, append: { type: "boolean" } }, required: ["text"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          const t = String(a.text ?? "");
          setInput((prev) => (a.append ? `${prev}${prev && !/\s$/.test(prev) && t ? " " : ""}${t}` : t));
          return { text: D().input };
        },
      },
      attach: {
        description: "Attach a vault file, as the + menu's Add photos & files does: an image becomes a picture on the message, any other file an @-reference in the text (its contents go with the message).",
        args: { type: "object", properties: { path: { type: "string", description: "The file's vault-relative path (or its absolute path in the vault)." } }, required: ["path"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const vault = (S().vaultPath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
          if (!vault) throw new Error("no vault is open");
          const raw = String(a.path ?? "").trim().replace(/\\/g, "/");
          if (!raw) throw new Error("attach needs a path");
          const rel = raw.startsWith(vault + "/") ? raw.slice(vault.length + 1) : raw.replace(/^\.?\//, "");
          if (rel.split("/").includes("..") || /^([a-zA-Z]:|\/)/.test(rel)) throw new Error(`${raw} is not a file in the vault`);
          const abs = `${vault}/${rel}`;
          const known = S().files.find((f) => f.path.replace(/\\/g, "/") === abs);
          if (known?.is_dir) throw new Error(`${rel} is a folder`);
          if (!known && S().files.length > 0) throw new Error(`no file "${rel}" in the vault`);
          const r = await attachPaths([abs]);
          if (r.errors.length) throw new Error(r.errors.join(" "));
          return { attached: r.attached, draft: draftState() };
        },
      },
      detach: {
        description: "Take something off the draft by its name: an attached picture or file, or an @-reference (its @name leaves the text too).",
        args: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          const name = String(a.name ?? "");
          const d = D();
          const img = d.images.findIndex((i) => (i.sourcePath?.split("/").pop() ?? "") === name);
          if (img >= 0) {
            setImages((prev) => prev.filter((_, j) => j !== img));
            return { detached: name, kind: "image" };
          }
          const file = d.files.findIndex((f) => f.name === name);
          if (file >= 0) {
            setFiles((prev) => prev.filter((_, j) => j !== file));
            return { detached: name, kind: "file" };
          }
          const ref = d.mentions.find((m) => m.name === name);
          if (ref) {
            setMentions((prev) => prev.filter((m) => m !== ref));
            setInput((prev) => prev.split(ref.raw).join("").replace(/ {2,}/g, " "));
            return { detached: name, kind: "reference" };
          }
          throw new Error(`nothing named "${name}" is attached`);
        },
      },
      clear: {
        description: "Empty the composer: text, references, pictures, files.",
        run: () => {
          clearDraft();
          return { draft: draftState() };
        },
      },
      setModel: {
        description: "Pick the model every chat runs on (the model label's menu), by its id or name (from the model state).",
        args: { type: "object", properties: { model: { type: "string" } }, required: ["model"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const want = String(a.model ?? "").trim();
          const { models } = chatModelsNow();
          const m = models.find((x) => x.id === want) ?? models.find((x) => x.name.toLowerCase() === want.toLowerCase());
          if (!m) throw new Error(`no model "${want}"${models.length ? ` (models: ${models.map((x) => x.name).join(", ")})` : " (the list loads when the box answers)"}`);
          const why = await setChatModel(S().vaultPath ?? "", S().activeConversationId, { model: m.id });
          if (why) throw new Error(why);
          return modelState();
        },
      },
      setEffort: {
        description: "Pick how hard the model thinks, in every chat (the effort label's menu): low, medium, high or max; null lets the model decide.",
        args: { type: "object", properties: { effort: { type: ["string", "null"], enum: [...EFFORTS, null] } }, required: ["effort"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const e = a.effort === null ? null : isEffort(a.effort) ? a.effort : undefined;
          if (e === undefined) throw new Error(`effort is one of ${EFFORTS.join(", ")} or null`);
          const why = await setChatModel(S().vaultPath ?? "", S().activeConversationId, { effort: e });
          if (why) throw new Error(why);
          return modelState();
        },
      },
      send: {
        description: "Send the draft as Carl's Enter does (with text: that text replaces the draft's first). While the agent works it reads the message at its next step.",
        args: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          if (typeof a.text === "string") setInput(a.text);
          const text = D().input.trim();
          const why = await sendDraft();
          if (why) throw new Error(why);
          return { sent: true, text, to: S().activeConversationId };
        },
      },
      stop: {
        description: "Stop the agent's run in this chat (Esc), or, held for the usage limit, don't pick it up at the reset.",
        run: () => {
          const g = chatGateOf(S());
          if (!S().busy && !g.held) throw new Error("nothing is running in this chat");
          stopAgent();
          return { stopped: true };
        },
      },
      focus: {
        description: "Put the caret in the composer.",
        run: () => {
          window.dispatchEvent(new CustomEvent("vc-focus-composer"));
          return { focused: true };
        },
      },
    },
    events: {
      sent: { description: "A message went from the composer: text, images (how many), files (names), references (vault paths)." },
      attached: { description: "Something was attached: name and kind (image | file | reference)." },
    },
  };
}

export function mount(el: HTMLElement, api: PluginApi): () => void {
  const offers = api.offer(composerOffers());
  const off = onDraftEvent({ sent: (s) => offers.emit("sent", s), attached: (a) => offers.emit("attached", a) });
  api.effect(off);
  // A render error the composer does not catch is the plugin's failure (src/ComposerPanel.tsx then shows its fallback).
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  // The host runs this from the app's own commit: drawn in a microtask right after it (before the browser paints, so
  // the text box is there in the same frame), and unmounted outside of it.
  let alive = true;
  queueMicrotask(() => alive && flushSync(() => root.render(<Composer />)));
  return () => {
    alive = false;
    queueMicrotask(() => root.unmount());
  };
}
