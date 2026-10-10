// The synthetic world every scenario starts from: Carl's chats, missions and
// their workers, alerts, notes and schedules — invented, written once, and
// adapted to both surfaces (the desktop's conversation files and the phone's
// MockDB), so desktop and phone show the same state.

const MIN = 60_000;
const HOUR = 60 * MIN;

type Msg = Record<string, unknown>;
export type Conv = Record<string, any> & { id: string; messages: Msg[] };

const u = (content: string, extra: Msg = {}): Msg => ({ role: "user", content, ...extra });
const a = (content: string, extra: Msg = {}): Msg => ({ role: "assistant", content, ...extra });
const tc = (name: string, input: unknown, result: string, id?: string) => ({ id: id ?? `call_${name}_${Math.abs(hash(JSON.stringify(input))) % 1e6}`, name, input, result });
const usage = (context: number, completion = 600) => ({ prompt: context - completion, completion, total: context, context });

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export const VAULT_FILE = (vault: string, rel: string) => `${vault}/${rel}`;

/** The desktop chats (source manual). */
export function chats(vault: string, now: number): Conv[] {
  return [
    {
      id: "c-spectral",
      title: "Why eigenvectors in spectral clustering?",
      source: "manual",
      status: "idle",
      unread: false,
      createdAt: now - 26 * HOUR,
      lastActivityAt: now - 25 * HOUR,
      messages: [
        u("In spectral clustering, why do we take eigenvectors of the Laplacian instead of just using the adjacency matrix?"),
        a(
          "Short version: the Laplacian's small eigenvectors are the *smoothest* functions on the graph, and smooth-over-the-graph is exactly what a good cut looks like.\n\n" +
            "For any vector $f$,\n\n$$f^\\top L f = \\tfrac12 \\sum_{ij} w_{ij}(f_i - f_j)^2,$$\n\nso a small eigenvalue means neighbours get similar values — the relaxed min-cut. Two facts the adjacency matrix doesn't give you:\n\n" +
            "1. **Components show up as zero eigenvalues.** The multiplicity of 0 equals the number of connected components.\n2. **Degree normalization** ($L_{sym}$) stops hubs from dominating — that's the Ncut relaxation.\n\nYour note already has the first point; I'd add the second.",
          {
            toolCalls: [tc("Read", { path: VAULT_FILE(vault, "notes/spectral-clustering.md") }, "# Spectral clustering — why eigenvectors\n\nBuild a similarity graph $W$ …")],
            usage: usage(14_210),
          },
        ),
      ],
    },
    {
      id: "c-writeup",
      title: "Tighten the BitNet writeup summary",
      source: "manual",
      status: "idle",
      unread: false,
      createdAt: now - 5 * HOUR,
      lastActivityAt: now - 4.6 * HOUR,
      messages: [
        u("Read the bitnet writeup and tighten the summary paragraph — keep the numbers."),
        a("Tightened it: one sentence for the result, one for the cause of the gap. Numbers unchanged.", {
          toolCalls: [
            tc("Read", { path: VAULT_FILE(vault, "projects/bitnet-160m/writeup.md") }, "# Reproducing BitNet b1.58 at 160M parameters\n…"),
            tc(
              "Edit",
              {
                path: VAULT_FILE(vault, "projects/bitnet-160m/writeup.md"),
                old_string: "The 160M reproduction is stable across three seeds",
                new_string: "The 160M reproduction is stable across three seeds",
              },
              "Edited projects/bitnet-160m/writeup.md (1 replacement)",
            ),
          ],
          usage: usage(31_870),
        }),
      ],
    },
    {
      id: "c-ps3",
      title: "PS3 problem 4 — eigengap bound",
      source: "manual",
      status: "idle",
      unread: false,
      createdAt: now - 50 * HOUR,
      lastActivityAt: now - 49 * HOUR,
      messages: [
        u("I'm stuck on PS3 problem 4. Davis–Kahan gives me the subspace angle — how do I get to the k-means misclustering rate?"),
        a(
          "Go through the rows of the embedding. Davis–Kahan bounds $\\|\\sin\\Theta(\\hat U, U)\\|_F \\le \\frac{2\\|E\\|}{\\lambda_{k+1}-\\lambda_k}$. Then:\n\n" +
            "1. There is a rotation $O$ with $\\|\\hat U - UO\\|_F \\le \\sqrt2\\,\\|\\sin\\Theta\\|_F$.\n2. Rows of $UO$ take only $k$ distinct values, separated by at least $\\sqrt{2/n_{max}}$.\n3. A node is misclustered only if its row moved at least half that gap — count them with Markov.\n\nThat gives misclustered $\\lesssim \\frac{n_{max}\\,\\|E\\|^2}{(\\lambda_{k+1}-\\lambda_k)^2}$.",
          { usage: usage(9_870) },
        ),
      ],
    },
  ];
}

