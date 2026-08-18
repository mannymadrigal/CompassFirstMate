// Deterministic rules engine.
// Evaluates a SESSION (a set of scanned documents) against rules.json.
// Presence checks ("is Schedule 1 in the file?") require the whole set,
// which is why rules run over the session rather than one document.

// session = {
//   docs: [ { docType, variant, filename, fields, viaOCR } ],
// }

function money(n) {
  return "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function docsOfType(session, type) {
  return session.docs.filter((d) => d.docType === type);
}

function hasDoc(session, type) {
  return docsOfType(session, type).length > 0;
}

// Sum a field across all docs of a type, ignoring nulls.
// Returns null if no doc of that type contributed a value.
function sumField(session, type, field) {
  const vals = docsOfType(session, type)
    .map((d) => d.fields[field])
    .filter((v) => typeof v === "number");
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0);
}

// Documents that contribute a "W-2 Box 1" wage figure: official W-2s AND
// unofficial "Wages Summary" attachments (a preparer wages-and-salaries
// summary stands in for a W-2's Box 1). Both store the value in w2_box1.
function wageDocs(session) {
  return session.docs.filter(
    (d) => d.docType === "Form W-2" || d.docType === "Wages Summary"
  );
}

// Sum of all wage-document Box 1 values (W-2s + Wages Summaries).
// Null if none contributed a numeric value.
function sumW2Box1(session) {
  const vals = wageDocs(session)
    .map((d) => d.fields.w2_box1)
    .filter((v) => typeof v === "number");
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0);
}

// The 1040 wages figure, whichever variant supplied it.
function get1040Wages(session) {
  const docs = docsOfType(session, "Form 1040");
  for (const d of docs) {
    if (typeof d.fields.f1040_wages === "number") return d.fields.f1040_wages;
  }
  return null;
}

// Find the first doc of a type that has a numeric field.
function firstFieldValue(session, type, field) {
  for (const d of docsOfType(session, type)) {
    if (typeof d.fields[field] === "number") return d.fields[field];
  }
  return null;
}

// Is any 1040 in the session a joint return? Returns the required W-2 minimum.
function requiredW2Count(session) {
  const joint = docsOfType(session, "Form 1040").some(
    (d) => d.fields.f1040_is_joint && d.fields.f1040_is_joint.joint
  );
  return joint ? 2 : 1;
}

function w2Count(session) {
  return wageDocs(session).length;
}

// Does a given 1040 have a Box 1a / Total Wages VALUE yet? A value counts
// whether it came from OCR, a text read, or the reviewer typing it in — the
// only thing that holds the wage-dependent steps is having no number at all.
function has1040WageValue(doc) {
  const v = doc.fields.f1040_wages;
  return typeof v === "number";
}

// Any 1040 in the session with no wage value yet? Returns the first such doc
// (for messaging), or null if every 1040 has a value.
function missingWage1040(session) {
  return docsOfType(session, "Form 1040").find((d) => !has1040WageValue(d)) || null;
}

// A "hold" result shown when a wage-dependent step can't run yet because a
// 1040's Box 1a / Total Wages value is missing (unreadable and not typed in).
// Styled like the joint-return gate.
function wageMissingBlock(rule, doc) {
  const which = doc.variant === "Transcript" ? "Total Wages" : "Box 1a";
  return {
    id: rule.id, status: "blocked", severity: "blocked",
    message: `The 1040 ${which} value couldn't be read. Enter it on the ` +
             `document above, then re-run the analysis.`,
    rule, data: { missingWage: true }
  };
}

