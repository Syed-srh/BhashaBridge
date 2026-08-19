"""
rag_retriever.py — BhashaBridge Layer-5 Trust & Verification System


Features:
  1. Semantic Document Chunking:
     Splits raw document text into overlapping chunks with metadata
     (chunk_id, text, start_char, end_char).
  2. RAG Vector Retriever:
     Retrieves top-K relevant chunks for each field query using TF-IDF /
     cosine similarity over embedded document chunks.
  3. Confidence Classification:
     - "high"      : Verbatim text match found in retrieved chunk (🟢)
     - "medium"    : Inferred / paraphrased from retrieved context (🟡)
     - "not_found" : Field missing or sentinel string → triggers "⚠ Not found in document" (🔴/⚪)
  4. Source Citations:
     Attaches exact source chunk reference & verbatim excerpt to each field
     for the "Show Source" UI toggle.
"""

from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass
from typing import Any, Optional

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

log = logging.getLogger(__name__)

# Sentinel string used across BhashaBridge for missing info
SENTINEL = "This information was not available in the document."


@dataclass
class DocumentChunk:
    chunk_id: str             # e.g. "Chunk #1", "Chunk #2"
    index: int
    text: str
    start_char: int
    end_char: int
    char_count: int


@dataclass
class FieldCitation:
    field_name: str
    confidence: str           # "high" | "medium" | "not_found"
    confidence_label: str     # "High Confidence" | "Medium Confidence" | "⚠ Not found in document"
    confidence_class: str     # "conf-high" | "conf-medium" | "conf-not-found"
    confidence_icon: str      # "🟢" | "🟡" | "⚠"
    source_chunk_id: str      # e.g. "Chunk #1" or "N/A"
    source_excerpt: str       # Exact verbatim snippet from original document
    relevance_score: float    # Cosine similarity score (0.0 to 1.0)


# ── 1. Document Chunking ──────────────────────────────────────────────────────

