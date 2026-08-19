"""
ingestion.py — BhashaBridge Layer-1 Ingestion Pipeline


Accepts a document from one of three sources and returns a normalised
IngestResult carrying:
  • clean text (deduplicated whitespace, non-printable chars removed)
  • source_type  : "text_pdf" | "scanned_pdf" | "image" | "url"
  • page_count   : int  (1 for images/URLs)
  • detected_language : ISO 639-1 code ("en", "hi", …) or "unknown"
  • char_count   : int

Public API
----------
  ingest_bytes(file_bytes, filename)  → IngestResult
  ingest_url(url)                     → IngestResult

Both raise IngestionError on unrecoverable failures.
"""

from __future__ import annotations

import io
import logging
import os
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Optional

import pdfplumber
import pytesseract
import requests
from PIL import Image

# ── Optional / gracefully-degraded deps 
try:
    from pdf2image import convert_from_bytes as _pdf2img
    _PDF2IMAGE_OK = True
except ImportError:
    _PDF2IMAGE_OK = False

try:
    from langdetect import detect as _lang_detect, LangDetectException
    _LANGDETECT_OK = True
except ImportError:
    _LANGDETECT_OK = False

try:
    import trafilatura
    _TRAFILATURA_OK = True
except ImportError:
    _TRAFILATURA_OK = False

from bs4 import BeautifulSoup

# ── Tesseract path (Windows) ─────────────────────────────────────────────────
pytesseract.pytesseract.tesseract_cmd = os.getenv(
    "TESSERACT_PATH",
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
)

# Tesseract language pack: covers most Indian languages with standard tessdata.
# Tesseract silently skips any lang code whose .traineddata file is absent.
_TESS_LANGS = "eng+hin+ben+tam+tel+kan+mal+mar+guj+pan+ori+asm"

log = logging.getLogger(__name__)

# ── Result dataclass ─────────────────────────────────────────────────────────

@dataclass
class IngestResult:
    text: str
    source_type: str          # "text_pdf" | "scanned_pdf" | "image" | "url"
    page_count: int = 1
    detected_language: str = "unknown"
    char_count: int = field(init=False)
    metadata: dict = field(default_factory=dict)

    def __post_init__(self):
        self.char_count = len(self.text)

    def is_usable(self) -> bool:
        """True when we extracted enough text for the LLM to work with."""
        return self.char_count >= 80


class IngestionError(Exception):
    """Raised when ingestion cannot produce usable text."""


# ── Public entry points ──────────────────────────────────────────────────────

def ingest_bytes(file_bytes: bytes, filename: str) -> IngestResult:
    """
    Route the uploaded file to the correct extractor.

    Decision tree:
      filename ends with .pdf           ->  _ingest_pdf()
      filename ends with image extension ->  _ingest_image()
      anything else                      ->  IngestionError
    """
    fname = filename.lower().strip()

    if fname.endswith(".pdf"):
        return _ingest_pdf(file_bytes, filename)

    image_exts = (".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp", ".gif")
    if any(fname.endswith(ext) for ext in image_exts):
        return _ingest_image(file_bytes, filename)

    raise IngestionError(
        f"Unsupported file type '{filename}'. "
        "Please upload a PDF or an image (JPG, PNG, etc.)."
    )


def ingest_url(url: str) -> IngestResult:
    """
    Fetch a URL and extract its main article body.
    Returns an IngestResult with source_type='url'.
    """
    return _ingest_url(url)


# ── PDF ingestion ─────────────────────────────────────────────────────────────

# Heuristic: fewer than this many chars/page on average => likely scanned PDF
_TEXT_PDF_MIN_CHARS_PER_PAGE = 80