// ---- Individual check implementations ----
const CHECKS = {
  // Sum of W-2s is MORE than the 1040 -> Make Note (no threshold).
  w2_sum_vs_1040_more(rule, session, cfg) {
    const missing = missingWage1040(session);
    if (missing) return wageMissingBlock(rule, missing);
    const gate = w2GateBlock(rule, session);
    if (gate) return gate;
    const w2sum = sumW2Box1(session);
    const v1040 = get1040Wages(session);
    if (w2sum == null || v1040 == null) return skip(rule, "Need at least one W-2 and one 1040 value.");
    const diff = w2sum - v1040;
    if (diff > 0) {
      return fire(rule, rule.output.replace("$xx", money(diff)), { w2sum, v1040, diff });
    }
    return pass(rule, { w2sum, v1040, diff });
  },

  // Sum of W-2s is $20,000+ LESS than the 1040 -> Request additional W-2s.
  w2_sum_vs_1040_short(rule, session, cfg) {
    const missing = missingWage1040(session);
    if (missing) return wageMissingBlock(rule, missing);
    const gate = w2GateBlock(rule, session);
    if (gate) return gate;
    const w2sum = sumW2Box1(session);
    const v1040 = get1040Wages(session);
    if (w2sum == null || v1040 == null) return skip(rule, "Need at least one W-2 and one 1040 value.");
    const shortfall = v1040 - w2sum;                  // positive when W-2s fall short
    const threshold = cfg.thresholds.w2_shortfall;    // 20000
    if (shortfall >= threshold) {
      return fire(rule, rule.output.replace("$xx", money(shortfall)), { w2sum, v1040, shortfall, requestMore: "Additional W-2s" });
    }
    return pass(rule, { w2sum, v1040, shortfall });
  },

  // Value > 0 AND the named companion document is absent -> request it.
  gt_zero_and_missing_doc(rule, session) {
    const val = firstFieldValue(session, rule.docType, rule.field);
    if (val == null) return skip(rule, `No ${rule.docType} value read for this field.`);
    if (val <= 0) return pass(rule, { value: val });
    if (hasDoc(session, rule.missingDoc)) {
      return pass(rule, { value: val, note: `${rule.missingDoc} is present — no action.` });
    }
    return fire(rule, rule.output, { value: val, missing: rule.missingDoc });
  },

  // 1040 Line 8 (Additional income from Schedule 1). Box 8 > 0 requires
  // Schedule 1 — UNLESS the income is already fully accounted for by the
  // schedules in the file. Specifically:
  //   - Box 8 <= 0 or unread -> no action.
  //   - Schedule 1 present -> no action.
  //   - Schedule 1 absent, but sum(all Schedule C Box 31) + sum(all Schedule E
  //     Box 40) EXACTLY equals Box 8 -> no action (the detail is already here).
  //   - Otherwise -> request Schedule 1.
  //
  // READ-FAILURE HANDLING: the exact-match escape is only trustworthy when the
  // values it compares were actually read. If a Schedule C or E is PRESENT in
  // the file but its Box 31 / Box 40 value couldn't be read (OCR failed, no
  // manual entry yet), the comparison is unreliable — we must NOT treat the
  // unread value as 0 (which could wrongly pass or wrongly fire). Instead we
  // HOLD and ask the reviewer to enter the missing box, then re-run.
  line8_sched1_or_schedCE_match(rule, session) {
    const box8 = firstFieldValue(session, "Form 1040", "f1040_line8");
    if (box8 == null) return skip(rule, "No 1040 Line 8 value read.");
    if (box8 <= 0) return pass(rule, { value: box8 });
    if (hasDoc(session, "Schedule 1")) {
      return pass(rule, { value: box8, note: "Schedule 1 is present — no action." });
    }

    // Schedule 1 absent. Reconcile against Schedule C Box 31 + Schedule E Box 40.
    // Distinguish "schedule not in file" (contributes 0) from "schedule in file
    // but value unreadable" (unknown — can't trust the comparison).
    const cPresent = hasDoc(session, "Schedule C");
    const ePresent = hasDoc(session, "Schedule E");
    const cSum = sumField(session, "Schedule C", "schedC_line31"); // null if unread
    const eSum = sumField(session, "Schedule E", "schedE_line40"); // null if unread

    const cUnreadable = cPresent && cSum == null;
    const eUnreadable = ePresent && eSum == null;
    if (cUnreadable || eUnreadable) {
      const which = [cUnreadable ? "Schedule C Box 31" : null,
                     eUnreadable ? "Schedule E Box 40" : null].filter(Boolean).join(" and ");
      return {
        id: rule.id, status: "blocked", severity: "blocked",
        message: `1040 Line 8 is ${money(box8)} and Schedule 1 isn't in the file. ` +
          `Can't confirm the schedules cover it because ${which} couldn't be read — ` +
          `enter ${cUnreadable && eUnreadable ? "those values" : "that value"} on the ` +
          `document${cUnreadable && eUnreadable ? "s" : ""} above, then re-run.`,
        rule, data: { missingValue: true, box8 }
      };
    }

    // Both readable (or absent → genuine 0). Compare exactly.
    const haveAny = cPresent || ePresent;
    if (haveAny) {
      const combined = (cSum || 0) + (eSum || 0);
      if (combined === box8) {
        return pass(rule, {
          value: box8, combined,
          note: `Schedule C Box 31 + Schedule E Box 40 (${money(combined)}) equals Line 8 — no action.`
        });
      }
    }
    return fire(rule, rule.output, { value: box8, missing: "Schedule 1" });
  },

  // Sum of Schedule C(s) net profit is LESS than Schedule 1 line 3.
  schedC_sum_vs_sched1(rule, session) {
    const cSum = sumField(session, "Schedule C", "schedC_line31");
    const s1 = firstFieldValue(session, "Schedule 1", "sched1_line3");
    if (cSum == null || s1 == null) return skip(rule, "Need Schedule 1 line 3 and at least one Schedule C.");
    const diff = s1 - cSum;
    if (diff > 0) {
      return fire(rule, rule.output.replace("$xx", money(diff)), { cSum, s1, diff, requestMore: "Additional Schedule C(s)" });
    }
    return pass(rule, { cSum, s1, diff });
  },

  gt_threshold(rule, session) {
    const val = firstFieldValue(session, rule.docType === "Form 1040 Record of Account" ? "Form 1040" : rule.docType, rule.field);
    if (val == null) return skip(rule, "Field not found in document.");
    if (val > rule.threshold) return fire(rule, rule.output, { value: val, threshold: rule.threshold });
    return pass(rule, { value: val });
  },

  lt_threshold(rule, session) {
    const val = firstFieldValue(session, rule.docType === "Form 1040 Record of Account" ? "Form 1040" : rule.docType, rule.field);
    if (val == null) return skip(rule, "Field not found in document.");
    if (val < rule.threshold) return fire(rule, rule.output, { value: val, threshold: rule.threshold });
    return pass(rule, { value: val });
  },

  // Collect unique EINs + business names from Schedule E line 28.
  schedE_collect_eins(rule, session) {
    const docs = docsOfType(session, "Schedule E");
    if (!docs.length) return skip(rule, "No Schedule E scanned.");
    const rows = [];
    docs.forEach((d) => (d.fields.schedE_line28 || []).forEach((r) => rows.push(r)));
    if (!rows.length) return pass(rule, { note: "No EINs found on line 28." });
    const seen = new Set();
    const uniq = rows.filter((r) => (seen.has(r.ein) ? false : (seen.add(r.ein), true)));
    const lines = uniq.map((r) => `${r.ein} — ${r.name}`);
    return fire(rule, "K-1 is needed for the following Businesses:\n\n" + lines.join("\n"), { businesses: uniq });
  },

  // "See statement" -> the referenced Federal Statement must be read.
  schedE_see_statement(rule, session) {
    const docs = docsOfType(session, "Schedule E");
    if (!docs.length) return skip(rule, "No Schedule E scanned.");
    const hit = docs.map((d) => d.fields.schedE_see_statement).find((v) => v && v.present);
    if (!hit) return pass(rule, { note: "Line 28(a) does not reference a statement." });
    const num = hit.statementNumber ? ` #${hit.statementNumber}` : "";
    return fire(
      rule,
      `Schedule E line 28(a) says "See statement${num}". Locate Federal Statement${num} (Schedule E, Page 2, Line 28) and capture the business names and EINs. K-1s will be needed for each.`,
      { statementNumber: hit.statementNumber, needsFuzzy: true }
    );
  },

  fed_statement_collect(rule, session) {
    return skip(rule, "Runs when a Federal Statement page is scanned.");
  },

  // Transcript says "No Record of return filed." -> nothing was filed for the
  // year, so request the full 1040. Fires on the presence flag alone.
  roa_no_return_filed(rule, session) {
    const flagged = docsOfType(session, "Form 1040").some(
      (d) => d.fields.roa_no_return_filed === true
    );
    if (!flagged) return skip(rule, "No '\''No Record of return filed'\'' marker in the session.");
    return fire(rule, rule.output, {});
  },

  // Wage field is exactly 0 -> no W-2s required (positive note, not action).
  // Rule 34 targets the standard 1040; rule 35 targets the transcript. Scope
  // each to its own variant so a single zero-wage 1040 doesn't fire both.
  // A MISSING value (unreadable and not typed) is not "zero" — it holds, so
  // Step 2 doesn't wrongly say "no W-2s required" when the figure is unknown.
  wage_zero_no_w2(rule, session) {
    const wantTranscript = rule.id === "roa_total_wages_no_w2";
    const docs = docsOfType(session, "Form 1040").filter((d) => {
      const isT = d.variant === "Transcript";
      return wantTranscript ? isT : !isT;
    });
    if (!docs.length) return skip(rule, "No matching 1040 variant in the session.");
    const zero = docs.some((d) => d.fields.f1040_wages === 0);
    if (!zero) {
      // A missing value holds (the gate on Steps 1/2 surfaces the ask); a
      // present non-zero value just means no note is due.
      const missing = docs.some((d) => typeof d.fields.f1040_wages !== "number");
      return skip(rule, missing
        ? "1040 wage value not read yet — enter it to continue."
        : "1040 wage value is present and non-zero.");
    }
    return fire(rule, rule.output, {});
  },

  // All-clear is resolved in evaluateRules() after every other rule, because
  // it depends on whether anything else fired. This stub keeps the registry
  // complete; the real decision happens in the post-pass.
  all_clear(rule, session) {
    return skip(rule, "Resolved in post-pass.");
  }
};

