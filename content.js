// ═══════════════════════════════════════════════════════════════════════════
// content.js — THE PAGE READER
//
// This file runs silently inside every webpage you visit (injected by Chrome
// as declared in manifest.json). It has one job: when the popup asks for it,
// extract the readable text from the current page and send it back.
//
// Think of it like a librarian that lives inside every webpage, waiting to
// be asked: "Hey, what does this page actually say?"
//
// HOW IT FITS IN:
//   popup.js (the UI) → sends a message → content.js (inside the page)
//   content.js extracts the text → sends it back → popup.js summarizes it
// ═══════════════════════════════════════════════════════════════════════════


// ── MESSAGE LISTENER ────────────────────────────────────────────────────────
// Set up a permanent listener that waits for messages from popup.js.
// When popup.js says "extractContent", this runs and sends back the page text.
//
// chrome.runtime.onMessage is Chrome's internal messaging system that lets
// different parts of the extension talk to each other.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // Check if the incoming message is specifically the "extractContent" request.
  // (We check this because multiple messages could theoretically be sent.)
  if (request.action === 'extractContent') {

    // Call our main extraction function and send its result back to popup.js.
    // .then(sendResponse) means: once extractContent() finishes, pass the
    // result to sendResponse(), which delivers it back to popup.js.
    extractContent().then(sendResponse);

    // Return true to tell Chrome: "this response will arrive asynchronously
    // (not immediately)". Without this, Chrome would close the message channel
    // before our async function finishes running.
    return true;
  }
});


// ── MAIN EXTRACTION ROUTER ───────────────────────────────────────────────────
// Decides whether we're on a YouTube page or a regular article page,
// then calls the appropriate extraction function.
async function extractContent() {

  // Get the current page's URL so we can check if it's YouTube.
  const url = window.location.href;

  // Check if the URL contains YouTube's video watch pattern.
  // youtu.be/ is YouTube's short URL format (e.g. youtu.be/abc123).
  const isYouTube = url.includes('youtube.com/watch') || url.includes('youtu.be/');

  if (isYouTube) {
    // It's a YouTube video — try to extract the spoken transcript.
    const transcript = await extractYouTubeTranscript();

    // Return a structured object with all the info popup.js needs.
    return {
      type: 'youtube',      // tells popup.js what kind of content this is
      title: document.title.replace(' - YouTube', '').trim(), // clean up the tab title
      content: transcript,  // the actual text to be summarized
      url                   // the page URL (shorthand for url: url)
    };
  }

  // It's a regular webpage — extract the article text.
  const article = extractArticleText();

  return {
    type: 'article',
    title: document.title.trim(),
    content: article,
    url
  };
}


// ── ARTICLE TEXT EXTRACTOR ───────────────────────────────────────────────────
// Pulls the main readable text from a webpage, stripping out navigation,
// ads, sidebars, comments, and other clutter.
function extractArticleText() {

  // A prioritized list of HTML elements to look for.
  // Most well-built websites wrap their main content in one of these.
  // We try each in order and stop at the first one we find.
  //   <article>       — the semantic HTML tag for article content
  //   <main>          — the semantic tag for the page's main content area
  //   [role="main"]   — an accessibility attribute meaning "main content"
  //   .post-content   — common CSS class used by WordPress and similar blogs
  //   .article-body   — common class used by news sites
  //   .entry-content  — another common WordPress class
  //   #content        — a common ID used for the main content area
  const selectors = ['article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content', '#content'];

  let el = null; // will hold the content element we find

  // Loop through each selector and stop as soon as we find a match.
  for (const sel of selectors) {
    el = document.querySelector(sel); // finds the first element matching this selector
    if (el) break; // found something — stop looking
  }

  // If none of the preferred selectors matched, fall back to the entire
  // page body. It's not ideal but better than returning nothing.
  if (!el) el = document.body;

  // Make a copy of the element so we can modify it without changing
  // what the user actually sees on the page.
  // cloneNode(true) means copy the element AND all its children.
  const clone = el.cloneNode(true);

  // List of "noisy" elements to remove from our copy.
  // These contain navigation, ads, and other things that aren't article content.
  const noiseSelectors = [
    'nav',              // navigation menus
    'header',           // page header (logo, main nav)
    'footer',           // page footer (links, copyright)
    'aside',            // sidebar content
    'script',           // JavaScript code (not text)
    'style',            // CSS styling code (not text)
    'noscript',         // fallback content for when JS is disabled
    '.ad', '.ads', '.advertisement',  // ad containers
    '.sidebar',         // sidebar panels
    '.comments',        // reader comment sections
    '.related',         // "related articles" widgets
    '.share', '.social',// social media share buttons
    '[aria-hidden="true"]', // elements intentionally hidden from readers
    '.cookie',          // cookie consent banners
    '.popup', '.modal', // popup dialogs
    '.newsletter'       // email signup forms
  ];

  // Remove each noisy element from our copy.
  noiseSelectors.forEach(sel => {
    // querySelectorAll finds ALL elements matching this selector.
    // forEach then removes each one from the cloned copy.
    clone.querySelectorAll(sel).forEach(n => n.remove());
  });

  // Extract the visible text from our cleaned-up copy.
  // innerText respects CSS visibility (hidden elements are excluded).
  // textContent is a fallback that gets all text regardless of visibility.
  const text = clone.innerText || clone.textContent || '';

  // Clean up the text:
  //   .replace(/\s+/g, ' ') — collapse multiple spaces/newlines into one space
  //   .trim()               — remove leading/trailing whitespace
  //   .slice(0, 15000)      — limit to 15,000 characters (the AI has a limit)
  return text.replace(/\s+/g, ' ').trim().slice(0, 15000);
}


