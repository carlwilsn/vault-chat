#!/usr/bin/env python3
"""The box's own screen: the real release, clicked through on a virtual display.

Why this exists: every claim that the desktop app works has been made from unit
tests, a browser preview, or a Linux dev build — and three releases running,
Carl was the first machine to actually open the app, and it did not work. The
box has no screen, so it could never check. This gives it one: Xvfb, the real
AppImage from the release, screenshots read with OCR, clicks and keystrokes sent
with xdotool. What it says happened, happened on a real screen.

It is the release that is run, not this checkout: --app takes an AppImage (or
`latest`, which downloads the newest release's). Everything it touches is
thrown away — its own HOME, its own vault-chat folder, its own Claude config
dir — so it can neither read nor change Carl's own.

It never touches a screen that is not its own: the display is a private Xvfb,
numbered from :90 up and only ever one Xvfb found free, and any inherited
DISPLAY is ignored. Carl's laptop screen is never driven from here.

  scripts/box-screen.py --app latest
  scripts/box-screen.py --app ~/Downloads/vault-chat_0.7.86_amd64.AppImage --keep

The release is built on Ubuntu 26.04 and bundles its glibc-2.43 libraries, which
this box (glibc 2.42) cannot load, so the app itself runs in an ubuntu:26.04
container — the same image the release is built in — with nothing but the X
socket and the throwaway HOME shared into it. The screen, the screenshots and
the clicks stay out here on the host. --runner host runs it through appimage-run
instead, for a machine new enough to load it directly.

Needs Xvfb, xdotool, openbox, dbus, imagemagick, tesseract and appimage-run; on
NixOS it re-runs itself inside a nix-shell that has them.
"""
import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

TOOLS = ["Xvfb", "xdotool", "openbox", "dbus-daemon", "import", "tesseract", "appimage-run"]
NIX_PACKAGES = "xorg-server xdotool openbox dbus imagemagick tesseract appimage-run"
SCREEN = (1440, 1000)
# Well clear of any display a person could be looking at. Xvfb climbs from here
# until it finds one free, so a run that overlaps another still gets its own.
# The titlebar's gear, in pixels from the right edge of the window, and the row
# the controls sit on (src/Titlebar.tsx: pop-out, terminal, settings, then the
# window controls).
SETTINGS_FROM_RIGHT = 123
TITLEBAR_Y = 13
# How far under the "VAULT-CHAT FOLDER" heading its path box and Set button sit.
FOLDER_ROW_BELOW_HEADING = 48
# The chats panel's toggle, the icon just right of the "New chat" words.
CHATS_TOGGLE_RIGHT_OF_NEW_CHAT = 40
# The paste field is the row under the command chip in the sign-in card.
TOKEN_FIELD_BELOW_COMMAND = 30
# The chat panel's own toggle, further left along the same row of icons.
CHAT_PANEL_FROM_RIGHT = 200
REPO = "carlwilsn/vault-chat"

children: list[subprocess.Popen] = []


def spawn(cmd, env=None, out=None, pass_fds=()) -> subprocess.Popen:
    # pass_fds, because Xvfb is told which fd to report its display number on
    # and Popen closes every other fd by default — without it the number never
    # arrives and the display looks like it failed to start.
    p = subprocess.Popen(cmd, env=env, stdout=out or subprocess.DEVNULL, stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, pass_fds=pass_fds)
    children.append(p)
    return p


def stop_children() -> None:
    for p in reversed(children):
        if p.poll() is None:
            p.terminate()
    deadline = time.time() + 5
    for p in reversed(children):
        while p.poll() is None and time.time() < deadline:
            time.sleep(0.05)
        if p.poll() is None:
            p.kill()


