// The first-run tutorial: a vault plugin like any other (mount(el, api), src/vaultPlugins.ts). vault-chat seeds it into
// a brand-new vault on the first run only (src-tauri/src/first_run_tutorial.rs), with Welcome.md and
// Welcome/sample-paper.pdf. Five steps, about five minutes: learn from a PDF, turn it into a note, edit it in place, ask
// for a tool, delete the tutorial. Each step checks for itself that it happened (files, plugin state, the layout) and
// moves on; Skip moves on anyway. Narration: one line per step in the app's local voice when there is one, else
// nothing (the text is all there). Delete it by asking ("delete the tutorial"): that removes this file; Welcome/ stays.
export const meta = {
  name: "Tutorial",
  description:
    "The first-run tutorial (a floating card, five steps). To delete it when the user asks (\"delete the tutorial\"): remove this file, .vault-chat/plugins/tutorial.js; the Welcome/ files stay unless asked. To replay it (\"start the tutorial\"): PluginAct its start action.",
};

const KEY = "vc-tutorial";
const PDF = "Welcome/sample-paper.pdf";

const STORIES = [
  ["Homework night that turned into a feature.", "Late one night I had the problem set on the left and my draft on the right, and asked for hints with no spoilers. Halfway through, editing felt clumsy, so I described a better way. The agent passed it to workers, it shipped, and I was using it the next afternoon."],
  ["Plugins by asking.", "\"Make my cursor a navy pen with an ink trail.\" It was live that day, with no update. A floating calculator, a notepad I can draw on and a menu that switches them all on and off came the same way. Some features I want today and not forever."],
  ["The agent's own update video.", "I asked for a video about what had changed. It wrote a script, gave me a little quiz page to pick the style (it read my clicks back), and rendered a narrated video. Watching it, I noticed the player controls didn't hide. That became a fix too."],
  ["Ideas by voice from the gym.", "Between sets I talked through product ideas on my phone. Back at the laptop: \"make an md of those and open it.\" That page became the plan for the plugin system."],
  ["vault-chat builds vault-chat.", "Most of the app was built by using it: I notice a gap, say so, and agents build it, check it and ship it. This tutorial was made the same way."],
];