def _ingest_pdf(file_bytes: bytes, filename: str) -> IngestResult:
    """
    Two-pass PDF extraction.

    Pass 1 -- pdfplumber (native text layer)
      Fast; preserves structure; works for digitally-created PDFs.

    Pass 2 -- Tesseract OCR via pdf2image (fallback for scanned PDFs)
      Renders each page as a 300-DPI image and runs OCR.
      Only triggered when Pass 1 yields < threshold chars/page on average.
    """
    text_parts: list[str] = []
    page_count = 0

    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        page_count = len(pdf.pages)
        for page in pdf.pages:
            raw = page.extract_text() or ""
            if raw.strip():
                text_parts.append(raw)

    native_text = _normalise(_join(text_parts))
    avg_chars = len(native_text) / max(page_count, 1)

    # ── Case A: Good text layer ───────────────────────────────────────────
    if avg_chars >= _TEXT_PDF_MIN_CHARS_PER_PAGE:
        lang = _detect_language(native_text)
        return IngestResult(
            text=native_text,
            source_type="text_pdf",
            page_count=page_count,
            detected_language=lang,
            metadata={"filename": filename, "avg_chars_per_page": round(avg_chars)},
        )

    # ── Case B: Scanned / image-only PDF ─────────────────────────────────
    log.info(
        "PDF '%s' yielded only %.0f chars/page avg -- routing to OCR.",
        filename, avg_chars,
    )

    if not _PDF2IMAGE_OK:
        if native_text:
            return IngestResult(
                text=native_text,
                source_type="scanned_pdf",
                page_count=page_count,
                detected_language=_detect_language(native_text),
                metadata={"filename": filename, "ocr": False,
                          "note": "pdf2image not installed; OCR skipped"},
            )
        raise IngestionError(
            "This appears to be a scanned PDF but pdf2image is not installed. "
            "Run: pip install pdf2image"
        )

    ocr_parts: list[str] = []
    try:
        images = _pdf2img(file_bytes, dpi=300)
        for img in images:
            ocr_parts.append(_ocr_image(img))
    except Exception as exc:
        log.warning("pdf2image/OCR failed for '%s': %s", filename, exc)
        if native_text:
            return IngestResult(
                text=native_text,
                source_type="scanned_pdf",
                page_count=page_count,
                detected_language=_detect_language(native_text),
                metadata={"filename": filename, "ocr": False, "ocr_error": str(exc)},
            )
        raise IngestionError(f"Could not read this scanned PDF: {exc}") from exc

    ocr_text = _normalise(_join(ocr_parts))
    if not ocr_text:
        raise IngestionError(
            "OCR produced no readable text from this PDF. "
            "Try uploading a clearer scan."
        )

    lang = _detect_language(ocr_text)
    return IngestResult(
        text=ocr_text,
        source_type="scanned_pdf",
        page_count=page_count,
        detected_language=lang,
        metadata={"filename": filename, "ocr": True, "dpi": 300},
    )


# ── Image ingestion ───────────────────────────────────────────────────────────

def _ingest_image(file_bytes: bytes, filename: str) -> IngestResult:
    """
    Pre-processes the image for best OCR accuracy, then runs Tesseract.

    Pre-processing steps (in order):
      1. Convert to RGB  -- strips alpha channels that confuse Tesseract
      2. Upscale small images to at least 1200px on the short side
         (Tesseract accuracy drops significantly below ~150 DPI equivalent)
      3. Convert to greyscale -- faster, often more accurate for text
    """
    try:
        img = Image.open(io.BytesIO(file_bytes))
    except Exception as exc:
        raise IngestionError(f"Could not open the image file: {exc}") from exc

    orig_size = (img.width, img.height)

    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    min_side = min(img.width, img.height)
    if min_side < 1200:
        scale = 1200 / min_side
        img = img.resize(
            (int(img.width * scale), int(img.height * scale)),
            Image.LANCZOS,
        )

    img_grey = img.convert("L")
    ocr_text = _normalise(_ocr_image(img_grey))

    if not ocr_text:
        raise IngestionError(
            "We could not read any text from this image. "
            "Please try a clearer photo with the text well-lit and in focus."
        )

    lang = _detect_language(ocr_text)
    return IngestResult(
        text=ocr_text,
        source_type="image",
        page_count=1,
        detected_language=lang,
        metadata={"filename": filename, "original_size": orig_size},
    )


# ── URL ingestion ─────────────────────────────────────────────────────────────

_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

_NOISE_TAGS = [
    "script", "style", "nav", "footer", "header", "aside",
    "noscript", "form", "button", "meta", "iframe", "svg",
]

_BOILERPLATE_PATTERN = re.compile(
    r"(menu|navbar|sidebar|breadcrumb|footer|cookie|banner|"
    r"subscribe|social|share|related|comment|advertisement)",
    re.IGNORECASE,
)


