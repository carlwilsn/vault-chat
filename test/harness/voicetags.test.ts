// The voice agent's audio tags (ElevenLabs v3: "[excited]", "[laughs]") leave
// the transcript; the audio is untouched (src/voiceTags.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAudioTags } from "../../src/voiceTags.ts";

test("the tags Carl saw are dropped, the words kept", () => {
  assert.equal(stripAudioTags("[excited] Yes, it absolutely does!"), "Yes, it absolutely does!");
  assert.equal(stripAudioTags("[happy] Good morning, Carl."), "Good morning, Carl.");
  assert.equal(stripAudioTags("That's the trick [laughs] — it works."), "That's the trick — it works.");
  assert.equal(stripAudioTags("Done [laughs]."), "Done.");
  assert.equal(stripAudioTags("[sighs] Okay. [excited] Found it!"), "Okay. Found it!");
  assert.equal(stripAudioTags("[clears throat] So, the writeup."), "So, the writeup.");
  assert.equal(stripAudioTags("[whispers softly now] Here."), "Here.");
  assert.equal(stripAudioTags("[laughs]"), "");
  assert.equal(stripAudioTags("Line one [happy]\n[curious] Line two"), "Line one\nLine two");
});

test("brackets that are text stay", () => {
  for (const t of [
    "See [the paper](https://example.org/p.pdf) for it.",
    "Open [[Weekly Review]] next.",
    "As shown in [1] and [2].",
    "- [x] done\n- [ ] not yet",
    "The array is [a, b, c].",
    "Call f[i] in the loop.",
    "Index arr[idx] there.",
    "[this is four words] stays",
    "No tags at all.",
  ]) {
    assert.equal(stripAudioTags(t), t, t);
  }
});

test("control tags the model writes out (P22: \"[skip_turn]\") never reach the transcript; vault-chat's own [vc:…] lines are recognised", async () => {
  assert.equal(stripAudioTags("[skip_turn]"), "");
  assert.equal(stripAudioTags("Okay. [skip_turn]"), "Okay.");
  assert.equal(stripAudioTags("[end_call] Bye."), "Bye.");
  const { isControlLine, controlLine } = await import("../../src/voicePrompt.ts");
  assert.equal(isControlLine(controlLine("result", "The agent answered: done.")), true);
  assert.equal(isControlLine("  [vc:context] Carl typed."), true);
  assert.equal(isControlLine("[vcx] not ours"), false);
  assert.equal(isControlLine("What's [vc] in this paper?"), false);
});
