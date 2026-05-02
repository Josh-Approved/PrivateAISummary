// popup.js

const $ = id => document.getElementById(id);

const els = {
  unsupported:     $('unsupported'),
  controls:        $('controls'),
  btnSummarize:    $('btnSummarize'),
  loading:         $('loading'),
  loadingText:     $('loadingText'),
  output:          $('output'),
  outputLabel:     $('outputLabel'),
  summaryBox:      $('summaryBox'),
  errorBox:        $('errorBox'),
  errorText:       $('errorText'),
  btnCopy:         $('btnCopy'),
  btnExpand:       $('btnExpand'),
  summaryType:     $('summaryType'),
  summaryLanguage: $('summaryLanguage'),
};

let lastSummaryText = '';
let lastMeta = null;
let lastType = '';

// INITIALIZATION
async function init() {
  const supported = await checkSupportAsync();

  document.getElementById('flagLink').addEventListener('click', function(e) {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://flags/#optimization-guide-on-device-model' });
  });

  const version = chrome.runtime.getManifest().version;
  const chromeMatch = navigator.userAgent.match(/Chrome\/([\d.]+)/);
  const chromeVersion = chromeMatch ? chromeMatch[1] : 'unknown';
  const feedbackSubject = encodeURIComponent('Private AI Summary Feedback');
  const feedbackBody = encodeURIComponent(
    'Hi,\n\n[Replace this with your feedback, or fill in the bug report below]\n\n' +
    '---\nBUG REPORT (delete if not applicable)\n' +
    'Extension: Private AI Summary v' + version + '\n' +
    'Chrome: ' + chromeVersion + '\n'
  );
  document.getElementById('feedbackLink').href =
    'mailto:jtysonwilliams@yahoo.com?subject=' + feedbackSubject + '&body=' + feedbackBody;

  const overlay = document.getElementById('aboutOverlay');
  document.getElementById('btnLearn').addEventListener('click', function() {
    overlay.classList.add('visible');
  });
  document.getElementById('btnCloseAbout').addEventListener('click', function() {
    overlay.classList.remove('visible');
  });

  if (!supported) {
    els.controls.style.display = 'none';
    els.unsupported.classList.add('visible');
    return;
  }

  const saved = await chrome.storage.local.get(['summaryType', 'summaryLanguage']);
  if (saved.summaryType)     els.summaryType.value     = saved.summaryType;
  if (saved.summaryLanguage) els.summaryLanguage.value = saved.summaryLanguage;

  applyFormatUI(saved.summaryType || 'key-points');

  els.btnSummarize.addEventListener('click', runSummary);
  els.btnCopy.addEventListener('click', copyText);
  els.btnExpand.addEventListener('click', function() {
    if (lastSummaryText) openExpandTab(lastSummaryText, lastType, lastMeta);
  });

  els.summaryType.addEventListener('change', function() {
    const val = els.summaryType.value;
    chrome.storage.local.set({ summaryType: val });
    applyFormatUI(val);
  });

  els.summaryLanguage.addEventListener('change', function() {
    chrome.storage.local.set({ summaryLanguage: els.summaryLanguage.value });
  });
}

function applyFormatUI(format) {
  const span = els.btnSummarize.querySelector('span');
  if (format === 'recipe') {
    span.textContent = 'Extract recipe';
  } else if (format === 'news-critique') {
    span.textContent = 'Critique this article';
  } else if (format === 'youtube-summary') {
    span.textContent = 'Summarize this video';
  } else {
    span.textContent = 'Summarize this page';
  }
}

// SUPPORT CHECK
async function checkSupportAsync() {
  if (!('Summarizer' in self)) return false;
  try {
    const avail = await Summarizer.availability({ outputLanguage: 'en' });
    return avail !== 'unavailable';
  } catch (e) {
    return false;
  }
}

