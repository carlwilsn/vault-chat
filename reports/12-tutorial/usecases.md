# vault-chat: real use cases for the first-run tutorial

Research done 2026-11-17, read-only, from Carl's two vaults (school2, vault-chat), their event logs
(`<vault>/.vault-chat/events/*.jsonl`, the `entry.shown` lines are his messages), the old
`.vault-chat/conversations/`, `.vault-chat/plugins/`, `.vault-chat/visuals/`, the `video/` folder and
`reports/08-fundamentals`. A flat dump of his asks (date, surface, text) is in `work/asks.tsv`
(about 3,400 rows) and `work/titles.tsv` holds the chat titles. Neither file is public: both contain personal data.

## Thesis (Carl's framing)

1. **vault-chat is building vault-chat.** The November push was the app improving itself through
   chats. Carl saw a gap while using it, said so, and agents built, verified and shipped the fix.
   The video script counts 121 releases from Nov 8 to 16 (v0.8.0 to v0.9.20). Over the same stretch
   the share of his past asks the agent can do live, with no build, went from 62% to 79%
   (`vault-chat/video/script.md`). Some of it needed no release at all: plugins written into the running app.
2. **Human-in-the-loop maxxing.** Both sides can step in from many places. The agent has rich
   context: open notes, PDFs, the screen, the board, activity and memory. Carl has many ways in:
   the laptop split view, phone voice, the iPad board, Ctrl+K/L, Notes and live pages whose clicks
   the agent reads back. The best moments are hand-offs where work crosses surfaces and changes owner.
3. **Range: learn, take notes, build.** The same assistant tutors him without spoilers, keeps
   a course site of notes, and ships its own UI. Use case #1 shows all three in one night.

Ranking = wow x how well it teaches in a 5-minute tutorial. Privacy flags say what must be
changed before anything goes in a public repo.

---

### 1. Homework night that turned into a shipped feature (learn + notes + build in one flow)
- **What:** In one sitting he asked for the homework PDF on the left and his draft .md on the right, then
  talked through the problems ("don't spoil anything, am I in the right direction?"). Partway through he
  noticed that Ctrl+K editing was clumsy. He pitched merging Ctrl+K and Ctrl+L into one "talk to the agent"
  path that decides whether to answer or propose an edit. The agent handed it to vault-chat workers, it shipped
  (1008b520), and he tried it that afternoon and sent back two precise fixes.
- **Evidence:** school2 chat `62654b29-54a`, 2026-11-12 22:44 to 11-13 02:12 (split view, no-spoiler tutoring). The chat
  "Carl's Idea: Editing Gap Analysis" `44c3dc21-d9d`, 11-13 01:22 (the idea), and its handoff at 11-13 17:44
  ("Carl tried the new Ctrl+K/L (1008b520)…").
- **Why unique:** the agent that tutors you also lays out your screen and also changes the app you're using.
- **Mini version (<2 min):** starter vault with `problem.md` and `draft.md`. Ask: "open the problem on the left
  and my draft on the right, and give me a hint, no spoilers". Then select a line in the draft, press Ctrl+K and say "tighten this".
- **Privacy:** course names, homework content and dates. Use a made-up problem (e.g. a small DP puzzle).

