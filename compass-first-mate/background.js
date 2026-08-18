// Open the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});

// Fetch a document the active tab is showing and return it as base64.
//
// Two document sources need different fetch treatment:
//   1. Portal documents (FACTS etc.) are served by authenticated handlers such
//      as ScannedDocumentHandler.ashx?metadataId=...&appId=... — not a .pdf
//      URL. These need credentials: "include" so the user's session cookies
//      go along; without them the server returns an HTML login page.
//   2. Pre-signed S3 URLs (Ravenna transcripts) carry their own auth in the
//      query string (X-Amz-Signature / AWSAccessKeyId+Expires+Signature).
//      Sending cookies here does nothing useful and some bucket policies
//      reject requests with credentials/extra auth headers attached, so
//      these are fetched with credentials: "omit" to keep the signature
//      valid.
// In both cases the response is sniffed by magic bytes, because a login or
// error page can still come back as HTTP 200.
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function sniff(bytes, contentType) {
  const head = String.fromCharCode.apply(null, bytes.subarray(0, 512)).toLowerCase();
  if (bytes.length >= 4) {
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic === "%PDF") return { kind: "pdf" };
  }
  // Scanned pages are frequently served as images rather than PDFs.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { kind: "image", mime: "image/png" };
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { kind: "image", mime: "image/gif" };
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return { kind: "image", mime: "image/bmp" };
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00)) return { kind: "tiff" };

  if (head.includes("<!doctype html") || head.includes("<html")) {
    const login = /login|sign in|signin|session|expired|unauthorized|forbidden/.test(head);
    return { kind: "html", login };
  }
  if (contentType && contentType.indexOf("image/") === 0) {
    return { kind: "image", mime: contentType.split(";")[0] };
  }
  return { kind: "unknown" };
}

