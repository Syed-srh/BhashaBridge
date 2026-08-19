"""
llm_pipeline.py — BhashaBridge Layer-2 LLM Simplification Pipeline


Three independent, separately-callable steps:

  Step 1  extract_structured_fields(text)
            Raw document text → strict structured JSON (scheme_name,
            eligibility, benefits, documents_required,
            application_process, restrictions, summary)

  Step 2  simplify(structured_fields)
            Structured JSON → same schema rewritten into plain language
            at a Class-5 reading level, in the *document's own language*.

  Step 3  translate(simplified_fields, target_language_code)
            Plain-language JSON → same schema in the user's target language.

  Convenience wrapper:
  run_pipeline(raw_text, target_language_code)
            Calls all three steps in sequence with intermediate logging,
            then maps the final result to the exact shape the frontend
            result cards expect:
              simplified_text / eligibility / benefit /
              documents / how_to_apply / restrictions

Each step logs its input key-lengths and its output so the pipeline is
independently debuggable. Use the module-level `log` logger.

All three step-functions accept an optional `client` argument so they can
share a single Groq connection (passed by run_pipeline) or be called
standalone in tests.
"""

from __future__ import annotations

import json
import logging
import os
import textwrap
from typing import Any

from groq import Groq
from rag_retriever import compute_all_citations

# ── Logging 
log = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  [%(levelname)s]  %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)

from dotenv import load_dotenv

load_dotenv()

# ── Config 
def get_api_key() -> str:
    return os.getenv("GROQ_API_KEY", "")

# Preferred model; fallback list tried in order on model_not_found / API error.
# Run  python -c "from groq import Groq; [print(m.id) for m in Groq().models.list().data]"
# to refresh this list when models are deprecated.
_PRIMARY_MODEL  = os.getenv("GROQ_MODEL", "groq/compound")

_FALLBACK_MODELS = [
    os.getenv("GROQ_MODEL", "groq/compound"),   # honour .env override first
    "groq/compound",
    "openai/gpt-oss-120b",
    "qwen/qwen3.6-27b",
    "openai/gpt-oss-20b",
    "groq/compound-mini",
]

# Language code → display name (add more as needed; matches ingestion.py)
LANGUAGE_NAMES: dict[str, str] = {
    "en":   "English",
    "hi":   "Hindi",
    "te":   "Telugu",
    "ta":   "Tamil",
    "bn":   "Bengali",
    "mr":   "Marathi",
    "gu":   "Gujarati",
    "kn":   "Kannada",
    "ml":   "Malayalam",
    "pa":   "Punjabi",
    "or":   "Odia",
    "as":   "Assamese",
    "ur":   "Urdu",
    "mai":  "Maithili",
    "kok":  "Konkani",
    "ne":   "Nepali",
    "ks":   "Kashmiri",
    "sd":   "Sindhi",
    "dog":  "Dogri",
    "bodo": "Bodo",
    "mni":  "Manipuri",
    "sa":   "Sanskrit",
}

# ── Schema shared by all three steps 
# Keys must be present in every LLM response.  Missing/null values are
# replaced with the sentinel string so the frontend never shows an empty card.
_SENTINEL        = "This information was not available in the document."
_SCHEMA_KEYS     = [
    "scheme_name",
    "summary",
    "eligibility",
    "benefits",
    "documents_required",
    "application_process",
    "restrictions",
]

# ── Helper: call LLM with model fallback + JSON fence stripping 

