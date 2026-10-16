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
