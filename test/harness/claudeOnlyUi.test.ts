// The Claude-only UI: what Carl sees signed out, what he sees signed in, and
// the two things that must stay gone.
//
// Carl, on a release: "I still see openrouter and old pi stuff and when I click
// the sign in button its not a clean obvious and nice thing", and "the app
// should work without claude, only the AI features should be blocked by sign
// in." So what is pinned here is:
//  - the decision itself (two sources, both health shapes, and what "not known
//    yet" means — the one state that must NOT draw a prompt);
//  - the model list: Claude's models, never an OpenRouter id, pinned against
//    the box's own alias list so the two cannot drift;
//  - the prompt's markup: one sentence and one button — no other way in;
//  - that the prompt is only ever drawn by an AI surface — the guard against a
//    full-window sign-in gate coming back;
//  - that no OpenRouter wording is left in any file that draws UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { CLAUDE_MODEL_ALIASES } from "../../server/engine/claude/models.ts";

const root = join(import.meta.dirname, "..", "..");

// The components reach src/store.ts, which touches localStorage as it is
// created, and @tauri-apps/api/core — so the fakes go in before the imports, as
// in claudeSignIn.test.ts.
const vault = makeTempVault("vc-claude-only-ui-");
const fake = installFakeTauri(vault);
fake.setHandler("vault_box_config", () => ({ box: "http://127.0.0.1:19348", vault: "School2" }));
let boxSignedIn: boolean | null = false;
fake.setHandler("box_get_json", () => ({
  status: 200,
  body: JSON.stringify(
    boxSignedIn === null
      ? { engine: { engines: { default: "claude" } } }
      : { engine: { engines: { default: "claude", claude: { signedIn: boxSignedIn, version: "2.1.0" } } } },
  ),
}));
fake.setHandler("box_post_json", () => ({ status: 200, body: '{"ok":true}' }));

const { claudeSignedIn, claudeSignedInOnBox, SIGN_IN_BUTTON, SIGN_IN_LINE } = await import("../../src/claudeAuth.ts");
const { CLAUDE_MODELS, claudeModelLabel, claudeModelsOnly, isClaudeModelId } = await import("../../src/claudeModels.ts");
const { useStore } = await import("../../src/store.ts");
const live = await import("../../src/claudeAuthLive.ts");
const { ClaudeAccountLine, ClaudeSignInPrompt } = await import("../../src/ClaudeCodeSignIn.tsx");

// ---- the decision ----------------------------------------------------------

/** The box health shape in use now: the `engines` record hoisted onto engine. */
const hoisted = (signedIn: boolean) => ({ engine: { engines: { default: "claude", claude: { signedIn, version: "2.1.0" } } } });
/** The older shape: the record sat under whichever engine led. */
const nested = (signedIn: boolean) => ({ engine: { pi: { engines: { default: "pi", claude: { signedIn, version: "2.1.0" } } } } });

test("signed in means this laptop has the token OR the box says so", () => {
  assert.equal(claudeSignedIn(null, hoisted(true)), true, "the box alone is enough");
  assert.equal(claudeSignedIn("sk-ant-oat01-x", null), true, "this laptop's token alone is enough — it is pushed on connect");
  assert.equal(claudeSignedIn("sk-ant-oat01-x", hoisted(false)), true, "a box that has not had the push yet does not sign Carl out");
  assert.equal(claudeSignedIn(null, hoisted(false)), false);
  assert.equal(claudeSignedIn(null, null), false, "nothing known is not signed in (the caller holds the prompt back, not this)");
  assert.equal(claudeSignedIn("", hoisted(false)), false, "an empty key is no key");
  assert.equal(claudeSignedIn("   ", hoisted(false)), false, "nor is whitespace");
});

test("both health shapes are read, so the answer does not depend on the box's version", () => {
  assert.equal(claudeSignedIn(null, nested(true)), true);
  assert.equal(claudeSignedIn(null, nested(false)), false);
});

test("a box that reports no Claude Code at all blocks nothing", () => {
  // An older box sends no `claude` entry. Blocking its AI over a field it never
  // sends would take the app away for a reason that is not true.
  assert.equal(claudeSignedInOnBox({ engine: { engines: { default: "pi" } } }), true);
  assert.equal(claudeSignedInOnBox({}), true);
  assert.equal(claudeSignedInOnBox(hoisted(false)), false);
  assert.equal(claudeSignedInOnBox(hoisted(true)), true);
  assert.equal(claudeSignedInOnBox(null), null, "not read yet is not an answer");
});

// ---- the model list --------------------------------------------------------

test("the picker's models are the box's own Claude aliases, and nothing drifts", () => {
  assert.deepEqual([...CLAUDE_MODELS].sort(), [...CLAUDE_MODEL_ALIASES].sort(), "src/claudeModels.ts and server/engine/claude/models.ts must offer the same models");
});

