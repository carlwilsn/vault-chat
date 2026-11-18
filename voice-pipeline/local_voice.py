"""The local voice: Kokoro TTS (voice af_heart) and Whisper STT, on this machine, free, no key.

Models are fetched once, on first need, into VC_VOICE_MODELS (the app's data dir; default ~/.cache/vault-chat/voice-models),
with progress as "[voice models] ..." lines on stdout. Loaded models are shared by every call of this process.

  Kokoro   kokoro-onnx v1.0 (kokoro-v1.0.onnx 326 MB + voices-v1.0.bin 28 MB, Apache-2.0); voice VC_KOKORO_VOICE (af_heart).
  Whisper  faster-whisper (CTranslate2, CPU int8) with Systran/faster-whisper-base.en (139 MB) by default; VC_WHISPER_MODEL
           names another CTranslate2 repo (e.g. Systran/faster-distil-whisper-medium.en). On Apple silicon: mlx-whisper with
           mlx-community/whisper-base.en-mlx (VC_WHISPER_MLX_MODEL).

The packages come from requirements-local.txt (pipecat-ai[kokoro,whisper] / [mlx-whisper]); nothing here is imported
until a call speaks locally, so an install that only uses ElevenLabs never loads them.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import platform
import sys
import threading
import time
import urllib.request
from pathlib import Path

MODELS = Path(os.environ.get("VC_VOICE_MODELS") or Path.home() / ".cache" / "vault-chat" / "voice-models")
KOKORO_VOICE = os.environ.get("VC_KOKORO_VOICE", "af_heart")
KOKORO_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
KOKORO_FILES = {"kokoro-v1.0.onnx": 325_532_387, "voices-v1.0.bin": 28_214_398}
WHISPER_REPO = os.environ.get("VC_WHISPER_MODEL", "Systran/faster-whisper-base.en")
WHISPER_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
WHISPER_MLX_REPO = os.environ.get("VC_WHISPER_MLX_MODEL", "mlx-community/whisper-base.en-mlx")
MLX = sys.platform == "darwin" and platform.machine() == "arm64"

_lock = threading.Lock()
_state: dict[str, str] = {"kokoro": "absent", "whisper": "absent"}
_kokoro = None
_whisper = None


def say(line: str) -> None:
    print(f"[voice models] {line}", flush=True)


def status() -> dict:
    return {**_state, "packages": missing_packages() or "installed", "stt": "mlx-whisper" if MLX else "faster-whisper"}


def missing_packages() -> str:
    """The local voice's packages not importable here ("" when all are)."""
    importlib.invalidate_caches()  # installed after this process started (the server's lazy install)
    need = ["kokoro_onnx", "mlx_whisper" if MLX else "faster_whisper"]
    return ", ".join(n for n in need if importlib.util.find_spec(n) is None)


def fetch(url: str, dest: Path, size_hint: int | None = None) -> None:
    """Download url to dest (once: an existing file is kept), via dest.part, logging every 10%."""
    if dest.exists():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    say(f"downloading {dest.name} from {url}")
    t0 = time.monotonic()
    with urllib.request.urlopen(url, timeout=60) as r, open(part, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0) or size_hint or 0
        got, shown = 0, -1
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                pct = got * 100 // total
                if pct // 10 > shown:
                    shown = pct // 10
                    say(f"{dest.name} {pct}% ({got >> 20}/{total >> 20} MB)")
    part.rename(dest)
    say(f"{dest.name} done ({got >> 20} MB in {time.monotonic() - t0:.1f} s)")


def kokoro_paths() -> tuple[Path, Path]:
    d = MODELS / "kokoro-v1.0"
    return d / "kokoro-v1.0.onnx", d / "voices-v1.0.bin"


def whisper_dir() -> Path:
    return MODELS / "whisper" / WHISPER_REPO.replace("/", "--")


def _load_kokoro():
    global _kokoro
    if _kokoro is not None:
        return _kokoro
    _state["kokoro"] = "downloading"
    model, voices = kokoro_paths()
    for p in (model, voices):
        fetch(KOKORO_BASE + p.name, p, KOKORO_FILES[p.name])
    _state["kokoro"] = "loading"
    from kokoro_onnx import Kokoro

    k = Kokoro(str(model), str(voices))
    if KOKORO_VOICE not in k.voices:
        raise ValueError(f"Kokoro voice {KOKORO_VOICE!r} is not in voices-v1.0.bin")
    k.create("Ready.", voice=KOKORO_VOICE, speed=1.0, lang="en-us")  # warm up: the first real reply starts at speed
    _kokoro = k
    _state["kokoro"] = "ready"
    say(f"kokoro ready (voice {KOKORO_VOICE})")
    return k


def _load_whisper():
    global _whisper
    if _whisper is not None:
        return _whisper
    if MLX:
        # mlx-whisper loads (and fetches through the Hugging Face cache) on first transcription: keep that cache here.
        os.environ.setdefault("HF_HOME", str(MODELS / "hf"))
        _whisper = WHISPER_MLX_REPO
        _state["whisper"] = "ready"
        return _whisper
    _state["whisper"] = "downloading"
    d = whisper_dir()
    for name in WHISPER_FILES:
        fetch(f"https://huggingface.co/{WHISPER_REPO}/resolve/main/{name}", d / name)
    _state["whisper"] = "loading"
    from faster_whisper import WhisperModel

    _whisper = WhisperModel(str(d), device="cpu", compute_type="int8")
    _state["whisper"] = "ready"
    say(f"whisper ready ({WHISPER_REPO}, cpu int8)")
    return _whisper


def ensure(stt: bool = True, tts: bool = True) -> None:
    """Download and load what a call needs (blocking; run it in a thread). Raises on failure (said in status())."""
    with _lock:
        for name, want, load in (("kokoro", tts, _load_kokoro), ("whisper", stt, _load_whisper)):
            if not want:
                continue
            try:
                load()
            except Exception as e:
                _state[name] = f"failed: {type(e).__name__}"
                say(f"{name} failed: {type(e).__name__}: {str(e)[:200]}")
                raise


def prefetch() -> None:
    if missing_packages():
        say(f"not prefetching: packages missing ({missing_packages()})")
        return
    try:
        ensure(True, True)
    except Exception:
        pass


def tts(**kwargs):
    """A Kokoro TTS service on the shared, loaded model (call ensure() first)."""
    from pipecat.services.kokoro import tts as kt

    k = _load_kokoro()
    model, voices = kokoro_paths()
    # The service loads its own Kokoro per instance (seconds): hand it the shared one instead.
    kt._ensure_model_files = lambda *_a: None
    kt.Kokoro = lambda *_a, **_k: k
    return kt.KokoroTTSService(
        model_path=str(model),
        voices_path=str(voices),
        settings=kt.KokoroTTSService.Settings(voice=KOKORO_VOICE),
        **kwargs,
    )


def stt(**kwargs):
    """A Whisper STT service (faster-whisper on the shared model; mlx-whisper on Apple silicon)."""
    from pipecat.services.whisper import stt as ws
    from pipecat.transcriptions.language import Language

    model = _load_whisper()
    if MLX:
        return ws.WhisperSTTServiceMLX(settings=ws.WhisperSTTServiceMLX.Settings(model=model, language=Language.EN), **kwargs)

    class SharedWhisper(ws.WhisperSTTService):
        def _load(self):
            self._model = model

    return SharedWhisper(settings=ws.WhisperSTTService.Settings(model=str(whisper_dir()), language=Language.EN), device="cpu", compute_type="int8", **kwargs)
