"""
voice_handler.py — BhashaBridge Layer-6 Voice Interface (STT + TTS Config & Backend Transcription)

Features:
  1. Detailed Language Voice Config:
     Annotates all 22 scheduled Indian languages + English with:
       - voice_supported (bool): True if reliable browser/Whisper STT/TTS exists.
       - bcp47_code (str): Standard locale code (e.g. "hi-IN", "te-IN", "en-IN").
       - stt_supported (bool): True if speech recognition is active.
       - tts_supported (bool): True if speech synthesis is active.

  2. Groq Whisper STT Integration:
     Server-side fallback speech-to-text using Groq's whisper-large-v3-turbo model
     when Web Speech API is unavailable or audio blob is recorded.

  3. Voice Support Checker:
     Returns voice capabilities per language code for the frontend UI.
"""

from __future__ import annotations

import io
import logging
import os
from typing import Any, Optional

from groq import Groq

log = logging.getLogger(__name__)

# Complete Master Language Config with explicit Voice Support Flags
LANGUAGES_VOICE_MASTER = [
    {"code": "en",  "name": "English",    "native": "English",  "voice_supported": True,  "bcp47_code": "en-IN", "stt_supported": True,  "tts_supported": True},
    {"code": "hi",  "name": "Hindi",      "native": "हिन्दी",   "voice_supported": True,  "bcp47_code": "hi-IN", "stt_supported": True,  "tts_supported": True},
    {"code": "te",  "name": "Telugu",     "native": "తెలుగు",   "voice_supported": True,  "bcp47_code": "te-IN", "stt_supported": True,  "tts_supported": True},
    {"code": "ta",  "name": "Tamil",      "native": "தமிழ்",    "voice_supported": True,  "bcp47_code": "ta-IN", "stt_supported": True,  "tts_supported": True},
    {"code": "bn",  "name": "Bengali",    "native": "বাংলা",    "voice_supported": True,  "bcp47_code": "bn-IN", "stt_supported": True,  "tts_supported": True},
    {"code": "mr",  "name": "Marathi",    "native": "मराठी",    "voice_supported": True,  "bcp47_code": "mr-IN", "stt_supported": True,  "tts_supported": True},
    {"code": "gu",  "name": "Gujarati",   "native": "ગુજરાતી",  "voice_supported": True,  "bcp47_code": "gu-IN", "stt_supported": True,  "tts_supported": True},
    {"code": "kn",  "name": "Kannada",    "native": "ಕನ್ನಡ",    "voice_supported": True,  "bcp47_code": "kn-IN", "stt_supported": True,  "tts_supported": True},
    {"code": "ml",  "name": "Malayalam",  "native": "മലയാളം",  "voice_supported": True,  "bcp47_code": "ml-IN", "stt_supported": True,  "tts_supported": True},
    {"code": "pa",  "name": "Punjabi",    "native": "ਪੰਜਾਬੀ",   "voice_supported": True,  "bcp47_code": "pa-IN", "stt_supported": True,  "tts_supported": True},
    {"code": "or",  "name": "Odia",       "native": "ଓଡ଼ିଆ",    "voice_supported": True,  "bcp47_code": "or-IN", "stt_supported": True,  "tts_supported": True},
    {"code": "ur",  "name": "Urdu",       "native": "اردو",     "voice_supported": True,  "bcp47_code": "ur-IN", "stt_supported": True,  "tts_supported": True},

    # Languages without reliable web STT/TTS models -> voice_supported: False
    {"code": "mai", "name": "Maithili",   "native": "मैथिली",   "voice_supported": False, "bcp47_code": "hi-IN", "stt_supported": False, "tts_supported": False},
    {"code": "kok", "name": "Konkani",    "native": "कोंकणी",   "voice_supported": False, "bcp47_code": "kok-IN","stt_supported": False, "tts_supported": False},
    {"code": "ne",  "name": "Nepali",     "native": "नेपाली",   "voice_supported": True,  "bcp47_code": "ne-NP", "stt_supported": True,  "tts_supported": True},
    {"code": "ks",  "name": "Kashmiri",   "native": "كٲشُر",   "voice_supported": False, "bcp47_code": "ks-IN", "stt_supported": False, "tts_supported": False},
    {"code": "sd",  "name": "Sindhi",     "native": "سنڌي",    "voice_supported": False, "bcp47_code": "sd-IN", "stt_supported": False, "tts_supported": False},
    {"code": "dog", "name": "Dogri",      "native": "डोगरी",   "voice_supported": False, "bcp47_code": "hi-IN", "stt_supported": False, "tts_supported": False},
    {"code": "bodo","name": "Bodo",       "native": "बड़ो",     "voice_supported": False, "bcp47_code": "hi-IN", "stt_supported": False, "tts_supported": False},
    {"code": "mni", "name": "Manipuri",   "native": "মৈতৈলোন্", "voice_supported": False, "bcp47_code": "mni-IN","stt_supported": False, "tts_supported": False},
    {"code": "sa",  "name": "Sanskrit",   "native": "संस्कृत",  "voice_supported": False, "bcp47_code": "sa-IN", "stt_supported": False, "tts_supported": False},
]

# Quick lookup map
LANG_VOICE_MAP = {lang["code"]: lang for lang in LANGUAGES_VOICE_MASTER}


def is_voice_supported(language_code: str) -> bool:
    """Returns True if the given language code has reliable STT/TTS support."""
    config = LANG_VOICE_MAP.get(language_code, {})
    return config.get("voice_supported", False)


def get_bcp47_code(language_code: str) -> str:
    """Returns standard BCP-47 locale tag (e.g. 'hi-IN')."""
    config = LANG_VOICE_MAP.get(language_code, {})
    return config.get("bcp47_code", "en-IN")


def transcribe_audio_groq(audio_file_bytes: bytes, filename: str = "speech.wav", language_code: Optional[str] = None) -> str:
    """
    Transcribes audio using Groq Whisper (whisper-large-v3-turbo).
    """
    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        raise ValueError("GROQ_API_KEY is not configured for Whisper STT.")

    client = Groq(api_key=api_key)

    # Use BytesIO with a named attribute so Groq client recognizes the file tuple
    file_tuple = (filename, audio_file_bytes, "audio/wav")

    log.info("Sending audio blob (%d bytes) to Groq Whisper...", len(audio_file_bytes))

    kwargs = {
        "model": "whisper-large-v3-turbo",
        "file": file_tuple,
        "response_format": "json",
    }
    if language_code and language_code in LANG_VOICE_MAP:
        kwargs["language"] = language_code

    try:
        transcription = client.audio.transcriptions.create(**kwargs)
        text = getattr(transcription, "text", str(transcription)).strip()
        log.info("Whisper transcription success: '%s'", text)
        return text
    except Exception as exc:
        log.error("Groq Whisper STT error: %s", exc)
        raise RuntimeError(f"Whisper STT failed: {exc}") from exc
