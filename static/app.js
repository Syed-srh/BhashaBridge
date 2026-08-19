/*
 * BhashaBridge — Frontend Logic
 */

let currentResult = null;
let selectedLanguageCode = "en";
let selectedLanguageVoiceSupported = true;
let selectedLanguageBcp47 = "en-IN";
let selectedFile = null;

// speechSynthesis state
let activeSpeech = null;
let activeSpeechBtn = null;

// Auto-detect backend: use same origin in production, localhost in dev
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? ''   // same-origin — Flask serves both the page and the API
  : 'https://bhashabridge-roqp.onrender.com';

// Boot: run once the page is ready

document.addEventListener("DOMContentLoaded", () => {
  loadLanguages();
  loadHistory();
  setupModeTabs();
  setupDropZone();
  setupFormActions();
  setupResultButtons();
  initDiscoverSection();
  setupSpeechToText();
});

// Language picker

async function loadLanguages() {
  try {
    const resp = await fetch(`${API_BASE}/api/languages`);
    const langs = await resp.json();
    buildLanguageGrid(langs);
  } catch {
    const grid = document.getElementById("lang-grid");
    if (grid) {
      grid.innerHTML = `<p style="color:var(--text-muted);font-size:var(--text-sm);grid-column:1/-1">
        Start the backend (python app.py) to load languages.
      </p>`;
    }
  }
}

function buildLanguageGrid(languages) {
  const grid = document.getElementById("lang-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const RTL_LANG_CODES = new Set(['ur', 'ks', 'sd']);

  languages.forEach(lang => {
    const btn = document.createElement("button");
    btn.className = "lang-btn" + (lang.code === "en" ? " selected" : "");
    btn.dataset.code = lang.code;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", lang.code === "en" ? "true" : "false");
    btn.setAttribute("aria-label", `${lang.name} — ${lang.native}`);

    if (RTL_LANG_CODES.has(lang.code)) {
      btn.setAttribute('dir', 'rtl');
    }

    const isVoice = (lang.voice_supported !== false);
    btn.innerHTML = `
      <span class="lang-native">${lang.native}</span>
      <span class="lang-english">${lang.name}</span>
      <span class="lang-transition-badge" aria-hidden="true">${isVoice ? "🎙️" : "📝"} en ➔ ${lang.code}</span>
    `;

    btn.addEventListener("click", () => {
      grid.querySelectorAll(".lang-btn").forEach(b => {
        b.classList.remove("selected");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("selected");
      btn.setAttribute("aria-checked", "true");
      selectedLanguageCode = lang.code;
      selectedLanguageVoiceSupported = isVoice;
      selectedLanguageBcp47 = lang.bcp47_code || "en-IN";

      updateVoiceButtonsVisibility();

      const announcer = document.getElementById("lang-selection-announce");
      if (announcer) {
        announcer.textContent = `${lang.name} selected ${isVoice ? '(Voice readout supported)' : '(Voice disabled for this language)'}`;
      }
    });

    grid.appendChild(btn);
  });

  updateVoiceButtonsVisibility();
}

function updateVoiceButtonsVisibility() {
  const voiceButtons = document.querySelectorAll(".btn-card-voice, #btn-voice-all");
  voiceButtons.forEach(btn => {
    if (!selectedLanguageVoiceSupported) {
      btn.style.opacity = "0.4";
      btn.style.pointerEvents = "none";
      btn.title = "Voice readout not available in this language";
    } else {
      btn.style.opacity = "1";
      btn.style.pointerEvents = "auto";
      btn.title = "Read aloud";
    }
  });
}

function setupSpeechToText() {
  const micBtn = document.getElementById("btn-stt-discover");
  const searchInput = document.getElementById("discover-search-input");
  if (!micBtn || !searchInput) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micBtn.title = "Speech recognition not supported on this browser";
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;

  micBtn.addEventListener("click", () => {
    if (micBtn.classList.contains("listening")) {
      recognition.stop();
      micBtn.classList.remove("listening");
      return;
    }

    recognition.lang = selectedLanguageBcp47 || "en-IN";
    try {
      recognition.start();
      micBtn.classList.add("listening");
      micBtn.title = "Listening... Speak your query";
    } catch (e) {
      console.warn("Speech recognition error:", e);
    }
  });

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    searchInput.value = transcript;
    micBtn.classList.remove("listening");
    micBtn.title = "Speak your query";
    fetchRecommendations(transcript);
  };

  recognition.onerror = () => {
    micBtn.classList.remove("listening");
    micBtn.title = "Speak your query";
  };

  recognition.onend = () => {
    micBtn.classList.remove("listening");
  };
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
  const urlValue  = document.getElementById("url-input").value.trim();
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

  // Hide results, show progress (SSE events will drive step activation)
  document.getElementById("results-section").classList.remove("visible");
  showProgress();

  // Visual preview in progress background for continuity
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

  const btn = document.getElementById("btn-submit");
  btn.disabled = true;
  btn.classList.add("processing");

  try {
    // ── Open a streaming fetch to the SSE endpoint ───────────────────
    const resp = await fetch(`${API_BASE}/api/process-stream`, {
      method: "POST",
      body:   formData,
    });

    if (!resp.ok) {
      // Non-200 before any streaming starts — parse as plain JSON error
      const err = await resp.json().catch(() => ({ error: "Server error. Please try again." }));
      throw new Error(err.error || "Server error. Please try again.");
    }

    // ── Read SSE frames from the response body stream ───────────────
    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = "";

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE messages are delimited by two consecutive newlines
      const parts = buffer.split("\n\n");
      buffer = parts.pop(); // last element may be an incomplete frame

      for (const part of parts) {
        // Find the data line inside this SSE frame
        const dataLine = part.split("\n").find(l => l.startsWith("data:"));
        if (!dataLine) continue;

        let payload;
        try {
          payload = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue; // malformed JSON — skip
        }

        // ─ Error from server ─
        if (payload.type === "error") {
          throw new Error(payload.message);
        }

        // ─ Stage progress event ─
        if (typeof payload.step === "number" && payload.stage) {
          activateStreamStep(payload.step);
        }

        // ─ Final result ─
        if (payload.type === "complete") {
          markAllStepsDone();
          btn.classList.remove("processing");
          btn.classList.add("success");
          await sleep(700);
          currentResult = payload.result;
          renderResults(payload.result);
          loadHistory();
          break outer;
        }
      }
    }

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

  // Reset all steps and track bar
  STEPS.forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove("active", "done");
  });
  const bar = document.getElementById("progress-track-bar");
  if (bar) bar.style.width = "0%";
  const num = document.getElementById("progress-step-num");
  if (num) num.textContent = "1";

  // Announce the first step to screen readers immediately.
  // The actual step activation is driven by SSE events from the server
  // (activateStreamStep is called as each "stage" event arrives).
  announceProgressStep(STEP_LABELS[0]);
}

