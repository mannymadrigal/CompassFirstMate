# Compass First Mate — Chrome Extension

A side-panel extension that reads a PDF and tells you which tax form it is —
in both its **standard filed version** and its **IRS transcript version**:

**Form 1040, Form 1065, Schedule 1, Schedule C, Schedule E, Schedule F, and W-2.**

For an identified **W-2**, it also extracts **Box 1 — Wages, tips, other
compensation** and saves the dollar amount (posts **0.00** if missing or zero).
Extraction for the other forms is stubbed pending the specific target field per form.

## Install (unpacked)
1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `compass-first-mate` folder
4. Pin the extension and click its icon to open the side panel

## Use
- **Scan PDF open in current tab** — works for PDFs hosted online (http/https), FACTS-style portal viewers, and Ravenna (see below). Open the document first, then click.
- **Open PDF from computer…** — pick any local PDF. This is the reliable path for files on your machine.
- **Drag and drop** a PDF onto the panel.

To scan local `file://` PDFs via the "current tab" button, also enable
"Allow access to file URLs" on the extension's details page. The
**Open PDF from computer** button works regardless.

## How detection works
Text is extracted from the first 3 pages with pdf.js, then scored against each
form using (1) the official title, (2) the OMB control number, (3) transcript
signals (e.g. "Form Number: 1040", "Record of Account"), and (4) supporting
field keywords. Schedules are checked before the generic 1040 so a
"Schedule 1 (Form 1040)" isn't misread as a bare 1040. Confidence, the detected
variant (Standard vs Transcript), and the matched markers are shown.

## Scanned images (OCR)
If a PDF has no text layer — i.e. it's a scanned image — the extension falls
back to **local OCR** using Tesseract.js (WebAssembly). Everything runs in the
browser; **no document data leaves the device**, which matters for taxpayer PII.

OCR is only used when the fast text path finds nothing, so real text PDFs stay
instant. OCR-read values are marked with an **OCR** badge and a "please verify"
note, because OCR can misread digits — always confirm an OCR amount before
relying on the $20,000 reconciliation.

## Manual entry
If a value can't be read (bad scan, unusual layout), type the W-2 wages and/or
1040 total wages into the **Manual entry** fields and click **Calculate
manually**. It runs the same reconciliation and $20,000 alert on your typed
values.

## Reconciliation
When both a W-2 value and a 1040 value are present, the panel computes
**W-2 wages − 1040 total wages**. If the difference is greater than +$20,000 or
less than −$20,000, it alerts that additional W-2s are required.

## Files
- `manifest.json` — MV3 config, side panel + permissions + Ravenna content script
- `background.js` — opens panel, fetches online PDFs and pre-signed S3 URLs (avoids CORS in panel)
- `content.js` — runs only on `aid.ravennasolutions.com`; locates the transcript's S3 iframe inside the page's shadow DOM
- `sidepanel.html` / `sidepanel.js` — UI, site dispatcher, and PDF loading/extraction
- `detector.js` — the classifier rules
- `layout.js` — positional (x/y) extraction for filed forms
- `segment.js` — splits a packet PDF into its component documents
- `fields.js` — per-field extractors (flat-text and positional)
- `rules.js` / `rules.json` — the deterministic rules engine
- `ocr.js` — local Tesseract.js OCR fallback
- `lib/` — bundled pdf.js + Tesseract.js (no remote code, MV3-compliant)

## Rules engine (from your Excel workbook)
`rules.json` is a direct translation of `Prepping_Tax_Document_Data.xlsx`
(sheet "Details"). Each rule keeps the workbook's own text:

| Workbook column | Where it goes |
|---|---|
| A — Document Type | `docType` (which document the rule applies to) |
| B — Location on Document/Label | `location` (which field to read; implemented in `fields.js`) |
| C — Logic/Check | `check` (executed by `rules.js`) |
| D — Output Instructions for User | `output` (shown in the **Next steps** panel) |

Rules run over a **session** — the set of documents you've scanned — because
checks like "is Schedule C present in the file?" need the whole set. Scan every
document in the review, then read **Next steps**.

Actions appear in red, notes in amber, and each card cites the workbook row it
came from. `$xx` in an output string is replaced with the computed amount.

### W-2 reconciliation (asymmetric, per the workbook)
- Sum of **all** W-2 Box 1 values vs. the 1040 wages figure.
- Sum is **more** than the 1040 → *Make Note* (any amount).
- Sum is **$20,000 or more less** than the 1040 → *Request additional W2s*.

### Optional AI assist
Two workbook rows ("See statement", Federal Statements) describe free-form
content that fixed patterns can't settle reliably. Those — and only those —
offer an **Ask AI** button. Everything else is deterministic and offline.
Leaving the button unused keeps the extension fully local.

