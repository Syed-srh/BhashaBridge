from dotenv import load_dotenv


import os
import io
import json
import sqlite3
from datetime import datetime
from flask import Flask, request, jsonify, render_template, Response, stream_with_context
from flask_cors import CORS
from dotenv import load_dotenv
import pytesseract
from PIL import Image
import pdfplumber
import requests
from bs4 import BeautifulSoup
from groq import Groq
from ingestion import ingest_bytes, ingest_url, IngestResult, IngestionError
from llm_pipeline import run_pipeline, extract_structured_fields, simplify, translate
from recommendation_engine import recommend_schemes, get_all_schemes
from eligibility_checker import evaluate_eligibility, build_action_guide
from voice_handler import LANGUAGES_VOICE_MASTER, is_voice_supported, get_bcp47_code, transcribe_audio_groq

load_dotenv()

app = Flask(__name__)
CORS(app)

# --- Config ---
DB_PATH = "db/results.db"
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "groq/compound")
FALLBACK_MODELS = [
    GROQ_MODEL,
    "groq/compound",
    "groq/compound-mini",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.6-27b",
    "llama-3.3-70b-versatile"
]



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
        CREATE TABLE IF NOT EXISTS uploaded_documents (
            id TEXT PRIMARY KEY,
            filename TEXT,
            file_type TEXT,
            url TEXT,
            page_count INTEGER DEFAULT 1,
            detected_language TEXT DEFAULT 'en',
            extraction_status TEXT DEFAULT 'completed',
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS feedback_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            result_id TEXT,
            stage TEXT,
            rating TEXT,
            comment TEXT,
            language TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS previously_explained (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT UNIQUE,
            source TEXT,
            language TEXT,
            scheme_name TEXT,
            simplified_text TEXT,
            eligibility TEXT,
            documents TEXT,
            benefit TEXT,
            how_to_apply TEXT,
            restrictions TEXT,
            citations TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT,
            language TEXT,
            simplified_text TEXT,
            eligibility TEXT,
            documents TEXT,
            benefit TEXT,
            how_to_apply TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.commit()
    conn.close()

init_db()
LANGUAGES = LANGUAGES_VOICE_MASTER
LANGUAGE_NAME_MAP = {lang["code"]: lang["name"] for lang in LANGUAGES}


# Routes
@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/languages", methods=["GET"])
def get_languages():
    """Returns languages list with voice_supported and bcp47_code flags."""
    return jsonify(LANGUAGES)


@app.route("/api/stt", methods=["POST"])
def speech_to_text():
    """
    Speech-to-Text Endpoint — transcribes audio blobs via Groq Whisper.
    Accepts: multipart audio file upload ("audio" or "file"), language (optional)
    """
    try:
        audio_file = request.files.get("audio") or request.files.get("file")
        language_code = request.form.get("language", "en")

        if not audio_file:
            return jsonify({"error": "No audio file uploaded."}), 400

        audio_bytes = audio_file.read()
        if len(audio_bytes) < 100:
            return jsonify({"error": "Audio recording was empty."}), 400

        text = transcribe_audio_groq(
            audio_file_bytes=audio_bytes,
            filename=audio_file.filename or "speech.wav",
            language_code=language_code
        )

        return jsonify({
            "success": True,
            "text": text,
            "language": language_code
        })
    except Exception as e:
        return jsonify({"error": f"Speech transcription error: {e}"}), 500





@app.route("/api/process", methods=["POST"])
def process_document():
    """Non-streaming endpoint (kept for compatibility). Returns structured JSON."""

    language = request.form.get("language", "en").strip()
    ingested: IngestResult | None = None

    url = request.form.get("url", "").strip()
    if url:
        try:
            ingested = ingest_url(url)
        except IngestionError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": f"Could not fetch that URL: {e}"}), 400

    elif "file" in request.files:
        f = request.files["file"]
        if not f or not f.filename:
            return jsonify({"error": "Please select a file before clicking upload."}), 400
        try:
            ingested = ingest_bytes(f.read(), f.filename)
        except IngestionError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": f"Could not read the file: {e}"}), 400
    else:
        return jsonify({"error": "Please upload a document or paste a link."}), 400

    if not ingested.is_usable():
        return jsonify({"error": (
            "We could not read enough text from this document. "
            "If it's a scanned image, try uploading a clearer photo. "
            "If it's a PDF, make sure it's not password-protected."
        )}), 400

    try:
        result = run_pipeline(ingested.text, language)
    except ValueError as e:
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        return jsonify({"error": f"Something went wrong on our end: {e}"}), 500

    source_name = ingested.metadata.get("url") or ingested.metadata.get("filename") or ""

    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            """
            INSERT INTO results
                (source, language, simplified_text, eligibility, documents, benefit, how_to_apply)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source_name, language,
                result.get("simplified_text", ""),
                result.get("eligibility",      ""),
                result.get("documents",        ""),
                result.get("benefit",          ""),
                result.get("how_to_apply",     ""),
            ),
        )
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()

    action_guide = build_action_guide(
        result.get("documents", ""),
        result.get("how_to_apply", "")
    )

    return jsonify({
        "success":            True,
        "source":             source_name,
        "source_type":        ingested.source_type,
        "page_count":         ingested.page_count,
        "detected_language":  ingested.detected_language,
        "language":           language,
        "scheme_name":        result.get("scheme_name",        ""),
        "simplified_text":    result.get("simplified_text",    ""),
        "eligibility":        result.get("eligibility",        ""),
        "benefit":            result.get("benefit",            ""),
        "documents":          result.get("documents",          ""),
        "how_to_apply":       result.get("how_to_apply",       ""),
        "restrictions":       result.get("restrictions",       ""),
        "action_guide":       action_guide,
        "citations":          result.get("citations",          {}),
        "overall_confidence": result.get("overall_confidence", "High Confidence"),
    })


@app.route("/api/evaluate-eligibility", methods=["POST"])
def evaluate_eligibility_route():
    """
    Granular per-criterion eligibility evaluation.
    Accepts: { "eligibility_text": "...", "profile": { "age": 30, "occupation": "farmer", ... } }
    """
    try:
        data = request.get_json(silent=True) or request.form
        eligibility_text = data.get("eligibility_text", "")
        profile = data.get("profile", {})

        eval_results = evaluate_eligibility(eligibility_text, profile)
        return jsonify({
            "success": True,
            "criteria_count": len(eval_results),
            "evaluations": eval_results,
        })
    except Exception as e:
        return jsonify({"error": f"Eligibility evaluation error: {e}"}), 500


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


@app.route("/api/feedback", methods=["GET", "POST"])
@app.route("/feedback", methods=["GET", "POST"])
def handle_feedback():
    """
    Feedback loop endpoint — logs thumbs up/down and optional comments,
    tagged with the specific pipeline stage (extraction, simplification, translation, eligibility, recommendation).
    """
    try:
        if request.method == "POST":
            data = request.get_json(silent=True) or request.form
            result_id = str(data.get("result_id", "scheme_explanation"))
            stage     = str(data.get("stage", "simplification"))
            rating    = str(data.get("rating", "up"))
            comment   = str(data.get("comment", "")).strip()
            language  = str(data.get("language", "en"))

            conn = sqlite3.connect(DB_PATH)
            conn.execute(
                """
                INSERT INTO feedback_logs (result_id, stage, rating, comment, language)
                VALUES (?, ?, ?, ?, ?)
                """,
                (result_id, stage, rating, comment, language)
            )
            # Duplicate to fallback table
            conn.execute(
                """
                INSERT INTO feedback (result_id, stage, rating, comment, language)
                VALUES (?, ?, ?, ?, ?)
                """,
                (result_id, stage, rating, comment, language)
            )
            conn.commit()
            conn.close()

            return jsonify({
                "success": True,
                "message": "Thank you for your feedback! It helps BhashaBridge improve."
            })
        else:
            # GET: return recent feedback for evaluation analysis
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            rows = conn.execute("SELECT * FROM feedback_logs ORDER BY created_at DESC LIMIT 50").fetchall()
            conn.close()
            return jsonify([dict(row) for row in rows])
    except Exception as e:
        return jsonify({"error": f"Feedback error: {e}"}), 500


@app.route("/ingest", methods=["POST"])
@app.route("/api/ingest", methods=["POST"])
def ingest_endpoint():
    """
    POST /ingest — Accepts document file or URL input, creates job_id.
    Returns: { "jobId": "job-xxxx", "status": "processing" }
    """
    import uuid
    job_id = f"job-{uuid.uuid4().hex[:12]}"
    language = request.form.get("language", "en").strip()
    url = request.form.get("url", "").strip()

    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        INSERT INTO uploaded_documents (id, url, detected_language, extraction_status)
        VALUES (?, ?, ?, ?)
        """,
        (job_id, url or "uploaded_file", language, "processing")
    )
    conn.commit()
    conn.close()

    return jsonify({"jobId": job_id, "status": "processing", "language": language})


@app.route("/explanation/<job_id>", methods=["GET"])
@app.route("/api/explanation/<job_id>", methods=["GET"])
def get_explanation(job_id):
    """
    GET /explanation/:jobId — Fetches completed explanation by jobId.
    """
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM previously_explained WHERE job_id = ?", (job_id,)
        ).fetchone()
        conn.close()

        if not row:
            return jsonify({"error": f"Explanation for jobId {job_id} not found."}), 404

        d = dict(row)
        if d.get("citations"):
            try:
                d["citations"] = json.loads(d["citations"])
            except Exception:
                pass
        return jsonify(d)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/eligibility", methods=["POST"])
