# vault-chat

A desktop app for your markdown notes with Claude (or GPT, or Gemini) wired into the editor, the PDF viewer, and the chat. Cursor-style inline editing for prose and code. Drag a box on any PDF and ask about the region — it sends the pixels, not just text, so math / handwriting / diagrams actually work.

![screenshot placeholder — add a GIF of the PDF marquee here]

## What makes it different

- **Three editable surfaces, one app.** Your **vault** (notes), the **meta vault** (the agent's own system prompt, skills, and custom tools), and the **app source** itself. The agent can read and write any of them. Every change is auto-committed to git so nothing is destructive.
- **Ctrl+K inline edit** on any paragraph or code selection. Ctrl+L for an ask mode that answers in the same popover.
- **PDF marquee to ask.** Drag a rectangle over a PDF region — selected text + the pixel screenshot go to the model. Works for theorems, tables, scanned pages.
- **Model-agnostic.** Bring an Anthropic, OpenAI, or Google key. Swap mid-session.
- **Source-first distribution.** Clone the repo, run `vc`. The app is the dev server. You can hack it with the agent itself.

## Prerequisites

This is a source-first project — the recommended way to run it is from the repo, in dev mode. You need:

- **Node 20+**
- **Rust** (via [rustup](https://rustup.rs))
- **git**
- Platform build tools for Tauri (per OS, below)

### macOS

```sh
xcode-select --install              # one-time; includes git + cc
brew install node rustup-init
rustup-init -y
```

### Linux (Debian / Ubuntu)

```sh
sudo apt update
sudo apt install -y build-essential curl git libssl-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libwebkit2gtk-4.1-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Install Node via your preferred method (nvm, fnm, apt, etc.)
```

### Windows

1. Install [Node 20+](https://nodejs.org/).
2. Install [Rust via rustup](https://rustup.rs/). During setup, accept the default (installs MSVC build tools).
3. WebView2 ships with Windows 10/11; nothing to install.

## Install and run

```sh
git clone https://github.com/YOUR_USERNAME/vault-chat
cd vault-chat
npm install
npm run tauri dev
```

**First launch takes ~10–15 minutes** while Rust compiles everything. Subsequent launches are near-instant.

## Daily use: the `vc` command

Once the prereqs above are installed, add the repo's `bin/` folder to your `PATH`. After that, `vc` in any terminal launches the app.

**macOS / Linux** (in `~/.zshrc` or `~/.bashrc`):

```sh
export PATH="$HOME/path/to/vault-chat/bin:$PATH"
```

**Windows** (PowerShell, one-time):

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  "$env:Path;C:\path\to\vault-chat\bin",
  "User"
)
```

Then anywhere: `vc` launches the app.

## Updates

```sh
cd vault-chat
git pull
npm install
```

Next `vc` picks up the changes.

## The three editable surfaces

Every folder vault-chat operates on is just a folder of files. Three are worth knowing about:

| Surface | Where | What's there | Who edits it |
|---|---|---|---|
| **User vault** | any folder you pick | your notes | you + the agent on request |
| **Meta vault** | `%APPDATA%/com.vault-chat.app/meta/` (or equivalent) | `system.md`, `skills/`, `tools/` | you or the agent — changes agent behavior |
| **App source** | the repo you cloned | the app itself | you or the agent — changes hot-reload live |

Switch between them from **Settings**:

- *Open meta vault* → edit the agent's config
- *Open app source* → edit the app itself

The titlebar shows a chip when you're in one of the non-user surfaces, so you never forget where you are. Git is the safety net — every change auto-commits, everything is revertable from the **History** button.

### Creating new skills (with the agent's help)

Ask: *"Make me a skill for reviewing math HW."*

The agent writes `<meta>/skills/review-hw/SKILL.md` with YAML front-matter (name + description + body). Next turn it's available as `/review-hw`.

### Creating new tools

Ask: *"Build me a tool that fetches the latest Champions League standings."*

The agent writes `<meta>/tools/champions-league/TOOL.md` + `run.py`. The manifest uses JSON Schema. The script reads JSON args on stdin and prints JSON to stdout. Available on the next turn.

### Editing the app itself

In dev mode, HMR picks up TS/React changes instantly and rebuilds Rust in ~30s. So asking the agent to *"add a Bright theme to App.css"* or *"add a reload button to the titlebar"* genuinely works — changes appear in the running window.

## Binary install (no toolchain)

Prefer not to build from source? Prebuilt installers for Windows are attached to each [GitHub Release](https://github.com/YOUR_USERNAME/vault-chat/releases). You lose the "edit the app source with the agent" feature, but everything else works.

## Scope

vault-chat is opinionated and small on purpose. Not goals, not coming:

- Editor plugins, graph view, backlinks, or other Obsidian-parity features — use Obsidian for those and point vault-chat at the same folder.
- A browser version — desktop only, Tauri-native.
- Multi-vault memory — opens one folder at a time.
- Chat history persistence across restarts — deliberate. Close the app, chat clears.
- Mobile.

## License

MIT. See [LICENSE](./LICENSE).