def _call_llm(
    system: str,
    user: str,
    client: Groq,
    temperature: float = 0.2,
    max_tokens: int = 2500,
) -> dict:
    """
    Sends a chat completion request, extracts JSON from code-fences or braces, and parses it.
    Tries each model in _FALLBACK_MODELS until one succeeds.

    Raises RuntimeError if every model fails.
    """
    tried = []
    last_err = None

    for model in dict.fromkeys(_FALLBACK_MODELS):   # dedup, preserve order
        try:
            resp = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user",   "content": user},
                ],
                temperature=temperature,
                max_tokens=max_tokens,
            )
            raw = (resp.choices[0].message.content or "").strip()

            if not raw:
                raise ValueError("Received empty content from LLM.")

            # Strip markdown code fences if present
            if "```" in raw:
                # Extract content inside markdown code block if present
                fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
                if fence_match:
                    raw = fence_match.group(1).strip()
                else:
                    # Generic code block strip
                    lines = [ln for ln in raw.splitlines() if not ln.strip().startswith("```")]
                    raw = "\n".join(lines).strip()

            # Attempt direct parse
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                # Fallback: find outer-most JSON braces { ... }
                first_brace = raw.find("{")
                last_brace = raw.rfind("}")
                if first_brace != -1 and last_brace > first_brace:
                    json_str = raw[first_brace:last_brace + 1]
                    parsed = json.loads(json_str)
                else:
                    raise

            log.info(
                "  [LLM] model=%s tokens_in≈%d tokens_out≈%d",
                model,
                len(system.split()) + len(user.split()),
                len(raw.split())
            )
            return parsed

        except Exception as exc:
            log.warning("  [LLM] model=%s failed (error: %s)", model, exc)
            tried.append(model)
            last_err = exc
            continue

    raise RuntimeError(
        f"All LLM models ({', '.join(tried)}) failed. Last error: {last_err}"
    )



def _fill_missing(fields: dict) -> dict:
    """Ensure all schema keys exist; replace None / empty with sentinel."""
    out = {}
    for k in _SCHEMA_KEYS:
        val = fields.get(k, "")
        out[k] = val if (val and str(val).strip()) else _SENTINEL
    return out


# Step 1 — extract_structured_fields

_EXTRACT_SYSTEM = textwrap.dedent("""\
You are a precise information extractor for Indian government welfare scheme documents.

Your task: read the document and extract EXACTLY the information asked for.
Do NOT invent, infer, or embellish. Copy language from the document as-is.
If a field is not mentioned at all, use the string "Not specified in the document."

Return ONLY a valid JSON object with EXACTLY these seven keys:
{
  "scheme_name":          "<official name of the scheme>",
  "summary":              "<2-3 sentence factual overview of what the scheme is>",
  "eligibility":          "<who is eligible — all criteria mentioned>",
  "benefits":             "<what the beneficiary receives — money, services, goods>",
  "documents_required":   "<list of all documents / proofs required to apply>",
  "application_process":  "<step-by-step process to apply — offices, portals, forms>",
  "restrictions":         "<exclusions, disqualifications, deadlines, caps>"
}

Return nothing outside the JSON object. No preamble, no trailing text.
""")

_EXTRACT_USER = """\
Government scheme document text:

---
{text}
---

Extract the structured information now.
"""

MAX_EXTRACT_CHARS = 6000   # Groq context budget for extraction step


def extract_structured_fields(
    text: str,
    *,
    client: Groq | None = None,
) -> dict:
    """
    Step 1: Raw text → strict structured JSON.

    Parameters
    ----------
    text   : Raw extracted document text from the ingestion layer.
    client : Optional shared Groq client (created internally if not given).

    Returns
    -------
    dict with keys: scheme_name, summary, eligibility, benefits,
                    documents_required, application_process, restrictions
    """
    api_key = get_api_key()
    if not api_key and client is None:
        raise ValueError("GROQ_API_KEY is not set. Add it to your .env file.")

    client = client or Groq(api_key=api_key)

    log.info("[Step 1] extract_structured_fields — input chars: %d", len(text))

    truncated = text[:MAX_EXTRACT_CHARS]
    if len(text) > MAX_EXTRACT_CHARS:
        log.info("[Step 1] Text truncated to %d chars for context budget.",
                 MAX_EXTRACT_CHARS)

    user_msg = _EXTRACT_USER.format(text=truncated)
    result   = _call_llm(_EXTRACT_SYSTEM, user_msg, client, temperature=0.1)
    result   = _fill_missing(result)

    log.info(
        "[Step 1] DONE — scheme_name=%r  eligibility_len=%d  benefits_len=%d",
        result.get("scheme_name", "?")[:60],
        len(result.get("eligibility", "")),
        len(result.get("benefits", "")),
    )
    return result


