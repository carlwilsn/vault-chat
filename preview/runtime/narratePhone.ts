// The phone page's narrated play (preview/phone.mjs adds this module when the
// scenario has phone beats). The beats come as JSON (window.__VC_NARRATE__);
// the steps press what conv-check.mjs presses: the composer and send button,
// the mock box's __vcPhoneNext(), option cards, the photo input.
import type { Beat, PhoneStep } from "../scenarios/types";
import { narrate, narrateWanted } from "./narrate";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const w = window as any;

async function waitFor(sel: string, ms = 6000): Promise<HTMLElement | null> {
  for (let t = 0; t < ms; t += 100) {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.getClientRects().length);
    if (el) return el;
    await tick(100);
  }
  return null;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function chartFile(): Promise<File> {
  const c = document.createElement("canvas");
  c.width = 360;
  c.height = 200;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 360, 200);
  g.strokeStyle = "#2a6fdb";
  g.lineWidth = 2;
  g.beginPath();
  for (let x = 0; x <= 320; x += 4) {
    const y = 26 + 140 * (1 - Math.exp(-x / 70)) - (x > 150 && x < 175 ? 22 : 0);
    if (x === 0) g.moveTo(30 + x, 200 - y);
    else g.lineTo(30 + x, 200 - y);
  }
  g.stroke();
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
  return new File([blob], "loss.png", { type: "image/png" });
}

/** One phone step; `next` and `send` are expanded with their pauses first. */
async function exec(s: PhoneStep): Promise<void> {
  if ("next" in s) w.__vcPhoneNext?.();
  else if ("send" in s) {
    const input = (await waitFor("#input")) as HTMLTextAreaElement | null;
    if (!input) throw new Error("no #input");
    setValue(input, s.send);
    await tick(250);
    (await waitFor("#sendBtn"))?.click();
  } else if ("tap" in s) {
    const el = await waitFor(s.tap, s.optional ? 1200 : 6000);
    if (el) el.click();
    else if (!s.optional) throw new Error(`no ${s.tap}`);
  } else if ("photo" in s) {
    const input = document.querySelector<HTMLInputElement>("#imgInput");
    if (!input) throw new Error("no #imgInput");
    const dt = new DataTransfer();
    dt.items.add(await chartFile());
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

const expand = (steps: PhoneStep[]): PhoneStep[] =>
  steps.flatMap((s): PhoneStep[] => {
    if ("next" in s) return Array.from({ length: s.next }, () => [{ next: 1 } as PhoneStep, { sleep: s.ms ?? 1200 }]).flat();
    if ("send" in s) return [s, { sleep: 700 }];
    return [s];
  });

async function main(): Promise<void> {
  const beats: Beat<PhoneStep>[] | undefined = w.__VC_NARRATE__;
  if (!beats?.length || !narrateWanted(new URLSearchParams(location.search))) return;
  // The page is up and the conversation open (as the check waits for it).
  for (let t = 0; t < 300 && !(w.__previewPhone?.ready && document.querySelector("#msgs .amsg")); t++) await tick(100);
  await tick(600);
  w.__previewPhone.narrating = true;
  await narrate({ beats: beats.map((b) => ({ ...b, steps: expand(b.steps), show: expand(b.show ?? []) })), surface: "phone", exec });
  w.__previewPhone.narrated = true;
}

main().catch((e) => {
  console.error("[preview] narration:", e?.message ?? e);
});
