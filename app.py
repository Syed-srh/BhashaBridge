from dotenv import load_dotenv


import os
import io
import json
import sqlite3
from datetime import datetime
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from dotenv import load_dotenv
import pytesseract
from PIL import Image
import pdfplumber
import requests
from bs4 import BeautifulSoup
from groq import Groq

load_dotenv()

app = Flask(__name__)
CORS(app)

# --- Config ---
DB_PATH = "db/results.db"
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")



# Tesseract path for Windows — adjust if yours is different
pytesseract.pytesseract.tesseract_cmd = os.getenv(
    "TESSERACT_PATH",
    r"C:\Program Files\Tesseract-OCR\tesseract.exe"
)

# Database setup

def init_db():
    os.makedirs("db", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS results (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source      TEXT,
            language    TEXT,
            simplified_text TEXT,
            eligibility TEXT,
            documents   TEXT,
            benefit     TEXT,
            how_to_apply TEXT,
            created_at  TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.commit()
    conn.close()

init_db()

# Language list — all 22 scheduled languages + English

LANGUAGES = [
    {"code": "en",  "name": "English",    "native": "English"},
    {"code": "hi",  "name": "Hindi",      "native": "हिन्दी"},
    {"code": "te",  "name": "Telugu",     "native": "తెలుగు"},
    {"code": "ta",  "name": "Tamil",      "native": "தமிழ்"},
    {"code": "bn",  "name": "Bengali",    "native": "বাংলা"},
    {"code": "mr",  "name": "Marathi",    "native": "मराठी"},
    {"code": "gu",  "name": "Gujarati",   "native": "ગુજરાતી"},
    {"code": "kn",  "name": "Kannada",    "native": "ಕನ್ನಡ"},
    {"code": "ml",  "name": "Malayalam",  "native": "മലയാളം"},
    {"code": "pa",  "name": "Punjabi",    "native": "ਪੰਜਾਬੀ"},
    {"code": "or",  "name": "Odia",       "native": "ଓଡ଼ିଆ"},
    {"code": "as",  "name": "Assamese",   "native": "অসমীয়া"},
    {"code": "ur",  "name": "Urdu",       "native": "اردو"},
    {"code": "mai", "name": "Maithili",   "native": "मैथिली"},
    {"code": "kok", "name": "Konkani",    "native": "कोंकणी"},
    {"code": "ne",  "name": "Nepali",     "native": "नेपाली"},
    {"code": "ks",  "name": "Kashmiri",   "native": "كٲشُر"},
    {"code": "sd",  "name": "Sindhi",     "native": "سنڌي"},
    {"code": "dog", "name": "Dogri",      "native": "डोगरी"},
    {"code": "bodo","name": "Bodo",       "native": "बड़ो"},
    {"code": "mni", "name": "Manipuri",   "native": "মৈতৈলোন্"},
    {"code": "sa",  "name": "Sanskrit",   "native": "संस्कृत"},
]

LANGUAGE_NAME_MAP = {lang["code"]: lang["name"] for lang in LANGUAGES}

# Text extraction helpers

def extract_from_pdf(file_bytes: bytes) -> str:
    """
    Tries pdfplumber first (works great for text-based PDFs).
    If the PDF is scanned / image-only and yields < 100 chars, falls back
    to running pytesseract on each page rendered as an image.
    """
    text_parts = []
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)

    combined = "\n".join(text_parts).strip()

    # If we barely got anything, the PDF is probably scanned
    if len(combined) < 100:
        try:
            from pdf2image import convert_from_bytes
            images = convert_from_bytes(file_bytes, dpi=200)
            ocr_parts = []
            for img in images:
                ocr_parts.append(pytesseract.image_to_string(img, lang="eng+hin"))
            combined = "\n".join(ocr_parts).strip()
        except Exception:
            # pdf2image not installed or tesseract not available — just return what we have
            pass

    return combined


def extract_from_image(file_bytes: bytes) -> str:
    """
    Runs Tesseract OCR on the uploaded image.
    We try English + Hindi together so mixed-language pamphlets work better.
    """
    img = Image.open(io.BytesIO(file_bytes))
    # Convert to RGB if needed (PNG with alpha channels can confuse Tesseract)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    text = pytesseract.image_to_string(img, lang="eng+hin")
    return text.strip()


def scrape_from_url(url: str) -> str:
    """
    Fetches a government portal URL and pulls the main body text.
    Strips nav bars, footers, scripts so the LLM only sees the content.
    """
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        )
    }
    resp = requests.get(url, headers=headers, timeout=20)
    resp.raise_for_status()

    soup = BeautifulSoup(resp.content, "html.parser")

    # Remove clutter
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "noscript"]):
        tag.decompose()

    text = soup.get_text(separator="\n", strip=True)
    lines = [line.strip() for line in text.splitlines() if len(line.strip()) > 20]

    # Limit to first 600 meaningful lines — enough for any scheme page
    return "\n".join(lines[:600])

# LLM call —  main task of BhashaBridge

