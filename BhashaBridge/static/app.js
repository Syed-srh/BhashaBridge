/*
 * BhashaBridge — Frontend Logic
 *
 * What this file handles:
 *  - Loading languages from the backend and building the language picker
 *  - Letting users switch between file-upload and URL modes
 *  - Drag-and-drop file handling
 *  - Submitting to the Flask backend and showing live progress steps
 *  - Rendering results into the four info cards
 *  - Text-to-speech via the browser's built-in speechSynthesis API
 *  - Loading and displaying query history
 *  - Copy / Share buttons
 *  - Toast notifications for errors
 */

// We keep a reference to the current result so the voice button can read it
let currentResult = null;
let selectedLanguageCode = "en";
let selectedFile = null;

// speechSynthesis state
let activeSpeech = null;
let activeSpeechBtn = null;

const API_BASE = "https://bhashabridge-roqp.onrender.com";

// Boot: run once the page is ready

document.addEventListener("DOMContentLoaded", () => {
  loadLanguages();
  loadHistory();
  setupModeTabs();
  setupDropZone();
  setupFormActions();
  setupResultButtons();
});

// Language picker

async function loadLanguages() {
  try {
    const resp = await fetch(`${API_BASE}/api/languages`);
    const langs = await resp.json();
    buildLanguageGrid(langs);
  } catch {
    // If backend isn't running yet, show a small offline notice
    const grid = document.getElementById("lang-grid");
    grid.innerHTML = `<p style="color:var(--text-muted);font-size:var(--text-sm);grid-column:1/-1">
      Start the backend (python app.py) to load languages.
    </p>`;
  }
}

function buildLanguageGrid(languages) {
  const grid = document.getElementById("lang-grid");
  grid.innerHTML = "";

  // RTL language codes: Urdu, Kashmiri, Sindhi use Arabic script
  const RTL_LANG_CODES = new Set(['ur', 'ks', 'sd']);

  languages.forEach(lang => {
    const btn = document.createElement("button");
    btn.className = "lang-btn" + (lang.code === "en" ? " selected" : "");
    btn.dataset.code = lang.code;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", lang.code === "en" ? "true" : "false");
    btn.setAttribute("aria-label", `${lang.name} — ${lang.native}`);

    // RTL: Arabic-script languages need dir=rtl on the button
    if (RTL_LANG_CODES.has(lang.code)) {
      btn.setAttribute('dir', 'rtl');
    }

    btn.innerHTML = `
      <span class="lang-native">${lang.native}</span>
      <span class="lang-english">${lang.name}</span>
      <span class="lang-transition-badge" aria-hidden="true">en ➔ ${lang.code}</span>
    `;

    btn.addEventListener("click", () => {
      // Deselect all, select this one
      grid.querySelectorAll(".lang-btn").forEach(b => {
        b.classList.remove("selected");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("selected");
      btn.setAttribute("aria-checked", "true");
      selectedLanguageCode = lang.code;

      // Announce to screen readers via aria-live region
      const announcer = document.getElementById("lang-selection-announce");
      if (announcer) {
        announcer.textContent = `${lang.name} selected`;
      }
    });

    grid.appendChild(btn);
  });
}

// Mode tabs (File upload vs URL)

function setupModeTabs() {
  const tabs = document.querySelectorAll(".mode-tab");

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const panelId = "panel-" + tab.dataset.panel;

      // Update tab states
      const parent = tab.closest(".mode-tabs");
      if (parent) {
        if (tab.dataset.panel === "url") {
          parent.classList.add("url-active");
        } else {
          parent.classList.remove("url-active");
        }
      }

      tabs.forEach(t => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");

      // Show the right panel
      document.querySelectorAll(".input-panel").forEach(p => p.classList.remove("active"));
      document.getElementById(panelId).classList.add("active");

      // Reset file/url state when switching
      selectedFile = null;
      document.getElementById("file-info").classList.remove("visible");
      document.getElementById("url-input").value = "";
      updateSubmitButton();
    });
  });
}

// Drop zone (file upload)