// Pre-signed S3 GET URL: v4 signing ("X-Amz-Signature=") or the older v2 form
// ("AWSAccessKeyId=...&Expires=...&Signature=").
function isPresignedS3Url(url) {
  if (!/\.s3[.\-][\w-]*\.amazonaws\.com\//i.test(url)) return false;
  return /X-Amz-Signature=/.test(url) || (/AWSAccessKeyId=/.test(url) && /Signature=/.test(url));
}

function fetchDoc(url) {
  const presigned = isPresignedS3Url(url);
  return fetch(url, {
    credentials: presigned ? "omit" : "include",
    redirect: "follow",
    headers: { "Accept": "application/pdf,image/*,*/*" }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FETCH_PDF" && msg.url) {
    fetchDoc(msg.url)
      .then(async (r) => {
        const contentType = r.headers.get("content-type") || "";
        if (!r.ok) {
          sendResponse({ ok: false, error: "Server returned " + r.status + " " + r.statusText });
          return;
        }
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (!bytes.length) { sendResponse({ ok: false, error: "Empty response from server." }); return; }

        const info = sniff(bytes, contentType);
        if (info.kind === "html") {
          sendResponse({
            ok: false,
            error: info.login
              ? "The portal returned a login page. Make sure the document is open and you're signed in, then try again."
              : "The server returned a web page, not a document."
          });
          return;
        }
        if (info.kind === "tiff") {
          sendResponse({ ok: false, error: "TIFF isn't supported by the browser. Use 'Open from computer' after converting." });
          return;
        }
        if (info.kind === "unknown") {
          sendResponse({ ok: false, error: "Unrecognized content (" + (contentType || "unknown type") + ")." });
          return;
        }
        sendResponse({ ok: true, kind: info.kind, mime: info.mime || contentType, data: bytesToBase64(bytes) });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true; // async
  }

  // SSS discovery: find the Ravenna family-transcript popup by URL and scrape
  // its rendered text. The transcript renders as real HTML text, so we read
  // the DOM directly — no S3 fetch, no OCR.
  if (msg.type === "SSS_SCRAPE_TRANSCRIPT") {
    scrapeRavennaTranscript()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true; // async
  }
});

// URL of the family transcript popup, e.g.
// https://aid.ravennasolutions.com/admin/familyTranscript?recordId=a5UVs000000NrtLMAS
const RAVENNA_TRANSCRIPT_RE = /^https:\/\/aid\.ravennasolutions\.com\/admin\/familyTranscript\?/i;

function recordIdFromUrl(url) {
  try { return new URL(url).searchParams.get("recordId") || null; }
  catch (e) { return null; }
}

// This function is serialized and injected into the popup's page context via
// chrome.scripting.executeScript, so it must be fully self-contained — no
// references to anything outside its own body. It walks the document, any
// same-origin iframes, and open shadow roots, and returns the transcript text.
function scrapeTranscriptDom() {
  const shadowHosts = [];

  function collectText(root, acc) {
    if (!root) return;
    const containers = root.querySelectorAll
      ? root.querySelectorAll("main, [class*=transcript], [id*=transcript], .content, article, table")
      : [];
    if (containers && containers.length) {
      let best = "";
      containers.forEach((c) => {
        const t = (c.innerText || c.textContent || "").trim();
        if (t.length > best.length) best = t;
      });
      if (best) acc.push(best);
    }
    // Recurse into open shadow roots and note their hosts (diagnostic).
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    all.forEach((el) => {
      if (el.shadowRoot) {
        shadowHosts.push(el.tagName.toLowerCase() + (el.id ? "#" + el.id : ""));
        collectText(el.shadowRoot, acc);
      }
    });
  }

  const acc = [];
  // Baseline: the whole document's rendered text. This catches the transcript
  // regardless of how it's nested, as long as it's in THIS frame's document.
  const bodyText = (document.body && (document.body.innerText || document.body.textContent) || "").trim();
  if (bodyText) acc.push(bodyText);

  // Then targeted containers (may beat body if body has lots of chrome/nav).
  collectText(document, acc);

  // Same-origin child iframes (cross-origin ones throw and are skipped, but
  // executeScript with allFrames also injects INTO them separately).
  const iframeEls = document.querySelectorAll("iframe");
  const iframeSrcs = [];
  iframeEls.forEach((f) => {
    iframeSrcs.push(f.src || f.getAttribute("src") || "(no src)");
    try {
      const doc = f.contentDocument;
      if (doc && doc.body) {
        const t = (doc.body.innerText || doc.body.textContent || "").trim();
        if (t) acc.push(t);
      }
    } catch (e) { /* cross-origin — handled by allFrames injection */ }
  });

  let text = "";
  acc.forEach((t) => { if (t.length > text.length) text = t; });

  return {
    text,
    chars: text.length,
    // Diagnostics (only meaningful when chars is low):
    bodyLen: bodyText.length,
    iframes: iframeSrcs,
    shadowHosts,
    sample: text.slice(0, 120)
  };
}

async function scrapeRavennaTranscript() {
  // 1) Find the popup tab across every window.
  const tabs = await chrome.tabs.query({});
  const matches = tabs.filter((t) => t.url && RAVENNA_TRANSCRIPT_RE.test(t.url));

  if (!matches.length) {
    return {
      ok: false,
      error: "No Ravenna transcript popup found. Open the family transcript (the familyTranscript popup) first, then click again."
    };
  }
  // If several are open, prefer the most recently focused/active one.
  matches.sort((a, b) => (b.active === a.active ? 0 : b.active ? 1 : -1));
  const tab = matches[0];
  const recordId = recordIdFromUrl(tab.url);

  // 2) Inject the scraper into the popup — into ALL frames, since the
  // transcript may live in a nested (even cross-origin) iframe. Each frame
  // returns its own text + diagnostics; we keep the longest text block.
  let injection;
  try {
    injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: scrapeTranscriptDom
    });
  } catch (e) {
    return { ok: false, error: "Couldn't read the transcript popup: " + (e && e.message ? e.message : e) +
      " (make sure it's fully loaded).", recordId };
  }

  // Aggregate across frames: pick the frame with the most text.
  const results = (injection || []).map((r) => r && r.result).filter(Boolean);
  let best = { text: "", chars: 0 };
  const diag = [];
  for (const r of results) {
    if (r.chars > best.chars) best = r;
    diag.push({ chars: r.chars, bodyLen: r.bodyLen, iframes: r.iframes, shadowHosts: r.shadowHosts, sample: r.sample });
  }

  if (!best.text || best.chars < 20) {
    // Surface what the DOM actually looked like so we can see WHY it's empty
    // instead of guessing "still loading".
    return {
      ok: false,
      error: "Found the popup" + (recordId ? ` (recordId ${recordId})` : "") +
        " but couldn't read transcript text. Diagnostics: " + JSON.stringify(diag),
      recordId,
      diagnostics: diag
    };
  }

  return { ok: true, text: best.text, recordId, url: tab.url, chars: best.chars };
}