def _ingest_url(url: str) -> IngestResult:
    """
    Two-strategy URL extraction.

    Strategy 1: trafilatura (if installed)
      Purpose-built article extractor; handles complex layouts well.

    Strategy 2: BeautifulSoup fallback
      Strips noise tags and boilerplate containers, keeps lines > 20 chars,
      limits to 700 lines.
    """
    try:
        resp = requests.get(url, headers=_HTTP_HEADERS, timeout=25)
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise IngestionError(
            f"Could not fetch '{url}'. Check the URL and try again. ({exc})"
        ) from exc

    html = resp.text
    content_url = resp.url  # final URL after any redirects

    # ── Strategy 1: trafilatura ───────────────────────────────────────────
    if _TRAFILATURA_OK:
        extracted = trafilatura.extract(
            html,
            include_comments=False,
            include_tables=True,
            no_fallback=False,
            favor_recall=True,
        )
        if extracted and len(extracted.strip()) >= 200:
            text = _normalise(extracted)
            return IngestResult(
                text=text,
                source_type="url",
                page_count=1,
                detected_language=_detect_language(text),
                metadata={"url": content_url, "extractor": "trafilatura"},
            )

    # ── Strategy 2: BeautifulSoup fallback ───────────────────────────────
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup(_NOISE_TAGS):
        tag.decompose()

    for el in soup.find_all(True):
        classes = " ".join(el.get("class", []))
        eid = el.get("id", "")
        if _BOILERPLATE_PATTERN.search(classes) or _BOILERPLATE_PATTERN.search(eid):
            el.decompose()

    candidate = _find_main_content(soup)
    raw_text = (
        candidate.get_text(separator="\n", strip=True)
        if candidate
        else soup.get_text(separator="\n", strip=True)
    )

    lines = [ln.strip() for ln in raw_text.splitlines() if len(ln.strip()) > 20]
    text = _normalise("\n".join(lines[:700]))

    if not text:
        raise IngestionError(
            "Could not extract any meaningful text from that URL. "
            "The page may require login or be JavaScript-rendered."
        )

    return IngestResult(
        text=text,
        source_type="url",
        page_count=1,
        detected_language=_detect_language(text),
        metadata={"url": content_url, "extractor": "beautifulsoup"},
    )


def _find_main_content(soup):
    """
    Heuristic: prefer <main> / <article> tags; fall back to the largest
    <div> or <section> by text length.
    """
    for tag_name in ("main", "article"):
        el = soup.find(tag_name)
        if el:
            return el

    best, best_len = None, 0
    for el in soup.find_all(["div", "section"]):
        length = len(el.get_text())
        if length > best_len:
            best_len = length
            best = el
    return best


# ── OCR helper ────────────────────────────────────────────────────────────────

def _ocr_image(img: Image.Image) -> str:
    """
    Attempts multi-language OCR first; falls back to eng+hin, then eng-only
    if the wider tessdata pack is not installed.
    """
    for lang_str in (_TESS_LANGS, "eng+hin", "eng"):
        try:
            return pytesseract.image_to_string(img, lang=lang_str)
        except pytesseract.TesseractError:
            continue
    return ""


# ── Language detection ────────────────────────────────────────────────────────

def _detect_language(text: str) -> str:
    """
    Returns ISO 639-1 language code (e.g. "en", "hi").
    Returns "unknown" if langdetect is not installed or detection fails.
    """
    if not _LANGDETECT_OK or not text:
        return "unknown"
    try:
        return _lang_detect(text[:1500])
    except LangDetectException:
        return "unknown"


# ── Text normalisation ────────────────────────────────────────────────────────

_MULTI_NEWLINE = re.compile(r"\n{3,}")
_MULTI_SPACE   = re.compile(r"[ \t]{2,}")


def _normalise(text: str) -> str:
    """
    1. Strip non-printable / control characters (keeps newlines and tabs)
    2. Collapse runs of 3+ blank lines to 2
    3. Collapse horizontal whitespace runs to a single space
    4. Strip leading/trailing whitespace
    """
    cleaned = "".join(
        ch for ch in text
        if ch in ("\n", "\t") or not unicodedata.category(ch).startswith("C")
    )
    cleaned = _MULTI_NEWLINE.sub("\n\n", cleaned)
    cleaned = _MULTI_SPACE.sub(" ", cleaned)
    return cleaned.strip()


def _join(parts: list[str]) -> str:
    return "\n\n".join(p.strip() for p in parts if p.strip())