# Step 2 — simplify

_SIMPLIFY_SYSTEM = textwrap.dedent("""\
You are BhashaBridge — a trusted friend helping ordinary Indian citizens
understand complex government documents.

A farmer from a rural village will read your output. They may have
studied only till Class 5. Use the simplest possible words.
Short sentences. Warm, encouraging tone. No jargon.

Rules:
- Rewrite every field into plain language a child could understand.
- Keep all factual information accurate — do not remove or add facts.
- Keep the text in the SAME LANGUAGE as the input fields.
- If a field says "Not specified in the document." leave it exactly as is.
- Format lists as bullet points starting with • (bullet character).
- For application_process, use numbered steps: 1. … 2. … 3. …

Return ONLY a valid JSON object with EXACTLY the same seven keys as the input:
{
  "scheme_name":          "...",
  "summary":              "...",
  "eligibility":          "...",
  "benefits":             "...",
  "documents_required":   "...",
  "application_process":  "...",
  "restrictions":         "..."
}

Return nothing outside the JSON object.
""")

_SIMPLIFY_USER = """\
Rewrite the following structured government scheme information into plain,
simple language that any rural Indian citizen can understand.

Input:
{fields_json}

Output the simplified version now.
"""


def simplify(
    structured_fields: dict,
    *,
    client: Groq | None = None,
) -> dict:
    """
    Step 2: Structured extraction → plain-language rewrite (same language).

    Parameters
    ----------
    structured_fields : Output of extract_structured_fields().
    client            : Optional shared Groq client.

    Returns
    -------
    dict with same seven keys, rewritten at Class-5 reading level.
    """
    client = client or Groq(api_key=get_api_key())

    log.info(
        "[Step 2] simplify — scheme=%r  input_total_len=%d",
        structured_fields.get("scheme_name", "?")[:60],
        sum(len(v) for v in structured_fields.values() if isinstance(v, str)),
    )

    fields_json = json.dumps(structured_fields, ensure_ascii=False, indent=2)
    user_msg    = _SIMPLIFY_USER.format(fields_json=fields_json)
    result      = _call_llm(_SIMPLIFY_SYSTEM, user_msg, client, temperature=0.3)
    result      = _fill_missing(result)

    log.info(
        "[Step 2] DONE — summary_len=%d  eligibility_len=%d",
        len(result.get("summary", "")),
        len(result.get("eligibility", "")),
    )
    return result


# Step 3 — translate

_TRANSLATE_SYSTEM = textwrap.dedent("""\
You are a careful translator helping Indian citizens access government information
in their native language.

Rules:
- Translate EVERY word of every field value into {target_language}.
- Keep the meaning exactly the same — do not add or remove information.
- Keep bullet points (•) and numbered steps (1. 2. 3.) as-is.
- If a field says "Not specified in the document." translate that phrase too.
- Proper nouns (scheme names, portal URLs, office names) may be kept in English
  if they are widely known that way (e.g. "PM-KISAN", "Aadhaar", "CSC").

Return ONLY a valid JSON object with EXACTLY these seven keys:
{{
  "scheme_name":          "...",
  "summary":              "...",
  "eligibility":          "...",
  "benefits":             "...",
  "documents_required":   "...",
  "application_process":  "...",
  "restrictions":         "..."
}}

Return nothing outside the JSON object.
""")

_TRANSLATE_USER = """\
Translate the following simplified government scheme information into {target_language}.

Input:
{fields_json}

Output the translated version now.
"""


