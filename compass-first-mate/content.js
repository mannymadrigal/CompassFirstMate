// Ravenna (aid.ravennasolutions.com) locator.
//
// Ravenna renders the transcript inside an <iframe> whose src is a
// pre-signed S3 URL, buried inside one or more LWC/Aura shadow roots. The
// side panel can't reach into the page's DOM itself (no content-script
// injection from there), so this script runs on the page, walks every open
// shadow root it can find, and hands back the first S3 iframe src it locates.
//
// This is purely a LOCATOR. It does not fetch or interpret anything — once it
// returns a URL, the existing fetch -> sniff -> classify -> extract -> rules
// pipeline in background.js / sidepanel.js takes over unchanged.

// Recognize a pre-signed S3 URL: bucket host + the signature query params
// that come with GET pre-signed links (v2 or v4 signing).
const S3_IFRAME_RE = /\.s3[.\-][\w-]*\.amazonaws\.com\//i;
const S3_SIGNED_RE = /(X-Amz-Signature=|Expires=.*Signature=|AWSAccessKeyId=)/i;

function looksLikeS3TranscriptSrc(src) {
  if (!src) return false;
  if (!S3_IFRAME_RE.test(src)) return false;
  return S3_SIGNED_RE.test(src) || /\.pdf(\?|$)/i.test(src) || /\.(png|jpe?g)(\?|$)/i.test(src);
}

// Depth-first walk of the document (and every open shadow root nested inside
// it) collecting all <iframe> elements. Closed shadow roots aren't reachable
// from content scripts — those simply won't be found.
function collectIframes(root, out) {
  const iframes = root.querySelectorAll ? root.querySelectorAll("iframe") : [];
  iframes.forEach((f) => out.push(f));

  const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
  all.forEach((el) => {
    if (el.shadowRoot) collectIframes(el.shadowRoot, out);
  });
}

function findTranscriptIframeSrc() {
  const found = [];
  collectIframes(document, found);
  for (const f of found) {
    const src = f.src || f.getAttribute("src") || "";
    if (looksLikeS3TranscriptSrc(src)) return src;
  }
  // Fallback: some Ravenna layouts load the PDF via an <embed> or <object>
  // instead of an <iframe> (same shadow-DOM depth problem).
  const embeds = [];
  (function collectEmbeds(root) {
    const els = root.querySelectorAll ? root.querySelectorAll("embed,object") : [];
    els.forEach((e) => embeds.push(e));
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    all.forEach((el) => { if (el.shadowRoot) collectEmbeds(el.shadowRoot); });
  })(document);
  for (const e of embeds) {
    const src = e.src || e.data || e.getAttribute("src") || e.getAttribute("data") || "";
    if (looksLikeS3TranscriptSrc(src)) return src;
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "RAVENNA_FIND_TRANSCRIPT") {
    try {
      const src = findTranscriptIframeSrc();
      sendResponse({ ok: !!src, url: src || null });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    return false; // synchronous
  }
});