### 2. "Make my cursor a navy pen": plugins written live into the running app
- **What:** Carl asked for a navy pen cursor with an ink trail. It was live in the app within hours with no release ("so you added the
  pen plugin? so cool"). Later, each by asking: a laser-pointer cursor, a floating calculator, a draw-on notepad you can
  drag and resize, a left-panel button, and a **plugin menu** in the bottom-left corner to toggle all of them.
- **Evidence:** `school2/.vault-chat/plugins/*.js` (calculator, notepad, laser-cursor, pen-cursor, plugin-menu,
  left-panel-button). Pen ask in chat `c9a1a03a-89b`, 11-13 17:39 / 21:56. Plugin menu in `1370332f-cef`, 11-16 02:07.
  Notepad in `cbbaa7c1-465`, 11-17 20:51. His goal in his own words: "it should be as simple as ask and get"
  (reports/08-fundamentals).
- **Why unique:** the app's own UI is something you can talk into existence and switch off again: "sometimes I want a feature
  today but I don't want it forever" (11-12).
- **Mini version:** "make me a floating notepad I can draw on" → it appears. Then "turn it off". The tutorial
  plugin can delete itself at the end (Carl suggested exactly this, `055a086c-af9`, 11-17 22:22).
- **Privacy:** clean. Avoid the snail/shail cursors (he called them not cool and "shail" is an in-joke).

### 3. The agent made him a narrated video about its own progress, and picked the style with a quiz he clicked
- **What:** "there's a lot in the vault-chat vault… do you have what's needed to make a video for me?" Workers wrote a
  script, built a style quiz page (his clicks are saved as page state the agent reads back with no copy-paste),
  rendered a ~7-minute 1080p narrated video with an ElevenLabs voice he chose and charts that build on screen, then cut v2 from his notes ("add a KPI part,
  better pauses"). While watching it full screen he spotted that the controls didn't auto-hide like YouTube's. That became an issue, a fix,
  his re-test ("shipped but broken") and a second fix.
- **Evidence:** `vault-chat/video/` (script.md, style-quiz.html, vault-chat-update.mp4, -v2.mp4). Chats
  `5da75607-2fa` (11-17 03:33), `ddab97e5-c6b` (11-17 05:01 to 07:53), `89f372f1-549`. Memory line about quiz pages and
  `vc.state` (MEMORY.md, 11-16).
- **Why unique:** long autonomous media production, choices made through a live page, and the product
  fixed from what he noticed while watching its own update video.
- **Mini version:** "make me a 3-question quiz page about this note and read back my answers". Rendering a video takes too long
  for the tutorial, so just show his video as the teaser.
- **Privacy:** the script quotes internal stats and his asks. The ElevenLabs voice ID is fine but needs a key. Make a fresh demo.

### 4. Apartment hunt: a multi-day web agent that ended in a slideshow he could email
- **What:** From "can you search for apartments for me?" to background workers browsing live listings, taking screenshots,
  checking photos against floor plans (he worried about scams), and shortlisting by budget, in-unit laundry and commute.
  Then on request: an HTML slideshow driven by the arrow keys, opened inline then in the viewer with the side panels closed,
  rebuilt to be more minimal, with "fits budget" and "close call" notes. Finally one self-contained file "so I can email the HTML to my gf".
- **Evidence:** chat "Apartment search for West Loop job" `5d97567d-339`, 11-13 17:21 to 11-15. Screenshots under
  `school2/.vault-chat/visuals/apartments{,2..7}/` (7 rounds, ~200 listings). `visuals/apartments/report.md`.
  `school2/Personal/Apartments shortlist.html` (5 MB, images embedded).
- **Why unique:** research with evidence (screenshots), then a live page in his own viewer, then the agent
  rearranging his layout, all in one thread over days.
- **Mini version:** "find 3 used road bikes under $400 near me, screenshot each listing, and make a slideshow I can arrow
  through". Or skip the web: build a slideshow from 5 bundled images.
- **Privacy: HIGH.** Salary and bonus, employer location, grad date, partner, city and neighborhood. Use a generic product search.

### 5. Phone voice from the gym designs the product; the laptop gets the doc
- **What:** "can I talk to you on voice mode from my phone about all of this? … I'm in the gym." That was about 50 voice turns
  thinking through plugins, pages and whether the phone and iPad are "subsets" of one idea. Back at the laptop the threads became
  `Open ideas.md` ("make a md of them for me and open it, I need some time to ponder"), and then the
  plugin engine behind #2.
- **Evidence:** chat `d61df567-aad`, 11-11 23:13 to 11-12 04:59. `vault-chat/Open ideas.md` (written 11-11).
- **Why unique:** one conversation that moves from phone voice to a laptop document to running features.
- **Mini version:** on a voice call: "let's brainstorm X". After hanging up: "turn that into a one-page md and open it".
- **Privacy:** low, but the content is about vault-chat internals. Use a neutral topic.

### 6. Voice to iPad and back: practice problem sent to the board, solved in ink, read by the agent
- **What:** On a voice call he asked for one exam practice problem to be sent to his iPad. It landed on the board,
  and he worked it there in pen. Separately he asked by voice "can you see my whiteboard? what do I have drawn?" and the agent
  read his strokes. Also by voice: a series of asks that added a whole new lecture tab to his course-notes site.
- **Evidence:** `school2/boards/games/board.json` (item "1. Supremum: prove both halves" from inbox
  `2026-10-21-real-320-1-practice-problem-1`, with his pen strokes). Voice-asks in chat `284a5523-93a`, 10-21 08:10 to 09:13.
  Old conversation `d1c77940-651` (10-18, "can you see my whiteboard").
- **Why unique:** the ask, the work and the check happen on three different surfaces, and the agent can see the handwriting.
- **Mini version:** if an iPad is paired: "send me one practice problem from sample.pdf to my board". Write on it, then
  ask "look at my board, am I right?". Without an iPad, skip this one. Carl calls plain iPad problem sets "obvious",
  so pitch the *loop back*, not the sending.
- **Privacy:** course codes and exam content. Use a generic math problem.

### 7. A living course site of notes: phone photos → notes → a 1.4 MB tabbed HTML course book, and a lost ask recovered
- **What:** Lecture notes were rebuilt as one tabbed HTML course book. He added tabs by voice. Whiteboard photos taken on his phone
  went into the notes. Weeks later: "a while ago I asked in Main for the Halloween stuff to be put inside the course notes,
  can you find that convo, I want to know why it never landed". The agent found the old ask and a worker finished lectures 4 to 7.
- **Evidence:** `school2/IEMS 469/course-notes.html` (1.39 MB), `IEMS 469/halloween.md`, `IEMS 469/phone/IMG_*.jpeg`.
  Chat `44aa7108-5c9`, 11-17 04:04 to 04:51 ("Worker finished: Finish IEMS 469 lectures 4-7"). The vault-chat worker title
  "Fix the missing phone photo in halloween.md and its image delivery".
- **Why unique:** the agent searches its own history and can say why something didn't happen, then finishes it.
- **Mini version:** drop two photos or notes into the starter vault. "Turn these into one HTML page with a tab per topic and open it."
- **Privacy:** course name, instructor, lecture content. Use invented topics.

### 8. Case-study homework designed with a statistician-in-a-box (R simulations on the box)
- **What:** He was designing a teaching case study (ER visits, Poisson model, MLE vs AMLE). The agent set up R on the box,
  ran simulations as background jobs, and wrote "behind closed doors" instructor and student versions side by side.
  Then they iterated on the shape of the arrival-rate curve until "one graphic can connect the function to the shape". He cut "AI slop" wording himself.
- **Evidence:** chat "Poisson Case Study Homework Design" `356c901f-c5c`, 11-12 07:59 to 18:06 (wake lines for R jobs).
  Folder `school2/303 revamp/`.
- **Why unique:** real code execution with a shared notes vault. He steers the math and the agent runs it.
- **Mini version:** "simulate 1,000 coin-flip streaks in Python, plot the longest-streak histogram, and put it in a note".
- **Privacy:** course number and teaching material. Generalize.

### 9. Watch a talk, then apply it to my project
- **What:** He pasted a YouTube link: "watch this video for me and tell me the fundamentals". Then: "check out the
  vault-chat project… are there easy, obvious big wins we can take from the talk and apply here? … bake in the easy wins."
- **Evidence:** chat "Talk Summary and Vault Wins" `b0a55fdc-24e`, 11-16 03:23 to 04:02.
- **Why unique:** media in, project-aware changes out. This goes past a plain summary (he called TLDRs obvious).
- **Mini version:** a short public talk plus a starter project note: "what from this talk applies to my-project.md? Add it as tasks."
- **Privacy:** clean, if a public talk is used.

### 10. Ship to a friend's Mac, verified before shipping
- **What:** "does vault chat work on mac, can my friend go to the github and try it?… you NEED to be able to verify before
  you ship". The agent researched macOS verification for Tauri, checked the title bar visually, and was asked for a recording
  as proof. This tutorial is part of that work.
- **Evidence:** chat "Mac Title Bar Window Controls" `055a086c-af9`, 11-17 21:02 to 22:22. Proof recordings
  `school2/.vault-chat/visuals/recording-2026-11-17T22-*.mp4`.
- **Why unique:** the app verifies and records itself before it changes on someone else's machine. Best as the
  tutorial's last line ("this tutorial was built by asking"), not as something the newcomer does.
- **Privacy:** a friend is mentioned. Drop it.

---

**Not featured (Carl calls these obvious):** PDF homework help, iPad problem sets, voice Q&A, article TLDRs (e.g.
the HBR pitch chat 11-17), snail cursor. Also skipped: "organize my messy vault" (`0fbc3983-196`, 11-16). It's real and useful,
but there's no visual payoff in a starter vault. A one-line mention would be enough.

**Suggested 5-minute arc:** #1 split view and no-spoiler hint (learn) → #7 photos to a tabbed page (notes) → #2 "make me a
notepad plugin" and toggle it off (build) → #3 quiz page whose answers the agent reads back (the agent and you in the loop) → close with
#10 ("vault-chat built this tutorial") and the plugin deleting itself.
