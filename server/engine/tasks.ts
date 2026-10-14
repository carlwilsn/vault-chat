// A project's task queue: <vault>/.vault-chat/local/projects/<slug>/tasks.json,
// written only by the server (each change is one synchronous read-modify-write,
// so two workers never claim the same task). Workers share what they learn in
// the project's learnings.md (agent-readable, appended by the server).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../atomic";
import { longDir } from "./long";
import { mkdirSync } from "node:fs";

export type TaskStatus = "todo" | "doing" | "done" | "failed" | "gave_up";
export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  attempts: number;
  /** Minutes one attempt may take (default 60). */
  deadline_min: number;
  notes: string;
  /** The worker conversation working on it now. */
  worker?: string;
  claimedAt?: number;
  /** Failed attempts so far (for model tiering). */
  failures?: number;
  doneAt?: number;
};

const file = (vault: string, slug: string) => join(longDir(vault, slug), "tasks.json");

export function readTasks(vault: string, slug: string): Task[] {
  try {
    const v = JSON.parse(readFileSync(file(vault, slug), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeTasks(vault: string, slug: string, list: Task[]): void {
  mkdirSync(longDir(vault, slug), { recursive: true });
  const p = file(vault, slug);
  writeAtomic(p, JSON.stringify(list, null, 1), `${p}.${process.pid}.tmp`);
}

/** Change the queue in one step; `fn` returns what the caller gets back. */
export function withTasks<T>(vault: string, slug: string, fn: (list: Task[]) => T): T {
  const list = readTasks(vault, slug);
  const out = fn(list);
  writeTasks(vault, slug, list);
  return out;
}

export function addTasks(vault: string, slug: string, items: { title?: unknown; notes?: unknown; deadline_min?: unknown }[]): Task[] {
  return withTasks(vault, slug, (list) => {
    let n = list.reduce((m, t) => Math.max(m, Number(/^t(\d+)$/.exec(t.id)?.[1] ?? 0)), 0);
    const added: Task[] = [];
    for (const it of items.slice(0, 500)) {
      const title = String(it?.title ?? "").trim().slice(0, 300);
      if (!title) continue;
      const d = Number(it?.deadline_min);
      const t: Task = { id: `t${++n}`, title, status: "todo", attempts: 0, deadline_min: d > 0 ? Math.min(d, 24 * 60) : 60, notes: String(it?.notes ?? "").slice(0, 4000) };
      list.push(t);
      added.push(t);
    }
    return added;
  });
}

/** The worker's task in progress, else the next todo (attempts counted). Null: nothing left to claim. */
export function claimTask(vault: string, slug: string, worker: string): Task | null {
  return withTasks(vault, slug, (list) => {
    const mine = list.find((t) => t.status === "doing" && t.worker === worker);
    if (mine) return { ...mine };
    const t = list.find((x) => x.status === "todo");
    if (!t) return null;
    t.status = "doing";
    t.worker = worker;
    t.claimedAt = Date.now();
    t.attempts += 1;
    return { ...t };
  });
}

/**
 * Finish an attempt. done → done. failed → back to todo, or gave_up after `maxAttempts`.
 * todo → released without counting as a failure (e.g. a merge conflict to redo).
 */
export function finishTask(vault: string, slug: string, id: string, status: "done" | "failed" | "todo", note: string, maxAttempts: number): Task | null {
  return withTasks(vault, slug, (list) => {
    const t = list.find((x) => x.id === id);
    if (!t) return null;
    if (note.trim()) t.notes = `${t.notes ? `${t.notes}\n` : ""}[attempt ${t.attempts}] ${note.trim()}`.slice(-6000);
    if (status === "done") {
      t.status = "done";
      t.doneAt = Date.now();
    } else if (status === "failed") {
      t.failures = (t.failures ?? 0) + 1;
      t.status = t.attempts >= maxAttempts ? "gave_up" : "todo";
    } else {
      t.status = "todo";
      t.attempts = Math.max(0, t.attempts - 1);
    }
    delete t.worker;
    delete t.claimedAt;
    return { ...t };
  });
}

export function taskCounts(list: Task[]): Record<TaskStatus, number> & { total: number } {
  const c = { todo: 0, doing: 0, done: 0, failed: 0, gave_up: 0, total: list.length };
  for (const t of list) c[t.status] = (c[t.status] ?? 0) + 1;
  return c;
}
