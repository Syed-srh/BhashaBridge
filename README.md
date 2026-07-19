#  BhashaBridge

> **Breaking language barriers in welfare.**
> Government schemes, explained simply — in your language.

BhashaBridge is a Flask web app that takes any Indian government welfare scheme document (PDF, image, or URL) and transforms the dense bureaucratic text into a clear, plain-language explanation — translated into any of the 22 scheduled Indian languages.


Website:
Github link: 

---

##  The Problem It Solves

India has over 20,000 central and state welfare schemes covering agriculture, health, housing, education, and more. Most of these scheme documents are:
- Written in complex legal/bureaucratic English or Hindi
- Inaccessible to rural citizens with limited education
- Rarely available in regional languages

**BhashaBridge bridges that gap.** A farmer in Odisha or a homemaker in Tamil Nadu can now upload a scheme PDF, choose their language, and instantly understand:
- Am I eligible?
- What documents do I need?
- What will I get?
- How do I apply?

---

##  Features

| Feature | Description |
|---|---|
| 📄 **PDF Upload** | Extracts text from both digital and scanned PDFs |
| 🖼️ **Image / Photo Upload** | OCR via Tesseract — works with JPG, PNG, BMP, TIFF, WebP |
| 🔗 **URL Scraping** | Paste any government portal link (myscheme.gov.in, state portals) |
| 🤖 **AI Simplification** | Powered by Groq's `llama-3.3-70b-versatile` — explains at a Class-5 reading level |
| 🗣️ **22+ Indian Languages** | All scheduled languages including Hindi, Telugu, Tamil, Bengali, Kannada, and more |
| 🔊 **Text-to-Speech** | Read-aloud feature for each section using the Web Speech API |
| 🕓 **History** | Stores the last 20 processed documents in a local SQLite database |
| 📋 **Copy & Share** | One-click copy and share of results |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Python, Flask, Flask-CORS |
| **AI / LLM** | [Groq API](https://console.groq.com) — `llama-3.3-70b-versatile` |
| **OCR** | Tesseract OCR via `pytesseract` |
| **PDF Parsing** | `pdfplumber` (digital PDFs), `pdf2image` (scanned PDFs) |
| **Web Scraping** | `requests` + `BeautifulSoup4` |
| **Database** | SQLite (local, zero-config) |
| **Frontend** | Vanilla HTML, CSS, JavaScript |

---

##  Prerequisites

Before running BhashaBridge, ensure you have the following installed:

1. **Python 3.9+**
2. **Tesseract OCR** — [Download for Windows](https://github.com/UB-Mannheim/tesseract/wiki)
   - Default expected path: `C:\Program Files\Tesseract-OCR\tesseract.exe`
   - For Hindi OCR support, install the `hin` language pack during setup
3. **A Groq API Key** — Get one free at [console.groq.com](https://console.groq.com)

---

##  Getting Started

### 1. Clone the repository

```bash
<<<<<<< HEAD
git clone https://github.com/your-username/BhashaBridge.git
=======
git clone https://github.com/Syed-srh/BhashaBridge.git
>>>>>>> 3d7af1eb6cfbd67e2b73d0684d70637520293664
cd BhashaBridge
```

### 2. Create a virtual environment

```bash
python -m venv venv

# Windows
venv\Scripts\activate

# macOS / Linux
source venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Configure environment variables

Create a `.env` file in the project root (a template is provided):

```env
GROQ_API_KEY=your_groq_api_key_here
TESSERACT_PATH=C:\Program Files\Tesseract-OCR\tesseract.exe
```

> **Note:** `TESSERACT_PATH` is optional if Tesseract is installed at the default Windows location.

### 5. Run the app

```bash
python app.py
```

<<<<<<< HEAD
Open your browser and go to **http://localhost:5000**

=======
>>>>>>> 3d7af1eb6cfbd67e2b73d0684d70637520293664
---

## 📁 Project Structure

```
BhashaBridge/
├── app.py                  # Main Flask application & all API routes
├── requirements.txt        # Python dependencies
├── .env                    # Environment variables (not committed to git)
├── .gitignore
│
├── templates/
│   └── index.html          # Single-page frontend
│
├── static/
│   ├── style.css           # Main stylesheet
│   ├── responsive.css      # Mobile/responsive styles
│   ├── app.js              # Frontend logic (tabs, fetch, TTS, history)
│   └── images/
│       └── BhashaBridge Logo.png
│
└── db/
    └── results.db          # SQLite database (auto-created on first run)
```

---

##  API Reference

### `GET /api/languages`
Returns the list of all supported languages.

**Response:**
```json
[
  { "code": "en", "name": "English", "native": "English" },
  { "code": "hi", "name": "Hindi",   "native": "हिन्दी" },
  ...
]
```

---

### `POST /api/process`
Main endpoint — processes a document and returns a simplified explanation.

**Form Data:**

| Field | Type | Description |
|---|---|---|
| `file` | File | A PDF or image file (mutually exclusive with `url`) |
| `url` | String | A URL to a government scheme page (mutually exclusive with `file`) |
| `language` | String | Language code (e.g. `hi`, `te`, `ta`). Defaults to `en` |

**Success Response:**
```json
{
  "success": true,
  "source": "pm-kisan.pdf",
  "language": "hi",
  "eligibility": "...",
  "documents": "...",
  "benefit": "...",
  "how_to_apply": "...",
  "simplified_text": "..."
}
```

---

### `GET /api/history`
Returns the last 20 processed documents from the local database.

---

##  Supported Languages

All 22 constitutionally scheduled Indian languages plus English:

| | | | |
|---|---|---|---|
| English | Hindi (हिन्दी) | Telugu (తెలుగు) | Tamil (தமிழ்) |
| Bengali (বাংলা) | Marathi (मराठी) | Gujarati (ગુજરાતી) | Kannada (ಕನ್ನಡ) |
| Malayalam (മലയാളം) | Punjabi (ਪੰਜਾਬੀ) | Odia (ଓଡ଼ିଆ) | Assamese (অসমীয়া) |
| Urdu (اردو) | Maithili (मैथिली) | Konkani (कोंकणी) | Nepali (नेपाली) |
| Kashmiri (كٲشُر) | Sindhi (سنڌي) | Dogri (डोगरी) | Bodo (बड़ो) |
| Manipuri (মৈতৈলোন্) | Sanskrit (संस्कृत) | | |

---

##  How It Works

```
User Input (PDF / Image / URL)
        │
        ▼
Text Extraction
  ├─ PDF      → pdfplumber → (fallback) Tesseract OCR via pdf2image
  ├─ Image    → Tesseract OCR (eng+hin)
  └─ URL      → requests + BeautifulSoup (strips nav/footer/scripts)
        │
        ▼
LLM Processing (Groq — llama-3.3-70b-versatile)
  • System prompt: "You are BhashaBridge. Explain like a trusted friend..."
  • Extracts: eligibility, documents, benefit, how_to_apply, simplified_text
  • Translates entire output into the chosen language
        │
        ▼
Result saved to SQLite → JSON returned to frontend → Displayed to user
```

---

##  Contributing

Contributions are welcome! Some ideas for improvement:

- [ ] Add support for more file formats (DOCX, HTML)
- [ ] Integrate Bharat TTS for native Indian language audio
- [ ] Add scheme category tagging (health, agriculture, education…)
- [ ] Build a mobile-first PWA version
- [ ] Add user accounts and saved scheme history

---

##  License

This project is open source and available under the [MIT License](LICENSE).

---

##  Acknowledgements

- [Groq](https://groq.com) for blazing-fast LLM inference
- [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) for open-source OCR
- [pdfplumber](https://github.com/jsvine/pdfplumber) for excellent PDF text extraction
- India's National Informatics Centre for making scheme data publicly available

---

<div align="center">
  <strong>BhashaBridge — Built for India. Made for India.</strong>
</div>