function fire(rule, message, data) {
  return { id: rule.id, status: "fired", severity: rule.severity || "action", message, rule, data };
}
function pass(rule, data) {
  return { id: rule.id, status: "pass", severity: "ok", message: "No action needed.", rule, data };
}
function skip(rule, why) {
  return { id: rule.id, status: "skipped", severity: "skip", message: why, rule, data: {} };
}

// Gate for the W-2 reconciliation checks. Only a JOINT 1040 gates: it needs
// 2 W-2s (taxpayer + spouse) before the reconciliation math is meaningful.
// A single (non-joint) return does not require a W-2 to exist, and a return
// whose wages are genuinely 0/null needs no W-2s at all — neither gates.
function w2GateBlock(rule, session) {
  if (!hasDoc(session, "Form 1040")) return null;

  // If every 1040's wage figure is 0/null, no W-2s are required — no gate.
  const anyWages = docsOfType(session, "Form 1040").some((d) => {
    const v = d.fields.f1040_wages;
    return typeof v === "number" && v > 0;
  });
  if (!anyWages) return null;

  // Only joint returns gate (need >= 2). Non-joint returns never gate here.
  const jointDoc = docsOfType(session, "Form 1040").find(
    (d) => d.fields.f1040_is_joint && d.fields.f1040_is_joint.joint
  );
  if (!jointDoc) return null;

  const need = 2;
  const have = w2Count(session);
  if (have >= need) return null;

  const reason = jointDoc.fields.f1040_is_joint.reason || "joint return";
  const msg = `This is a joint return (${reason}). Add ${need} W-2s (taxpayer + spouse) before the W-2 vs 1040 math can run — ${have} scanned so far.`;
  return {
    id: rule.id, status: "blocked", severity: "blocked",
    message: msg, rule, data: { need, have }
  };
}

