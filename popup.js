// ═══════════════════════════════════════════════════════════════════════════
// popup.js — THE BRAIN OF THE EXTENSION
//
// This file controls everything the user sees and does in the popup window.
// When you click the extension icon, popup.html is shown — and this file
// is what makes it actually work.
//
// WHAT THIS FILE DOES, IN ORDER:
//   1. Grabs references to every visible element in popup.html
//   2. Checks whether Chrome's on-device AI is available on this computer
//   3. Shows the current page's title and type (article vs YouTube)
//   4. When "Summarize" is clicked:
//        a. Extracts text from the current page
//        b. Loads Chrome's built-in Gemini Nano AI model
//        c. Runs the summarization entirely on-device
//        d. Displays the result in the popup
//   5. Handles errors gracefully and shows helpful messages
// ═══════════════════════════════════════════════════════════════════════════


// ── SHORTHAND HELPER ─────────────────────────────────────────────────────────
// Instead of typing document.getElementById('something') every time,
// we create a shortcut called $ that does the same thing in fewer characters.
// Example: $('btnSummarize') is the same as document.getElementById('btnSummarize')
const $ = id => document.getElementById(id);


// ── ELEMENT REFERENCES ───────────────────────────────────────────────────────
// Grab a reference to every interactive or dynamic element in popup.html.
// We store them all in one object called "els" (short for elements) so we
// can easily access any piece of the UI anywhere in this file.
//
// Each key corresponds to an id="" attribute in popup.html.
const els = {
  pageInfo:      $('pageInfo'),      // the strip showing page title + type badge
  pageTitle:     $('pageTitle'),     // the text showing the current page's title
  pageTypeBadge: $('pageTypeBadge'), // the "ARTICLE" or "YOUTUBE" colored badge
  unsupported:   $('unsupported'),   // the warning panel shown if AI isn't available
  controls:      $('controls'),      // the section with dropdowns + summarize button
  btnSummarize:  $('btnSummarize'),  // the green "Summarize this page" button
  loading:       $('loading'),       // the spinning loading indicator
  loadingText:   $('loadingText'),   // the text shown during loading (e.g. "EXTRACTING CONTENT")
  output:        $('output'),        // the section that holds the finished summary
  outputLabel:   $('outputLabel'),   // the label above the summary (e.g. "KEY POINTS")
  summaryBox:    $('summaryBox'),    // the box containing the actual summary text
  errorBox:      $('errorBox'),      // the red error panel shown when something goes wrong
  errorText:     $('errorText'),     // the text inside the error panel
  btnCopy:       $('btnCopy'),       // the "copy" button next to the summary
  summaryType:   $('summaryType'),   // the Format dropdown (Key Points, TL;DR, etc.)
  summaryLength: $('summaryLength'), // the Length dropdown (Short, Medium, Long)
};


// ── STATE VARIABLE ───────────────────────────────────────────────────────────
// Stores the most recently generated summary text so the copy button can
// access it. Empty string means no summary has been generated yet.
let lastSummaryText = '';


