# First-run tutorial: draft text (for Carl to approve)

Target: about 5 minutes on a Mac. Narration is read by Kokoro `af_heart`, so spoken lines are short and plain.
Shortcuts are written Mac first: ⌘K (Ctrl+K on Windows). Thread: **learn → note → build**, with you and the agent
handing work back and forth.

**Sample content:** `Welcome/sample-paper.pdf` is a 3-page public-domain explainer, *The Broad Street Pump (London, 1854)*.
Its one striking figure is John Snow's cholera map: each death is a black bar stacked at its house, and the bars pile up
around a single water pump. It's public domain, makes the point in one look, and has nothing to do with Carl.

---

## Step 1 · Learn from a PDF  (~1 min)

- **Spoken:** "Hi, I'm your vault's agent. I can see what you're reading. Open the sample paper and ask me about the map."
- **On screen:** *Open `sample-paper.pdf`. Press **⌘L** (Ctrl+L on Windows) and ask: "What is this map telling me?"*
- **User does:** opens the PDF, presses ⌘L, types or says the question.
- **What happens:** the answer cites the figure: the deaths cluster around the Broad Street pump, so the cause was the water
  and not the air. The PDF stays where it is.
- **Success check:** an answer arrives that mentions the pump or page 2. Tip line: *Press **⌘⇧F** (Ctrl+Shift+F) to make the chat full screen, and again to go back.*

## Step 2 · Turn it into a note  (~1 min)

- **Spoken:** "Reading is half of it. Ask me to write it up, and I'll put the note next to the paper."
- **On screen:** *In the chat, ask: "Make me a one-page note on this paper and open it next to the PDF."*
- **User does:** sends the ask.
- **What happens:** `Welcome/broad-street.md` is written. The viewer splits, with the PDF on the left and the note on the right.
- **Success check:** both panes are visible and the note has a heading, 3 to 5 bullets and a line about the map.

## Step 3 · Edit it in place  (~45 s)

- **Spoken:** "Now it's your note. Select a line, press command K, and tell me what to change."
- **On screen:** *Select any bullet in the note. Press **⌘K** (Ctrl+K on Windows) and say "make this shorter" or "add an example".*
- **User does:** selects text, presses ⌘K, gives an instruction, then accepts the edit.
- **What happens:** the proposed change shows inline. Accept keeps it, Escape drops it.
- **Success check:** the note on disk changed (the tutorial reads the file).

## Step 4 · Ask for a tool, get it live  (~1.5 min)

- **Spoken:** "Here's the fun part. The app itself is something you can ask for. Ask me for a tool and watch it show up. No restart."
- **On screen:** *Ask: "Make me a flashcard tool that quizzes me on my note."*
- **User does:** asks, then answers two or three cards.
- **What happens:** a flashcard panel opens in the app, made from `broad-street.md`. Each click is saved, and the agent can
  read your answers back with no copy-paste. Follow-up shown: *Ask "how did I do?"*
- **Success check:** the plugin is mounted and at least one answer is in its state. Optional extra line:
  *"Turn it off" hides it. "Turn it back on" brings it back.*

## Step 4b · Flex: your iPad board  (only if a board is paired, ~1 min)

- **Spoken:** "You've got an iPad paired. Let's use it. I'll send you a question, you answer in ink, and I'll check it."
- **On screen:** *Ask: "Send me one question about the map to my board." Answer it with the pen, then ask "Look at my board. Am I right?"*
- **What happens:** the question lands in the board inbox. The agent reads your handwriting and replies on the laptop.
- **Success check:** a board save arrives after the send. Without a board, this step is skipped silently.

## Step 5 · Delete me  (closing, ~20 s)

- **Spoken:** "That's the tour. One last thing: this tutorial is a plugin too. If you're done with it, just ask me to delete it."
- **On screen:** *This tutorial is a plugin, made by asking. Say **"delete the tutorial"** and it's gone. Or keep it, and read
  [How Carl uses vault-chat](#how-carl-uses-vault-chat) first.*
- **User does:** asks to delete it (or not).
- **What happens:** the plugin turns itself off and removes its files. The sample PDF and your note stay unless you ask
  for them gone too.
- **Success check:** the plugin no longer shows in the plugin list.

---

## How Carl uses vault-chat

*The idea: human-in-the-loop, maxed out. The agent has rich context (your open files, your screen, your board, your
history). You have good ways in (split view, ⌘K and ⌘L, voice on your phone, ink on an iPad, pages you click). Either side can
step in from any of them. It's one assistant for learning, for notes and for building.*

1. **Homework night that turned into a feature.** Late one night I had the problem set on the left and my draft on the right,
   and asked for hints with no spoilers. Halfway through, editing felt clumsy, so I described a better way. The agent passed it to
   workers, it shipped, and I was using it the next afternoon.
2. **Plugins by asking.** "Make my cursor a navy pen with an ink trail." It was live that day, with no update. A floating calculator,
   a notepad I can draw on and a menu that switches them all on and off came the same way. Some features I want today and not forever.
3. **The agent's own update video.** I asked for a video about what had changed. It wrote a script, gave me a little
   quiz page to pick the style (it read my clicks back), and rendered a narrated video. Watching it, I noticed the player controls
   didn't hide. That became a fix too.
4. **Ideas by voice from the gym.** Between sets I talked through product ideas on my phone. Back at the laptop: "make an md of
   those and open it." That page became the plan for the plugin system.
5. **vault-chat builds vault-chat.** Most of the app was built by using it: I notice a gap, say so, and agents build it,
   check it and ship it. This tutorial was made the same way.

---

## Needs a decision from Carl

1. **Sample PDF:** OK with the Broad Street / cholera map explainer? Alternatives: the Hertzsprung-Russell diagram or
   Minard's Napoleon march chart. We'd write the PDF ourselves (3 pages, public-domain figure) and bundle it.
2. **Step 4 tool:** flashcards (reads answers back, shows the loop) or a floating notepad (closer to your real story, more visual)?
3. **Story voice:** first person ("I", as written) or third person ("Carl")? Use your name at all in a public repo?
4. **Real numbers in story 5** ("121 releases in 9 days")? Left out for now as internal stats.
5. **Delete scope:** should "delete the tutorial" also remove `Welcome/` (sample PDF and note), or only the plugin?
6. **Mention ⌘⇧F as a tip in step 1,** or leave it out to keep step 1 tight?
7. **Step 3 (⌘K) as its own step, or fold it into step 2** to get down to 4 steps and nearer 4 minutes?
8. **Teaser:** link your update video from the stories page? It needs a fresh, public-safe cut, because the current one quotes internal stats.
9. **Skip/replay:** a "skip tutorial" button on every step, and "start the tutorial" as an ask to replay it?
