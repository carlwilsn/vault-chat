---
name: youtube
description: >
  Download a YouTube video and turn it into a vault reference doc — markdown
  with timestamped transcript and embedded scene-change keyframes. Output is
  written to <output_dir>/<auto-slug>/<auto-slug>.md plus a frames/ subdir.
  Pass an absolute vault path as output_dir (the vault root, or a subfolder
  like <vault>/youtube). Returns JSON {markdown_path, frames, duration_seconds, title, slug}.
input_schema:
  type: object
  properties:
    url:
      type: string
      description: YouTube URL (full youtube.com/watch?v=… or youtu.be/… form).
    output_dir:
      type: string
      description: Absolute vault path where the slug folder will be created.
  required: [url, output_dir]
  additionalProperties: false
requires_keys: [groq]
timeout_ms: 1200000
---

# youtube

Pipeline:
1. `yt-dlp` downloads audio (16kbps mono mp3) + lowest-resolution video stream.
2. Groq Whisper Large v3 Turbo transcribes with segment timestamps.
3. `ffmpeg` scene-change detection extracts keyframes (typically 30–80 for a 2-hour lecture; far fewer for short videos).
4. Assembles markdown: header (title, source, duration) + interleaved `[HH:MM:SS]` transcript chunks and `![](frames/HH-MM-SS.png)` images at scene boundaries.

Wall-clock for a 2-hour lecture is roughly 3–5 minutes (download + transcribe + extract). The 20-minute timeout in the frontmatter is the safety ceiling.

## Failure modes

- **Audio file exceeds 25MB** → Groq free-tier may reject. The script downsamples aggressively (16kbps mono) so a 2hr lecture is ~25MB. For very long videos (>3hr) this can fail; user must upgrade Groq tier or accept failure.
- **yt-dlp errors** usually mean the video is age-restricted, region-locked, private, or removed. Surface the original URL and yt-dlp's error message to the user.
- **No frames extracted** means the video has no detectable scene changes (e.g. a single static talking head with no slides). The transcript is still produced.

## Notes for the agent

- Frames are written next to the markdown; `![](frames/00-04-12.png)` paths in the markdown render in the vault's MarkdownView.
- The slug is auto-derived from the video title. If the user wants a specific slug, they should rename the folder afterward — this tool always uses the auto-slug.
- `output_dir` is a *parent*; the tool creates `<output_dir>/<slug>/` under it.