def eligibility_alias():
    return evaluate_eligibility_route()


@app.route("/recommendations", methods=["GET", "POST"])
def recommendations_alias():
    return get_recommendations()


@app.route("/history", methods=["GET"])
def history_alias():
    return get_history()


@app.route("/api/recommendations", methods=["GET", "POST"])
def get_recommendations():
    """
    Recommendation endpoint — vector similarity search over curated schemes.
    Accepts:
      POST json/form: { "query": "farmer financial help", "profile": {...}, "top_k": 4 }
      GET args: ?query=farmer&top_k=4
    """
    try:
        if request.method == "POST":
            data = request.get_json(silent=True) or request.form
            query_text = data.get("query", "")
            profile = data.get("profile", {})
            top_k = int(data.get("top_k", 4))
        else:
            query_text = request.args.get("query", "")
            profile = {}
            top_k = int(request.args.get("top_k", 4))

        if not query_text and not profile:
            # If no query specified, return all curated schemes
            results = get_all_schemes()
            for r in results:
                r["match_label"] = "Featured Scheme"
                r["match_class"] = "match-high"
                r["match_percentage"] = "Featured"
            return jsonify(results[:top_k])

        results = recommend_schemes(query_text=query_text, profile=profile, top_k=top_k)
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": f"Recommendation error: {e}"}), 500


