// The Ctrl+K / Ctrl+L box as a plugin (Track 1; src/appPlugins.ts ASK_PLUGIN_ID, app/ask). Two parts:
//  - `mount`: mounted once in the main window's overlays (src/App.tsx); it draws nothing and declares what the box
//    offers the agent (api.offer, src/pluginOffers.ts);
//  - `prompt`: the box itself (./Prompt.tsx), mounted by every viewer that opens one through src/InlineEditPrompt.tsx,
//    with its request, editable, onAccept and onCancel as props (api.props, src/pluginProps.ts). Its own React root, so
//    a keystroke in it redraws only the box.
// Turned off, the box is still drawn (in the app's tree) and the agent cannot reach it; failing, a plain box says so
// with Reload and Close. A live copy of app/ask runs this folder (the box, its request to the agent: ./request.ts) instead
// of the built-in one; ./view.ts (the open boxes) is the app's, shared.
//
// Offers: state open (each box on screen: its file, selection, what is typed, the question asked and the answer so
// far, the edit proposed), actions type, submit, accept, close, sendToChat, saveAsNote, focus (each on the box named,
// else the newest; the same as Carl's keys and clicks), events opened, closed, asked, answered, accepted, rejected,
// sentToChat, savedAsNote.
import { useCallback } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { PluginApi } from "../../mountHost";
import type { Offers } from "../../pluginOffers";
import { useProps, type PluginProps } from "../../pluginProps";
import { AskPrompt, type AskPromptProps } from "./Prompt";
import { askBox, askBoxes, onAskEvent } from "./view";

const BOX = { id: { type: "string", description: "The box's id (open: id); left out: the newest box." } };
const ONLY_BOX = { type: "object", properties: BOX, additionalProperties: false };

/** The plugin's offers (exported for tests). */
export function askOffers(): Offers {
  return {
    state: {
      open: {
        description:
          "The Ctrl+K / Ctrl+L boxes open now (usually one): id, file (vault-relative), editable (Ctrl+K in an editor: it may propose an edit), selection, where (a page or line), prompt (typed, not sent), asked (the question it last sent), answer (so far), streaming, error, proposal ({newText, removed}: the edit Accept puts in), turns, images.",
        read: () => askBoxes().map(([, b]) => b.read()),
      },
    },
    actions: {
      type: {
        description: "Put text in a box's input (replaces what is typed; nothing is sent).",
        args: { type: "object", properties: { ...BOX, text: { type: "string" } }, required: ["text"], additionalProperties: false },
        run: (a) => {
          const [id, b] = askBox(a.id);
          b.type(String(a.text ?? ""));
          return { id, prompt: b.read().prompt };
        },
      },
      submit: {
        description: "Send what is typed in a box (or `text`), as Enter: the agent answers or proposes an edit in the box. Returns at once; read open for the answer.",
        args: { type: "object", properties: { ...BOX, text: { type: "string", description: "Type this first." } }, additionalProperties: false },
        run: (a) => {
          const [id, b] = askBox(a.id);
          void b.submit(typeof a.text === "string" ? a.text : undefined);
          return { id, asked: b.read().prompt || b.read().asked };
        },
      },
      accept: {
        description: "Accept the edit the agent proposed in a box (as its Accept): the file takes it and the box closes. Only when Carl asks.",
        args: ONLY_BOX,
        run: (a) => {
          const [id, b] = askBox(a.id);
          if (!b.accept()) throw new Error(`box ${id} has no proposed edit to accept`);
          return { accepted: id };
        },
      },
      close: {
        description: "Close a box (as Esc): a running answer stops, a proposed edit is rejected.",
        args: ONLY_BOX,
        run: (a) => {
          const [id, b] = askBox(a.id);
          b.close();
          return { closed: id };
        },
      },
      sendToChat: {
        description: "Send a box's conversation to the chat (as its chat button): its turns become the open chat's, and the box closes.",
        args: ONLY_BOX,
        run: async (a) => {
          const [id, b] = askBox(a.id);
          await b.sendToChat();
          return { sent: id };
        },
      },
      saveAsNote: {
        description: "Save a box as a note (as its note button): the note composer opens with the selection, the conversation and the source.",
        args: ONLY_BOX,
        run: (a) => {
          const [id, b] = askBox(a.id);
          b.saveAsNote();
          return { note: id };
        },
      },
      focus: {
        description: "Put the cursor in a box's input.",
        args: ONLY_BOX,
        run: (a) => {
          const [id, b] = askBox(a.id);
          b.focus();
          return { focused: id };
        },
      },
    },
    events: {
      opened: { description: "A box opened: id." },
      closed: { description: "A box closed: id." },
      asked: { description: "A box sent a question: id, prompt." },
      answered: { description: "A box's answer finished: id, proposal (an edit was proposed)." },
      accepted: { description: "A proposed edit was accepted: id." },
      rejected: { description: "A box with a proposed edit was closed without accepting it: id." },
      sentToChat: { description: "A box's conversation went to the chat: id." },
      savedAsNote: { description: "A box was saved as a note: id." },
    },
  };
}

/** Offers only (src/App.tsx's overlays): the box itself is the `prompt` part. */
export function mount(_el: HTMLElement, api: PluginApi): void {
  const offers = api.offer(askOffers());
  api.effect(onAskEvent((name, data) => offers.emit(name, data)));
}

function Bound({ props }: { props: PluginProps<AskPromptProps> }) {
  // Accept / Cancel always reach the viewer's newest handlers (a new function alone does not redraw the box).
  const onAccept = useCallback<AskPromptProps["onAccept"]>((r, p) => props.get().onAccept(r, p), [props]);
  const onCancel = useCallback(() => props.get().onCancel(), [props]);
  return <AskPrompt {...useProps(props)} onAccept={onAccept} onCancel={onCancel} />;
}

/** The box, where a viewer opens it (src/InlineEditPrompt.tsx hands it its props). */
export const prompt = {
  mount(el: HTMLElement, api: PluginApi): () => void {
    const props = api.props as PluginProps<AskPromptProps> | undefined;
    if (!props) throw new Error("the Ctrl+K box needs its request (props)");
    let alive = true;
    // A render error the box does not catch is the plugin's failure (src/InlineEditPrompt.tsx then shows its fallback).
    const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
    // Drawn right after the app's commit, before the browser paints.
    queueMicrotask(() => alive && flushSync(() => root.render(<Bound props={props} />)));
    return () => {
      alive = false;
      queueMicrotask(() => root.unmount());
    };
  },
};
