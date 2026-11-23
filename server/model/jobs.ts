// The jobs noun (report 24 §4, noun 6): the asking conversation's background work. Its Agent-tool workers (state read
// from their transcripts: running / waiting on a tool / idle / finished / interrupted by a restart), its background
// workers (a `subagent` call moved to the background) and its StartJob shell jobs. Read: the list and one job's
// progress line. Act: stop a worker or a job, steer a worker: the same path the chat's background-task chip takes
// (Stop / Steer, POST /api/v1/conversations/:id/subagents/:sid/{stop,steer} → Engine.jobControl), so the agent and
// Carl stop the same thing the same way. Starting one stays the StartJob tool (it owns the turn's wake on its end).
// Watched on the events its sources give (ctl.watch): no re-reading on a timer.
// Was the JobList, JobStatus, JobStop and JobSteer tools and the list-only box:jobs offer.
import type { Noun } from "./index";

/** What the engine gives the noun for one conversation. `turn`: the asker owns a turn (a side thread or an external
 *  client reads, never stops or steers). */
export type JobsCtl = {
  list: (all: boolean) => string;
  status: (id: string, tail?: number) => string;
  control: (id: string, op: "stop" | "steer", text?: string) => Promise<{ ok: boolean; text: string }>;
  turn: boolean;
  /** Call `fn` when the work may have changed: the conversation's records (a worker's row), its workers' transcripts
   *  and the StartJob registry and logs being written. Returns the undo. */
  watch: (fn: () => void) => () => void;
};

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });

export function jobsNoun(ctl: JobsCtl): Noun {
  const owned = (op: string) => (ctl.turn ? null : { ok: false, text: `${op} needs an owning turn: this request only reads jobs. Nothing was changed.` });
  return {
    id: "jobs",
    name: "Jobs",
    state: {
      list: {
        description: "this conversation's background work: Agent-tool workers (id, task, state from their transcripts: running / waiting on tool X / IDLE / finished / interrupted by a restart, last tool, tool calls, age; an interrupted or idle one shows its SendMessage resume), background workers and StartJob shell jobs (id, state, age, command)",
        read: () => ctl.list(false),
      },
    },
    actions: {
      list: {
        readOnly: true,
        description: "the list; all: true for every StartJob job in the vault and finished workers of the last days",
        args: obj({ all: { type: "boolean" } }),
        run: (a) => ({ ok: true, text: ctl.list(a.all === true) }),
      },
      status: {
        readOnly: true,
        description: "one job's progress now, without waiting for it: a worker (its id or first 6+ characters: state, last tool and when, tool calls, files written, its latest words) or a StartJob job (state, last output lines)",
        args: obj({ id: str("its id, from the list"), tail: { type: "number", description: "output lines (StartJob)" } }, ["id"]),
        run: (a) => ({ ok: true, text: ctl.status(String(a.id ?? "").trim(), Number(a.tail) || undefined) }),
      },
      stop: {
        description: "stop a running worker or StartJob job by its id (a stopped worker's turn still follows, saying it was stopped)",
        args: obj({ id: str("its id, from the list") }, ["id"]),
        run: (a) => owned("stop") ?? ctl.control(String(a.id ?? "").trim(), "stop"),
      },
      steer: {
        description: "pass Carl's change to a running background worker (\"make it shorter\"): it takes it up after its current step and keeps going",
        args: obj({ id: str("its id, from the list"), message: str("the change, in Carl's words") }, ["id", "message"]),
        run: (a) => owned("steer") ?? ctl.control(String(a.id ?? "").trim(), "steer", String(a.message ?? "").trim()),
      },
    },
    watch: (fn) => ctl.watch(fn),
  };
}