function setupDropZone() {
  const zone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");

  // Keyboard accessibility: pressing Enter or Space on the zone opens the picker
  zone.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  // Track drag events window-wide to toggle ".dragging" state (Document detected)
  let dragCounter = 0;

  window.addEventListener("dragenter", e => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
      zone.classList.add("dragging");
    }
  });

  window.addEventListener("dragleave", e => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
      zone.classList.remove("dragging");
    }
  });

  window.addEventListener("dragover", e => {
    e.preventDefault();
  });

  window.addEventListener("drop", e => {
    e.preventDefault();
    dragCounter = 0;
    zone.classList.remove("dragging", "dragover");
  });

  // Drag over drop-zone specifically (HOVER state: "Release to understand it")
  zone.addEventListener("dragenter", e => {
    e.preventDefault();
    zone.classList.add("dragover");
  });

  zone.addEventListener("dragover", e => {
    e.preventDefault();
    zone.classList.add("dragover");
  });

  zone.addEventListener("dragleave", () => {
    zone.classList.remove("dragover");
  });

  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("dragover", "dragging");
    const files = e.dataTransfer.files;
    if (files.length > 0) handleFileSelected(files[0]);
  });

  // Normal file picker
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) handleFileSelected(fileInput.files[0]);
  });

  // URL input — enable button as soon as there's a URL
  document.getElementById("url-input").addEventListener("input", updateSubmitButton);
}

