// Settings → Voice → "Browse the voice library…" (src/voiceLibraryBrowse.ts):
// the list's query, adding a library voice then selecting it, the plan's voice
// limit, a voice already in the account, and the box getting the new voice id.
// ElevenLabs is faked here, never called.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-voicelibrary-");
installFakeTauri(vault);

const L = await import("../../src/voiceLibraryBrowse.ts");
const { boxVoiceSession } = await import("../../src/voiceBox.ts");

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
let calls: Call[] = [];
const respond = (fn: (c: Call) => Response) =>
  (async (url: string, init?: any) => {
    const c = { url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body };
    calls.push(c);
    return fn(c);
  }) as unknown as typeof fetch;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

const v = (id: string, name: string, extra: Partial<import("../../src/voiceLibraryBrowse.ts").SharedVoice> = {}) => ({
  voice_id: id,
  public_owner_id: `owner-${id}`,
  name,
  description: `${name}, warm and clear.`,
  gender: "female",
  age: "middle_aged",
  accent: "american",
  preview_url: `https://storage.example/${id}.mp3`,
  ...extra,
});

beforeEach(() => {
  calls = [];
  localStorage.removeItem(L.VOICE_STORAGE);
});

test("the list: English, conversational, trending first, 30 a page, search, the all-uses toggle", async () => {
  const f = respond(() => json({ voices: [v("a1", "Ava")], has_more: true }));
  const r = await L.fetchSharedVoices("el-test", { page: 2, search: " calm narrator " }, f);
  assert.deepEqual(r, { voices: [v("a1", "Ava")], hasMore: true });
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, "https://api.elevenlabs.io/v1/shared-voices");
  assert.equal(calls[0].headers["xi-api-key"], "el-test");
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    page_size: "30",
    page: "2",
    language: "en",
    use_cases: "conversational",
    sort: "trending",
    search: "calm narrator",
  });
  const any = new URL(L.sharedVoicesUrl({ anyUse: true }));
  assert.equal(any.searchParams.has("use_cases"), false, "all uses: no use-case filter");
  assert.equal(any.searchParams.has("search"), false);
  assert.equal(new URL(L.sharedVoicesUrl({ featured: true, pageSize: 8 })).searchParams.get("featured"), "true");
  await assert.rejects(L.fetchSharedVoices("el-test", {}, respond(() => json({}, 401))), /ElevenLabs 401/);
});

test("recommended: the featured ones, topped up from trending to eight", async () => {
  const f = respond((c) =>
    new URL(c.url).searchParams.get("featured") === "true"
      ? json({ voices: [v("f1", "Featured One"), v("f2", "Featured Two")], has_more: false })
      : json({ voices: [v("f2", "Featured Two"), ...Array.from({ length: 10 }, (_, i) => v(`t${i}`, `Top ${i}`))], has_more: true }),
  );
  const r = await L.recommendedVoices("el-test", f);
  assert.equal(r.length, 8);
  assert.deepEqual(r.slice(0, 3).map((x) => x.voice_id), ["f1", "f2", "t0"], "featured first, no duplicates");
  const q = new URL(calls[0].url).searchParams;
  assert.deepEqual([q.get("featured"), q.get("page_size"), q.get("language"), q.get("use_cases"), q.get("sort")], ["true", "8", "en", "conversational", "trending"]);
});

