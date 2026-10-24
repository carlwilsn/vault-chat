// The board's voice on screen: the mic button (view.ts puts it in the top-right controls) starts a
// call; while one is on, the button steps aside and one compact pill under the controls is the call:
// live waves, the chat it continues (small; tap: the recent chats, to switch), mute, and the one end
// button. Mute is the big, plain toggle (Carl lets voice sit muted while he works and unmutes to ask):
// muted, it is red with a slashed mic and says "Muted"; the SDK's own mute, so no audio leaves the iPad
// while the voice can still speak a result. Held down while muted, it talks while held (push to talk).
// Voice taken over by another device says where it went ("Voice moved to laptop."), not in red. A start that fails shows the mic red and the pill one plain line, like the laptop's red bars. The pill lives on the page, not in a board, so a call goes on
// while Carl changes boards.
//
// Its buttons follow the chrome's rule (chrome.ts): the Pencil, a finger or the mouse presses a
// button once, on pointerup, and the click iOS may add after it is dropped.
//
// `?voice=fake` swaps the ElevenLabs SDK and the box's session for voiceFake.ts (the preview).
import * as api from "./api";
import { ChromeTaps, buttonName, isField, redrawnSame, routeChrome } from "./chrome";
import { icon, toolIcon } from "./icons";
import { onInboxEvent } from "./inbox";
import { AUDIO_WARN_LINE, VoiceController, type VoiceApi, type VoiceSdk, type VoiceState } from "./voice";
import { blog, setStatSource, tapLine } from "./log";
import { WaitTracker, renderWaitLine, type WaitCalib, type WaitPlan, type WaitWork } from "../../src/voiceWaitLine";
import { MAIN_ID } from "../../src/threads";

const FAKE = /[?&]voice=fake\b/.test(location.search);
const BARS = 5;

let actx: AudioContext | null = null;
/** iOS: audio plays only after a sound started in a tap. A silent buffer, in the tap. */
function unlockAudio(): void {
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  actx = actx || new AC();
  if (actx.state === "suspended") void actx.resume().catch(() => {});
  const b = actx.createBuffer(1, 1, 22050);
  const s = actx.createBufferSource();
  s.buffer = b;
  s.connect(actx.destination);
  s.start(0);
}

const realApi: VoiceApi = { listChats: api.listChats, voiceSession: api.voiceSession, voiceTool: api.voiceTool, voiceTranscript: api.voiceTranscript, voiceUpdates: api.voiceUpdates, brainEngine: api.brainEngine, brainPost: api.brainPost };

/** The board's one voice conversation, remembered on this iPad for THREAD_MS (a new day starts from the latest chat). */
const THREAD_KEY = "vc_board_voice_thread";
const THREAD_MS = 12 * 3600_000;
function threadStore(): { get(): string | null; set(id: string | null): void } {
  return {
    get: () => {
      try {
        const j = JSON.parse(localStorage.getItem(THREAD_KEY) ?? "null") as { id?: string; at?: number } | null;
        return j?.id && typeof j.at === "number" && Date.now() - j.at < THREAD_MS ? j.id : null;
      } catch {
        return null;
      }
    },
    set: (id) => {
      try {
        if (id) localStorage.setItem(THREAD_KEY, JSON.stringify({ id, at: Date.now() }));
        else localStorage.removeItem(THREAD_KEY);
      } catch {
        /* storage blocked: this page only */
      }
    },
  };
}