def reexec_in_nix(argv: list[str]) -> None:
    """Missing tools are a NixOS fact of life, not a failure: fetch them and re-run."""
    missing = [t for t in TOOLS if shutil.which(t) is None]
    if not missing:
        return
    if not shutil.which("nix-shell"):
        sys.exit(f"missing {', '.join(missing)} and no nix-shell to get them with")
    print(f"[screen] fetching {', '.join(missing)} through nix-shell", flush=True)
    inner = " ".join(["python3", repr(str(Path(__file__).resolve()))[1:-1]] + [f"'{a}'" for a in argv] + ["--inside-nix"])
    os.execvp("nix-shell", ["nix-shell", "-p"] + NIX_PACKAGES.split() + ["--run", inner])


# ---- the screen ------------------------------------------------------------


class Screen:
    """A private Xvfb with a window manager and a session bus, and the hands to use it."""

    def __init__(self, out: Path, env: dict):
        self.out = out
        self.shots = out / "shots"
        self.shots.mkdir(parents=True, exist_ok=True)
        self.env = env
        self.display: str | None = None
        self.n = 0

    def start(self) -> None:
        r, w = os.pipe()
        xvfb_log = open(self.out / "xvfb.log", "wb")
        # From :90 up, and only a number Xvfb found free: a display anyone could
        # be looking at is never taken over. (With -displayfd Xvfb starts at the
        # number it is given and climbs until one is free.)
        before = set(Path("/tmp/.X11-unix").glob("X*")) if Path("/tmp/.X11-unix").is_dir() else set()
        first = 90 + os.getpid() % 60
        spawn(["Xvfb", f":{first}", "-displayfd", str(w), "-screen", "0",
               f"{SCREEN[0]}x{SCREEN[1]}x24", "-nolisten", "tcp"],
              env={**self.env, "DISPLAY": ""}, out=xvfb_log, pass_fds=(w,))
        os.close(w)
        num = b""
        deadline = time.time() + 20
        while b"\n" not in num and time.time() < deadline:
            chunk = os.read(r, 16)
            if not chunk:
                break
            num += chunk
        os.close(r)
        got = num.decode().strip()
        if not got.isdigit() or int(got) < 90:
            raise RuntimeError(f"Xvfb handed out no display of its own (got {got!r})")
        if Path(f"/tmp/.X11-unix/X{got}") in before:
            raise RuntimeError(f"display :{got} was already there — it is somebody's screen, not ours")
        self.display = f":{got}"
        self.env["DISPLAY"] = self.display
        print(f"[screen] private display {self.display}", flush=True)
        # A window manager, so the app's window is mapped, sized and focused the
        # way a real desktop does it, and a session bus, which WebKit expects.
        bus = subprocess.run(["dbus-daemon", "--session", "--fork", "--print-address"],
                             capture_output=True, text=True, env=self.env)
        if bus.returncode == 0 and bus.stdout.strip():
            self.env["DBUS_SESSION_BUS_ADDRESS"] = bus.stdout.strip()
        spawn(["openbox"], env=self.env)
        time.sleep(1)

    def x(self, *args: str) -> str:
        return subprocess.run(["xdotool", *args], capture_output=True, text=True, env=self.env).stdout.strip()

    def shot(self, name: str) -> Path:
        self.n += 1
        p = self.shots / f"{self.n:02d}-{name}.png"
        subprocess.run(["import", "-window", "root", str(p)], check=True, env=self.env)
        return p

    def pass_(self, png: Path, suffix: str, recipe: list[str], scale: int) -> list[dict]:
        """One OCR pass over the shot, prepared one way. Scale is how much the
        recipe grew it, so the words come back in screen pixels."""
        big = png.with_suffix(f".{suffix}.png")
        subprocess.run(["convert", str(png), *recipe, str(big)], check=True, env=self.env)
        tsv = subprocess.run(["tesseract", str(big), "stdout", "--psm", "11", "tsv"],
                             capture_output=True, text=True, env=self.env).stdout
        out = []
        for line in tsv.splitlines()[1:]:
            f = line.split("\t")
            if len(f) < 12 or not f[11].strip():
                continue
            left, top, w, h = (int(f[6]) / scale, int(f[7]) / scale, int(f[8]) / scale, int(f[9]) / scale)
            out.append({"text": f[11], "x": left + w / 2, "y": top + h / 2,
                        "conf": float(f[10]), "pass": suffix})
        # Reading order within the pass: down the screen in rows, left to right
        # inside a row. find() walks this list to match a phrase.
        out.sort(key=lambda w: (round(w["y"] / 6), w["x"]))
        return out

    def words(self, png: Path) -> list[dict]:
        """Every word OCR found, with where it is — two passes, one after the other.

        One pass cannot read this UI. Plain upscaling reads the bright text —
        headings, paragraphs, the editor — and goes blind on the small dim
        grey-on-near-black of the titlebar and the file tree: the run that found
        this had "Open folder" on screen the whole time and never saw the words,
        so the vault was never picked and four checks failed for a reason that
        was never in the app. Inverting and pushing the contrast reads that
        text, and loses some of the bright text in return.

        The two stay apart rather than interleaved, because a phrase is matched
        by words standing next to each other: merging the passes drops one
        pass's half-read word ("VAULT-", "ILDER") between the other's whole ones
        and the phrase no longer reads. find() tries each pass in turn instead.
        """
        return (self.pass_(png, "2x", ["-resize", "200%"], 2)
                + self.pass_(png, "dim", ["-colorspace", "gray", "-negate", "-resize", "400%",
                                          "-sigmoidal-contrast", "5x30%"], 4))

    def read(self, name: str) -> tuple[str, list[dict]]:
        """What is on screen as text, plus the words' places. The text is one line, lowercased."""
        png = self.shot(name)
        ws = self.words(png)
        said: list[str] = []
        for i, w in enumerate(ws):
            # A word both passes read in the same place is one word on screen.
            if any(o["pass"] != w["pass"] and norm(o["text"]) == norm(w["text"])
                   and abs(o["x"] - w["x"]) < 12 and abs(o["y"] - w["y"]) < 8 for o in ws[:i]):
                continue
            said.append(w["text"])
        return (" ".join(said).lower(), ws)

    def find(self, ws: list[dict], want: str, below: float = 0) -> dict | None:
        """Where `want` is on screen — a word, or a phrase whose words sit side
        by side. `below` skips everything higher up, for a word that appears
        more than once (Settings has two "Set"s)."""
        # Both sides the same way: OCR reads "VAULT-CHAT" as one word, and a
        # wanted word with a hyphen in it would otherwise never match.
        parts = [norm(x) for x in want.split()]
        for which in dict.fromkeys(w["pass"] for w in ws):
            got = self.find_in([w for w in ws if w["pass"] == which], parts, below)
            if got:
                return got
        return None

    @staticmethod
    def find_in(ws: list[dict], parts: list[str], below: float) -> dict | None:
        for i, w in enumerate(ws):
            if w["y"] < below:
                continue
            if norm(w["text"]) != parts[0]:
                continue
            run = [w]
            ok = True
            for j, p in enumerate(parts[1:], 1):
                if i + j >= len(ws) or norm(ws[i + j]["text"]) != p:
                    ok = False
                    break
                run.append(ws[i + j])
            if ok:
                return {"x": sum(r["x"] for r in run) / len(run), "y": sum(r["y"] for r in run) / len(run)}
        return None

    def click_text(self, want: str, name: str, tries: int = 3) -> bool:
        for attempt in range(tries):
            _, ws = self.read(f"{name}-look")
            at = self.find(ws, want)
            if at:
                self.x("mousemove", str(round(at["x"])), str(round(at["y"])), "click", "1")
                time.sleep(1.5)
                self.shot(f"{name}-clicked")
                return True
            time.sleep(1.5)
        return False

    def click_at(self, x: int, y: int, name: str) -> None:
        self.x("mousemove", str(x), str(y), "click", "1")
        time.sleep(1.5)
        self.shot(name)

    def type_text(self, text: str) -> None:
        self.x("type", "--clearmodifiers", "--delay", "40", text)
        time.sleep(0.5)

    def key(self, chord: str) -> None:
        self.x("key", "--clearmodifiers", chord)
        time.sleep(0.8)

    def app_window(self) -> str | None:
        got = self.x("search", "--onlyvisible", "--name", "vault-chat")
        return got.split()[0] if got else None

    def settle_window(self) -> bool:
        deadline = time.time() + 90
        while time.time() < deadline:
            win = self.app_window()
            if win:
                self.x("windowmove", win, "0", "0", "windowsize", win, str(SCREEN[0]), str(SCREEN[1]),
                       "windowactivate", "--sync", win)
                time.sleep(2)
                return True
            time.sleep(1)
        return False