// ── INITIALIZATION ───────────────────────────────────────────────────────────
// This is the first function that runs when the popup opens.
// It sets up the UI state before the user does anything.
async function init() {

  // ── Step 1: Check if Chrome's on-device AI is supported ──
  // Not all computers or Chrome versions support Gemini Nano.
  // We check this first so we can show an error immediately if needed.
  const supported = await checkSupportAsync();

  // ── Step 2: Get info about the current browser tab ──
  // chrome.tabs.query asks Chrome: "which tab is the user looking at right now?"
  // The { active: true, currentWindow: true } filter means: the focused tab
  // in the currently focused window.
  // The [tab] syntax "destructures" the array — we only want the first result.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Show the page title in the UI if we got one.
  // The ?. is "optional chaining" — if tab is undefined, this won't crash.
  if (tab?.title) {
    els.pageTitle.textContent = tab.title;
  }

  // ── Step 3: Detect if this is a YouTube page ──
  // If so, update the badge from "ARTICLE" (the default) to "YOUTUBE"
  // and apply the red YouTube styling instead of the blue article styling.
  const isYouTube = tab?.url?.includes('youtube.com/watch') || tab?.url?.includes('youtu.be/');
  if (isYouTube) {
    els.pageTypeBadge.textContent = 'YOUTUBE';
    els.pageTypeBadge.className = 'page-type-badge youtube'; // switches to red styling
  }

  // ── Step 4: Handle unsupported browsers/computers ──
  if (!supported) {
    els.controls.style.display = 'none';          // hide the summarize controls
    els.unsupported.classList.add('visible');      // show the "not supported" warning
    return;                                        // stop here — nothing else to set up
  }

  // ── Step 5: Restore the user's last-used settings ──
  // chrome.storage.local is like localStorage but for extensions.
  // We saved the user's format and length preferences last time they used the extension.
  // Now we restore them so their settings persist between sessions.
  const saved = await chrome.storage.local.get(['summaryType', 'summaryLength']);
  if (saved.summaryType)   els.summaryType.value   = saved.summaryType;
  if (saved.summaryLength) els.summaryLength.value = saved.summaryLength;

  // ── Step 6: Wire up the button click handlers ──
  // "addEventListener" means: when this element is clicked, call this function.
  els.btnSummarize.addEventListener('click', runSummary); // main action
  els.btnCopy.addEventListener('click', copyText);        // copy to clipboard

  // ── Step 7: Auto-save settings whenever the user changes a dropdown ──
  // 'change' fires when the selected option changes.
  // We save to chrome.storage.local so it persists next time the popup opens.
  els.summaryType.addEventListener('change', () =>
    chrome.storage.local.set({ summaryType: els.summaryType.value }));
  els.summaryLength.addEventListener('change', () =>
    chrome.storage.local.set({ summaryLength: els.summaryLength.value }));
}


// ── SUPPORT CHECK ────────────────────────────────────────────────────────────
// Checks whether the current browser and computer support Chrome's built-in
// Summarizer API. Returns true if supported, false if not.
async function checkSupportAsync() {

  // First, check if the Summarizer object even exists in this browser.
  // Older Chrome versions and non-Chrome browsers won't have it at all.
  // 'Summarizer' in self checks if it's a property of the global scope.
  if (!('Summarizer' in self)) return false;

  try {
    // Ask Chrome what the current availability status is.
    // Possible values:
    //   'available'    — model is downloaded and ready to use
    //   'downloadable' — model can be downloaded (will happen on first use)
    //   'unavailable'  — this computer doesn't meet the requirements
    const avail = await Summarizer.availability();

    // Return true for anything except 'unavailable'
    return avail !== 'unavailable';
  } catch {
    // If the check itself throws an error, assume it's not supported.
    return false;
  }
}


