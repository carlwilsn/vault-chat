// Narrated play: a scenario's beats with a tutorial caption before each one,
// at a pace a person can follow. Shared by the desktop boot and the phone
// page (runtime/narratePhone.ts); it knows nothing about either app — the
// caller passes `exec` for a step, and `sleep` steps are paced here.
//
//   Space pause/play · → next (finish this step quickly) · ← previous (the
//   page replays up to it) · −/+ speed (0.5×, 1×, 2×) · R from the start
//
// 1× is today's step pace slowed 2.5× (every `sleep` in the steps), plus a
// moment to read each caption. The card sits where it covers neither what it
// explains nor the composer; what a caption names gets a soft outline.
import type { Spot } from "../scenarios/types";

export type NBeat<S> = { title: string; text: string; spot?: Spot; steps: S[]; show?: S[] };
export type NarrateOpts<S> = {
  beats: NBeat<S>[];
  /** Run one non-sleep step. */
  exec: (s: S) => Promise<void>;
  surface: "desktop" | "phone";
};

const SPEEDS = [0.5, 1, 2];
const SLOW = 2.5; // 1× = today's sleeps × 2.5
const CATCH_UP = 0.6; // replaying to a stage: a little faster than today's pace

/** `narrate` from the URL: on unless `narrate=0`, or under automation (a checker) without `narrate=1`. */
export function narrateWanted(q: URLSearchParams): boolean {
  const v = q.get("narrate");
  if (v === "0") return false;
  if (v === "1") return true;
  return !(navigator as any).webdriver;
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function findSpot(spot: Spot | undefined, host: Element | null): HTMLElement | null {
  if (!spot) return null;
  const sel = typeof spot === "string" ? spot : spot.sel ?? "div, p, span, li, summary, button";
  let els = ([...document.querySelectorAll(sel)] as HTMLElement[]).filter((e) => visible(e) && !host?.contains(e));
  if (typeof spot !== "string") {
    const re = new RegExp(spot.text);
    els = els.filter((e) => re.test((e.textContent ?? "").trim()));
    // innermost matches only
    els = els.filter((e) => !els.some((o) => o !== e && e.contains(o)));
  }
  return els[els.length - 1] ?? null;
}

function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 2) return p;
  }
  return null;
}

const CSS = (surface: "desktop" | "phone") => `
:host{
  ${
    surface === "phone"
      ? `--bg:var(--panel,#0b0b0c);--fg:var(--text,rgba(255,255,255,.92));--mute:var(--muted,rgba(255,255,255,.5));--line:var(--line,rgba(255,255,255,.12));--hi:var(--ring,rgba(255,255,255,.35));--chip:var(--raised,rgba(255,255,255,.06));`
      : `--bg:hsl(var(--popover,0 0% 18%) / .97);--fg:hsl(var(--popover-foreground,var(--foreground,0 0% 92%)));--mute:hsl(var(--muted-foreground,0 0% 60%));--line:hsl(var(--border,0 0% 22%));--hi:hsl(var(--ring,0 0% 60%));--chip:hsl(var(--accent,var(--muted,0 0% 20%)));`
  }
}
.card,.ring{position:fixed;z-index:2147483646}
.card{
  box-sizing:border-box;background:var(--bg);color:var(--fg);border:1px solid var(--line);
  border-radius:${surface === "phone" ? "14px" : "10px"};box-shadow:0 8px 28px rgba(0,0,0,.28);
  font:${surface === "phone" ? "12.5px/1.4" : "12.5px/1.45"} Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  padding:${surface === "phone" ? "9px 11px 7px" : "10px 12px 8px"};
  width:${surface === "phone" ? "calc(100vw - 20px)" : "330px"};max-width:calc(100vw - 20px);
  transition:top .35s ease,left .35s ease,opacity .25s ease;pointer-events:auto;user-select:none;
}
.card.fade{opacity:0}
.head{display:flex;align-items:baseline;gap:8px}
.n{color:var(--mute);font-size:11px;font-variant-numeric:tabular-nums;flex:none}
.t{font-weight:600;font-size:13px;letter-spacing:-.005em}
.x{color:var(--mute);margin-top:3px}
.bar{height:2px;background:var(--line);border-radius:2px;margin:8px 0 6px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--hi);transition:width .4s ease}
.ctl{display:flex;align-items:center;gap:2px;color:var(--mute);font-size:11px}
.ctl button{all:unset;cursor:pointer;padding:2px 6px;border-radius:5px;color:var(--mute);font-size:11px;line-height:16px}
.ctl button:hover{color:var(--fg);background:var(--chip)}
.ctl button.on{color:var(--fg);background:var(--chip)}
.ctl .sp{flex:1}
.ctl .k{opacity:.7;margin-right:4px}
.ring{pointer-events:none;border-radius:8px;box-shadow:0 0 0 2px var(--hi),0 0 0 6px color-mix(in srgb,var(--hi) 22%,transparent);
  transition:opacity .3s ease;opacity:0}
