# Notes — capture-as-you-go (Ctrl+N)

Sometimes you don't want to edit the file. You just want to jot a thought *about* what you're reading and come back to it later. That's what Notes are for.

## Try it on this paragraph

Select the next paragraph below — triple-click is fine. Press **Ctrl+N**. A composer pops open with the selection anchored to *this file, this line*. Type:

> revisit this — relevant to chapter 3 of my thesis

Hit Enter. The note saves. Click the **sticky-note icon** in the titlebar (top-right) to open the Notes panel — your note's there, with a one-click "Jump back" that takes you to the exact spot in this file.

---

The cleverest use of vault-chat is the part that *isn't* prose-rewriting at all. The agent and the inline tools are the loud features, but the quiet feature — capture-and-revisit — is what turns the app from "a chat-y editor" into "a place I actually live."

---

## Try it on the PDF

Open `sample.pdf` again. Turn on the marquee, drag a box around the equation. Instead of asking the model, press **Ctrl+N**. The note captures the *image* of what you boxed, plus a reference to which PDF page it came from. Future you opens the note three weeks later and sees the equation rendered inline next to your scribble.

The same works on `dashboard.html` (HTML marquee → note) and on any image file.

## Where they live

`<your-vault>/.vault-chat/notes.jsonl` — JSON-lines, one note per row. Hidden from the file tree but versioned with the rest of the vault, so they travel with your notes when you push the repo elsewhere or restore via Ctrl+H.

States are **open** / **resolved** — flip a note to resolved when you've dealt with it. The titlebar sticky-note icon shows a dot when there are open notes pending, so they don't disappear into the void.

---

That's the tour. Now open a folder you actually use — your real notes, your research, a project directory — and start chatting. Titlebar → folder icon → pick a directory.

Found a bug or have an idea? carlwilson2027@u.northwestern.edu.