def dismiss_update(screen: "Screen") -> bool:
    """Put away the update offer if one is on screen, and say whether there was.

    It is a toast in the bottom-right corner, over the chat pane — the release
    the box is clicking through is the one it was given, not whatever shipped
    since. One arrived mid-run (the app polls, and a release had just been
    published) and covered "New chat": two checks failed on a control that was
    there all along, behind it.
    """
    _, ws = screen.read("maybe-update")
    later = screen.find(ws, "Later")
    if not later:
        return False
    screen.click_at(round(later["x"]), round(later["y"]), "update-dismissed")
    time.sleep(1)
    return True


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


# ---- the release -----------------------------------------------------------


def latest_appimage(into: Path) -> Path:
    """The newest release's AppImage — the file Carl's Linux install would get."""
    into.mkdir(parents=True, exist_ok=True)
    subprocess.run(["gh", "release", "download", "--repo", REPO, "--pattern", "*.AppImage",
                    "--dir", str(into), "--clobber"], check=True)
    found = sorted(into.glob("*.AppImage"))
    if not found:
        raise RuntimeError("the latest release carries no AppImage")
    return found[0]


IMAGE = "vc-screen:26.04"
# Ubuntu's own webkit/gtk stack, so everything the bundle does not carry is
# there; the AppImage's own copies take precedence when it runs.
DOCKERFILE = """FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-0 libgtk-3-0t64 libayatana-appindicator3-1 librsvg2-2 \
      libasound2t64 libgl1-mesa-dri libglx-mesa0 libegl1 fontconfig fonts-dejavu-core \
      dbus-x11 xdg-utils zlib1g ca-certificates \
    && rm -rf /var/lib/apt/lists/*
"""


