// The voice agent's expressive TTS (ElevenLabs v3) reads audio tags out of its
// reply text — "[excited] Yes, it absolutely does!", "[laughs]", "[happy]" —
// and they shape the audio. They are not words: the transcript (shown on the
// laptop and the phone, and saved on the box) drops them. The audio is never
// touched (this runs only on the text clients receive after the fact).

/** One tag: [word], [two words] or [three words], letters (and underscores: a
 *  control tag the model writes out, "[skip_turn]", P22) and spaces only —
 *  never a markdown link's text ("[the paper](…)"), a wiki link ("[[Note]]"),
 *  a footnote ("[1]") or a checkbox ("[ ]", "[x]"). */
const TAG = /(?<![[\w])\[\s*[A-Za-z][A-Za-z_]+(?: [A-Za-z_]+){0,2}\s*\](?![\](])/g;

/** `text` without its audio tags, the spaces around them tidied. */
export function stripAudioTags(text: string): string {
  if (!text || !text.includes("[")) return text;
  const cut = text.replace(TAG, "\u0000");
  if (cut === text) return text;
  // Only around the tags removed: a tag and the spaces next to it become one space.
  return cut
    .replace(/[ \t]*(?:\u0000[ \t]*)+([,.!?;:])/g, "$1")
    .replace(/^(?:\u0000[ \t]*)+/gm, "")
    .replace(/[ \t]*(?:\u0000[ \t]*)+$/gm, "")
    .replace(/[ \t]*(?:\u0000[ \t]*)+/g, " ")
    .trim();
}
