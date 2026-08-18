/* global pdfjsLib, classifyTaxDocument, extractFields, evaluateRules, buildLayout, segmentPages, findRows, labelAnchor, valueBelow, valueOnRow, moneyItems, parseMoneyItem, MONEY_ITEM, rowText */

// layout.js helpers, passed to fields.js positional extractors.
const LAYOUT = { buildLayout, groupRows, rowText, findRows, labelAnchor, valueBelow, valueOnRow, moneyItems, parseMoneyItem, MONEY_ITEM };

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const resultBox = $("resultBox");
const SESSION_KEY = "review_session";

let RULES = null;
function setStatus(msg) { statusEl.textContent = msg || ""; }

// Load the rules workbook export once.
async function loadRules() {
  if (RULES) return RULES;
  const res = await fetch(chrome.runtime.getURL("rules.json"));
  RULES = await res.json();
  return RULES;
}

function money(n) {
  return "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---- PDF text extraction (copy the buffer; pdf.js detaches it) ----
async function extractText(bytes, maxPages = 5) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(src.length);
  copy.set(src);
  const pdf = await pdfjsLib.getDocument({ data: copy, disableAutoFetch: true, disableStream: true }).promise;
  const pages = Math.min(pdf.numPages, maxPages);
  let text = "";
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n";
  }
  await pdf.destroy();
  return text;
}

// ---- Session storage ----
async function getSession() {
  const store = await chrome.storage.local.get(SESSION_KEY);
  return store[SESSION_KEY] || { docs: [] };
}
async function addDoc(doc) {
  const s = await getSession();
  s.docs.unshift(doc);
  await chrome.storage.local.set({ [SESSION_KEY]: s });
  return s;
}

// ---- Main scan pipeline ----
// ---- Per-page extraction with layout, then segment into documents ----
// Real filed forms print values away from labels in reading order, so we keep
// each page's text-item coordinates and locate values positionally.
// A single PDF is often a packet (1040 + Schedule 1), so we classify each page
// and merge consecutive same-type pages into documents.
async function readPdfDocs(bytes, onStatus) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(src.length);
  copy.set(src);
  const pdf = await pdfjsLib.getDocument({ data: copy, disableAutoFetch: true, disableStream: true }).promise;

  const maxPages = Math.min(pdf.numPages, 12);
  const pageResults = [];
  let totalChars = 0;

  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(" ");
    totalChars += text.replace(/\s/g, "").length;
    pageResults.push({
      page: i,
      text,
      layout: buildLayout(content.items),
      items: content.items
    });
  }

  // Scanned (no text layer) -> OCR the whole file, no coordinates available.
  if (totalChars < 20) {
    if (onStatus) onStatus("No text layer — running OCR…");
    const ocr = await window.__ocr.ocrPdf(bytes, 3, onStatus);
    await pdf.destroy();
    const r = classifyTaxDocument(ocr.text);
    return {
      viaOCR: true,
      docs: r.type === "Unknown" ? [] : [{
        docType: r.type, variant: r.variant, confidence: r.confidence,
        pages: [1], text: ocr.text, layouts: []
      }],
      unknown: r.type === "Unknown"
    };
  }

  for (const pr of pageResults) {
    const r = classifyTaxDocument(pr.text);
    pr.type = r.type; pr.variant = r.variant; pr.confidence = r.confidence;
  }
  await pdf.destroy();

  const docs = segmentPages(pageResults);
  return { viaOCR: false, docs, unknown: docs.length === 0 };
}

async function classifyFromData(data, filename) {
  setStatus("Reading PDF…");
  try {
    await loadRules();
    const { docs, viaOCR, unknown } = await readPdfDocs(data, (m) => setStatus(m));
    setStatus("");

    if (unknown || !docs.length) {
      showUnknown(filename, viaOCR);
      return;
    }

    const added = [];
    for (const doc of docs) {
      // Merge field reads across the document's pages; first non-null wins.
      let fields = {};
      const layouts = doc.layouts && doc.layouts.length ? doc.layouts : [null];
      for (const lay of layouts) {
        const f = extractFields(doc.docType, doc.variant, doc.text, lay, lay ? LAYOUT : null);
        for (const [k, v] of Object.entries(f)) {
          if ((fields[k] === undefined || fields[k] === null) && v !== null) fields[k] = v;
        }
      }
      const entry = {
        id: "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
        docType: doc.docType,
        variant: doc.variant,
        filename: docs.length > 1 ? `${filename} (p${doc.pages.join("-")})` : (filename || doc.docType),
        fields,
        viaOCR,
        confidence: doc.confidence,
        at: new Date().toISOString()
      };
      await addDoc(entry);
      added.push({ ...entry, confidence: doc.confidence });
    }

    showResults(added, filename, viaOCR);
    await renderSession();
  } catch (e) {
    setStatus("Error: " + e.message);
  }
}

function showUnknown(filename, viaOCR) {
  resultBox.innerHTML = `
    <div class="result">
      <div class="doctype" style="color:var(--warn)">Unknown</div>
      <div class="conf">Could not classify</div>
      ${filename ? `<div class="filename">${filename}</div>` : ""}
      <div class="matches">No recognizable tax-form markers found${viaOCR ? " even after OCR" : ""}. Try a clearer scan or a different file.</div>
    </div>`;
}

// ---- Result card ----
function fieldSummary(fields, variant, docType) {
  const rows = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null) continue;
    if (k === "f1040_is_joint") {
      if (v.joint) {
        const detail = v.status ? `${v.status}` : "joint return";
        rows.push(`${detail} — 2 W-2s required` + (v.ssnCount ? ` (${v.ssnCount} SSNs)` : ""));
      } else if (v.status) {
        rows.push(`${v.status}` + (v.ssnCount ? ` (${v.ssnCount} SSN)` : ""));
      }
      continue;
    }
    if (Array.isArray(v)) {
      if (v.length) rows.push(`${k}: ${v.length} business(es)`);
    } else if (typeof v === "object") {
      if (v.present) rows.push(`${k}: statement ${v.statementNumber || "(unnumbered)"}`);
    } else if (typeof v === "number") {
      // The 1040 wage figure is the headline value — label it plainly rather
      // than by raw field name. On a filed 1040 it's Box 1a; on a transcript
      // it's "Total Wages" (the workbook's own wording).
      if (k === "f1040_wages") {
        rows.push(variant === "Transcript"
          ? `Total Wages: ${money(v)}`
          : `Box 1a — Total W-2 wages: ${money(v)}`);
      } else if (k === "w2_box1") {
        // Same field for an official W-2 (Box 1) and an unofficial wages
        // summary (just "Wages") — label by which document it came from.
        rows.push(docType === "Wages Summary"
          ? `Wages: ${money(v)}`
          : `Box 1 — Wages: ${money(v)}`);
      } else {
        rows.push(`${k}: ${money(v)}`);
      }
    }
  }
  return rows;
}