test("the box's catalog is cut down to Claude's models, in order, with no OpenRouter id left", () => {
  // What GET /api/v1/models really answers with while pi is still on the box.
  const catalog = [
    "anthropic/claude-sonnet-4.5",
    "google/gemini-3-pro",
    "haiku",
    "openai/gpt-6.1-sol",
    "opus",
    "sonnet",
    "x-ai/grok-5",
  ];
  const out = claudeModelsOnly(catalog);
  assert.deepEqual(out, ["opus", "sonnet", "haiku"], "the three aliases, most capable first");
  assert.ok(
    !out.some((id) => id.includes("/")),
    `a provider/model id reached the picker: ${out}`,
  );
  assert.deepEqual(claudeModelsOnly(["openai/gpt-6.1-sol"]), [], "a box with no Claude models offers none, rather than falling back to the catalog");
  // A pinned Claude release is still Claude, and still belongs.
  assert.deepEqual(claudeModelsOnly(["claude-opus-5", "opus", "x-ai/grok-5"]), ["opus", "claude-opus-5"]);
});

test("a Claude id reads as a name; anything else has no name to show", () => {
  assert.equal(claudeModelLabel("opus"), "Opus");
  assert.equal(claudeModelLabel("sonnet"), "Sonnet");
  assert.equal(claudeModelLabel("haiku"), "Haiku");
  assert.equal(claudeModelLabel("claude-opus-5"), "claude-opus-5", "a pinned Claude id is readable as itself");
  // The one that matters: the box still set to pi must not put its id on screen.
  assert.equal(claudeModelLabel("openai/gpt-6.1-sol"), null);
  assert.equal(claudeModelLabel("x-ai/grok-5"), null);
  assert.equal(claudeModelLabel(null), null);
  assert.equal(isClaudeModelId("opus"), true);
  assert.equal(isClaudeModelId("anthropic/claude-sonnet-4.5"), false, "a provider-prefixed id is an OpenRouter id, whatever its name says");
});

// ---- what is on screen -----------------------------------------------------

/** Put the laptop and the box into a known state, then render. */
async function render(el: Parameters<typeof renderToStaticMarkup>[0], opts: { key?: string; box: boolean | null }): Promise<string> {
  boxSignedIn = opts.box;
  live.forgetClaudeHealth();
  useStore.setState({ vaultPath: vault, boxChat: { on: true, reachable: true } as never, serviceKeys: opts.key ? { claudeCode: opts.key } : {} });
  // The hook reads the cached health in its initializer; renderToStaticMarkup
  // never runs effects, so the read has to have happened already.
  if (opts.box !== null) await live.readClaudeHealth(true);
  return renderToStaticMarkup(el);
}

test("signed out, an AI surface draws one sentence and one button, and no other way in", async () => {
  const html = await render(createElement(ClaudeSignInPrompt, { surface: "chat" }), { box: false });
  assert.match(html, /Sign in with Claude to chat/, "the sentence for this surface");
  assert.match(html, new RegExp(SIGN_IN_BUTTON), "the one button");
  assert.match(html, /data-el="claude-signin-prompt"/);
  assert.ok(!html.includes("setup-token"), `no raw token paste: ${html}`);
  // Carl: "I don't want the other sign on options." One button, nothing else.
  assert.ok(!/Other ways to sign in/.test(html), `no other way in: ${html}`);
  assert.equal((html.match(/<button/g) ?? []).length, 1, `exactly one button: ${html}`);
});

test("each surface says what is blocked there, in its own words", async () => {
  for (const [surface, line] of Object.entries(SIGN_IN_LINE)) {
    if (surface === "phone" || surface === "board") continue; // drawn by those apps, not React
    const html = await render(createElement(ClaudeSignInPrompt, { surface: surface as "chat" }), { box: false });
    assert.match(html, new RegExp(line), `${surface}: ${line}`);
    assert.match(html, new RegExp(`data-surface="${surface}"`));
  }
  assert.notEqual(SIGN_IN_LINE.chat, SIGN_IN_LINE.voice, "reworded per surface, not one sentence for all");
});

test("signed in, an AI surface draws nothing at all and shows itself", async () => {
  assert.equal(await render(createElement(ClaudeSignInPrompt, { surface: "chat" }), { box: true }), "");
});

test("this laptop's own token unblocks the AI even while the box still says no", async () => {
  // Through the store, which is what the real app reads. (Not through a render:
  // zustand answers a server render from the store's INITIAL state, so a
  // renderToStaticMarkup here could never see a key set after boot. The
  // decision itself is pinned above.)
  boxSignedIn = false;
  live.forgetClaudeHealth();
  useStore.setState({ vaultPath: vault, boxChat: { on: true, reachable: true } as never, serviceKeys: { claudeCode: "sk-ant-oat01-x" } });
  await live.readClaudeHealth(true);
  assert.equal(live.claudeSignedInNow(), true, "the token is pushed to the box on connect; the laptop does not wait for it");
  useStore.setState({ serviceKeys: {} });
  assert.equal(live.claudeSignedInNow(), false, "and signing out here blocks it again");
});

