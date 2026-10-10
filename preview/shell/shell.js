// The harness shell: scenario switcher, surface tabs, Before | After | Split |
// Toggle, the fixture-data switch, and the log of backend gaps ("not faked")
// and refused outbound requests reported by the frames.
const $ = (s) => document.querySelector(s);
const SIZES = { desktop: [1400, 900], popout: [520, 820], phone: [390, 844] };
let cfg = { sides: {} };
let scenarios = [];
const state = Object.assign(
  { scenario: "home", surface: "desktop", mode: "before", base: "synthetic" },
  Object.fromEntries(new URLSearchParams(location.hash.slice(1))),
);
let toggled = "before";

function save() {
  history.replaceState(null, "", "#" + new URLSearchParams(state).toString());
}

function urlFor(side, surface, extra = {}) {
  const s = cfg.sides[side];
  if (!s) return null;
  const q = new URLSearchParams({ scenario: state.scenario, side, base: state.base, ...extra });
  if (surface === "phone") return `${s.url}/phone?${q}`;
  if (surface === "inventory") return `${s.url}/__preview/inventory?${q}`;
  if (surface === "popout-chat") return `${s.url}/?view=chat&${q}`;
  return `${s.url}/?${q}`;
}

function frame(src, [w, h], cls = "") {
  const f = document.createElement("div");
  f.className = "frame " + cls;
  const ifr = document.createElement("iframe");
  ifr.src = src;
  ifr.width = w;
  ifr.height = h;
  ifr.style.width = w + "px";
  ifr.style.height = h + "px";
  f.appendChild(ifr);
  f.dataset.w = w;
  f.dataset.h = h;
  return f;
}

function pane(side, children) {
  const p = document.createElement("div");
  p.className = "pane";
  p.dataset.side = side;
  const l = document.createElement("div");
  l.className = "lbl";
  l.innerHTML = `<b>${side === "before" ? "Before" : "After"}</b>`;
  l.append(cfg.sides[side]?.label ?? "");
  p.appendChild(l);
  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "10px";
  row.style.alignItems = "flex-start";
  for (const c of children) row.appendChild(c);
  p.appendChild(row);
  return p;
}

function framesFor(side) {
  const s = state.surface;
  if (s === "desktop") return [frame(urlFor(side, "desktop"), SIZES.desktop)];
  if (s === "phone") return [frame(urlFor(side, "phone"), SIZES.phone, "phone")];
  if (s === "popout") return [frame(urlFor(side, "desktop"), SIZES.desktop), frame(urlFor(side, "popout-chat"), SIZES.popout)];
  if (s === "inventory") return [frame(urlFor(side, "inventory"), [1200, 900])];
  return [];
}

function fit() {
  const stage = $("#stage");
  const panes = [...stage.querySelectorAll(".pane:not(.hidden)")];
  if (!panes.length) return;
  const availW = stage.clientWidth - 28 - (panes.length - 1) * 14;
  const availH = stage.clientHeight - 28 - 22;
  for (const p of stage.querySelectorAll(".pane")) {
    const frames = [...p.querySelectorAll(".frame")];
    const totalW = frames.reduce((a, f) => a + Number(f.dataset.w), 0) + (frames.length - 1) * 10;
    const maxH = Math.max(...frames.map((f) => Number(f.dataset.h)));
    const scale = Math.min(1, availW / panes.length / totalW, availH / maxH);
    for (const f of frames) {
      const w = Number(f.dataset.w), h = Number(f.dataset.h);
      f.style.width = w * scale + "px";
      f.style.height = h * scale + "px";
      f.querySelector("iframe").style.transform = `scale(${scale})`;
    }
  }
}

