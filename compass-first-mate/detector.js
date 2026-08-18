// Tax document classifier.
// Scores each form type using ordered rules: strong title matches first,
// then OMB control numbers, then supporting keywords. Each rule also carries
// `transcript` signals so both the filed form AND its IRS transcript version
// are recognized. Order matters: specific schedules/returns are evaluated
// before the generic 1040 so "Schedule 1 (Form 1040)" isn't read as a 1040.

const FORM_RULES = [
  {
    type: "Wages Summary",
    label: "Wages and Salaries Summary (unofficial)",
    // Preparer/tax-software attachments summarizing wages — NOT an official W-2.
    // Match the summary title strongly; these are the phrasings such attachments
    // use. Checked before Form W-2 so a "Wages and Salaries Summary" isn't read
    // as an official W-2.
    strong: [
      /wages?\s+and\s+salaries\s+summary/i,
      /wage\s+and\s+salary\s+summary/i,
      /wages?\s+summary\s+(?:statement|attachment|worksheet)/i,
      /salaries\s+and\s+wages\s+summary/i
    ],
    omb: [],
    transcript: [],
    keywords: [
      /total wages/i,
      /wages/i,
      /salaries/i,
      /employer/i,
      /taxpayer/i,
      /spouse/i
    ]
  },
  {
    type: "Form W-2",
    label: "W-2 — Wage and Tax Statement",
    strong: [/wage and tax statement/i, /\bform\s*w-?2\b/i],
    omb: [/1545-0008/],
    // W-2 data appears inside an IRS "Wage and Income Transcript".
    transcript: [/wage and income transcript/i, /w-?2\s+submission type/i, /w-?2\s+whc/i],
    keywords: [
      /social security wages/i,
      /medicare wages and tips/i,
      /employer identification number/i,
      /wages,?\s*tips[,\s]+(?:and\s+)?other\s*compensation/i,
      /federal income tax withheld/i
    ]
  },
  {
    type: "Schedule C",
    label: "Schedule C — Profit or Loss From Business",
    strong: [/profit or loss from business/i, /schedule c\s*\(form 1040\)/i],
    omb: [/1545-0074/],
    transcript: [/schedule c.{0,40}(?:return transcript|per computer)/i, /schedule c--/i],
    keywords: [
      /sole proprietorship/i,
      /gross receipts or sales/i,
      /cost of goods sold/i,
      /principal business or profession/i
    ]
  },
  {
    type: "Schedule E",
    label: "Schedule E — Supplemental Income and Loss",
    strong: [/supplemental income and loss/i, /schedule e\s*\(form 1040\)/i],
    omb: [/1545-0074/],
    transcript: [/schedule e.{0,40}(?:return transcript|per computer)/i, /schedule e--/i],
    keywords: [
      /rental real estate/i,
      /royalties/i,
      /partnerships and s corporations/i,
      /from rental real estate/i,
      /estates and trusts/i
    ]
  },
  {
    type: "Schedule F",
    label: "Schedule F — Profit or Loss From Farming",
    strong: [/profit or loss from farming/i, /schedule f\s*\(form 1040\)/i],
    omb: [/1545-0074/],
    transcript: [/schedule f.{0,40}(?:return transcript|per computer)/i, /schedule f--/i],
    keywords: [
      /farm income/i,
      /agricultural program payments/i,
      /cooperative distributions/i,
      /livestock/i
    ]
  },
  {
    type: "Schedule 2",
    label: "Schedule 2 — Additional Taxes",
    strong: [/additional taxes/i, /schedule 2\s*\(form 1040\)/i],
    omb: [/1545-0074/],
    transcript: [/schedule 2.{0,40}(?:return transcript|per computer)/i, /schedule 2--/i],
    keywords: [
      /self-?employment tax/i,
      /alternative minimum tax/i,
      /excess advance premium tax credit/i,
      /unreported social security/i
    ]
  },
  {
    type: "Schedule 1",
    label: "Schedule 1 — Additional Income and Adjustments",
    strong: [
      /additional income and adjustments to income/i,
      /schedule 1\s*\(form 1040\)/i
    ],
    omb: [/1545-0074/],
    transcript: [/schedule 1.{0,40}(?:return transcript|per computer)/i, /schedule 1--/i],
    keywords: [
      /additional income/i,
      /adjustments to income/i,
      /taxable refunds/i,
      /alimony received/i,
      /educator expenses/i
    ]
  },
  {
    type: "Form 1120-S",
    label: "Form 1120-S — U.S. Income Tax Return for an S Corporation",
    // Checked before Form 1065 so an S-corp return isn't misread as a
    // partnership return (both are business returns with K-1s).
    strong: [
      /income tax return for an s corporation/i,
      /\bform\s*1120-?s\b/i
    ],
    omb: [/1545-0123/],
    transcript: [
      /1120-?s.{0,40}return transcript/i,
      /form 1120-?s per computer/i
    ],
    keywords: [
      /s corporation/i,
      /shareholder/i,
      /schedule k-?1/i,
      /ordinary business income/i
    ]
  },
  {
    type: "Form 1065",
    label: "Form 1065 — U.S. Return of Partnership Income",
    strong: [
      /u\.?s\.? return of partnership income/i,
      /\bform\s*1065\b/i
    ],
    omb: [/1545-0123/],
    // Business return transcripts: "Return Transcript" alongside the 1065 marker.
    transcript: [
      /1065.{0,40}return transcript/i,
      /partnership.{0,20}return transcript/i,
      /form 1065 per computer/i
    ],
    keywords: [
      /ordinary business income/i,
      /partnership/i,
      /schedule k-?1/i,
      /number of schedules k-?1/i,
      /gross receipts or sales/i
    ]
  },
  {
    type: "Form 1040",
    label: "Form 1040 / 1040-SR — U.S. Individual Income Tax Return",
    // Covers both Form 1040 and Form 1040-SR (U.S. Tax Return for Seniors).
    // The 1040-SR has identical line numbering (Box 1a, line 8, line 23, etc.),
    // so it classifies as "Form 1040" and every 1040 rule applies to it too —
    // matching the workbook, whose 1040 rows apply to "1040 or 1040-SR".
    strong: [
      /u\.?s\.? individual income tax return/i,
      /u\.?s\.? tax return for seniors/i,
      /\bform\s*1040(?:-?sr)?\b/i,
      /form\s*number:?\s*1040(?:-?sr)?\b/i
    ],
    omb: [/1545-0074/],
    // 1040 transcripts: "Tax Return Transcript", "Record of Account", or
    // "Account Transcript"; all carry "Form Number: 1040".
    transcript: [
      /tax return transcript/i,
      /record of account/i,
      /account transcript/i,
      /form\s*number:?\s*1040(?:-?sr)?\b/i,
      /form 1040(?:-?sr)? per computer/i
    ],
    keywords: [
      /filing status/i,
      /standard deduction/i,
      /adjusted gross income/i,
      /qualifying surviving spouse/i,
      /head of household/i
    ]
  }
];