// MAIN WORKFLOW
async function runSummary() {
  setLoading(true);
  hideError();
  hideSetup();
  hideOutput();

  const type = els.summaryType.value;

  // NEWS CRITIQUE MODE
  if (type === 'news-critique') {
    try {
      setLoadingText('Extracting content');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      let extracted;
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractContentFromPage,
        });
        extracted = res[0] && res[0].result;
      } catch (e) {
        throw new Error("Couldn't access this page.");
      }

      if (!extracted || !extracted.content || extracted.content.trim().length < 100) {
        throw new Error("Not enough readable text found on this page.");
      }
      lastMeta = extracted;

      var lm = null;
      try {
        if (self.ai && self.ai.languageModel) lm = self.ai.languageModel;
        else if (self.LanguageModel) lm = self.LanguageModel;
      } catch (e) {}

      if (!lm) {
        setLoading(false);
        showSetup(
          'To use this feature, you must turn on an exploratory Google Chrome feature. Click below, then restart Chrome.',
          'Enable Prompt API for Gemini Nano',
          'chrome://flags'
        );
        return;
      }

      setLoadingText('Loading on-device model');
      var availability;
      try {
        availability = await lm.availability();
      } catch (e) {
        availability = 'unavailable';
      }

      if (availability === 'unavailable' || availability === 'no') {
        setLoading(false);
        showSetup(
          'The on-device AI model isn\'t ready yet. This sometimes takes a few minutes after enabling the Chrome feature. Try closing and reopening Chrome, then try again.',
          'Open Chrome flags',
          'chrome://flags'
        );
        return;
      }

      var session;
      if (availability === 'downloadable') {
        setLoadingText('Downloading model (once)');
        session = await lm.create({
          monitor: function(m) {
            m.addEventListener('downloadprogress', function(e) {
              var pct = Math.round((e.loaded || 0) * 100);
              setLoadingText('Downloading model ' + pct + '%');
            });
          }
        });
      } else {
        session = await lm.create();
      }

      setLoadingText('Analyzing article');

      const prompt = 'You are a media literacy analyst. Analyze the article below and respond with ONLY these five labeled sections. Do not add any text before the first section or after the last section.\n\n'
        + 'KEY POINTS:\nList 3-5 bullet points of the main facts and claims. Include specific names, numbers, and direct claims from the article. Do not editorialize. Start each bullet with *.\n\n'
        + "WHAT'S MISSING:\nList 2-4 specific gaps — name a missing statistic, an absent source or perspective, an unaddressed counterargument, or omitted context that would change how a reader understands this story. Every bullet must be specific to this article. Do not write vague observations like \"more context would be helpful.\" Start each bullet with *.\n\n"
        + 'WHO BENEFITS:\nName 2-4 specific people, organizations, or groups who benefit from this story being framed this way. For each, write one sentence explaining what they gain. Do not use vague categories like "politicians" or "the media."\n\n'
        + 'QUESTIONS TO ASK:\nWrite 3-4 questions a skeptical reader should investigate. Each question must be specific to a claim or gap in this article — not generic media literacy questions. Start each bullet with *.\n\n'
        + 'Article title: ' + extracted.title + '\n\n'
        + extracted.content;

      let streamedText = '';
      let prevChunk = '';
      let streamingStarted = false;
      let rafId = null;
      const stream = session.promptStreaming(prompt);

      for await (const chunk of stream) {
        // Handle both cumulative and incremental chunk styles across Chrome versions
        const delta = chunk.startsWith(prevChunk) ? chunk.slice(prevChunk.length) : chunk;
        streamedText += delta;
        prevChunk = chunk;

        if (!streamingStarted) {
          streamingStarted = true;
          setLoading(false);
          els.outputLabel.textContent = 'News critique';
          els.output.classList.add('visible');
        }

        if (!rafId) {
          rafId = requestAnimationFrame(function() {
            rafId = null;
            renderNewsCritiqueStreaming(streamedText);
          });
        }
      }

      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      session.destroy();
      displayNewsCritique(streamedText);
    } catch (err) {
      setLoading(false);
      showError(err.message || 'Could not analyze article.');
    }
    return;
  }

  // RECIPE MODE
  if (type === 'recipe') {
    try {
      setLoadingText('Finding recipe');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      let result;
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractRecipeFromPage,
        });
        result = res[0] && res[0].result;
      } catch (e) {
        throw new Error("Couldn't access this page.");
      }

      if (!result || (!result.ingredients.length && !result.instructions.length)) {
        throw new Error("No recipe found on this page. Make sure you're on a recipe article.");
      }

      openRecipeTab(result);
      setLoading(false);
    } catch (err) {
      setLoading(false);
      showError(err.message || 'Could not extract recipe.');
    }
    return;
  }

  // YOUTUBE SUMMARY MODE
  if (type === 'youtube-summary') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.url || !tab.url.includes('youtube.com/watch')) {
        throw new Error("Navigate to a YouTube video page first, then try again.");
      }

      setLoadingText('Extracting transcript');
      let ytResult;
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractYouTubeTranscriptFromPage,
          world: 'MAIN',
        });
        ytResult = res[0] && res[0].result;
      } catch (e) {
        throw new Error("Couldn't access this page.");
      }

      if (!ytResult || !ytResult.content || ytResult.content.trim().length < 100) {
        throw new Error("No transcript found. This video may not have captions available. Look for the CC icon on the video player to check.");
      }
      lastMeta = ytResult;

      setLoadingText('Loading on-device model');
      const ytAvailability = await Summarizer.availability();
      const ytLang = els.summaryLanguage.value;

      const ytOptions = {
        type: 'key-points',
        length: 'medium',
        format: 'plain-text',
        outputLanguage: ytLang,
        sharedContext: 'This is a transcript from a spoken YouTube video. The text may lack punctuation or sentence structure.',
      };

      let ytSummarizer;
      if (ytAvailability === 'downloadable') {
        setLoadingText('Downloading model (once)');
        ytSummarizer = await Summarizer.create(Object.assign({}, ytOptions, {
          monitor: function(m) {
            m.addEventListener('downloadprogress', function(e) {
              const pct = Math.round((e.loaded || 0) * 100);
              setLoadingText('Downloading model ' + pct + '%');
            });
          }
        }));
      } else {
        ytSummarizer = await Summarizer.create(ytOptions);
      }

      setLoadingText('Summarizing on-device');

      let ytStreamedText = '';
      let ytPrevChunk = '';
      let ytStreamingStarted = false;
      let ytRafId = null;
      const ytStream = ytSummarizer.summarizeStreaming(ytResult.content, {
        context: 'Title: ' + ytResult.title
      });

      for await (const chunk of ytStream) {
        const delta = chunk.startsWith(ytPrevChunk) ? chunk.slice(ytPrevChunk.length) : chunk;
        ytStreamedText += delta;
        ytPrevChunk = chunk;

        if (!ytStreamingStarted) {
          ytStreamingStarted = true;
          setLoading(false);
          els.outputLabel.textContent = 'Video summary';
          els.output.classList.add('visible');
        }

        if (!ytRafId) {
          ytRafId = requestAnimationFrame(function() {
            ytRafId = null;
            renderSummaryStreaming(ytStreamedText, 'youtube-summary');
          });
        }
      }

      if (ytRafId) { cancelAnimationFrame(ytRafId); ytRafId = null; }
      ytSummarizer.destroy();
      displaySummary(ytStreamedText, 'youtube-summary');
      if (lastMeta && lastMeta.topComments && lastMeta.topComments.length) {
        appendYouTubeComments(lastMeta.topComments);
      }
      setLoading(false);

    } catch (err) {
      setLoading(false);
      showError(err.message || 'Could not summarize video.');
    }
    return;
  }

  // SUMMARIZE MODE
  try {
    setLoadingText('Extracting content');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let extracted;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractContentFromPage,
      });
      extracted = res[0] && res[0].result;
    } catch (e) {
      throw new Error("Couldn't access this page.");
    }

    if (!extracted || !extracted.content || extracted.content.trim().length < 100) {
      throw new Error("Not enough readable text found on this page.");
    }
    lastMeta = extracted;

    setLoadingText('Loading on-device model');
    const availability = await Summarizer.availability();
    const lang = els.summaryLanguage.value;

    const options = {
      type: type,
      length: 'medium',
      format: 'plain-text',
      outputLanguage: lang,
      sharedContext: 'This is a webpage.',
    };

    let summarizer;
    if (availability === 'downloadable') {
      setLoadingText('Downloading model (once)');
      summarizer = await Summarizer.create(Object.assign({}, options, {
        monitor: function(m) {
          m.addEventListener('downloadprogress', function(e) {
            const pct = Math.round((e.loaded || 0) * 100);
            setLoadingText('Downloading model ' + pct + '%');
          });
        }
      }));
    } else {
      summarizer = await Summarizer.create(options);
    }

    setLoadingText('Summarizing on-device');

    let streamedText = '';
    let prevChunk = '';
    let streamingStarted = false;
    let rafId = null;
    const stream = summarizer.summarizeStreaming(extracted.content, {
      context: 'Title: ' + extracted.title
    });

    for await (const chunk of stream) {
      const delta = chunk.startsWith(prevChunk) ? chunk.slice(prevChunk.length) : chunk;
      streamedText += delta;
      prevChunk = chunk;

      if (!streamingStarted) {
        streamingStarted = true;
        setLoading(false);
        els.outputLabel.textContent = options.type === 'key-points' ? 'Key points' : 'Summary';
        els.output.classList.add('visible');
      }

      if (!rafId) {
        rafId = requestAnimationFrame(function() {
          rafId = null;
          renderSummaryStreaming(streamedText, type);
        });
      }
    }

    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    summarizer.destroy();
    displaySummary(streamedText, type);
    setLoading(false);

  } catch (err) {
    setLoading(false);
    showError(err.message || 'An unexpected error occurred.');
  }
}