.ring.on{opacity:1}
`;

export async function narrate<S>(o: NarrateOpts<S>): Promise<void> {
  const q = new URLSearchParams(location.search);
  const N = o.beats.length;
  const start = Math.max(0, Math.min(N - 1, Number(q.get("narrateAt") ?? 0) || 0));
  let speed = SPEEDS.includes(Number(q.get("speed"))) ? Number(q.get("speed")) : 1;
  let paused = q.get("paused") === "1";
  let hurry = false; // → : finish this beat quickly
  let idx = start;
  let catchingUp = start > 0;

  // ---- the card --------------------------------------------------------------
  const hostEl = document.createElement("div");
  hostEl.id = "vc-narrate";
  // Its own top-level layer, above everything the app stacks.
  hostEl.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;isolation:isolate";
  document.body.appendChild(hostEl);
  const root = hostEl.attachShadow({ mode: "open" });
  // Custom properties inherit into the shadow root: the card takes the app's tokens.
  root.innerHTML = `<style>${CSS(o.surface)}</style>
    <div class="ring" part="ring"></div>
    <div class="card" role="status" aria-live="polite">
      <div class="head"><span class="n"></span><span class="t"></span></div>
      <div class="x"></div>
      <div class="bar"><i></i></div>
      <div class="ctl">
        <button data-a="prev" title="Previous step (←)">◀</button>
        <button data-a="play" title="Pause / play (Space)"></button>
        <button data-a="next" title="Next step (→)">▶</button>
        <span class="sp"></span>
        ${SPEEDS.map((s) => `<button data-s="${s}" title="Speed (− / +)">${s === 0.5 ? "½" : s}×</button>`).join("")}
      </div>
    </div>`;
  const card = root.querySelector(".card") as HTMLElement;
  const ring = root.querySelector(".ring") as HTMLElement;
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  // Before React mounts its theme class the tokens may be missing: hide until placed.
  card.style.opacity = "0";

  const paint = () => {
    $(".n").textContent = `${idx + 1}/${N}`;
    ($(".bar i") as HTMLElement).style.width = `${((idx + 1) / N) * 100}%`;
    $("[data-a=play]").textContent = paused ? "▶︎ play" : "❚❚ pause";
    for (const b of root.querySelectorAll<HTMLElement>("[data-s]")) b.classList.toggle("on", Number(b.dataset.s) === speed);
  };
  const say = (title: string, text: string) => {
    $(".t").textContent = title;
    $(".x").textContent = text;
    paint();
  };

  // ---- placement ---------------------------------------------------------------
  const composer = (): DOMRect | null => {
    const c = document.querySelector(o.surface === "phone" ? "#input" : "textarea");
    const box = (c?.closest("form") ?? c?.parentElement?.parentElement ?? c) as HTMLElement | null;
    return box && visible(box) ? box.getBoundingClientRect() : null;
  };
  const hits = (a: { x: number; y: number; w: number; h: number }, r: DOMRect | null) => !!r && a.x < r.right && a.x + a.w > r.left && a.y < r.bottom && a.y + a.h > r.top;
  const place = (avoid: DOMRect | null) => {
    const w = card.offsetWidth, h = card.offsetHeight, W = innerWidth, H = innerHeight, m = o.surface === "phone" ? 10 : 16;
    const comp = composer();
    const spots =
      o.surface === "phone"
        ? [
            { k: "top", x: (W - w) / 2, y: 58 },
            { k: "above-composer", x: (W - w) / 2, y: (comp ? comp.top : H) - h - 10 },
            { k: "top0", x: (W - w) / 2, y: m },
          ]
        : [
            { k: "bottom-left", x: m, y: H - h - m },
            { k: "top-center", x: (W - w) / 2, y: m + 36 },
            { k: "top-left", x: m, y: m + 36 },
          ];
    const pick = spots.find((s) => !hits({ ...s, w, h }, avoid) && !hits({ ...s, w, h }, comp)) ?? spots[0];
    card.style.left = `${Math.round(pick.x)}px`;
    card.style.top = `${Math.round(Math.max(m, pick.y))}px`;
    card.style.opacity = "";
  };

  // ---- highlight -----------------------------------------------------------------
  let ringFor: HTMLElement | null = null;
  let restore: (() => void) | null = null;
  const clipRect = (el: HTMLElement): DOMRect | null => {
    const r = el.getBoundingClientRect();
    let L = r.left, T = r.top, R = r.right, B = r.bottom;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "hidden") {
        const pr = p.getBoundingClientRect();
        L = Math.max(L, pr.left), T = Math.max(T, pr.top), R = Math.min(R, pr.right), B = Math.min(B, pr.bottom);
      }
    }
    L = Math.max(L, 0), T = Math.max(T, 0), R = Math.min(R, innerWidth), B = Math.min(B, innerHeight);
    return R - L > 2 && B - T > 2 ? new DOMRect(L, T, R - L, B - T) : null;
  };
  const track = () => {
    if (!ringFor) return;
    const r = ringFor.isConnected ? clipRect(ringFor) : null;
    if (r) {
      const pad = 4;
      Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
      ring.classList.add("on");
    } else ring.classList.remove("on");
    requestAnimationFrame(track);
  };
  const highlight = async (el: HTMLElement) => {
    // Off screen (above the newest reply, say): bring it into view, and put the
    // thread back at its end afterwards if that is where it was.
    const sc = scroller(el);
    const r = el.getBoundingClientRect();
    const view = sc ? sc.getBoundingClientRect() : new DOMRect(0, 0, innerWidth, innerHeight);
    if (sc && (r.top < view.top + 8 || r.top > view.bottom - 40)) {
      const atEnd = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
      el.scrollIntoView({ block: r.height > view.height * 0.7 ? "start" : "center", behavior: "smooth" });
      restore = atEnd ? () => sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" }) : null;
      await new Promise((res) => setTimeout(res, 450));
    }
    ringFor = el;
    track();
    place(clipRect(el));
  };
  const unhighlight = () => {
    ringFor = null;
    ring.classList.remove("on");
    const r = restore;
    restore = null;
    r?.();
  };

  // ---- time --------------------------------------------------------------------
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** A pausable sleep of `ms` at today's pace, scaled by the narration's. */
  const wait = async (ms: number, kind: "step" | "dwell") => {
    let left = catchingUp ? ms * CATCH_UP : kind === "step" ? (ms * SLOW) / speed : ms / speed;
    if (catchingUp && kind === "dwell") return;
    while (left > 0) {
      if (hurry) {
        if (kind === "dwell") return;
        left = Math.min(left, ms * 0.3);
        await tick(left);
        return;
      }
      if (paused && !catchingUp) {
        await tick(60);
        continue;
      }
      const d = Math.min(60, left);
      await tick(d);
      left -= d;
    }
  };
  const gate = async () => {
    while (paused && !hurry) await tick(60);
  };

  const go = (at: number, keepPaused = paused) => {
    const u = new URL(location.href);
    u.searchParams.set("narrateAt", String(Math.max(0, Math.min(N - 1, at))));
    u.searchParams.set("speed", String(speed));
    if (keepPaused) u.searchParams.set("paused", "1");
    else u.searchParams.delete("paused");
    location.replace(u.toString());
  };
  const act = (a: string) => {
    if (catchingUp && a !== "speed") return;
    if (a === "play") paused = !paused;
    else if (a === "next") hurry = true;
    else if (a === "prev") go(idx - 1);
    else if (a === "restart") go(0, false);
    paint();
  };
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    if (b.dataset.s) {
      speed = Number(b.dataset.s);
      paint();
    } else act(b.dataset.a!);
  });
  const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  addEventListener(
    "keydown",
    (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || !e.isTrusted || editable(e.target)) return;
      const k = e.key;
      const step = (d: number) => (speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + d))]);
      if (k === " ") act("play");
      else if (k === "ArrowRight") act("next");
      else if (k === "ArrowLeft") act("prev");
      else if (k === "-" || k === "_") step(-1);
      else if (k === "+" || k === "=") step(1);
      else if (k === "r" || k === "R") act("restart");
      else return;
      e.preventDefault();
      e.stopPropagation();
      paint();
    },
    true,
  );
  // A narrated step focuses the composer to type; give the keys back after it.
  const releaseFocus = () => {
    const a = document.activeElement as HTMLElement | null;
    if (a && editable(a)) a.blur();
  };

  const run = async (steps: S[]) => {
    for (const s of steps) {
      if (s && typeof s === "object" && "sleep" in (s as any) && Object.keys(s as any).length === 1) await wait((s as any).sleep, "step");
      else {
        if (!catchingUp && !hurry) await gate();
        await o.exec(s);
      }
    }
  };

  // ---- play ----------------------------------------------------------------------
  if (catchingUp) {
    say("Catching up…", `Replaying to step ${start + 1} of ${N}.`);
    place(null);
    for (let i = 0; i < start; i++) {
      idx = i;
      paint();
      await run([...o.beats[i].steps, ...(o.beats[i].show ?? [])]);
    }
    releaseFocus();
    catchingUp = false;
  }
  for (let i = start; i < N; i++) {
    const b = o.beats[i];
    idx = i;
    hurry = false;
    unhighlight();
    card.classList.add("fade");
    await tick(180);
    say(b.title, b.text);
    place(null);
    card.classList.remove("fade");
    const words = `${b.title} ${b.text}`.split(/\s+/).length;
    await wait(Math.min(1600, 500 + 30 * words), "dwell");
    await gate();
    await run(b.steps);
    await run(b.show ?? []);
    releaseFocus();
    let el: HTMLElement | null = null;
    for (let t = 0; t < 25 && b.spot && !(el = findSpot(b.spot, hostEl)); t++) await tick(80);
    if (el) await highlight(el);
    await wait(el ? 1900 : 900, "dwell");
    await gate();
  }
  unhighlight();
  hurry = false;
  idx = N - 1;
  say("That's the whole conversation", "R plays it again from the start; ◀ steps back.");
  place(null);
}
