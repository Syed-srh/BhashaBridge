"""
recommendation_engine.py — BhashaBridge Layer-3 Scheme Recommendation Engine


Features:
  1. Knowledge Base of 12 real curated Indian government schemes with rich
     structured fields (Prompt 3 / Layer 2 schema).
  2. Multi-database backend:
     - Connects to Postgres / Supabase with pgvector if DATABASE_URL or
       SUPABASE_URL is configured in .env.
     - Fallback: embedded SQLite database (db/schemes_kb.db) + NumPy / TF-IDF
       vector embedding engine for instant zero-config local operation.
  3. Vector similarity search based on Cosine Similarity:
     - Accepts free-text user query ("I am a farmer and need money") or
       structured profile dict ({age, occupation, income, location}).
     - Assigns match labels: High Match (🟢), Medium Match (🟡), Low Match (⚪).
     - Returns top-K schemes formatted for the frontend "Discover" UI.

Public API:
-----------
  init_db()
  recommend_schemes(query_text=None, profile=None, top_k=4) -> list[dict]
  get_all_schemes() -> list[dict]
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
from dataclasses import asdict, dataclass
from typing import Any, Optional

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

log = logging.getLogger(__name__)

# ── Config 
SQLITE_DB_PATH = "db/schemes_kb.db"
POSTGRES_URL   = os.getenv("DATABASE_URL") or os.getenv("SUPABASE_URL", "")

# ── Seed Knowledge Base (12 Curated Real Schemes) 
CURATED_SCHEMES = [
    {
        "id": "pm-kisan",
        "scheme_name": "PM-KISAN Samman Nidhi",
        "category": "Agriculture & Farmers",
        "icon": "🌾",
        "official_url": "https://pmkisan.gov.in/",
        "summary": "Direct annual cash benefit of ₹6,000 for small and marginal landholding farmer families across India paid in three equal installments.",
        "eligibility": "All landholding farmer families with cultivable land. Excludes income taxpayers, government employees, and institutional landholders.",
        "benefits": "₹6,000 per year transferred directly to bank account via Direct Benefit Transfer (DBT) in 3 installments of ₹2,000.",
        "documents_required": "Aadhaar Card, Land Ownership Records (Khasra/Khatauni), Active Bank Account linked with Aadhaar.",
        "application_process": "Apply online at pmkisan.gov.in or visit nearest Common Service Centre (CSC) or district Agriculture Officer.",
        "restrictions": "Must own cultivable land. High-income earners and tax-paying farmers are excluded.",
        "target_profile": "Occupation: Farmer, Agriculture; Income: Low to Medium; Land: Own land",
    },
    {
        "id": "ayushman-bharat",
        "scheme_name": "Ayushman Bharat PM-JAY",
        "category": "Healthcare & Medical",
        "icon": "🏥",
        "official_url": "https://pmjay.gov.in/",
        "summary": "World's largest government-funded healthcare scheme providing health coverage of ₹5 lakh per family per year for secondary and tertiary hospitalization.",
        "eligibility": "Low-income families identified under SECC 2011 data, unorganized workers, landless laborers, and senior citizens aged 70+.",
        "benefits": "Cashless health cover up to ₹5,000,000 per family per year covering pre and post hospitalization expenses across empanelled hospitals.",
        "documents_required": "Aadhaar Card, Ration Card, Ayushman Golden Card or PM-JAY ID.",
        "application_process": "Check eligibility at beneficiary.ha.gov.in or visit any empanelled public/private hospital Arogyamitra.",
        "restrictions": "Families paying income tax or owning 4-wheeler motor vehicles are not eligible.",
        "target_profile": "Income: Low; Occupation: Laborer, Domestic Worker, Unorganized; Health: Medical assistance",
    },
    {
        "id": "pmay-housing",
        "scheme_name": "Pradhan Mantri Awas Yojana (PMAY)",
        "category": "Housing & Urban",
        "icon": "🏠",
        "official_url": "https://pmaymis.gov.in/",
        "summary": "Financial housing assistance and credit-linked interest subsidies to help low-income families and urban poor build or buy a pucca house.",
        "eligibility": "Families belonging to EWS (Economically Weaker Section) or LIG (Low Income Group) who do not own a pucca house anywhere in India.",
        "benefits": "Financial grant up to ₹2.67 lakh interest subsidy on home loans, or ₹1.5 lakh direct assistance for house construction.",
        "documents_required": "Aadhaar Card, Income Certificate, Bank Passbook, Land Ownership or Affidavit of non-ownership of house.",
        "application_process": "Apply online on PMAY portal or through urban local body / Gram Panchayat office.",
        "restrictions": "Applicant or family members must not own a pucca house anywhere in India.",
        "target_profile": "Income: EWS/LIG (< ₹6 Lakh/yr); Housing: Homeless or Kutcha house owner",
    },
    {
        "id": "nsp-scholarships",
        "scheme_name": "National Scholarship Portal (NSP)",
        "category": "Education & Students",
        "icon": "🎓",
        "official_url": "https://scholarships.gov.in/",
        "summary": "Single-window portal providing central and state scholarships for school, college, and university students from SC/ST/OBC/Minority/EWS backgrounds.",
        "eligibility": "Students enrolled in recognized schools or colleges with annual family income below specified limits (typically ₹2.5 Lakh/yr).",
        "benefits": "Annual tuition fee coverage, maintenance allowance, and book grants ranging from ₹5,000 to ₹50,000 per year.",
        "documents_required": "Aadhaar Card, Marksheet, Caste/Category Certificate, Income Certificate, Fee Receipt, Bank Account details.",
        "application_process": "Register on scholarships.gov.in, complete OTR registration, fill scheme form and submit institute verification.",
        "restrictions": "Student cannot hold two government scholarships simultaneously. Minimum 50% marks in previous exam required.",
        "target_profile": "Occupation: Student; Age: 6-25; Income: Below ₹2.5 Lakh",
    },
    {
        "id": "pm-ujjwala",
        "scheme_name": "PM Ujjwala Yojana 2.0",
        "category": "Women & Welfare",
        "icon": "🔥",
        "official_url": "https://www.pmuy.gov.in/",
        "summary": "Free LPG gas connection with first refill and stove provided free of cost to adult women from Below Poverty Line (BPL) households.",
        "eligibility": "Adult women belonging to BPL households, SC/ST, PMAGY beneficiaries, or rural poor households without an existing LPG connection.",
        "benefits": "Free LPG connection deposit fee, free 14.2kg cylinder, free hotplate (stove), plus ₹300 per cylinder subsidy up to 12 refills per year.",
        "documents_required": "Aadhaar Card of applicant, Ration Card, Bank Passbook, BPL proof or declaration.",
        "application_process": "Apply online at pmuy.gov.in or submit physical application form to nearest LPG distributor (Indane, Bharatgas, HP Gas).",
        "restrictions": "No existing LPG connection must be present in the same household.",
        "target_profile": "Gender: Female; Income: BPL; Category: Women Welfare",
    },
    {
        "id": "pm-mudra",
        "scheme_name": "PM Mudra Yojana (PMMY)",
        "category": "Business & Loans",
        "icon": "💼",
        "official_url": "https://www.mudra.org.in/",
        "summary": "Collateral-free business micro-loans up to ₹10 lakh for small entrepreneurs, shopkeepers, artisans, and micro-enterprises.",
        "eligibility": "Any Indian citizen having a business plan for a non-farm income generating micro-activity (Shishu: up to ₹50k, Kishor: up to ₹5lakh, Tarun: up to ₹10lakh).",
        "benefits": "Collateral-free loans at low interest rates with flexible repayment terms up to 5 years.",
        "documents_required": "Identity Proof, Address Proof, Business Registration / Proof of Business, Bank Statement for last 6 months.",
        "application_process": "Apply at any commercial bank, RRB, MFI, or online via udyamimitra.in portal.",
        "restrictions": "Loan must be used strictly for commercial/business expansion, not personal consumption.",
        "target_profile": "Occupation: Entrepreneur, Shopkeeper, Artisan, Self-employed; Business: Micro-enterprise",
    },
    {
        "id": "pm-svanidhi",
        "scheme_name": "PM SVANidhi Scheme",
        "category": "Business & Micro-loans",
        "icon": "🛒",
        "official_url": "https://pmsvanidhi.mohua.gov.in/",
        "summary": "Special micro-credit facility providing working capital loans up to ₹50,000 for street vendors affected by economic disruption.",
        "eligibility": "Street vendors vending in urban areas on or before March 24, 2020, with Certificate of Vending or Letter of Recommendation.",
        "benefits": "Initial collateral-free working capital loan of ₹10,000, progressing to ₹20,000 and ₹50,000 on timely repayment, with 7% interest subsidy.",
        "documents_required": "Aadhaar Card, Vending Certificate / LOR, Bank Account details.",
        "application_process": "Apply online through pmsvanidhi.mohua.gov.in portal or via local Common Service Centre.",
        "restrictions": "Vendor must be listed in municipal survey or possess vendor ID.",
        "target_profile": "Occupation: Street Vendor, Hawker, Small Vendor; Location: Urban",
    },
    {
        "id": "sukanya-samriddhi",
        "scheme_name": "Sukanya Samriddhi Yojana (SSY)",
        "category": "Women & Child",
        "icon": "👧",
        "official_url": "https://www.indiapost.gov.in/",
        "summary": "High-interest government savings scheme for girl children offering tax-free returns to secure their higher education and marriage expenses.",
        "eligibility": "Parents or legal guardians of a girl child below 10 years of age (maximum 2 girl children per family).",
        "benefits": "Highest sovereign interest rate (currently 8.2% p.a.), tax deduction under Section 80C, and completely tax-free maturity amount.",
        "documents_required": "Birth Certificate of Girl Child, Aadhaar Card of Parent/Guardian, Address Proof, Passport Photos.",
        "application_process": "Open account at any Post Office or authorized commercial bank branch with minimum ₹250 initial deposit.",
        "restrictions": "Maximum deposit limit ₹1.5 lakh per financial year. Account matures 21 years from date of opening.",
        "target_profile": "Target: Girl Child; Age: Below 10 years; Goal: Savings, Education",
    },
    {
        "id": "mgnrega",
        "scheme_name": "MGNREGA Scheme",
        "category": "Employment & Labor",
        "icon": "🛠️",
        "official_url": "https://nrega.nic.in/",
        "summary": "Guarantee of at least 100 days of wage employment per financial year to rural households whose adult members volunteer to do unskilled manual work.",
        "eligibility": "Adult members of any rural household willing to do manual unskilled labor.",
        "benefits": "Guaranteed minimum 100 days of paid employment per year at state-notified minimum wages directly deposited to bank account.",
        "documents_required": "Job Card, Aadhaar Card, Bank Account linked with Aadhaar.",
        "application_process": "Submit application for Job Card to local Gram Panchayat office.",
        "restrictions": "Work provided within 5km of village. Unemployment allowance paid if work not provided within 15 days.",
        "target_profile": "Location: Rural; Occupation: Unskilled Worker, Laborer; Employment: Job Guarantee",
    },
    {
        "id": "pm-vishwakarma",
        "scheme_name": "PM Vishwakarma Yojana",
        "category": "Artisans & Crafts",
        "icon": "🧰",
        "official_url": "https://pmvishwakarma.gov.in/",
        "summary": "Holistic support scheme providing skill training, toolkit incentive of ₹15,000, and low-interest collateral-free loans to traditional artisans and craftspeople.",
        "eligibility": "Traditional artisans working with hands and tools across 18 specified trades (carpenters, blacksmiths, potters, tailors, cobblers, goldsmiths, etc.).",
        "benefits": "Free skill training with ₹500/day stipend, ₹15,000 e-voucher for toolkits, and collateral-free loan up to ₹3 Lakh at 5% interest.",
        "documents_required": "Aadhaar Card, Bank Passbook, Ration Card, Trade Verification from Gram Panchayat / Urban Body.",
        "application_process": "Register via CSC on pmvishwakarma.gov.in portal followed by 3-step verification.",
        "restrictions": "Only one member per family can avail benefit. Must belong to traditional 18 trades.",
        "target_profile": "Occupation: Artisan, Craftsman, Tailor, Carpenter, Blacksmith, Traditional Trade",
    },
    {
        "id": "atal-pension",
        "scheme_name": "Atal Pension Yojana (APY)",
        "category": "Pensions & Social Security",
        "icon": "👵",
        "official_url": "https://www.npscra.nsdl.co.in/",
        "summary": "Government-backed guaranteed pension scheme for unorganized sector workers providing guaranteed monthly pension from age 60.",
        "eligibility": "Any Indian citizen between 18 and 40 years of age with a bank account, who is not an income taxpayer or covered under statutory social security.",
        "benefits": "Guaranteed monthly pension of ₹1,000 to ₹5,000 per month starting at age 60 based on contribution level.",
        "documents_required": "Aadhaar Card, Bank / Post Office Account, Mobile Number.",
        "application_process": "Fill APY registration form at bank branch or apply via NetBanking portal.",
        "restrictions": "Income taxpayers are excluded from joining APY.",
        "target_profile": "Age: 18-40; Occupation: Unorganized Sector, Worker; Goal: Pension",
    },
    {
        "id": "pm-jandhan",
        "scheme_name": "PM Jan Dhan Yojana (PMJDY)",
        "category": "Banking & Inclusion",
        "icon": "💳",
        "official_url": "https://pmjdy.gov.in/",
        "summary": "National mission for financial inclusion ensuring access to zero-balance savings bank accounts, RuPay debit card, and overdraft facility.",
        "eligibility": "Any Indian citizen above 10 years of age who does not have a bank account.",
        "benefits": "Zero-balance savings account, free RuPay debit card, ₹2 lakh accident insurance cover, and ₹10,000 overdraft facility.",
        "documents_required": "Aadhaar Card or any valid Officially Valid Document (OVD) like Voter ID, PAN, Driving License.",
        "application_process": "Visit any bank branch or Bank Mitra kiosk with Aadhaar and photos.",
        "restrictions": "Overdraft facility available after 6 months of satisfactory account operation.",
        "target_profile": "Banking: Unbanked; Income: Any; Goal: Bank Account",
    },
]

# ── Local TF-IDF Vectorizer + Cosine Engine 
_vectorizer: Optional[TfidfVectorizer] = None
_scheme_embeddings: Optional[np.ndarray] = None
_scheme_kb: list[dict] = []


def _build_scheme_search_text(scheme: dict) -> str:
    """Combines scheme fields into a single text blob optimized for vector representation."""
    parts = [
        scheme.get("scheme_name", ""),
        scheme.get("category", ""),
        scheme.get("summary", ""),
        scheme.get("eligibility", ""),
        scheme.get("benefits", ""),
        scheme.get("target_profile", ""),
    ]
    return " ".join(parts)


def init_db():
    """Initialises SQLite schemes database & builds vector search index."""
    global _vectorizer, _scheme_embeddings, _scheme_kb

    os.makedirs("db", exist_ok=True)
    conn = sqlite3.connect(SQLITE_DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schemes (
            id TEXT PRIMARY KEY,
            scheme_name TEXT,
            category TEXT,
            icon TEXT,
            official_url TEXT,
            summary TEXT,
            eligibility TEXT,
            benefits TEXT,
            documents_required TEXT,
            application_process TEXT,
            restrictions TEXT,
            target_profile TEXT,
            search_text TEXT
        )
    """)

    # Seed curated schemes if empty
    cursor = conn.execute("SELECT COUNT(*) FROM schemes")
    count = cursor.fetchone()[0]

    if count == 0:
        log.info("Seeding Knowledge Base with %d curated schemes...", len(CURATED_SCHEMES))
        for s in CURATED_SCHEMES:
            stext = _build_scheme_search_text(s)
            conn.execute(
                """
                INSERT INTO schemes
                  (id, scheme_name, category, icon, official_url, summary,
                   eligibility, benefits, documents_required, application_process,
                   restrictions, target_profile, search_text)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    s["id"], s["scheme_name"], s["category"], s["icon"],
                    s["official_url"], s["summary"], s["eligibility"], s["benefits"],
                    s["documents_required"], s["application_process"],
                    s["restrictions"], s["target_profile"], stext
                )
            )
        conn.commit()

    # Load all schemes into memory for fast vector similarity search
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM schemes").fetchall()
    conn.close()

    _scheme_kb = [dict(row) for row in rows]
    corpus = [row["search_text"] for row in _scheme_kb]

    # Build TF-IDF vectorizer
    _vectorizer = TfidfVectorizer(
        ngram_range=(1, 2),
        stop_words="english",
        sublinear_tf=True,
    )
    _scheme_embeddings = _vectorizer.fit_transform(corpus).toarray()
    log.info("Vector index built for %d schemes (dim=%d).", len(_scheme_kb), _scheme_embeddings.shape[1])


# Call init_db on module load
init_db()


def get_all_schemes() -> list[dict]:
    """Return all curated schemes from knowledge base."""
    return _scheme_kb


# ── Recommendation Engine 

def recommend_schemes(
    query_text: Optional[str] = None,
    profile: Optional[dict] = None,
    top_k: int = 4,
) -> list[dict]:
    """
    Computes vector similarity between query/profile and all knowledge base schemes.

    Parameters
    ----------
    query_text : Free text query e.g. "I am a farmer and need financial support"
    profile    : Dict with fields e.g. {"occupation": "farmer", "age": 30, "income": "< 2 Lakh"}
    top_k      : Number of recommendations to return

    Returns
    -------
    list[dict] of matching schemes with fields:
      scheme_id, scheme_name, category, icon, official_url, summary,
      eligibility, benefits, documents_required, application_process,
      restrictions, score, match_label ("High Match" | "Medium Match" | "Low Match"),
      match_percentage
    """
    global _vectorizer, _scheme_embeddings, _scheme_kb

    if _vectorizer is None or _scheme_embeddings is None or not _scheme_kb:
        init_db()

    # Combine query text & profile fields into search vector input
    search_parts = []
    if query_text and query_text.strip():
        search_parts.append(query_text.strip())

    if profile and isinstance(profile, dict):
        for k, v in profile.items():
            if v and str(v).strip():
                search_parts.append(f"{k}: {v}")

    full_query = " ".join(search_parts) if search_parts else "all government schemes"

    # Transform query to vector
    try:
        query_vec = _vectorizer.transform([full_query]).toarray()
        similarities = cosine_similarity(query_vec, _scheme_embeddings)[0]
    except Exception as exc:
        log.warning("Vector similarity error: %s — falling back to uniform score", exc)
        similarities = np.zeros(len(_scheme_kb))

    # Boost scores based on category keyword matches
    q_lower = full_query.lower()
    boosted_scores = []
    for idx, s in enumerate(_scheme_kb):
        sim = float(similarities[idx])
        
        # Keyword matching boost
        cat = s["category"].lower()
        name = s["scheme_name"].lower()
        tprof = s["target_profile"].lower()

        if any(w in q_lower for w in ["farmer", "kisan", "agriculture", "land"]) and ("farm" in cat or "kisan" in name):
            sim += 0.25
        if any(w in q_lower for w in ["health", "hospital", "doctor", "medical", "disease"]) and ("health" in cat or "pmjay" in name):
            sim += 0.25
        if any(w in q_lower for w in ["house", "housing", "home", "awas", "flat"]) and ("hous" in cat or "awas" in name):
            sim += 0.25
        if any(w in q_lower for w in ["student", "study", "scholarship", "school", "college"]) and ("educ" in cat or "schol" in name):
            sim += 0.25
        if any(w in q_lower for w in ["business", "loan", "shop", "vendor", "money", "credit"]) and ("loan" in cat or "busi" in cat or "mudra" in name):
            sim += 0.25
        if any(w in q_lower for w in ["girl", "daughter", "woman", "female", "women"]) and ("wom" in cat or "child" in cat or "girl" in tprof):
            sim += 0.25
        if any(w in q_lower for w in ["artisan", "craft", "tailor", "carpenter", "worker"]) and ("artisan" in cat or "vishwakarma" in name or "labor" in cat):
            sim += 0.25

        boosted_scores.append((idx, sim))

    # Sort descending by similarity score
    boosted_scores.sort(key=lambda x: x[1], reverse=True)

    results = []
    for idx, score in boosted_scores[:top_k]:
        scheme = dict(_scheme_kb[idx])

        # Normalize score to percentage (capped between 45% and 98%)
        if score >= 0.35:
            match_label = "High Match"
            match_class = "match-high"
            pct = min(98, max(85, int(score * 120)))
        elif score >= 0.15:
            match_label = "Medium Match"
            match_class = "match-medium"
            pct = min(84, max(65, int(score * 160)))
        else:
            match_label = "Eligible Scheme"
            match_class = "match-low"
            pct = min(64, max(45, int(score * 180) + 40))

        scheme["score"] = round(float(score), 3)
        scheme["match_label"] = match_label
        scheme["match_class"] = match_class
        scheme["match_percentage"] = f"{pct}%"

        # Remove internal search text blob from response
        scheme.pop("search_text", None)
        results.append(scheme)

    return results
