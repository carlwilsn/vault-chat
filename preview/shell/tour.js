// The Tour: every new thing, before then after, full screen and live — like a
// video, but the real app playing real steps. Per change: a title card (the
// change and one plain sentence), then "Before · today" with the steps played
// on the before tree, then "After · new" with the same steps on the after tree
// (one pass per option when there are options to pick), then on to the next.
//
// Autoplays end to end. Space pauses/resumes, ←/→ previous/next phase, R
// replays the phase, Esc exits. Slides: preview/tour/tour.json.
//
// Every frame is same-origin with the shell (/before/…, /after/… are proxied
// by serve.mjs), so the shell drives a frame directly through its
// window.__preview.tour(...) (runtime/tour.ts).
(() => {
  const $ = (s) => document.querySelector(s);
  const SIZES = { desktop: [1400, 900], popout: [980, 820], phone: [390, 844] };
  const T = (window.__tour = { active: false, index: 0, phases: [], results: [], done: false, paused: false });
  let slides = [];
  let token = 0;
  let nsSeq = 0;
  let preloaded = null; // { key, el, win-getter }
  let timer = null;

  // ---- DOM ------------------------------------------------------------------
  const root = document.createElement("div");
  root.id = "tour";
  root.hidden = true;
  root.innerHTML = `
    <div id="tour-stage"></div>
    <div id="tour-bar">
      <div id="tour-label"><b></b><span></span></div>
      <span id="tour-loading">loading…</span>
      <span id="tour-paused">Paused — Space to resume</span>
      <span id="tour-hint">Space pause · ← → step · R replay · Esc exit</span>
      <div id="tour-progress"><i></i></div>
    </div>
    <div id="tour-card"><div class="in"><div class="kicker"></div><h1></h1><p></p><div class="extra"></div></div></div>`;
  document.body.appendChild(root);
  const stage = $("#tour-stage");
  const card = $("#tour-card");
  const label = $("#tour-label");

  // ---- phases -----------------------------------------------------------------
  function phasesOf(list) {
    const out = [];
    list.forEach((s, si) => {
      if (s.card) return void out.push({ si, kind: "card" });
      out.push({ si, kind: "title" });
      if (s.before !== false) out.push({ si, kind: "before" });
      const opts = s.options?.length ? s.options : [null];
      opts.forEach((o, oi) => out.push({ si, kind: "after", oi: o ? oi : null }));
    });
    return out;
  }

  /** What a live phase loads and plays. */
  function planOf(ph) {
    const s = slides[ph.si];
    const side = ph.kind;
    const o = side === "after" && ph.oi !== null ? s.options[ph.oi] : null;
    const sideCfg = (side === "before" ? s.beforeSide : s.afterSide) ?? {};
    return {
      side,
      // Which tree serves it (a slide can show two variants of the after tree),
      // extra query, and the corner label.
      tree: sideCfg.tree ?? side,
      query: sideCfg.query ?? "",
      label: sideCfg.label ?? null,
      surface: s.surface ?? "desktop",
      scenario: o?.scenario ?? sideCfg.scenario ?? s.scenario,
      steps: o?.steps ?? sideCfg.steps ?? s.steps ?? [],
      open: o?.open ?? sideCfg.open ?? s.open ?? "paced",
      pages: sideCfg.pages ?? s.pages ?? null,
      hold: s.hold ?? 2600,
      optLabel: o?.label ?? null,
    };
  }

  // ---- frames ------------------------------------------------------------------
  function src(plan, scenario, ns, extra = "") {
    const sides = window.__previewCfg?.sides ?? {};
    const base = sides[plan.tree]?.url ?? `/${plan.tree}`;
    const q = new URLSearchParams({ scenario, side: plan.tree, base: "synthetic", tour: "1", overlay: "0", ns });
    const more = plan.query ? `&${plan.query}` : "";
    if (plan.surface === "phone") return `${base}/phone?${q}${more}`;
    return `${base}/?${q}${more}${extra}`;
  }

  function buildFrames(plan, scenario) {
    const ns = `${plan.tree}-t${++nsSeq}`;
    const wrap = document.createElement("div");
    wrap.className = "tour-frames " + plan.surface;
    const mk = (u, [w, h], cls) => {
      const f = document.createElement("div");
      f.className = "tframe " + (cls ?? "");
      const ifr = document.createElement("iframe");
      ifr.src = u;
      ifr.width = w;
      ifr.height = h;
      Object.assign(ifr.style, { width: w + "px", height: h + "px" });
      f.dataset.w = w;
      f.dataset.h = h;
      f.appendChild(ifr);
      wrap.appendChild(f);
      return ifr;
    };
    let main;
    if (plan.surface === "phone") main = mk(src(plan, scenario, ns), SIZES.phone, "phone");
    else {
      main = mk(src(plan, scenario, ns), SIZES.desktop);
      if (plan.surface === "popout") mk(src(plan, scenario, ns, "&view=chat"), SIZES.popout);
    }
    wrap.main = main;
    wrap.ns = ns;
    return wrap;
  }

  // Every frame gets its own localStorage namespace on the shared origin
  // (runtime/storage.ts); a frame's keys go with it, or a long tour fills the
  // origin's quota.
  function purge(match) {
    try {
      const dead = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && match(k)) dead.push(k);
      }
      for (const k of dead) localStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
  }
  function drop(w) {
    w.remove();
    if (w.ns) purge((k) => k.startsWith(`vcp:${w.ns}:`));
  }

  // Contain, like a video in a player: the whole frame always fits the stage
  // (the space above the caption bar), centred; re-fit whenever it changes size.
  function fit(wrap) {
    const W = Math.max(50, stage.clientWidth - 16);
    const H = Math.max(50, stage.clientHeight - 16);
    const frames = [...wrap.querySelectorAll(".tframe")];
    const totalW = frames.reduce((a, f) => a + Number(f.dataset.w), 0) + (frames.length - 1) * 12;
    const maxH = Math.max(...frames.map((f) => Number(f.dataset.h)));
    const scale = Math.min(W / totalW, H / maxH, wrap.classList.contains("phone") ? 1.15 : 2);
    for (const f of frames) {
      const w = Number(f.dataset.w), h = Number(f.dataset.h);
      f.style.width = w * scale + "px";
      f.style.height = h * scale + "px";
      f.querySelector("iframe").style.transform = `scale(${scale})`;
    }
  }

  function keyOf(plan) {
    return `${plan.tree}|${plan.query}|${plan.surface}|${plan.pages ? plan.pages[0].scenario : plan.scenario}`;
  }

  /** The frame for a plan: the preloaded one when it matches, else a new one. */
  function framesFor(plan) {
    const k = keyOf(plan);
    if (preloaded && preloaded.key === k) {
      const w = preloaded.el;
      preloaded = null;
      return w;
    }
    dropPreload();
    const w = buildFrames(plan, plan.pages ? plan.pages[0].scenario : plan.scenario);
    stage.appendChild(w);
    return w;
  }
  function dropPreload() {
    if (preloaded) drop(preloaded.el);
    preloaded = null;
  }
  function preloadNext() {
    dropPreload();
    for (let i = T.index + 1; i < T.phases.length; i++) {
      const ph = T.phases[i];
      if (ph.kind === "title") continue;
      if (ph.kind === "card") return;
      const plan = planOf(ph);
      const w = buildFrames(plan, plan.pages ? plan.pages[0].scenario : plan.scenario);
      stage.appendChild(w);
      fit(w);
      preloaded = { key: keyOf(plan), el: w };
      return;
    }
  }

  // ---- waiting -----------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  class Stale extends Error {}
  async function wait(ms, my) {
    let left = ms;
    while (left > 0) {
      if (my !== token) throw new Stale();
      if (T.paused) {
        await sleep(100);
        continue;
      }
      await sleep(Math.min(100, left));
      left -= 100;
    }
    if (my !== token) throw new Stale();
  }
  async function until(fn, ms, my, what) {
    const t0 = Date.now();
    for (;;) {
      if (my !== token) throw new Stale();
      let v = null;
      try {
        v = fn();
      } catch {
        /* frame navigating */
      }
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
      await sleep(100);
    }
  }

  // ---- rendering a phase --------------------------------------------------------
  function progress() {
    const n = Math.max(1, T.phases.length - 1);
    $("#tour-progress i").style.width = `${(T.index / n) * 100}%`;
  }

  function showCard(s, kind) {
    card.classList.toggle("closing", kind === "card");
    card.querySelector(".kicker").textContent = s.kicker ?? (kind === "card" ? "" : `${s.group ?? ""}`);
    card.querySelector("h1").textContent = s.title;
    card.querySelector("p").textContent = s.caption ?? "";
    const ex = card.querySelector(".extra");
    ex.innerHTML = "";
    for (const sec of s.sections ?? []) {
      const d = document.createElement("div");
      d.className = "sec";
      const h = document.createElement("h3");
      h.textContent = sec.title;
      const ul = document.createElement("ul");
      for (const it of sec.items) {
        const li = document.createElement("li");
        li.textContent = it;
        ul.appendChild(li);
      }
      d.append(h, ul);
      ex.appendChild(d);
    }
    if (kind !== "card" && s.options?.length) {
      const d = document.createElement("div");
      d.className = "opts";
      d.textContent = `${s.options.length} options to pick from: ${s.options.map((o) => o.label).join(" · ")}`;
      ex.appendChild(d);
    }
    card.classList.add("on");
  }

  /** Wait until a hidden frame has rendered (no splash), then cross-fade it
   *  in over whatever is showing and let the rest fade out. Waiting past 15 s
   *  says "loading…" in the caption bar — never a blank or splash frame. */
  async function reveal(w, ready, my, what) {
    const lt = setTimeout(() => my === token && $("#tour-loading").classList.add("on"), 15000);
    let v;
    // A frame that hasn't rendered in 25 s (a cold dev server can answer a
    // module 504 and the page never mounts) is reloaded, up to three times.
    let tries = 0;
    const kick = setInterval(() => {
      if (my !== token || tries >= 3) return;
      tries++;
      for (const f of w.querySelectorAll("iframe")) {
        try {
          f.contentWindow.location.reload();
        } catch {
          /* gone */
        }
      }
    }, 25000);
    try {
      v = await until(ready, 120000, my, what);
    } finally {
      clearInterval(kick);
      clearTimeout(lt);
      $("#tour-loading").classList.remove("on");
    }
    fit(w);
    w.classList.add("show");
    clearStage(w);
    return v;
  }
  /** Fade out and drop every frame but `keep` (and the preloaded one). */
  function clearStage(keep) {
    for (const o of [...stage.children]) {
      if (o === keep || (preloaded && o === preloaded.el)) continue;
      if (!o.classList.contains("show")) {
        drop(o); // loaded for a phase that never came (stepped past)
        continue;
      }
      o.classList.remove("show");
      setTimeout(() => drop(o), 500);
    }
  }

  async function play(i) {
    const my = ++token;
    clearTimeout(timer);
    T.index = Math.max(0, Math.min(T.phases.length - 1, i));
    T.done = false;
    save();
    progress();
    const ph = T.phases[T.index];
    const s = slides[ph.si];
    // What was showing stays up until the next thing is ready to be seen (a
    // title card fades over it, a frame cross-fades in once it has rendered).
    const t0 = Date.now();
    const result = { phase: T.index, slide: ph.si, id: s.id, kind: ph.kind, option: ph.oi, ok: true, error: null };
    try {
      if (ph.kind === "title" || ph.kind === "card") {
        label.classList.remove("on");
        showCard(s, ph.kind);
        setTimeout(() => my === token && clearStage(null), 450);
        if (ph.kind === "title") preloadNext();
        // Recorded once the card has faded in (the checker shoots it then).
        await wait(500, my);
        if (ph.kind === "card") {
          dropPreload();
          T.results.push(result);
          T.done = T.index === T.phases.length - 1;
          return;
        }
        T.results.push(result);
        const ms = s.titleMs ?? Math.min(5200, 2200 + (s.caption?.length ?? 0) * 18 + (s.options?.length ? 900 : 0));
        await wait(ms - 500, my);
        return next(my);
      }
      const plan = planOf(ph);
      const setLabel = (extra) => {
        label.querySelector("b").textContent = plan.label ?? (plan.side === "before" ? "Before · today" : "After · new");
        label.querySelector("span").textContent = (plan.optLabel ? plan.optLabel + " — " : "") + s.title + (extra ? ` — ${extra}` : "");
        label.className = `on ${plan.side}`;
      };
      const w = framesFor(plan);
      fit(w);
      if (plan.surface === "phone") {
        const pages = plan.pages ?? [{ scenario: plan.scenario, hold: 3000 }];
        const phoneReady = (fw, sc) => () => fw.main.contentWindow?.__previewPhone?.ready && fw.main.contentWindow.location.search.includes(`scenario=${sc}`);
        let cur = w;
        let upcoming = null;
        for (const [pi, pg] of pages.entries()) {
          if (pi > 0) cur = upcoming;
          await reveal(cur, phoneReady(cur, pg.scenario), my, `phone ${pg.scenario} ready`);
          card.classList.remove("on");
          setLabel(pg.label ?? pg.scenario);
          if (pi === 0) preloadNext();
          // The next page loads hidden while this one is on screen.
          if (pages[pi + 1]) {
            upcoming = buildFrames(plan, pages[pi + 1].scenario);
            stage.appendChild(upcoming);
            fit(upcoming);
          }
          // A tap on something only one side has (Activity, say) is the point of
          // some pages: noted for the checker, not a failure.
          const pe = cur.main.contentWindow.__previewPhone.stepError;
          if (pe) (T.notes ??= []).push({ phase: T.index, page: pg.scenario, note: pe });
          await wait(pg.hold ?? 2600, my);
        }
      } else {
        const win = await reveal(w, () => w.main.contentWindow?.__preview?.ready && w.main.contentWindow, my, "app ready");
        card.classList.remove("on");
        setLabel();
        preloadNext(); // the next phase loads hidden while this one plays
        win.__preview.tourPause(T.paused);
        const r = await win.__preview.tour(plan.steps, { open: plan.open, pace: s.pace });
        if (my !== token) throw new Stale();
        if (!r.ok && !r.aborted) throw new Error(r.error ?? "steps failed");
      }
      T.results.push({ ...result, ms: Date.now() - t0 });
      await wait(plan.hold, my);
      return next(my);
    } catch (e) {
      if (e instanceof Stale) return;
      result.ok = false;
      result.error = String(e?.message ?? e);
      T.results.push({ ...result, ms: Date.now() - t0 });
      console.warn(`[tour] ${s.id} ${ph.kind}: ${result.error}`);
      label.querySelector("span").textContent += `  (step failed: ${result.error})`;
      await wait(2500, my).catch(() => {});
      if (my === token) next(my);
    }
  }

  function next(my) {
    if (my !== token) return;
    if (T.index < T.phases.length - 1) play(T.index + 1);
  }

  function abortFrames() {
    for (const ifr of stage.querySelectorAll("iframe")) {
      try {
        ifr.contentWindow?.__preview?.tourAbort?.();
      } catch {
        /* gone */
      }
    }
  }

  function setPaused(p) {
    T.paused = p;
    $("#tour-paused").classList.toggle("on", p);
    for (const ifr of stage.querySelectorAll(".tour-frames.show iframe")) {
      try {
        ifr.contentWindow?.__preview?.tourPause?.(p);
      } catch {
        /* gone */
      }
    }
  }

  // ---- enter / exit -------------------------------------------------------------
  function save() {
    const h = new URLSearchParams(location.hash.slice(1));
    h.set("tour", String(T.index));
    history.replaceState(null, "", "#" + h.toString().replace(/=$/, ""));
  }

  async function enter(at = 0) {
    if (!slides.length) {
      try {
        slides = (await (await fetch("/tour/tour.json", { cache: "no-store" })).json()).slides;
      } catch (e) {
        alert("Could not load preview/tour/tour.json: " + e);
        return;
      }
      T.phases = phasesOf(slides);
      T.slides = slides.map((s) => s.id);
    }
    T.active = true;
    purge((k) => /^vcp:(before|after)-t\d+:/.test(k)); // left by an earlier tour
    $("#stage").innerHTML = ""; // the shell's own frames stop while touring
    root.hidden = false;
    document.body.classList.add("touring");
    setPaused(false);
    play(at);
  }

  function exit() {
    token++;
    abortFrames();
    dropPreload();
    for (const w of [...stage.children]) drop(w);
    T.active = false;
    root.hidden = true;
    document.body.classList.remove("touring");
    const h = new URLSearchParams(location.hash.slice(1));
    h.delete("tour");
    history.replaceState(null, "", "#" + h.toString());
    window.__shellRender?.();
  }

  window.addEventListener("keydown", (e) => {
    if (!T.active) return;
    const k = e.key;
    if (k === "Escape") exit();
    else if (k === " ") setPaused(!T.paused);
    else if (k === "ArrowRight") {
      abortFrames();
      play(T.index + 1);
    } else if (k === "ArrowLeft") {
      abortFrames();
      play(T.index - 1);
    } else if (k === "r" || k === "R") {
      abortFrames();
      dropPreload();
      play(T.index);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  const refit = () => {
    for (const w of stage.querySelectorAll(".tour-frames")) fit(w);
  };
  window.addEventListener("resize", refit);
  if (typeof ResizeObserver === "function") new ResizeObserver(refit).observe(stage);

  // Frames' reports (not faked, refused, errors) while touring: kept for the
  // checker (tools/tour-check.mjs); the shell's own log shows them too.
  T.reports = [];
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (T.active && d?.source === "vc-preview" && d.type === "report" && d.kind !== "info") T.reports.push({ phase: T.index, kind: d.kind, text: d.text, href: d.href });
  });

  window.__tourEnter = enter;
  window.__tourExit = exit;
  $("#tour-btn")?.addEventListener("click", () => enter(0));
  // #tour or #tour=<phase> opens it (after the shell has its config).
  // Read now: the shell rewrites the hash with its own state as it starts.
  const initialHash = new URLSearchParams(location.hash.slice(1));
  const startFromHash = () => {
    const h = initialHash;
    if (h.has("tour")) enter(Number(h.get("tour")) || 0);
  };
  if (window.__previewCfg) startFromHash();
  else window.addEventListener("vc-shell-ready", startFromHash, { once: true });
})();
