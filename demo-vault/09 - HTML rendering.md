# HTML rendering — and marquee on rendered HTML

vault-chat doesn't only render markdown. Open **dashboard.html** in the file tree.

It's a single self-contained file: React + Tailwind via CDN, dark theme matching the editor, an interactive bar chart of the same revenue data you saw in `sample.pdf`. The whole thing lives inside vault-chat's HTML view — sandboxed iframe, scripts allowed, links open in your real browser.

## Try the marquee on it

Same drag-a-box trick you used on the PDF works here. Toggle the marquee (top-right of the editor pane — the dashed-rectangle icon, or just look for the "marquee" toggle) and drag a rectangle around the bar chart. Ask:

> what's the trend?

> which year had the biggest jump?

The model gets the *rendered pixels* of what you boxed — not the underlying source. Same machinery as the PDF marquee, no special-casing for HTML.

## Hover the bars

The dashboard has live state — hover a bar to see the value tooltip and YoY growth. It's a real React app, not a screenshot. The point: anything you can build with React + Tailwind, you can drop into your vault as a single `.html` file and it renders inline. Build a personal habit tracker, a quick data viewer, a custom calendar — your vault's a folder, your folder's full of files, and HTML files just work.

## Ask the agent to make one

In the chat pane:

> create a file called `mood-tracker.html` that's a single-file React + Tailwind dashboard for tracking my mood across a week. dark theme to match the editor (bg #1a1a1a, indigo accents). seven slots, click to set 1-5, store in localStorage.

Watch it write the file. Click it in the file tree. It just works.

Next: **10 - Terminal.md**.