function showResults(docs, filename, viaOCR) {
  resultBox.innerHTML = docs.map((d) => {
    const summary = fieldSummary(d.fields, d.variant, d.docType);
    const valueBlock = summary.length
      ? `<ul class="matches">${summary.map((s) => `<li>${s}</li>`).join("")}</ul>
         ${viaOCR ? '<div class="ocr-note">Read by OCR — verify these amounts.</div>' : ""}`
      : `<div class="matches">No target fields found on this document.</div>`;
    return `
      <div class="result">
        <div class="doctype">${d.docType}</div>
        <div class="conf">${d.variant}${d.confidence ? ` <span class="badge">${d.confidence}%</span>` : ""}${viaOCR ? ' <span class="ocr-badge">OCR</span>' : ""}</div>
        <div class="filename">${d.filename}</div>
        ${valueBlock}
      </div>`;
  }).join("");
  if (docs.length > 1) {
    resultBox.innerHTML = `<div class="why" style="margin-bottom:6px;">Found ${docs.length} documents in this file.</div>` + resultBox.innerHTML;
  }
}

// ---- Session + instructions rendering ----
// Manual-entry field definitions per document type. Each field the reviewer
// may need to hand-enter when OCR/scrape can't read it. Types:
//   "amount"  — single numeric box
//   "lines"   — one textarea, one entry per line (Schedule E EIN + name)
//   "rows"    — a "+ Add another" list of rows (unknown count: statements,
//               transcript Other Expenses)
// `label` is the approved wording shown when the field can't be read.
// `wageForNoW2` marks the wage fields that, when genuinely null/0, mean
// "no W-2s required" (positive note) INSTEAD of a manual box.
const MANUAL_FIELDS = {
  "Form W-2": [
    { key: "w2_box1", type: "amount", label: "Unable to read W2 - Enter the value in Box 1." }
  ],
  "Wages Summary": [
    { key: "w2_box1", type: "amount",
      label: "Not official W-2 - Enter the wages value from this summary." }
  ],
  "Form 1040": [
    { key: "f1040_wages",  type: "amount", wageForNoW2: true,
      label: "Unable to read 1040 - Enter the value in Box 1a.",
      noW2Note: "No W2's required based on 1040 1a value." },
    { key: "f1040_line8",  type: "amount", label: "Unable to read 1040 - Enter the value in Box 8." },
    { key: "f1040_line23", type: "amount", label: "Unable to read 1040 - Enter the value in Box 23." },
    // Transcript (Record of Account) variants use the same doc type:
    { key: "roa_total_wages_manual", type: "amount", variant: "Transcript", wageForNoW2: true,
      valueKey: "f1040_wages", targetField: "f1040_wages",
      label: "Unable to read 1040 Transcript - Enter the value Total Wages",
      noW2Note: "No W2's required based on 1040 Total Wages value." },
    { key: "roa_other_expenses_manual", type: "rows", variant: "Transcript",
      sumTo: "roa_schedC_other_expenses",
      label: "Unable to read 1040 Transcript (Schedule C) - Enter the value(s) Other Expenses",
      rowPlaceholder: "Other expenses amount (one per business)" },
    { key: "roa_partnership_loss_manual", type: "rows", variant: "Transcript",
      sumTo: "roa_partnership_loss", sumAsNegative: true,
      label: "Unable to read 1040 Transcript (Schedule E) - Enter the value Partnership loss",
      rowPlaceholder: "Partnership loss amount (one per occurrence)" }
  ],
  "Schedule 1": [
    { key: "sched1_line3", type: "amount", label: "Unable to read Schedule 1 - Enter the value in Box 3." },
    { key: "sched1_line5", type: "amount", label: "Unable to read Schedule 1 - Enter the value in Box 5." },
    { key: "sched1_line6", type: "amount", label: "Unable to read Schedule 1 - Enter the value in Box 6." }
  ],
  "Schedule C": [
    { key: "schedC_line31", type: "amount", label: "Unable to read Schedule 1 - Enter the value in Box 31." }
  ],
  "Schedule E": [
    { key: "schedE_line28", type: "lines",
      label: "Unable to read Schedule E - Enter the value(s) in Boxes 28 [A] (d), [B] (d), [C] (d), and [D] (d).",
      linesPlaceholder: "One per line:  12-3456789  Business Name" },
    { key: "schedE_line40", type: "amount",
      label: "Unable to read Schedule E - Enter the value in Box 40 (Net farm rental income)." }
  ],
  "Federal Statements": [
    { key: "fed_statement_manual", type: "rows",
      label: "Unable to read Schedule E Statement - Enter the value(s) EIN and Business Name",
      rowPlaceholder: "12-3456789  Business Name" }
  ],
  "Wage and Income Transcript": [
    { key: "wage_income_manual", type: "amount",
      label: "Unable to read Wage & Income Transcript - Enter the value Wages, Tips and Other Compensation" }
  ]
};

const LOW_CONFIDENCE = 70; // below this, an OCR read isn't trusted

// A wage field of exactly 0 means "no W-2s required" — used to suppress the
// manual box AND drive the positive note. A MISSING value (null — nothing
// read or typed) is NOT this case: it needs a manual box so the reviewer can
// enter it, and the rules engine holds Steps 1 & 2 until it's present.
function isWageNoW2Zero(doc, fieldDef) {
  if (!fieldDef.wageForNoW2) return false;
  const v = doc.fields[fieldDef.valueKey || fieldDef.sumTo || fieldDef.key];
  return v === 0;
}