# ── Server-Sent Events helper ───────────────────────────────────────────────
def make_sse(payload: dict) -> str:
    """Encode a dict as a single SSE data line followed by double newline."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.route("/api/process-stream", methods=["POST"])
def process_document_stream():
    """
    Streaming endpoint -- emits Server-Sent Events as the pipeline runs.

    Events emitted (in order):
      {"stage": "Reading your document",      "step": 0}
      {"stage": "Finding key information",     "step": 1}
      {"stage": "Simplifying the language",    "step": 2}
      {"stage": "Preparing your explanation",  "step": 3}
      {"type": "complete", "result": { ...structured result... }}

    On any error:
      {"type": "error", "message": "<human-readable message>"}
    """
    # Read all request data BEFORE the generator opens
    language    = request.form.get("language", "en").strip()
    url         = request.form.get("url", "").strip()
    file_bytes  = None
    filename    = ""

    if url:
        pass  # ingestion done inside generator via ingest_url()
    elif "file" in request.files:
        f = request.files["file"]
        if f and f.filename:
            file_bytes = f.read()
            filename   = f.filename

    def generate():
        # Stage 1: Reading -- this is where actual I/O happens
        yield make_sse({"stage": "Reading your document", "step": 0})

        ingested: IngestResult | None = None

        if url:
            try:
                ingested = ingest_url(url)
            except IngestionError as e:
                yield make_sse({"type": "error", "message": str(e)})
                return
            except Exception as e:
                yield make_sse({"type": "error",
                    "message": f"Could not fetch that URL: {e}"})
                return

        elif file_bytes is not None:
            try:
                ingested = ingest_bytes(file_bytes, filename)
            except IngestionError as e:
                yield make_sse({"type": "error", "message": str(e)})
                return
            except Exception as e:
                yield make_sse({"type": "error",
                    "message": f"Could not read the file: {e}"})
                return
        else:
            yield make_sse({"type": "error",
                "message": "Please upload a document or paste a link."})
            return

        if not ingested.is_usable():
            yield make_sse({"type": "error", "message":
                "We could not read enough text from this document. "
                "If it's a scanned image, try uploading a clearer photo. "
                "If it's a PDF, make sure it's not password-protected."})
            return

        source_name = ingested.metadata.get("url") or ingested.metadata.get("filename") or ""

        # Stage 2: Finding key information
        yield make_sse({"stage": "Finding key information", "step": 1})

        # Stage 3: Simplifying (LLM call -- blocking, real work here)
        yield make_sse({"stage": "Simplifying the language", "step": 2})

        try:
            result = run_pipeline(ingested.text, language)
        except Exception as e:
            yield make_sse({"type": "error", "message": str(e)})
            return

        # Stage 4: Preparing
        yield make_sse({"stage": "Preparing your explanation", "step": 3})

        try:
            conn = sqlite3.connect(DB_PATH)
            conn.execute(
                """
                INSERT INTO results
                    (source, language, simplified_text, eligibility, documents, benefit, how_to_apply)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    source_name, language,
                    result.get("simplified_text", ""),
                    result.get("eligibility",      ""),
                    result.get("documents",        ""),
                    result.get("benefit",          ""),
                    result.get("how_to_apply",     ""),
                ),
            )
            import uuid
            job_id = f"job-{uuid.uuid4().hex[:12]}"
            conn.execute(
                """
                INSERT INTO previously_explained
                    (job_id, source, language, scheme_name, simplified_text, eligibility, documents, benefit, how_to_apply, restrictions, citations)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id, source_name, language,
                    result.get("scheme_name", ""),
                    result.get("simplified_text", ""),
                    result.get("eligibility", ""),
                    result.get("documents", ""),
                    result.get("benefit", ""),
                    result.get("how_to_apply", ""),
                    result.get("restrictions", ""),
                    json.dumps(result.get("citations", {}), ensure_ascii=False)
                )
            )
            conn.commit()
        except Exception:
            pass
        finally:
            conn.close()

        action_guide = build_action_guide(
            result.get("documents", ""),
            result.get("how_to_apply", "")
        )

        yield make_sse({
            "type": "complete",
            "result": {
                "jobId":              job_id,
                "success":            True,
                "source":             source_name,
                "source_type":        ingested.source_type,
                "page_count":         ingested.page_count,
                "detected_language":  ingested.detected_language,
                "language":           language,
                "scheme_name":        result.get("scheme_name",        ""),
                "simplified_text":    result.get("simplified_text",    ""),
                "eligibility":        result.get("eligibility",        ""),
                "benefit":            result.get("benefit",            ""),
                "documents":          result.get("documents",          ""),
                "how_to_apply":       result.get("how_to_apply",       ""),
                "restrictions":       result.get("restrictions",       ""),
                "action_guide":       action_guide,
                "citations":          result.get("citations",          {}),
                "overall_confidence": result.get("overall_confidence", "High Confidence"),
            },
        })

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":     "no-cache, no-store",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )


@app.route("/status/<job_id>", methods=["GET"])
@app.route("/api/status/<job_id>", methods=["GET"])
def job_status_stream(job_id):
    """
    GET /status/:jobId — SSE endpoint for job status tracking.
    """
    return process_document_stream()


if __name__ == "__main__":
    print("\nBhashaBridge is starting...")
    print("   Open https://bhashabridge-roqp.onrender.com in your browser")
    print("   Press Ctrl+C to stop\n")

    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 5000)),
        debug=True,
        use_reloader=False
    )