// animateStep is kept for any future timer-based fallback use,
// but the main pipeline now uses activateStreamStep driven by SSE events.
function animateStep(index) {
  if (index >= STEPS.length - 1) return;
  const el = document.getElementById(STEPS[index]);
  el.classList.add("active");
  updateProgressTrack(index);
  setTimeout(() => {
    el.classList.remove("active");
    el.classList.add("done");
    if (index + 1 < STEPS.length - 1) {
      announceProgressStep(STEP_LABELS[index + 1]);
      animateStep(index + 1);
    }
  }, 1400);
}

/*
 * activateStreamStep(index)
 * Called by handleSubmit() each time a {stage, step} SSE event arrives.
 * Marks all previous steps as done, activates the current step,
 * and updates the track bar + aria-live announcer.
 */
function activateStreamStep(index) {
  // Everything before this index is done
  for (let i = 0; i < index; i++) {
    const el = document.getElementById(STEPS[i]);
    if (el) { el.classList.remove("active"); el.classList.add("done"); }
  }
  // Deactivate any currently active step first
  STEPS.forEach(id => document.getElementById(id)?.classList.remove("active"));
  // Activate the arriving step
  const current = document.getElementById(STEPS[index]);
  if (current) {
    current.classList.remove("done");
    current.classList.add("active");
  }
  updateProgressTrack(index);
  announceProgressStep(STEP_LABELS[index]);
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

  const textToScan = [
    data.eligibility, data.documents, data.benefit, data.how_to_apply, data.restrictions
  ].join(" ");

  let items = [];

  // ── Real restrictions from the LLM pipeline (Step 1 extract field) ───────
  const SENTINEL = "This information was not available in the document.";
  const restrictions = (data.restrictions || "").trim();
  if (restrictions && restrictions !== SENTINEL) {
    // Each newline in restrictions becomes its own bullet
    restrictions.split(/\n+/).forEach(line => {
      const t = line.replace(/^[•\-\*\d]+[\.\)]\s*/, "").trim();
      if (t) items.push(escapeHtml(t));
    });
  }

  // ── Always-useful civic tips ──────────────────────────────────────────────
  items.push(
    "Ensure your <strong>Aadhaar card</strong> is linked to your active bank account for direct benefit transfer (DBT)."
  );
  items.push(
    "Never pay any fee to middlemen or brokers. This service is <strong>completely free</strong>."
  );

  // ── Heuristic: income cap ─────────────────────────────────────────────────
  const incomeMatch = textToScan.match(
    /(income\s?(limit|cap)?\sof\s?Rs\.\s?\d+[\d,]*|income\s?below\s?Rs\.\s?\d+[\d,]*|income\s?less\s?than\s?Rs\.\s?\d+[\d,]*)/i
  );
  if (incomeMatch) {
    items.push(`Income cap detected: <span class="bb-highlight">${escapeHtml(incomeMatch[0])}</span>.`);
  }

  // ── Heuristic: age limit ──────────────────────────────────────────────────
  const ageMatch = textToScan.match(/(\bage\s?limit\b|\bunder\s?\d+\s?years\b|\babove\s?\d+\s?years\b)/i);
  if (ageMatch) {
    items.push(
      `Age eligibility rule: Verify that you are <span class="bb-highlight-blue">${escapeHtml(ageMatch[0])}</span> before applying.`
    );
  }

  // ── Heuristic: deadline ───────────────────────────────────────────────────
  const deadlineMatch = textToScan.match(/(deadline|last date|apply before|due date|expiry)/i);
  if (deadlineMatch) {
    items.push("Pay close attention to the application deadline. Apply early to avoid server congestion.");
  }

  // De-duplicate and render
  const seen = new Set();
  const deduped = items.filter(i => {
    const key = i.replace(/<[^>]+>/g, "").trim().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  el.innerHTML = "<ul>" + deduped.map(i => `<li>${i}</li>`).join("") + "</ul>";
}

function renderResults(data) {
  // Fill in Cards 1 & 3
  document.getElementById("result-summary").innerHTML = formatContent(data.simplified_text || "");
  document.getElementById("result-benefit").innerHTML = formatContent(data.benefit || "");

  // Card 2: Who Can Apply?
  document.getElementById("result-eligibility").innerHTML = formatContent(data.eligibility || "");

  // Card 4: What Do You Need? (Interactive Document Checklist)
  const docsContainer = document.getElementById("result-documents");
  if (docsContainer) {
    if (data.action_guide && data.action_guide.documents_checklist && data.action_guide.documents_checklist.length > 0) {
      const itemsHtml = data.action_guide.documents_checklist.map(item => `
        <label class="doc-check-item" style="display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; cursor: pointer;">
          <input type="checkbox" style="margin-top: 3px; accent-color: var(--blue-accent, #3B82F6);" />
          <span style="font-size: var(--t-xs); color: var(--text-primary);">${escapeHtml(item.label)}</span>
        </label>
      `).join("");
      docsContainer.innerHTML = `
        <div style="font-size: var(--t-xs); color: var(--text-muted); margin-bottom: var(--s3); font-weight: 600;">
          <i class="fa-solid fa-square-check" style="color: var(--blue-accent, #3B82F6);"></i> Document Checklist (Click to check off):
        </div>
        <div class="action-checklist-wrap">${itemsHtml}</div>
      `;
    } else {
      docsContainer.innerHTML = formatContent(data.documents || "");
    }
  }

  // Card 5: How Do You Apply? (Numbered Steps)
  const applyContainer = document.getElementById("result-apply");
  if (applyContainer) {
    if (data.action_guide && data.action_guide.application_steps && data.action_guide.application_steps.length > 0) {
      const stepsHtml = data.action_guide.application_steps.map(step => `
        <div style="display: flex; gap: 12px; margin-bottom: 12px; align-items: flex-start;">
          <span style="background: linear-gradient(135deg, var(--blue-accent, #3B82F6), #2563EB); color: #fff; width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 700; flex-shrink: 0; margin-top: 2px;">${step.step_number}</span>
          <div style="font-size: var(--t-xs); color: var(--text-primary); line-height: 1.5;">${escapeHtml(step.description)}</div>
        </div>
      `).join("");
      applyContainer.innerHTML = `
        <div style="font-size: var(--t-xs); color: var(--text-muted); margin-bottom: var(--s3); font-weight: 600;">
          <i class="fa-solid fa-list-ol" style="color: var(--blue-accent, #3B82F6);"></i> Step-by-Step Action Guide:
        </div>
        <div class="action-steps-wrap">${stepsHtml}</div>
      `;
    } else {
      applyContainer.innerHTML = formatContent(data.how_to_apply || "");
    }
  }

  // Card 6: Important Information
  populateImportantCard(data);

  // Render RAG Confidence Badges & Show Source Citation Toggles
  renderCardCitations(data);

  // Attach Thumbs Up / Down Feedback Controls
  attachCardFeedbackControls(data);

  // Source label
  const src = data.source || "Untitled document";
  const overallConf = data.overall_confidence ? ` • ${data.overall_confidence}` : "";
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

function renderCardCitations(data) {
  if (!data || !data.citations) return;

  const fieldCardMap = {
    simplified_text: "summary",
    eligibility:     "eligibility",
    benefit:         "benefit",
    documents:       "documents",
    how_to_apply:    "apply",
  };

  Object.entries(data.citations).forEach(([fieldKey, cit]) => {
    const cardClass = fieldCardMap[fieldKey];
    if (!cardClass) return;

    const card = document.querySelector(`.info-card.${cardClass}`);
    if (!card) return;

    const footer = card.querySelector(".info-card-footer");
    if (!footer) return;

    // Remove old citation elements if re-rendering
    card.querySelectorAll(".source-citation-box, .btn-card-source").forEach(el => el.remove());
    card.querySelectorAll(".confidence-badge").forEach(el => el.remove());

    // Confidence badge HTML
    const badgeHtml = `
      <span class="confidence-badge ${cit.confidence_class}">
        ${cit.confidence_icon} ${escapeHtml(cit.confidence_label)}
      </span>
    `;

    // Show source button
    const btn = document.createElement("button");
    btn.className = "btn-card-source";
    btn.innerHTML = `<i class="fa-solid fa-quote-left"></i> Show Source (${escapeHtml(cit.source_chunk_id || "Chunk #1")})`;

    // Collapsible citation box
    const box = document.createElement("div");
    box.className = "source-citation-box";
    box.innerHTML = `
      <div class="source-citation-header">
        <span><i class="fa-solid fa-file-lines"></i> ${escapeHtml(cit.source_chunk_id || "Source Chunk")} Citation</span>
        <span style="font-size:0.7rem; opacity:0.8;">Relevance: ${Math.round((cit.relevance_score || 0.8) * 100)}%</span>
      </div>
      <div class="source-citation-excerpt">"${escapeHtml(cit.source_excerpt)}"</div>
    `;

    btn.addEventListener("click", () => {
      box.classList.toggle("visible");
      btn.innerHTML = box.classList.contains("visible")
        ? `<i class="fa-solid fa-eye-slash"></i> Hide Source`
        : `<i class="fa-solid fa-quote-left"></i> Show Source (${escapeHtml(cit.source_chunk_id || "Chunk #1")})`;
    });

    footer.appendChild(btn);
    card.appendChild(box);

    const header = card.querySelector(".info-card-header");
    if (header) {
      header.insertAdjacentHTML("beforeend", badgeHtml);
    }
  });
}

function attachCardFeedbackControls(data) {
  if (!data) return;

  const cardStageMap = [
    { cardSelector: ".info-card.summary",     stage: "simplification" },
    { cardSelector: ".info-card.eligibility", stage: "eligibility" },
    { cardSelector: ".info-card.benefit",     stage: "extraction" },
    { cardSelector: ".info-card.documents",   stage: "extraction" },
    { cardSelector: ".info-card.apply",       stage: "simplification" },
    { cardSelector: ".info-card.important",   stage: "extraction" },
  ];

  cardStageMap.forEach(({ cardSelector, stage }) => {
    const card = document.querySelector(cardSelector);
    if (!card) return;

    const footer = card.querySelector(".info-card-footer");
    if (!footer) return;

    card.querySelectorAll(".feedback-group").forEach(el => el.remove());

    const group = document.createElement("div");
    group.className = "feedback-group";
    group.innerHTML = `
      <button class="btn-feedback btn-thumb-up" title="Helpful section" aria-label="Thumbs up">
        <i class="fa-regular fa-thumbs-up"></i>
      </button>
      <button class="btn-feedback btn-thumb-down" title="Needs improvement" aria-label="Thumbs down">
        <i class="fa-regular fa-thumbs-down"></i>
      </button>
    `;

    const btnUp = group.querySelector(".btn-thumb-up");
    const btnDown = group.querySelector(".btn-thumb-down");

    const sendFeedback = async (rating) => {
      btnUp.classList.remove("active-up");
      btnDown.classList.remove("active-down");

      if (rating === "up") btnUp.classList.add("active-up");
      if (rating === "down") btnDown.classList.add("active-down");

      try {
        await fetch(`${API_BASE}/api/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            result_id: data.scheme_name || data.source || "document",
            stage: stage,
            rating: rating,
            language: selectedLanguageCode || "en",
          }),
        });

        let sentLabel = group.querySelector(".feedback-sent-msg");
        if (!sentLabel) {
          sentLabel = document.createElement("span");
          sentLabel.className = "feedback-sent-msg";
          group.appendChild(sentLabel);
        }
        sentLabel.textContent = rating === "up" ? "Thanks! 👍" : "Noted 👎";
      } catch (err) {
        console.warn("Feedback post error:", err);
      }
    };

    btnUp.addEventListener("click", () => sendFeedback("up"));
    btnDown.addEventListener("click", () => sendFeedback("down"));

    footer.appendChild(group);
  });
}

// Text-to-Speech

/*
 * Speaks the given text. If speech is already playing, stops it.
 * The btn parameter is the button that was clicked — we toggle its style.
 */
function speak(text, btn) {
  if (!selectedLanguageVoiceSupported) {
    showToast("Voice readout is not available for this language.");
    return;
  }

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
    .to(govPanel,   { x: 0, opacity: 1, duration: 1,   ease: 'power2.out' })
    .to(lineFill,   { width: '100%',    duration: 2.2, ease: 'power1.inOut' }, '<0.3')
    .to(dot,        { left: '100%',     duration: 2.2, ease: 'power1.inOut' }, '<')
    .to(humanPanel, { x: 0, opacity: 1, duration: 1,   ease: 'power2.out' }, '-=1.2')
    .to(comparison, { y: 0, opacity: 1, duration: 0.9, ease: 'power2.out' }, '-=0.5');
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
  Clicking card body: switches to URL tab → pre-fills the URL input →
                      scrolls to the upload section → auto-submits.
  Clicking external link icon: opens official website in a new tab directly.
*/
function initExampleSchemes() {
  const cards = document.querySelectorAll('.example-card');
  cards.forEach(card => {
    // External link icon handler
    const extLink = card.querySelector('.example-card-ext');
    if (extLink) {
      extLink.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    card.addEventListener('click', async (e) => {
      if (e.target.closest('.example-card-ext')) return;

      const url = card.dataset.url;
      if (!url) return;

      // Visual loading indicator on card
      card.classList.add('loading');

      // 1. Activate URL tab & panel
      const urlTab = document.getElementById('tab-url');
      const parent = urlTab ? urlTab.closest('.mode-tabs') : null;

      document.querySelectorAll('.mode-tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      if (urlTab) {
        urlTab.classList.add('active');
        urlTab.setAttribute('aria-selected', 'true');
      }
      if (parent) parent.classList.add('url-active');

      document.querySelectorAll('.input-panel').forEach(p => p.classList.remove('active'));
      const urlPanel = document.getElementById('panel-url');
      if (urlPanel) urlPanel.classList.add('active');

      // 2. Clear file selection
      selectedFile = null;
      const fileInfo = document.getElementById('file-info');
      if (fileInfo) fileInfo.classList.remove('visible');

      // 3. Set URL input value
      const urlInput = document.getElementById('url-input');
      if (urlInput) {
        urlInput.value = url;
      }
      updateSubmitButton();

      // 4. Smooth scroll to input section
      const inputSection = document.querySelector('.input-section');
      if (inputSection) {
        inputSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // 5. Submit form after scroll settles
      setTimeout(() => {
        card.classList.remove('loading');
        const btn = document.getElementById('btn-submit');
        if (btn && !btn.disabled) {
          btn.click();
        }
      }, 550);
    });
  });
}

/* ── Layer 3: Discover & Recommendation Engine ────────────────────────── */

function initDiscoverSection() {
  const searchInput = document.getElementById("discover-search-input");
  const chipsContainer = document.getElementById("discover-chips");
  const grid = document.getElementById("discover-grid");

  if (!grid) return;

  // Load initial schemes
  fetchRecommendations();

  // Debounced search input
  let searchTimer = null;
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const q = searchInput.value.trim();
        fetchRecommendations(q);
      }, 300);
    });
  }

  // Category chips
  if (chipsContainer) {
    chipsContainer.addEventListener("click", (e) => {
      const chip = e.target.closest(".discover-chip");
      if (!chip) return;

      chipsContainer.querySelectorAll(".discover-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");

      const cat = chip.dataset.category;
      if (cat === "all") {
        if (searchInput) searchInput.value = "";
        fetchRecommendations();
      } else {
        const queryText = chip.textContent.replace(/^[^\w\s]+/, "").trim();
        if (searchInput) searchInput.value = queryText;
        fetchRecommendations(queryText);
      }
    });
  }
}

async function fetchRecommendations(query = "", profile = null) {
  const grid = document.getElementById("discover-grid");
  if (!grid) return;

  grid.innerHTML = `
    <div style="grid-column: 1/-1; text-align: center; padding: var(--s6); color: var(--text-muted);">
      <i class="fa-solid fa-spinner fa-spin" style="font-size: 1.5rem; margin-bottom: var(--s2);"></i>
      <p style="font-size: var(--t-xs);">Finding matching government schemes...</p>
    </div>
  `;

  try {
    const resp = await fetch(`${API_BASE}/api/recommendations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, profile, top_k: 4 }),
    });

    if (!resp.ok) throw new Error("Failed to fetch recommendations");
    const schemes = await resp.json();
    renderRecommendationCards(schemes);
  } catch (err) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: var(--s4); color: var(--text-muted); font-size: var(--t-xs);">
        Could not load recommendations. Start backend server (python app.py).
      </div>
    `;
  }
}

function renderRecommendationCards(schemes) {
  const grid = document.getElementById("discover-grid");
  if (!grid) return;

  if (!schemes || schemes.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: var(--s6); color: var(--text-muted); font-size: var(--t-sm);">
        No matching schemes found. Try a broader search term like 'farmer' or 'healthcare'.
      </div>
    `;
    return;
  }

  grid.innerHTML = schemes.map(s => {
    const matchClass = s.match_class || "match-high";
    const matchLabel = s.match_label || "High Match";
    const matchPct   = s.match_percentage ? ` • ${s.match_percentage}` : "";

    return `
      <div class="rec-card" role="listitem">
        <div>
          <div class="rec-card-top">
            <span class="rec-card-icon">${escapeHtml(s.icon || "📋")}</span>
            <span class="match-badge ${matchClass}">
              <i class="fa-solid fa-circle-check"></i>
              ${escapeHtml(matchLabel)}${matchPct}
            </span>
          </div>
          <div class="rec-card-title">${escapeHtml(s.scheme_name)}</div>
          <div class="rec-card-category">${escapeHtml(s.category)}</div>
          <div class="rec-card-summary">${escapeHtml(s.summary)}</div>
        </div>

        <div class="rec-card-actions">
          <button class="btn-explain-rec" data-url="${escapeHtml(s.official_url)}" title="Explain ${escapeHtml(s.scheme_name)}">
            <i class="fa-solid fa-wand-magic-sparkles"></i>
            Explain Scheme
          </button>
          <a href="${escapeHtml(s.official_url)}" target="_blank" rel="noopener noreferrer" style="color: var(--text-muted); font-size: 0.85rem;" title="Official portal">
            <i class="fa-solid fa-arrow-up-right-from-square"></i>
          </a>
        </div>
      </div>
    `;
  }).join("");

  // Attach click listener to "Explain Scheme" buttons
  grid.querySelectorAll(".btn-explain-rec").forEach(btn => {
    btn.addEventListener("click", () => {
      const url = btn.dataset.url;
      if (!url) return;

      // Activate URL tab
      const urlTab = document.getElementById("tab-url");
      if (urlTab) urlTab.click();

      // Set URL input
      const urlInput = document.getElementById("url-input");
      if (urlInput) urlInput.value = url;
      updateSubmitButton();

      // Scroll to input section and trigger submit
      const inputSection = document.querySelector(".input-section");
      if (inputSection) inputSection.scrollIntoView({ behavior: "smooth", block: "center" });

      setTimeout(() => {
        const submitBtn = document.getElementById("btn-submit");
        if (submitBtn && !submitBtn.disabled) submitBtn.click();
      }, 500);
    });
  });
}
