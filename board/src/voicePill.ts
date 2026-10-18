// The board's voice on screen: the mic button's state (view.ts puts the button in the top-right
// controls) and, while voice is on, a small pill under them — live waves, the chat it continues
// (tap: the recent chats, to switch), mute and end. A start that fails turns it red with one plain
// line, like the laptop's red bars. The pill lives on the page, not in a board, so a call goes on
// while Carl changes boards.
//
// Its buttons follow the chrome's rule (chrome.ts): the Pencil, a finger or the mouse presses a
// button once, on pointerup, and the click iOS may add after it is dropped.
//
// `?voice=fake` swaps the ElevenLabs SDK and the box's session for voiceFake.ts (the preview).
import * as api from "./api";
import { ChromeTaps, routeChrome } from "./chrome";
import { icon, toolIcon } from "./icons";
import { onInboxEvent } from "./inbox";
import { VoiceController, type VoiceApi, type VoiceSdk, type VoiceState } from "./voice";

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

const realApi: VoiceApi = { listChats: api.listChats, voiceSession: api.voiceSession, voiceTool: api.voiceTool, voiceTranscript: api.voiceTranscript };

export const voice = new VoiceController({
  api: FAKE ? { ...realApi, voiceSession: async () => ({ signedUrl: "fake://board-preview", conversationToken: null, systemPrompt: "", toolNames: [] }) } : realApi,
  sdk: () => (FAKE ? import("./voiceFake").then((m) => m.fakeSdk()) : (import("@elevenlabs/client") as unknown as Promise<VoiceSdk>)),
  mic: FAKE ? async () => new MediaStream() : navigator.mediaDevices?.getUserMedia ? () => navigator.mediaDevices.getUserMedia({ audio: true }) : null,
  unlock: unlockAudio,
});
(window as unknown as { __voice: VoiceController }).__voice = voice;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Keep the board's mic button showing voice's state (regular idle, fill while on, red after a failed start). */
export function voiceButton(btn: HTMLElement): () => void {
  btn.innerHTML = toolIcon("microphone", "fill");
  return voice.on((s) => {
    const on = s.phase === "live" || s.phase === "connecting";
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", on ? "End voice" : "Voice");
    btn.title = on ? "End voice" : "Voice";
    btn.classList.toggle("text-[rgb(var(--sys-red))]", s.phase === "error");
  });
}

const IB = "grid h-9 w-9 shrink-0 place-items-center rounded-full transition active:scale-95";

