// The box terminals open now (the title bar's terminal button / Ctrl+J opens one: an SSH session into the box, in the
// vault's working copy): each is an sshd session with a pseudo-terminal, seen here in /proc as "sshd-session:
// <user>@pts/<n>" (older OpenSSH: "sshd: <user>@pts/<n>"). box:links reads them; its watch hears /dev/pts change (a pty
// made or gone: the OS's file events). Closing one hangs that session up, as closing its window does.
import { readdirSync, readFileSync, watch as fsWatch } from "node:fs";

export type BoxTerminal = { pid: number; user: string; tty: string; since: string };

const SESSION = /^sshd(?:-session)?: ([^@\s]+)@(pts\/\d+)/;

export function boxTerminals(proc = "/proc"): BoxTerminal[] {
  const out: BoxTerminal[] = [];
  let pids: string[] = [];
  try {
    pids = readdirSync(proc).filter((p) => /^\d+$/.test(p));
  } catch {
    return out;
  }
  const boot = (() => {
    try {
      return Number(/btime (\d+)/.exec(readFileSync(`${proc}/stat`, "utf8"))?.[1] ?? 0);
    } catch {
      return 0;
    }
  })();
  const hz = 100;
  for (const pid of pids) {
    try {
      const cmd = readFileSync(`${proc}/${pid}/cmdline`, "utf8").replace(/\0+$/, "").replace(/\0/g, " ");
      const m = SESSION.exec(cmd);
      if (!m) continue;
      const stat = readFileSync(`${proc}/${pid}/stat`, "utf8");
      const start = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? 0);
      out.push({ pid: Number(pid), user: m[1]!, tty: m[2]!, since: boot ? new Date((boot + start / hz) * 1000).toISOString() : "" });
    } catch {
      /* a process that went while it was read */
    }
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** Hang up a box terminal (its session), as closing its window does. */
export function closeBoxTerminal(tty: string): { ok: boolean; text: string } {
  const t = boxTerminals().find((x) => x.tty === tty || `/dev/${x.tty}` === tty);
  if (!t) return { ok: false, text: `No box terminal on ${tty}; nothing was closed.` };
  try {
    process.kill(t.pid, "SIGHUP");
    return { ok: true, text: `Closed the box terminal on ${t.tty} (${t.user}).` };
  } catch (e) {
    return { ok: false, text: `Could not close it: ${(e as Error).message}` };
  }
}

/** A pty made or gone on the box: a terminal opened or closed. */
export function watchBoxTerminals(fn: () => void): () => void {
  try {
    const w = fsWatch("/dev/pts", () => fn());
    w.on("error", () => {});
    return () => w.close();
  } catch {
    return () => {};
  }
}