// RECIPE EXTRACTOR (injected into the page)
function extractRecipeFromPage() {

  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (let si = 0; si < scripts.length; si++) {
    try {
      let data = JSON.parse(scripts[si].textContent);

      function isRecipeType(t) {
        return t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));
      }

      if (Array.isArray(data)) {
        data = data.find(function(d) { return isRecipeType(d['@type']); }) || data[0];
      }
      if (data && data['@graph']) {
        data = data['@graph'].find(function(d) { return isRecipeType(d['@type']); }) || data;
      }

      if (!isRecipeType(data && data['@type'])) continue;

      const title = data.name || document.title;

      const ingredients = (data.recipeIngredient || [])
        .map(function(i) { return i.trim(); })
        .filter(Boolean);

      const instructions = (data.recipeInstructions || []).map(function(step) {
        if (typeof step === 'string') return step.replace(/<[^>]+>/g, '').trim();
        if (step['@type'] === 'HowToSection' && step.itemListElement) {
          return step.itemListElement.map(function(s) { return (s.text || s.name || '').trim(); }).join(' ');
        }
        return (step.text || step.name || '').replace(/<[^>]+>/g, '').trim();
      }).filter(Boolean);

      function parseDuration(val) {
        if (!val) return null;
        if (typeof val !== 'string') return null;
        if (val.charAt(0) !== 'P') return val.trim() || null;
        const hMatch = val.match(/(\d+)H/);
        const mMatch = val.match(/(\d+)M/);
        const parts = [];
        if (hMatch) parts.push(hMatch[1] + ' hr');
        if (mMatch) parts.push(mMatch[1] + ' min');
        return parts.join(' ') || null;
      }

      const prepTime  = parseDuration(data.prepTime);
      const cookTime  = parseDuration(data.cookTime);
      const totalTime = parseDuration(data.totalTime);
      const servings  = data.recipeYield
        ? (Array.isArray(data.recipeYield) ? data.recipeYield[0] : data.recipeYield).toString().trim()
        : null;

      const authorRaw = data.author;
      let author = null;
      if (authorRaw) {
        if (typeof authorRaw === 'string') {
          author = authorRaw;
        } else if (Array.isArray(authorRaw)) {
          author = authorRaw.map(function(a) { return a.name || a; }).filter(Boolean).join(', ');
        } else {
          author = authorRaw.name || null;
        }
      }

      const siteEl = document.querySelector('meta[property="og:site_name"]') ||
                     document.querySelector('meta[name="application-name"]');
      const siteName = siteEl ? siteEl.content : null;

      if (ingredients.length || instructions.length) {
        return { title: title, ingredients: ingredients, instructions: instructions,
                 prepTime: prepTime, cookTime: cookTime, totalTime: totalTime,
                 servings: servings, author: author, siteName: siteName, url: window.location.href };
      }

    } catch (e) { continue; }
  }

  // DOM fallback
  const title = document.title;
  let ingredients = [];
  let instructions = [];

  const ingredientSelectors = ['[class*="ingredient" i]', '[itemprop="recipeIngredient"]', '[data-ingredient]'];
  for (let i = 0; i < ingredientSelectors.length; i++) {
    const found = document.querySelectorAll(ingredientSelectors[i]);
    if (found.length > 2) {
      const items = Array.from(found)
        .map(function(el) { return el.textContent.trim(); })
        .filter(function(t) { return t.length > 2 && t.length < 300; });
      if (items.length) { ingredients = items; break; }
    }
  }

  const instructionSelectors = [
    '[class*="instruction" i]', '[class*="direction" i]',
    '[class*="step" i] p', '[itemprop="recipeInstructions"]', '[class*="method" i]',
  ];
  for (let i = 0; i < instructionSelectors.length; i++) {
    const found = document.querySelectorAll(instructionSelectors[i]);
    if (found.length > 1) {
      const items = Array.from(found)
        .map(function(el) { return el.textContent.trim(); })
        .filter(function(t) { return t.length > 15; });
      if (items.length) { instructions = items; break; }
    }
  }

  const siteEl = document.querySelector('meta[property="og:site_name"]') ||
                 document.querySelector('meta[name="application-name"]');
  const siteName = siteEl ? siteEl.content : null;

  return { title: title, ingredients: ingredients, instructions: instructions,
           prepTime: null, cookTime: null, totalTime: null, servings: null,
           author: null, siteName: siteName, url: window.location.href };
}