def docker_ok() -> bool:
    return shutil.which("docker") is not None and subprocess.run(
        ["docker", "info"], capture_output=True).returncode == 0


def ensure_image() -> None:
    if subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True).returncode == 0:
        return
    print(f"[screen] building {IMAGE} (the release's own build image)", flush=True)
    subprocess.run(["docker", "build", "-t", IMAGE, "-"], input=DOCKERFILE, text=True, check=True)


def run_app(app: Path, env: dict, out: Path, runner: str) -> str:
    """Start the release. Returns how it was run, for the report."""
    log = open(out / "app.log", "wb")
    if runner == "host":
        spawn(["appimage-run", str(app)], env=env, out=log)
        return "appimage-run on the host"
    ensure_image()
    name = f"vc-screen-{os.getpid()}"
    home = env["HOME"]
    cmd = ["docker", "run", "--rm", "--name", name, "--net=host", "--shm-size=1g",
           "--user", f"{os.getuid()}:{os.getgid()}",
           "-v", "/tmp/.X11-unix:/tmp/.X11-unix",
           "-v", f"{out}:{out}",
           "-v", f"{app}:/release.AppImage:ro",
           "-w", home, "-e", "APPIMAGE_EXTRACT_AND_RUN=1", "-e", f"TMPDIR={home}/tmp"]
    # The sign-in drives a real `claude`, and the image has none. The box's own
    # binary is lent to it read-only — the BINARY, never a login: the config dir
    # is the throwaway HOME's, so nothing of Carl's account is in there and
    # nothing this run does can reach it.
    cli = box_claude()
    if cli:
        cmd += ["-v", f"{cli}:/claude:ro", "-e", "VC_CLAUDE_BIN=/claude"]
    (Path(home) / "tmp").mkdir(parents=True, exist_ok=True)
    for k, v in env.items():
        # The host's PATH is nix store paths that do not exist in the image; the
        # stand-in browser still goes first, which is what the sign-in check reads.
        if k == "PATH":
            v = f"{home}/bin:/usr/local/bin:/usr/bin:/bin"
        cmd += ["-e", f"{k}={v}"]
    cmd += [IMAGE, "/release.AppImage"]
    (out / "docker-cmd").write_text(" ".join(cmd) + "\n")
    spawn(cmd, env={**os.environ, "DISPLAY": env["DISPLAY"]}, out=log)
    return f"the release in {IMAGE}"