/** A long working chat whose last reported context is `ctx` tokens. */
export function longChat(now: number, ctx: number, id = "c-long", turns = 18): Conv {
  const msgs: Msg[] = [];
  const topics = [
    "the LR schedule for 3.2B tokens",
    "what muP buys us at 160M",
    "why seed 43 diverged",
    "the minimum log set for a trustworthy run",
    "Chinchilla vs inference-aware scaling",
    "how to stamp the git SHA into checkpoints",
    "the eval shard and why it must be fixed",
    "grad-norm spikes before divergence",
    "throughput regressions on the A10",
  ];
  for (let i = 0; i < turns; i++) {
    const t = topics[i % topics.length];
    msgs.push(u(`Next: walk me through ${t}.`));
    msgs.push(
      a(
        `## ${t[0].toUpperCase()}${t.slice(1)}\n\n` +
          "Here's the working picture, with the numbers from our runs. " +
          "The short answer is that the schedule, the token budget and the eval protocol are coupled; change one and you re-plan the others. " +
          "I've pulled the relevant rows from `results.csv` and the notes so we don't re-derive them.\n\n" +
          "| run | tokens | eval loss |\n|---|---|---|\n| seed 42 | 1.70B | 1.5576 |\n| seed 43 | 1.70B | 1.5601 |\n| seed 44 | 1.70B | 1.5588 |\n\n" +
          "The one thing to watch: the effective LR at step 0 — that's the guard that would have caught seed 43.",
        {
          toolCalls: i % 3 === 0 ? [tc("Read", { path: "projects/bitnet-160m/results.csv" }, "seed,tokens,steps,peak_lr,eval_loss…")] : undefined,
          usage: usage(Math.round(ctx * ((i + 1) / turns))),
        },
      ),
    );
  }
  return {
    id,
    title: "BitNet: scaling-law deep dive (long)",
    source: "manual",
    status: "idle",
    unread: false,
    createdAt: now - 30 * HOUR,
    lastActivityAt: now - 20 * MIN,
    messages: msgs,
  };
}