test("while the answer is not known, nothing is drawn — a signed-in Carl never sees 'sign in' flash", async () => {
  const html = await render(createElement(ClaudeSignInPrompt, { surface: "chat" }), { box: null });
  assert.equal(html, "", `the prompt appeared before the box had answered: ${html}`);
});

test("Settings' top line: signed in, with Sign out; signed out, the button", async () => {
  const inHtml = await render(createElement(ClaudeAccountLine), { box: true });
  assert.match(inHtml, /Signed in to Claude/);
  assert.match(inHtml, /Sign out/);
  assert.match(inHtml, /data-el="claude-sign-out"/);
  assert.ok(!inHtml.includes(SIGN_IN_BUTTON), "signed in, there is no sign-in button to click by mistake");
  assert.ok(!inHtml.includes("setup-token"), "and no token field");

  const outHtml = await render(createElement(ClaudeAccountLine), { box: false });
  assert.match(outHtml, new RegExp(SIGN_IN_BUTTON));
  assert.ok(!outHtml.includes("Sign out"), "signed out, there is nothing to sign out of");
  assert.ok(!outHtml.includes("setup-token"), "the paste field starts closed here too");
});

// ---- the two things that must stay gone ------------------------------------

function sources(dir: string, out: string[] = []): string[] {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name !== "lib" && d.name !== "dist" && d.name !== "node_modules") sources(p, out);
    } else if (/\.tsx?$/.test(d.name)) out.push(p);
  }
  return out;
}

const uiSources = (): Array<[string, string]> =>
  [...sources(join(root, "src")), ...sources(join(root, "phone", "src")), ...sources(join(root, "board", "src"))].map((abs) => [
    relative(root, abs).replace(/\\/g, "/"),
    readFileSync(abs, "utf8"),
  ]);

/** The lines that are code, not prose: comments are another lane's to clean up. */
const codeLines = (src: string): string[] =>
  src.split("\n").filter((l) => {
    const t = l.trim();
    return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });

// The keychain plumbing keeps the OpenRouter name: the box still needs
// OPENROUTER_API_KEY while pi runs there, and a key already on a machine must
// keep travelling. None of these files draw anything.
const KEY_PLUMBING = new Set(["src/keychain.ts", "src/keyEnv.ts", "src/keystore.ts", "src/store.ts", "src/boxKeys.ts", "src/logRedact.ts"]);

test("no file that draws UI mentions OpenRouter or asks for a model-provider key", () => {
  const offenders: string[] = [];
  for (const [file, src] of uiSources()) {
    if (KEY_PLUMBING.has(file)) continue;
    for (const line of codeLines(src)) {
      if (/openrouter|sk-or-/i.test(line)) offenders.push(`${file}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], `OpenRouter is back in the UI:\n${offenders.join("\n")}`);
});

test("the sign-in prompt is drawn only by AI surfaces: no full-window gate", () => {
  // Carl: "the app should work without claude, only the AI features should be
  // blocked by sign in." The shell, the file tree, the editors and the viewers
  // must not be able to block themselves on it, so they must not even be able
  // to reach the prompt.
  const allowed = new Set(["src/ChatPane.tsx", "src/VoiceCockpit.tsx", "src/SettingsPane.tsx", "src/ClaudeCodeSignIn.tsx"]);
  const importers: string[] = [];
  for (const [file, src] of uiSources()) {
    if (!/ClaudeSignInPrompt|useAiBlocked|ClaudeAccountLine/.test(src)) continue;
    if (!allowed.has(file)) importers.push(file);
  }
  assert.deepEqual(importers, [], `the sign-in prompt reached a non-AI surface: ${importers.join(", ")}`);

  // And the shell itself never reads the sign-in at all.
  for (const shell of ["src/App.tsx", "src/main.tsx", "src/Titlebar.tsx", "src/FileTree.tsx", "src/VaultPicker.tsx"]) {
    const src = readFileSync(join(root, shell), "utf8");
    assert.ok(!/claudeAuth|ClaudeSignInPrompt|useAiBlocked/.test(src), `${shell} gates itself on the Claude sign-in; only the AI features may`);
  }
});

test("the phone and the board block their AI the same way, with the same words", () => {
  const boot = readFileSync(join(root, "phone", "src", "boot.ts"), "utf8");
  const pill = readFileSync(join(root, "board", "src", "voicePill.ts"), "utf8");
  // Both take the sentence from the shared table rather than writing their own.
  assert.match(boot, /SIGN_IN_LINE/, "the phone says the shared sentence");
  assert.match(pill, /SIGN_IN_LINE\.board/, "the board says the shared sentence");
  // And both only block on an outright false: a dropped health read must not
  // take the composer or the mic away.
  assert.match(boot, /claudeSignedIn === false/, "the phone blocks only on a definite no");
  const pages = readFileSync(join(root, "phone", "src", "shell", "Pages.tsx"), "utf8");
  assert.match(pages, /id="signin"/, "the phone's prompt sits in the composer's place");
});