function render() {
  save();
  for (const b of document.querySelectorAll("#surface button")) b.classList.toggle("on", b.dataset.v === state.surface);
  const hasAfter = !!cfg.sides.after;
  for (const b of document.querySelectorAll("#mode button")) {
    b.classList.toggle("on", b.dataset.v === state.mode);
    b.disabled = b.dataset.v !== "before" && !hasAfter;
    if (b.disabled) b.title = "Start with --after <dir|branch> to compare";
  }
  if (!hasAfter && state.mode !== "before") state.mode = "before";
  for (const a of document.querySelectorAll("#list a")) a.classList.toggle("on", a.dataset.id === state.scenario);
  const sc = scenarios.find((x) => x.id === state.scenario);
  $("#sc-title").textContent = sc ? sc.title : state.scenario;
  $("#sc-notes").textContent = sc ? sc.notes : "";
  const stage = $("#stage");
  stage.innerHTML = "";
  stage.classList.toggle("stack", state.mode === "toggle");
  const sides = state.mode === "split" || state.mode === "toggle" ? ["before", "after"] : [state.mode];
  for (const side of sides) {
    const p = pane(side, framesFor(side));
    if (state.mode === "toggle" && side !== toggled) p.classList.add("hidden");
    stage.appendChild(p);
  }
  const first = urlFor(state.mode === "after" ? "after" : "before", state.surface === "popout" ? "desktop" : state.surface);
  $("#open").href = first ?? "#";
  requestAnimationFrame(fit);
}

function renderList() {
  const q = $("#filter").value.trim().toLowerCase();
  const nav = $("#list");
  nav.innerHTML = "";
  let group = null;
  for (const sc of scenarios) {
    if (q && !`${sc.id} ${sc.title} ${sc.group} ${sc.notes}`.toLowerCase().includes(q)) continue;
    if (sc.group !== group) {
      group = sc.group;
      const h = document.createElement("h4");
      h.textContent = group;
      nav.appendChild(h);
    }
    const a = document.createElement("a");
    a.href = "#";
    a.dataset.id = sc.id;
    a.textContent = sc.title;
    if (sc.surfaces.includes("phone")) {
      const s = document.createElement("span");
      s.className = "ph";
      s.textContent = "+ phone";
      a.appendChild(s);
    }
    a.onclick = (e) => {
      e.preventDefault();
      state.scenario = sc.id;
      render();
    };
    nav.appendChild(a);
  }
  render();
}

function log(kind, text, side) {
  const ul = $("#log-list");
  if (ul.firstElementChild?.classList.contains("dim")) ul.innerHTML = "";
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = `${side ?? ""} ${kind === "unfaked" ? "not faked:" : kind + ":"} ${text}`;
  ul.prepend(li);
}

window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.source !== "vc-preview") return;
  if (d.type === "report" && d.kind !== "info") {
    const side = new URL(d.href).searchParams.get("side") ?? "";
    log(d.kind, d.text, side);
  }
});

for (const b of document.querySelectorAll("#surface button"))
  b.onclick = () => {
    state.surface = b.dataset.v;
    render();
  };
for (const b of document.querySelectorAll("#mode button"))
  b.onclick = () => {
    state.mode = b.dataset.v;
    render();
  };
$("#reload").onclick = () => render();
$("#filter").oninput = renderList;
$("#log-clear").onclick = () => ($("#log-list").innerHTML = '<li class="dim">none yet</li>');
$("#base").onchange = () => {
  state.base = $("#base").value;
  render();
};
window.addEventListener("resize", fit);
window.addEventListener("keydown", (e) => {
  if (e.target !== document.body) return;
  if (e.key === "t" && state.mode === "toggle") {
    toggled = toggled === "before" ? "after" : "before";
    for (const p of document.querySelectorAll("#stage .pane")) p.classList.toggle("hidden", p.dataset.side !== toggled);
    fit();
  }
});

(async () => {
  cfg = await (await fetch("/api/config")).json();
  $("#sides").textContent = Object.entries(cfg.sides)
    .map(([k, v]) => `${k}: ${v.label}`)
    .join(" · ");
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch("/api/scenarios");
      if (r.ok) {
        scenarios = await r.json();
        break;
      }
    } catch {
      /* dev server still starting */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    const bases = await (await fetch("/api/bases")).json();
    $("#base").innerHTML = bases.map((b) => `<option value="${b}">${b === "synthetic" ? "synthetic (committed)" : b + " (private, unapproved)"}</option>`).join("");
    $("#base").value = state.base;
  } catch {
    $("#base").innerHTML = '<option value="synthetic">synthetic</option>';
  }
  if (!scenarios.length) $("#stage").innerHTML = '<p class="empty">The before dev server did not answer. Check the terminal running npm run preview.</p>';
  renderList();
})();