// ── MAIN SUMMARY WORKFLOW ────────────────────────────────────────────────────
// This is the core function that runs when the user clicks "Summarize this page".
// It orchestrates the full pipeline: extract → load model → summarize → display.
async function runSummary() {

  // Reset the UI to a clean loading state before starting.
  setLoading(true);  // show the spinner, dim the controls
  hideError();       // hide any previous error message
  hideOutput();      // hide any previous summary

  try {

    // ── STEP 1: Extract text from the current page ──────────────────────────
    setLoadingText('EXTRACTING CONTENT');

    // Find out which tab the user is on.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let extracted; // will hold the page content once extracted

    try {
      // chrome.scripting.executeScript injects a function into the live webpage
      // and runs it there. This is how we read the page's content from the
      // extension popup — we can't directly access the page's DOM from here.
      //
      // We're injecting extractContentFromPage (defined below) into the page.
      // It runs inside the page's context and returns the extracted text.
      [extracted] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },        // which tab to inject into
        func: extractContentFromPage,     // the function to run inside the page
      });
      extracted = extracted?.result; // the function's return value

    } catch (e) {
      // Some pages block script injection (e.g. Chrome's own settings pages,
      // the Chrome Web Store, PDF files). Show a helpful error if this happens.
      throw new Error("Couldn't access this page. Try a regular article or YouTube video.");
    }

    // If we got less than 100 characters, the page probably doesn't have
    // meaningful text content (maybe it's mostly images or a login page).
    if (!extracted?.content || extracted.content.trim().length < 100) {
      throw new Error("Not enough readable text found on this page. Try navigating to a full article.");
    }

    // ── STEP 2: Check the AI model status ───────────────────────────────────
    setLoadingText('LOADING ON-DEVICE MODEL');

    // Ask Chrome again what the model's current status is.
    // This may have changed since our initial check (e.g. the model finished downloading).
    const availability = await Summarizer.availability();

    // Read the user's chosen format and length from the dropdowns.
    const type   = els.summaryType.value;   // e.g. 'key-points', 'tldr'
    const length = els.summaryLength.value; // e.g. 'short', 'medium', 'long'

    // Build the configuration object for the summarizer.
    // This tells the AI how to format its output.
    const options = {
      type,    // what kind of summary: key-points, tldr, teaser, or headline
      length,  // how long the summary should be
      format: 'plain-text', // we'll handle formatting ourselves in displaySummary()

      // Extra context helps the AI understand what it's reading.
      // A YouTube transcript and a news article need slightly different treatment.
      sharedContext: extracted.type === 'youtube'
        ? 'This is a YouTube video transcript.'
        : 'This is a web article or webpage.',
    };

    // ── STEP 3: Create the AI summarizer ────────────────────────────────────
    let summarizer;

    if (availability === 'downloadable') {
      // The model hasn't been downloaded yet (first time using Chrome's AI).
      // We create the summarizer with a download progress monitor so we can
      // show the user how far along the download is.
      setLoadingText('DOWNLOADING MODEL (ONCE)');

      summarizer = await Summarizer.create({
        ...options, // spread the options we built above into this object

        // monitor() receives a progress tracker object "m".
        // We add a listener for 'downloadprogress' events.
        monitor(m) {
          m.addEventListener('downloadprogress', e => {
            // e.loaded is a number between 0 and 1 representing download progress.
            // Multiply by 100 and round to get a percentage.
            const pct = Math.round((e.loaded || 0) * 100);
            setLoadingText(`DOWNLOADING MODEL ${pct}%`);
          });
        }
      });

    } else {
      // Model is already downloaded and ready — create it without a monitor.
      summarizer = await Summarizer.create(options);
    }

    // ── STEP 4: Run the summarization ────────────────────────────────────────
    setLoadingText('SUMMARIZING ON-DEVICE');

    // This is the key call — it sends the extracted text to Gemini Nano
    // running locally on the user's computer. No internet request is made.
    const summary = await summarizer.summarize(extracted.content, {
      context: `Title: ${extracted.title}` // helps the AI know the article's topic
    });

    // Free up memory now that we're done with the AI model.
    // Good practice — especially important on lower-powered machines.
    summarizer.destroy();

    // ── STEP 5: Show the result ───────────────────────────────────────────────
    displaySummary(summary, type); // render the summary text in the UI
    setLoading(false);             // hide the spinner, restore the controls

  } catch (err) {
    // If anything went wrong in any of the steps above, land here.
    // Hide the spinner and show a red error message.
    setLoading(false);
    showError(err.message || 'An unexpected error occurred.');
  }
}