// Return the list of fields on this doc that currently need manual entry.
// A field needs entry when it couldn't be read (null) or came from a
// low-confidence OCR pass — EXCEPT wage fields that are genuinely null/0,
// which are suppressed (they mean "no W-2s required", handled as a note).
function neededManualFields(doc) {
  const defs = MANUAL_FIELDS[doc.docType];
  if (!defs) return [];
  // A 1040 transcript that reports no return filed has no figures to type.
  if (doc.docType === "Form 1040" && doc.fields.roa_no_return_filed === true) return [];

  const isTranscript = doc.variant === "Transcript";
  const lowConf = typeof doc.confidence === "number" && doc.confidence < LOW_CONFIDENCE;
  const out = [];
  for (const def of defs) {
    // Variant-scoped fields: transcript-only vs standard-only.
    if (def.variant === "Transcript" && !isTranscript) continue;
    if (def.variant === "Standard" && isTranscript) continue;
    // Standard 1040 fields shouldn't show on a transcript and vice versa.
    if (!def.variant && isTranscript && doc.docType === "Form 1040" &&
        (def.key === "f1040_line8" || def.key === "f1040_line23")) continue;

    if (doc.manualFields && doc.manualFields[def.key] != null) continue; // already entered

    // Resolve the underlying field that actually holds this manual field's
    // value. Priority: an explicit valueKey (e.g. the transcript wage box reads
    // f1040_wages), then a sumTo target (the "rows" fields — Other Expenses,
    // Partnership loss — land their total in roa_schedC_other_expenses /
    // roa_partnership_loss), then the field's own key. Without this, a "rows"
    // field checked its own (always-undefined) key and showed a box even when
    // the value had been extracted.
    const valueKey = def.valueKey || def.sumTo || def.key;
    const v = doc.fields[valueKey];

    // A wage field of exactly 0 is "no W-2s required" (positive note) — no box.
    // A missing wage value (null) is NOT suppressed: it falls through to the
    // missing check below so the reviewer gets a box to type Box 1a into.
    if (isWageNoW2Zero(doc, def)) continue;

    const missing = (v == null || (Array.isArray(v) && v.length === 0));
    // Prompt when the field is missing (nothing read/typed), or when an OCR
    // pass was low-confidence enough not to trust.
    if (missing || lowConf) out.push(def);
  }
  return out;
}

// Positive "no W-2s required" notes for a doc whose wage field is null/0.
function noW2Notes(doc) {
  const defs = MANUAL_FIELDS[doc.docType] || [];
  const notes = [];
  const isTranscript = doc.variant === "Transcript";
  for (const def of defs) {
    if (def.variant === "Transcript" && !isTranscript) continue;
    if (!def.variant && isTranscript && def.wageForNoW2) continue; // avoid dup on transcript
    if (isWageNoW2Zero(doc, def) && def.noW2Note) notes.push(def.noW2Note);
  }
  return notes;
}

// Short label for a document row's thumbnail chip.
function thumbLabel(docType) {
  const map = {
    "Form 1040": "1040",
    "Form 1065": "1065",
    "Form 1120-S": "1120S",
    "Form W-2": "W-2",
    "Schedule 1": "Sch 1",
    "Schedule 2": "Sch 2",
    "Schedule C": "Sch C",
    "Schedule E": "Sch E",
    "Schedule F": "Sch F",
    "Wages Summary": "Wages"
  };
  return map[docType] || "DOC";
}

async function renderSession() {
  await loadRules();
  const s = await getSession();
  const sec = $("sessionSection");
  const list = $("sessionList");
  const instSec = $("instructionsSection");

  if (!s.docs.length) {
    sec.classList.add("hidden");
    instSec.classList.add("hidden");
    const instList = $("instructionsList");
    if (instList) instList.innerHTML = "";
    const aiSec = $("aiSection");
    if (aiSec) aiSec.innerHTML = "";
    list.innerHTML = "";
    const countPill = $("docCount");
    if (countPill) countPill.classList.add("hidden");
    return;
  }
  sec.classList.remove("hidden");

  // Update the document counters (header pill + list count).
  const n = s.docs.length;
  const countPill = $("docCount");
  const countText = $("docCountText");
  const listCount = $("docListCount");
  if (countPill && countText) {
    countPill.classList.remove("hidden");
    countText.textContent = `${n} document${n === 1 ? "" : "s"} added`;
  }
  if (listCount) listCount.textContent = `(${n} file${n === 1 ? "" : "s"})`;

  list.innerHTML = s.docs.map((d) => {
    const vals = fieldSummary(d.fields, d.variant, d.docType).slice(0, 3).join(" · ") || "no values read";
    const needFields = neededManualFields(d);
    const notes = noW2Notes(d);
    const hasManual = needFields.length > 0;

    const notesBlock = notes.map((n) =>
      `<div class="now2-note"><span class="ok-dot">✓</span>${n}</div>`).join("");

    const manualBlock = needFields.map((def) => renderManualField(d, def)).join("");

    // Entered manual values shown read-only with an Edit link, so a wrong
    // entry can be corrected. `editing` set on a field re-opens its input.
    const enteredBlock = renderEnteredValues(d);

    const thumb = thumbLabel(d.docType);
    const conf = typeof d.confidence === "number"
      ? `<span class="conf-badge">${d.confidence}%</span>` : "";
    const title = `${d.docType}${d.variant ? ` (${d.variant})` : ""}`;
    const manualBadge = (d.manualFields && Object.keys(d.manualFields).length)
      ? ' <span class="badge" style="background:var(--green-soft);color:var(--green);">manual</span>' : "";
    return `<div class="doc-row${hasManual ? " needs-fix" : ""}">
      <span class="thumb">${thumb}</span>
      <span>
        <div class="doc-row-top">
          <span class="dt">${title}</span> ${conf}${d.viaOCR ? ' <span class="ocr-badge">OCR</span>' : ""}${manualBadge}
          <button type="button" class="remove-doc" data-remove-doc="${d.id}" title="Remove this document">✕ Remove</button>
        </div>
        <div class="fv">${vals}</div>
        <div class="fv filename"><b>File Name:</b> ${d.filename}</div>${notesBlock}${enteredBlock}${manualBlock}
      </span>
      ${hasManual ? "" : '<span class="chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>'}
    </div>`;
  }).join("");

  // Wire up manual inputs. Saving stores the value but does NOT run analysis;
  // rules only evaluate on Run Analysis.
  list.querySelectorAll("[data-manual-amount]").forEach((inp) => {
    inp.addEventListener("blur", () => saveManualAmount(inp));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
  });
  list.querySelectorAll("[data-manual-lines]").forEach((ta) => {
    ta.addEventListener("blur", () => saveManualLines(ta));
  });
  list.querySelectorAll("[data-add-row]").forEach((btn) => {
    btn.addEventListener("click", () => addManualRow(btn));
  });
  list.querySelectorAll("[data-manual-rows-save]").forEach((btn) => {
    btn.addEventListener("click", () => saveManualRows(btn));
  });
  // Remove-document buttons.
  list.querySelectorAll("[data-remove-doc]").forEach((btn) => {
    btn.addEventListener("click", () => removeDoc(btn.getAttribute("data-remove-doc")));
  });
  // Edit links on entered values.
  list.querySelectorAll("[data-edit-field]").forEach((lnk) => {
    lnk.addEventListener("click", () =>
      editManualField(lnk.getAttribute("data-doc-id"), lnk.getAttribute("data-edit-field")));
  });

  // NOTE: analysis is intentionally NOT run here. Adding documents or entering
  // manual values only builds the list; evaluateRules runs in runAnalysis(),
  // triggered by the Run Analysis button.
}