export const voice = new VoiceController({
  api: FAKE ? { ...realApi, voiceSession: async () => ({ signedUrl: "fake://board-preview", conversationToken: null, systemPrompt: "", toolNames: [] }) } : realApi,
  sdk: () => (FAKE ? import("./voiceFake").then((m) => m.fakeSdk()) : (import("@elevenlabs/client") as unknown as Promise<VoiceSdk>)),
  // The preview's mic: an empty stream (a WebKit without media capture has no MediaStream: a stand-in with no tracks).
  mic: FAKE ? async () => (typeof MediaStream === "function" ? new MediaStream() : ({ getTracks: () => [] } as unknown as MediaStream)) : navigator.mediaDevices?.getUserMedia ? () => navigator.mediaDevices.getUserMedia({ audio: true }) : null,
  unlock: unlockAudio,
  threadStore: threadStore(),
  // Every close, with who closed it and why (the board's log): the evidence for a call that keeps dropping.
  onClose: (c) => blog("voice.close", { ...c }),
  // The call's mic: pinned, switched when unplugged, and every device change (src/voiceMic.ts).
  ...(FAKE ? { devices: null } : {}),
  audioContexts: () => [actx],
  // "voice turn" keeps the laptop's name (one query finds every device's turns); the rest are the board's own.
  log: (ev, data) => blog(ev === "voice turn" ? ev : ev.replace(/^voice /, "voice.").replace(/ /g, "-"), data),
});