// ── PAGE CONTENT EXTRACTOR (runs inside the webpage) ─────────────────────────
// IMPORTANT: This function is injected into the actual webpage by
// chrome.scripting.executeScript above. It does NOT run in the extension popup.
// It runs in the context of the page the user is viewing.
//
// Because of this, it has access to the page's document (its HTML) but
// cannot use any variables or functions defined elsewhere in this file.
// It must be completely self-contained.
function extractContentFromPage() {

  const url = window.location.href;

  // Check if this is a YouTube video page.
  const isYouTube = url.includes('youtube.com/watch') || url.includes('youtu.be/');

  if (isYouTube) {

    // First, check if the YouTube transcript panel is already open.
    // If the user had opened it manually before clicking Summarize,
    // the transcript segments will already be in the DOM.
    const segments = document.querySelectorAll(
      'ytd-transcript-segment-renderer .segment-text, .ytd-transcript-segment-renderer'
    );

    if (segments.length > 0) {
      // Transcript is open — collect all the text segments and join them.
      const text = Array.from(segments)
        .map(s => s.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      return {
        type: 'youtube',
        title: document.title.replace(' - YouTube', ''), // strip YouTube's title suffix
        content: text.slice(0, 15000),
        url
      };
    }

    // Transcript wasn't open — fall back to the video's description text.
    // Less ideal but still useful for shorter or well-described videos.
    const desc = document.querySelector(
      '#description-inline-expander, #description, ytd-text-inline-expander'
    )?.textContent || '';

    return {
      type: 'youtube',
      title: document.title.replace(' - YouTube', ''),
      content: desc.slice(0, 8000), // shorter limit for descriptions
      url
    };
  }

  // ── ARTICLE EXTRACTION ───────────────────────────────────────────────────
  // For non-YouTube pages, find the main content area of the article.

  // Try these selectors in order, stopping at the first that has meaningful content.
  // We also check that the found element has more than 200 characters of text —
  // a match with very little text is probably a navigation element, not the article.
  const selectors = [
    'article', 'main', '[role="main"]',
    '.post-content', '.article-body', '.entry-content',
    '#content', '#main-content'
  ];

  let el = null;
  for (const sel of selectors) {
    const found = document.querySelector(sel);
    if (found && found.textContent.trim().length > 200) {
      el = found;
      break;
    }
  }

  // If no content area was found, fall back to the entire page body.
  if (!el) el = document.body;

  // Clone the element to avoid modifying the actual page.
  const clone = el.cloneNode(true);

  // Remove all the "noise" elements from the copy.
  // The try/catch wraps each removal in case a selector causes an error —
  // we don't want one bad selector to stop the whole extraction.
  [
    'nav', 'header', 'footer', 'aside',
    'script', 'style', 'noscript',
    '.ad', '.ads', '.sidebar', '.comments',
    '.share', '.social', '.cookie',
    '.popup', '.modal', '.newsletter',
    '[aria-hidden="true"]'
  ].forEach(sel => {
    try {
      clone.querySelectorAll(sel).forEach(n => n.remove());
    } catch {}
  });

  // Extract and clean the remaining text.
  const text = (clone.innerText || clone.textContent || '')
    .replace(/\s+/g, ' ')  // collapse all whitespace into single spaces
    .trim()                 // remove leading/trailing whitespace
    .slice(0, 15000);       // cap at 15,000 characters for the AI

  return { type: 'article', title: document.title, content: text, url };
}


// ── SUMMARY DISPLAY ──────────────────────────────────────────────────────────
// Takes the raw text from the AI and renders it nicely in the popup.
// The display logic differs based on the summary type the user chose.
function displaySummary(text, type) {

  // Save the text globally so the copy button can access it later.
  lastSummaryText = text;

  // Map the internal type values to human-readable labels for the UI.
  const label = {
    'key-points': 'KEY POINTS',
    'tldr':       'TL;DR',
    'teaser':     'TEASER',
    'headline':   'HEADLINE'
  }[type] || 'SUMMARY'; // default to 'SUMMARY' if type is unrecognized

  // Update the label above the summary box.
  els.outputLabel.textContent = label;

  if (type === 'key-points') {
    // Key points are best shown as a bulleted list.
    // The AI returns them as separate lines, often prefixed with - or •.
    // We split on newlines, strip the bullet characters, and filter out short/empty lines.
    const lines = text
      .split('\n')                            // separate into individual lines
      .map(l => l.replace(/^[-•*·]\s*/, '').trim()) // strip leading bullet characters
      .filter(l => l.length > 5);            // remove very short/empty lines

    if (lines.length > 1) {
      // Build an HTML unordered list (<ul>) with one <li> per point.
      const ul = document.createElement('ul');
      lines.forEach(line => {
        const li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li); // add the item to the list
      });
      els.summaryBox.innerHTML = ''; // clear any previous summary
      els.summaryBox.appendChild(ul);
    } else {
      // If the AI only returned one line, just show it as a paragraph.
      renderParagraphs(text);
    }

  } else {
    // For TL;DR, Teaser, and Headline — just render as plain paragraphs.
    renderParagraphs(text);
  }

  // Make the output section visible (it's hidden by default with display:none).
  els.output.classList.add('visible');
}


