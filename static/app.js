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

const API_BASE = "http://localhost:5000";

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

  languages.forEach(lang => {
    const btn = document.createElement("button");
    btn.className = "lang-btn" + (lang.code === "en" ? " selected" : "");
    btn.dataset.code = lang.code;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", lang.code === "en" ? "true" : "false");
    btn.setAttribute("aria-label", `${lang.name} — ${lang.native}`);

    btn.innerHTML = `
      <span class="lang-native">${lang.native}</span>
      <span class="lang-english">${lang.name}</span>
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

  // Drag events — visual feedback
  zone.addEventListener("dragover", e => {
    e.preventDefault();
    zone.classList.add("dragover");
  });

  zone.addEventListener("dragleave", () => {
    zone.classList.remove("dragover");
  });

  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("dragover");
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

  // Disable button during processing
  const btn = document.getElementById("btn-submit");
  btn.disabled = true;
  document.getElementById("submit-text").textContent = "Processing…";

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

    // Small pause so the user sees the "Done!" step
    await sleep(600);

    currentResult = data;
    renderResults(data);
    loadHistory(); // Refresh history after a new result

  } catch (err) {
    hideProgress();
    showToast(err.message);
  } finally {
    btn.disabled = false;
    document.getElementById("submit-text").textContent = "Explain This to Me";
  }
}

// Progress animation

const STEPS = ["step-read", "step-understand", "step-translate", "step-done"];

function showProgress() {
  const section = document.getElementById("progress-section");
  section.classList.add("visible");

  // Reset all steps
  STEPS.forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove("active", "done");
  });

  // Animate through steps with delays
  animateStep(0);
}

function animateStep(index) {
  if (index >= STEPS.length - 1) return; // Don't auto-advance to "done"

  const el = document.getElementById(STEPS[index]);
  el.classList.add("active");

  // Each step stays visible for 1.4s, then "completes"
  setTimeout(() => {
    el.classList.remove("active");
    el.classList.add("done");

    // Start next step (except the last one which waits for real completion)
    if (index + 1 < STEPS.length - 1) {
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
}

function hideProgress() {
  document.getElementById("progress-section").classList.remove("visible");
  STEPS.forEach(id => {
    document.getElementById(id).classList.remove("active", "done");
  });
}

// Rendering results

function renderResults(data) {
  // Fill in the four info cards
  document.getElementById("result-summary").textContent = data.simplified_text || "";
  document.getElementById("result-eligibility").textContent = data.eligibility  || "";
  document.getElementById("result-documents").textContent  = data.documents     || "";
  document.getElementById("result-benefit").textContent    = data.benefit       || "";
  document.getElementById("result-apply").textContent      = data.how_to_apply  || "";

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
    // document.getElementById("voice-all-icon").textContent = isSpeaking ? '<i class="fa-solid fa-stop" style="color: rgb(255, 255, 255);"></i>' : '<i class="fa-solid fa-volume" style="color: rgb(255, 255, 255);"></i>';
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
    items.forEach(item => {
      list.appendChild(buildHistoryItem(item));
    });

  } catch {
    list.innerHTML = `
      <div class="history-empty">
        History will appear here after you process your first document.
      </div>`;
  }
}

function buildHistoryItem(item) {
  const el = document.createElement("div");
  el.className = "history-item";
  el.setAttribute("role", "listitem");

  // Figure out what kind of source this was
  const isUrl  = item.source && item.source.startsWith("http");
  const icon   = isUrl ? '<i class="fa-solid fa-link" style="color: white"></i>' : '<i class="fa-solid fa-file" style="color: white"></i>';
  const label  = item.source ? shortLabel(item.source) : "Unknown source";
  const date   = formatDate(item.created_at);

  el.innerHTML = `
    <div class="history-item-header" role="button" tabindex="0" aria-expanded="false">
      <div class="history-item-left">
        <span class="history-icon" aria-hidden="true">${icon}</span>
        <span class="history-source" title="${escapeHtml(item.source || '')}">${escapeHtml(label)}</span>
      </div>
      <span class="history-date">${date}</span>
      <span class="history-chevron" aria-hidden="true">▾</span>
    </div>
    <div class="history-item-body">
      <strong>Summary:</strong><br />
      ${escapeHtml(item.simplified_text || "No summary saved.")}
    </div>
  `;

  // Toggle open/close
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