(window as unknown as { __voice: VoiceController }).__voice = voice;
// Voice's phases (start, live, stop, a failure and why) and the chat it joins, in the board's log.
{
  let last = { phase: voice.state.phase as string, error: "", chat: null as string | null, muted: false };
  voice.on((st) => {
    const chat = st.chat?.id ?? null;
    if (st.phase !== last.phase || (st.error && st.error !== last.error)) blog("voice", { phase: st.phase, ...(st.error ? { error: st.error.slice(0, 200) } : {}), ...(chat ? { conv: chat } : {}) });
    else if (chat !== last.chat && st.phase === "live") blog("voice.chat", { conv: chat });
    if (st.muted !== last.muted && st.phase === "live") blog("voice.muted", { on: st.muted });
    last = { phase: st.phase, error: st.error, chat, muted: st.muted };
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Keep the board's mic button showing voice's state: it starts a call, and while one is connecting or on it is
 * hidden — the pill is the call, with the one end button (it was a second "End voice" beside the pill's own).
 * Red after a failed start (tap: try again).
 */
export function voiceButton(btn: HTMLElement): () => void {
  btn.innerHTML = toolIcon("microphone", "fill");
  return voice.on((s) => {
    const on = s.phase === "live" || s.phase === "connecting";
    btn.style.display = on ? "none" : "";
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", "Voice");
    btn.title = "Voice";
    btn.classList.toggle("text-[rgb(var(--sys-red))]", s.phase === "error");
  });
}

const IB = "grid h-8 w-8 shrink-0 place-items-center rounded-full transition active:scale-95";
/** How long the mute button is held (while muted) before it talks: shorter is a tap (unmute). */
const HOLD_MS = 300;
/** Another device took the call over: said plainly, not as a failure. */
const isMoved = (s: VoiceState) => s.phase === "error" && /^Voice moved to /.test(s.error);

let mounted = false;
/** The pill, once per page. */
export function mountVoicePill(): void {
  if (mounted) return;
  mounted = true;
  const root = document.createElement("div");
  root.className = "voice-pill pointer-events-none fixed right-[max(12px,env(safe-area-inset-right))] top-[calc(max(12px,env(safe-area-inset-top))+62px)] z-30 flex flex-col items-end gap-2";
  document.body.appendChild(root);
  // A landed inbox entry (or a make that failed): one short line at the next pause, as on the laptop.
  onInboxEvent((ev) => {
    if (typeof ev.say === "string" && ev.say) voice.announce(ev.say);
  });

  let built = "";
  let chatsOpen = false;
  let bars: HTMLElement[] = [];
  let raf = 0;
  const smooth = new Array(BARS).fill(0);

  const build = (s: VoiceState) => {
    const key = `${s.phase}|${chatsOpen}`;
    if (key === built) return patch(s);
    built = key;
    if (s.phase === "idle") {
      root.innerHTML = "";
      bars = [];
      return;
    }
    // The waves, and under them the waiting line (src/voiceWaitLine.ts): the same element as on the laptop and phone.
    const waves = `<div class="flex shrink-0 flex-col items-stretch text-sys-label/70"><div class="waves flex h-4 shrink-0 items-center gap-[2.5px] px-0.5" aria-hidden="true">${'<i class="block h-full w-[3px] origin-center rounded-full"></i>'.repeat(BARS)}</div><div class="v-waitline"></div></div>`;
    if (s.phase === "error") {
      root.innerHTML = `<div class="pointer-events-auto material hairline shadow-float flex min-h-10 max-w-[460px] items-center gap-2 rounded-[20px] py-1 pl-3 pr-1 animate-pop-in" role="${isMoved(s) ? "status" : "alert"}" data-voice="${isMoved(s) ? "moved" : "error"}">
        ${waves}
        <span class="v-reason min-w-0 text-footnote font-medium leading-[17px] ${isMoved(s) ? "text-sys-label/80" : "text-[rgb(var(--sys-red))]"}"></span>
        <button class="${IB} text-sys-label/60 active:bg-sys-fill/20" data-v="dismiss" aria-label="Close">${icon("x", 16)}</button>
      </div>`;
    } else {
      const list = chatsOpen
        ? `<div class="pointer-events-auto pop material hairline shadow-pop flex w-[300px] flex-col rounded-[14px] p-1.5 text-foreground animate-pop-in origin-top-right" data-scroll>
            <div class="px-2.5 pb-1 pt-1.5 text-caption font-semibold uppercase tracking-wide text-sys-secondary/60">Continue a chat</div>
            <div class="v-chats flex flex-col"></div>
          </div>`
        : "";
      // One row, 40 px: the waves, the chat (small, tap to switch), mute, end.
      root.innerHTML = `<div class="pointer-events-auto material hairline shadow-float flex h-10 items-center gap-0.5 rounded-full pl-3 pr-1 animate-pop-in" data-voice="${s.phase}">
          ${waves}
          <button class="ml-1 flex h-8 min-w-0 max-w-[180px] items-center gap-0.5 rounded-full px-1.5 text-caption font-medium text-sys-label/70 transition active:bg-sys-fill/20 aria-expanded:bg-sys-fill/15" data-v="chats" aria-expanded="${chatsOpen}" aria-label="Chat"><span class="v-title truncate"></span><span class="shrink-0 opacity-60">${icon("caret-down", 12)}</span></button>
          <button class="v-mute flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-footnote font-semibold transition active:scale-95" data-v="mute" aria-pressed="false" aria-label="Mute"></button>
          <button class="${IB} bg-sys-red text-white shadow-sm active:bg-sys-red/80" data-v="end" aria-label="End call">${icon("phone-disconnect", 18, "fill")}</button>
        </div>${list}`;
    }
    bars = [...root.querySelectorAll<HTMLElement>(".waves i")];
    patch(s);
  };

  const patch = (s: VoiceState) => {
    const reason = root.querySelector(".v-reason");
    if (reason) reason.textContent = s.error;
    const title = root.querySelector(".v-title");
    if (title) title.textContent = s.phase === "connecting" ? (s.chat ? `Connecting · ${s.chat.title}` : "Connecting…") : s.audio ? AUDIO_WARN_LINE : (s.chat?.title ?? "New chat");
    // No sound can play: the title is the warning (amber), and a tap on it reconnects the audio.
    const chatsBtn = root.querySelector<HTMLElement>('[data-v="chats"]');
    if (chatsBtn) {
      chatsBtn.dataset.audio = s.audio ? "warn" : "";
      chatsBtn.classList.toggle("text-[#ff9500]", !!s.audio);
      chatsBtn.classList.toggle("font-semibold", !!s.audio);
    }
    const mute = root.querySelector<HTMLElement>(".v-mute");
    if (mute) {
      mute.setAttribute("aria-pressed", String(s.muted));
      mute.setAttribute("aria-label", s.muted ? "Unmute" : "Mute");
      mute.dataset.muted = String(s.muted);
      // Muted: unmistakable (solid red, a slashed mic, the word). Live: the mic and "Mute".
      mute.classList.toggle("bg-[rgb(var(--sys-red))]", s.muted);
      mute.classList.toggle("text-white", s.muted);
      mute.classList.toggle("bg-sys-fill/15", !s.muted);
      mute.classList.toggle("text-sys-label/85", !s.muted);
      mute.innerHTML = s.muted ? `${icon("microphone-slash", 18, "fill")}<span>Muted</span>` : `${icon("microphone", 18)}<span>Mute</span>`;
    }
    const tone = s.phase === "error" ? (isMoved(s) ? "bg-sys-label/25" : "bg-[rgb(var(--sys-red))]") : s.audio ? "bg-[#ff9500]" : s.speaking ? "bg-sys-blue" : s.muted ? "bg-sys-label/25" : "bg-sys-label/70";
    for (const b of bars) b.className = `block h-full w-[3px] origin-center rounded-full ${tone}${s.phase === "connecting" ? " v-wait" : ""}`;
    const list = root.querySelector(".v-chats");
    if (list) {
      const rows = s.chats.slice(0, 8);
      list.innerHTML = rows.length
        ? rows
            .map(
              (c) => `<button class="flex h-11 items-center gap-2 rounded-[9px] px-2.5 text-left transition active:bg-sys-fill/20" data-v="chat" data-id="${esc(c.id)}">
                <span class="min-w-0 flex-1 truncate text-subhead ${c.id === s.chat?.id ? "font-semibold text-sys-label" : "text-sys-label/85"}">${esc(c.title || "New chat")}</span>
                <span class="shrink-0 text-footnote tabular-nums text-sys-secondary/60">${ago(c.lastActivityAt)}</span>
                <span class="w-4 shrink-0 text-sys-blue">${c.id === s.chat?.id ? icon("check", 16) : ""}</span>
              </button>`,
            )
            .join("")
        : `<div class="px-2.5 py-3 text-footnote text-sys-secondary/60">No chats yet: this call starts one.</div>`;
    }
    loop(s);
  };

  // The waiting line: what the voice waits on, from the box (the board has no conversation feed), until it speaks.
  let waitTimer = 0;
  let waitTracker = new WaitTracker();
  let wait: { works: WaitWork[]; plan: WaitPlan | null; calib: WaitCalib; skew: number } = { works: [], plan: null, calib: {}, skew: 0 };
  let waitBusy = false;
  const waitLoop = (s: VoiceState) => {
    if (s.phase !== "live") {
      clearInterval(waitTimer);
      waitTimer = 0;
      waitTracker = new WaitTracker();
      return;
    }
    if (waitTimer) return;
    let n = 0;
    waitTimer = window.setInterval(() => {
      const st = voice.state;
      if (n++ % 2 === 0 && !waitBusy) {
        waitBusy = true;
        api
          .brainWait(st.chat?.id ?? MAIN_ID)
          .then((r) => (wait = { works: r.works ?? [], plan: r.plan ?? null, calib: r.calib ?? {}, skew: Date.now() - (r.now ?? Date.now()) }))
          .catch(() => {})
          .finally(() => (waitBusy = false));
      }
      const el = root.querySelector<HTMLElement>(".v-waitline");
      // Box times on this clock (the box's now vs ours).
      const works = wait.works.map((w) => ({ ...w, startedAt: w.startedAt + wait.skew }));
      if (el) renderWaitLine(el, waitTracker.update({ works, plan: wait.plan, calib: wait.calib, now: Date.now(), speaking: st.speaking }));
    }, 300);
  };

  // The waves: the SDK's mic level while Carl talks (flat while muted), the agent's output while it speaks.
  const loop = (s: VoiceState) => {
    cancelAnimationFrame(raf);
    raf = 0;
    if (s.phase !== "live") {
      for (const b of bars) b.style.transform = s.phase === "error" ? "scaleY(.55)" : "";
      return;
    }
    const frame = () => {
      const st = voice.state;
      let lv: number[];
      if (st.speaking) {
        const l = voice.outputLevel();
        lv = Array.from({ length: BARS }, (_, i) => l * (0.55 + 0.45 * Math.sin((i / (BARS - 1)) * Math.PI)));
      } else {
        // Carl's level from the SDK's own mic stream (the one the call sends).
        const l = voice.inputLevel();
        lv = Array.from({ length: BARS }, (_, i) => l * (0.55 + 0.45 * Math.sin((i / (BARS - 1)) * Math.PI)));
      }
      bars.forEach((b, i) => {
        smooth[i] = Math.max(lv[i]!, smooth[i]! * 0.85);
        b.style.transform = `scaleY(${(0.2 + Math.min(1, smooth[i]!) * 0.8).toFixed(3)})`;
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  };

  voice.on((s) => {
    if (s.phase !== "live" && s.phase !== "connecting") chatsOpen = false;
    build(s);
    waitLoop(s);
  });

  // ---- presses (chrome.ts): on pointerup, once; the click after it is dropped
  let synth = false;
  const taps = new ChromeTaps<HTMLButtonElement>(
    (b) => {
      synth = true;
      try {
        b.click();
      } finally {
        synth = false;
      }
    },
    { same: redrawnSame, name: buttonName },
  );
  // The pill's taps in the board's log too (its chat switch, mute and end are not the board's chrome).
  setStatSource("taps:pill", "taps", () => tapLine(taps.takeStats(), "pill"));
  const btnAt = (t: EventTarget | null) => {
    const b = (t as Element | null)?.closest?.("button") ?? null;
    return b && root.contains(b) ? (b as HTMLButtonElement) : null;
  };
  const route = (e: PointerEvent) => {
    const type = e.type === "pointerdown" ? "down" : e.type === "pointerup" ? "up" : "cancel";
    routeChrome(taps, { type, id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() }, false, () => btnAt(type === "down" ? e.target : document.elementFromPoint(e.clientX, e.clientY)));
  };
  // Push to talk: the mute button held down while muted talks while held (the tap after it is not a toggle).
  let hold: { id: number; timer: ReturnType<typeof setTimeout>; talking: boolean } | null = null;
  let dropMuteTap = false;
  root.addEventListener(
    "pointerdown",
    (e) => {
      dropMuteTap = false;
      const b = btnAt(e.target);
      if (!b || b.dataset.v !== "mute" || !voice.state.muted || voice.state.phase !== "live") return;
      const h = { id: e.pointerId, talking: false, timer: setTimeout(() => {
        h.talking = true;
        voice.setMuted(false);
        blog("voice.ptt", { on: true });
      }, HOLD_MS) };
      hold = h;
    },
    true,
  );
  const release = (e: Event) => {
    const h = hold;
    if (!h || (e as PointerEvent).pointerId !== h.id) return;
    hold = null;
    clearTimeout(h.timer);
    if (!h.talking) return;
    dropMuteTap = true;
    voice.setMuted(true);
    blog("voice.ptt", { on: false });
  };
  root.addEventListener("pointerup", release, true);
  root.addEventListener("pointercancel", release, true);
  for (const t of ["pointerdown", "pointerup", "pointercancel"]) root.addEventListener(t, (e) => route(e as PointerEvent));
  root.addEventListener("click", (e) => {
    if (!synth && e.isTrusted && !isField(e.target) && !taps.click(performance.now())) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const b = btnAt(e.target);
    if (!b) return;
    const v = b.dataset.v;
    if (v === "end") void voice.end("pill");
    else if (v === "mute") {
      if (dropMuteTap) dropMuteTap = false;
      else voice.setMuted(!voice.state.muted);
    }
    else if (v === "dismiss") voice.dismiss();
    else if (v === "chats" && voice.state.audio) void voice.reconnectAudio();
    else if (v === "chats") {
      chatsOpen = !chatsOpen;
      build(voice.state);
      // The list as it is now (a chat may have moved up since the call started).
      if (chatsOpen) void api.listChats().then((rows) => voice.refreshChats(rows)).catch(() => {});
    } else if (v === "chat" && b.dataset.id) {
      chatsOpen = false;
      void voice.switchChat(b.dataset.id);
    }
  });
  // Keep the pill's touches its own (no page scroll, no callout).
  root.addEventListener("touchmove", (e) => !isField(e.target) && !(e.target as HTMLElement).closest?.("[data-scroll]") && e.preventDefault(), { passive: false });
}