// ── PARAGRAPH RENDERER ───────────────────────────────────────────────────────
// Splits text into paragraphs and creates a <p> element for each one.
// This is cleaner than setting innerHTML directly (safer against injection).
function renderParagraphs(text) {
  els.summaryBox.innerHTML = ''; // clear the box first

  // Split the text on newlines, skip blank lines, create a <p> for each.
  text.split('\n')
    .filter(l => l.trim()) // skip empty lines
    .forEach(line => {
      const p = document.createElement('p');   // create a paragraph element
      p.textContent = line.trim();              // set its text content safely
      els.summaryBox.appendChild(p);           // add it to the summary box
    });
}


// ── COPY TO CLIPBOARD ────────────────────────────────────────────────────────
// Copies the current summary text to the clipboard when the user clicks "copy".
async function copyText() {

  // Don't do anything if there's no summary to copy yet.
  if (!lastSummaryText) return;

  // navigator.clipboard.writeText is the modern way to copy text in browsers.
  await navigator.clipboard.writeText(lastSummaryText);

  // Give the user visual confirmation that it worked.
  els.btnCopy.textContent = 'copied!';
  els.btnCopy.classList.add('copied'); // applies the green highlight style

  // After 2 seconds, revert the button back to its normal "copy" state.
  // setTimeout schedules a function to run after a delay (2000ms = 2 seconds).
  setTimeout(() => {
    els.btnCopy.textContent = 'copy';
    els.btnCopy.classList.remove('copied');
  }, 2000);
}


// ── UI STATE HELPERS ─────────────────────────────────────────────────────────
// These small functions toggle different UI states.
// Keeping them as named functions makes the main code easier to read.

// Shows or hides the loading spinner.
// If "on" is true: show spinner and disable controls.
// If "on" is false: hide spinner and re-enable controls.
function setLoading(on) {
  els.loading.classList.toggle('visible', on); // add 'visible' if on=true, remove if false

  // While loading, dim the controls and prevent clicking them.
  els.controls.style.opacity       = on ? '0.4' : '1';    // 40% opacity when loading
  els.controls.style.pointerEvents = on ? 'none' : 'auto'; // disable clicks when loading
}

// Updates the status text shown below the spinner during loading.
// Called at each stage: "EXTRACTING CONTENT" → "LOADING MODEL" → "SUMMARIZING"
function setLoadingText(t) {
  els.loadingText.textContent = t;
}

// Shows the red error box with a specific message.
function showError(msg) {
  els.errorText.textContent = msg;
  els.errorBox.classList.add('visible');
}

// Hides the error box (called before starting a new summary attempt).
function hideError() {
  els.errorBox.classList.remove('visible');
}

// Hides the summary output area (called before starting a new summary attempt).
function hideOutput() {
  els.output.classList.remove('visible');
}


// ── KICK EVERYTHING OFF ──────────────────────────────────────────────────────
// Call init() immediately when this file is loaded.
// This runs as soon as the popup opens.
init();
