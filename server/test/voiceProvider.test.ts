// Which voice a call uses is decided in one place (server/voiceProvider.ts) and handed to the pipeline per call:
// local (Kokoro + Whisper, no key) unless the ElevenLabs voice plugin is on and Keys holds a key. The key never goes
// to the pipeline for a local call.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { brainRoute, endCall, startCall, type BrainDeps, type BrainEngine } from "../voiceBrain";
import { voiceProvider } from "../voiceProvider";

const engine = { setTalker() {}, tap: () => () => {}, isRunning: () => false, async interrupt() { return true; } } as unknown as BrainEngine;

let bot: Server | null = null;
afterEach(() => { bot?.close(); bot = null; });

async function offerWith(over: Partial<BrainDeps>): Promise<{ status: number; body: any; sent: any }> {
  let sent: any = null;
  bot = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { sent = JSON.parse(b); res.end(JSON.stringify({ sdp: "answer", type: "answer" })); });
  });
  await new Promise<void>((r) => bot!.listen(0, "127.0.0.1", r));
  const d: BrainDeps = { vault: "/v", engine: async () => engine, elKey: () => "el-key", voiceId: () => "voice1234", botUrl: `http://127.0.0.1:${(bot.address() as AddressInfo).port}`, selfUrl: "http://127.0.0.1:1", logDir: null, ...over };
  const c = await startCall(d, { convId: "conv-provider", device: "phone" });
  let status = 0, body: any = null;
  const res = { writeHead(s: number) { status = s; }, end(t: string) { body = JSON.parse(t); } } as any;
  await brainRoute(d, {} as any, res, "/api/v1/brain/offer", "POST", true, async () => ({ callId: c.body.callId, sdp: "offer", type: "offer" }));
  endCall(d, String(c.body.callId));
  return { status, body, sent };
}

describe("voice provider", () => {
  it("is ElevenLabs only when the plugin is on and a key exists", () => {
    expect(voiceProvider({ elevenlabsPluginOn: true, elKey: "k" })).toBe("elevenlabs");
    expect(voiceProvider({ elevenlabsPluginOn: true, elKey: null })).toBe("local");
    expect(voiceProvider({ elevenlabsPluginOn: false, elKey: "k" })).toBe("local");
  });

  it("an install with a key and no plugin record keeps ElevenLabs, with its key and voice", async () => {
    const r = await offerWith({});
    expect(r.status).toBe(200);
    expect(r.sent.call).toMatchObject({ provider: "elevenlabs", elKey: "el-key", voiceId: "voice1234" });
  });

  it("no key (a new, free install): the local voice, and no key is sent", async () => {
    const r = await offerWith({ elKey: () => null });
    expect(r.status).toBe(200);
    expect(r.sent.call.provider).toBe("local");
    expect(r.sent.call).not.toHaveProperty("elKey");
  });

  it("the plugin turned off: local even with a key", async () => {
    const r = await offerWith({ elevenlabsPluginOn: () => false });
    expect(r.sent.call.provider).toBe("local");
    expect(r.sent.call).not.toHaveProperty("elKey");
  });

  it("local packages still installing: the device is told, the pipeline is not asked", async () => {
    const r = await offerWith({ elKey: () => null, localVoiceReady: () => ({ ready: false, error: "Setting up the local voice" }) });
    expect(r.status).toBe(503);
    expect(r.body.error).toContain("local voice");
    expect(r.sent).toBeNull();
  });
});
