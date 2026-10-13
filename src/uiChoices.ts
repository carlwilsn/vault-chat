// Presentation choices Carl has not made yet. Each is a localStorage switch
// between two minimal options (the preview has one scenario per option); the
// first option is the default. Read once per page load.
//
//   thinking   "line"    a collapsed quiet "Thought" line on the reply
//              "toggle"  hidden; a small toggle in the composer row shows all
//   subagents  "inline"  a card per spawn in the thread, under its reply
//              "strip"   a compact strip above the composer
//   cost       "reply"   each reply's cost under it
//              "total"   only the conversation's total, at the top
//   todos      "inline"  the list in the thread
//              "pinned"  pinned above the composer
//   verdict    "thread"  a line at the end of the thread
//              "ongoing" in the ongoing line above the composer
//   ask        "cards"   option cards (the phone's language, desktop style)
//              "buttons" numbered buttons under the question

export const UI_CHOICES = {
  thinking: { key: "vc_ui_thinking", options: ["line", "toggle"] },
  subagents: { key: "vc_ui_subagents", options: ["inline", "strip"] },
  cost: { key: "vc_ui_cost", options: ["reply", "total"] },
  todos: { key: "vc_ui_todos", options: ["inline", "pinned"] },
  verdict: { key: "vc_ui_verdict", options: ["thread", "ongoing"] },
  ask: { key: "vc_ui_ask", options: ["cards", "buttons"] },
} as const;

export type UiChoice = keyof typeof UI_CHOICES;
type OptionOf<C extends UiChoice> = (typeof UI_CHOICES)[C]["options"][number];

const cache = new Map<UiChoice, string>();

export function uiChoice<C extends UiChoice>(c: C): OptionOf<C> {
  const hit = cache.get(c);
  if (hit) return hit as OptionOf<C>;
  const { key, options } = UI_CHOICES[c];
  let v: string | null = null;
  try {
    v = localStorage.getItem(key);
  } catch {
    v = null;
  }
  const out = (options as readonly string[]).includes(v ?? "") ? v! : options[0];
  cache.set(c, out);
  return out as OptionOf<C>;
}