// Detect against extracted text. Order matters: more specific schedules are
// evaluated before the generic 1040 so a "Schedule 1 (Form 1040)" isn't
// misread as a bare 1040.
function classifyTaxDocument(rawText) {
  const text = (rawText || "").replace(/\s+/g, " ").trim();
  if (!text) return { type: "Unknown", confidence: 0, matches: [], label: "No text found" };

  const scored = FORM_RULES.map((rule) => {
    const matches = [];
    let score = 0;
    let isTranscript = false;

    rule.strong.forEach((re) => {
      if (re.test(text)) { score += 50; matches.push("Title: " + re.source); }
    });
    rule.omb.forEach((re) => {
      if (re.test(text)) { score += 10; matches.push("OMB No. " + re.source); }
    });
    (rule.transcript || []).forEach((re) => {
      if (re.test(text)) { score += 20; isTranscript = true; matches.push("Transcript: " + re.source); }
    });
    rule.keywords.forEach((re) => {
      if (re.test(text)) { score += 8; matches.push("Keyword: " + re.source); }
    });

    return { ...rule, score, matches, isTranscript };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1] || { score: 0 };

  if (best.score === 0) {
    return { type: "Unknown", confidence: 0, matches: [], label: "Not a recognized tax form", variant: null };
  }

  // Confidence: scaled by best score and how far it leads the runner-up.
  const lead = best.score - second.score;
  let confidence = Math.min(99, Math.round((best.score / (best.score + 30)) * 100));
  if (best.score >= 50 && lead >= 20) confidence = Math.max(confidence, 90);

  const variant = best.isTranscript ? "Transcript" : "Standard";

  return {
    type: best.type,
    label: best.label,
    variant,
    confidence,
    matches: best.matches,
    runnerUp: second.type ? { type: second.type, score: second.score } : null
  };
}

// Normalize a raw dollar string to "0.00" format. Returns "0.00" for
// missing/blank/zero values per requirement.
function normalizeAmount(raw) {
  if (raw == null) return "0.00";
  // Strip currency symbols, spaces, and thousands separators.
  let s = String(raw).replace(/[$\s]/g, "").replace(/,/g, "");
  if (!s) return "0.00";
  const n = parseFloat(s);
  if (!isFinite(n) || n === 0) return "0.00";
  return n.toFixed(2);
}

// Extract Box 1 "Wages, tips, other compensation" from W-2 text.
// W-2 layouts vary: the label and the number may be adjacent, the label may
// carry a "1" box marker, or the amount may sit just before/after the label.
// We try several patterns in priority order and fall back to "0.00".
function extractW2Box1(rawText) {
  const text = (rawText || "").replace(/\s+/g, " ").trim();
  if (!text) return "0.00";

  // Amount: optional $, then digits with optional thousands separators and
  // optional cents. Order the alternatives longest-first and require a word
  // boundary so we don't capture a truncated number.
  const AMT = "\\$?\\s*((?:[0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{2})?)|(?:[0-9]+\\.[0-9]{2})|(?:[0-9]+))";

  // Label variants: standard W-2 says "Wages, tips, other compensation";
  // IRS Wage & Income transcripts say "Wages, Tips and Other Compensation".
  // Accept comma or "and" between segments.
  const LBL = "wages,?\\s*tips[,\\s]+(?:and\\s+)?other\\s*compensation";

  const patterns = [
    // "1 Wages, tips, other compensation  52,000.00"  (box marker before label)
    new RegExp("\\b1\\b[^A-Za-z0-9]{0,4}" + LBL + "\\s*[:\\-]?\\s*" + AMT, "i"),
    // "Wages, tips, other compensation 1 39,900.12"  (box marker after label)
    new RegExp(LBL + "\\s+1\\s+" + AMT, "i"),
    // "Wages, Tips and Other Compensation: $19,056.00"  (label then amount / transcript)
    new RegExp(LBL + "\\s*[:\\-]?\\s*" + AMT, "i"),
    // "52,000.00  Wages, tips, other compensation"  (amount immediately before label)
    new RegExp(AMT + "\\s{0,3}(?:1\\s+)?" + LBL, "i")
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const val = normalizeAmount(m[1]);
      if (val !== "0.00") return val;
    }
  }
  // Label present but no parseable amount (or amount is zero) -> 0.00
  return "0.00";
}