// EXPAND TAB
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function openExpandTab(text, type, meta) {
  function fmtDate(iso) {
    if (!iso) return null;
    try { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
    catch (e) { return null; }
  }

  var title = (meta && meta.title) || 'Summary';
  var url   = (meta && meta.url)   || '';
  var isYT  = meta && meta.type === 'youtube';
  var metaParts, dateStr;

  if (isYT) {
    var ytPub = fmtDate(meta.publishedDate) || meta.publishedDate || '';
    dateStr   = ytPub ? 'Published ' + ytPub : '';
    metaParts = [meta.channelName || '', meta.viewCount || '', dateStr].filter(Boolean);
  } else {
    var site    = (meta && meta.siteName) || '';
    var authors = (meta && meta.authors && meta.authors.length) ? 'By ' + meta.authors.join(', ') : '';
    var pubDate = fmtDate(meta && meta.publishedTime);
    var modDate = fmtDate(meta && meta.modifiedTime);
    dateStr = pubDate
      ? 'Published ' + pubDate + (modDate && modDate !== pubDate ? ' · Updated ' + modDate : '')
      : (modDate ? 'Updated ' + modDate : '');
    metaParts = [site, authors, dateStr].filter(Boolean);
  }

  var contentHtml = '';

  if (type === 'news-critique') {
    var sectionDefs = [
      { key: 'KEY POINTS',       label: 'Key points' },
      { key: "WHAT'S MISSING",   label: "What's missing" },
      { key: 'WHO BENEFITS',     label: 'Who benefits' },
      { key: 'QUESTIONS TO ASK', label: 'Questions to ask' },
    ];
    contentHtml += '<p class="disclaimer">AI-generated analysis using a local model. Verify all facts independently.</p>';
    for (var i = 0; i < sectionDefs.length; i++) {
      var key     = sectionDefs[i].key;
      var label   = sectionDefs[i].label;
      var nextKey = sectionDefs[i + 1] ? sectionDefs[i + 1].key : null;
      var startIdx = text.toUpperCase().indexOf(key);
      if (startIdx === -1) continue;
      var afterHeader = text.slice(startIdx + key.length).replace(/^[:\s]+/, '');
      var sContent;
      if (nextKey) {
        var endIdx = afterHeader.toUpperCase().indexOf(nextKey);
        sContent = endIdx === -1 ? afterHeader.trim() : afterHeader.slice(0, endIdx).trim();
      } else {
        sContent = afterHeader.trim();
      }
      if (!sContent) continue;
      contentHtml += '<h2>' + escapeHtml(label) + '</h2>';
      var lines = sContent.split('\n').map(function(l) {
        return l.replace(/^[-*•\d.]+\s*/, '').trim();
      }).filter(function(l) { return l.length > 3; });
      if (lines.length > 1) {
        contentHtml += '<ul>' + lines.map(function(l) { return '<li>' + escapeHtml(l) + '</li>'; }).join('') + '</ul>';
      } else {
        contentHtml += '<p>' + escapeHtml(sContent.trim()) + '</p>';
      }
    }
  } else {
    contentHtml += '<p class="disclaimer">AI-generated summary using a local model. Verify important details independently.</p>';
    var kpLabel = type === 'key-points' ? 'Key points' : type === 'youtube-summary' ? 'Video summary' : 'Summary';
    contentHtml += '<h2>' + kpLabel + '</h2>';
    var kpLines = text.split('\n').map(function(l) {
      return l.replace(/^[-*]\s*/, '').trim();
    }).filter(function(l) { return l.length > 5; });
    if (kpLines.length > 1) {
      contentHtml += '<ul>' + kpLines.map(function(l) { return '<li>' + escapeHtml(l) + '</li>'; }).join('') + '</ul>';
    } else {
      text.split('\n').filter(function(l) { return l.trim(); }).forEach(function(line) {
        contentHtml += '<p>' + escapeHtml(line.trim()) + '</p>';
      });
    }

    if (type === 'youtube-summary' && meta && meta.topComments && meta.topComments.length) {
      contentHtml += '<h2>Top comments</h2>';
      meta.topComments.forEach(function(comment) {
        contentHtml += '<div class="comment-item">';
        if (comment.author) contentHtml += '<p class="comment-author">' + escapeHtml(comment.author) + '</p>';
        contentHtml += '<p class="comment-text">&ldquo;' + escapeHtml(comment.text) + '&rdquo;</p>';
        contentHtml += '</div>';
      });
    }
  }

  var metaHtml = metaParts.length
    ? '<p class="meta">' + escapeHtml(metaParts.join('  ·  ')) + '</p>'
    : '';
  var urlHtml = url
    ? '<a class="source-url" href="' + escapeHtml(url) + '" target="_blank">View original</a>'
    : '';

  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
    + '<title>' + escapeHtml(title) + '</title>'
    + '<style>'
    + ':root {'
    + '  --ink: #0E0E0F; --paper: #FAFAF7; --pure-white: #FFFFFF;'
    + '  --fg-muted: #6B6B72; --fg-subtle: #9A9AA0;'
    + '  --hairline: #E5E5E2; --hairline-strong: #C8C8CC;'
    + '  --accent: #1F8A4C;'
    + '  --warning: #92400E; --warning-bg: #FEF3C7;'
    + '  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;'
    + '  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;'
    + '}'
    + '@media (prefers-color-scheme: dark) {'
    + '  :root { --ink: #F5F5F2; --paper: #0B0B0C; --pure-white: #131315; --fg-muted: #A0A0A6; --fg-subtle: #6B6B72; --hairline: #26262A; --hairline-strong: #3D3D42; --warning-bg: rgba(180,83,9,0.18); }'
    + '}'
    + '* { box-sizing: border-box; margin: 0; padding: 0; }'
    + 'body { font-family: var(--font-sans); color: var(--ink); background: var(--paper); line-height: 1.6; -webkit-font-smoothing: antialiased; }'
    + '.page { max-width: 680px; margin: 0 auto; padding: 48px 40px; }'
    + '.badge { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-muted); margin-bottom: 24px; }'
    + 'h1 { font-family: var(--font-sans); font-weight: 600; font-size: 32px; line-height: 1.25; letter-spacing: -0.02em; margin-bottom: 14px; color: var(--ink); }'
    + '.meta { font-family: var(--font-mono); font-size: 12px; color: var(--fg-muted); margin-bottom: 8px; line-height: 1.5; }'
    + '.source-url { display: inline-block; font-family: var(--font-mono); font-size: 12px; color: var(--ink); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--hairline-strong); margin-bottom: 28px; }'
    + '.source-url:hover { text-decoration-color: var(--ink); }'
    + '.divider { border: none; border-top: 1px solid var(--hairline); margin-bottom: 24px; }'
    + 'h2 { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.04em; font-weight: 400; text-transform: uppercase; color: var(--fg-muted); margin-top: 28px; margin-bottom: 12px; }'
    + 'h2:first-of-type { margin-top: 0; }'
    + 'ul { list-style: none; display: flex; flex-direction: column; gap: 10px; }'
    + 'li { display: flex; gap: 12px; font-size: 15px; line-height: 1.65; color: var(--ink); align-items: flex-start; }'
    + 'li::before { content: ""; flex-shrink: 0; width: 4px; height: 4px; background: var(--fg-muted); border-radius: 50%; margin-top: 11px; }'
    + 'p { font-size: 15px; line-height: 1.7; color: var(--ink); margin-bottom: 10px; }'
    + '.disclaimer { font-family: var(--font-sans); font-size: 13px; color: var(--warning); background: var(--warning-bg); border: 1px solid color-mix(in srgb, var(--warning) 25%, transparent); border-radius: 6px; padding: 9px 12px; margin-bottom: 20px; line-height: 1.5; }'
    + '.comment-item { background: var(--pure-white); border: 1px solid var(--hairline); border-radius: 10px; padding: 12px 14px; margin-bottom: 8px; }'
    + '.comment-author { font-family: var(--font-mono); font-size: 11px; color: var(--fg-muted); margin-bottom: 5px; }'
    + '.comment-text { font-size: 14px; line-height: 1.6; color: var(--ink); font-style: italic; }'
    + '.footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--hairline); font-family: var(--font-mono); font-size: 11px; color: var(--fg-subtle); letter-spacing: 0.04em; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }'
    + '.footer a { color: var(--fg-muted); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--hairline-strong); }'
    + '.footer a:hover { color: var(--ink); text-decoration-color: var(--ink); }'
    + '@media print { body { background: white; } .page { padding: 0; } .footer a { display: none; } }'
    + '</style></head><body>'
    + '<div class="page">'
    + '<div class="badge">Private AI Summary</div>'
    + '<h1>' + escapeHtml(title) + '</h1>'
    + metaHtml
    + urlHtml
    + '<hr class="divider">'
    + contentHtml
    + '<div class="footer"><span>Private AI Summary · Runs entirely on your device · No data sent</span><a href="https://buymeacoffee.com/jtysonwilliams" target="_blank">Buy me a coffee</a></div>'
    + '</div></body></html>';

  var blob = new Blob([html], { type: 'text/html' });
  var blobUrl = URL.createObjectURL(blob);
  var win = window.open(blobUrl, '_blank');
  if (win) win.addEventListener('load', function() { URL.revokeObjectURL(blobUrl); });
}

// RECIPE TAB
function openRecipeTab(recipe) {
  const meta = [];
  if (recipe.totalTime) meta.push('Total: ' + recipe.totalTime);
  if (recipe.prepTime)  meta.push('Prep: ' + recipe.prepTime);
  if (recipe.cookTime)  meta.push('Cook: ' + recipe.cookTime);
  if (recipe.servings)  meta.push('Serves ' + recipe.servings);

  const ingredientRows = recipe.ingredients.map(function(i) {
    return '<li><span class="cb"></span><span>' + i + '</span></li>';
  }).join('');

  const instructionRows = recipe.instructions.map(function(s) {
    return '<li>' + s + '</li>';
  }).join('');

  const sourceparts = [];
  if (recipe.siteName) sourceparts.push(recipe.siteName);
  if (recipe.author)   sourceparts.push('By ' + recipe.author);
  if (recipe.url)      sourceparts.push('<a href="' + recipe.url + '">' + recipe.url + '</a>');
  const sourceLine = sourceparts.length
    ? '<p class="source">' + sourceparts.join('&nbsp;&nbsp;&middot;&nbsp;&nbsp;') + '</p>'
    : '';

  const metaLine = meta.length
    ? '<p class="meta">' + meta.map(function(m) { return '<span>' + m + '</span>'; }).join('') + '</p>'
    : '';

  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
    + '<title>' + recipe.title + '</title>'
    + '<style>'
    + '@page { size: letter portrait; margin: 20mm; }'
    + ':root {'
    + '  --ink: #0E0E0F; --paper: #FAFAF7;'
    + '  --fg-muted: #6B6B72; --fg-subtle: #9A9AA0;'
    + '  --hairline: #E5E5E2; --hairline-strong: #C8C8CC;'
    + '  --warning: #92400E; --warning-bg: #FEF3C7;'
    + '  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;'
    + '  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;'
    + '}'
    + '@media (prefers-color-scheme: dark) {'
    + '  :root { --ink: #F5F5F2; --paper: #0B0B0C; --fg-muted: #A0A0A6; --fg-subtle: #6B6B72; --hairline: #26262A; --hairline-strong: #3D3D42; --warning-bg: rgba(180,83,9,0.18); }'
    + '}'
    + '* { box-sizing: border-box; margin: 0; padding: 0; }'
    + 'body { font-family: var(--font-sans); color: var(--ink); background: var(--paper); line-height: 1.6; padding: 32px 40px; max-width: 860px; margin: 0 auto; -webkit-font-smoothing: antialiased; }'
    + '.header { text-align: center; margin-bottom: 28px; }'
    + 'h1 { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 12px; color: var(--ink); }'
    + '.meta { color: var(--fg-muted); font-size: 12px; font-family: var(--font-mono); letter-spacing: 0.04em; }'
    + '.meta span { display: inline-block; margin: 0 10px; }'
    + '.source { font-size: 11px; color: var(--fg-subtle); font-family: var(--font-mono); margin-top: 8px; }'
    + '.source a { color: var(--fg-muted); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--hairline-strong); }'
    + '.divider { border: none; border-top: 1px solid var(--hairline); margin-bottom: 24px; }'
    + '.columns { display: grid; grid-template-columns: 2fr 3fr; gap: 32px; align-items: start; }'
    + 'h2 { font-family: var(--font-mono); font-size: 10px; font-weight: 400; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-muted); border-bottom: 1px solid var(--hairline); padding-bottom: 6px; margin-bottom: 14px; }'
    + '.ingredients { list-style: none; display: flex; flex-direction: column; gap: 9px; }'
    + '.ingredients li { display: flex; align-items: flex-start; gap: 10px; font-size: 14px; line-height: 1.5; color: var(--ink); }'
    + '.cb { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid var(--hairline-strong); border-radius: 3px; margin-top: 3px; display: inline-block; }'
    + '.instructions { list-style: decimal; padding-left: 20px; display: flex; flex-direction: column; gap: 12px; }'
    + '.instructions li { font-size: 14px; line-height: 1.65; color: var(--ink); }'
    + '.disclaimer { font-family: var(--font-sans); font-size: 13px; color: var(--warning); background: var(--warning-bg); border: 1px solid color-mix(in srgb, var(--warning) 25%, transparent); border-radius: 6px; padding: 9px 12px; line-height: 1.5; margin-bottom: 20px; }'
    + '.footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--hairline); font-family: var(--font-mono); font-size: 11px; color: var(--fg-subtle); letter-spacing: 0.04em; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }'
    + '.footer a { color: var(--fg-muted); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--hairline-strong); }'
    + '.footer a:hover { color: var(--ink); }'
    + '@media print { body { padding: 0; max-width: none; margin: 0; background: white; } .footer a { display: none; } }'
    + '</style></head><body>'
    + '<p class="disclaimer">Recipe extracted from the source page. Check the original for accuracy.</p>'
    + '<div class="header">'
    + '<h1>' + recipe.title + '</h1>'
    + metaLine
    + sourceLine
    + '</div>'
    + '<hr class="divider">'
    + '<div class="columns">'
    + (ingredientRows ? '<div><h2>Ingredients</h2><ul class="ingredients">' + ingredientRows + '</ul></div>' : '<div></div>')
    + (instructionRows ? '<div><h2>Instructions</h2><ol class="instructions">' + instructionRows + '</ol></div>' : '<div></div>')
    + '</div>'
    + '<div class="footer"><span>Private AI Summary · Runs entirely on your device · No data sent</span><a href="https://buymeacoffee.com/jtysonwilliams" target="_blank">Buy me a coffee</a></div>'
    + '</body></html>';

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  win.addEventListener('load', function() { URL.revokeObjectURL(url); });
}

// PAGE CONTENT EXTRACTOR (injected into the page)
function extractContentFromPage() {
  const url = window.location.href;

  const selectors = ['article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content', '#content', '#main-content'];
  let el = null;
  for (let i = 0; i < selectors.length; i++) {
    const found = document.querySelector(selectors[i]);
    if (found && found.textContent.trim().length > 200) { el = found; break; }
  }
  if (!el) el = document.body;

  const clone = el.cloneNode(true);
  const noisy = ['nav','header','footer','aside','script','style','noscript','.ad','.ads','.sidebar','.comments','.share','.social','.cookie','.popup','.modal','.newsletter','[aria-hidden="true"]'];
  noisy.forEach(function(sel) {
    try { clone.querySelectorAll(sel).forEach(function(n) { n.remove(); }); } catch (e) {}
  });

  const text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 15000);

  const siteEl = document.querySelector('meta[property="og:site_name"], meta[name="application-name"]');
  const siteName = siteEl ? siteEl.content : null;

  const authorEls = document.querySelectorAll('meta[name="author"], meta[property="article:author"]');
  let authors = Array.from(authorEls).map(function(m) { return m.content; }).filter(Boolean);
  if (!authors.length) {
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (let s = 0; s < ldScripts.length; s++) {
      try {
        const d = JSON.parse(ldScripts[s].textContent);
        const items = d['@graph'] ? d['@graph'] : (Array.isArray(d) ? d : [d]);
        for (let t = 0; t < items.length; t++) {
          if (items[t].author) {
            const a = Array.isArray(items[t].author) ? items[t].author : [items[t].author];
            authors = a.map(function(x) { return typeof x === 'string' ? x : (x && x.name); }).filter(Boolean);
            if (authors.length) break;
          }
        }
        if (authors.length) break;
      } catch (e) {}
    }
  }

  const pubEl = document.querySelector(
    'meta[property="article:published_time"], meta[name="article:published_time"], ' +
    'meta[property="datePublished"], meta[itemprop="datePublished"], meta[name="pubdate"]'
  );
  const modEl = document.querySelector(
    'meta[property="article:modified_time"], meta[name="article:modified_time"], ' +
    'meta[property="dateModified"], meta[itemprop="dateModified"]'
  );
  const publishedTime = pubEl ? pubEl.content : null;
  const modifiedTime  = modEl ? modEl.content : null;

  return { type: 'article', title: document.title, content: text, url: url,
           siteName: siteName, authors: authors, publishedTime: publishedTime, modifiedTime: modifiedTime };
}

