import { MemoryBox } from "../../src/convlog/memoryBox";
export function installMock() {
  const now = Date.now();
  // Auto-play the supervisor m1 working→idle→(stale trailing frame) lifecycle
  // once on load, so the mock demonstrates a live supervisor edge and settling
  // to "waiting". Re-arm any time from a test with `window.__m1seq = 1`.
  if (typeof window.__m1seq === "undefined") window.__m1seq = 1;
  // The preview harness (preview/phone.mjs) hands in a scenario DB here.
  const ROOT: MockDB = window.__VC_PREVIEW_DB__ || {
    vault: "summer", model: "claude-opus-4-8",
    convs: [
      { id: "m1", title: "BitNet 160M MVP", source: "mission", role: "supervisor", mission: "BitNet 160M MVP", lastActivityAt: now - 120000, msgCount: 9, preview: "seeds 1 & 3 verified; seed 2 rerunning", goal: "MISSION BRIEF (user-approved). Reproduce the BitNet 160M MVP.\n\nDone when (each defines completion — likely one worker each):\n- All 3 seeds trained, eval.loss committed for each\n- The three seeds land within 0.005 nat of each other\n- A short writeup lands under docs/", taskSummary: "Reproduce the BitNet 160M MVP across 3 seeds", statusSummary: "Seeds 1 & 3 verified; seed 2 rerunning", thinkingDigest: "Seeds 1 and 3 landed within tolerance, but seed 2 came in 0.13 nat high — likely an LR mismatch, so it respawned that worker at seed 1's learning rate rather than accept the gap. Holding the eval/writeup worker until seed 2 confirms.", doneWhenDone: ["All 3 seeds trained, eval.loss committed for each"] },
      { id: "m2", title: "Quiet watch — repo hygiene", source: "mission", role: "supervisor", mission: "Quiet watch — repo hygiene", lastActivityAt: now - 3600000, msgCount: 4, preview: "all clean on last sweep; next check at 9pm", goal: "MISSION BRIEF (user-approved). Quiet watch on repo hygiene.\n\nDone when:\n- No uncommitted drift older than 30 min\n- main pre-commit hook green", completedAt: now - 1800000 },
      { id: "m3", title: "Scrapped — LR sweep", source: "mission", role: "supervisor", mission: "Scrapped — LR sweep", lastActivityAt: now - 9000000, msgCount: 2, preview: "stopped by user before it finished", goal: "MISSION BRIEF (user-approved). Sweep learning rates.\n\nDone when:\n- best LR committed", completedAt: now - 5400000, missionState: "KILLED" },
      { id: "w2", title: "seed-2 retry", source: "worker", role: "", mission: "BitNet 160M MVP", lastActivityAt: now - 60000, msgCount: 4, preview: "seed 2 retry running at matched LR", goal: "retry seed 2 at seed 1's LR; commit eval.loss", taskSummary: "Retry seed 2 at seed 1's LR", statusSummary: "Training relaunched; eval pending" },
      { id: "w4", title: "eval + writeup", source: "worker", role: "", mission: "BitNet 160M MVP", lastActivityAt: now - 30000, msgCount: 3, preview: "building the comparison table + writeup", goal: "build the per-seed comparison table and draft the writeup under docs/", taskSummary: "Per-seed comparison table + writeup", statusSummary: "Drafting the comparison table" },
      { id: "w1", title: "3-seed BitNet repro", source: "worker", role: "", mission: "BitNet 160M MVP", lastActivityAt: now - 1080000, msgCount: 6, preview: "all three seeds done; gap held at +0.13 nat", goal: "train + eval seeds 42/43/44 on the 1700-step config" },
      { id: "sup", title: "cockpit nav testing", source: "phone", role: "supervisor", lastActivityAt: now - 300000, msgCount: 14, preview: "shipped the unified app; working through nav", goal: "" },
      { id: "c1", title: "densing law — readings", source: "manual", role: "", lastActivityAt: now - 5400000, msgCount: 10, preview: "the crossover moves with task difficulty, not just scale", goal: "" },
      { id: "cL", title: "scaling-law deep dive — the long one", source: "manual", role: "", lastActivityAt: now - 900000, msgCount: 22, preview: "walking the loss curve end to end — data, LR schedule, the crossover, and what to actually log", goal: "" },
      { id: "cx1", title: "paper notes — Chinchilla, revisited", source: "manual", role: "", lastActivityAt: now - 7200000, msgCount: 6, preview: "compute-optimal vs data-optimal, and why the frontier moved", goal: "" },
      { id: "cx2", title: "infra — weekly box cost log", source: "manual", role: "", lastActivityAt: now - 12600000, msgCount: 4, preview: "A10 vs A100 hours this week; where the spend went", goal: "" },
      { id: "cx3", title: "reading — muP & hyperparameter transfer", source: "manual", role: "", lastActivityAt: now - 18000000, msgCount: 8, preview: "transfer across width; what actually held at 160M", goal: "" },
      { id: "cx4", title: "scratch — eval harness TODOs", source: "manual", role: "", lastActivityAt: now - 26000000, msgCount: 5, preview: "dedup the loaders, cache tokenization, pin the seed", goal: "" },
    ],
    runs: [
      { convId: "w2", title: "seed-2 retry", mission: "BitNet 160M MVP", source: "worker", lastTool: "Bash", lastProgressAt: now - 60000 },
      { convId: "w4", title: "eval + writeup", mission: "BitNet 160M MVP", source: "worker", lastTool: "Write", lastProgressAt: now - 30000 },
      // An assistant chat mid-turn: must NOT appear on the Activity page.
      { convId: "sup", title: "cockpit nav testing", mission: "", source: "phone", lastTool: "Read", lastProgressAt: now - 5000 },
    ],
    schedules: [
      { id: "s1", name: "Daily coach", prompt: "Run the summer-vault coach prompt and produce the morning briefing.", label: "daily · 7:00 AM · summer vault", enabled: true, lastFiredAt: now - 18000000, quietUnlessAlert: false },
      { id: "s2", name: "Repo hygiene sweep", prompt: "Sweep the repos for uncommitted drift and a failing pre-commit on main; ping only on a real problem.", label: "every 3h", enabled: true, lastFiredAt: now - 2400000, quietUnlessAlert: true },
    ],
    notifs: [
      // A DELIBERATION ask — the redesigned AskUser. `deliberation` drives the
      // richer "Needs you" card on the feed and the inline-option sheet: a
      // decision + verbose option cards you pick INLINE in the conversation,
      // plus a short sample "talk it through" exchange and a probe input.
      { id: "nAsk", ts: now - 90000, kind: "ask", title: "Coconut fp32", intention: "Mission needs your call · Coconut fp32", icon: "?", cls: "a", summary: "Raise the cost cap? Spend's at $28 of the $32 cap; accuracy climbing 0.68 → 0.85, ~a few hours to the result.", convId: "m1", askConvId: "a1", read: false,
        deliberation: {
          mission: "Coconut fp32",
          ask: "Raise the cost cap? Spend's at $28 of the $32 cap; accuracy climbing 0.68 → 0.85, ~a few hours to the result.",
          askLong: "Raise the cost cap? Spend's at $28 of the $32 cap; accuracy climbing 0.68 → 0.85, ~a few hours to the result. Two ways to go:",
          options: [
            { answer: "Hold at $32", title: "Hold at $32 — bank the 0.93 now", body: "It's already a clean reproduction, well past the old 0.83 plateau. The last ~4 points toward the paper's 0.97 costs ~$12 and a few more hours for a marginal gain." },
            { answer: "Raise to $40", primary: true, title: "Raise to $40 — run to the asymptote", body: "The latent stages fully phase in around epoch 30 — this is the real shot at matching 0.97. Hard-stops at $40 no matter what, so the downside stays bounded either way." },
          ],
          exchange: [
            { role: "user", text: "is the 0.85 real, or noise?" },
            { role: "assistant", text: "Real — it's climbed 0.68 → 0.71 → 0.78 → 0.85 across the last 4 epochs, exactly the latent-stage ramp. The run that plateaued never cleared 0.83." },
          ],
        } },
      { id: "n1", ts: now - 120000, kind: "ask", title: "Seed 3 diverged", intention: "Mission needs your call · BitNet 160M MVP", icon: "?", cls: "a", summary: "step 800, +0.05 nat above seed 1 — real effect, or match the LR and rerun?", body: "Seed 3 is **+0.05 nat above seed 1** at step 800 and still drifting.\n\nTwo readings:\n- **Real effect** — seed sensitivity worth reporting.\n- **LR mismatch** — match seed 1's LR and rerun (~9 min).\n\nReply and the mission's supervisor takes it from there.", convId: "m1", read: false },
      { id: "n0", ts: now - 18000000, kind: "info", title: "Morning briefing", intention: "Scheduled worker · summer vault", icon: "≡", cls: "", summary: "3 things moved overnight; today: finish the 3-seed writeup + push.", body: "## Overnight\n- 3-seed BitNet nearly there.\n- Repo sweep clean.\n- Idle box auto-killed (~$0.26).\n\n## Today\n1. Resolve the seed-3 divergence.\n2. Finish the writeup and push.", convId: "cch", read: false },
      { id: "n2", ts: now - 1080000, kind: "info", title: "Worker finished — seed 44", intention: "Worker deliverable · BitNet 160M MVP", icon: "✓", cls: "g", summary: "eval.loss 1.5588, within tolerance; committed under results/.", body: "Seed 44 eval.loss **1.5588** — within the 0.005 nat tolerance. `results/seed44.jsonl` committed.", convId: "w1", read: false },
      // readAt DELIBERATELY older than nDone's answeredAt though its ts is
      // newer — proves the Archive sorts by archive date, not fire date
      // (note 56e57731): nDone must render ABOVE this one.
      { id: "n3", ts: now - 5400000, kind: "info", title: "Stopped an idle box", intention: "Cost / cleanup · autonomous action", icon: "$", cls: "r", summary: "idle GPU box auto-killed after its job exited; ~$0.26, nothing billing now.", body: "A box sat at zero GPU utilization for 12 minutes after its job exited — killed it. ~$0.26, nothing billing now.", read: true, readAt: now - 8000000 },
      // A SETTLED ask in the archive: shows the recorded decision on the card
      // (answeredWith) and opens as a dead, read-only deliberation sheet.
      { id: "nDone", ts: now - 7200000, kind: "ask", title: "Budget fork — old run", intention: "Mission needed your call · BitNet 160M MVP", icon: "?", cls: "a", summary: "Spend was at $18 of $20 with seed 2 mid-run — extend or stop?", convId: "m1", read: true, answeredWith: "Extend to $26", answeredAt: now - 7100000,
        deliberation: {
          mission: "Budget fork — old run",
          ask: "Spend was at $18 of $20 with seed 2 mid-run — extend or stop?",
          askLong: "Spend was at $18 of $20 with seed 2 mid-run — extend the cap or stop and bank what's committed?",
          options: [
            { answer: "Extend to $26", title: "Extend to $26 — let seed 2 finish", body: "Seed 2 was ~40 min from its eval; stopping mid-run wastes the spend so far." },
            { answer: "Stop now", title: "Stop now — bank seeds 1 & 3", body: "Two seeds were already in tolerance; the writeup could proceed without seed 2." },
          ],
        } },
    ],
    notes: [
      { id: "nt1", status: "open", timestamp: new Date(now - 3600000).toISOString(), last_updated: new Date(now - 3600000).toISOString(), title: "Spectral clustering — why eigenvectors", user_draft: "In spectral clustering we build the Laplacian and take its eigenvectors to place each node in a new space. Why not the adjacency matrix directly?", turns: [], anchors: [] },
      { id: "nt2", status: "resolved", timestamp: new Date(now - 7200000).toISOString(), last_updated: new Date(now - 7000000).toISOString(), title: "Message sent snaps sheet to top", user_draft: "The snap to the top happens when I send a message in the sheet.", turns: [], anchors: [] },
      { id: "nt3", status: "resolved", timestamp: new Date(now - 9200000).toISOString(), last_updated: new Date(now - 9000000).toISOString(), title: "Sheets expand without scrolling to top", user_draft: "When the sheets expand they should not auto scroll to the top of the conversation.", turns: [], anchors: [] },
    ],
    threads: {
      // [ask redesign] The nAsk notification's OWN conversation — the user ↔
      // ask-agent deliberation, including an agent-proposed option set
      // (askOptions render as tappable relay cards that stack).
      a1: { id: "a1", title: "Coconut fp32", source: "ask", status: "idle", askOf: "m1", askNotifId: "nAsk", messages: [
        { role: "user", content: "is the 0.85 real, or noise?", direct: true },
        { role: "assistant", content: "Real — it's climbed 0.68 → 0.71 → 0.78 → 0.85 across the last 4 epochs, exactly the latent-stage ramp. The run that plateaued never cleared 0.83.", direct: true },
        { role: "user", content: "what if we split the difference on the cap?", direct: true },
        { role: "assistant", content: "A middle cap is workable — here's how I'd frame it:", direct: true, askOptions: [
          { answer: "Raise to $36", title: "Raise to $36 — one more latent stage", body: "Covers epochs 26-28 where most of the remaining gain lives; hard-stops $4 earlier than the full ask." , primary: true },
          { answer: "Hold, re-ask at 0.90", title: "Hold at $32, re-ask if it crosses 0.90", body: "Keeps the cap; the mission fires a fresh ask only if accuracy proves the ramp is still going." },
        ] },
      ] },
      m1: { id: "m1", title: "BitNet 160M MVP", source: "mission", status: "idle", messages: [
        { role: "user", content: "MISSION BRIEF (user-approved). Reproduce the BitNet 160M MVP across 3 seeds; commit eval.loss; writeup under docs/. Done = three seeds within 0.005 nat." },
        { role: "assistant", content: "Criterion pinned. Fanning out a worker per seed plus an eval/writeup worker; I'll watch on 15-min wakes and verify before I call it.", tools: ["StartWorker", "StartWorker", "StartWorker", "Schedule"] },
        { role: "user", content: "Your worker \"seed-42\" (id 99284a75) just finished its turn. Last output: seed 42 trained, eval.loss 1.553 committed under results/.\n\nReview its thread and decide: verified done, steer it (AskWorker), respawn with learnings, or — only if you can't resolve it yourself — bring the user in." },
        { role: "assistant", content: "Read the worker threads. Seeds **42 & 44 landed in tolerance**, eval.loss committed. **Seed 3 diverged** at step 800 (+0.05 nat) — I held it and surfaced the call to you. Kicked the eval/writeup worker since 2 of 3 are in.", timeline: { steps: [
          { thought: "Didn't trust any worker's 'done' on its word — pulled all three threads and checked each eval.loss against the 0.005 tolerance before counting it.", action: "read 3 worker threads, verified eval.loss" },
          { thought: "Seed 3 came back diverged at step 800, +0.05 nat above seed 1 and still drifting — that breaks the within-tolerance criterion, so I couldn't mark it done.", action: "", snag: true },
          { thought: "Whether that's a real seed effect or just an LR mismatch is a judgment call with real cost either way, so I held the worker and put the decision to you rather than guess.", action: "asked you: real effect, or rerun at matched LR?" },
          { thought: "Two of three are already in tolerance, so there's no reason to block the writeup on seed 3 — kicked the eval/writeup worker in parallel.", action: "spawned the eval + writeup worker" },
        ], reply: "Seeds **42 & 44** landed in tolerance; **seed 3 diverged** at step 800 (+0.05 nat) — I held it and surfaced the call to you. Kicked the eval/writeup worker since 2 of 3 are in." } },
        { role: "user", content: "don't wait on it — spin up a worker to rerun seed 3 at seed 42's LR." },
        { role: "assistant", content: "On it — spawning a worker to rerun seed 3 at seed 42's LR.", tools: ["StartWorker"] },
        // [unified ask] The supervisor FRONT staging inline option cards on a
        // reply — the only surface that does (a plain chat just talks). Last
        // message → cards render live/tappable in the mission sheet.
        { role: "user", content: "how should seed 3 land in the writeup?", direct: true },
        { role: "assistant", content: "Two clean ways to fold seed 3 in — your call:", direct: true, askOptions: [
          { answer: "Report seed 3 as a plumbing incident with the LR-guard fix, keep the headline table to the three clean seeds", title: "Plumbing incident + clean table", body: "Honest about what happened without polluting the headline numbers; the guard note makes it actionable.", primary: true },
          { answer: "Fold seed 3's rerun into the table as a fourth row and footnote the original divergence", title: "Fourth row + footnote", body: "Everything in one table; slightly muddies the 3-seed protocol the brief promised." },
        ] },
      ] },
      w2: { id: "w2", title: "seed-2 retry", source: "worker", status: "running", messages: [
        { role: "user", content: "retry seed 2 at seed 1's LR; commit eval.loss" },
        { role: "assistant", content: "Matched the LR, streaming c4. Step 600, tracking seed 1 within 0.01 nat so far.", tools: ["Bash"] },
      ] },
      w4: { id: "w4", title: "eval + writeup", source: "worker", status: "running", messages: [
        { role: "user", content: "build the per-seed comparison table and draft the writeup under docs/" },
        { role: "assistant", content: "Have seeds 42 & 44. Table built; drafting docs/bitnet-160m-mvp/writeup.md now.", tools: ["Read", "Write"] },
      ] },
      w1: { id: "w1", title: "3-seed BitNet repro", source: "worker", status: "idle", messages: [
        { role: "user", content: "train + eval seeds 42/43/44 on the 1700-step config" },
        { role: "assistant", content: "## Result\n\nAll three seeds done.\n\n| seed | eval loss |\n|---|---|\n| 42 | 1.5576 |\n| 43 | 1.5601 |\n| 44 | 1.5588 |\n\nGap held at **+0.13 nat**. `eval.loss` committed under `results/`.", tools: ["Write", "Bash"] },
      ] },
      cch: { id: "cch", title: "Morning briefing", source: "scheduled", status: "idle", messages: [
        { role: "user", content: "Run the summer-vault coach prompt and produce the morning briefing." },
        { role: "assistant", content: "## Overnight\n- **3-seed BitNet** repro nearly there.\n- Repo-hygiene sweep: clean.\n- Idle GPU box auto-killed (~$0.26).\n\n## Today\n1. Resolve the seed-3 divergence.\n2. Finish the writeup and push." },
      ] },
      sup: { id: "sup", title: "cockpit nav testing", source: "phone", status: "idle", messages: [
        { role: "user", content: "rebuild the phone nav — pages from the menu" },
        { role: "assistant", content: "Done — pages live behind the menu now, conversations are the left button." },
      ] },
      c1: { id: "c1", title: "densing law — readings", source: "manual", status: "idle", messages: [
        { role: "user", content: "summarize BitNet's ternary quantization + the STE trick, with the loss gap" },
        { role: "assistant", content: "## BitNet 160M — quick notes\n\nWeights are **ternary**, mapped to $\\{-1,0,+1\\}$ by a scaled sign:\n\n$$\\hat{w}=\\alpha\\cdot\\operatorname{sign}(w),\\qquad \\alpha=\\frac{1}{n}\\sum_i |w_i|$$\n\nThe *straight-through estimator* passes the gradient through unchanged:\n\n$$\\frac{\\partial\\mathcal{L}}{\\partial w}\\approx\\frac{\\partial\\mathcal{L}}{\\partial\\hat{w}}$$\n\nAcross three seeds the eval-loss gap held at about $+0.13$ nat." },
      ] },
      cL: { id: "cL", title: "scaling-law deep dive \u2014 the long one", source: "manual", status: "idle", messages: [
        { role: "user", content: "ok walk me through the whole scaling-law picture for the 160M runs — I want the end-to-end, not just the headline number" },
        { role: "assistant", content: "## The shape of it\n\nThree levers set the loss: **parameters** N, **tokens** D, and the **compute** C \u2248 6ND that ties them. Hold compute fixed and there is an optimal split between making the model bigger and training it longer. Miss the split and you leave loss on the table.\n\nFor our 160M budget the compute-optimal token count lands around **3.2B tokens** \u2014 we have been training closer to 1.7B, which is why the curve still looks hungry at the end." },
        { role: "user", content: "why 3.2B specifically" },
        { role: "assistant", content: "From the compute-optimal ratio D/N \u2248 20 tokens per parameter (the Chinchilla-ish regime). At N = 160M that is ~3.2B tokens. Below it you are param-rich / data-poor \u2014 the model has capacity it never fills. Our 1.7B run sits at ~10.6 tok/param, so it is under-trained by roughly 2x." },
        { role: "user", content: "show me the seeds again" },
        { role: "assistant", content: "All three, final eval loss:\n\n| seed | tokens | eval loss |\n|---|---|---|\n| 42 | 1.70B | 1.5576 |\n| 43 | 1.70B | 1.5601 |\n| 44 | 1.70B | 1.5588 |\n\nSpread is **0.0025 nat** \u2014 inside the 0.005 tolerance, so the run is reproducible. The gap to the paper\u2019s number is ~**+0.13 nat**, and almost all of it is the token shortfall, not the architecture.", "tools": ["Read", "Bash"] },
        { role: "user", content: "so if it is just tokens, why not crank D and move on" },
        { role: "assistant", content: "Because the LR schedule is coupled to D. The cosine decay is set to reach its floor at the *planned* last step. If you extend tokens without re-planning the schedule, you either (a) hit the LR floor early and waste the tail on a near-zero LR, or (b) never decay enough and leave the model noisy. Extending D means re-fitting the schedule, not just running longer." },
        { role: "user", content: "walk me through the schedule you would use for 3.2B" },
        { role: "assistant", content: "Warmup 2% of steps, then cosine to 10% of peak. Peak LR from the muP transfer at this width \u2014 not the 12M proxy\u2019s value. Concretely:\n\n```python\nsteps = tokens // (batch * seq)      # ~3.2B / (0.5M) = 6100\nwarmup = int(0.02 * steps)\npeak_lr = 3.0e-3                       # muP-transferred to 160M width\nfloor = 0.1 * peak_lr\nsched = cosine(warmup, steps, peak_lr, floor)\n```\n\nThe one number people get wrong is the floor: 10% not 0. Decaying to a hard zero over-smooths the last few hundred steps and the eval loss ticks *up*." },
        { role: "user", content: "what is the muP part doing for us" },
        { role: "assistant", content: "muP makes the optimal LR **width-invariant**, so we tune it once on a cheap narrow proxy and transfer it up without re-sweeping. We fit peak_lr on a 12M-width model, and it transfers to 160M essentially unchanged \u2014 which is why the 3.0e-3 above is not a guess. What does *not* transfer is depth-dependent stuff (residual scaling), so keep depth fixed between proxy and target." },
        { role: "user", content: "and this actually held? or is that the theory talking" },
        { role: "assistant", content: "It held \u2014 mostly. Seed 3 diverged at step 800, +0.05 nat above seed 1, and it turned out to be an LR mismatch: that worker inherited the proxy\u2019s raw LR instead of the transferred one, so it was ~1.6x too hot. Re-ran it at the matched LR and it fell back into the pack. So the transfer held; the *plumbing* around it did not, once.", "tools": ["Read"] },
        { role: "user", content: "that is the kind of thing I want caught automatically" },
        { role: "assistant", content: "Agreed. The fix is to log the *effective* LR each worker actually used and assert it against the transferred target at step 0 \u2014 a one-line guard that would have caught seed 3 before it burned 800 steps. I can add that to the harness as a pre-flight check so a hot-LR worker fails fast instead of quietly diverging." },
        { role: "user", content: "do it, and while you are there tell me what else we should be logging" },
        { role: "assistant", content: "### Minimum log set for a run you can trust\n\n- **effective LR** at step 0 and at every decay checkpoint (catches the seed-3 class of bug)\n- **tokens seen**, not just steps \u2014 steps lie when batch size changes\n- **grad norm** pre-clip (spikes precede divergence by ~50 steps)\n- **eval loss** on a *fixed* held-out shard, same shard every run, or the numbers are not comparable\n- **throughput** (tok/s) to catch a silently-degraded box\n- the **git SHA + config hash** stamped into the checkpoint, so a result is always traceable to exactly what produced it\n\nEverything else is nice-to-have. Those six are the ones whose absence has actually cost us a run." },
        { role: "user", content: "good. last thing \u2014 give me the one-paragraph version I can paste into the writeup" },
        { role: "assistant", content: "The 160M reproduction is stable across three seeds (eval loss 1.559 \u00b1 0.001) and sits ~0.13 nat above the reference, a gap almost entirely explained by training on 1.7B tokens against a compute-optimal ~3.2B. The learning rate was set once on a 12M-width proxy and transferred via muP to the target width unchanged; the only divergence (seed 3) traced to a worker running the un-transferred LR, now guarded by a step-0 effective-LR assertion. Closing the gap is a token-count decision, not an architecture one, and requires re-fitting the cosine schedule to the longer horizon rather than simply training further." },
      ] },
      cx1: { id: "cx1", title: "paper notes \u2014 Chinchilla, revisited", source: "manual", status: "idle", messages: [
        { role: "user", content: "was Chinchilla compute-optimal or data-optimal, and why did the frontier move" },
        { role: "assistant", content: "Compute-optimal for a *fixed* compute budget. The frontier moved because inference cost changed the objective: if you serve a model a lot, it is worth over-training a smaller one past its compute-optimal point to save every future forward pass. So \u201coptimal\u201d depends on whether you are counting training FLOPs or lifetime FLOPs." },
      ] },
      cx2: { id: "cx2", title: "infra \u2014 weekly box cost log", source: "manual", status: "idle", messages: [
        { role: "user", content: "where did the GPU spend go this week" },
        { role: "assistant", content: "## This week\n\n- A10 \u00d7 41h \u2014 the 3-seed reruns\n- A100 \u00d7 6h \u2014 the 3.2B pilot\n- ~$0.26 wasted on an idle box (auto-killed)\n\nTotal tracked spend is within the cap; the A100 hours are the only thing worth watching." },
      ] },
      cx3: { id: "cx3", title: "reading \u2014 muP & hyperparameter transfer", source: "manual", status: "idle", messages: [
        { role: "user", content: "one-line: what does muP actually buy us" },
        { role: "assistant", content: "Width-invariant optimal LR \u2014 tune once on a narrow proxy, transfer up without re-sweeping. Depth-dependent terms do not transfer, so hold depth fixed between proxy and target." },
      ] },
      cx4: { id: "cx4", title: "scratch \u2014 eval harness TODOs", source: "manual", status: "idle", messages: [
        { role: "user", content: "list the eval harness cleanups" },
        { role: "assistant", content: "- dedup the data loaders (two copies drift)\n- cache tokenization so eval is not re-tokenizing each run\n- pin the eval seed + fixed held-out shard\n- stamp git SHA into every result row" },
      ] },
    },
  };
  // A box with more than one vault (MockDB.vaults): the page shows the vault it names (?vault=).
  const pick = (() => {
    try {
      return new URLSearchParams(location.search).get("vault") || localStorage.getItem("vc_phone_vault") || "";
    } catch {
      return "";
    }
  })();
  const DB: MockDB = pick && ROOT.vaults?.[pick] ? ({ ...ROOT, ...ROOT.vaults[pick], vault: pick } as MockDB) : ROOT;
  const reply = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
  // The preview's UI choices (localStorage switches), before the page reads them.
  for (const [k, v] of Object.entries(DB.ls ?? {})) {
    try { localStorage.setItem(k, v); } catch {}
  }
  // The box's conversations: its event log (src/convlog/memoryBox.ts — the same
  // records and fold as the real box). The fixture threads are its history.
  const box = new MemoryBox();
  const asFixture = (m: any) => ({
    ...m,
    ...(Array.isArray(m.tools) && m.tools.length ? { toolCalls: m.tools.map((name: string, i: number) => ({ id: `${name}-${i}-${Math.random().toString(36).slice(2, 6)}`, name, input: {}, result: "" })) } : {}),
    ...(typeof m.divider === "string" ? { compaction: { summary: m.divider } } : {}),
    ...(Array.isArray(m.spawns) && m.spawns.length && !m.tools?.length ? { toolCalls: [{ id: "sub-" + m.spawns.join("-"), name: "subagent", input: {}, result: "", subagents: m.spawns }] } : {}),
  });
  for (const [id, t] of Object.entries(DB.threads)) {
    const row = DB.convs.find((c) => c.id === id) as any;
    box.import(id, { ...(t as any), title: (t as any).title || row?.title || "New chat", source: (t as any).source || row?.source || "phone", ...(row?.project ? { project: row.project } : {}), lastActivityAt: row?.lastActivityAt, createdAt: row?.lastActivityAt }, ((t as any).messages || []).map(asFixture));
    if (DB.runs.some((r) => r.convId === id)) box.startTurn(id);
  }
  // One main conversation (src/threads.ts), as the box makes it at start: Main and each project's one thread.
  if (!box.picture("main")) box.create("main", { title: "Main", source: "main", kind: "main" });
  for (const p of DB.projects || []) if (!box.picture(`project-${p.slug}`)) box.create(`project-${p.slug}`, { title: p.name, source: "project", kind: "project", project: p.slug });
  /** The list rows the box adds for them (GET /conversations: the fixture's chats are older chats). */
  const threadRows = () => box.rows().filter((r) => r.kind === "main" || r.kind === "project" || r.kind === "separate").map((r) => ({ id: r.id, title: r.title, lastActivityAt: r.lastActivityAt, source: r.source, kind: r.kind, project: r.project, msgCount: 0, preview: "" }));
  // A send gets the mock's canned reply (a scripted preview leaves the reply to its script).
  box.onSend = (conv) => {
    if (DB.script) return;
    setTimeout(() => {
      box.say(conv, "Here's the context on that call — happy to dig into any part of it.", 3);
      box.endTurn(conv);
    }, 350);
  };
  (window as any).__vcPhoneBox = box;
  // A scripted box (preview): each __vcPhoneNext() applies one step — what the
  // box writes for it (its older shapes: messages appended, meta, run states).
  let scriptAt = 0;
  window.__vcPhonePosts = [];
  window.__vcPhoneNext = () => {
    const st = DB.script?.[scriptAt];
    if (!st) return false;
    scriptAt++;
    for (const [id, m] of Object.entries(st.meta ?? {})) {
      const row = DB.convs.find((c) => c.id === id);
      if (row) Object.assign(row, m);
    }
    if (st.runs) DB.runs = st.runs;
    box.applyLegacyStep({ ...st, append: Object.fromEntries(Object.entries(st.append ?? {}).map(([id, ms]) => [id, (ms as any[]).map(asFixture)])) } as any);
    return true;
  };
  window.fetch = async (url, opts) => {
    const u = String(url).split("?")[0];
    const q = new URLSearchParams(String(url).split("?")[1] || "");
    const body = opts && opts.body ? JSON.parse(opts.body as string) : {};
    if (DB.script && u !== "/poll") window.__vcPhonePosts.push({ url: String(url), method: (opts && opts.method) || "GET", body });
    // The log's routes: /poll, /api/v2/conversations[/<id>/checkpoint], /api/v2/intent.
    const routed = await box.route((opts && opts.method) || "GET", u, q, body, DB.script ? 2400 : 2500);
    if (routed) return new Response(JSON.stringify(routed.body), { status: routed.status, headers: { "Content-Type": "application/json" } });
    if (DB.script && /^\/api\/v1\/conversations\/[^/]+\/subagents\/[^/]+\/(steer|stop)$/.test(u)) return reply({ ok: true });
    if (u === "/conversations") return reply({ vault: DB.vault, conversations: [...threadRows(), ...DB.convs.filter((c) => !threadRows().some((t) => t.id === c.id))] });
    if (u === "/api/v1/vaults") return reply({ vaults: [{ name: ROOT.vault, main: true, syncing: true }, ...Object.keys(ROOT.vaults ?? {}).map((name) => ({ name, main: false, syncing: true }))] });
    if (u === "/conversation") {
      const t = DB.threads[q.get("id")];
      if (!t) return reply({ error: "not found" });
      // The box's last-n window (refreshConvMeta asks for n=1).
      const n = Number(q.get("n")) || 0;
      return reply(n > 0 ? { ...t, messages: t.messages.slice(-n) } : t);
    }
    if (u === "/status") return reply({ vault: DB.vault, model: DB.model, version: "0.4.21-mock", runs: DB.runs });
    if (u === "/schedules") return reply({ schedules: DB.schedules });
    if (u === "/notifications") { const ct = DB.notifClearTs || 0; const ns = DB.notifs.filter((n) => !(n.read && n.ts <= ct)); return reply({ unread: ns.filter((n) => !n.read).length, notifications: ns }); }
    if (u === "/notifications/read") { const n = DB.notifs.find((x) => x.id === body.id); if (n) n.read = true; return reply({ ok: true }); }
    if (u === "/notifications/hide") { DB.notifs = DB.notifs.filter((x) => x.id !== body.id); return reply({ ok: true }); }
    if (u === "/notifications/clear") { DB.notifClearTs = Date.now(); return reply({ ok: true }); }
    if (u === "/notes") { const ns = DB.notes.filter((n) => n.status !== "cleared"); return reply({ open: ns.filter((n) => n.status === "open").length, notes: ns }); }
    if (u === "/notes/status") { const n = DB.notes.find((x) => x.id === body.id); if (n) n.status = body.status === "open" ? "open" : "resolved"; return reply({ ok: true }); }
    if (u === "/notes/edit") { const n = DB.notes.find((x) => x.id === body.id); if (!n) return reply({ error: "note not found" }); n.user_draft = body.text; n.title = null; n.last_updated = new Date().toISOString(); return reply({ ok: true, id: n.id }); }
    if (u === "/notes/clear-resolved") { let c = 0; DB.notes.forEach((n) => { if (n.status === "resolved") { n.status = "cleared"; c += 1; } }); return reply({ ok: true, cleared: c }); }
    if (u === "/projects" && (opts?.method || "GET") === "POST") {
      const name = String(body.name || "").trim();
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug) return reply({ error: "name required" });
      if (!(DB.projects || []).some((x) => x.slug === slug)) (DB.projects = DB.projects || []).push({ slug, name });
      if (!box.picture(`project-${slug}`)) box.create(`project-${slug}`, { title: name, source: "project", kind: "project", project: slug });
      return reply({ ok: true, slug, name, convId: `project-${slug}` });
    }
    if (u === "/projects") return reply({ projects: DB.projects || [] });
    if (u === "/conversation/project") {
      const want = String(body.project || "").trim();
      const slug = want ? want.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : "";
      if (slug && !(DB.projects || []).some((x) => x.slug === slug)) (DB.projects = DB.projects || []).push({ slug, name: want });
      const cs = DB.convs.find((c) => c.id === body.convId); if (cs) cs.project = slug || undefined;
      const th = DB.threads[body.convId]; if (th) (th as any).project = slug || undefined;
      return reply({ ok: true, project: slug || null });
    }
    if (u === "/message") return reply(box.intent({ ...body, type: body.queue ? "queue" : "send", clientId: body.clientMsgId || "m-" + Date.now() }));
    if (u === "/decision-record") {
      // Mirror the real box: an inline decision lands in the archive as a
      // pre-decided ask card (never unread, never pushed).
      DB.notifs.push({ id: "dec-" + Date.now(), ts: Date.now(), kind: "ask", title: body.title || "Inline decision", intention: "Your call · decided in-conversation", icon: "?", cls: "a", body: body.question || "", convId: body.convId || "", read: true, answeredWith: body.answer, answeredAt: Date.now(), readAt: Date.now() });
      return reply({ ok: true });
    }
    if (u === "/answer") {
      // Mirror the real box: stamp WHICH answer settled the ask (answeredWith)
      // and mark it read, so the decided-card/dead-sheet states are testable.
      const an = DB.notifs.find((x) => x.id === body.notifId);
      if (an) { an.answeredWith = body.text; an.answeredAt = Date.now(); an.read = true; }
      if (body.convId && box.picture(body.convId)) box.intent({ type: "answer", convId: body.convId, clientId: body.clientMsgId || "a-" + Date.now(), text: body.text });
      return reply({ ok: true, convId: body.convId, answered: true });
    }
    if (u === "/kill") { if (body.convId) { DB.runs = DB.runs.filter((r) => r.convId !== body.convId); box.intent({ type: "stop", convId: body.convId }); } return reply({ ok: true, result: "Kill sent." }); }
    if (u === "/chats/clear") return reply({ ok: true, cleared: 0 });
    if (u === "/schedule") { if (body.action === "toggle") { const s = DB.schedules.find((x) => x.id === body.id); if (s) s.enabled = body.enabled; } else if (body.action === "delete") { DB.schedules = DB.schedules.filter((x) => x.id !== body.id); } return reply({ ok: true }); }
    if (u === "/surface") return reply({ ok: true });
    if (u === "/push/vapid") return reply({ key: "" });
    if (u === "/push/subscribe" || u === "/push/test") return reply({ ok: true });
    if (u === "/file") return new Response("(mock file)", { status: 200 });
    return reply({});
  };
}