def box_claude() -> Path | None:
    """A Claude Code binary on this machine, to lend the container."""
    home = Path.home()
    for p in [
        home / ".local" / "state" / "vault-chat-server" / "claude" / "bin" / "claude",
        home / ".local" / "state" / "vault-chat-server" / "claude" / "cli" / "claude",
        home / ".local" / "bin" / "claude",
    ]:
        if p.is_file():
            return p
    found = shutil.which("claude")
    return Path(found) if found else None


def stop_app() -> None:
    """docker run's child dying does not stop the container; ask it to stop."""
    subprocess.run(["docker", "rm", "-f", f"vc-screen-{os.getpid()}"], capture_output=True)


def staged(app: Path, out: Path) -> Path:
    """The AppImage, executable. A release asset downloads as 0644 and a file
    that cannot be executed is the whole of what goes wrong, with no sign of why."""
    if os.access(app, os.X_OK):
        return app
    dest = out / "release" / app.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.resolve() != app.resolve():
        shutil.copy2(app, dest)
    dest.chmod(0o755)
    return dest


def throwaway_home(out: Path) -> tuple[dict, Path]:
    """A HOME of its own, with a vault-chat folder and a stand-in for the browser.

    The fake xdg-open is how "the sign-in opens a browser" is checked without a
    browser: the app's opener runs it, and it writes the URL down instead.
    """
    home = out / "home"
    for d in ["bin", ".config", ".local/share", ".cache", "vc/vaults"]:
        (home / d).mkdir(parents=True, exist_ok=True)
    opened = out / "opened-urls"
    opened.write_text("")
    xdg = home / "bin" / "xdg-open"
    xdg.write_text(f'#!/bin/sh\nprintf "%s\\n" "$1" >> {opened}\n')
    xdg.chmod(0o755)
    # A vault to pick: the folder layout the picker lists (<master>/vaults/<name>).
    # The name is deliberately not a word that appears anywhere else on screen
    # (not in the path, not in the app's own chrome): a check that reads it has
    # then really read the vault.
    vault = home / "vc" / "vaults" / "Orchard"
    (vault / "notes").mkdir(parents=True, exist_ok=True)
    (vault / "notes" / "welcome.md").write_text("# Orchard\n\nA note for the virtual screen to show.\n")
    env = {
        "HOME": str(home),
        "PATH": f"{home / 'bin'}:{os.environ.get('PATH', '')}",
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "XDG_RUNTIME_DIR": os.environ.get("XDG_RUNTIME_DIR", "/tmp"),
        # Never the box's own login: a sign-in started here writes nowhere Carl's
        # account lives, and nothing of his is readable from it.
        "CLAUDE_CONFIG_DIR": str(home / ".claude-throwaway"),
        "LANG": "C.UTF-8",
        "WEBKIT_DISABLE_COMPOSITING_MODE": "1",
        "WEBKIT_DISABLE_DMABUF_RENDERER": "1",
        "LIBGL_ALWAYS_SOFTWARE": "1",
        "GDK_BACKEND": "x11",
        "NO_AT_BRIDGE": "1",
        # One core for the screenshots and the OCR: this box is also a build
        # machine, and a screen check must not starve what else is running.
        "MAGICK_THREAD_LIMIT": "1",
        "OMP_THREAD_LIMIT": "1",
    }
    return env, vault


# ---- the click-through -----------------------------------------------------