// ── YOUTUBE TRANSCRIPT EXTRACTOR ─────────────────────────────────────────────
// Attempts to find and extract the spoken transcript of a YouTube video.
// YouTube has a built-in transcript feature — we try to access it.
async function extractYouTubeTranscript() {
  try {

    // YouTube sometimes hides the description. Try to find and click
    // a "show more" button to expand it, in case it reveals a transcript link.
    const descBtn = document.querySelector(
      '#description-inline-expander button, ytd-text-inline-expander button'
    );
    if (descBtn) descBtn.click(); // click it if found

    // Wait 500ms for the page to respond to our click before continuing.
    await sleep(500);

    // Look for a "..." or "More" button that might reveal additional options
    // including the transcript. (YouTube's UI varies — this is a fallback.)
    const moreBtn = Array.from(document.querySelectorAll('button')).find(b =>
      b.getAttribute('aria-label')?.toLowerCase().includes('more') ||
      b.textContent?.trim() === '...'
    );
    // Note: we found moreBtn here but don't use it in the next step —
    // we go straight for the transcript button directly.

    // Search ALL buttons and clickable elements on the page for one that
    // mentions "transcript" either in its visible text or its aria-label
    // (the accessibility label screen readers use).
    const transcriptBtn = Array.from(
      document.querySelectorAll('button, [role="button"]')
    ).find(b =>
      b.textContent?.toLowerCase().includes('transcript') ||
      b.getAttribute('aria-label')?.toLowerCase().includes('transcript')
    );

    if (transcriptBtn) {
      transcriptBtn.click(); // open the transcript panel

      // Wait 1.5 seconds for YouTube to load the transcript panel.
      // This is a deliberate pause — the transcript loads dynamically.
      await sleep(1500);

      // YouTube's transcript panel uses these specific element types.
      // Each "segment" is one line of the transcript with its timestamp.
      const segments = document.querySelectorAll(
        'ytd-transcript-segment-renderer, .segment-text'
      );

      if (segments.length > 0) {
        // Grab the text from each segment, remove empty ones, join into one string.
        const text = Array.from(segments)
          .map(s => s.textContent?.trim())   // get the text of each segment
          .filter(Boolean)                    // remove any empty/null entries
          .join(' ');                         // join all segments with a space

        return text.slice(0, 15000); // limit to 15,000 characters
      }
    }

    // ── FALLBACK: no transcript panel found ──
    // If we couldn't open the transcript, use the video description instead.
    // It's not as good as a full transcript, but better than nothing.
    const desc = document.querySelector(
      '#description-inline-expander, #description'
    )?.textContent || '';

    // Prefix the text so the AI knows it's working with a description, not a transcript.
    return `[Transcript unavailable — using description]\n\n${desc}`.slice(0, 15000);

  } catch (e) {
    // If anything above threw an error (e.g. YouTube changed their HTML structure),
    // catch it and try one last fallback: just grab the description text directly.
    const desc = document.querySelector('#description')?.textContent || '';
    return `[Transcript unavailable]\n\n${desc}`.slice(0, 5000);
  }
}


// ── SLEEP HELPER ─────────────────────────────────────────────────────────────
// A utility function that pauses execution for a given number of milliseconds.
// JavaScript doesn't have a built-in "wait" — this creates one using a Promise.
//
// Usage: await sleep(500) — pauses for half a second.
// "await" only works inside async functions, which is why extractYouTubeTranscript
// is declared as "async function".
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
  // setTimeout schedules resolve() to run after `ms` milliseconds.
  // The Promise wraps it so we can use "await" to wait for it.
}
