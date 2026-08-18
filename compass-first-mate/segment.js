// Split a PDF into logical documents.
//
// A single upload is often a PACKET: e.g. Form 1040 (pages 1-2) followed by
// Schedule 1 (pages 3-4), or several W-2s. Classifying the concatenated text
// picks one winner and loses the rest — and the rules engine needs to know that
// Schedule 1 is "present in the file", so each form must be registered.
//
// Strategy: classify each page independently, then merge consecutive pages of
// the same type into one document. Continuation pages ("Page 2") usually score
// lower but classify the same, so consecutive-merge handles them naturally.

function segmentPages(pageResults) {
  // pageResults: [{ page, type, variant, confidence, text, layout }]

  // IRS TRANSCRIPTS are one continuous document: a 1040 transcript's later
  // pages reference "Schedule 2", "Form W-2 wages", etc., so per-page
  // classification would shatter it into phantom documents. If any page reads
  // as a Transcript, treat the whole file as that single transcript.
  const transcriptPage = pageResults.find((p) => p.variant === "Transcript" && p.type !== "Unknown");
  if (transcriptPage) {
    const all = pageResults.filter((p) => p.text && p.text.trim());
    return [{
      docType: transcriptPage.type,
      variant: "Transcript",
      confidence: Math.max(...pageResults.map((p) => p.confidence || 0)),
      pages: all.map((p) => p.page),
      text: all.map((p) => p.text).join("\n"),
      layouts: all.map((p) => p.layout)
    }];
  }

  // FILED FORMS: a single PDF is often a packet (1040 pages 1-2, then
  // Schedule 1 pages 3-4). Merge consecutive pages of the same type.
  const docs = [];
  for (const pr of pageResults) {
    const last = docs[docs.length - 1];
    if (last && last.docType === pr.type && pr.type !== "Unknown") {
      last.pages.push(pr.page);
      last.text += "\n" + pr.text;
      last.layouts.push(pr.layout);
      last.confidence = Math.max(last.confidence, pr.confidence);
      continue;
    }
    if (pr.type === "Unknown") {
      if (last) {
        last.pages.push(pr.page);
        last.text += "\n" + pr.text;
        last.layouts.push(pr.layout);
      }
      continue;
    }
    docs.push({
      docType: pr.type,
      variant: pr.variant,
      confidence: pr.confidence,
      pages: [pr.page],
      text: pr.text,
      layouts: [pr.layout]
    });
  }
  return docs;
}

if (typeof module !== "undefined") {
  module.exports = { segmentPages };
}
