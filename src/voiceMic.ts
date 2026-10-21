// The call's audio devices, pinned (Carl, 2026-10-21: "it suddenly stops
// hearing me", and "I stop hearing the voice, but the waves keep going"). His
// laptop log: 19 "voice devices changed" during calls, the inputs flipping
// between "Default - Microphone Array (Intel…)", "Communications - Microphone
// Array (Intel…)" and "Microphone (Realtek(R) Audio)". Windows moves its
// default and communications endpoints, inputs and outputs alike; a call opened
// on "default" follows them (LiveKit restarts the mic on the new default, the
// audio element's sink follows the default output) or its track ends: what
// ElevenLabs gets goes silent, or the agent plays — the SDK's own output level
// drives the waves — into a device Carl isn't listening to.
//
// So a call opens on the physical devices behind "default" (matched by label
// without the "Default - " / "Communications - " prefix, and groupId), through
// the SDK's own `inputDeviceId` / `outputDeviceId`, and stays there:
//   - a devicechange while the pinned device is still listed: logged, nothing else;
//   - the device gone (unplugged): the best remaining physical one, logged, the
//     call goes on;
//   - a mic track that ended: re-acquired on the same pinned device.
// Only where the system lists a virtual "default"/"communications" entry of
// that kind (Chromium on Windows, Linux, Android): Safari/iOS lists physical
// inputs only and no outputs, and routes them itself, so there nothing is
// pinned and nothing changes. The SDK keeps echoCancellation/noiseSuppression
// on for a picked mic. Pure policy plus a small holder; the caller does the
// SDK calls.

export type MicDevice = { deviceId: string; groupId?: string; label?: string; kind?: string };
export type AudioKind = "audioinput" | "audiooutput";

const VIRTUAL = new Set(["default", "communications"]);
const kindOf = (d: MicDevice) => d.kind ?? "audioinput";

export function isVirtualMic(id: string | undefined | null): boolean {
  return !id || VIRTUAL.has(id);
}

/** A label without Windows' role prefix: "Default - Microphone Array (…)" → "Microphone Array (…)". */
export function bareMicLabel(label: string | undefined | null): string {
  return String(label ?? "")
    .replace(/^\s*(Default|Communications)\s*-\s*/i, "")
    .trim();
}

/** Real devices of a kind: a concrete id (an id is empty before the mic was ever allowed). */
export function physicalMics(devs: MicDevice[], kind: AudioKind = "audioinput"): MicDevice[] {
  return devs.filter((d) => kindOf(d) === kind && !isVirtualMic(d.deviceId));
}

/** The system lists a virtual default of this kind the call would follow. */
export function hasVirtualDefault(devs: MicDevice[], kind: AudioKind = "audioinput"): boolean {
  return devs.some((d) => kindOf(d) === kind && (d.deviceId === "default" || d.deviceId === "communications"));
}

/** The physical device behind a virtual entry ("default" unless said): label and group, then label, then group. */
export function resolveVirtualMic(devs: MicDevice[], which = "default", kind: AudioKind = "audioinput"): MicDevice | null {
  const mics = physicalMics(devs, kind);
  const v = devs.find((d) => kindOf(d) === kind && d.deviceId === which);
  if (!v) return null;
  const label = bareMicLabel(v.label);
  return (
    (label && mics.find((d) => bareMicLabel(d.label) === label && (!v.groupId || d.groupId === v.groupId))) ||
    (label && mics.find((d) => bareMicLabel(d.label) === label)) ||
    (v.groupId && mics.find((d) => d.groupId === v.groupId)) ||
    null
  );
}

/** Where the call's device should be now: the pinned one while listed; else the same device back under a new id;
 *  else what "default" points to; else what "communications" points to; else the first physical one. */
