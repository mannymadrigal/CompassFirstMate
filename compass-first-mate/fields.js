// Field extractors used by the rules engine.
// Each returns a number, or null when the field is absent/unreadable
// (null is distinct from 0.00 — "not found" vs "found and zero").

const AMT_RE = "\\(?\\-?\\$?\\s*((?:[0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{2})?)|(?:[0-9]+\\.[0-9]{2})|(?:[0-9]+))\\)?";

function _norm(s) {
  if (s == null) return null;
  // Strip $ , whitespace AND parens/minus — sign is decided by the caller.
  const t = String(s).replace(/[$,\s()\-]/g, "");
  if (t === "") return null;
  const n = parseFloat(t);
  return isFinite(n) ? n : null;
}

// Match a labelled amount. `labelRe` is a regex SOURCE string.
//
// Two tiers, tried in order:
//   1. A MONEY-SHAPED amount (has a thousands comma, a decimal, or a leading
//      "$") may sit a little further from the label — real form amounts almost
//      always carry a comma or cents, so this is safe to search a wider gap.
//   2. Failing that, a BARE INTEGER, but only immediately after the label
//      (tight gap) — this catches a genuine "0" without letting a blank field
//      grab a distant line-number/marker.
// In both tiers the amount token must NOT be glued to a letter (rejects line
// markers like "1a"/"8b" read as "1"/"8"). Negative detection is scoped to the
// captured token, so a hyphen inside the label ("W-2") never flips the sign.
function _labelled(text, labelRe, opts = {}) {
  const t = (text || "").replace(/\s+/g, " ");
  const NOT_MARKER = "(?![A-Za-z])";

  // Tier 1: money-shaped amount, wider gap (but no other digits in between,
  // so we can't skip past an intervening numeric field). Many 2025 form lines
  // print a line-number marker between the label and the amount, after the dot
  // leaders — e.g. "...box 1 (see instructions) . . . . 1a  144,669." or
  // "...from Form 4835 ... 40  5,500." The optional MARKER_SKIP consumes that
  // "1a"/"40"/"23" marker (digits + optional single letter) so the amount is
  // read, not the marker. It's safe because a real amount is comma/decimal/$
  // shaped and won't be mistaken for a bare marker.
  const MONEY = "(\\(?\\s*-?\\s*\\$?\\s*(?:[0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{0,2})?|[0-9]+\\.[0-9]{1,2}|\\$[0-9]+)\\.?\\s*\\)?)";
  const WIDE_GAP = "[^0-9]{0,60}?";
  const MARKER_SKIP = "(?:[0-9]{1,2}[a-z]?\\s+)?"; // optional line-number marker
  let m = t.match(new RegExp(labelRe + WIDE_GAP + MARKER_SKIP + MONEY + NOT_MARKER, "i"));

  // Tier 2: bare integer, tight gap only. The gap excludes dot leaders — a run
  // of "." with stray OCR digits is noise, not a value — allowing only spaces,
  // tabs or a colon. Reject an integer immediately followed by a capitalized
  // word (that's the next line's label, e.g. a blank field then "9 Add lines").
  if (!m) {
    const INT = "(\\(?\\s*-?\\s*\\$?\\s*[0-9]+\\s*\\)?)";
    const TIGHT_GAP = "[ \\t:]{0,3}";
    const NOT_NEXT_LABEL = "(?!\\s+[A-Z])";
    m = t.match(new RegExp(labelRe + TIGHT_GAP + INT + NOT_MARKER + NOT_NEXT_LABEL, "i"));
  }
  if (!m) return null;

  const token = m[1];
  const n = _norm(token);
  if (n == null) return null;
  // Negative iff the amount token is parenthesized (open paren is a reliable
  // signal on IRS forms even if the close is clipped) or leading-minus.
  const neg = /\(/.test(token) || /^\s*-/.test(token.trim());
  return neg ? -Math.abs(n) : n;
}

// ---- W-2 ----
const W2_LABEL = "wages,?\\s*tips[,\\s]+(?:and\\s+)?other\\s*compensation";
function f_w2_box1(text) {
  const t = (text || "").replace(/\s+/g, " ");
  const pats = [
    "\\b1\\b[^A-Za-z0-9]{0,4}" + W2_LABEL,
    W2_LABEL + "\\s+1\\s",
    W2_LABEL
  ];
  for (const p of pats) {
    const v = _labelled(t, p);
    if (v != null) return v;
  }
  return null;
}

// ---- Form 1040 (standard, 2025 layout) ----
// Line 1a: Total amount from Form(s) W-2, box 1
// Note: the label ends at "box 1"; the amount follows within the small GAP
// enforced by _labelled. We do NOT pad the label with a wide "[^0-9]{0,60}"
// gap — that would let a blank 1a match a distant digit (e.g. the "1a" line
// marker) and report a bogus value instead of leaving it unread.
function f_1040_line1a(text) {
  // On the real form the line reads: "1a Total amount from Form(s) W-2, box 1
  // (see instructions) . . . 1a  <amount>". The SECOND "1a" is a line marker,
  // not a value, so the label pattern consumes it (when present) to keep it
  // out of the amount slot. When 1a is blank, there is no amount and we return
  // null rather than grabbing the marker's digit.
  return _labelled(text, "total amount from form\\(?s\\)?\\s*w-?2,?\\s*box\\s*1(?:\\s*\\(see instructions\\))?(?:\\s*1a\\b)?")
      ?? _labelled(text, "1a\\s+total amount from form\\(?s\\)?\\s*w-?2,?\\s*box\\s*1(?:\\s*\\(see instructions\\))?");
}
// Line 8: Additional income from Schedule 1, line 10
function f_1040_line8(text) {
  return _labelled(text, "\\b8\\s+additional income from schedule\\s*1,?\\s*line\\s*10")
      ?? _labelled(text, "additional income from schedule\\s*1,?\\s*line\\s*10");
}
// Line 23: Other taxes ... from Schedule 2, line 21
function f_1040_line23(text) {
  return _labelled(text, "\\b23\\s+other taxes,?\\s*including self-?employment tax,?\\s*from schedule\\s*2,?\\s*line\\s*21")
      ?? _labelled(text, "other taxes,?\\s*including self-?employment tax,?\\s*from schedule\\s*2,?\\s*line\\s*21");
}

// ---- Schedule 1 ----
function f_sched1_line3(text) {
  return _labelled(text, "\\b3\\s*business income or \\(?loss\\)?\\.?\\s*attach schedule c")
      ?? _labelled(text, "business income or \\(?loss\\)?\\.?\\s*attach schedule c");
}
function f_sched1_line5(text) {
  return _labelled(text, "\\b5\\s*rental real estate,?\\s*royalties,?\\s*partnerships")
      ?? _labelled(text, "rental real estate,?\\s*royalties,?\\s*partnerships");
}
function f_sched1_line6(text) {
  return _labelled(text, "\\b6\\s*farm income or \\(?loss\\)?\\.?\\s*attach schedule f")
      ?? _labelled(text, "farm income or \\(?loss\\)?\\.?\\s*attach schedule f");
}

// ---- Schedule C ----
// Line 31: Net profit or (loss)
function f_schedC_line31(text) {
  return _labelled(text, "net profit or \\(?loss\\)?\\.?\\s*subtract line 30 from line 29\\.?")
      ?? _labelled(text, "\\b31\\s*net profit or \\(?loss\\)?\\.?\\s*subtract line 30 from line 29\\.?")
      ?? _labelled(text, "net profit or \\(?loss\\)?\\.?\\s*subtract line 30")
      ?? _labelled(text, "\\b31\\s+net profit or \\(loss\\)");
}

// ---- Schedule E ----
// Line 40: Net farm rental income or (loss) from Form 4835. Feeds the Line 8
// reconciliation (Sch C Box 31 + Sch E Box 40 vs 1040 Box 8).
function f_schedE_line40(text) {
  return _labelled(text, "net farm rental income or \\(?loss\\)?\\s*from form 4835\\.?\\s*(?:also,?\\s*complete line 42 below\\.?)?")
      ?? _labelled(text, "\\b40\\s*net farm rental income or \\(?loss\\)?\\s*from form 4835");
}

// ---- 1040 transcript (Record of Account) ----
function f_roa_total_wages(text) {
  return _labelled(text, "(?:^|[^a-z])total\\s+wages")
      ?? _labelled(text, "form\\s*w-?2\\s*wages");
}
// Transcript Schedule C "Other expenses:" — there is one per business, inside
// each "Schedule C - Profit or Loss From Business (Occurrence #: N)" section.
// Two filers -> Occurrence #1 and #2 (and possibly more). We find EVERY
// "Other expenses:" amount across all occurrences and SUM them, because Step 25
// checks the combined total against $10,000. Returns the sum, or null if no
// "Other expenses:" line is present at all (so manual entry can prompt).
function f_roa_schedC_other_expenses(text) {
  const t = (text || "").replace(/\s+/g, " ");
  // Global match on the labelled amount. Same amount grammar as _labelled.
  const AMT = "\\(?\\-?\\$?\\s*((?:[0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{2})?)|(?:[0-9]+\\.[0-9]{2})|(?:[0-9]+))\\)?";
  const re = new RegExp("other\\s+expenses\\s*[:\\-]?\\s*" + AMT, "gi");
  let m, total = 0, found = false;
  while ((m = re.exec(t)) !== null) {
    const raw = m[1];
    const n = parseFloat(String(raw).replace(/[$,\s]/g, ""));
    if (isFinite(n)) {
      // Respect parenthesized/negative amounts.
      const whole = m[0];
      const neg = /^\(/.test(whole.trim()) || /-\s*\$?\s*[\d,]/.test(whole);
      total += neg ? -n : n;
      found = true;
    }
  }
  return found ? total : null;
}

// Per-occurrence breakdown of Schedule C Other expenses (for display / manual
// prefill). Returns [{ occurrence, amount }] in document order.
function f_roa_schedC_other_expenses_list(text) {
  const t = (text || "").replace(/\s+/g, " ");
  const AMT = "\\(?\\-?\\$?\\s*((?:[0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{2})?)|(?:[0-9]+\\.[0-9]{2})|(?:[0-9]+))\\)?";
  // Anchor each amount to the nearest preceding occurrence number if present.
  const occRe = /schedule c[^]*?occurrence #?:?\s*(\d+)/gi;
  const occs = [];
  let om;
  while ((om = occRe.exec(t)) !== null) occs.push({ n: parseInt(om[1], 10), idx: om.index });
  const re = new RegExp("other\\s+expenses\\s*[:\\-]?\\s*" + AMT, "gi");
  const out = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const n = parseFloat(String(m[1]).replace(/[$,\s]/g, ""));
    if (!isFinite(n)) continue;
    // Which occurrence block does this amount fall in? last occurrence whose
    // header index precedes this match.
    let occ = null;
    for (const o of occs) { if (o.idx < m.index) occ = o.n; else break; }
    out.push({ occurrence: occ, amount: n });
  }
  return out;
}
// Transcript Schedule E "Partnership income:" / "Partnership loss:" — inside
// the "Schedule E--Supplemental Income and Loss" section. Like Schedule C,
// there can be multiple occurrences (one per filer/entity), so we find EVERY
// matching line and SUM them. Steps 27 (income > 0) and 28 (loss < 0) run
// against these totals. Returns null when the labelled line is absent, so the
// manual fallback (Step 29) can prompt.
function _sumLabelledAll(text, labelRe) {
  const t = (text || "").replace(/\s+/g, " ");
  const AMT = "\\(?\\-?\\$?\\s*((?:[0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{2})?)|(?:[0-9]+\\.[0-9]{2})|(?:[0-9]+))\\)?";
  const re = new RegExp(labelRe + "\\s*[:\\-]?\\s*" + AMT, "gi");
  let m, total = 0, found = false;
  while ((m = re.exec(t)) !== null) {
    const n = parseFloat(String(m[1]).replace(/[$,\s]/g, ""));
    if (!isFinite(n)) continue;
    const whole = m[0];
    const neg = /^\(/.test(whole.trim()) || /-\s*\$?\s*[\d,]/.test(whole);
    total += neg ? -n : n;
    found = true;
  }
  return found ? total : null;
}

function f_roa_partnership_income(text) {
  return _sumLabelledAll(text, "partnership\\s+income");
}
function f_roa_partnership_loss(text) {
  return _sumLabelledAll(text, "partnership\\s+loss");
}

// A 1040 Record of Account for a year with no filing reads "No Record of
// return filed." This is a presence flag, not an amount — returns true when
// the phrase is on the transcript, otherwise null (nothing to report).
function f_roa_no_return_filed(text) {
  const t = (text || "").replace(/\s+/g, " ");
  return /no\s+record\s+of\s+return\s+filed/i.test(t) ? true : null;
}

// ---- Schedule E line 28: business names + EINs ----
// Returns [{ name, ein }]; EIN format NN-NNNNNNN.
function f_schedE_line28(text) {
  const t = (text || "").replace(/\s+/g, " ");
  const out = [];
  const einRe = /(\d{2}-\d{7})/g;
  let m;
  while ((m = einRe.exec(t)) !== null) {
    const ein = m[1];
    // Look back up to 80 chars for a plausible business name.
    const start = Math.max(0, m.index - 80);
    const before = t.slice(start, m.index).trim();
    const name = before.split(/\s{2,}|\||;/).pop().trim().slice(-60) || "(name not found)";
    out.push({ name, ein });
  }
  // De-duplicate by EIN (rule: "unique in comparison to all 28 (d) values").
  const seen = new Set();
  return out.filter((r) => (seen.has(r.ein) ? false : (seen.add(r.ein), true)));
}

// Does Schedule E line 28(a) say "See statement"?
function f_schedE_see_statement(text) {
  const t = (text || "").replace(/\s+/g, " ");
  const m = t.match(/see\s+statement\s*#?\s*(\d+)?/i);
  if (!m) return null;
  return { present: true, statementNumber: m[1] ? m[1] : null };
}

// Detect whether a 1040 is a JOINT return (implies a spouse's W-2s too).
//
// TRANSCRIPTS: the label "Spouse SSN:" is printed on every transcript, so the
// label alone means nothing — we need an actual VALUE after it.
// FILED FORMS: there is no "Spouse SSN:" label at all; instead a checkbox is
// marked and the SSNs are printed at fixed positions. Per the requirement:
// Single -> one SSN; Married filing jointly -> two SSNs. We use the checked
// box as the primary signal and the SSN count to corroborate.
function f_1040_is_joint(text, layout, L) {
  // --- Filed-form path (layout available) ---
  if (layout && L) {
    const status = lx_1040_filing_status(L, layout);
    const ssns = lx_1040_ssns(L, layout);
    const ssnCount = new Set(ssns.map((s) => s.ssn)).size;

    if (status) {
      const joint = /jointly/i.test(status);
      return {
        joint,
        status,
        ssnCount,
        reason: `filing status box "${status}" is checked` +
                (joint && ssnCount >= 2 ? ` and ${ssnCount} SSNs are present` : ""),
        agrees: joint ? ssnCount >= 2 : ssnCount <= 1
      };
    }
    // No checkbox read: fall back to SSN count alone.
    if (ssnCount >= 2) {
      return { joint: true, status: null, ssnCount, reason: `${ssnCount} SSNs present on the return`, agrees: true };
    }
    if (ssnCount === 1) {
      return { joint: false, status: null, ssnCount, reason: "one SSN present", agrees: true };
    }
  }

  // --- Flat-text path (IRS transcripts AND OCR'd filed forms) ---
  const t = (text || "").replace(/\s+/g, " ");

  // A filed 1040 prints ALL FIVE filing-status labels; only one is checked.
  // So the mere presence of the words "married filing jointly" means nothing —
  // that's just the printed option. We must find which box is MARKED.
  //
  // OCR renders a checked box as an X-ish glyph near the label: "X", "[X]",
  // "IX]", "(X)", "☒", etc. Detect a mark within a short window BEFORE a status
  // label. If a NON-joint status (Single, HOH, MFS, QSS) is the marked one,
  // this return is definitively not joint — even if the joint words appear.
  const looksLikeFiledForm =
    /married filing jointly/i.test(t) && /head of household/i.test(t) &&
    /married filing separately/i.test(t); // all printed labels present

  if (looksLikeFiledForm) {
    // A CHECKED box OCRs as a bracketed/filled X glyph: "[X]", "IX]", "X]",
    // "☒", "[x]". Unchecked boxes OCR as "OO", "OU", "O", "[ ]", "L]" etc.
    // Require a checked glyph immediately (<=2 chars) before the status label.
    const CHECKED = "(?:\\[\\s*x\\s*\\]|I\\s*x\\s*\\]|x\\s*\\]|☒|\\bx\\b(?=\\s{0,2}(?:married|head|single|qualifying)))";
    const boxOn = (label) => new RegExp(CHECKED + "\\s{0,2}" + label, "i").test(t);

    const jointChecked = boxOn("married filing jointly");
    const singleChecked = boxOn("single");
    const hohChecked = boxOn("head of household");
    const mfsChecked = boxOn("married filing separately");
    const qssChecked = boxOn("qualifying surviving spouse");
    const nonJointChecked = singleChecked || hohChecked || mfsChecked || qssChecked;

    // Strongest signal: the spouse block is filled — a spouse SSN value, OR a
    // spouse name printed in the "If joint return, spouse's first name" row.
    const spouseSSN = new RegExp(
      "spouse('?s)?\\s*(?:ssn|social security number|taxpayer identification number|tin)\\s*:?\\s*" +
      "((?:[X\\*\\d]{3}[- ][X\\*\\d]{2}[- ][X\\*\\d]{4})|(?:\\d{9}))", "i"
    ).exec(t);

    if (spouseSSN) {
      return { joint: true, reason: "spouse SSN is populated", spouseValue: spouseSSN[2] };
    }
    if (jointChecked && !nonJointChecked) {
      return { joint: true, reason: "married-filing-jointly box is checked", spouseValue: null };
    }
    if (nonJointChecked) {
      const which = singleChecked ? "Single" : hohChecked ? "Head of household"
                  : mfsChecked ? "Married filing separately" : "Qualifying surviving spouse";
      return { joint: false, reason: `filing status "${which}" is checked`, spouseValue: null };
    }
    // No legible checkbox and no spouse value — unknown, treat as not joint but
    // flag low confidence so the reviewer isn't given a false 2-W2 requirement.
    return { joint: false, reason: "filing status not legible from scan", spouseValue: null, uncertain: true };
  }

  // --- True transcript path (not a printed filed form) ---
  // Transcripts state the status as data: "FILING STATUS: Married Filing Joint".
  const jointStatus = /filing\s+status\s*:?\s*married[\w\s]*filing\s+joint/i.test(t)
                    || /married[\w\s]{0,12}filing\s+joint(ly)?/i.test(t) && !/head of household/i.test(t);

  const spouseVal = new RegExp(
    "spouse('?s)?\\s*(?:ssn|social security number|taxpayer identification number|tin)\\s*:?\\s*" +
    "((?:[X\\*\\d]{3}-[X\\*\\d]{2}-[X\\*\\d]{4})|(?:\\d{9}))",
    "i"
  );
  const m = t.match(spouseVal);
  const spousePresent = !!m;

  if (!jointStatus && !spousePresent) return null; // not joint / no signal

  return {
    joint: true,
    reason: jointStatus ? "filing status is married filing jointly" : "spouse taxpayer ID is populated",
    spouseValue: m ? m[2] : null
  };
}

// ============================================================
// LAYOUT-AWARE EXTRACTION (for real filed forms)
// Transcripts are "label: value" text — flat regex works.
// Filed forms print the blank template and the values as separate text runs,
// so we locate values by page position instead. Requires layout.js.
// ============================================================

// W-2 boxes: label row on top, value directly beneath in the same column.
// Note the filed W-2 abbreviates: "Wages, tips, other comp." (not "compensation").
const W2_BOX1_ROW = /wages,?\s*tips,?\s*other\s*comp/i;

function lx_w2_box1(L, layout) {
  const rows = L.findRows(layout, W2_BOX1_ROW);
  for (const row of rows) {
    const anchor = L.labelAnchor(row, /^wages,/i);
    const v = L.valueBelow(layout, row, anchor, { bandLeft: 12, bandRight: 70, maxDrop: 22 });
    if (v != null) return v;
  }
  return null;
}

// ---- Wages Summary (unofficial preparer/tax-software attachment) ----
// Two shapes occur:
//   (A) Simple label:value — "Wages: $52,000.00" or "Total wages 52,000".
//   (B) A TABLE — "Wages" is a COLUMN HEADER, with the amount in a data row
//       far below it, plus a "Total" row. OCR flattens the table to lines like:
//         "SHALOM INSTITUTE CAMP 84-1652923 S 68,965 4,292 4,276 CA 68,965 ..."
//         "Total 68,965 4,292 4,276 68,965 2,881"
//       Here "Wages" isn't adjacent to the value, so label:value fails — we use
//       the table's structure instead. Wages is the FIRST money column, so the
//       first monetary value on the Total row (or the single data row) is it.
const WAGES_SUMMARY_ROW = /(?:total\s+)?wages(?:\s+and\s+salaries)?\b/i;

// A monetary token: has a thousands comma or decimal ($ optional). A bare EIN
// like 84-1652923 or an SSN won't match (they have dashes, not comma groups).
const MONEY_TOKEN_RE = /\$?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\$?\d+\.\d{2}/g;

function firstMoney(line) {
  const m = String(line).match(MONEY_TOKEN_RE);
  if (!m || !m.length) return null;
  const n = parseFloat(m[0].replace(/[$,]/g, ""));
  return isFinite(n) ? n : null;
}

// Layout path: "Wages" column header with the value in the same column band
// below it (the data/total row). Also handles the simple right-of-label case.
function lx_wages_summary(L, layout) {
  const rows = L.findRows(layout, WAGES_SUMMARY_ROW);
  for (const row of rows) {
    const anchor = L.labelAnchor(row, WAGES_SUMMARY_ROW);
    // Right of label, same row (simple "Wages: 52,000" layout).
    const right = L.valueOnRow(layout, row, { minX: anchor + 1 });
    if (right != null) return right;
    // Below the header, same column band — allow a large drop for tables where
    // the data row sits well beneath the header.
    const below = L.valueBelow(layout, row, anchor, { bandLeft: 40, bandRight: 90, maxDrop: 400 });
    if (below != null) return below;
  }
  return null;
}

// Flat-text path. Priority:
//   1. Simple label:value ("Wages: 52,000", "Total wages 52,000").
//   2. TABLE — the "Total" row's FIRST money value (Wages is the first money
//      column; the Total row sums all employers, which is what reconciles
//      against the 1040).
//   3. TABLE with no Total row — a single employer data row: first money value
//      after the employer EIN.
function f_wages_summary(text) {
  const t = (text || "").replace(/\r/g, "");

  // 1. Simple label:value. Guard against matching the column HEADER "Wages"
  //    with a value that's actually from a different column — only accept when
  //    a value sits immediately after the label word on the same run.
  const simple = _labelled(t.replace(/\s+/g, " "), "total\\s+wages")
              ?? _labelled(t.replace(/\s+/g, " "), "wages\\s+and\\s+salaries")
              ?? _labelled(t.replace(/\s+/g, " "), "salaries\\s+and\\s+wages");
  if (simple != null) return simple;

  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);

  // 2. Total row -> first money value.
  const totalLine = lines.find((l) => /^total\b/i.test(l) && MONEY_TOKEN_RE.test(l));
  if (totalLine) {
    const v = firstMoney(totalLine);
    if (v != null) return v;
  }

  // 3. Single data row (employer line with an EIN NN-NNNNNNN) -> first money.
  //    Use the FIRST such row's first money value. If there are multiple
  //    employer rows and no Total, sum their first-money values.
  const empRows = lines.filter((l) => /\b\d{2}-\d{7}\b/.test(l) && MONEY_TOKEN_RE.test(l));
  if (empRows.length === 1) {
    const v = firstMoney(empRows[0].replace(/\b\d{2}-\d{7}\b/, " ")); // drop EIN first
    if (v != null) return v;
  } else if (empRows.length > 1) {
    let sum = 0, any = false;
    for (const r of empRows) {
      const v = firstMoney(r.replace(/\b\d{2}-\d{7}\b/, " "));
      if (v != null) { sum += v; any = true; }
    }
    if (any) return sum;
  }

  // 4. Last resort: a bare "Wages" label followed somewhere by a value.
  return _labelled(t.replace(/\s+/g, " "), "\\bwages\\b");
}

// 1040 / Schedule 1 lines: value sits in the right-hand amount column,
// on the same visual row as the label.
function lx_rowValue(L, layout, labelRe, minX = 400) {
  const rows = L.findRows(layout, labelRe);
  for (const row of rows) {
    const v = L.valueOnRow(layout, row, { minX });
    if (v != null) return v;
  }
  return null;
}

// ---- Filing status + SSN count on a FILED 1040 ----
// The form prints checkboxes; the selected one is marked with an "X" text item
// placed at the box's coordinates. We find the "X" nearest each status label.
// Per the requirement: Single -> expect 1 SSN; Married filing jointly -> 2 SSNs.
function lx_1040_filing_status(L, layout) {
  const statuses = [
    { key: "Single", re: /(^|\s)Single(\s|$)/ },
    { key: "Married filing jointly", re: /married filing jointly/i },
    { key: "Married filing separately", re: /married filing separately/i },
    { key: "Head of household", re: /head of household/i },
    { key: "Qualifying surviving spouse", re: /qualifying surviving spouse/i }
  ];

  // Candidate "X" marks on the page.
  const marks = layout.items.filter((i) => /^X$/i.test(i.s));
  if (!marks.length) return null;

  let best = null;
  for (const st of statuses) {
    const rows = L.findRows(layout, st.re);
    for (const row of rows) {
      const lbl = row.items.find((i) => st.re.test(i.s));
      if (!lbl) continue;
      // An X marking this status sits just left of the label, on the same row.
      for (const m of marks) {
        const dy = Math.abs(m.y - row.y);
        const dx = lbl.x - m.x;
        if (dy <= 4 && dx > 0 && dx < 60) {
          const score = dx + dy;
          if (!best || score < best.score) best = { status: st.key, score };
        }
      }
    }
  }
  return best ? best.status : null;
}

// Collect SSNs printed on a filed 1040 (NNN-NN-NNNN). Dependent SSNs also
// appear, so we only count those in the taxpayer/spouse band near the top.
function lx_1040_ssns(L, layout, pageHeightHint) {
  const re = /^\d{3}-\d{2}-\d{4}$/;
  const all = layout.items.filter((i) => re.test(i.s));
  return all.map((i) => ({ ssn: i.s, x: i.x, y: i.y }));
}

const FIELD_FNS = {
  w2_box1: f_w2_box1,
  f1040_line1a: f_1040_line1a,
  f1040_line8: f_1040_line8,
  f1040_line23: f_1040_line23,
  sched1_line3: f_sched1_line3,
  sched1_line5: f_sched1_line5,
  sched1_line6: f_sched1_line6,
  schedC_line31: f_schedC_line31,
  roa_total_wages: f_roa_total_wages,
  roa_schedC_other_expenses: f_roa_schedC_other_expenses,
  roa_schedC_other_expenses_list: f_roa_schedC_other_expenses_list,
  roa_partnership_income: f_roa_partnership_income,
  roa_partnership_loss: f_roa_partnership_loss,
  roa_no_return_filed: f_roa_no_return_filed,
  schedE_line28: f_schedE_line28,
  schedE_line40: f_schedE_line40,
  schedE_see_statement: f_schedE_see_statement,
  f1040_is_joint: f_1040_is_joint,
  wages_summary: f_wages_summary
};

// Extract every field relevant to a detected doc type.
// Extract every field relevant to a detected doc type.
// `layout` (optional) enables positional extraction for real filed forms;
// when absent, or when a positional read misses, we fall back to flat-text
// regex (which is what IRS transcripts need).
function extractFields(docType, variant, text, layout, L) {
  const f = {};
  const useLayout = !!(layout && L);
  const pos = (fn) => {
    if (!useLayout) return null;
    try { return fn(); } catch (e) { return null; }
  };

  if (docType === "Form W-2") {
    f.w2_box1 = pos(() => lx_w2_box1(L, layout));
    if (f.w2_box1 == null) f.w2_box1 = f_w2_box1(text);
  } else if (docType === "Wages Summary") {
    // Unofficial preparer wages summary. Find the Wages value to the right of
    // (or below) the label. Store it in w2_box1 so it sums into the W-2 total
    // for the 1040 reconciliation, exactly like a scanned W-2's Box 1.
    f.w2_box1 = pos(() => lx_wages_summary(L, layout));
    if (f.w2_box1 == null) f.w2_box1 = f_wages_summary(text);
  } else if (docType === "Form 1040") {
    f.f1040_is_joint = f_1040_is_joint(text, layout, L);
    if (variant === "Transcript") {
      f.f1040_wages = f_roa_total_wages(text);
      f.roa_schedC_other_expenses = f_roa_schedC_other_expenses(text);
      f.roa_schedC_other_expenses_list = f_roa_schedC_other_expenses_list(text);
      f.roa_partnership_income = f_roa_partnership_income(text);
      f.roa_partnership_loss = f_roa_partnership_loss(text);
      f.roa_no_return_filed = f_roa_no_return_filed(text);
    } else {
      f.f1040_wages = pos(() => lx_rowValue(L, layout, /total amount from form\(s\) w-?2,?\s*box\s*1/i));
      if (f.f1040_wages == null) f.f1040_wages = f_1040_line1a(text);
      f.f1040_line8 = pos(() => lx_rowValue(L, layout, /additional income from schedule\s*1,?\s*line\s*10/i));
      if (f.f1040_line8 == null) f.f1040_line8 = f_1040_line8(text);
      f.f1040_line23 = pos(() => lx_rowValue(L, layout, /other taxes,?\s*including self-?employment tax/i));
      if (f.f1040_line23 == null) f.f1040_line23 = f_1040_line23(text);
    }
  } else if (docType === "Schedule 1") {
    f.sched1_line3 = pos(() => lx_rowValue(L, layout, /business income or \(?loss\)?\.?\s*attach schedule c/i));
    if (f.sched1_line3 == null) f.sched1_line3 = f_sched1_line3(text);
    f.sched1_line5 = pos(() => lx_rowValue(L, layout, /rental real estate,?\s*royalties,?\s*partnerships/i));
    if (f.sched1_line5 == null) f.sched1_line5 = f_sched1_line5(text);
    f.sched1_line6 = pos(() => lx_rowValue(L, layout, /farm income or \(?loss\)?\.?\s*attach schedule f/i));
    if (f.sched1_line6 == null) f.sched1_line6 = f_sched1_line6(text);
  } else if (docType === "Schedule C") {
    f.schedC_line31 = pos(() => lx_rowValue(L, layout, /net profit or \(?loss\)?/i));
    if (f.schedC_line31 == null) f.schedC_line31 = f_schedC_line31(text);
  } else if (docType === "Schedule E") {
    f.schedE_line28 = f_schedE_line28(text);
    f.schedE_see_statement = f_schedE_see_statement(text);
    f.schedE_line40 = pos(() => lx_rowValue(L, layout, /net farm rental income or \(?loss\)?/i));
    if (f.schedE_line40 == null) f.schedE_line40 = f_schedE_line40(text);
  }
  return f;
}

if (typeof module !== "undefined") {
  module.exports = { extractFields, FIELD_FNS, _labelled, _norm, lx_1040_filing_status, lx_1040_ssns, lx_w2_box1, lx_rowValue, f_roa_schedC_other_expenses, f_roa_schedC_other_expenses_list, f_roa_partnership_income, f_roa_partnership_loss };
}