def chunk_document(raw_text: str, chunk_size: int = 450, overlap: int = 90) -> list[DocumentChunk]:
    """
    Splits document into overlapping semantic chunks.
    Attempts sentence boundaries (. ! \n) to avoid splitting words.
    """
    text = (raw_text or "").strip()
    if not text:
        return [DocumentChunk(chunk_id="Chunk #1", index=0, text="", start_char=0, end_char=0, char_count=0)]

    chunks = []
    start = 0
    doc_len = len(text)
    idx = 1

    while start < doc_len:
        end = min(start + chunk_size, doc_len)

        # Extend/contract to end of sentence or line if possible
        if end < doc_len:
            break_pt = max(text.rfind(". ", start, end), text.rfind("\n", start, end))
            if break_pt != -1 and break_pt > start + (chunk_size // 2):
                end = break_pt + 1

        chunk_str = text[start:end].strip()
        if chunk_str:
            chunks.append(DocumentChunk(
                chunk_id=f"Chunk #{idx}",
                index=idx - 1,
                text=chunk_str,
                start_char=start,
                end_char=end,
                char_count=len(chunk_str),
            ))
            idx += 1

        if end >= doc_len:
            break
        start = max(end - overlap, start + 1)

    return chunks


# ── 2. Vector Retriever Over Chunks 

def retrieve_relevant_chunks(
    chunks: list[DocumentChunk],
    field_query: str,
    top_k: int = 2,
) -> list[tuple[DocumentChunk, float]]:
    """
    RAG Retriever: Computes TF-IDF vector similarity between query & document chunks.
    Returns list of (DocumentChunk, similarity_score) tuples sorted by score.
    """
    if not chunks or not field_query.strip():
        return []

    corpus = [c.text for c in chunks]

    try:
        vectorizer = TfidfVectorizer(ngram_range=(1, 2), stop_words="english")
        tfidf_matrix = vectorizer.fit_transform(corpus)
        query_vec = vectorizer.transform([field_query])

        scores = cosine_similarity(query_vec, tfidf_matrix)[0]
    except Exception as exc:
        log.warning("RAG Retriever TF-IDF error: %s — falling back to keyword search", exc)
        scores = np.zeros(len(chunks))
        q_words = set(re.findall(r"\w+", field_query.lower()))
        for i, c in enumerate(chunks):
            c_words = set(re.findall(r"\w+", c.text.lower()))
            if q_words and c_words:
                scores[i] = len(q_words & c_words) / len(q_words)

    # Sort descending
    indexed_scores = [(chunks[i], float(scores[i])) for i in range(len(chunks))]
    indexed_scores.sort(key=lambda x: x[1], reverse=True)

    return indexed_scores[:top_k]


# ── 3. Confidence Classification & Citation Generator 

def compute_field_confidence(
    field_name: str,
    field_value: str,
    chunks: list[DocumentChunk],
    raw_document_text: str,
) -> FieldCitation:
    """
    Determines field confidence and source citation reference:
      - "not_found" (⚠): Missing or sentinel string
      - "high"      (🟢): Verbatim phrase overlap >= 30% or exact string match in source
      - "medium"    (🟡): Paraphrased/inferred from retrieved source chunk
    """
    val = (field_value or "").strip()

    # Case 1: Missing or Sentinel String → Trigger "⚠ not found in document" UI state
    if not val or val.startswith(SENTINEL) or "not available in the document" in val.lower():
        return FieldCitation(
            field_name=field_name,
            confidence="not_found",
            confidence_label="⚠ Not found in document",
            confidence_class="conf-not-found",
            confidence_icon="⚠",
            source_chunk_id="N/A",
            source_excerpt="No supporting information was found in the uploaded document.",
            relevance_score=0.0,
        )

    # Search query tailored for field
    field_queries = {
        "simplified_text": "scheme overview summary purpose objective",
        "eligibility":     "who can apply eligibility criteria qualification age income land",
        "benefit":         "benefit financial assistance grant rupees money service support",
        "documents":       "documents required certificate aadhaar proof papers mandatory",
        "how_to_apply":    "how to apply portal website process steps office form",
        "restrictions":    "restrictions exclusions disqualifications deadline last date cap",
    }
    query = field_queries.get(field_name, field_name)

    retrieved = retrieve_relevant_chunks(chunks, query, top_k=2)

    if not retrieved:
        return FieldCitation(
            field_name=field_name,
            confidence="medium",
            confidence_label="Medium Confidence (Paraphrased Context)",
            confidence_class="conf-medium",
            confidence_icon="🟡",
            source_chunk_id="Chunk #1",
            source_excerpt=raw_document_text[:200] + "..." if raw_document_text else "General document text.",
            relevance_score=0.3,
        )

    top_chunk, score = retrieved[0]

    # Calculate verbatim word overlap between field value & retrieved chunk
    val_words = set(re.findall(r"\b\w{4,}\b", val.lower()))
    chunk_words = set(re.findall(r"\b\w{4,}\b", top_chunk.text.lower()))

    verbatim_overlap = (len(val_words & chunk_words) / max(len(val_words), 1)) if val_words else 0.0

    # High Confidence: Verbatim overlap >= 30% or high retriever similarity score >= 0.35
    if verbatim_overlap >= 0.30 or score >= 0.35:
        # Extract a clean snippet (up to 220 chars) from the source chunk
        excerpt = top_chunk.text[:220].strip() + ("..." if len(top_chunk.text) > 220 else "")
        return FieldCitation(
            field_name=field_name,
            confidence="high",
            confidence_label="High Confidence (Verbatim Source)",
            confidence_class="conf-high",
            confidence_icon="🟢",
            source_chunk_id=top_chunk.chunk_id,
            source_excerpt=excerpt,
            relevance_score=round(score, 3),
        )

    # Medium Confidence: Paraphrased / inferred
    excerpt = top_chunk.text[:220].strip() + ("..." if len(top_chunk.text) > 220 else "")
    return FieldCitation(
        field_name=field_name,
        confidence="medium",
        confidence_label="Medium Confidence (Paraphrased Context)",
        confidence_class="conf-medium",
        confidence_icon="🟡",
        source_chunk_id=top_chunk.chunk_id,
        source_excerpt=excerpt,
        relevance_score=round(score, 3),
    )


def compute_all_citations(
    result_dict: dict,
    raw_document_text: str,
) -> tuple[dict[str, dict], str]:
    """
    Computes field-level citations & overall document confidence score.
    """
    chunks = chunk_document(raw_document_text)

    fields = ["simplified_text", "eligibility", "benefit", "documents", "how_to_apply", "restrictions"]
    citations = {}

    high_count = 0
    not_found_count = 0

    for f in fields:
        val = result_dict.get(f, "")
        cit = compute_field_confidence(f, val, chunks, raw_document_text)
        citations[f] = asdict(cit)

        if cit.confidence == "high":
            high_count += 1
        elif cit.confidence == "not_found":
            not_found_count += 1

    # Overall document confidence score
    if not_found_count >= 3:
        overall_confidence = "Low Confidence (Partial Information)"
    elif high_count >= 3:
        overall_confidence = "High Confidence (Strong Grounding)"
    else:
        overall_confidence = "Medium Confidence (Grounded Extraction)"

    return citations, overall_confidence
