# 🌉 BhashaBridge (भाषाब्रिज)

> **Breaking Language & Bureaucratic Barriers in Indian Public Welfare.**  
> *Upload any complex government scheme document, image, or website link — receive a clear, plain-language explanation in your mother tongue with actionable checklists, eligibility checks, and verified source citations.*

---

[![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-blue.svg)](https://www.python.org/)
[![Flask](https://img.shields.io/badge/Framework-Flask-green.svg)](https://flask.palletsprojects.com/)
[![Groq LLM](https://img.shields.io/badge/AI-Groq%20Compound%20%7C%20GPT--OSS-orange.svg)](https://console.groq.com/)
[![Speech STT/TTS](https://img.shields.io/badge/Voice-WebSpeech%20%2B%20Whisper--v3-purple.svg)](https://groq.com)
[![Languages](https://img.shields.io/badge/Languages-22%20Scheduled%20Indian-brightgreen.svg)](#-supported-languages)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-bhashabridge--roqp.onrender.com-blue)](https://bhashabridge-roqp.onrender.com)

---

## 📌 Problem & Impact

India offers over 20,000 central and state welfare schemes targeting farmers, women, students, artisans, and low-income families. However, most official scheme documents are written in dense legalistic jargon in English or Hindi, creating an immense information barrier for citizens.

**BhashaBridge bridges this gap.** A farmer in Odisha or a student in Tamil Nadu can upload a scheme PDF or paste a URL and receive an instant breakdown answering:
1. **What is this scheme?** (Class-5 plain-language summary)
2. **Who can apply?** (Interactive eligibility rules evaluation)
3. **What do I get?** (Key financial & non-financial benefits)
4. **What do I need?** (Interactive document checklist)
5. **How do I apply?** (Numbered step-by-step action guide)
6. **Is this verified?** (RAG source citations with confidence badges & verbatim document excerpts)

---

## 🏗️ Technical Architecture (6 Core Pipeline Layers)

BhashaBridge is built on a modular 6-layer architecture designed for accuracy, speed, and trust:

```
                  ┌────────────────────────────────────────┐
                  │ 1. Multi-modal Ingestion Pipeline      │
                  │   (Text PDFs, Scanned Images, URLs)    │
                  └──────────────────┬─────────────────────┘
                                     │
                  ┌──────────────────▼─────────────────────┐
                  │ 2. 3-Step LLM Simplification Engine     │
                  │   Extract ➔ Simplify ➔ Translate       │
                  └──────────────────┬─────────────────────┘
                                     │
       ┌─────────────────────────────┼─────────────────────────────┐
       │                             │                             │
┌──────▼────────────────┐ ┌──────────▼───────────────┐ ┌──────────▼───────────────┐
│ 3. Scheme Rec Engine  │ │ 4. Eligibility Checker  │ │ 5. RAG Verification   │
│ (TF-IDF / pgvector)   │ │ (Rule Evaluator & Guide)│ │ (Chunks & Citations)  │
└───────────────────────┘ └─────────────────────────┘ └─────────────────────────┘
                                     │
                  ┌──────────────────▼─────────────────────┐
                  │ 6. Multi-lingual Voice Interface       │
                  │ (STT Input + TTS Readout + Fallbacks)  │
                  └────────────────────────────────────────┘
```

### 📄 Layer 1: Document Ingestion Pipeline (`ingestion.py`)
- **Text PDFs**: Direct high-speed text extraction via `pdfplumber` / `pypdf`.
- **Scanned PDFs & Images**: Optical Character Recognition (OCR) using `pytesseract` + `pdf2image` + `PIL` supporting `.jpg`, `.png`, `.bmp`, `.tiff`, and `.webp`.
- **Web Scraping**: Custom portal scraper (`requests` + `BeautifulSoup4`) removing navigation, boilerplate, and scripts to extract main article text.
- **Normalization**: Language detection via `langdetect` and normalization into a single clean UTF-8 text string.

### 🤖 Layer 2: 3-Step LLM Simplification Pipeline (`llm_pipeline.py`)
Separated into independently loggable, debuggable functions:
1. `extract_structured_fields(text)`: Extracts structured JSON with strict schema validation (`scheme_name`, `eligibility`, `benefits`, `documents_required`, `application_process`, `restrictions`).
2. `simplify(structured_fields)`: Rewrites technical/bureaucratic terminology into plain language at a 5th-grade reading level.
3. `translate(simplified_fields, target_language)`: Translates plain-language fields into the user's selected Indian language.
- **Model Fallback Chain**: Auto-fallback across `groq/compound` ➔ `openai/gpt-oss-120b` ➔ `llama-3.3-70b-versatile` with JSON fence stripping and sentinel fallbacks.

### 🎯 Layer 3: Scheme Recommendation Engine (`recommendation_engine.py`)
- **Curated Knowledge Base**: Pre-seeded with 12 major Indian welfare schemes (`PM-KISAN`, `Ayushman Bharat`, `PMAY`, `PM-SVANidhi`, `PM-Vishwakarma`, `Sukanya Samriddhi`, etc.).
- **Vector Search Engine**: TF-IDF Vectorizer + Cosine Similarity matching over scheme embeddings.
- **`GET /recommendations` API**: Accepts free-text queries (e.g. *"I am a farmer looking for financial support"*) or user demographic profiles (`age`, `location`, `occupation`, `income`), returning matching schemes tagged with match levels (High/Medium/Low) and percentage scores.

### ✅ Layer 4: Eligibility Checker & Action Guidance (`eligibility_checker.py`)
- **Rule-Based Criterion Evaluator**: Evaluates user profiles against extracted eligibility requirements, returning granular per-criterion states: `matched` (🟢), `possible` (🟡), or `not_found` (❌).
- **Action Guide Builder**: Converts extracted document requirements into interactive checkboxes and application procedures into numbered step-by-step guides.

### 🛡️ Layer 5: RAG Trust & Verification System (`rag_retriever.py`)
- **Semantic Document Chunking**: Segments source documents into overlapping semantic text chunks.
- **RAG Retriever**: Passes only relevant source chunks to the LLM to prevent hallucinations.
- **Field Confidence Classification**: Computes field confidence labels:
  - `High Confidence (Verbatim Source)` 🟢: Field supported verbatim in a retrieved chunk.
  - `Medium Confidence (Paraphrased Context)` 🟡: Field inferred/paraphrased from retrieved context.
  - `⚠ Not found in document` 🔴: Information unavailable in the source document.
- **Interactive UI Citations**: Renders collapsible *"Show Source"* citation toggles on every card displaying verbatim chunk text and relevance percentages.

### 🎙️ Layer 6: Voice Interface (STT & TTS) (`voice_handler.py`)
- **Speech-to-Text (STT)**: Voice search using Web Speech API + `POST /api/stt` fallback powered by Groq's `whisper-large-v3-turbo` model.
- **Text-to-Speech (TTS)**: Web Speech API synthesis using exact BCP-47 locale tags (`hi-IN`, `te-IN`, `ta-IN`, `bn-IN`, `en-IN`, etc.).
- **Graceful Fallback Flag**: Exposes `voice_supported: false` flag for languages without reliable voice engines (e.g., Sanskrit, Maithili, Konkani), gracefully disabling voice controls instead of failing.

---

## 🗄️ Database Schema & API Reference

### Database Tables (`schema.sql` & SQLite `db/results.db`)

- **`uploaded_documents`**: Upload metadata, URL, page count, language, extraction status.
- **`scheme_knowledge_base`**: Scheme records with `pgvector` similarity embedding column (`vector(384)`).
- **`user_profiles`**: Demographic profile records (`age`, `location`, `occupation`, `income`).
- **`feedback_logs`**: User ratings (thumbs up/down) and comments tagged by pipeline stage.
- **`previously_explained`**: Full explanation history indexed by `job_id`.

### REST Endpoints

| Clean Endpoint | Method | Description |
|---|---|---|
| `POST /ingest` | `POST` | Accepts file or URL input, creates job record, returns `{ "jobId": "job-xxx", "status": "processing" }` |
| `GET /status/:jobId` | `GET` | Server-Sent Events (SSE) streaming live progress events (`Reading`, `Finding`, `Simplifying`, `Preparing`, `complete`) |
| `GET /explanation/:jobId` | `GET` | Retrieves full explanation payload & citations for a given `jobId` |
| `POST /eligibility` | `POST` | Per-criterion eligibility rule evaluation |
| `GET /recommendations` | `GET`, `POST` | Top-K vector scheme recommendations |
| `POST /feedback` | `POST` | Submits thumbs up/down & stage-tagged feedback |
| `GET /history` | `GET` | Retrieves previously explained document history |
| `POST /api/stt` | `POST` | Transcribes recorded audio blobs via Groq Whisper |
| `GET /api/languages` | `GET` | Returns list of all 22 scheduled languages with voice capability flags |

---

## 🌐 Supported Languages

BhashaBridge supports all 22 constitutionally scheduled Indian languages plus English:

| Language | Native Script | Voice Support | BCP-47 Tag |
|---|---|---|---|
| English | English | 🎙️ STT & TTS | `en-IN` |
| Hindi | हिन्दी | 🎙️ STT & TTS | `hi-IN` |
| Telugu | తెలుగు | 🎙️ STT & TTS | `te-IN` |
| Tamil | தமிழ் | 🎙️ STT & TTS | `ta-IN` |
| Bengali | বাংলা | 🎙️ STT & TTS | `bn-IN` |
| Marathi | मराठी | 🎙️ STT & TTS | `mr-IN` |
| Gujarati | ગુજરાતી | 🎙️ STT & TTS | `gu-IN` |
| Kannada | ಕನ್ನಡ | 🎙️ STT & TTS | `kn-IN` |
| Malayalam | മലയാളം | 🎙️ STT & TTS | `ml-IN` |
| Punjabi | ਪੰਜਾਬੀ | 🎙️ STT & TTS | `pa-IN` |
| Odia | ଓଡ଼ିଆ | 🎙️ STT & TTS | `or-IN` |
| Urdu | اردو | 🎙️ STT & TTS | `ur-IN` |
| Nepali | नेपाली | 🎙️ STT & TTS | `ne-NP` |
| Maithili | मैथिली | 📝 Text Only | `hi-IN` |
| Konkani | कोंकणी | 📝 Text Only | `kok-IN` |
| Kashmiri | كٲشُر | 📝 Text Only | `ks-IN` |
| Sindhi | سنڌي | 📝 Text Only | `sd-IN` |
| Dogri | डोगरी | 📝 Text Only | `hi-IN` |
| Bodo | बड़ो | 📝 Text Only | `hi-IN` |
| Manipuri | মৈতৈলোন্ | 📝 Text Only | `mni-IN` |
| Sanskrit | संस्कृत | 📝 Text Only | `sa-IN` |

---

## 🚀 Quickstart & Installation

### Prerequisites
- **Python 3.11+**
- **Tesseract OCR**: Download and install [Tesseract OCR for Windows](https://github.com/UB-Mannheim/tesseract/wiki) (Default path: `C:\Program Files\Tesseract-OCR\tesseract.exe`).
- **Groq API Key**: Get a free API key at [console.groq.com](https://console.groq.com).

### Step-by-Step Setup

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/Syed-srh/BhashaBridge.git
   cd BhashaBridge
   ```

2. **Create & Activate Virtual Environment**:
   ```bash
   python -m venv venv

   # Windows
   venv\Scripts\activate

   # macOS / Linux
   source venv/bin/activate
   ```

3. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure Environment Variables**:
   Create a `.env` file in the project root:
   ```env
   GROQ_API_KEY=your_groq_api_key_here
   TESSERACT_PATH=C:\Program Files\Tesseract-OCR\tesseract.exe
   ```

5. **Run the Server**:
   ```bash
   python app.py
   ```

6. **Open in Browser**:
   Navigate to [http://127.0.0.1:5000](http://127.0.0.1:5000)

---

## 📁 Repository Layout

```
BhashaBridge/
├── app.py                      # Flask Application Server & Clean REST API Routes
├── ingestion.py                # Layer 1: Multi-modal Document Ingestion & OCR
├── llm_pipeline.py             # Layer 2: 3-Step LLM Extraction, Simplification & Translation
├── recommendation_engine.py    # Layer 3: Vector Similarity Scheme Recommendation Engine
├── eligibility_checker.py      # Layer 4: Rule-based Eligibility Evaluator & Action Guide
├── rag_retriever.py            # Layer 5: Semantic Chunking, RAG Retriever & Citations
├── voice_handler.py            # Layer 6: Voice Interface (STT/TTS & Groq Whisper)
├── schema.sql                  # Master Postgres / Supabase Database Schema
├── requirements.txt            # Python Dependencies
├── .env                        # Environment Configuration
│
├── templates/
│   └── index.html              # Responsive Frontend SPA Template
│
├── static/
│   ├── style.css               # Main CSS Stylesheet & Modern Dark Theme System
│   ├── responsive.css          # Mobile / Tablet Responsive Overrides
│   ├── app.js                  # Frontend Application Logic & Event Handlers
│   └── images/
│       └── BhashaBridge Logo.png
│
└── db/
    └── results.db              # SQLite Local Database Store
```

---

## 🤝 Contributing & License

Contributions are welcome! Please feel free to submit a Pull Request or open an Issue.  
Licensed under the [MIT License](LICENSE).