/** Missions, their workers and the ask thread. */
export function missions(now: number, opts: { awaiting?: boolean } = {}): Conv[] {
  const mission = "BitNet 160M MVP";
  const brief =
    "MISSION BRIEF (user-approved). Reproduce the BitNet 160M MVP across 3 seeds; commit eval.loss for each; writeup under projects/bitnet-160m/.\n\n" +
    "Done when:\n- All 3 seeds trained, eval.loss committed for each\n- The three seeds land within 0.005 nat of each other\n- A short writeup lands under projects/bitnet-160m/";
  return [
    {
      id: "m-bitnet",
      title: mission,
      source: "mission",
      role: "supervisor",
      mission,
      status: "idle",
      unread: true,
      createdAt: now - 52 * HOUR,
      lastActivityAt: now - 8 * MIN,
      missionState: opts.awaiting ? "AWAITING_USER" : "RUNNING",
      taskSummary: "Reproduce BitNet 160M across 3 seeds, then write it up",
      statusSummary: opts.awaiting ? "Waiting for you: extend to 3.2B tokens or stop?" : "Seeds 42 & 44 verified; seed 43 rerun in tolerance; writeup drafting",
      thinkingDigest:
        "Seeds 42 and 44 landed within tolerance. Seed 43 came in 0.05 nat high at step 800 — traced to the worker reading the proxy's raw LR, so it respawned that worker at the transferred LR rather than accept the gap. Holding the writeup worker until the rerun's eval lands.",
      doneWhenDone: ["All 3 seeds trained, eval.loss committed for each", "The three seeds land within 0.005 nat of each other"],
      costUsd: 27.84,
      audits: [
        { at: now - 3 * HOUR, by: "MarkDoneWhen", criterion: "All 3 seeds trained, eval.loss committed for each", pass: true, reason: "results.csv has three rows; eval.loss files committed in 3 commits", evidence: "git log results/" },
      ],
      messages: [
        u(brief),
        a("Criterion pinned. Fanning out one worker per seed plus an eval/writeup worker; I'll check on 15-minute wakes and verify before I call anything done.", {
          toolCalls: [
            tc("StartWorker", { title: "seed 42", task: "train + eval seed 42" }, "worker w-seed42 started"),
            tc("StartWorker", { title: "seed 43", task: "train + eval seed 43" }, "worker w-seed43 started"),
            tc("StartWorker", { title: "seed 44", task: "train + eval seed 44" }, "worker w-seed44 started"),
            tc("Schedule", { every: 15 }, "wake scheduled every 15 min"),
          ],
        }),
        u('Your worker "seed 43" just finished its turn. Last output: diverged at step 800, eval loss +0.05 nat above seed 42.'),
        a("Seed 43 diverged — the worker read the 12M proxy's raw LR (1.6× too hot). Respawned it at the transferred LR. Seeds 42 and 44 are verified in tolerance.", {
          timeline: {
            steps: [
              { thought: "Didn't take the worker's word for it — read all three threads and checked each eval.loss against the tolerance.", action: "read 3 worker threads" },
              { thought: "Seed 43 is +0.05 nat at step 800 and climbing — breaks the criterion.", action: "", snag: true },
              { thought: "Its config shows peak_lr 4.8e-3, the proxy's value, not the transferred 3.0e-3. Plumbing bug, not a seed effect.", action: "read seed 43 config" },
              { thought: "Respawned it at the transferred LR; kept 42 and 44.", action: "respawned seed 43" },
            ],
            reply: "Seed 43 diverged — wrong LR. Respawned at the transferred LR; 42 and 44 verified.",
          },
        }),
        ...(opts.awaiting
          ? [
              a(
                "All three seeds are in tolerance (spread 0.0025 nat). The remaining gap to the paper is ~0.13 nat, almost all token count. Extending to 3.2B tokens costs ~$31 more and ~28 GPU-hours. I've asked you whether to extend.",
                { toolCalls: [tc("AskUser", { question: "Extend to 3.2B tokens (~$31, ~28 GPU-h) or stop at 1.7B and write up?" }, "asked")] },
              ),
            ]
          : []),
      ],
    },
    {
      id: "w-seed43",
      title: "seed 43 rerun (matched LR)",
      source: "worker",
      mission,
      status: "idle",
      unread: false,
      createdAt: now - 20 * HOUR,
      lastActivityAt: now - 9 * MIN,
      taskSummary: "Rerun seed 43 at the muP-transferred LR; commit eval.loss",
      statusSummary: "Done — eval loss 1.5601, in tolerance",
      messages: [
        u("Rerun seed 43 at the transferred LR (3.0e-3, from mup.json). Commit eval.loss."),
        a("Done. Seed 43 eval loss **1.5601** — within 0.005 nat of seed 42. Committed `results/seed43.jsonl`.", {
          toolCalls: [
            tc("Bash", { command: "python train.py --seed 43 --tokens 1.7e9 --lr-from mup.json" }, "exit: 0\nstdout:\nseed=43 steps=3240 warmup=64 peak_lr=0.003\n…\nfinal eval loss 1.5601"),
            tc("Write", { path: "results/seed43.jsonl" }, "Wrote results/seed43.jsonl"),
          ],
        }),
      ],
    },
    {
      id: "w-writeup",
      title: "eval table + writeup",
      source: "worker",
      mission,
      status: "idle",
      unread: false,
      createdAt: now - 6 * HOUR,
      lastActivityAt: now - 30 * MIN,
      taskSummary: "Build the per-seed table and draft the writeup",
      statusSummary: "Draft written to projects/bitnet-160m/writeup.md",
      messages: [
        u("Build the per-seed comparison table and draft the writeup under projects/bitnet-160m/."),
        a("Table built from results.csv; draft written to `projects/bitnet-160m/writeup.md`.", {
          toolCalls: [
            tc("Read", { path: "projects/bitnet-160m/results.csv" }, "seed,tokens,…"),
            tc("Write", { path: "projects/bitnet-160m/writeup.md" }, "Wrote projects/bitnet-160m/writeup.md"),
          ],
        }),
      ],
    },
    {
      id: "m-hygiene",
      title: "Quiet watch — repo hygiene",
      source: "mission",
      role: "supervisor",
      mission: "Quiet watch — repo hygiene",
      status: "idle",
      unread: false,
      createdAt: now - 7 * 24 * HOUR,
      lastActivityAt: now - 30 * HOUR,
      completedAt: now - 30 * HOUR,
      missionState: "DONE",
      costUsd: 1.92,
      taskSummary: "Keep the repos free of uncommitted drift",
      statusSummary: "Done — all clean for 6 days",
      messages: [u("MISSION BRIEF (user-approved). Quiet watch on repo hygiene.\n\nDone when:\n- No uncommitted drift older than 30 min for a week"), a("A week clean. Completing the mission.", { toolCalls: [tc("CompleteMission", { evidence: "7 daily sweeps, 0 findings" }, "completed")] })],
    },
    {
      id: "m-lrsweep",
      title: "LR sweep (scrapped)",
      source: "mission",
      role: "supervisor",
      mission: "LR sweep (scrapped)",
      status: "idle",
      unread: false,
      createdAt: now - 4 * 24 * HOUR,
      lastActivityAt: now - 3 * 24 * HOUR,
      completedAt: now - 3 * 24 * HOUR,
      missionState: "KILLED",
      costUsd: 4.1,
      messages: [u("MISSION BRIEF (user-approved). Sweep learning rates 1e-3…1e-2.\n\nDone when:\n- best LR committed"), a("Stopped by you before it finished. Two of six runs completed.", { system: false })],
    },
    {
      id: "s-brief",
      title: "Morning briefing",
      source: "scheduled",
      status: "idle",
      unread: true,
      createdAt: now - 2.5 * HOUR,
      lastActivityAt: now - 2.5 * HOUR,
      messages: [
        u("Run the morning briefing: what moved overnight, what's due today."),
        a("## Overnight\n- **BitNet**: seed 43 rerun landed in tolerance; writeup drafted.\n- Repo sweep: clean.\n\n## Today\n1. PS3 problem 4 (due Monday).\n2. Decide on the 3.2B-token extension.\n3. Reply about Thursday's reading group."),
      ],
    },
  ];
}