// Evaluate all rules against a session. Only rules whose docType is present
// (or which compare across types) are meaningful; skipped ones report why.
// Rows 3/4 and 24/25 of the sheet express the same comparison for the standard
// vs transcript flavors, so identical fired messages are collapsed to one.
function evaluateRules(cfg, session) {
  const results = [];
  for (const rule of cfg.rules) {
    const fn = CHECKS[rule.check];
    if (!fn) { results.push(skip(rule, "No implementation for check: " + rule.check)); continue; }
    try {
      results.push(fn(rule, session, cfg));
    } catch (e) {
      results.push(skip(rule, "Error: " + e.message));
    }
  }
  // Collapse duplicate fired/blocked messages (keep the first, note source rows).
  const seen = new Map();
  const deduped = [];
  for (const r of results) {
    if (r.status !== "fired" && r.status !== "blocked") { deduped.push(r); continue; }
    const key = r.status + "::" + r.message;
    if (seen.has(key)) {
      seen.get(key).alsoFrom = (seen.get(key).alsoFrom || []).concat(r.rule.sheetRow);
      continue;
    }
    seen.set(key, r);
    deduped.push(r);
  }

  // All-clear post-pass: fire "Good news!" only when nothing requiring the
  // reviewer's attention fired. Positive notes (severity "ok") don't count
  // against all-clear; actions, notes-to-make, and blocked gates do.
  const attentionSeverities = new Set(["action", "note", "blocked"]);
  const anyAttention = deduped.some(
    (r) => (r.status === "fired" || r.status === "blocked") &&
           attentionSeverities.has(r.severity)
  );
  const allClearRule = cfg.rules.find((r) => r.check === "all_clear");
  if (allClearRule && !anyAttention && session.docs && session.docs.length) {
    deduped.push({
      id: allClearRule.id, status: "fired", severity: "ok",
      message: allClearRule.output, rule: allClearRule, data: {}
    });
  }

  return deduped;
}

if (typeof module !== "undefined") {
  module.exports = { evaluateRules, CHECKS, sumField, hasDoc };
}
if (typeof window !== "undefined") {
  window.__rules = { evaluateRules };
}
