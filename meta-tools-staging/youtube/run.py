#!/usr/bin/env python3
"""
Download a YouTube video and produce a vault reference doc.

Pipeline:
  yt-dlp (audio + low-res video)
    -> Groq Whisper Large v3 Turbo (verbose_json transcription)
    -> ffmpeg scene-change keyframe extraction
    -> assembled markdown with interleaved [HH:MM:SS] transcript and frames

Reads JSON {url, output_dir} from stdin.
Reads Groq API key from os.environ["groq"].
Prints final result JSON to stdout.
Progress messages go to stderr.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import requests
    import yt_dlp
    import imageio_ffmpeg
except ImportError as e:
    # The Tauri child process may pick a different Python than the user's
    # interactive shell — multiple installs (pyenv / Microsoft Store /
    # Program Files) share `python` on PATH. Print sys.executable so the
    # user knows exactly which interpreter to install into.
    print(
        f"error: missing dep '{getattr(e, 'name', e)}'\n"
        f"  this script is running under: {sys.executable}\n"
        f"  install with:\n"
        f"    \"{sys.executable}\" -m pip install yt-dlp imageio-ffmpeg requests",
        file=sys.stderr,
    )
    sys.exit(1)


GROQ_API_BASE = "https://api.groq.com/openai/v1"
GROQ_MODEL = "whisper-large-v3-turbo"
SCENE_THRESHOLD = 0.3
GROQ_FREE_TIER_MAX_MB = 25


def slugify(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"[\s-]+", "-", s)
    return s.strip("-")[:80] or "video"


def fmt_filename_ts(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600:02d}-{(s % 3600) // 60:02d}-{s % 60:02d}"


def fmt_human_ts(seconds: float) -> str:
    s = int(seconds)
    if s >= 3600:
        return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"
    return f"{s // 60:02d}:{s % 60:02d}"


def die(msg: str, code: int = 1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def download_audio(url: str, tmpdir: Path, ffmpeg_exe: str) -> Path:
    """
    Two-step audio extraction:
      1. yt-dlp pulls the raw bestaudio stream as-is (no postprocessing).
         Avoids yt-dlp's FFmpegExtractAudio postprocessor which would
         require ffprobe — imageio-ffmpeg ships only ffmpeg, not ffprobe.
      2. We run our bundled ffmpeg ourselves to compress to 16kbps mono mp3.
    """
    raw_template = str(tmpdir / "audio_raw.%(ext)s")
    opts = {
        "format": "bestaudio/best",
        "outtmpl": raw_template,
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    raw_files = [p for p in tmpdir.glob("audio_raw.*") if p.suffix.lower() != ".part"]
    if not raw_files:
        die("audio download produced no file")
    raw = raw_files[0]

    out = tmpdir / "audio.mp3"
    proc = subprocess.run(
        [
            ffmpeg_exe,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(raw),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "16k",
            str(out),
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if proc.returncode != 0 or not out.exists():
        die(f"ffmpeg audio compress failed: {proc.stderr[:500]}")
    return out


def download_video(url: str, tmpdir: Path, ffmpeg_exe: str) -> Path:
    """
    Pull a single low-res combined stream. yt-dlp's `worst` selector picks
    a pre-merged audio+video format, so no merge step (which would need
    ffprobe). We only use this file for frame extraction; audio comes from
    download_audio.
    """
    out_template = str(tmpdir / "video.%(ext)s")
    opts = {
        "format": "worst[ext=mp4]/worst",
        "outtmpl": out_template,
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    candidates = [p for p in tmpdir.glob("video.*") if p.suffix.lower() != ".part"]
    if not candidates:
        die("video download produced no file")
    return candidates[0]


def transcribe_with_groq(audio_path: Path, api_key: str) -> dict:
    size_mb = audio_path.stat().st_size / 1024 / 1024
    print(f"  audio size: {size_mb:.1f} MB", file=sys.stderr)
    if size_mb > GROQ_FREE_TIER_MAX_MB:
        print(
            f"  warning: exceeds {GROQ_FREE_TIER_MAX_MB}MB free-tier limit — Groq may 413",
            file=sys.stderr,
        )
    with open(audio_path, "rb") as f:
        r = requests.post(
            f"{GROQ_API_BASE}/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (audio_path.name, f, "audio/mpeg")},
            data={
                "model": GROQ_MODEL,
                "response_format": "verbose_json",
                "timestamp_granularities[]": "segment",
            },
            timeout=600,
        )
    if r.status_code != 200:
        die(f"groq returned {r.status_code}: {r.text[:500]}")
    return r.json()


def extract_keyframes(video_path: Path, ffmpeg_exe: str, frames_dir: Path):
    """Run ffmpeg scene-change detection. Returns [(timestamp_seconds, png_path), ...]."""
    cmd = [
        ffmpeg_exe,
        "-hide_banner",
        "-i",
        str(video_path),
        "-vf",
        f"select='gt(scene,{SCENE_THRESHOLD})',showinfo",
        "-vsync",
        "vfr",
        str(frames_dir / "frame-%04d.png"),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    pts_re = re.compile(r"pts_time:(\d+\.?\d*)")
    times = []
    for line in proc.stderr.splitlines():
        if "Parsed_showinfo" in line and "pts_time" in line:
            m = pts_re.search(line)
            if m:
                times.append(float(m.group(1)))

    frame_files = sorted(frames_dir.glob("frame-*.png"))
    out = []
    for i, fp in enumerate(frame_files):
        if i >= len(times):
            fp.unlink(missing_ok=True)
            continue
        ts = times[i]
        new_path = frames_dir / f"{fmt_filename_ts(ts)}.png"
        if new_path.exists() and new_path != fp:
            new_path.unlink()
        if new_path != fp:
            fp.rename(new_path)
        out.append((ts, new_path))
    out.sort(key=lambda x: x[0])
    return out


def assemble_markdown(info, transcription, frames, out_root, url):
    title = info.get("title", "Untitled")
    duration = float(transcription.get("duration") or info.get("duration") or 0)
    segments = transcription.get("segments", []) or []

    md = []
    md.append(f"# {title}")
    md.append("")
    md.append(f"**source**: {url}  ")
    md.append(f"**channel**: {info.get('uploader', '?')}  ")
    md.append(f"**duration**: {fmt_human_ts(duration)}  ")
    md.append(f"**transcribed by**: groq · {GROQ_MODEL}")
    md.append("")
    md.append("---")
    md.append("")

    if not segments:
        md.append("_(transcription returned no segments)_")
        md.append("")

    frame_iter = iter(frames)
    next_frame = next(frame_iter, None)

    def emit_frame(ts_path):
        ts, path = ts_path
        rel = path.relative_to(out_root).as_posix()
        md.append("")
        md.append(f"![[scene change at {fmt_human_ts(ts)}]](./{rel})")
        md.append("")

    for seg in segments:
        start = float(seg.get("start", 0) or 0)
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        while next_frame is not None and next_frame[0] <= start:
            emit_frame(next_frame)
            next_frame = next(frame_iter, None)
        md.append(f"[{fmt_human_ts(start)}] {text}")

    while next_frame is not None:
        emit_frame(next_frame)
        next_frame = next(frame_iter, None)

    slug = out_root.name
    md_path = out_root / f"{slug}.md"
    md_path.write_text("\n".join(md) + "\n", encoding="utf-8")
    return md_path


def main():
    args = json.loads(sys.stdin.read() or "{}")
    url = args.get("url")
    output_dir = args.get("output_dir")

    if not url:
        die("missing 'url'")
    if not output_dir:
        die("missing 'output_dir' (absolute vault path)")

    api_key = os.environ.get("groq")
    if not api_key:
        die("groq API key not in env. Settings -> Your keys -> register name 'groq'.")

    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)

        print("[1/4] fetching metadata", file=sys.stderr)
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
            info = ydl.extract_info(url, download=False)
        title = info.get("title", "video")
        slug = slugify(title)

        out_parent = Path(output_dir)
        out_parent.mkdir(parents=True, exist_ok=True)
        out_root = out_parent / slug
        out_root.mkdir(parents=True, exist_ok=True)
        frames_dir = out_root / "frames"
        frames_dir.mkdir(exist_ok=True)

        print(f"[1/4] title: {title}", file=sys.stderr)
        print(f"[1/4] output: {out_root}", file=sys.stderr)

        print("[2/4] downloading audio + low-res video", file=sys.stderr)
        audio_path = download_audio(url, tmpdir, ffmpeg_exe)
        video_path = download_video(url, tmpdir, ffmpeg_exe)

        print("[3/4] transcribing via groq", file=sys.stderr)
        transcription = transcribe_with_groq(audio_path, api_key)

        print("[3/4] extracting keyframes", file=sys.stderr)
        frames = extract_keyframes(video_path, ffmpeg_exe, frames_dir)
        print(f"  {len(frames)} keyframes", file=sys.stderr)

        print("[4/4] assembling markdown", file=sys.stderr)
        md_path = assemble_markdown(info, transcription, frames, out_root, url)

    print(
        json.dumps(
            {
                "ok": True,
                "markdown_path": str(md_path).replace("\\", "/"),
                "frames": len(frames),
                "duration_seconds": float(transcription.get("duration") or 0),
                "title": title,
                "slug": slug,
            }
        )
    )


if __name__ == "__main__":
    main()