### Joint returns require 2 W-2s
When a scanned 1040 is a **joint return** — detected by a populated spouse
Taxpayer ID / SSN value, or "married filing jointly" filing status — the
W-2-vs-1040 reconciliation is **held back until at least 2 W-2s** (taxpayer +
spouse) are in the session. A purple "Add W-2s to continue" card appears in
Next steps and the math does not run until the minimum is met.

Note: the spouse-SSN *label* appears on every 1040 transcript, so detection
requires an actual spouse ID *value* — a Head-of-Household or Single return with
a blank spouse field is not treated as joint.

## Two document shapes: transcripts vs filed forms
The extension handles both, and they need different extraction strategies:

**IRS transcripts** — text reads `Total wages: $29,006.00`. Flat regex works.
A transcript is ONE document even across many pages (its later pages mention
"Schedule 2", "Form W-2 wages" etc., which must not be mistaken for separate forms).

**Real filed forms** (preparer 1040s, ADP W-2s) — the blank form template and
the filled-in values are separate text runs, so in reading order a value can sit
hundreds of characters from its label. These are read **positionally** via
`layout.js`, which rebuilds rows/columns from each text item's x/y coordinates:
- W-2 boxes: value sits directly *beneath* its label in the same column.
- 1040 / Schedule lines: value sits in the right-hand amount column *on the same row*.

Filed PDFs are often **packets** (1040 pages 1-2 + Schedule 1 pages 3-4).
`segment.js` classifies each page and merges consecutive same-type pages, so one
upload registers every form it contains — which is what makes "is Schedule 1
present in the file?" answerable.

## Filing status on filed 1040s
On a filed 1040 there is no "Spouse SSN:" label — instead a checkbox is marked.
The checked box is found by locating the `X` text item nearest each status label,
and corroborated by counting printed SSNs: **Single → 1 SSN, Married filing
jointly → 2 SSNs**. Both signals are reported; joint returns require 2 W-2s
before the reconciliation math runs.

## Where a document can come from — the site dispatcher
"Scan PDF open in current tab" doesn't require declaring which portal you're
in. `sidepanel.js` reads the tab's URL, checks it against a small table of
known site locators, and hands off to whichever one matches. Each locator's
only job is to resolve a fetchable document URL — once it has one, the same
fetch → sniff → classify → extract → rules pipeline runs, identically, no
matter where the document came from. Adding a new site later is one more row
in that table.

### Documents in portal viewers (FACTS, etc.)
Handles authenticated portal handlers such as
`ScannedDocumentHandler.ashx?metadataId=...&appId=...` — URLs with no `.pdf`
in them. This is the default/fallback locator (no content script needed):

- The background fetch uses `credentials: "include"`, so your existing portal
  session cookies are sent. Without them the server returns a login page.
- The response is **sniffed by magic bytes**, because a login or error page is
  still served as HTTP 200. A PDF goes down the text/layout path; a JPEG/PNG is
  a scan and goes straight to OCR; an HTML login page reports
  "The portal returned a login page" instead of a confusing parse error.

### Ravenna (`aid.ravennasolutions.com`)
Ravenna renders the transcript inside an `<iframe>` (or occasionally an
`<embed>`) whose `src` is a **pre-signed S3 URL**, nested inside one or more
LWC/Aura **shadow roots** — so the address bar never shows the document URL
and the panel can't reach into the page's DOM on its own.

- `content.js` is a scoped content script (registered in `manifest.json` for
  `https://aid.ravennasolutions.com/*` only) that walks every open shadow root
  on the page and returns the first S3 iframe/embed `src` it finds.
- When the tab's hostname matches Ravenna, `sidepanel.js`'s dispatcher asks
  that content script for the URL *before* falling back to the address-bar
  logic used for every other site.
- Pre-signed S3 URLs carry their own auth in the query string
  (`X-Amz-Signature=...` or `AWSAccessKeyId=...&Expires=...&Signature=...`).
  `background.js` detects this pattern and fetches with
  **`credentials: "omit"`** — sending cookies here does nothing useful and can
  cause some bucket policies to reject the request, so it's kept clean.
  The FACTS credentialed path is untouched; it's a separate branch.
- From there, nothing else changes: the fetched bytes are sniffed, classified,
  and run through the identical detector → fields → rules chain as a local
  file or a FACTS document.
- Content-script permission is scoped narrowly to `aid.ravennasolutions.com`
  — it does not run on any other site, which keeps the Chrome Web Store
  justification for `scripting` simple.

Scanned images are supported everywhere now — tab, file picker, and drag-drop.
Since an image has no text layer, values come from OCR and are flagged for
verification.
