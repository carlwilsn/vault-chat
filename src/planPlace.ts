// Presentation only, adapted from 3794b1f4: native writes own their cards.
// Never borrow the conversation-wide cached todos or move a historical plan to
// the live tail. Call on the existing afterClear messages; no history is edited.
type TodoItem = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };
type PlanMessage = {
  role?: string; hidden?: boolean; system?: boolean; waiting?: boolean; mid?: string;
  toolCalls?: { id?: string; name: string; input?: any }[];
};

export type PlanCard = { id: string; index: number; todos: TodoItem[] };

export function planCards(messages: PlanMessage[]): PlanCard[] {
  const cards: PlanCard[] = [];
  let current: PlanCard | undefined;
  messages.forEach((m, index) => {
    if (m.hidden || m.waiting) return;
    if (m.role === "user") { current = undefined; return; }
    if (m.role !== "assistant" || m.system) return;
    for (const call of m.toolCalls ?? []) {
      if (call.name !== "TodoWrite" || !Array.isArray(call.input?.todos)) continue;
      if (!current) {
        current = { id: call.id ?? m.mid ?? `i${index}`, index, todos: call.input.todos };
        cards.push(current);
      } else current.todos = call.input.todos;
    }
  });
  return cards.filter((card) => card.todos.length > 0);
}

/** Pinned UI is only the latest visible input's own write, not old work. */
export function currentPlan(messages: Parameters<typeof planCards>[0]): TodoItem[] {
  let start = -1;
  messages.forEach((m, i) => { if (m.role === "user" && !m.hidden && !m.waiting) start = i; });
  if (start < 0) return []; // Clear/truncation may leave writes without their visible input.
  const cards = planCards(messages.slice(start));
  return cards[cards.length - 1]?.todos ?? [];
}

/** Compatibility selector: no unowned/tail fallback, even while busy. */
export function planIndex(messages: Parameters<typeof planCards>[0], _busy: boolean): number {
  const cards = planCards(messages);
  return cards[cards.length - 1]?.index ?? -1;
}

export function planDone(todos: { status: string }[]): boolean {
  return todos.length > 0 && todos.every((t) => t.status === "completed");
}
