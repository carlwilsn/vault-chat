/* harness-loop UI recorder — lane-tagged MutationObserver for the phone cockpit.
 *
 * Why: the two-lane flash (a reply appears → vanishes → returns) is sub-second.
 * Screenshots and interval sampling can land between frames and miss it entirely.
 * A MutationObserver fires on EVERY discrete DOM change with a timestamp, so an
 * add → remove → re-add is captured as three stamped events — it cannot slip
 * between samples. And because it tags WHICH lane each change hits (#liveEdge =
 * the executor's live thought-chain; #chatEdge = the frozen conversational-front
 * reply that phone.html $("chatEdge").remove()s on unfreeze), the output names
 * the bug (a message hopping lanes = reconciliation) rather than just "flicker".
 *
 * Usage (via preview_eval):
 *   1) paste this whole file
 *   2) __flashStart()                 // reset + begin recording
 *   3) <trigger the two-lane turn: send a message while the executor is working>
 *   4) __flashSummary()               // condensed per-message lane-hop timeline
 *      __flashDump()                  // full raw event log if you need detail
 */
(function () {
  const state = { t0: 0, log: [], obs: null };
  window.__flashState = state;

  // Which lane does a node belong to? Walk self-or-ancestor to find the lane root.
  function laneOf(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el) {
      if (el.id === "liveEdge") return "live-edge";
      if (el.id === "chatEdge") return "chat-edge";
      el = el.parentElement;
    }
    return null; // not in either lane — ignore, keeps the log focused
  }

  // A best-effort stable-ish key for a node, so add/remove/re-add of the SAME
  // message line can be correlated across events.
  function keyOf(node) {
    if (!node) return "?";
    if (node.nodeType === 3) return "text:" + (node.textContent || "").trim().slice(0, 24);
    const id = node.id ? "#" + node.id : "";
    const mid = node.getAttribute && (node.getAttribute("data-mid") || node.getAttribute("data-id"));
    const cls = node.className && typeof node.className === "string"
      ? "." + node.className.trim().split(/\s+/).slice(0, 2).join(".")
      : "";
    const txt = (node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
    return (mid ? "mid=" + mid + " " : "") + id + cls + (txt ? ' "' + txt + '"' : "");
  }

  function stamp() {
    return Math.round((performance.now() - state.t0));
  }

  function record(ev) {
    state.log.push(ev);
  }

  window.__flashStart = function () {
    if (state.obs) state.obs.disconnect();
    state.t0 = performance.now();
    state.log = [];
    // Observe the whole document subtree; laneOf() filters to the two lanes, so
    // we never depend on knowing the sheet container's id, and we still catch a
    // lane node created deep in a rebuild.
    state.obs = new MutationObserver(function (muts) {
      for (const m of muts) {
        if (m.type === "childList") {
          for (const n of m.addedNodes) {
            const lane = laneOf(n) || laneOf(m.target);
            if (lane) record({ t: stamp(), op: "add", lane, node: keyOf(n) });
          }
          for (const n of m.removedNodes) {
            // removed nodes are detached, so infer lane from the mutation target
            const lane = laneOf(n) || laneOf(m.target);
            if (lane) record({ t: stamp(), op: "remove", lane, node: keyOf(n) });
          }
        } else if (m.type === "attributes") {
          const lane = laneOf(m.target);
          if (lane) {
            const el = m.target;
            const val = m.attributeName === "style"
              ? (el.getAttribute("style") || "")
              : (el.getAttribute(m.attributeName) || "");
            // Only log attrs that can produce a visual flash.
            if (/^(style|class|hidden)$/.test(m.attributeName)) {
              record({ t: stamp(), op: "attr:" + m.attributeName, lane, node: keyOf(el), val: val.slice(0, 60) });
            }
          }
        } else if (m.type === "characterData") {
          const lane = laneOf(m.target);
          if (lane) record({ t: stamp(), op: "text", lane, node: keyOf(m.target) });
        }
      }
    });
    state.obs.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
      attributeFilter: ["style", "class", "hidden"],
    });
    return "recording… trigger the two-lane turn, then call __flashSummary()";
  };

  window.__flashStop = function () {
    if (state.obs) { state.obs.disconnect(); state.obs = null; }
    return "stopped; " + state.log.length + " events";
  };

  window.__flashDump = function () {
    return JSON.stringify(state.log, null, 0);
  };

  // Condensed, human-readable: group by node key, show the lane-hop sequence.
  window.__flashSummary = function () {
    if (!state.log.length) return "NO MUTATIONS RECORDED — either nothing flashed, or you didn't trigger the two-lane turn while recording.";
    const byNode = new Map();
    for (const e of state.log) {
      const k = e.node;
      if (!byNode.has(k)) byNode.set(k, []);
      byNode.get(k).push(e);
    }
    const lines = [];
    // Flag the classic flash: a node added → removed → added (a re-render churned it).
    for (const [k, evs] of byNode) {
      const seq = evs.map((e) => `${e.op}→${e.lane}@${e.t}ms`).join("  ·  ");
      const adds = evs.filter((e) => e.op === "add").length;
      const removes = evs.filter((e) => e.op === "remove").length;
      const flapped = adds >= 2 || (adds >= 1 && removes >= 1);
      const lanes = new Set(evs.map((e) => e.lane));
      const hopped = lanes.size > 1;
      const flag = hopped ? "  ⚑ LANE-HOP" : flapped ? "  ⚑ FLAP" : "";
      lines.push(`${k}${flag}\n    ${seq}`);
    }
    const total = state.log.length;
    const span = state.log[state.log.length - 1].t - state.log[0].t;
    return `${byNode.size} node(s), ${total} mutations over ${span}ms:\n\n` + lines.join("\n");
  };
})();