export function notifications(now: number, opts: { awaiting?: boolean } = {}): string[] {
  const out: Record<string, unknown>[] = [
    { id: "n-brief", ts: now - 2.5 * HOUR, kind: "info", title: "Morning briefing", body: "## Overnight\n- BitNet seed 43 rerun in tolerance.\n- Repo sweep clean.\n\n## Today\n1. PS3 problem 4.\n2. Decide on 3.2B extension.", convId: "s-brief", intention: "Scheduled · summer-demo", summary: "Seed 43 back in tolerance; PS3 p4 due Monday.", icon: "≡", cls: "" },
    { id: "n-seed43", ts: now - 9 * MIN, kind: "info", title: "Worker finished — seed 43", body: "Seed 43 eval loss **1.5601** — within tolerance. `results/seed43.jsonl` committed.", convId: "w-seed43", intention: "Worker deliverable · BitNet 160M MVP", summary: "eval loss 1.5601, in tolerance; committed.", icon: "✓", cls: "g" },
  ];
  if (opts.awaiting)
    out.push({
      id: "n-ask",
      ts: now - 6 * MIN,
      kind: "ask",
      title: "Extend to 3.2B tokens?",
      body: "All three seeds are in tolerance. The remaining ~0.13 nat gap is token count.\n\n- **Extend**: ~$31 more, ~28 GPU-hours.\n- **Stop**: write up at 1.7B tokens now.",
      convId: "m-bitnet",
      intention: "Mission needs your call · BitNet 160M MVP",
      summary: "Extend (~$31, ~28 GPU-h) or stop and write up?",
      icon: "?",
      cls: "a",
    });
  return out.map((o) => JSON.stringify(o));
}

export function notes(now: number): string[] {
  const iso = (t: number) => new Date(t).toISOString();
  const n = (id: string, t: number, status: string, draft: string, anchor?: { path: string; kind: string; sel?: string; at?: string }) =>
    JSON.stringify({
      id,
      timestamp: iso(t),
      last_updated: iso(t),
      anchors: anchor
        ? [{ source_path: anchor.path, source_kind: anchor.kind, source_anchor: anchor.at ?? null, source_selection: anchor.sel ?? null, primary: true }]
        : [],
      turns: [],
      user_draft: draft,
      status,
    });
  return [
    n("note-eigengap", now - 26 * HOUR, "open", "When does the eigengap heuristic fail? Office hours said: very different cluster sizes. Find a reference.", { path: "notes/spectral-clustering.md", kind: "markdown", sel: "When does the eigengap heuristic for choosing $k$ fail?" }),
    n("note-lrguard", now - 20 * HOUR, "open", "Add the step-0 effective-LR assertion to every train script, not just bitnet.", { path: "projects/bitnet-160m/train.py", kind: "code", at: "L44" }),
    n("note-readgroup", now - 3 * HOUR, "open", "Reply about Thursday's reading group — suggest the Chinchilla follow-ups."),
    n("note-table", now - 40 * HOUR, "resolved", "Writeup table should show tokens per seed."),
  ];
}