export function mount(el, api) {
  const h = api.host;
  const key = (id, fallback) => h.shortcut?.(id) || fallback;
  const K = { ask: key("edit.ask", "Ctrl+L"), edit: key("edit.inline", "Ctrl+K"), full: key("view.fullscreen", "Ctrl+Shift+F") };

  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {}
  const st = {
    step: typeof saved.step === "number" ? saved.step : 0,
    hidden: !!saved.hidden,
    muted: !!saved.muted,
    note: typeof saved.note === "string" ? saved.note : null,
    results: saved.results && typeof saved.results === "object" ? saved.results : {},
    board: null,
  };
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ step: st.step, hidden: st.hidden, muted: st.muted, note: st.note, results: st.results }));
    } catch {}
  };

  // ---------- the checks: each step's own way of seeing it happened
  const askAnswers = async () => {
    const r = await api.plugins.read("app/ask", "open");
    const boxes = r && r.ok !== false ? (r.state?.open ?? r.open ?? r.value ?? []) : [];
    return (Array.isArray(boxes) ? boxes : []).filter((b) => b && !b.streaming && typeof b.answer === "string").map((b) => b.answer);
  };
  const lastAssistant = () => {
    const m = h.state().lastMessage;
    return m && m.role === "assistant" ? m : null;
  };
  const notePane = () => {
    const panes = h.layout.get().panes || [];
    const pdf = panes.some((p) => /sample-paper\.pdf$/i.test(p.file));
    const md = panes.find((p) => /\.md$/i.test(p.file) && !/(^|\/)Welcome\.md$/i.test(p.file));
    return pdf && md ? md.file : null;
  };
  const listPlugins = () => api.plugins.list().map((p) => p.id);
  const hasSomething = (v) =>
    v == null ? false : Array.isArray(v) ? v.length > 0 : typeof v === "object" ? Object.values(v).some(hasSomething) : typeof v === "number" ? v > 0 : v !== "" && v !== false;

  const STEPS = [
    {
      id: "learn",
      title: "Learn from a PDF",
      say: "Hi, I'm your vault's agent. I can see what you're reading. Open the sample paper and ask me about the map.",
      body: () => [
        ["p", `Open `, ["a", "sample-paper.pdf", () => h.openFile(PDF)], `. Press `, ["kbd", K.ask], ` and ask: `, ["q", "What is this map telling me?"]],
        ["tip", `Tip: press `, ["kbd", K.full], ` to make the chat full screen, and again to go back.`],
      ],
      waiting: "Waiting for an answer about the map",
      enter(b) {
        b.last = lastAssistant()?.id ?? null;
      },
      async check(b) {
        const good = (t) => /pump|page 2/i.test(t || "");
        if (b.heard || (await askAnswers()).some(good)) return true;
        const m = lastAssistant();
        return !!m && m.id !== b.last && good(m.content);
      },
    },
    {
      id: "note",
      title: "Turn it into a note",
      say: "Reading is half of it. Ask me to write it up, and I'll put the note next to the paper.",
      body: () => [["p", `In the chat, ask: `, ["q", "Make me a one-page note on this paper and open it next to the PDF."]]],
      waiting: "Waiting for a note beside the PDF",
      async check() {
        const file = notePane();
        if (!file) return false;
        const text = await h.readFile(file);
        if (!text || !/^#{1,3}\s+\S/m.test(text) || (text.match(/^\s*[-*]\s+\S/gm) || []).length < 3) return false;
        st.note = file;
        return true;
      },
    },
    {
      id: "edit",
      title: "Edit it in place",
      say: "Now it's your note. Select a line, press command K, and tell me what to change.",
      sayElsewhere: "Now it's your note. Select a line, press control K, and tell me what to change.",
      body: () => [
        ["p", `Select any bullet in the note. Press `, ["kbd", K.edit], ` and say `, ["q", "make this shorter"], ` or `, ["q", "add an example"], `.`],
        ["tip", "The change shows in place: Accept keeps it, Esc drops it."],
      ],
      waiting: "Waiting for the note to change on disk",
      async enter(b) {
        b.file = st.note || notePane();
        b.text = b.file ? await h.readFile(b.file) : null;
      },
      async check(b) {
        if (!b.file) {
          b.file = st.note || notePane();
          b.text = b.file ? await h.readFile(b.file) : null;
          return false;
        }
        const now = await h.readFile(b.file);
        return now != null && b.text != null && now !== b.text;
      },
    },
    {
      id: "tool",
      title: "Ask for a tool, get it live",
      say: "Here's the fun part. The app itself is something you can ask for. Ask me for a tool and watch it show up. No restart.",
      body: () => [
        ["p", `Ask: `, ["q", "Make me a flashcard tool that quizzes me on my note."], ` Then answer two or three cards.`],
        ["tip", `Each answer is saved where the agent can read it: ask `, ["q", "how did I do?"], `. "Turn it off" hides it; "turn it back on" brings it back.`],
      ],
      waiting: "Waiting for a new tool with an answer saved",
      enter(b) {
        b.before = listPlugins();
      },
      async check(b) {
        for (const id of listPlugins()) {
          if (id === api.path || id.startsWith("app/") || (b.before || []).includes(id)) continue;
          const r = await api.plugins.read(id);
          if (r && r.ok !== false && hasSomething(r.state ?? r)) return true;
        }
        return false;
      },
    },
    {
      id: "board",
      title: "Flex: your iPad board",
      only: () => st.board === true,
      say: "You've got an iPad paired. Let's use it. I'll send you a question, you answer in ink, and I'll check it.",
      body: () => [["p", `Ask: `, ["q", "Send me one question about the map to my board."], ` Answer it with the pen, then ask `, ["q", "Look at my board. Am I right?"]]],
      waiting: "Waiting for the agent to look at your board",
      enter(b) {
        b.asked = false;
        b.last = lastAssistant()?.id ?? null;
      },
      async check(b) {
        const m = h.state().lastMessage;
        if (m && m.role === "user" && /look at my board/i.test(m.content || "")) b.asked = true;
        const a = lastAssistant();
        return b.asked && !!a && a.id !== b.last;
      },
    },
    {
      id: "delete",
      title: "Delete me",
      say: "That's the tour. One last thing: this tutorial is a plugin too. If you're done with it, just ask me to delete it.",
      body: () => [
        ["p", `This tutorial is a plugin, made by asking. Say `, ["q", "delete the tutorial"], ` and it's gone. Or keep it, and read how Carl uses vault-chat first.`],
        ["tip", "The sample paper and your note stay unless you ask for them gone too. To see this again later, ask: \"start the tutorial\"."],
      ],
      last: true,
    },
  ];

  // ---------- the card
  const root = document.createElement("div");
  root.setAttribute("data-el", "tutorial");
  root.style.cssText =
    "position:fixed;left:16px;bottom:16px;z-index:45;width:360px;max-width:calc(100vw - 32px);max-height:calc(100vh - 80px);overflow:auto;" +
    "background:hsl(var(--card));color:hsl(var(--card-foreground));border:1px solid hsl(var(--border));border-radius:12px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.35);font:13px/1.5 system-ui,-apple-system,sans-serif;padding:14px 16px 12px";
  document.body.appendChild(root);
  api.effect(() => root.remove());

  const css = {
    kbd: "display:inline-block;padding:0 5px;border:1px solid hsl(var(--border));border-bottom-width:2px;border-radius:5px;font:12px ui-monospace,monospace;background:hsl(var(--accent))",
    q: "font-style:italic",
    a: "color:inherit;text-decoration:underline;cursor:pointer",
    btn: "all:unset;cursor:pointer;padding:4px 10px;border-radius:7px;border:1px solid hsl(var(--border));font-size:12px",
    primary: "all:unset;cursor:pointer;padding:4px 12px;border-radius:7px;background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-size:12px;font-weight:600",
    icon: "all:unset;cursor:pointer;padding:0 5px;border-radius:5px;opacity:.7;font-size:13px",
  };
  const make = (tag, style, text) => {
    const e = document.createElement(tag);
    if (style) e.style.cssText = style;
    if (text != null) e.textContent = text;
    return e;
  };
  const inline = (parts, into) => {
    for (const p of parts) {
      if (typeof p === "string") into.append(p);
      else if (p[0] === "kbd") into.append(make("kbd", css.kbd, p[1]));
      else if (p[0] === "q") into.append(make("span", css.q, `"${p[1]}"`));
      else if (p[0] === "a") {
        const a = make("a", css.a, p[1]);
        a.setAttribute("role", "link");
        api.listen(a, "click", () => void p[2]());
        into.append(a);
      }
    }
  };

  const visible = () => STEPS.filter((s) => !s.only || s.only());
  let showStories = false;
  let bag = {};
  let passed = false;
  let spoken = -1;

  function render() {
    root.replaceChildren();
    root.style.display = st.hidden ? "none" : "";
    if (st.hidden) return;
    const steps = visible();
    const step = STEPS[st.step] || STEPS[STEPS.length - 1];
    const at = Math.max(0, steps.indexOf(step));
    root.setAttribute("data-step", step.id);

    const top = make("div", "display:flex;align-items:center;gap:8px;margin-bottom:6px");
    top.append(make("span", "font-size:11px;opacity:.65;margin-right:auto", `Tutorial · step ${at + 1} of ${steps.length}`));
    const mute = make("button", css.icon, st.muted ? "🔇" : "🔈");
    mute.title = st.muted ? "Narration off: turn it on" : "Narration on: turn it off";
    api.listen(mute, "click", () => {
      st.muted = !st.muted;
      persist();
      render();
    });
    const close = make("button", css.icon, "×");
    close.title = "Hide the tutorial (ask \"start the tutorial\" to see it again)";
    close.setAttribute("data-tutorial", "hide");
    api.listen(close, "click", () => hide());
    top.append(mute, close);
    root.append(top);

    root.append(make("div", "font-size:15px;font-weight:650;margin-bottom:6px", step.title));
    for (const [kind, ...parts] of step.body()) {
      const p = make("p", kind === "tip" ? "margin:6px 0 0;font-size:12px;opacity:.75" : "margin:0");
      inline(parts, p);
      root.append(p);
    }

    const foot = make("div", "display:flex;align-items:center;gap:8px;margin-top:12px");
    if (step.last) {
      const stories = make("button", css.btn, showStories ? "Hide the stories" : "How Carl uses vault-chat");
      stories.setAttribute("data-tutorial", "stories");
      api.listen(stories, "click", () => {
        showStories = !showStories;
        render();
      });
      const done = make("button", css.primary, "Finish");
      done.setAttribute("data-tutorial", "finish");
      api.listen(done, "click", () => hide());
      foot.append(make("span", "margin-right:auto"), stories, done);
    } else {
      const status = make("span", "margin-right:auto;font-size:11.5px;opacity:.75", passed ? "✓ Done" : `${step.waiting}…`);
      status.setAttribute("data-tutorial", passed ? "passed" : "waiting");
      const skip = make("button", css.btn, "Skip");
      skip.title = "Skip this step";
      skip.setAttribute("data-tutorial", "skip");
      api.listen(skip, "click", () => advance("skipped"));
      foot.append(status, skip);
    }
    root.append(foot);

    if (step.last && showStories) {
      const s = make("div", "margin-top:12px;border-top:1px solid hsl(var(--border));padding-top:10px");
      s.setAttribute("data-tutorial", "stories-page");
      s.append(make("div", "font-weight:650;margin-bottom:4px", "How Carl uses vault-chat"));
      s.append(
        make(
          "p",
          "margin:0 0 8px;font-size:12px;opacity:.85;font-style:italic",
          "The idea: human-in-the-loop, maxed out. The agent has rich context (your open files, your screen, your board, your history). You have good ways in (split view, " +
            `${K.edit} and ${K.ask}, voice on your phone, ink on an iPad, pages you click). Either side can step in from any of them. It's one assistant for learning, for notes and for building.`,
        ),
      );
      STORIES.forEach(([title, text], i) => {
        const p = make("p", "margin:0 0 8px;font-size:12px");
        p.append(make("b", null, `${i + 1}. ${title} `), text);
        s.append(p);
      });
      root.append(s);
    }

    if (!st.muted && spoken !== st.step) {
      spoken = st.step;
      const mac = /^⌘/.test(K.edit);
      void h.speak((!mac && step.sayElsewhere) || step.say);
    }
  }

  async function enter() {
    bag = {};
    passed = false;
    const step = STEPS[st.step];
    if (step && step.enter) {
      try {
        await step.enter(bag);
      } catch {}
    }
    render();
  }

  function advance(how) {
    const step = STEPS[st.step];
    if (step && !step.last) {
      st.results[step.id] = how;
      emit.emit("step", { step: step.id, result: how });
    }
    let next = st.step + 1;
    while (STEPS[next] && STEPS[next].only && !STEPS[next].only()) next++;
    st.step = Math.min(next, STEPS.length - 1);
    persist();
    void enter();
  }

  function hide() {
    st.hidden = true;
    persist();
    render();
  }

  function start() {
    st.step = 0;
    st.hidden = false;
    st.results = {};
    st.note = null;
    spoken = -1;
    persist();
    void enter();
  }

  // ---------- the loop: every 1.5 s, the step's check; a pass shows "Done" and moves on
  let checking = false;
  api.timer(
    async () => {
      const step = STEPS[st.step];
      if (st.hidden || checking || passed || !step || step.last || !step.check) return;
      checking = true;
      try {
        if (await step.check(bag)) {
          passed = true;
          render();
          api.timer(() => advance("passed"), 1200);
        }
      } catch {
        /* a check that cannot tell yet: try again */
      } finally {
        checking = false;
      }
    },
    1500,
    true,
  );

  const emit = api.offer({
    state: {
      progress: {
        description: "The tutorial now: the step shown (id, title), whether the card is hidden, and each step's result so far (passed / skipped).",
        read: () => ({ step: (STEPS[st.step] || {}).id, title: (STEPS[st.step] || {}).title, hidden: st.hidden, results: st.results, note: st.note, board: st.board }),
      },
    },
    actions: {
      start: { description: "Start the tutorial again from step 1 and show it (when the user asks to start or replay the tutorial).", run: () => (start(), { ok: true }) },
      skip: { description: "Skip the step shown (as its Skip button).", run: () => (advance("skipped"), { ok: true, step: STEPS[st.step].id }) },
      hide: { description: "Hide the tutorial card (it stays installed; start shows it again). To delete it, remove its file instead.", run: () => (hide(), { ok: true }) },
    },
    events: { step: { description: "A step finished: {step, result: passed | skipped}." } },
  });

  // A Cmd/Ctrl+L answer may be closed before the next look: catch it as it finishes.
  api.plugins.on("app/ask", "answered", () => {
    if (STEPS[st.step]?.id !== "learn") return;
    const b = bag;
    void askAnswers().then((all) => {
      if (all.some((t) => /pump|page 2/i.test(t))) b.heard = true;
    });
  });

  void h.boardPaired().then((b) => {
    st.board = b;
    if (STEPS[st.step]?.only && !STEPS[st.step].only()) advance("skipped");
    else render();
  });
  void enter();
}