test("picking a library voice adds it to the account, then selects it — and the box's session gets it", async () => {
  const f = respond(() => json({ voice_id: "lib-new-1" }));
  const r = await L.pickLibraryVoice("el-test", v("lib-new-1", "Juniper"), new Set(["nPczCjzI2devNBz1zQrb"]), f);
  assert.deepEqual(r, { voiceId: "lib-new-1", added: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/voices/add/owner-lib-new-1/lib-new-1");
  assert.deepEqual(JSON.parse(calls[0].body!), { new_name: "Juniper" });
  assert.equal(localStorage.getItem("vault_chat_elevenlabs_voice"), "lib-new-1", "selected like any voice");
  // The box voice path reads the same key: its session is asked for this voice.
  const paths: string[] = [];
  await boxVoiceSession({ link: {} } as any, null, async (_l, path) => {
    paths.push(path);
    return { signedUrl: "wss://fake", systemPrompt: "p", toolNames: [] };
  });
  assert.match(paths[0], /[?&]voice=lib-new-1(&|$)/);
});

test("the plan's voice limit: one plain line, nothing selected", async () => {
  localStorage.setItem(L.VOICE_STORAGE, "nPczCjzI2devNBz1zQrb");
  const f = respond(() =>
    json(
      {
        detail: {
          status: "voice_limit_reached",
          message: "You have reached your maximum amount of custom voices (10 / 10). You can upgrade your subscription to increase your custom voice limit.",
        },
      },
      400,
    ),
  );
  const r = await L.pickLibraryVoice("el-test", v("lib-x", "Rowan"), new Set(), f);
  assert.deepEqual(r, { error: "Your ElevenLabs plan holds 10 library voices — remove one on elevenlabs.io" });
  assert.equal(localStorage.getItem(L.VOICE_STORAGE), "nPczCjzI2devNBz1zQrb", "the old voice stays");
  // No number in the message: still the plain line.
  assert.match(L.addErrorLine(400, JSON.stringify({ detail: { status: "voice_limit_reached", message: "Voice limit reached." } })), /plan's library voices are full/);
  // Any other refusal: the status and ElevenLabs' words.
  assert.equal(L.addErrorLine(422, JSON.stringify({ detail: "bad id" })), "ElevenLabs 422: bad id");
});

test("a voice already in the account is just selected (no add)", async () => {
  const f = respond(() => {
    throw new Error("should not be called");
  });
  const r = await L.pickLibraryVoice("el-test", v("owned-1", "Brian"), new Set(["owned-1"]), f);
  assert.deepEqual(r, { voiceId: "owned-1", added: false });
  const r2 = await L.pickLibraryVoice("el-test", v("lib-2", "Iris", { is_added_by_user: true }), new Set(), f);
  assert.deepEqual(r2, { voiceId: "lib-2", added: false }, "ElevenLabs says it's added");
  assert.equal(calls.length, 0);
  assert.equal(localStorage.getItem(L.VOICE_STORAGE), "lib-2");
});

const ACCT = [
  { voice_id: "brianA", name: "Brian", labels: { accent: "american", gender: "male", description: "deep" } },
  { voice_id: "brianB", name: "Brian", labels: { accent: "british", gender: "male", description: "calm" } },
  { voice_id: "george", name: "George", labels: { accent: "british", gender: "male" } },
  { voice_id: "sarah", name: "Sarah", labels: { accent: "american", gender: "female" } },
];

test("the one-time snapshot hides every account voice but the selected one (by id: the other Brian goes too)", () => {
  localStorage.removeItem(L.HIDDEN_STORAGE);
  const ids = ACCT.map((v) => v.voice_id);
  assert.deepEqual([...L.snapshotHidden(ids, "brianA")].sort(), ["brianB", "george", "sarah"]);
  assert.equal(localStorage.getItem(L.HIDDEN_STORAGE), JSON.stringify(["brianB", "george", "sarah"]), "stored as ids");
  assert.deepEqual(L.visibleVoices(ACCT, L.readHidden(), "brianA").map((v) => v.voice_id), ["brianA"]);
  // Once only: a later run (another selection, more voices) leaves it alone.
  assert.deepEqual([...L.snapshotHidden([...ids, "later"], "george")].sort(), ["brianB", "george", "sarah"]);
});

test("a voice added later shows; the selected voice always shows, even if the snapshot holds it", () => {
  localStorage.setItem(L.HIDDEN_STORAGE, JSON.stringify(["brianB", "george", "sarah"]));
  const later = { voice_id: "lib-later", name: "Juniper", labels: { accent: "american", gender: "female" } };
  const hidden = L.readHidden();
  assert.deepEqual(L.visibleVoices([...ACCT, later], hidden, "brianA").map((v) => v.voice_id), ["brianA", "lib-later"]);
  assert.deepEqual(L.visibleVoices([...ACCT, later], hidden, "george").map((v) => v.voice_id), ["brianA", "george", "lib-later"]);
  // Two voices of one name are told apart in the row.
  const h = L.voiceHints(ACCT);
  assert.notEqual(h.get("brianA"), h.get("brianB"));
  const twins = L.voiceHints([ACCT[0], { ...ACCT[0], voice_id: "brianZZ" }]);
  assert.notEqual(twins.get("brianA"), twins.get("brianZZ"), "identical labels: the id's head");
});

test("a voice picked from the library shows, even one the snapshot hid", async () => {
  localStorage.setItem(L.HIDDEN_STORAGE, JSON.stringify(["lib-h", "owned-h"]));
  await L.pickLibraryVoice("el-test", v("lib-h", "Nova"), new Set(), respond(() => json({ voice_id: "lib-h" })));
  assert.deepEqual([...L.readHidden()], ["owned-h"]);
  await L.pickLibraryVoice("el-test", v("owned-h", "Brian"), new Set(["owned-h"]), respond(() => json({})));
  assert.deepEqual([...L.readHidden()], []);
});

test("no hide UI: the module has no hide action and Settings renders none", async () => {
  assert.equal((L as Record<string, unknown>).hideVoice, undefined);
  assert.equal((L as Record<string, unknown>).keepOnly, undefined);
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/SettingsPane.tsx", import.meta.url), "utf8");
  for (const word of [/>\s*Hide\s*</, /Show hidden/, /Keep only/, /Unhide/]) assert.doesNotMatch(src, word);
});