def simplify_with_llm(raw_text: str, language_code: str) -> dict:
    """
    Sends the extracted scheme text to Groq (llama-3.3-70b-versatile).

    The prompt is carefully designed so the model:
    1. Extracts the four things a citizen actually needs to know
    2. Rewrites everything at a Class-5 reading level
    3. Translates the entire output into the chosen language

    Returns a dict with: eligibility, documents, benefit, how_to_apply, simplified_text
    """
    if not GROQ_API_KEY:
        raise ValueError(
            "GROQ_API_KEY is not set. Please add it to your .env file."
        )

    client = Groq(api_key=GROQ_API_KEY)
    language_name = LANGUAGE_NAME_MAP.get(language_code, "English")

    system_prompt = f"""You are BhashaBridge. Your purpose is to help ordinary Indian citizens — 
many of whom have studied only till Class 5 — understand government welfare schemes.

A person from a rural village is going to read what you write. 
They may not know English. They may not know big words.
They need to know: Am I eligible? What do I need to bring? What will I get? Where do I go?

Your rules:
- Write as if you are a trusted friend explaining things, not a government officer.
- Use the simplest possible words. Short sentences only.
- Be warm. Be encouraging. This information could genuinely change their life.
- Translate EVERYTHING you write into {language_name}. Every single word.
- If the document does not clearly mention something, say "This information was not clear in the document."

Return ONLY a valid JSON object with exactly these five keys:
{{
  "eligibility": "<Who can get this? 2-4 simple sentences in {language_name}>",
  "documents": "<What papers to bring? A simple list in {language_name}>",
  "benefit": "<What will they get? Money, help, or services? In {language_name}>",
  "how_to_apply": "<Step by step — where to go, what to do. In {language_name}>",
  "simplified_text": "<4-6 sentence plain-language summary of the whole scheme. In {language_name}>"
}}

Return nothing else. Only the JSON."""

    user_prompt = f"""Here is the government scheme document:

---
{raw_text[:5500]}
---

Please extract and explain this in simple {language_name}."""

    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ],
        temperature=0.25,   # Low temp = consistent, factual output
        max_tokens=2048,
    )

    raw_output = response.choices[0].message.content.strip()

    # Sometimes the model wraps JSON in a code fence — handle that
    if raw_output.startswith("```"):
        lines = raw_output.splitlines()
        raw_output = "\n".join(lines[1:-1])  # strip first and last lines

    return json.loads(raw_output)

# Routes
@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/languages", methods=["GET"])
def get_languages():
    return jsonify(LANGUAGES)


@app.route("/api/process", methods=["POST"])
def process_document():
    """Main endpoint. Accepts a file upload or a URL, returns structured JSON."""

    language = request.form.get("language", "en").strip()
    raw_text = ""
    source_name = ""

    # Path 1: URL was provided
    url = request.form.get("url", "").strip()
    if url:
        try:
            raw_text = scrape_from_url(url)
            source_name = url
        except requests.RequestException as e:
            return jsonify({"error": f"Could not open that link. Please check the URL and try again. ({str(e)})"}), 400

    # Path 2: File was uploaded
    elif "file" in request.files:
        file = request.files["file"]
        if file.filename == "":
            return jsonify({"error": "Please select a file before clicking upload."}), 400

        file_bytes = file.read()
        source_name = file.filename
        fname_lower = file.filename.lower()

        try:
            if fname_lower.endswith(".pdf"):
                raw_text = extract_from_pdf(file_bytes)
            elif fname_lower.endswith((".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".webp")):
                raw_text = extract_from_image(file_bytes)
            else:
                return jsonify({"error": "Please upload a PDF or an image file (JPG, PNG, etc.)"}), 400
        except Exception as e:
            return jsonify({"error": f"Could not read the file: {str(e)}"}), 400

    else:
        return jsonify({"error": "Please upload a document or paste a link."}), 400

    # Sanity check — make sure we got enough text to work with
    if len(raw_text.strip()) < 80:
        return jsonify({
            "error": (
                "We could not read enough text from this document. "
                "If it's a scanned image, try uploading a clearer photo. "
                "If it's a PDF, make sure it's not password-protected."
            )
        }), 400

    # Call the LLM
    try:
        result = simplify_with_llm(raw_text, language)
    except ValueError as e:
        # Missing API key
        return jsonify({"error": str(e)}), 500
    except json.JSONDecodeError:
        return jsonify({"error": "The AI had a hiccup processing this document. Please try once more."}), 500
    except Exception as e:
        return jsonify({"error": f"Something went wrong on our end: {str(e)}"}), 500

    # Save to database
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            """
            INSERT INTO results
                (source, language, simplified_text, eligibility, documents, benefit, how_to_apply)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source_name,
                language,
                result.get("simplified_text", ""),
                result.get("eligibility", ""),
                result.get("documents", ""),
                result.get("benefit", ""),
                result.get("how_to_apply", ""),
            ),
        )
        conn.commit()
    except Exception:
        pass  # Don't let DB errors break the response
    finally:
        conn.close()

    return jsonify({
        "success":       True,
        "source":        source_name,
        "language":      language,
        "eligibility":   result.get("eligibility", ""),
        "documents":     result.get("documents", ""),
        "benefit":       result.get("benefit", ""),
        "how_to_apply":  result.get("how_to_apply", ""),
        "simplified_text": result.get("simplified_text", ""),
    })


@app.route("/api/history", methods=["GET"])
def get_history():
    """Returns the last 20 processed documents from the database."""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM results ORDER BY created_at DESC LIMIT 20"
        ).fetchall()
        conn.close()
        return jsonify([dict(row) for row in rows])
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Run

if __name__ == "__main__":
    print("\nBhashaBridge is starting...")
    print("   Open http://localhost:5000 in your browser")
    print("   Press Ctrl+C to stop\n")

    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 5000)),
        debug=True,
        use_reloader=False
    )