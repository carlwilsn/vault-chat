# vault-chat

A desktop app for your markdown notes with Claude (or GPT, or Gemini) wired into the editor, the PDF viewer, and the chat. Heavily inspired by Obsidian (any folder is a vault), Cursor (inline edit on selections), and Claude Code (a real local-file agent with Read / Write / Bash). Drag a box on any PDF and ask about the region — it sends the pixels, not just text, so math / handwriting / diagrams actually work.

## Getting started

This is a source-first project. You clone the repo, install the prereqs once, and launch it from your terminal.

### 1. Install prerequisites (one-time)

#### macOS

```sh
# Homebrew (skip if you already have it)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

xcode-select --install            # git + cc (skip if already installed)
brew install node rustup-init
rustup-init -y
```

~5 min total. npm ships with Node — no separate install.

#### Linux (Debian / Ubuntu)

```sh
# Build tools + Tauri deps
sudo apt update
sudo apt install -y build-essential curl git libssl-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libwebkit2gtk-4.1-dev

# Node 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

~5 min total. npm ships with Node — no separate install.

#### Windows

**Terminal path** (Windows 11 or any recent Win 10 with winget):

```powershell
winget install OpenJS.NodeJS.LTS
winget install Rustlang.Rustup
# Then run rustup from a fresh shell and accept defaults (installs MSVC build tools, ~1.5 GB)
rustup-init
```

**GUI path** (older Windows without winget):

1. Install [Node 20+](https://nodejs.org/).
2. Install [Rust via rustup](https://rustup.rs/). Accept defaults — installs MSVC build tools.

WebView2 ships with Windows 10/11 — nothing to install either way.

~20 min total, mostly the MSVC download. npm ships with Node — no separate install.

### 2. Clone + install

```sh
git clone https://github.com/carlwilsn/vault-chat
cd vault-chat
npm install
```

~1 min.

### 3. First launch

```sh
npm run tauri dev
```

The first launch takes **~10–15 minutes** while Rust compiles everything. Subsequent launches are ~2 seconds.

When the app opens: hit the gear icon → paste an API key (Anthropic, OpenAI, or Google) → open a folder as your vault → start asking.

## Daily use: the `vault-chat` command

After the first launch works, register the `vault-chat` command globally with one command:

```sh
cd vault-chat
npm link
```

That's it. Type `vault-chat` from any terminal on any OS to launch the app. (`npm link` uses npm's global bin folder, which is already on `PATH` because you installed Node.)

The launcher detaches after a successful first compile — your terminal returns immediately, closing it doesn't kill the app, and dev-server logs tail to `%APPDATA%\com.vault-chat.app\dev.log` (same pattern on Mac/Linux). Pass `--foreground` if you want the output inline.

Unlink later with `npm unlink -g vault-chat`.

## What's in it

- **Ctrl+K inline edit** on any paragraph or code selection. `Ctrl+L` for an ask mode that answers in the same popover without touching the file.
- **PDF marquee** — drag a rectangle over any region of a PDF. Selected text + the pixel screenshot go to the model together. Works on math, tables, scanned pages, handwriting.
- **Model-agnostic**. Anthropic, OpenAI, or Google. Swap mid-session via the settings dropdown.
- **Git-backed**. Every agent turn that touches files auto-commits. One-click restore to any earlier commit. Vault never loses state.
- **Three editable surfaces** — explained below. The agent can modify its own config, and (in dev mode) the app's own source.

## The three editable surfaces

vault-chat treats every folder as a vault. Three are worth knowing about:

| Surface | Where | What's there | Switch from |
|---|---|---|---|
| **User vault** | any folder you pick | your notes | titlebar → folder icon |
| **Meta vault** | `%APPDATA%/com.vault-chat.app/meta/` (Windows) — same pattern Mac/Linux | `system.md`, `skills/`, `tools/` | settings → "Open meta vault" |
| **App source** | the repo you cloned | the app itself | settings → "Open app source" |

Each is git-versioned with auto-commit. The titlebar shows a chip when you're in one of the non-user surfaces so you never forget where you are.

### Creating new skills

Ask the agent: *"Make me a skill for reviewing math HW."* It writes `<meta>/skills/review-hw/SKILL.md` with YAML front-matter. Next turn the skill is invokable as `/review-hw` in chat.

### Creating new tools

Ask: *"Build me a tool that fetches the Champions League standings."* The agent writes `<meta>/tools/champions-league/TOOL.md` (JSON Schema input spec) + `run.py` (reads stdin JSON, prints stdout JSON). Available on the next turn.

### Modifying the app itself

In dev mode, HMR picks up TS/React changes instantly and Rust changes in ~30s. Asking the agent to *"add a new theme"* or *"add a button to the titlebar"* genuinely works — changes appear in the running window.

## Security

API keys live in the OS keychain (Windows Credential Manager / Mac Keychain / Linux libsecret), not in localStorage or plaintext files. The agent's file-operation tools (`Read`, `Write`, `Bash`, etc.) cannot reach them.

The agent cannot modify files inside any `.git/` directory — the file-op tools refuse those paths so the undo system stays intact.

## License

MIT. See [LICENSE](./LICENSE).