# Words that must not be anywhere in Settings any more: the providers and model
# ids of the two-engine world, and the engine itself. (A model is named by what
# it is for — "Opus" — beside Send, never by an id.)
FORBIDDEN = ["openrouter", "open router", "anthropic/claude", "openai/", "gpt-", "grok"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default="latest", help="an AppImage path, or `latest` to download the release's")
    ap.add_argument("--out", default="/tmp/vc-box-screen", help="where the screenshots and the log go")
    ap.add_argument("--keep", action="store_true", help="leave the throwaway HOME behind to look at")
    ap.add_argument("--runner", default="auto", choices=["auto", "docker", "host"],
                    help="how to run the AppImage: in the release's ubuntu:26.04 image, or straight on this machine")
    ap.add_argument("--inside-nix", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()
    if not args.inside_nix:
        reexec_in_nix([a for a in sys.argv[1:]])

    out = Path(args.out)
    # One run at a time: two of these share a display, a container name and a
    # shots folder, and the second quietly ruins both.
    lock = Path(args.out + ".lock")
    if lock.exists():
        try:
            os.kill(int(lock.read_text().strip()), 0)
            sys.exit(f"another screen run is live (pid {lock.read_text().strip()}); {lock} says so")
        except (ProcessLookupError, ValueError):
            pass
    lock.write_text(str(os.getpid()))
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    app = latest_appimage(out / "release") if args.app == "latest" else Path(args.app).expanduser().resolve()
    if not app.is_file():
        sys.exit(f"no AppImage at {app}")
    app = staged(app, out)

    env, vault = throwaway_home(out)
    screen = Screen(out, env)
    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, said: str = "") -> None:
        checks.append((name, ok, said))
        print(f"[{'ok  ' if ok else 'FAIL'}] {name}{(' — ' + said) if said else ''}", flush=True)

    try:
        screen.start()
        runner = args.runner if args.runner != "auto" else ("docker" if docker_ok() else "host")
        how = run_app(app, env, out, runner)
        print(f"[screen] running {app.name} — {how}", flush=True)

        # 1. It opens at all. On a fresh machine, with no box: the thing three
        #    releases could not be said to do.
        up = screen.settle_window()
        check("the release opens a window on a machine with no box", up)
        if not up:
            return report(checks, out)
        text, _ = screen.read("opened")
        check("and it draws its own UI, not an error page", len(text) > 40, f"{len(text)} characters of text")

        # 2. An update offer, if one is waiting: it sits over the corner of the
        #    screen, and this run is about the version it was given.
        dismiss_update(screen)

        # 3. Settings, and the vault-chat folder — Carl's setup, in his order.
        #    The gear is an icon, so there is no word for OCR to find: it is the
        #    fourth control in from the right edge (src/Titlebar.tsx). Whether
        #    the click landed is answered by what Settings then says.
        screen.click_at(SCREEN[0] - SETTINGS_FROM_RIGHT, TITLEBAR_Y, "settings-clicked")
        time.sleep(2)
        text, ws = screen.read("settings-open")
        check("Settings opens from the titlebar", any(w in text for w in ("keys", "box", "agent", "vault")))
        folder_set = False
        # The section is found by its heading, which is the one string on the
        # pane that is only ever this section. Its button says "Set", and OCR has
        # no idea which word is a button — so the row is taken by position
        # instead: the box and its button are one line under the heading and its
        # sentence (src/MasterSection.tsx). (There was a second "Set" above it,
        # in the Models row; that row is gone — a chat's model is chosen beside
        # Send now.)
        heading = screen.find(ws, "VAULT-CHAT FOLDER")
        if heading:
            row_y = round(heading["y"]) + FOLDER_ROW_BELOW_HEADING
            screen.click_at(600, row_y, "folder-box")
            screen.key("ctrl+a")
            screen.type_text(str(vault.parent.parent))
            # Tab to the button and press it: a keyboard press cannot land a few
            # pixels off the way a click can, and the button is the next thing
            # after the box.
            screen.key("Tab")
            screen.key("Return")
            time.sleep(5)
            text, _ = screen.read("folder-saved")
            # The vault is listed under the folder once it is set.
            folder_set = "orchard" in text
            if not folder_set:
                # Then the button itself, at the right-hand end of that row.
                screen.click_at(SCREEN[0] - 35, row_y, "folder-set-clicked")
                time.sleep(5)
                text, _ = screen.read("folder-saved-2")
                folder_set = "orchard" in text
        check("the vault-chat folder can be set, and lists the vault in it", folder_set)

        # 4. Pick the vault from the app's own picker.
        picked = False
        screen.click_at(SCREEN[0] - SETTINGS_FROM_RIGHT, TITLEBAR_Y, "settings-closed")
        time.sleep(1)
        if screen.click_text("Open folder", "open-folder"):
            time.sleep(2)
            if screen.click_text("Orchard", "pick-vault"):
                time.sleep(5)
                text, _ = screen.read("vault-open")
                # The open vault's name is in the titlebar and its folders are
                # in the tree beside it.
                picked = "orchard" in text and "notes" in text
        check("a vault can be picked, and the app opens it", picked)

        # 5. Signed out, the chat says so — one line where the chat is, not a
        #    window-wide gate. The chat panel starts closed; it has a shortcut
        #    of its own (src/Titlebar.tsx: "Show chat panel (Ctrl+Shift+B)"),
        #    which cannot land a few pixels off the way a click can.
        screen.key("ctrl+shift+b")
        time.sleep(2)
        text, ws = screen.read("chat")
        if "sign in" not in text and "connect your box" not in text:
            # Then its icon, in case the shortcut was swallowed: it is the
            # left-most of the titlebar's right-hand controls.
            screen.click_at(SCREEN[0] - CHAT_PANEL_FROM_RIGHT, TITLEBAR_Y, "chat-opened")
            time.sleep(2)
            text, ws = screen.read("chat-2")
        # A machine with no box runs the server itself, and that takes a while
        # to boot — a fixed wait here would read whatever the chat happened to
        # be showing mid-start and call it the answer. So wait for the chat to
        # settle on what it means, up to the app's own 90 s giving-up point.
        deadline = time.time() + 120
        while "sign in" not in text and time.time() < deadline:
            time.sleep(5)
            text, ws = screen.read("chat-waiting")
        check("the chat asks for the Claude sign-in when signed out", "sign in" in text)
        check("and the app is still usable around it (the vault is on screen)", "orchard" in text or "welcome" in text)
        # An update can be offered at any moment, not only at startup: the app
        # polls, and one arrived in the middle of a run and sat over the corner
        # of the chat pane. Put it away before reading the pane, or a control it
        # covers is reported missing.
        if dismiss_update(screen):
            text, ws = screen.read("chat-after-update")
        # Clearing a conversation is gone: a new chat is a new chat, and the old
        # one stays in the list under its place (src/ChatsPanel.tsx).
        check("a new chat can be started, and nothing offers to clear one",
              "new chat" in text and "clear" not in text,
              "found the word clear" if "clear" in text else "")
        # And the list those chats live in. Signed out the pane still draws its
        # own chrome — the sign-in card only replaces the composer — so the
        # panel's toggle, the icon just right of "New chat", opens the places:
        # the vault's main on its own, then projects. (The model and effort
        # pickers sit in the composer, so they are the one part of all this the
        # box cannot see without a sign-in of its own.)
        listed = ""
        at = screen.find(ws, "New chat")
        if at:
            toggle = (round(at["x"]) + CHATS_TOGGLE_RIGHT_OF_NEW_CHAT, round(at["y"]))
            screen.click_at(*toggle, "chats-panel")
            time.sleep(2)
            listed, _ = screen.read("chats-list")
            # Shut again: the panel sits over the pane, and what comes next is
            # the sign-in card underneath it. Escape, not the toggle — once the
            # panel is open it covers the toggle, so clicking there again hits
            # the panel and the card stays hidden.
            screen.key("Escape")
            time.sleep(1)
            screen.shot("chats-panel-shut")
        check("the chats are a list of places, with the vault's main in it",
              "main" in listed and "project" in listed,
              "the panel did not open" if not listed else f"{len(listed)} characters read")

        # 6. What the sign-in actually is now: Carl runs `claude setup-token` in
        #    a real terminal and pastes what it prints. The app drove that
        #    command itself once, through a pty, and it broke four different
        #    ways on his Windows laptop before he said to stop — so what is
        #    checked here is the command he is given, the field he pastes into,
        #    and the one button. Nothing is completed: minting a token is his.
        screen.shot("sign-in-state")
        said = []
        if "setup-token" in text:
            said.append("the command")
        if "sign in with claude" in text:
            said.append("the button")
        check("the sign-in shows the command to run and the button to save what it prints",
              "setup-token" in text and "sign in with claude" in text,
              ", ".join(said) if said else "neither on screen")
        # And the paste field takes a token: typed into, the button is what acts
        # on it. A bad token is refused on the spot, which is the one thing that
        # can be checked without minting a real one.
        #
        # The field is found from the command above it, not from its own
        # placeholder: OCR reads "claude setup-token" (a monospace chip) every
        # time and reads "sk-ant-oat01-…" as "sk-ant-oat0l-." or not at all. A
        # run that clicked the placeholder it could not see fell back to
        # clicking the command, typed a token into nothing, pressed the button
        # on an empty field and reported the app as broken.
        # What was typed is never read back: the field masks a token, the way a
        # password field does, so the screen shows dots and OCR can say nothing
        # about them. The click is what had to be made reliable; whether it
        # worked is answered by what the app does with the button.
        _, ws = screen.read("sign-in-card")
        field = screen.find(ws, "setup-token")
        if field:
            screen.click_at(round(field["x"]), round(field["y"]) + TOKEN_FIELD_BELOW_COMMAND, "token-field")
            screen.type_text("not-a-real-token")
            # Entered, not clicked. The button cannot be found on screen: its
            # label is white on a light fill and OCR reads that row as "sor",
            # "[", "vincinv" once the field holds its dots, and the words "Sign
            # in with Claude" that ARE readable belong to the card's heading
            # above it — clicking those does nothing, which one run reported as
            # the app swallowing a bad token. The field takes Enter
            # (src/ClaudeCodeSignIn.tsx), which is what a person does anyway.
            screen.key("Return")
            time.sleep(2)
            after, _ = screen.read("token-refused")
            said = next((p for p in ("doesn't look like", "does not look like", "sk-ant-oat") if p in after), None)
            check("a token that is not one is refused on the spot, with no raw error", bool(said),
                  f'the card said "{said}"' if said else "nothing on screen says the token was refused")
        else:
            check("a token that is not one is refused on the spot, with no raw error", False,
                  "the sign-in card was not on screen")

        # 7. Settings again, with a vault open: no OpenRouter, no pi, nothing
        #    of the old two-engine world.
        screen.click_at(SCREEN[0] - SETTINGS_FROM_RIGHT, TITLEBAR_Y, "settings-again")
        time.sleep(2)
        text, _ = screen.read("settings-wording")
        said = [w for w in FORBIDDEN if w in text]
        check("Settings names no OpenRouter and no other engine", text != "" and not said,
              ("found " + ", ".join(said)) if said else f"{len(text)} characters read")

        return report(checks, out)
    finally:
        stop_app()
        stop_children()
        Path(args.out + ".lock").unlink(missing_ok=True)
        if not args.keep:
            shutil.rmtree(out / "home", ignore_errors=True)


def report(checks: list[tuple[str, bool, str]], out: Path) -> int:
    (out / "result.json").write_text(json.dumps(
        [{"check": c, "ok": ok, "said": said} for c, ok, said in checks], indent=2))
    failed = [c for c, ok, _ in checks if not ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} on a real screen; shots in {out / 'shots'}", flush=True)
    for c in failed:
        print(f"  still wrong: {c}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (stop_children(), sys.exit(143)))
    try:
        sys.exit(main())
    finally:
        stop_children()