// Render already-entered manual values as read-only rows with an Edit link.
// A field flagged in doc._editing is re-rendered as an input instead.
function renderEnteredValues(doc) {
  if (!doc.manualFields) return "";
  const defs = MANUAL_FIELDS[doc.docType] || [];
  const byKey = Object.fromEntries(defs.map((def) => [def.key, def]));
  const editing = doc._editing || {};
  const parts = [];
  for (const [key, val] of Object.entries(doc.manualFields)) {
    if (val == null) continue;
    const def = byKey[key];
    if (!def) continue;
    if (editing[key]) {
      // Re-open the input for this field.
      parts.push(renderManualField(doc, def));
      continue;
    }
    const shown = Array.isArray(val)
      ? val.join("; ")
      : (typeof val === "number" ? formatEnteredAmount(val) : String(val));
    parts.push(`<div class="entered-val">
      <span class="ev-label">${shortFieldName(def)}:</span>
      <span class="ev-value">${shown}</span>
      <a class="ev-edit" data-edit-field="${key}" data-doc-id="${doc.id}">Edit</a>
    </div>`);
  }
  return parts.join("");
}

function formatEnteredAmount(n) {
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A short human name for a manual field, derived from its approved label.
function shortFieldName(def) {
  // Pull the "Box X" / "Total Wages" tail from the label for a compact tag.
  const m = def.label.match(/Enter the value(?:\(s\))?(?: in)? (.+?)\.?$/i);
  return m ? m[1] : def.key;
}

// Render one manual-entry field by its type. When re-opened for editing, the
// previous value is prefilled from doc._editPrefill.
function renderManualField(doc, def) {
  const head = `<div class="manual-fix-label">${def.label}</div>`;
  const prefill = (doc._editPrefill && doc._editPrefill[def.key] != null)
    ? doc._editPrefill[def.key] : null;
  if (def.type === "amount") {
    const v = (typeof prefill === "number") ? String(prefill) : "";
    return `<div class="manual-fix">${head}
      <input class="minput" type="text" inputmode="decimal"
             data-manual-amount data-doc-id="${doc.id}" data-field="${def.key}"${def.targetField ? ` data-target="${def.targetField}"` : ""}
             placeholder="e.g. 52000.00" value="${v}" /></div>`;
  }
  if (def.type === "lines") {
    const v = Array.isArray(prefill) ? prefill.join("\n") : "";
    return `<div class="manual-fix">${head}
      <textarea class="minput" rows="3" data-manual-lines
                data-doc-id="${doc.id}" data-field="${def.key}"
                placeholder="${def.linesPlaceholder || "One entry per line"}">${v}</textarea></div>`;
  }
  if (def.type === "rows") {
    const rows = Array.isArray(prefill) && prefill.length ? prefill : [""];
    const inputs = rows.map((val) =>
      `<input class="minput" type="text" placeholder="${def.rowPlaceholder || "Value"}" value="${String(val).replace(/"/g,"&quot;")}" />`
    ).join("");
    return `<div class="manual-fix" data-rows-field="${def.key}" data-doc-id="${doc.id}">${head}
      <div class="row-inputs">${inputs}</div>
      <div class="row-actions">
        <button type="button" class="rowbtn" data-add-row data-field="${def.key}" data-doc-id="${doc.id}">+ Add another</button>
        <button type="button" class="rowbtn save" data-manual-rows-save data-field="${def.key}" data-doc-id="${doc.id}">Save</button>
      </div></div>`;
  }
  return "";
}

// Persist a rep-typed value; refresh list only (no rule run).
async function persistManual(docId, key, value, targetField) {
  const s = await getSession();
  const doc = s.docs.find((d) => d.id === docId);
  if (!doc) return;
  if (!doc.manualFields) doc.manualFields = {};
  doc.manualFields[key] = value;
  // Amount fields feed doc.fields so the rules engine reads them. A manual
  // field may target a different underlying field (e.g. transcript wages ->
  // f1040_wages) so reconciliation picks it up.
  if (typeof value === "number") doc.fields[targetField || key] = value;
  // Whenever a manual entry resolves the 1040 wage figure — whether typed into
  // the standard Box 1a field (key f1040_wages) or the transcript Total Wages
  // field (which targets f1040_wages) — mark f1040_wages as confirmed so the
  // OCR pending-gate (Steps 1 & 2) clears for both variants.
  if ((targetField === "f1040_wages" || key === "f1040_wages") && typeof value === "number") {
    doc.manualFields.f1040_wages = value;
  }
  // Clear any edit-in-progress flag for this field now that it's saved.
  if (doc._editing) delete doc._editing[key];
  if (doc._editPrefill) delete doc._editPrefill[key];
  await chrome.storage.local.set({ [SESSION_KEY]: s });
  await renderSession();
}

async function saveManualAmount(inp) {
  const val = parseManual(inp.value);
  if (val === null) return;
  await persistManual(
    inp.getAttribute("data-doc-id"),
    inp.getAttribute("data-field"),
    val,
    inp.getAttribute("data-target") || undefined
  );
}

async function saveManualLines(ta) {
  const lines = ta.value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  await persistManual(ta.getAttribute("data-doc-id"), ta.getAttribute("data-field"), lines);
}

// "+ Add another" appends an input row to a dynamic rows field.
function addManualRow(btn) {
  const wrap = btn.closest(".manual-fix").querySelector(".row-inputs");
  const first = wrap.querySelector("input");
  const clone = document.createElement("input");
  clone.className = "minput";
  clone.type = "text";
  clone.placeholder = first ? first.placeholder : "Value";
  wrap.appendChild(clone);
  clone.focus();
}

async function saveManualRows(btn) {
  const wrap = btn.closest(".manual-fix");
  const values = Array.from(wrap.querySelectorAll(".row-inputs input"))
    .map((i) => i.value.trim()).filter(Boolean);
  if (!values.length) return;
  const docId = btn.getAttribute("data-doc-id");
  const key = btn.getAttribute("data-field");
  await persistManual(docId, key, values);
  // If this field sums into an engine field (e.g. Other expenses across
  // occurrences -> roa_schedC_other_expenses for Step 25), total the numeric
  // rows and store that so Run Analysis reads the combined value.
  const def = findManualDef(docId, key);
  if (def && def.sumTo) {
    let total = values
      .map((v) => parseFloat(String(v).replace(/[$,\s()]/g, "")))
      .filter((n) => isFinite(n))
      .reduce((a, b) => a + Math.abs(b), 0);
    // Loss fields: store as a negative so the < 0 check (Step 28) fires
    // regardless of whether the rep typed a minus sign.
    if (def.sumAsNegative && total > 0) total = -total;
    await persistManual(docId, def.sumTo, total);
  }
}

// Look up a manual field definition by doc + key (across the doc's type).
function findManualDef(docId, key) {
  for (const defs of Object.values(MANUAL_FIELDS)) {
    const d = defs.find((x) => x.key === key);
    if (d) return d;
  }
  return null;
}

// Remove a scanned document from the session (e.g. wrong doc, or the rep wants
// to re-scan). Confirm first since it's destructive. Clears prior analysis
// results — they no longer reflect the current set.
async function removeDoc(docId) {
  const s = await getSession();
  const doc = s.docs.find((d) => d.id === docId);
  if (!doc) return;
  const label = `${doc.docType}${doc.variant ? ` (${doc.variant})` : ""}`;
  if (!confirm(`Remove ${label} from this review?`)) return;
  s.docs = s.docs.filter((d) => d.id !== docId);
  await chrome.storage.local.set({ [SESSION_KEY]: s });
  // Prior Next-steps results are stale once the set changes — clear them.
  const instSec = $("instructionsSection");
  if (instSec) instSec.classList.add("hidden");
  const instList = $("instructionsList");
  if (instList) instList.innerHTML = "";
  resultBox.innerHTML = "";
  await renderSession();
}

// Re-open a previously entered manual value for correction. Flags the field
// as editing and stashes the previous value; renderManualField then shows its
// input again, pre-filled, via renderEnteredValues.
async function editManualField(docId, key) {
  const s = await getSession();
  const doc = s.docs.find((d) => d.id === docId);
  if (!doc) return;
  if (!doc._editing) doc._editing = {};
  if (!doc._editPrefill) doc._editPrefill = {};
  doc._editing[key] = true;
  doc._editPrefill[key] = doc.manualFields ? doc.manualFields[key] : null;
  await chrome.storage.local.set({ [SESSION_KEY]: s });
  await renderSession();
}

function renderInstructions(results, session) {
  const sec = $("instructionsSection");
  const box = $("instructionsList");
  const blocked = results.filter((r) => r.status === "blocked");
  const attention = results.filter((r) => r.status === "fired" &&
    (r.severity === "action" || r.severity === "note" || r.severity === "info"));
  const positives = results.filter((r) => r.status === "fired" && r.severity === "ok");
  sec.classList.remove("hidden");

  // --- Documents still needed: collect every distinct document a fired rule
  // asked for (missingDoc on gt_zero_and_missing_doc, plus "Request additional"
  // rules). De-duplicated, in the order first encountered.
  const missingDocs = [];
  const seenMissing = new Set();
  for (const r of results) {
    if (r.status !== "fired") continue;
    const items = [];
    if (r.data && r.data.missing) items.push(r.data.missing);
    if (r.data && r.data.requestMore) items.push(r.data.requestMore);
    for (const m of items) {
      if (!seenMissing.has(m)) { seenMissing.add(m); missingDocs.push(m); }
    }
  }

  // --- Count summary bar. Actions and blocked gates are what the rep must act
  // on; notes are FYI; positives are confirmations.
  const nAction = attention.filter((r) => r.severity === "action").length + blocked.length;
  const nNote = attention.filter((r) => r.severity === "note").length;
  const nInfo = attention.filter((r) => r.severity === "info").length;
  const parts = [];
  if (nAction) parts.push(`${nAction} action${nAction === 1 ? "" : "s"}`);
  if (nNote) parts.push(`${nNote} note${nNote === 1 ? "" : "s"}`);
  if (nInfo) parts.push(`${nInfo} info`);
  if (missingDocs.length) parts.push(`${missingDocs.length} document${missingDocs.length === 1 ? "" : "s"} to request`);
  const summaryText = parts.length ? parts.join(" · ") : "All checks passed";
  const summaryClass = nAction ? "sum-attention" : (nNote ? "sum-note" : "sum-ok");
  const summaryHTML = `<div class="steps-summary ${summaryClass}">
    <span class="ss-label">Analysis summary</span>
    <span class="ss-counts">${summaryText}</span></div>`;

  // --- Documents still needed section.
  const missingHTML = missingDocs.length ? `
    <div class="missing-docs">
      <div class="md-head">Documents still needed</div>
      ${missingDocs.map((d) => `<div class="md-item"><span class="md-dot">▢</span>${d}</div>`).join("")}
    </div>` : "";

  // --- Order all triggered cards by their Step number (from the workbook),
  // with severity as the tiebreak within the same step (blocked, then action,
  // then note, then info, then positive). This presents the review in the
  // sequence a reviewer works through, per the Step column.
  const sevRank = { blocked: 0, action: 1, note: 2, info: 3, ok: 4 };
  const allCards = []
    .concat(blocked.map((r) => ({ r, kind: "blocked" })))
    .concat(attention.map((r) => ({ r, kind: "attention" })))
    .concat(positives.map((r) => ({ r, kind: "positive" })));
  allCards.sort((a, b) => {
    const sa = a.r.rule.step ?? 999, sb = b.r.rule.step ?? 999;
    if (sa !== sb) return sa - sb;
    return (sevRank[a.r.severity] ?? 9) - (sevRank[b.r.severity] ?? 9);
  });

  const cardsHTML = allCards.map(({ r, kind }) => {
    const step = r.rule.step != null ? `Step ${r.rule.step}` : "";
    const rows = [r.rule.sheetRow].concat(r.alsoFrom || []).join(", ");
    if (kind === "blocked") {
      // Block reasons: a 1040 wage value not read (enter Box 1a), a schedule
      // value needed for the Line 8 check not read (enter the box), or a joint
      // return needing 2 W-2s. Header matches the reason.
      const blockHead = (r.data && r.data.missingWage)
        ? "Enter Box 1a to continue"
        : (r.data && r.data.missingValue)
        ? "Enter schedule value to continue"
        : "Add W-2s to continue";
      return `<div class="inst blocked">
        <div class="head"><span>${step ? step + " · " : ""}${blockHead}</span><span class="src">gates rows ${rows}</span></div>
        <div>${r.message}</div>
      </div>`;
    }
    if (kind === "positive") {
      const isAllClear = r.id === "all_documents_in";
      return `<div class="allclear"${isAllClear ? ' style="font-weight:600;"' : ''}>
        <span class="ok"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg></span>
        <span>${step && !isAllClear ? `<b>${step}</b> — ` : ""}${r.message}</span>
      </div>`;
    }
    const cls = r.severity === "action" ? "action" : (r.severity === "note" ? "note" : "");
    const heading = r.severity === "action" ? "Action required" : (r.severity === "note" ? "Make a note" : "Info");
    const body = r.message.includes("\n") ? `<pre>${r.message}</pre>` : r.message;
    return `<div class="inst ${cls}">
      <div class="head"><span>${step ? step + " · " : ""}${heading}</span><span class="src">Rule row ${rows}</span></div>
      <div>${body}</div>
      <div class="why">Checked: ${r.rule.location}</div>
    </div>`;
  }).join("");

  if (!attention.length && !blocked.length && !positives.length) {
    box.innerHTML = summaryHTML + `<div class="allclear">
      <span class="ok"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg></span>
      <span>No action items. Scan any remaining documents to complete the review.</span></div>`;
    renderAISection(session, results);
    return;
  }

  box.innerHTML = summaryHTML + missingHTML + cardsHTML;
  renderAISection(session, results);
}

// ---- Optional AI assist for fuzzy rules only ----
function renderAISection(session, results) {
  const box = $("aiSection");
  // A fuzzy rule is one the sheet describes in a way regex can't fully settle.
  const fuzzy = results.filter((r) => r.status === "fired" && r.rule.fuzzy);
  if (!fuzzy.length) { box.innerHTML = ""; return; }

  box.innerHTML = `
    <div class="inst note">
      <div class="head"><span>Needs interpretation</span><span class="src">optional AI</span></div>
      <div>${fuzzy.length} rule${fuzzy.length === 1 ? "" : "s"} reference free-form content
        (statements, business names/EINs) that fixed patterns may not capture reliably.</div>
      <div class="why">${fuzzy.map((f) => f.rule.fuzzyReason).join(" ")}</div>
      <button id="aiAssist" class="secondary" style="margin-top:8px;">Ask AI to read these (sends text to Anthropic)</button>
      <div class="ocr-note">This is the only step that sends document text off-device. Leave it unused to stay fully local.</div>
      <div id="aiOut"></div>
    </div>`;

  $("aiAssist").addEventListener("click", () => runAIAssist(session, fuzzy));
}

async function runAIAssist(session, fuzzy) {
  const out = $("aiOut");
  out.innerHTML = `<div class="why">Asking…</div>`;
  try {
    const schedE = session.docs.filter((d) => d.docType === "Schedule E");
    const context = schedE.map((d) => `${d.filename}: ${JSON.stringify(d.fields)}`).join("\n");
    const prompt = `You are helping a tax-document reviewer. From the Schedule E data below, list each unique business needing a K-1 as "EIN — Business Name". If a line says "See statement", say which statement number must be located. Reply with only the list.\n\n${context}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await resp.json();
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    out.innerHTML = `<pre>${text || "(no response)"}</pre>`;
  } catch (e) {
    out.innerHTML = `<div class="why">AI request failed: ${e.message}. The deterministic rules above are unaffected.</div>`;
  }
}

// ---- Manual entry (per-document, rendered inside the session list) ----
// parseManual is used by saveManualAmount when a rep types a value into a
// failed OCR doc's box. Strips $ and commas; returns null for empty/bad input.
function parseManual(raw) {
  const s = String(raw || "").replace(/[$,\s]/g, "");
  if (s === "") return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

$("clearSession").addEventListener("click", async () => {
  await chrome.storage.local.remove(SESSION_KEY);
  resultBox.innerHTML = "";
  await renderSession();
});

// ==========================================================================
// SITE DISPATCHER
//
// Different portals hide the document in different places. Rather than
// asking the reviewer to declare where they are, the tab-scan handler reads
// the URL it already has and matches it against a small table of known site
// locators. Each locator's job is only to resolve a fetchable document URL —
// once it has one, the existing fetch -> sniff -> classify chain in
// background.js / classifyFromData takes over unchanged, identically for
// every site. Adding a new site later means adding one more row here.
// ==========================================================================
const SITE_LOCATORS = [
  {
    name: "ravenna",
    match: (url) => {
      try { return new URL(url).hostname === "aid.ravennasolutions.com"; }
      catch (e) { return false; }
    },
    // Ask the content script (running in the page, across shadow roots) for
    // the transcript's underlying S3 URL.
    locate: async (tab) => {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: "RAVENNA_FIND_TRANSCRIPT" });
      if (resp && resp.ok && resp.url) return { url: resp.url, name: "Ravenna transcript" };
      return null;
    }
  }
];

// Try every locator whose `match` fits the current tab URL. Returns
// { url, name } on success, or null if none of them found anything — the
// caller then falls back to the existing address-bar logic untouched.
async function locateViaDispatcher(tab) {
  const url = tab.url || "";
  for (const site of SITE_LOCATORS) {
    if (!site.match(url)) continue;
    try {
      const hit = await site.locate(tab);
      if (hit) return hit;
    } catch (e) {
      // Content script may not be injected yet (e.g. page loaded before the
      // extension did) — fall through to the address-bar path below.
    }
  }
  return null;
}

// ---- Scan the document open in the active tab ----
// Portal viewers (FACTS etc.) serve documents from authenticated handlers like
// ScannedDocumentHandler.ashx?metadataId=...&appId=... — there is no ".pdf" in
// the URL, and the payload may be a PDF *or* a scanned image. So we don't gate
// on the extension; we fetch with the user's session and sniff what comes back.
function looksLikeDocumentUrl(url) {
  if (/\.pdf($|\?)/i.test(url)) return true;
  if (/\.(png|jpe?g|gif|bmp|tiff?)($|\?)/i.test(url)) return true;
  if (url.startsWith("blob:")) return true;
  // Portal document handlers: .ashx/.aspx/.php/.do endpoints, or URLs whose
  // query mentions a document/file/attachment id.
  if (/\.(ashx|aspx|axd|php|do|jsp)(\?|$)/i.test(url)) return true;
  if (/(document|file|attachment|scan|image|metadataid|docid|fileid)/i.test(url)) return true;
  return false;
}

$("scanTab").addEventListener("click", async () => {
  resultBox.innerHTML = "";
  setStatus("Locating document in tab…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) { setStatus("No active tab URL."); return; }

    // 1) Site dispatcher: known sites (currently just Ravenna) resolve their
    //    own document URL via a content script. Everything else falls
    //    through to the address-bar logic below, unchanged.
    let url = null;
    let dispatchedName = null;
    const hit = await locateViaDispatcher(tab);
    if (hit) {
      url = hit.url;
      dispatchedName = hit.name;
    } else {
      url = tab.url;
      // Chrome's built-in PDF viewer wraps the real URL.
      const m = url.match(/[?&]src=([^&]+)/);
      if (m) url = decodeURIComponent(m[1]);

      if (url.startsWith("file:")) {
        setStatus("Chrome blocks reading local files this way. Use 'Open from computer'.");
        return;
      }
      if (!/^https?:|^blob:/i.test(url)) {
        setStatus("This tab isn't a document URL. Open the document itself in a tab, or use 'Open from computer'.");
        return;
      }
      if (!looksLikeDocumentUrl(url)) {
        setStatus("This tab doesn't look like a document. Open the file itself (not the viewer page), or use 'Open from computer'.");
        return;
      }
    }

    setStatus("Fetching document…");
    const resp = await chrome.runtime.sendMessage({ type: "FETCH_PDF", url });
    if (!resp || !resp.ok) {
      setStatus(resp && resp.error ? resp.error : "Couldn't fetch the document.");
      return;
    }

    const clean = String(resp.data).replace(/\s/g, "");
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const name = dispatchedName || fileNameFromUrl(url);
    if (resp.kind === "image") {
      await classifyFromImage(bytes, resp.mime, name);
    } else {
      await classifyFromData(bytes, name);
    }
  } catch (e) {
    setStatus("Error: " + e.message);
  }
});

// Derive a readable name from a handler URL (…?metadataId=37352606 -> id).
function fileNameFromUrl(url) {
  try {
    const u = new URL(url, location.href);
    const idKey = ["metadataId", "documentId", "docId", "fileId", "id"]
      .find((k) => u.searchParams.get(k));
    if (idKey) return `${u.hostname} (${idKey}=${u.searchParams.get(idKey)})`;
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || u.hostname;
  } catch (e) {
    return url.split("/").pop() || url;
  }
}

// A scanned page served as an image: no text layer at all, so OCR is the only path.
async function classifyFromImage(bytes, mime, filename) {
  setStatus("Scanned image — running OCR…");
  try {
    await loadRules();
    const ocr = await window.__ocr.ocrImage(bytes, mime, (m) => setStatus(m));
    setStatus("");
    const res = classifyTaxDocument(ocr.text);
    if (res.type === "Unknown") { showUnknown(filename, true); return; }

    // No coordinates from OCR text, so extraction uses the flat-text path.
    const fields = extractFields(res.type, res.variant, ocr.text, null, null);
    const entry = {
      id: "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
      docType: res.type,
      variant: res.variant,
      filename: filename || res.type,
      fields,
      viaOCR: true,
      confidence: res.confidence,
      at: new Date().toISOString()
    };
    await addDoc(entry);
    showResults([{ ...entry, confidence: res.confidence }], filename, true);
    await renderSession();
  } catch (e) {
    setStatus("OCR error: " + e.message);
  }
}

// ---- SSS: scrape the Ravenna family-transcript popup ----
// The transcript renders as real HTML text, so the background worker reads the
// popup's DOM directly. No S3 fetch, no OCR — the text is exact, so the doc is
// saved as viaOCR:false (trusted, no manual-entry fallback).
$("sssScrape").addEventListener("click", async () => {
  resultBox.innerHTML = "";
  setStatus("Searching for the Ravenna transcript popup…");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "SSS_SCRAPE_TRANSCRIPT" });
    if (!resp || !resp.ok) {
      setStatus(resp && resp.error ? resp.error : "Couldn't scrape the transcript.");
      // If the worker returned diagnostics, show them in the result area so we
      // can see what the popup's DOM actually contained.
      if (resp && resp.diagnostics) {
        resultBox.innerHTML = `<div class="result">
          <div class="doctype" style="color:var(--warn)">Scrape came up empty</div>
          <div class="conf">${resp.recordId ? "recordId " + resp.recordId : "popup found"}</div>
          <div class="matches">Per-frame DOM diagnostics:</div>
          <details open><summary>frames scanned: ${resp.diagnostics.length}</summary>
          <pre>${JSON.stringify(resp.diagnostics, null, 2)}</pre></details>
          <div class="ocr-note">If the transcript text is inside one of the iframe srcs above, tell me and I'll target it. If bodyLen is large but text is short, the container selector needs tuning.</div>
        </div>`;
      }
      return;
    }
    setStatus("");
    const name = resp.recordId ? `SSS transcript (${resp.recordId})` : "SSS transcript";
    await classifyFromText(resp.text, name);
  } catch (e) {
    setStatus("Error: " + e.message);
  }
});

// Classify + extract from already-plain text (scraped HTML). Mirrors the image
// path but skips OCR: the text is exact, so viaOCR is false and there's no
// coordinate layout (flat-text extractors handle transcripts natively).
async function classifyFromText(text, filename) {
  await loadRules();
  const res = classifyTaxDocument(text);
  if (res.type === "Unknown") { showUnknown(filename, false); return; }

  const fields = extractFields(res.type, res.variant, text, null, null);
  const entry = {
    id: "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
    docType: res.type,
    variant: res.variant,
    filename: filename || res.type,
    fields,
    viaOCR: false,
    confidence: res.confidence,
    at: new Date().toISOString()
  };
  await addDoc(entry);
  showResults([{ ...entry, confidence: res.confidence }], filename, false);
  await renderSession();
}

// ---- Open a PDF from local storage ----
$("openLocal").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  resultBox.innerHTML = "";
  await handleLocalFile(file);
  e.target.value = "";
});

// Route by type: PDFs get the text/layout path, images go straight to OCR.
async function handleLocalFile(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (file.type && file.type.indexOf("image/") === 0) {
    await classifyFromImage(bytes, file.type, file.name);
  } else {
    await classifyFromData(bytes, file.name);
  }
}

// ---- Drag and drop ----
const drop = $("drop");
["dragover", "dragenter"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = "var(--accent)"; })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = "var(--border)"; })
);
drop.addEventListener("drop", async (e) => {
  const file = e.dataTransfer.files[0];
  const ok = file && (file.type === "application/pdf" || (file.type || "").indexOf("image/") === 0);
  if (!ok) { setStatus("Please drop a PDF or a scanned image."); return; }
  resultBox.innerHTML = "";
  await handleLocalFile(file);
});

// ---- Top tab bar: switch views ----
document.querySelectorAll(".tabbar .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const view = tab.getAttribute("data-view");
    document.querySelectorAll(".tabbar .tab").forEach((t) => {
      const on = t === tab;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll("[data-view-panel]").forEach((p) => {
      p.classList.toggle("hidden", p.getAttribute("data-view-panel") !== view);
    });
  });
});

// ---- Run Analysis: re-run the rules over the current session ----
// ---- Run Analysis: the ONLY place rules are evaluated ----
// Adding documents and entering manual values just build the list; the rep
// clicks this to actually run the rules workbook over the whole set and paint
// "Next steps". Results then persist until the next click.
$("runAnalysis").addEventListener("click", async () => {
  await loadRules();
  const s = await getSession();
  if (!s.docs.length) { setStatus("Add at least one document, then run the analysis."); return; }
  setStatus("");

  // Mark the count pill as analyzed now that analysis has actually run.
  const countText = $("docCountText");
  if (countText) {
    const n = s.docs.length;
    countText.textContent = `${n} document${n === 1 ? "" : "s"} analyzed`;
  }

  renderInstructions(evaluateRules(RULES, s), s);
  const instSec = $("instructionsSection");
  if (instSec) instSec.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// ---- Family Narrative: character counter ----
const narrInput = $("narrativeInput");
if (narrInput) {
  narrInput.addEventListener("input", () => {
    const c = $("narrCount");
    if (c) c.textContent = narrInput.value.length.toLocaleString("en-US");
  });
}

// ---- Summarize Narrative (optional AI; sends text to Anthropic) ----
$("summarizeNarrative").addEventListener("click", async () => {
  const out = $("narrativeSummary");
  const text = (narrInput && narrInput.value || "").trim();
  if (!text) {
    out.innerHTML = `<span>Paste the family narrative above first, then select "Summarize Narrative."</span>`;
    return;
  }
  out.innerHTML = `<span>Summarizing…</span>`;
  try {
    const prompt = "Summarize the following family narrative for a financial-aid reviewer. " +
      "Be concise and factual, focus on circumstances relevant to financial need, and use plain sentences.\n\n" + text;
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await resp.json();
    const summary = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    out.textContent = summary || "(No summary returned.)";
  } catch (e) {
    out.textContent = "Couldn't summarize: " + e.message + ". Your narrative text is unchanged above.";
  }
});

// ---- Copy Summary ----
$("copySummary").addEventListener("click", async () => {
  const out = $("narrativeSummary");
  const text = (out && out.textContent || "").trim();
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch (e) { /* clipboard blocked */ }
});

// ---- Pin button (visual affordance; panel pinning is a Chrome UI action) ----
const pinBtn = $("pinBtn");
if (pinBtn) pinBtn.addEventListener("click", () => pinBtn.classList.toggle("active"));

// Show any existing session on open.
renderSession();