export function micFor(devs: MicDevice[], pinned: MicDevice | null, kind: AudioKind = "audioinput"): MicDevice | null {
  const mics = physicalMics(devs, kind);
  if (pinned) {
    const same = mics.find((d) => d.deviceId === pinned.deviceId);
    if (same) return same;
    const label = bareMicLabel(pinned.label);
    const back = label ? mics.find((d) => bareMicLabel(d.label) === label) : undefined;
    if (back) return back;
  }
  return resolveVirtualMic(devs, "default", kind) ?? resolveVirtualMic(devs, "communications", kind) ?? mics[0] ?? null;
}

/** What a log line says about the devices: the inputs and outputs listed, each by label. */
export function deviceLists(devs: MicDevice[]): { inputs: string[]; outputs: string[] } {
  const of = (k: AudioKind) => devs.filter((d) => kindOf(d) === k).map((d) => (d.deviceId === "default" || d.deviceId === "communications" ? `[${d.deviceId}] ` : "") + (d.label || "?").slice(0, 36)).slice(0, 8);
  return { inputs: of("audioinput"), outputs: of("audiooutput") };
}

export type MicLog = (event: string, data: Record<string, unknown>) => void;
export type PinOutcome = "unpinned" | "kept" | "switched" | "lost" | "failed";

const short = (d: MicDevice | null, noun: string) =>
  d ? { [noun]: d.label || null, [`${noun}Id`]: d.deviceId.slice(0, 12) } : { [noun]: null, [`${noun}Id`]: null };

/** One call's pinned device of one kind. `list` is enumerateDevices; `change` is the SDK's changeInputDevice /
 *  changeOutputDevice. Logs "voice mic …" for the mic, "voice output …" for the output. */
export class MicPin {
  pinned: MicDevice | null = null;
  readonly kind: AudioKind;
  private readonly noun: string;
  /** The log field naming the device ("output" alone is a content field the box's redaction sizes away). */
  private readonly key: string;

  constructor(
    private readonly o: {
      list: (() => Promise<MicDevice[]>) | null;
      log: MicLog;
      kind?: AudioKind;
    },
  ) {
    this.kind = o.kind ?? "audioinput";
    this.noun = this.kind === "audioinput" ? "mic" : "output";
    this.key = this.kind === "audioinput" ? "mic" : "outputDevice";
  }

  async devices(): Promise<MicDevice[] | null> {
    if (!this.o.list) return null;
    try {
      return await this.o.list();
    } catch {
      return null;
    }
  }

  /** Before the call opens: the physical device behind "default", for the SDK's inputDeviceId / outputDeviceId.
   *  Undefined: the SDK's default (no virtual default here, or ids not readable yet — `afterConnect` pins then). */
  async atStart(listed?: MicDevice[] | null): Promise<string | undefined> {
    this.pinned = null;
    const devs = listed === undefined ? await this.devices() : listed;
    if (!devs || !hasVirtualDefault(devs, this.kind)) return undefined;
    const dev = resolveVirtualMic(devs, "default", this.kind) ?? micFor(devs, null, this.kind);
    if (!dev) return undefined;
    this.pinned = dev;
    const from = devs.find((d) => kindOf(d) === this.kind && d.deviceId === "default");
    this.o.log(`voice ${this.noun} pinned`, { at: "start", ...short(dev, this.key), from: bareMicLabel(from?.label) || null, ...(this.kind === "audiooutput" ? { outputs: deviceLists(devs).outputs } : {}) });
    return dev.deviceId;
  }

