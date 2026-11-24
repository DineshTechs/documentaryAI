"""Text-to-speech providers for the final narration voice."""
import shutil
import subprocess
import tempfile
from pathlib import Path

import requests

from . import db

TTS_PROVIDERS = {
    "espeak": "espeak-ng (free, robotic - scratch timing only)",
    "openai": "OpenAI TTS",
    "elevenlabs": "ElevenLabs",
}


def tts_settings():
    return db.get_setting("tts", {}) or {}


def _ffmpeg_convert(src: Path, dst: Path):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), str(dst)], check=True)


def synthesize(text: str, out_path: Path, voice: str | None = None, provider: str | None = None) -> str:
    s = tts_settings()
    provider = provider or s.get("provider") or "espeak"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp())
    try:
        if provider == "openai":
            key = s.get("openai_key") or ((db.get_setting("providers", {}) or {}).get("openai", {}) or {}).get("api_key")
            if not key:
                raise RuntimeError("OpenAI TTS needs an OpenAI API key (Settings > Voice).")
            r = requests.post("https://api.openai.com/v1/audio/speech",
                              headers={"authorization": f"Bearer {key}"},
                              json={"model": s.get("openai_model") or "gpt-4o-mini-tts",
                                    "voice": voice or s.get("openai_voice") or "onyx",
                                    "input": text, "response_format": "wav",
                                    **({"instructions": s["openai_instructions"]} if s.get("openai_instructions") else {})},
                              timeout=300)
            if r.status_code >= 400:
                raise RuntimeError(f"OpenAI TTS error {r.status_code}: {r.text[:400]}")
            raw = tmp / "a.wav"
            raw.write_bytes(r.content)
        elif provider == "elevenlabs":
            key = s.get("elevenlabs_key")
            vid = voice or s.get("elevenlabs_voice")
            if not key or not vid:
                raise RuntimeError("ElevenLabs needs an API key and a voice ID (Settings > Voice).")
            r = requests.post(f"https://api.elevenlabs.io/v1/text-to-speech/{vid}",
                              headers={"xi-api-key": key, "accept": "audio/mpeg"},
                              json={"text": text, "model_id": s.get("elevenlabs_model") or "eleven_multilingual_v2"},
                              timeout=300)
            if r.status_code >= 400:
                raise RuntimeError(f"ElevenLabs error {r.status_code}: {r.text[:400]}")
            raw = tmp / "a.mp3"
            raw.write_bytes(r.content)
        else:
            exe = shutil.which("espeak-ng") or shutil.which("espeak")
            if not exe:
                raise RuntimeError("espeak-ng is not installed on the server.")
            raw = tmp / "a.wav"
            subprocess.run([exe, "-v", voice or "en-us", "-s", "155", "-w", str(raw), text], check=True)

        if raw.suffix.lower() == out_path.suffix.lower():
            shutil.move(str(raw), out_path)
        else:
            _ffmpeg_convert(raw, out_path)
        return f"Wrote {out_path.name} with {provider}"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
