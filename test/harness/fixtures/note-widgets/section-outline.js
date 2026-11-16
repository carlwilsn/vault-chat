// An example note widget (src/noteWidgets.ts). Put it in the vault and embed it in a note:
//
//   ```widget
//   widgets/section-outline.js
//   Things to check before the exam
//   ```
//
// It lists the headings of the section it sits in, live as the note changes, with a checkbox each; what is checked is
// its own state (plugin.state records: the same in every window, after a restart). The agent reads and drives it
// through PluginRead / PluginAct (its id is "<note>#widgets/section-outline.js").
export const meta = { name: "Section outline", description: "The headings of the section around it, as a checklist kept in the log." };

export function mount(el, api) {
  const style = el.ownerDocument.createElement("style");
  style.textContent = `.box{border:1px solid hsl(var(--border,0 0% 30%));border-radius:8px;padding:10px 12px;font:13px/1.5 system-ui,sans-serif;color:hsl(var(--foreground,0 0% 90%))}
.box b{display:block;margin-bottom:6px}.box label{display:block;cursor:pointer}.done{opacity:.55;text-decoration:line-through}`;
  el.appendChild(style);
  const box = el.ownerDocument.createElement("div");
  box.className = "box";
  el.appendChild(box);

  const items = () => {
    const sec = api.note.section();
    const start = sec.heading ? sec.heading.line : 0;
    const end = (sec.heading ? sec.heading.line : 1) + sec.text.split("\n").length - 1;
    return api.note.headings().filter((h) => h.line > start && h.line <= end).map((h) => h.text);
  };
  const checked = () => api.state.get("checked") || [];
  const draw = () => {
    const done = new Set(checked());
    box.textContent = "";
    const title = el.ownerDocument.createElement("b");
    title.textContent = api.block.text || (api.note.section().heading || { text: api.note.path }).text;
    box.appendChild(title);
    for (const text of items()) {
      const label = el.ownerDocument.createElement("label");
      const cb = el.ownerDocument.createElement("input");
      cb.type = "checkbox";
      cb.checked = done.has(text);
      api.listen(cb, "change", () => void toggle(text));
      label.appendChild(cb);
      const span = el.ownerDocument.createElement("span");
      span.textContent = " " + text;
      if (done.has(text)) span.className = "done";
      label.appendChild(span);
      box.appendChild(label);
    }
  };
  const toggle = async (text) => {
    const cur = new Set(checked());
    if (cur.has(text)) cur.delete(text);
    else cur.add(text);
    await api.state.set("checked", [...cur]);
    offers.emit("toggled", { text, checked: cur.has(text) });
  };
  const offers = api.offer({
    state: {
      items: { description: "the headings it lists (the section's subheadings)", read: items },
      checked: { description: "the ones checked", read: checked },
    },
    actions: {
      toggle: { description: "check or uncheck one item by its text", args: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, run: ({ text }) => toggle(text) },
    },
    events: { toggled: { description: "an item was checked or unchecked ({text, checked})" } },
  });
  api.note.onChange(draw);
  api.state.onChange(draw);
  draw();
}