// YOUTUBE TRANSCRIPT EXTRACTOR (injected into the page)
async function extractYouTubeTranscriptFromPage() {
  const title = document.title.replace(/ - YouTube$/, '').trim();
  const url = window.location.href;

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function readTranscriptDOM() {
    // New UI (PAmodern_transcript_view): transcript-segment-view-model with span[role="text"]
    // Timestamps are in aria-hidden divs and a11y label divs — span[role="text"] gives only the speech text
    var newSegs = document.querySelectorAll('transcript-segment-view-model span[role="text"]');
    if (newSegs.length >= 5) {
      return Array.from(newSegs)
        .map(function(s) { return s.textContent ? s.textContent.trim() : ''; })
        .filter(Boolean)
        .join(' ').replace(/\s+/g, ' ').trim();
    }

    // Old UI: ytd-transcript-segment-renderer .segment-text
    var oldSegs = document.querySelectorAll(
      'ytd-transcript-segment-renderer .segment-text, ytd-transcript-segment-renderer'
    );
    if (oldSegs.length < 5) return null;
    return Array.from(oldSegs)
      .map(function(s) { return s.textContent ? s.textContent.trim() : ''; })
      .filter(function(t) { return t && !/^\d+:\d+$/.test(t); })
      .join(' ').replace(/\s+/g, ' ').trim();
  }

  function collectMeta() {
    const channelEl = document.querySelector(
      'ytd-channel-name yt-formatted-string a, #channel-name .yt-formatted-string, #owner ytd-channel-name a'
    );
    const channelName = channelEl ? channelEl.textContent.trim() : null;

    const viewEl = document.querySelector('.view-count, #view-count span.view-count, ytd-video-view-count-renderer span');
    const viewCount = viewEl ? viewEl.textContent.trim() : null;

    const pubMeta = document.querySelector('meta[itemprop="datePublished"]');
    const publishedDate = pubMeta ? pubMeta.content : null;

    const commentNodes = document.querySelectorAll('ytd-comment-thread-renderer');
    const topComments = Array.from(commentNodes).slice(0, 3).map(function(node) {
      const authorEl = node.querySelector('#author-text span');
      const textEl   = node.querySelector('#content-text');
      const text     = textEl ? textEl.textContent.trim() : null;
      return text ? { author: authorEl ? authorEl.textContent.trim() : null, text: text } : null;
    }).filter(Boolean);

    return { channelName: channelName, viewCount: viewCount, publishedDate: publishedDate, topComments: topComments };
  }

  function buildResult(content) {
    const m = collectMeta();
    return {
      title: title, url: url, content: content, type: 'youtube',
      channelName: m.channelName, viewCount: m.viewCount,
      publishedDate: m.publishedDate, topComments: m.topComments
    };
  }

  function parseTracksAndFetch(tracks) {
    if (!tracks || !tracks.length) return Promise.resolve(null);
    const track = tracks.find(function(t) {
      return t.languageCode === 'en' || (t.languageCode && t.languageCode.startsWith('en'));
    }) || tracks[0];
    if (!track || !track.baseUrl) return Promise.resolve(null);

    return fetch(track.baseUrl + '&fmt=json3')
      .then(function(r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function(j) {
        const text = (j.events || [])
          .filter(function(e) { return e.segs; })
          .map(function(e) { return e.segs.map(function(s) { return s.utf8 || ''; }).join(''); })
          .join(' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        return text.length > 100 ? text.slice(0, 15000) : null;
      })
      .catch(function() {
        return fetch(track.baseUrl)
          .then(function(r) { return r.ok ? r.text() : null; })
          .then(function(xml) {
            if (!xml) return null;
            const text = xml
              .replace(/<[^>]+>/g, ' ')
              .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
              .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
              .replace(/\s+/g, ' ').trim();
            return text.length > 100 ? text.slice(0, 15000) : null;
          })
          .catch(function() { return null; });
      });
  }

  // ── Method 1: ytInitialPlayerResponse (player data — has caption tracks) ──
  // Only use if it matches the current video (SPA navigation can leave stale data)
  try {
    const currentVideoId = new URLSearchParams(window.location.search).get('v');
    const ipr = window.ytInitialPlayerResponse;
    const iprVideoId = ipr && ipr.videoDetails && ipr.videoDetails.videoId;
    if (ipr && (!currentVideoId || !iprVideoId || currentVideoId === iprVideoId)) {
      const tracks = ipr.captions
        && ipr.captions.playerCaptionsTracklistRenderer
        && ipr.captions.playerCaptionsTracklistRenderer.captionTracks;
      const text = await parseTracksAndFetch(tracks);
      if (text) return buildResult(text);
    }
  } catch (e) {}

  // ── Method 1b: ytplayer.config (player re-initialises on SPA nav; raw_player_response may be fresher) ──
  try {
    const cfg = window.ytplayer && window.ytplayer.config;
    const raw = cfg && cfg.args && cfg.args.raw_player_response;
    const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    const tracks = parsed
      && parsed.captions
      && parsed.captions.playerCaptionsTracklistRenderer
      && parsed.captions.playerCaptionsTracklistRenderer.captionTracks;
    const text = await parseTracksAndFetch(tracks);
    if (text) return buildResult(text);
  } catch (e) {}

  // ── Method 2: Transcript panel already open ──
  const existing = readTranscriptDOM();
  if (existing && existing.length > 100) return buildResult(existing.slice(0, 15000));

  // ── Method 3a: New "In this video" panel — click the Transcript tab if visible ──
  try {
    var allTabs = Array.from(document.querySelectorAll(
      'tp-yt-paper-tab, [role="tab"], yt-tab-shape'
    ));
    var transcriptTab = allTabs.find(function(tab) {
      var txt = (tab.innerText || tab.textContent || '').trim().toLowerCase();
      return txt === 'transcript';
    });
    if (transcriptTab) {
      transcriptTab.click();
      await sleep(1000);
      var tabText = readTranscriptDOM();
      if (tabText && tabText.length > 100) return buildResult(tabText.slice(0, 15000));
    }
  } catch (e) {}

  // ── Method 3b: "Show transcript" button (new UI: ytd-video-description-transcript-section-renderer,
  //               old UI: in description after expanding) ──
  try {
    // First try the aria-label — most reliable, works without needing to expand description
    var transcriptBtn = document.querySelector('[aria-label="Show transcript"]');

    if (!transcriptBtn) {
      // Old UI: expand the description first, then find the button by text
      const expandSelectors = [
        '#description-inline-expander #expand',
        'ytd-text-inline-expander #expand',
        'ytd-text-inline-expander tp-yt-paper-button',
        '#description tp-yt-paper-button[aria-expanded="false"]',
      ];
      for (var i = 0; i < expandSelectors.length; i++) {
        var expBtn = document.querySelector(expandSelectors[i]);
        if (expBtn) { expBtn.click(); break; }
      }
      await sleep(600);

      var allClickable = Array.from(document.querySelectorAll(
        'button, tp-yt-paper-button, yt-button-shape button, ytd-button-renderer button'
      ));
      transcriptBtn = allClickable.find(function(b) {
        var txt = (b.innerText || b.textContent || '').trim().toLowerCase();
        return txt === 'show transcript' || txt === 'transcript' || txt === 'open transcript';
      });
    }

    if (transcriptBtn) {
      transcriptBtn.click();
      await sleep(2500);
      var domText = readTranscriptDOM();
      if (domText && domText.length > 100) return buildResult(domText.slice(0, 15000));
    }
  } catch (e) {}

  return buildResult(null);
}

// NEWS CRITIQUE DISPLAY
function displayNewsCritique(rawText) {
  lastSummaryText = rawText;
  lastType = 'news-critique';

  var sectionDefs = [
    { key: 'KEY POINTS',       label: 'Key points' },
    { key: "WHAT'S MISSING",   label: "What's missing" },
    { key: 'WHO BENEFITS',     label: 'Who benefits' },
    { key: 'QUESTIONS TO ASK', label: 'Questions to ask' },
  ];

  var sections = [];
  for (var i = 0; i < sectionDefs.length; i++) {
    var key = sectionDefs[i].key;
    var label = sectionDefs[i].label;
    var nextKey = sectionDefs[i + 1] ? sectionDefs[i + 1].key : null;

    var startIdx = rawText.toUpperCase().indexOf(key);
    if (startIdx === -1) continue;

    var afterHeader = rawText.slice(startIdx + key.length).replace(/^[:\s]+/, '');
    var content;
    if (nextKey) {
      var endIdx = afterHeader.toUpperCase().indexOf(nextKey);
      content = endIdx === -1 ? afterHeader.trim() : afterHeader.slice(0, endIdx).trim();
    } else {
      content = afterHeader.trim();
    }

    if (content) sections.push({ label: label, text: content });
  }

  if (!sections.length) {
    sections = [{ label: 'Analysis', text: rawText }];
  }

  els.outputLabel.textContent = 'News critique';
  els.summaryBox.innerHTML = '';

  var disclaimer = document.createElement('p');
  disclaimer.className = 'disclaimer';
  disclaimer.textContent = 'AI-generated analysis using a local model. Check all facts for accuracy.';
  els.summaryBox.appendChild(disclaimer);

  for (var j = 0; j < sections.length; j++) {
    var sLabel = sections[j].label;
    var sText = sections[j].text;
    if (!sText || !sText.trim()) continue;

    var heading = document.createElement('p');
    heading.className = 'section-label';
    heading.textContent = sLabel;
    els.summaryBox.appendChild(heading);

    var lines = sText.split('\n').map(function(l) {
      return l.replace(/^[-*•\d.]+\s*/, '').trim();
    }).filter(function(l) {
      return l.length > 3;
    });

    if (lines.length > 1) {
      var ul = document.createElement('ul');
      for (var k = 0; k < lines.length; k++) {
        var li = document.createElement('li');
        li.textContent = lines[k];
        ul.appendChild(li);
      }
      els.summaryBox.appendChild(ul);
    } else {
      var p = document.createElement('p');
      p.textContent = sText.trim();
      els.summaryBox.appendChild(p);
    }
  }

  els.output.classList.add('visible');
}

// SUMMARY DISPLAY
function displaySummary(text, type) {
  lastSummaryText = text;
  lastType = type;

  const labels = {
    'key-points':      'Key points',
    'youtube-summary': 'Video summary',
    'tldr':            'TL;DR',
    'teaser':          'Teaser',
    'headline':        'Headline'
  };
  els.outputLabel.textContent = labels[type] || 'Summary';

  var disclaimer = document.createElement('p');
  disclaimer.className = 'disclaimer';
  disclaimer.textContent = 'AI-generated summary using a local model. Verify important details independently.';

  if (type === 'key-points' || type === 'youtube-summary') {
    const lines = text.split('\n').map(function(l) {
      return l.replace(/^[-*]\s*/, '').trim();
    }).filter(function(l) {
      return l.length > 5;
    });

    els.summaryBox.innerHTML = '';
    els.summaryBox.appendChild(disclaimer);

    if (lines.length > 1) {
      const ul = document.createElement('ul');
      lines.forEach(function(line) {
        const li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      });
      els.summaryBox.appendChild(ul);
    } else {
      text.split('\n').filter(function(l) { return l.trim(); }).forEach(function(line) {
        const p = document.createElement('p');
        p.textContent = line.trim();
        els.summaryBox.appendChild(p);
      });
    }
  } else {
    els.summaryBox.innerHTML = '';
    els.summaryBox.appendChild(disclaimer);
    text.split('\n').filter(function(l) { return l.trim(); }).forEach(function(line) {
      const p = document.createElement('p');
      p.textContent = line.trim();
      els.summaryBox.appendChild(p);
    });
  }

  els.output.classList.add('visible');
}

function renderParagraphs(text) {
  els.summaryBox.innerHTML = '';
  text.split('\n').filter(function(l) { return l.trim(); }).forEach(function(line) {
    const p = document.createElement('p');
    p.textContent = line.trim();
    els.summaryBox.appendChild(p);
  });
}

// YOUTUBE COMMENTS APPEND
function appendYouTubeComments(comments) {
  if (!comments || !comments.length) return;

  var heading = document.createElement('p');
  heading.className = 'section-label';
  heading.textContent = 'Top comments';
  els.summaryBox.appendChild(heading);

  comments.forEach(function(comment) {
    var item = document.createElement('div');
    item.className = 'comment-item';

    if (comment.author) {
      var author = document.createElement('p');
      author.className = 'comment-author';
      author.textContent = comment.author;
      item.appendChild(author);
    }

    var text = document.createElement('p');
    text.className = 'comment-text';
    text.textContent = '“' + comment.text + '”';
    item.appendChild(text);

    els.summaryBox.appendChild(item);
  });
}

// STREAMING RENDER HELPERS

function createCursor() {
  const span = document.createElement('span');
  span.className = 'stream-cursor';
  span.textContent = '▍';
  return span;
}

function renderSummaryStreaming(text, type) {
  els.summaryBox.innerHTML = '';

  if (type === 'key-points' || type === 'youtube-summary') {
    const lines = text.split('\n').map(function(l) {
      return l.replace(/^[-*]\s*/, '').trim();
    }).filter(function(l) { return l.length > 5; });

    if (lines.length > 1) {
      const ul = document.createElement('ul');
      lines.forEach(function(line, i) {
        const li = document.createElement('li');
        li.textContent = line;
        if (i === lines.length - 1) li.appendChild(createCursor());
        ul.appendChild(li);
      });
      els.summaryBox.appendChild(ul);
      return;
    }
  }

  const paras = text.split('\n').filter(function(l) { return l.trim(); });
  if (paras.length) {
    paras.forEach(function(line, i) {
      const p = document.createElement('p');
      p.textContent = line.trim();
      if (i === paras.length - 1) p.appendChild(createCursor());
      els.summaryBox.appendChild(p);
    });
  } else {
    const p = document.createElement('p');
    p.appendChild(createCursor());
    els.summaryBox.appendChild(p);
  }
}

function renderNewsCritiqueStreaming(text) {
  var sectionDefs = [
    { key: 'KEY POINTS',       label: 'Key points' },
    { key: "WHAT'S MISSING",   label: "What's missing" },
    { key: 'WHO BENEFITS',     label: 'Who benefits' },
    { key: 'QUESTIONS TO ASK', label: 'Questions to ask' },
  ];

  var sections = [];
  for (var i = 0; i < sectionDefs.length; i++) {
    var key = sectionDefs[i].key;
    var label = sectionDefs[i].label;
    var nextKey = sectionDefs[i + 1] ? sectionDefs[i + 1].key : null;
    var startIdx = text.toUpperCase().indexOf(key);
    if (startIdx === -1) continue;
    var afterHeader = text.slice(startIdx + key.length).replace(/^[:\s]+/, '');
    var content;
    if (nextKey) {
      var endIdx = afterHeader.toUpperCase().indexOf(nextKey);
      content = endIdx === -1 ? afterHeader.trim() : afterHeader.slice(0, endIdx).trim();
    } else {
      content = afterHeader.trim();
    }
    if (content) sections.push({ label: label, text: content });
  }

  els.summaryBox.innerHTML = '';

  var disclaimer = document.createElement('p');
  disclaimer.className = 'disclaimer';
  disclaimer.textContent = 'AI-generated analysis using a local model. Check all facts for accuracy.';
  els.summaryBox.appendChild(disclaimer);

  if (!sections.length) {
    var p = document.createElement('p');
    p.textContent = text.trim();
    p.appendChild(createCursor());
    els.summaryBox.appendChild(p);
    return;
  }

  for (var j = 0; j < sections.length; j++) {
    var isLast = j === sections.length - 1;
    var sLabel = sections[j].label;
    var sText = sections[j].text;
    if (!sText || !sText.trim()) continue;

    var heading = document.createElement('p');
    heading.className = 'section-label';
    heading.textContent = sLabel;
    els.summaryBox.appendChild(heading);

    var lines = sText.split('\n').map(function(l) {
      return l.replace(/^[-*•\d.]+\s*/, '').trim();
    }).filter(function(l) { return l.length > 3; });

    if (lines.length > 1) {
      var ul = document.createElement('ul');
      for (var k = 0; k < lines.length; k++) {
        var li = document.createElement('li');
        li.textContent = lines[k];
        if (isLast && k === lines.length - 1) li.appendChild(createCursor());
        ul.appendChild(li);
      }
      els.summaryBox.appendChild(ul);
    } else {
      var p = document.createElement('p');
      p.textContent = sText.trim();
      if (isLast) p.appendChild(createCursor());
      els.summaryBox.appendChild(p);
    }
  }
}

// COPY TO CLIPBOARD
async function copyText() {
  if (!lastSummaryText) return;
  await navigator.clipboard.writeText(lastSummaryText);
  els.btnCopy.textContent = 'copied!';
  els.btnCopy.classList.add('copied');
  setTimeout(function() {
    els.btnCopy.textContent = 'copy';
    els.btnCopy.classList.remove('copied');
  }, 2000);
}

// UI HELPERS
function setLoading(on) {
  els.loading.classList.toggle('visible', on);
  els.controls.style.opacity       = on ? '0.4' : '1';
  els.controls.style.pointerEvents = on ? 'none' : 'auto';
}

function setLoadingText(t) { els.loadingText.textContent = t; }
function showError(msg)     { els.errorText.textContent = msg; els.errorBox.classList.add('visible'); }
function hideError()        { els.errorBox.classList.remove('visible'); }
function hideOutput()       { els.output.classList.remove('visible'); }

function showSetup(message, buttonLabel, flagUrl) {
  document.getElementById('setupText').textContent = message;
  var btn = document.getElementById('btnSetupAction');
  btn.textContent = buttonLabel;
  btn.onclick = function() { chrome.tabs.create({ url: flagUrl }); };
  document.getElementById('setupBox').classList.add('visible');
}

function hideSetup() { document.getElementById('setupBox').classList.remove('visible'); }

init();