let mounted = false;
/** The pill, once per page. */
export function mountVoicePill(): void {
  if (mounted) return;
  mounted = true;
  const root = document.createElement("div");
  root.className = "voice-pill pointer-events-none fixed right-[max(12px,env(safe-area-inset-right))] top-[calc(max(12px,env(safe-area-inset-top))+64px)] z-30 flex flex-col items-end gap-2";
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
    const waves = `<div class="waves flex h-5 items-center gap-[3px] px-1" aria-hidden="true">${'<i class="block h-full w-[3px] origin-center rounded-full"></i>'.repeat(BARS)}</div>`;
    if (s.phase === "error") {
      root.innerHTML = `<div class="pointer-events-auto material hairline shadow-float flex max-w-[460px] items-center gap-2 rounded-[22px] py-1.5 pl-3 pr-1.5 animate-pop-in" role="alert" data-voice="error">
        ${waves}
        <span class="v-reason min-w-0 text-footnote font-medium leading-[17px] text-[rgb(var(--sys-red))]"></span>
        <button class="${IB} text-sys-label/60 active:bg-sys-fill/20" data-v="dismiss" aria-label="Close">${icon("x", 18)}</button>
      </div>`;
    } else {
      const list = chatsOpen
        ? `<div class="pointer-events-auto pop material hairline shadow-pop flex w-[300px] flex-col rounded-[14px] p-1.5 text-foreground animate-pop-in origin-top-right" data-scroll>
            <div class="px-2.5 pb-1 pt-1.5 text-caption font-semibold uppercase tracking-wide text-sys-secondary/60">Continue a chat</div>
            <div class="v-chats flex flex-col"></div>
          </div>`
        : "";
      root.innerHTML = `<div class="pointer-events-auto material hairline shadow-float flex h-12 items-center gap-1 rounded-full pl-3 pr-1.5 animate-pop-in" data-voice="${s.phase}">
          ${waves}
          <button class="flex h-9 min-w-0 max-w-[240px] items-center gap-1 rounded-full px-2 text-footnote font-medium text-sys-label/70 transition active:bg-sys-fill/20 aria-expanded:bg-sys-fill/15" data-v="chats" aria-expanded="${chatsOpen}" aria-label="Chat"><span class="v-title truncate"></span><span class="shrink-0 opacity-60">${icon("caret-down", 14)}</span></button>
          <button class="v-mute ${IB} text-sys-label/80 active:bg-sys-fill/20 aria-pressed:bg-sys-label/10 aria-pressed:text-[rgb(var(--sys-red))]" data-v="mute" aria-pressed="false" aria-label="Mute">${icon("microphone", 22)}</button>
          <button class="${IB} bg-sys-red text-white shadow-sm active:bg-sys-red/80" data-v="end" aria-label="End voice">${icon("phone-disconnect", 22, "fill")}</button>
        </div>${list}`;
    }
    bars = [...root.querySelectorAll<HTMLElement>(".waves i")];
    patch(s);
  };

  const patch = (s: VoiceState) => {
    const reason = root.querySelector(".v-reason");
    if (reason) reason.textContent = s.error;
    const title = root.querySelector(".v-title");
    if (title) title.textContent = s.phase === "connecting" ? (s.chat ? `Connecting · ${s.chat.title}` : "Connecting…") : (s.chat?.title ?? "New chat");
    const mute = root.querySelector(".v-mute");
    if (mute) {
      mute.setAttribute("aria-pressed", String(s.muted));
      mute.setAttribute("aria-label", s.muted ? "Unmute" : "Mute");
      mute.innerHTML = s.muted ? icon("microphone-slash", 22, "fill") : icon("microphone", 22);
    }
    const tone = s.phase === "error" ? "bg-[rgb(var(--sys-red))]" : s.speaking ? "bg-sys-blue" : s.muted ? "bg-sys-label/25" : "bg-sys-label/70";
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
  });

  // ---- presses (chrome.ts): on pointerup, once; the click after it is dropped
  let synth = false;
  const taps = new ChromeTaps<HTMLButtonElement>((b) => {
    synth = true;
    try {
      b.click();
    } finally {
      synth = false;
    }
  });
  const btnAt = (t: EventTarget | null) => {
    const b = (t as Element | null)?.closest?.("button") ?? null;
    return b && root.contains(b) ? (b as HTMLButtonElement) : null;
  };
  const route = (e: PointerEvent) => {
    const type = e.type === "pointerdown" ? "down" : e.type === "pointerup" ? "up" : "cancel";
    routeChrome(taps, { type, id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() }, false, () => btnAt(type === "down" ? e.target : document.elementFromPoint(e.clientX, e.clientY)));
  };
  for (const t of ["pointerdown", "pointerup", "pointercancel"]) root.addEventListener(t, (e) => route(e as PointerEvent));
  root.addEventListener("click", (e) => {
    if (!synth && e.isTrusted && !taps.click(performance.now())) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const b = btnAt(e.target);
    if (!b) return;
    const v = b.dataset.v;
    if (v === "end") void voice.end();
    else if (v === "mute") voice.setMuted(!voice.state.muted);
    else if (v === "dismiss") voice.dismiss();
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
  root.addEventListener("touchmove", (e) => !(e.target as HTMLElement).closest?.("[data-scroll]") && e.preventDefault(), { passive: false });
}
