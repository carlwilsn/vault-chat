// The editor's existing 300 ms autosave, with an awaitable drain. Jobs retain
// their captured path across pane switches; a failed save stays pending.
export type EditorWrite = { vault: string; path: string; text: string };
type Job = EditorWrite & { base: string; saved?: string; timer?: ReturnType<typeof setTimeout>; tail?: Promise<void>; onSaved: () => void; onConflict: () => void };

export class EditorWrites {
  private jobs = new Map<string, Job>();
  constructor(private io: { read(path: string): Promise<string>; write(path: string, text: string): Promise<void> }) {}

  queue(write: EditorWrite, base: string, onSaved: () => void, onConflict: () => void): void {
    const prev = this.jobs.get(write.path);
    if (prev?.timer) clearTimeout(prev.timer);
    const job: Job = { ...write, base: prev?.saved ?? prev?.base ?? base, tail: prev?.tail, onSaved, onConflict };
    this.jobs.set(write.path, job);
    job.timer = setTimeout(() => { job.timer = undefined; void this.save(job).catch(() => {}); }, 300);
  }

  private save(job: Job): Promise<void> {
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
    const previous = job.tail;
    const run = (async () => {
      await previous;
      const disk = await this.io.read(job.path);
      if (job.saved === job.text) {
        // Git/live reload may supersede a completed autosave. Its old hash is
        // not an unsaved buffer and must not lock every later chat forever.
        if (disk !== job.saved && this.jobs.get(job.path) === job) this.jobs.delete(job.path);
        return;
      }
      if (this.jobs.get(job.path) !== job) {
        // A newer queued edit still needs this predecessor's base, but an
        // explicit Reload/discard must cancel a save not yet written.
        if (!this.jobs.has(job.path)) return;
      }
      // A preceding queued write may have completed while this one waited.
      if (disk !== job.base && disk !== job.saved) {
        job.onConflict();
        throw new Error(`${job.path}: changed on disk; Reload or Keep mine before sending`);
      }
      await this.io.write(job.path, job.text);
      job.saved = job.text;
      const next = this.jobs.get(job.path);
      if (next && next !== job && next.base === job.base) next.base = job.text;
      job.onSaved();
    })();
    // Failures remain retryable, not a permanently rejected promise chain.
    job.tail = run.catch(() => {});
    return run;
  }

  async flush(vault: string): Promise<EditorWrite[]> {
    const jobs = [...this.jobs.values()].filter(j => j.vault === vault);
    await Promise.all(jobs.map(j => this.save(j)));
    return jobs.filter(j => this.jobs.get(j.path) === j || j.saved === j.text && this.jobs.has(j.path));
  }

  acknowledge(writes: EditorWrite[]): void {
    for (const write of writes) if (this.jobs.get(write.path) === write) this.jobs.delete(write.path);
  }

  discard(path: string): void {
    const job = this.jobs.get(path);
    if (job?.timer) clearTimeout(job.timer);
    this.jobs.delete(path);
  }
}