def translate(
    simplified_fields: dict,
    target_language_code: str,
    *,
    client: Groq | None = None,
) -> dict:
    """
    Step 3: Plain-language fields → target language.

    Parameters
    ----------
    simplified_fields     : Output of simplify().
    target_language_code  : ISO 639-1 / BCP-47 code e.g. "hi", "ta", "en".
    client                : Optional shared Groq client.

    Returns
    -------
    dict with same seven keys translated into target_language_code.
    If target is already English and the simplified output appears to be
    English already, this step is skipped for efficiency.
    """
    target_language = LANGUAGE_NAMES.get(target_language_code, "English")

    # Skip translation step if target == English and content looks English
    if target_language_code == "en":
        log.info("[Step 3] translate — target is English; skipping translation.")
        return simplified_fields

    client = client or Groq(api_key=get_api_key())

    log.info(
        "[Step 3] translate — target=%s (%s)  input_total_len=%d",
        target_language_code, target_language,
        sum(len(v) for v in simplified_fields.values() if isinstance(v, str)),
    )

    system_msg = _TRANSLATE_SYSTEM.format(target_language=target_language)
    fields_json = json.dumps(simplified_fields, ensure_ascii=False, indent=2)
    user_msg    = _TRANSLATE_USER.format(
        target_language=target_language,
        fields_json=fields_json,
    )

    result = _call_llm(system_msg, user_msg, client, temperature=0.1, max_tokens=3000)
    result = _fill_missing(result)

    log.info(
        "[Step 3] DONE — summary_len=%d",
        len(result.get("summary", "")),
    )
    return result


# Convenience wrapper — full pipeline

def run_pipeline(
    raw_text: str,
    target_language_code: str = "en",
) -> dict:
    """
    Runs all three steps in sequence and maps the final output to the exact
    shape the BhashaBridge frontend result cards expect.

    Frontend keys produced:
      simplified_text  — "What is this scheme" card (summary)
      eligibility      — "Who can apply" card
      benefit          — "What you get" card  (benefits)
      documents        — "What you need" card (documents_required)
      how_to_apply     — "How to apply" card  (application_process)
      restrictions     — fed into populateImportantCard()

    Also includes pipeline metadata for debugging / history:
      scheme_name, pipeline_stages
    """
    api_key = get_api_key()
    if not api_key:
        raise ValueError("GROQ_API_KEY is not set. Add it to your .env file.")

    client = Groq(api_key=api_key)

    log.info("=" * 60)
    log.info("BhashaBridge pipeline START — target_lang=%s  input_chars=%d",
             target_language_code, len(raw_text))

    # ── Step 1: extract 
    extracted = extract_structured_fields(raw_text, client=client)

    # ── Step 2: simplify 
    simplified = simplify(extracted, client=client)

    # ── Step 3: translate 
    final = translate(simplified, target_language_code, client=client)

    log.info("BhashaBridge pipeline DONE")
    log.info("=" * 60)

    # ── Map to frontend card shape 
    result_dict = {
        # Core display fields — must match renderResults() in app.js exactly
        "simplified_text": final.get("summary",              _SENTINEL),
        "eligibility":     final.get("eligibility",          _SENTINEL),
        "benefit":         final.get("benefits",             _SENTINEL),
        "documents":       final.get("documents_required",   _SENTINEL),
        "how_to_apply":    final.get("application_process",  _SENTINEL),
        "restrictions":    final.get("restrictions",         _SENTINEL),
        "scheme_name":     final.get("scheme_name",          ""),
    }

    # ── Layer 5: Compute RAG field-level citations & confidence 
    citations, overall_confidence = compute_all_citations(result_dict, raw_text)

    result_dict["citations"] = citations
    result_dict["overall_confidence"] = overall_confidence
    result_dict["pipeline_stages"] = {
        "extracted":  extracted,
        "simplified": simplified,
        "translated": final,
    }

    return result_dict