// Extract "Total wages:" from a 1040 transcript (Record of Account / Tax
// Return Transcript). The transcript income section lists "Total wages:
// $29,006.00". We anchor on the exact label so nearby lines like "Form W-2
// wages" or "Total income" aren't picked up. Falls back to "0.00".
function extract1040TotalWages(rawText) {
  const text = (rawText || "").replace(/\s+/g, " ").trim();
  if (!text) return "0.00";

  const AMT = "\\$?\\s*((?:[0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{2})?)|(?:[0-9]+\\.[0-9]{2})|(?:[0-9]+))";

  const patterns = [
    // "Total wages: $29,006.00"  (^ boundary so it isn't part of another label)
    new RegExp("(?:^|[^a-z])total\\s+wages\\s*[:\\-]?\\s*" + AMT, "i"),
    // Fallback: "Form W-2 wages: $29,006.00" if Total wages is absent
    new RegExp("form\\s*w-?2\\s*wages\\s*[:\\-]?\\s*" + AMT, "i")
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const val = normalizeAmount(m[1]);
      if (val !== "0.00") return val;
    }
  }
  return "0.00";
}

if (typeof module !== "undefined") {
  module.exports = { classifyTaxDocument, extractW2Box1, extract1040TotalWages, normalizeAmount };
}
