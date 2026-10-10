// Drives the real app to a scenario's screen with real DOM input: clicks,
// key chords dispatched on the focused element, typing through React's value
// setter. Titlebar modals are local React state, so there is no store
// shortcut — the steps press the same buttons and keys Carl would.
import type { Step, StepApi } from "../scenarios/types";
import { advance } from "./clock";
import { emitFromBackend } from "./ipc";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function visible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect?.();
  return !!r && r.width > 0 && r.height > 0;
}

export function q(sel: string): HTMLElement | null {
  return ([...document.querySelectorAll(sel)] as HTMLElement[]).find(visible) ?? null;
}
export function qa(sel: string): HTMLElement[] {
  return ([...document.querySelectorAll(sel)] as HTMLElement[]).filter(visible);
}
export function byText(text: string | RegExp, sel = "button, [role=button], a, div, span, li"): HTMLElement | null {
  const all = qa(sel);
  const m = (s: string) => (typeof text === "string" ? s.trim() === text : text.test(s));
  // Innermost match first.
  return all.filter((e) => m(e.textContent ?? "")).sort((a, b) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0))[0] ?? null;
}

async function waitFor(sel: string, timeout = 8000, text?: string): Promise<HTMLElement> {
  const t0 = Date.now();
  for (;;) {
    const el = text ? byText(text, sel) : q(sel);
    if (el) return el;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${sel}${text ? ` "${text}"` : ""}`);
    await sleep(60);
  }
}

export function pressKey(chord: string, target?: Element | null): void {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const el = (target ?? document.activeElement ?? document.body) as HTMLElement;
  const code = key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : `Digit${key}`) : key;
  const init: KeyboardEventInit = {
    key: key.length === 1 ? key.toLowerCase() : key,
    code,
    ctrlKey: mods.has("ctrl"),
    shiftKey: mods.has("shift"),
    altKey: mods.has("alt"),
    metaKey: mods.has("meta"),
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
}

export function typeInto(el: HTMLElement, text: string): void {
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter && (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (el.isContentEditable) {
    document.execCommand("insertText", false, text);
  }
}

export async function runSteps(steps: Step[], vault: string): Promise<void> {
  const api: StepApi = { vault, q, qa, byText };
  for (const s of steps) {
    if ("wait" in s) await waitFor(s.wait, s.timeout);
    else if ("click" in s) {
      const el = s.optional ? await waitFor(s.click, 2500, s.text).catch(() => null) : await waitFor(s.click, 8000, s.text);
      if (!el) continue;
      const target = s.nth !== undefined ? qa(s.click)[s.nth] ?? el : el;
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      target.click();
    } else if ("key" in s) pressKey(s.key, s.target ? await waitFor(s.target) : null);
    else if ("type" in s) typeInto(await waitFor(s.into), s.type);
    else if ("sleep" in s) await sleep(s.sleep);
    else if ("file" in s) {
      // The app's own store module (same instance Vite serves the app).
      const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
      const { invoke } = await import(/* @vite-ignore */ "@tauri-apps/api/core");
      let path = `${vault}/${s.file}`;
      if (!(await invoke<boolean>("path_exists", { path }))) {
        // A private fixture base doesn't have the synthetic vault's files:
        // open its first note instead.
        const files = await invoke<Array<{ path: string; is_dir: boolean }>>("list_markdown_files", { vault });
        const first = files.find((f) => !f.is_dir && f.path.endsWith(".md") && !f.path.includes("/.vault-chat/"));
        if (!first) continue;
        path = first.path;
      }
      const binary = /\.(pdf|png|jpe?g|gif|webp|mp4)$/i.test(path);
      const content = binary ? "" : await invoke<string>("read_text_file", { path });
      useStore.getState().setCurrentFile(path, content);
      if (s.mode === "edit" && useStore.getState().mode !== "edit") useStore.getState().toggleMode?.();
    } else if ("waitIdle" in s) {
      const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
      await sleep(300);
      const t0 = Date.now();
      while (useStore.getState().busy && Date.now() - t0 < (s.timeout ?? 20000)) await sleep(100);
    } else if ("chat" in s) {
      const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
      if (useStore.getState().rightCollapsed) useStore.getState().toggleRight();
    } else if ("conversation" in s) {
      const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
      const st = useStore.getState();
      for (let i = 0; i < 100 && !useStore.getState().conversationsLoaded; i++) await sleep(50);
      useStore.getState().selectConversation(s.conversation);
    }
    else if ("advance" in s) advance(s.advance);
    else if ("emit" in s) emitFromBackend(s.emit, s.payload);
    else if ("run" in s) await s.run(api);
    await sleep(80);
  }
}