export function schedules(now: number): string[] {
  return [
    { id: "sch-brief", name: "Morning briefing", prompt: "Run the morning briefing: what moved overnight, what's due today.", recurrence: { kind: "daily" }, time: "07:00", timezone: "America/Los_Angeles", target: { kind: "new" }, modelId: "anthropic/claude-sonnet-5.5", enabled: true, markUnreadOnFinish: true, lastFiredAt: now - 2.5 * HOUR, createdAt: now - 30 * 24 * HOUR },
    { id: "sch-hygiene", name: "Repo hygiene sweep", prompt: "Sweep the repos for uncommitted drift; ALERT only on a real problem.", recurrence: { kind: "every", minutes: 180 }, time: "09:00", timezone: "America/Los_Angeles", target: { kind: "new" }, modelId: "anthropic/claude-haiku-5.5", enabled: true, markUnreadOnFinish: false, quietUnlessAlert: true, lastFiredAt: now - 40 * MIN, createdAt: now - 14 * 24 * HOUR },
    // The mission's own 15-minute wake (missions schedule their next check).
    { id: "sch-bitnet-wake", name: "BitNet 160M MVP — check-in", prompt: "Watched run check-in: review the workers and continue the mission.", recurrence: { kind: "every", minutes: 15 }, time: "09:00", timezone: "America/Los_Angeles", target: { kind: "existing", conversationId: "m-bitnet" }, modelId: "openai/gpt-6.1-sol", enabled: true, markUnreadOnFinish: false, quietUnlessAlert: true, lastFiredAt: now - 8 * MIN, createdAt: now - 52 * HOUR },
    { id: "sch-weekly", name: "Weekly spend report", prompt: "Summarize the week's GPU and model spend.", recurrence: { kind: "weekly", dow: 5 }, time: "17:00", timezone: "America/Los_Angeles", target: { kind: "new" }, modelId: "anthropic/claude-haiku-5.5", enabled: false, markUnreadOnFinish: true, createdAt: now - 20 * 24 * HOUR },
  ].map((s) => JSON.stringify(s));
}

/** Seeded git history: ~3 weeks of autosaves, agent edits and a mission's
 *  commits. "@current" = the file's content in the fixture vault. */
export function history(now: number) {
  const DAY = 24 * HOUR;
  const C = "@current";
  return [
    { subject: "vault-chat start", at: now - 21 * DAY, changes: {}, anchor: true },
    { subject: "autosave", at: now - 20 * DAY, changes: { "notes/mup.md": "# muP — hyperparameter transfer\n\nTune once on a narrow proxy, transfer up.\n" } },
    { subject: "[agent] add STAT 210 syllabus", author: "vault-chat-agent", at: now - 14 * DAY, changes: { "courses/stat-210/syllabus.md": C } },
    { subject: "autosave", at: now - 6 * DAY, changes: { "notes/scaling-laws.md": "# Scaling laws — the working picture\n\nThree levers set the loss: parameters $N$, tokens $D$, and compute.\n\n- Compute-optimal ratio is about **20 tokens per parameter**.\n" } },
    { subject: "autosave", at: now - 3 * DAY, changes: { "notes/mup.md": C } },
    { subject: "[agent] BitNet 160M MVP: results table (seeds 42, 44)", author: "vault-chat-agent", at: now - 2 * DAY, changes: { "projects/bitnet-160m/results.csv": "seed,tokens,steps,peak_lr,eval_loss,wall_hours,gpu\n42,1.70e9,3240,3.0e-3,1.5576,13.6,A10\n44,1.70e9,3240,3.0e-3,1.5588,13.5,A10\n" } },
    { subject: "autosave", at: now - 26 * HOUR, changes: { "daily/2026-10-08.md": C, "notes/scaling-laws.md": C } },
    { subject: "[agent] seed 43 rerun: eval.loss committed", author: "vault-chat-agent", at: now - 2 * HOUR, changes: { "projects/bitnet-160m/results.csv": C } },
    { subject: "[agent] BitNet writeup draft", body: "mission: BitNet 160M MVP", author: "vault-chat-agent", at: now - 30 * MIN, changes: { "projects/bitnet-160m/writeup.md": C } },
    { subject: "autosave", at: now - 12 * MIN, changes: { "daily/2026-10-09.md": C, "daily/2026-10-10.md": C } },
  ];
}