  /** Connected: `inUse` is the device the call actually uses (the mic track's deviceId; for the output, unknown).
   *  Still on a virtual default (ids unreadable before the mic was allowed): moved once onto the device behind it. */
  async afterConnect(inUse: string | undefined, change: (id: string) => Promise<void>): Promise<void> {
    if (this.pinned) return;
    const devs = await this.devices();
    if (!devs || !hasVirtualDefault(devs, this.kind)) return;
    const concrete = !isVirtualMic(inUse) ? physicalMics(devs, this.kind).find((d) => d.deviceId === inUse) : undefined;
    if (concrete) {
      this.pinned = concrete;
      this.o.log(`voice ${this.noun} pinned`, { at: "connect", ...short(concrete, this.key) });
      return;
    }
    const dev = resolveVirtualMic(devs, inUse && isVirtualMic(inUse) ? inUse : "default", this.kind) ?? micFor(devs, null, this.kind);
    if (!dev) return;
    try {
      await change(dev.deviceId);
      this.pinned = dev;
      this.o.log(`voice ${this.noun} pinned`, { at: "connect", ...short(dev, this.key), moved: true });
    } catch (e) {
      this.o.log(`voice ${this.noun} pin failed`, { ...short(dev, this.key), error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }

  /** The pinned device is listed in `devs`. */
  present(devs: MicDevice[]): boolean {
    const p = this.pinned;
    return !!p && physicalMics(devs, this.kind).some((d) => d.deviceId === p.deviceId);
  }

  /** A devicechange (with the fresh listing): the pinned device still there → nothing; gone → the best remaining
   *  one. The caller logs the change itself ("voice devices changed", both kinds at once). */
  async devicesChanged(devs: MicDevice[], change: (id: string) => Promise<void>): Promise<PinOutcome> {
    const pinned = this.pinned;
    if (!pinned) return "unpinned";
    if (this.present(devs)) return "kept";
    const next = micFor(devs, pinned, this.kind);
    if (!next) {
      this.o.log(`voice ${this.noun} lost`, { was: pinned.label || null });
      return "lost";
    }
    try {
      await change(next.deviceId);
      this.pinned = next;
      this.o.log(`voice ${this.noun} switched`, { why: `the pinned ${this.noun} went away`, was: pinned.label || null, ...short(next, this.key) });
      return "switched";
    } catch (e) {
      this.o.log(`voice ${this.noun} switch failed`, { ...short(next, this.key), error: String((e as Error)?.message ?? e).slice(0, 300) });
      return "failed";
    }
  }

  /** The device a re-acquire opens: the pinned one (or its replacement when it went away); "default" unpinned. */
  async target(): Promise<string> {
    if (!this.pinned) return "default";
    const devs = await this.devices();
    if (!devs) return this.pinned.deviceId;
    const next = micFor(devs, this.pinned, this.kind);
    if (!next) return "default";
    if (next.deviceId !== this.pinned.deviceId) {
      this.o.log(`voice ${this.noun} switched`, { why: `the pinned ${this.noun} went away`, was: this.pinned.label || null, ...short(next, this.key) });
      this.pinned = next;
    }
    return this.pinned.deviceId;
  }

  reset(): void {
    this.pinned = null;
  }
}

/** navigator.mediaDevices.enumerateDevices, or null where there is none. */
export function browserMicList(): (() => Promise<MicDevice[]>) | null {
  const md = typeof navigator !== "undefined" ? (navigator as Navigator).mediaDevices : undefined;
  if (!md?.enumerateDevices) return null;
  return async () => (await md.enumerateDevices()).map((d) => ({ deviceId: d.deviceId, groupId: d.groupId, label: d.label, kind: d.kind }));
}

/** The one device listing a pin reads when asked (tests install theirs late); throws where there is none. */
export async function listAudioDevices(): Promise<MicDevice[]> {
  const l = browserMicList();
  if (!l) throw new Error("no device listing");
  return l();
}

/** Where a page can play the agent through a chosen output (Chromium's setSinkId). Safari/WebKit: no. */
export function canPickOutput(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

export const AUDIO_WARN_LINE = "No sound? Tap to reconnect audio";

/** The agent's audio should be audible but can't be: it is speaking (or its audio arriving) while a playback
 *  context is suspended, the page may not play audio, or the pinned output is gone with nothing to move to. */
export function audioBlocked(s: { speaking: boolean; contexts: string[]; canPlay?: boolean | null; outputLost?: boolean }): string | null {
  if (s.outputLost) return "output-gone";
  if (!s.speaking) return null;
  if (s.contexts.some((c) => c === "suspended" || c === "interrupted")) return "context-suspended";
  if (s.canPlay === false) return "playback-blocked";
  return null;
}