function handleFileSelected(file) {
  const allowed = ["application/pdf", "image/jpeg", "image/png", "image/bmp", "image/tiff", "image/webp"];
  if (!allowed.includes(file.type) && !file.name.toLowerCase().endsWith(".pdf")) {
    showToast("Please upload a PDF or an image file (JPG, PNG, etc.)");
    return;
  }

  selectedFile = file;

  // Show file name
  const nameDisplay = document.getElementById("file-name-display");
  const info = document.getElementById("file-info");
  nameDisplay.textContent = file.name + " (" + formatFileSize(file.size) + ")";
  info.classList.add("visible");

  updateSubmitButton();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function updateSubmitButton() {
  const btn = document.getElementById("btn-submit");
  const hasFile = selectedFile !== null;
  const hasUrl  = document.getElementById("url-input").value.trim().length > 5;
  btn.disabled = !(hasFile || hasUrl);
}

// Form submission

function setupFormActions() {
  document.getElementById("btn-submit").addEventListener("click", handleSubmit);
}

async function handleSubmit() {
  const urlValue = document.getElementById("url-input").value.trim();
  const activePanel = document.querySelector(".input-panel.active").id;

  // Build form data
  const formData = new FormData();
  formData.append("language", selectedLanguageCode);

  if (activePanel === "panel-url" && urlValue) {
    formData.append("url", urlValue);
  } else if (selectedFile) {
    formData.append("file", selectedFile);
  } else {
    showToast("Please upload a file or paste a link first.");
    return;
  }

  // Hide results, show progress
  document.getElementById("results-section").classList.remove("visible");
  showProgress();

  // Set up visual preview in progress background for continuity
  const previewWrap = document.getElementById("progress-preview-wrap");
  if (previewWrap) {
    previewWrap.innerHTML = "";
    if (activePanel === "panel-url" && urlValue) {
      previewWrap.innerHTML = `
        <div style="text-align: center; color: var(--text-secondary); opacity: 0.45; transform: scale(1.05);">
          <i class="fa-solid fa-globe" style="font-size: 5rem; margin-bottom: var(--s4); color: var(--blue)"></i>
          <p style="font-size: var(--t-sm); font-weight: 600; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0 auto;">${escapeHtml(urlValue)}</p>
        </div>
      `;
    } else if (selectedFile) {
      if (selectedFile.type.startsWith("image/")) {
        try {
          const imgUrl = URL.createObjectURL(selectedFile);
          previewWrap.innerHTML = `
            <img src="${imgUrl}" alt="Document Preview" style="max-height: 240px; border-radius: var(--r-md); box-shadow: var(--shadow-lg); opacity: 0.65; filter: blur(2px);">
          `;
        } catch(e) {
          previewWrap.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); opacity: 0.45;">
              <i class="fa-solid fa-file-image" style="font-size: 5rem; margin-bottom: var(--s4); color: var(--green)"></i>
              <p style="font-size: var(--t-sm); font-weight: 600; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0 auto;">${escapeHtml(selectedFile.name)}</p>
            </div>
          `;
        }
      } else {
        previewWrap.innerHTML = `
          <div style="text-align: center; color: var(--text-secondary); opacity: 0.45;">
            <i class="fa-solid fa-file-pdf" style="font-size: 5.5rem; margin-bottom: var(--s4); color: #EF4444"></i>
            <p style="font-size: var(--t-sm); font-weight: 600; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0 auto;">${escapeHtml(selectedFile.name)}</p>
          </div>
        `;
      }
    }
  }

  // Disable button during processing
  const btn = document.getElementById("btn-submit");
  btn.disabled = true;
  btn.classList.add("processing");

  try {
    const resp = await fetch(`${API_BASE}/api/process`, {
      method: "POST",
      body: formData,
    });

    const data = await resp.json();

    if (!resp.ok || data.error) {
      throw new Error(data.error || "Something went wrong. Please try again.");
    }

    markAllStepsDone();

    // Show SUCCESS state briefly
    btn.classList.remove("processing");
    btn.classList.add("success");

    // Small pause so the user sees the "Done!" step and success state
    await sleep(900);

    currentResult = data;
    renderResults(data);
    loadHistory(); // Refresh history after a new result

  } catch (err) {
    hideProgress();
    showToast(err.message);
  } finally {
    btn.classList.remove("processing", "success");
    btn.disabled = false;
  }
}

// Progress animation

const STEPS = ["step-read", "step-understand", "step-translate", "step-done"];

// Human-readable labels for aria-live announcements
const STEP_LABELS = [
  "Step 1 of 4: Reading your document",
  "Step 2 of 4: Finding key information",
  "Step 3 of 4: Simplifying the language",
  "Step 4 of 4: Preparing your explanation",
];

// Update progress track bar (0–100%) + step counter number
function updateProgressTrack(stepIndex) {
  const bar = document.getElementById("progress-track-bar");
  const num = document.getElementById("progress-step-num");
  if (bar) bar.style.width = ((stepIndex + 1) / STEPS.length * 100) + "%";
  if (num) num.textContent = stepIndex + 1;
}

// Write to the dedicated aria-live announcer so screen readers hear each stage
function announceProgressStep(label) {
  const announcer = document.getElementById("progress-step-announcer");
  if (!announcer) return;
  // Clear first so repeat announces always fire (needed for aria-atomic)
  announcer.textContent = "";
  // rAF ensures the DOM change registers as a new live update
  requestAnimationFrame(() => { announcer.textContent = label; });
}

function showProgress() {
  const section = document.getElementById("progress-section");
  section.classList.add("visible");

  // Reset all steps and track
  STEPS.forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove("active", "done");
  });
  const bar = document.getElementById("progress-track-bar");
  if (bar) bar.style.width = "0%";
  const num = document.getElementById("progress-step-num");
  if (num) num.textContent = "1";

  // Announce first step immediately
  announceProgressStep(STEP_LABELS[0]);

  // Animate through steps
  animateStep(0);
}

function animateStep(index) {
  if (index >= STEPS.length - 1) return; // Don't auto-advance to "done"

  const el = document.getElementById(STEPS[index]);
  el.classList.add("active");

  // Drive visual track + step counter
  updateProgressTrack(index);

  // Each step stays visible for 1.4s, then "completes"
  setTimeout(() => {
    el.classList.remove("active");
    el.classList.add("done");

    // Start next step (except the last one which waits for real completion)
    if (index + 1 < STEPS.length - 1) {
      announceProgressStep(STEP_LABELS[index + 1]);
      animateStep(index + 1);
    }
  }, 1400);
}

function markAllStepsDone() {
  STEPS.forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove("active");
    el.classList.add("done");
  });
  // Fill track to 100% and announce completion
  const bar = document.getElementById("progress-track-bar");
  if (bar) bar.style.width = "100%";
  const num = document.getElementById("progress-step-num");
  if (num) num.textContent = "4";
  announceProgressStep("Explanation ready. Showing results.");
}

function hideProgress() {
  document.getElementById("progress-section").classList.remove("visible");
  STEPS.forEach(id => {
    document.getElementById(id).classList.remove("active", "done");
  });
}

// Rendering results

function formatContent(text) {
  if (!text) return "";

  // Escape HTML tags to prevent XSS while keeping original content intact
  let escaped = escapeHtml(text);

  // Highlight money amounts (Rupees / ₹ / Rs.)
  let formatted = escaped.replace(/(₹\s?\d+[\d,]*|Rs\.?\s?\d+[\d,]*\s?(Lakh|Lakhs|Crore|Crores)?|\b\d+[\d,]*\s?(Rupees|rupees)\b)/gi, match => {
    return `<span class="bb-highlight-green">${match}</span>`;
  });

  // Highlight age limits/caps
  formatted = formatted.replace(/(\b\d+\s?(years|years of age|yrs)\b|age of\s?\d+|\babove\s?\d+\b|\bbelow\s?\d+\b)/gi, match => {
    return `<span class="bb-highlight-blue">${match}</span>`;
  });

  // Highlight deadlines/dates
  formatted = formatted.replace(/(\b\d{1,2}(st|nd|rd|th)?\s(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s\d{1,2}\b|\b\d{2}[-/\.]\d{2}[-/\.]\d{4}\b)/gi, match => {
    return `<span class="bb-highlight">${match}</span>`;
  });

  // Format bullet lists and ordered lists
  const lines = formatted.split("\n");
  let insideUl = false;
  let insideOl = false;
  let html = "";

  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const isBullet = /^[•\-\*]\s*(.*)/.test(trimmed);
    const isNumber = /^\d+[\.\)]\s*(.*)/.test(trimmed);

    if (isBullet) {
      const content = trimmed.replace(/^[•\-\*]\s*/, "");
      if (insideOl) { html += "</ol>"; insideOl = false; }
      if (!insideUl) { html += "<ul>"; insideUl = true; }
      html += `<li>${content}</li>`;
    } else if (isNumber) {
      const content = trimmed.replace(/^\d+[\.\)]\s*/, "");
      if (insideUl) { html += "</ul>"; insideUl = false; }
      if (!insideOl) { html += "<ol>"; insideOl = true; }
      html += `<li>${content}</li>`;
    } else {
      if (insideUl) { html += "</ul>"; insideUl = false; }
      if (insideOl) { html += "</ol>"; insideOl = false; }
      html += `<p style="margin-bottom: var(--s2)">${trimmed}</p>`;
    }
  });

  if (insideUl) html += "</ul>";
  if (insideOl) html += "</ol>";

  return html;
}

function populateImportantCard(data) {
  const el = document.getElementById("result-important");
  if (!el) return;

  const textToScan = [data.eligibility, data.documents, data.benefit, data.how_to_apply].join(" ");
  
  // Generic important civic advice
  let items = [
    "Ensure your <strong>Aadhaar card</strong> is linked to your active bank account for direct benefit transfer (DBT).",
    "Never pay any fee to middlemen or brokers. This service is <strong>completely free</strong>."
  ];

  // Income cap check
  const incomeMatch = textToScan.match(/(income\s?(limit|cap)?\sof\s?Rs\.\s?\d+[\d,]*|income\s?below\s?Rs\.\s?\d+[\d,]*|income\s?less\s?than\s?Rs\.\s?\d+[\d,]*)/i);
  if (incomeMatch) {
    items.push(`Income cap detected: <span class="bb-highlight">${incomeMatch[0]}</span>.`);
  }

  // Age limit check
  const ageMatch = textToScan.match(/(\bage\s?limit\b|\bunder\s?\d+\s?years\b|\babove\s?\d+\s?years\b)/i);
  if (ageMatch) {
    items.push(`Age eligibility rule: Verify that you are <span class="bb-highlight-blue">${ageMatch[0]}</span> before applying.`);
  }

  // Deadline check
  const deadlineMatch = textToScan.match(/(deadline|last date|apply before|due date|expiry)/i);
  if (deadlineMatch) {
    items.push("Pay close attention to the application deadline. Apply early to avoid server failure.");
  }

  let html = "<ul>";
  items.forEach(item => {
    html += `<li>${item}</li>`;
  });
  html += "</ul>";

  el.innerHTML = html;
}

function renderResults(data) {
  // Fill in the 6 info cards
  document.getElementById("result-summary").innerHTML = formatContent(data.simplified_text || "");
  document.getElementById("result-eligibility").innerHTML = formatContent(data.eligibility  || "");
  document.getElementById("result-documents").innerHTML  = formatContent(data.documents     || "");
  document.getElementById("result-benefit").innerHTML    = formatContent(data.benefit       || "");
  document.getElementById("result-apply").innerHTML      = formatContent(data.how_to_apply  || "");
  
  // Populate Card 6
  populateImportantCard(data);

  // Source label
  const src = data.source || "Untitled document";
  document.getElementById("result-source-label").textContent =
    "Source: " + (src.length > 70 ? src.slice(0, 67) + "…" : src);

  // Hide progress, reveal results
  hideProgress();
  const section = document.getElementById("results-section");
  section.classList.add("visible");

  // Scroll smoothly to results
  setTimeout(() => {
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 100);
}

// Text-to-Speech

/*
 * Speaks the given text. If speech is already playing, stops it.
 * The btn parameter is the button that was clicked — we toggle its style.
 */
function speak(text, btn) {
  // If we're already speaking, stop
  if (activeSpeech && window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    resetVoiceButton(activeSpeechBtn, false);

    // If the same button was clicked again, just stop (toggle off)
    if (activeSpeechBtn === btn) {
      activeSpeech = null;
      activeSpeechBtn = null;
      return;
    }
  }

  const utterance = new SpeechSynthesisUtterance(text);

  // Try to match language to speech synthesis voice
  const langMap = {
    "hi": "hi-IN", "te": "te-IN", "ta": "ta-IN", "bn": "bn-IN",
    "mr": "mr-IN", "gu": "gu-IN", "kn": "kn-IN", "ml": "ml-IN",
    "pa": "pa-IN", "ur": "ur-IN", "en": "en-IN",
  };
  utterance.lang = langMap[selectedLanguageCode] || "en-IN";
  utterance.rate = 0.88;    // Slightly slower for clarity
  utterance.pitch = 1.0;

  utterance.onstart = () => {
    activeSpeech = utterance;
    activeSpeechBtn = btn;
    setSpeaking(btn, true);
  };

  utterance.onend = () => {
    setSpeaking(btn, false);
    activeSpeech = null;
    activeSpeechBtn = null;
  };

  utterance.onerror = () => {
    setSpeaking(btn, false);
    activeSpeech = null;
    activeSpeechBtn = null;
  };

  window.speechSynthesis.speak(utterance);
}

function setSpeaking(btn, isSpeaking) {
  if (!btn) return;
  if (isSpeaking) {
    btn.classList.add("speaking");
  } else {
    btn.classList.remove("speaking");
  }
  // Update icon/text for the main voice button specifically
  if (btn.id === "btn-voice-all") {
    const iconEl = document.getElementById("voice-all-icon");
    if (iconEl) {
      iconEl.innerHTML = isSpeaking
        ? '<i class="fa-solid fa-stop" aria-hidden="true"></i>'
        : '<i class="fa-solid fa-volume-high" aria-hidden="true"></i>';
    }
    document.getElementById("voice-all-text").textContent = isSpeaking ? "Stop" : "Read Aloud";
  }
}

function resetVoiceButton(btn, speaking) {
  if (!btn) return;
  setSpeaking(btn, speaking);
}

function buildFullText(result) {
  // Concatenate everything in a natural order for "read all"
  return [
    result.simplified_text,
    "Eligibility: " + result.eligibility,
    "Documents needed: " + result.documents,
    "What you will get: " + result.benefit,
    "How to apply: " + result.how_to_apply,
  ].filter(Boolean).join(". ");
}

// Result buttons (voice, copy, share, new)

function setupResultButtons() {
  // Main "read aloud" button
  document.getElementById("btn-voice-all").addEventListener("click", function () {
    if (!currentResult) return;
    speak(buildFullText(currentResult), this);
  });

  // Per-card voice buttons
  const fieldMap = {
    "eligibility": "result-eligibility",
    "documents":   "result-documents",
    "benefit":     "result-benefit",
    "apply":       "result-apply",
  };

  document.querySelectorAll(".btn-card-voice").forEach(btn => {
    btn.addEventListener("click", function () {
      const field = this.dataset.field;
      const text = document.getElementById(fieldMap[field])?.textContent || "";
      if (!text) return;
      speak(text, this);
    });
  });

  // Copy to clipboard
  document.getElementById("btn-copy").addEventListener("click", async function () {
    if (!currentResult) return;
    try {
      await navigator.clipboard.writeText(buildFullText(currentResult));
      const orig = this.textContent;
      this.textContent = "Copied!";
      setTimeout(() => { this.textContent = orig; }, 2000);
    } catch {
      showToast("Could not copy. Try selecting the text manually.");
    }
  });

  // Share via Web Share API (works on mobile)
  document.getElementById("btn-share").addEventListener("click", async function () {
    if (!currentResult) return;
    const shareData = {
      title: "Government Scheme — BhashaBridge",
      text: buildFullText(currentResult),
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch { /* user cancelled */ }
    } else {
      // Fallback: copy the text
      try {
        await navigator.clipboard.writeText(shareData.text);
        showToast("Link copied! Share it with someone who needs it.", "success");
      } catch {
        showToast("Sharing is not supported in this browser.");
      }
    }
  });

  // "Try Another Document" button
  document.getElementById("btn-new").addEventListener("click", () => {
    // Stop any running speech
    if (window.speechSynthesis.speaking) window.speechSynthesis.cancel();

    // Reset UI
    currentResult = null;
    selectedFile = null;
    document.getElementById("results-section").classList.remove("visible");
    document.getElementById("file-info").classList.remove("visible");
    document.getElementById("url-input").value = "";
    document.getElementById("file-input").value = "";
    document.getElementById("btn-submit").disabled = true;
    hideProgress();

    // Scroll back to input
    document.querySelector(".input-section").scrollIntoView({ behavior: "smooth" });
  });

  // History refresh
  document.getElementById("btn-refresh-history").addEventListener("click", loadHistory);
}

// History

async function loadHistory() {
  const list = document.getElementById("history-list");

  try {
    const resp = await fetch(`${API_BASE}/api/history`);
    const items = await resp.json();

    if (!items.length) {
      list.innerHTML = `
        <div class="history-empty">
           No past searches yet. Try explaining your first scheme!
        </div>`;
      return;
    }

    list.innerHTML = "";
    items.forEach((item, index) => {
      list.appendChild(buildHistoryItem(item, index));
    });

  } catch {
    list.innerHTML = `
      <div class="history-empty">
        History will appear here after you process your first document.
      </div>`;
  }
}

function buildHistoryItem(item, index = 0) {
  const el = document.createElement("div");
  el.className = "history-item";
  el.setAttribute("role", "listitem");

  // Stagger the card entrance animation
  el.style.animationDelay = `${index * 0.07}s`;

  const isUrl      = item.source && item.source.startsWith("http");
  const badgeClass = isUrl ? "icon-url" : "icon-file";
  const iconClass  = isUrl ? "fa-solid fa-link" : "fa-solid fa-file";
  const label      = item.source ? shortLabel(item.source) : "Unknown source";
  const date       = formatDate(item.created_at);

  // Show first ~90 chars of summary as a teaser snippet
  const raw     = item.simplified_text || "";
  const snippet = raw.length > 90 ? raw.slice(0, 90).trimEnd() + "…" : raw;

  el.innerHTML = `
    <div class="history-item-header" role="button" tabindex="0" aria-expanded="false">
      <div class="history-item-icon-badge ${badgeClass}" aria-hidden="true">
        <i class="${iconClass}"></i>
      </div>
      <div class="history-item-meta">
        <div class="history-item-source" title="${escapeHtml(item.source || '')}">${escapeHtml(label)}</div>
        ${snippet ? `<div class="history-item-snippet">${escapeHtml(snippet)}</div>` : ''}
      </div>
      <div class="history-item-right">
        <span class="history-date">${date}</span>
        <span class="history-chevron" aria-hidden="true">▾</span>
      </div>
    </div>
    <div class="history-item-body">
      <p>${escapeHtml(item.simplified_text || "No summary saved.")}</p>
    </div>
  `;

  const header = el.querySelector(".history-item-header");
  header.addEventListener("click",   () => toggleHistoryItem(el, header));
  header.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleHistoryItem(el, header);
    }
  });

  return el;
}

function toggleHistoryItem(el, header) {
  const isOpen = el.classList.toggle("open");
  header.setAttribute("aria-expanded", isOpen ? "true" : "false");
}

function shortLabel(source) {
  // For URLs, strip protocol; for file names, just use the name
  if (source.startsWith("http")) {
    return source.replace(/^https?:\/\//, "").slice(0, 60);
  }
  return source.split(/[\\/]/).pop().slice(0, 60);
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr + (dateStr.includes("T") ? "" : " UTC"));
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return dateStr.slice(0, 10);
  }
}

// Toast notifications

let toastTimer = null;

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("visible");

  // Auto-hide after 4 seconds
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("visible");
  }, 4000);
}

// Small utilities

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


/* ==========================================================================
   PHASE 1 — Scroll storytelling, count-up, Lenis, RTL, hero parallax
   ==========================================================================

   Implementation notes:
   - This is a Flask/vanilla-JS app, so Framer Motion is approximated with
     IntersectionObserver + CSS transitions (same effect, no framework).
   - Lenis is loaded via CDN in index.html, init'd here.
   - GSAP is reserved for Phase 4's single complex scroll-sequence.
   - All features respect prefers-reduced-motion.
   ========================================================================== */

// ── Reduced-motion check (single source of truth) ──
const BB_REDUCED_MOTION = window.matchMedia(
  '(prefers-reduced-motion: reduce)'
).matches;

// ── RTL language codes ──
const BB_RTL_CODES = new Set(['ur', 'ks', 'sd']);


/* ── Lenis smooth scroll ──────────────────────────────────────────────── */
function initLenis() {
  if (BB_REDUCED_MOTION) return;
  if (typeof Lenis === 'undefined') return; // CDN may not have loaded

  const lenis = new Lenis({
    duration: 1.15,
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothTouch: false,  // touch devices: use native momentum (better perf)
  });

  function raf(time) {
    lenis.raf(time);
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);
}


/* ── Scroll reveal (IntersectionObserver) ───────────────────────────────
   Elements with [data-reveal] start at opacity:0 / translateY / blur.
   CSS in style.css defines the transition; JS adds .is-revealed.
   If reduced-motion, elements are revealed immediately (no animation). */
function initScrollReveals() {
  const els = document.querySelectorAll('[data-reveal]');
  if (!els.length) return;

  if (BB_REDUCED_MOTION) {
    els.forEach(el => el.classList.add('is-revealed'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-revealed');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -48px 0px' }
  );

  els.forEach(el => observer.observe(el));
}


/* ── Stats count-up animation ───────────────────────────────────────────
   Triggered once when .stats-bar enters the viewport.
   Eases out exponentially; formats large numbers as "20K+".
   Skipped if reduced-motion or if the element has no data-target. */
function initCountUp() {
  const statNumbers = document.querySelectorAll('.stat-number[data-target]');
  if (!statNumbers.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;

        const el       = entry.target;
        const target   = parseInt(el.dataset.target, 10);
        const suffix   = el.dataset.suffix || '';

        observer.unobserve(el);

        if (BB_REDUCED_MOTION || isNaN(target)) return; // static display

        const duration = 1800; // ms
        const startTs  = performance.now();

        function formatNum(n) {
          if (n >= 10000) return Math.round(n / 1000) + 'K' + suffix;
          if (n >= 1000)  return (n / 1000).toFixed(1).replace('.0', '') + 'K' + suffix;
          return n + suffix;
        }

        // Start from 0
        el.textContent = formatNum(0);

        function tick(now) {
          const elapsed  = now - startTs;
          const progress = Math.min(elapsed / duration, 1);
          // Expo ease-out
          const eased    = 1 - Math.pow(2, -10 * progress);
          const current  = Math.round(eased * target);

          el.textContent = formatNum(current);

          if (progress < 1) {
            requestAnimationFrame(tick);
          } else {
            el.textContent = formatNum(target); // land exactly on target
          }
        }

        requestAnimationFrame(tick);
      });
    },
    { threshold: 0.6 }
  );

  statNumbers.forEach(el => observer.observe(el));
}


/* ── RTL language: apply dir="rtl" to result containers ─────────────────
   When Urdu / Kashmiri / Sindhi is selected, result text containers
   get dir="rtl" and the Noto Nastaliq Urdu font stack.
   This is functional (bidi layout), not merely cosmetic. */
function applyRTLToResults(langCode) {
  const isRTL = BB_RTL_CODES.has(langCode);

  const resultEls = [
    document.getElementById('result-summary'),
    document.getElementById('result-eligibility'),
    document.getElementById('result-documents'),
    document.getElementById('result-benefit'),
    document.getElementById('result-apply'),
  ];

  resultEls.forEach(el => {
    if (!el) return;
    if (isRTL) {
      el.setAttribute('dir', 'rtl');
      el.style.fontFamily = "'Noto Nastaliq Urdu', 'Noto Sans', serif";
      el.style.textAlign  = 'right';
      el.style.lineHeight = '2';   // Nastaliq needs extra line-height
    } else {
      el.removeAttribute('dir');
      el.style.fontFamily = '';
      el.style.textAlign  = '';
      el.style.lineHeight = '';
    }
  });
}

/* Patch language grid to trigger RTL on selection */
function patchLangGridForRTL() {
  const grid = document.getElementById('lang-grid');
  if (!grid) return;

  // Delegate: catches both click and keyboard activation
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.lang-btn');
    if (btn && btn.dataset.code) applyRTLToResults(btn.dataset.code);
  });
}


/* ── Hero parallax (subtle only) ──────────────────────────────────────
   As the user scrolls past the hero:
     - echo-complex card fades and blurs a little more (reinforces
       the "complexity fades" metaphor without overcomplicating it)
     - orbs drift very slightly
   rAF-throttled; disabled on mobile and reduced-motion. */
function initHeroParallax() {
  if (BB_REDUCED_MOTION) return;

  // Mobile: don't waste cycles (orbs are hidden via CSS anyway)
  if (window.innerWidth <= 580) return;

  const heroWrapper  = document.getElementById('hero-wrapper');
  const echoComplex  = document.querySelector('.echo-complex');
  const orb1         = document.querySelector('.orb-1');
  const orb2         = document.querySelector('.orb-2');

  if (!heroWrapper) return;

  let ticking = false;

  function onScroll() {
    const scrollY    = window.scrollY;
    const heroH      = heroWrapper.offsetHeight;
    if (scrollY > heroH) return; // only in-hero

    const progress = Math.min(scrollY / heroH, 1);

    // Echo complex: fade and blur as complexity "dissolves" on scroll
    if (echoComplex) {
      echoComplex.style.opacity = Math.max(0.5 - progress * 0.35, 0.12);
      echoComplex.style.filter  = `blur(${0.6 + progress * 3.5}px)`;
    }

    // Orbs: very subtle vertical drift (parallax layer separation)
    if (orb1) orb1.style.transform = `translateY(${scrollY * 0.1}px)`;
    if (orb2) orb2.style.transform = `translateY(${scrollY * 0.07}px)`;
  }

  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => { onScroll(); ticking = false; });
      ticking = true;
    }
  }, { passive: true });
}


/* ── Boot Phase 1 features ───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initLenis();
  initScrollReveals();
  initCountUp();
  patchLangGridForRTL();
  initHeroParallax();
  initBridgeAnimation(); // Phase 4 — GSAP bridge scroll sequence
  initExampleSchemes();  // Phase 4 — sample scheme cards
});


/* ── Phase 4: GSAP Bridge Animation ───────────────────────────────────── */
/*
  Scroll-driven timeline using GSAP + ScrollTrigger.
  Sequence: gov panel fades in → line draws + dot travels →
            human panel appears → comparison cards reveal.
  If GSAP is not loaded (CDN fail) or reduced-motion is set,
  all elements are made visible immediately via fallback.
*/
function initBridgeAnimation() {
  const section    = document.getElementById('bridge-section');
  const govPanel   = document.getElementById('bridge-panel-gov');
  const humanPanel = document.getElementById('bridge-panel-human');
  const comparison = document.getElementById('bridge-comparison');
  const lineFill   = document.getElementById('bridge-line-fill');
  const dot        = document.getElementById('bridge-traveling-dot');

  if (!section) return;

  // Graceful fallback: show everything immediately if GSAP missing or reduced-motion
  function revealAll() {
    [govPanel, humanPanel, comparison].forEach(el => { if (el) el.style.opacity = '1'; });
    if (lineFill) lineFill.style.width  = '100%';
    if (dot)      dot.style.left        = '100%';
  }

  if (BB_REDUCED_MOTION || typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') {
    revealAll();
    return;
  }

  // Register ScrollTrigger plugin
  gsap.registerPlugin(ScrollTrigger);

  // Set initial states (elements already CSS opacity:0)
  gsap.set(govPanel,   { x: -28, opacity: 0 });
  gsap.set(humanPanel, { x:  28, opacity: 0 });
  gsap.set(comparison, { y:  28, opacity: 0 });
  gsap.set(lineFill,   { width: '0%' });
  gsap.set(dot,        { left: '0%' });

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: section,
      start:   'top 65%',
      end:     'bottom 30%',
      scrub:   1.6,
    }
  });

  tl
    // Gov panel slides in from left
    .to(govPanel,   { x: 0, opacity: 1, duration: 1,   ease: 'power2.out' })
    // Bridge line draws left-to-right simultaneously
    .to(lineFill,   { width: '100%',    duration: 2.2, ease: 'power1.inOut' }, '<0.3')
    // Dot travels across the line
    .to(dot,        { left: '100%',     duration: 2.2, ease: 'power1.inOut' }, '<')
    // Human panel slides in from right (overlaps with line completion)
    .to(humanPanel, { x: 0, opacity: 1, duration: 1,   ease: 'power2.out' }, '-=1.2')
    // Comparison cards rise up once bridge is complete
    .to(comparison, { y: 0, opacity: 1, duration: 0.9, ease: 'power2.out' }, '-=0.5');
}


/* ── Phase 4: Example Scheme Cards ─────────────────────────────────── */
/*
  Each card has data-url set to a real govt scheme URL.
  Clicking: switches to URL tab → pre-fills the URL input →
            scrolls to the upload section → auto-submits after
            a short delay (letting the scroll settle).
*/
function initExampleSchemes() {
  const cards = document.querySelectorAll('.example-card');
  cards.forEach(card => {
    card.addEventListener('click', async () => {
      const url = card.dataset.url;
      if (!url) return;

      // Visual loading state on the clicked card
      card.classList.add('loading');

      // Switch to URL tab (trigger the existing tab click logic)
      const urlTab = document.getElementById('tab-url');
      if (urlTab) urlTab.click();

      // Pre-fill the URL input
      const urlInput = document.getElementById('url-input');
      if (urlInput) {
        urlInput.value = url;
        urlInput.dispatchEvent(new Event('input')); // triggers updateSubmitButton()
      }

      // Scroll the input section into view
      const inputSection = document.querySelector('.input-section');
      if (inputSection) {
        inputSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // Remove loading state and auto-submit after scroll settles
      setTimeout(() => {
        card.classList.remove('loading');
        const btn = document.getElementById('btn-submit');
        if (btn && !btn.disabled) btn.click();
      }, 750);
    });
  });
}
