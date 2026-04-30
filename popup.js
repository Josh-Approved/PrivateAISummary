// popup.js

const $ = id => document.getElementById(id);

const els = {
  pageInfo:        $('pageInfo'),
  pageTitle:       $('pageTitle'),
  pageTypeBadge:   $('pageTypeBadge'),
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
  summaryType:     $('summaryType'),
  summaryLength:   $('summaryLength'),
  summaryLanguage: $('summaryLanguage'),
  lengthWrap:      $('lengthWrap'),
};

let lastSummaryText = '';

// INITIALIZATION
async function init() {
  const supported = await checkSupportAsync();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.title) els.pageTitle.textContent = tab.title;

  const isYouTube = tab && tab.url && (tab.url.includes('youtube.com/watch') || tab.url.includes('youtu.be/'));
  if (isYouTube) {
    els.pageTypeBadge.textContent = 'YOUTUBE';
    els.pageTypeBadge.className = 'page-type-badge youtube';
  }

  document.getElementById('flagLink').addEventListener('click', function(e) {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://flags/#optimization-guide-on-device-model' });
  });

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

  const saved = await chrome.storage.local.get(['summaryType', 'summaryLength', 'summaryLanguage']);
  if (saved.summaryType)     els.summaryType.value     = saved.summaryType;
  if (saved.summaryLength)   els.summaryLength.value   = saved.summaryLength;
  if (saved.summaryLanguage) els.summaryLanguage.value = saved.summaryLanguage;

  applyFormatUI(saved.summaryType || 'key-points');

  els.btnSummarize.addEventListener('click', runSummary);
  els.btnCopy.addEventListener('click', copyText);

  els.summaryType.addEventListener('change', function() {
    const val = els.summaryType.value;
    chrome.storage.local.set({ summaryType: val });
    applyFormatUI(val);
  });

  els.summaryLength.addEventListener('change', function() {
    chrome.storage.local.set({ summaryLength: els.summaryLength.value });
  });

  els.summaryLanguage.addEventListener('change', function() {
    chrome.storage.local.set({ summaryLanguage: els.summaryLanguage.value });
  });
}

function applyFormatUI(format) {
  const hideLength = format === 'recipe' || format === 'news-critique';
  els.lengthWrap.style.display = hideLength ? 'none' : '';
  const span = els.btnSummarize.querySelector('span');
  if (format === 'recipe') {
    span.textContent = 'Extract Recipe';
  } else if (format === 'news-critique') {
    span.textContent = 'Critique this article';
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
      setLoadingText('EXTRACTING CONTENT');
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

      setLoadingText('LOADING ON-DEVICE MODEL');
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
          'Open Chrome flags →',
          'chrome://flags'
        );
        return;
      }

      var session;
      if (availability === 'downloadable') {
        setLoadingText('DOWNLOADING MODEL (ONCE)');
        session = await lm.create({
          monitor: function(m) {
            m.addEventListener('downloadprogress', function(e) {
              var pct = Math.round((e.loaded || 0) * 100);
              setLoadingText('DOWNLOADING MODEL ' + pct + '%');
            });
          }
        });
      } else {
        session = await lm.create();
      }

      setLoadingText('ANALYZING ARTICLE');

      const prompt = 'You are a media literacy analyst. Analyze the article below and respond with ONLY these five labeled sections. Do not add any text before the first section or after the last section.\n\n'
        + 'KEY POINTS:\nList 3-5 bullet points of the main facts and claims. Include specific names, numbers, and direct claims from the article. Do not editorialize. Start each bullet with *.\n\n'
        + "WHAT'S MISSING:\nList 2-4 specific gaps — name a missing statistic, an absent source or perspective, an unaddressed counterargument, or omitted context that would change how a reader understands this story. Every bullet must be specific to this article. Do not write vague observations like \"more context would be helpful.\" Start each bullet with *.\n\n"
        + 'TONE CHECK:\nPick exactly ONE tone from the list below that best matches the article\'s OWN language and framing. Evaluate only the author\'s words — ignore text inside quotation marks, which are words spoken by sources, not the author. Focus on the author\'s own word choices, how they describe events, and which perspectives they choose to emphasize.\n\nNEUTRAL — Balanced language, no loaded framing, both sides represented fairly.\nPERSUASIVE — Selective framing or leading language that steers the reader toward a conclusion.\nEMOTIONAL — Charged or dramatic language designed to trigger sympathy, outrage, or fear.\nALARMING — Emphasizes threats, danger, or crisis to create urgency.\n\nWrite the tone word alone on its own line first. On the next line, quote a specific word or phrase from the author\'s own writing — not from a quoted source — and explain in one sentence why it demonstrates this tone.\n\n'
        + 'WHO BENEFITS:\nName 2-4 specific people, organizations, or groups who benefit from this story being framed this way. For each, write one sentence explaining what they gain. Do not use vague categories like "politicians" or "the media."\n\n'
        + 'QUESTIONS TO ASK:\nWrite 3-4 questions a skeptical reader should investigate. Each question must be specific to a claim or gap in this article — not generic media literacy questions. Start each bullet with *.\n\n'
        + 'Article title: ' + extracted.title + '\n\n'
        + extracted.content;

      let streamedText = '';
      let prevChunk = '';
      let streamingStarted = false;
      let rafPending = false;
      let streamingEl = null;
      const stream = session.promptStreaming(prompt);

      for await (const chunk of stream) {
        // Handle both cumulative and incremental chunk styles across Chrome versions
        const delta = chunk.startsWith(prevChunk) ? chunk.slice(prevChunk.length) : chunk;
        streamedText += delta;
        prevChunk = chunk;

        if (!streamingStarted) {
          streamingStarted = true;
          setLoading(false);
          els.outputLabel.textContent = 'NEWS CRITIQUE';
          els.summaryBox.innerHTML = '<div class="streaming-raw" id="streamingRaw"></div>';
          streamingEl = document.getElementById('streamingRaw');
          els.output.classList.add('visible');
        }

        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(function() {
            if (streamingEl) streamingEl.textContent = streamedText;
            rafPending = false;
          });
        }
      }

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
      setLoadingText('FINDING RECIPE');
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

  // SUMMARIZE MODE
  try {
    setLoadingText('EXTRACTING CONTENT');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let extracted;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractContentFromPage,
      });
      extracted = res[0] && res[0].result;
    } catch (e) {
      throw new Error("Couldn't access this page. Try a regular article or YouTube video.");
    }

    if (!extracted || !extracted.content || extracted.content.trim().length < 100) {
      throw new Error("Not enough readable text found on this page. Try navigating to a full article.");
    }

    setLoadingText('LOADING ON-DEVICE MODEL');
    const availability = await Summarizer.availability();
    const length = els.summaryLength.value;
    const lang = els.summaryLanguage.value;

    const options = {
      type: type,
      length: length,
      format: 'plain-text',
      outputLanguage: lang,
      sharedContext: extracted.type === 'youtube'
        ? 'This is a YouTube video transcript.'
        : 'This is a web article or webpage.',
    };

    let summarizer;
    if (availability === 'downloadable') {
      setLoadingText('DOWNLOADING MODEL (ONCE)');
      summarizer = await Summarizer.create(Object.assign({}, options, {
        monitor: function(m) {
          m.addEventListener('downloadprogress', function(e) {
            const pct = Math.round((e.loaded || 0) * 100);
            setLoadingText('DOWNLOADING MODEL ' + pct + '%');
          });
        }
      }));
    } else {
      summarizer = await Summarizer.create(options);
    }

    setLoadingText('SUMMARIZING ON-DEVICE');
    const summary = await summarizer.summarize(extracted.content, {
      context: 'Title: ' + extracted.title
    });
    summarizer.destroy();

    displaySummary(summary, type);
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

// RECIPE TAB
function openRecipeTab(recipe) {
  const meta = [];
  if (recipe.totalTime) meta.push('⏱ Total: ' + recipe.totalTime);
  if (recipe.prepTime)  meta.push('Prep: ' + recipe.prepTime);
  if (recipe.cookTime)  meta.push('Cook: ' + recipe.cookTime);
  if (recipe.servings)  meta.push('🍽 Serves ' + recipe.servings);

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
    + '* { box-sizing: border-box; margin: 0; padding: 0; }'
    + 'body { font-family: Georgia, serif; color: #1a1a1a; line-height: 1.6; padding: 32px 40px; max-width: 860px; margin: 0 auto; }'
    + '@media print { body { padding: 0; max-width: none; margin: 0; } }'
    + '.header { text-align: center; margin-bottom: 28px; }'
    + 'h1 { font-size: 26px; margin-bottom: 10px; }'
    + '.meta { color: #666; font-size: 12px; font-family: monospace; letter-spacing: 0.3px; }'
    + '.meta span { display: inline-block; margin: 0 10px; }'
    + '.source { font-size: 10px; color: #999; font-family: monospace; margin-top: 8px; }'
    + '.source a { color: #999; text-decoration: none; }'
    + '.divider { border: none; border-top: 1px solid #ddd; margin-bottom: 24px; }'
    + '.columns { display: grid; grid-template-columns: 2fr 3fr; gap: 32px; align-items: start; }'
    + 'h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: #888; border-bottom: 1px solid #ddd; padding-bottom: 5px; margin-bottom: 14px; }'
    + '.ingredients { list-style: none; display: flex; flex-direction: column; gap: 9px; }'
    + '.ingredients li { display: flex; align-items: flex-start; gap: 9px; font-size: 13px; line-height: 1.5; }'
    + '.cb { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid #aaa; border-radius: 2px; margin-top: 2px; display: inline-block; }'
    + '.instructions { list-style: decimal; padding-left: 18px; display: flex; flex-direction: column; gap: 12px; }'
    + '.instructions li { font-size: 13px; line-height: 1.65; }'
    + '</style></head><body>'
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
    + '</body></html>';

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  win.addEventListener('load', function() { URL.revokeObjectURL(url); });
}

// PAGE CONTENT EXTRACTOR (injected into the page)
function extractContentFromPage() {
  const url = window.location.href;
  const isYouTube = url.includes('youtube.com/watch') || url.includes('youtu.be/');

  if (isYouTube) {
    const segments = document.querySelectorAll(
      'ytd-transcript-segment-renderer .segment-text, .ytd-transcript-segment-renderer'
    );
    if (segments.length > 0) {
      const text = Array.from(segments).map(function(s) {
        return s.textContent ? s.textContent.trim() : '';
      }).filter(Boolean).join(' ');
      return { type: 'youtube', title: document.title.replace(' - YouTube', ''), content: text.slice(0, 15000), url: url };
    }
    const descEl = document.querySelector('#description-inline-expander, #description, ytd-text-inline-expander');
    const desc = descEl ? descEl.textContent : '';
    return { type: 'youtube', title: document.title.replace(' - YouTube', ''), content: desc.slice(0, 8000), url: url };
  }

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
  return { type: 'article', title: document.title, content: text, url: url };
}

// NEWS CRITIQUE DISPLAY
function displayNewsCritique(rawText) {
  lastSummaryText = rawText;

  var sectionDefs = [
    { key: 'KEY POINTS',       label: 'Key Points' },
    { key: "WHAT'S MISSING",   label: "What's Missing" },
    { key: 'TONE CHECK',       label: 'Tone Check' },
    { key: 'WHO BENEFITS',     label: 'Who Benefits' },
    { key: 'QUESTIONS TO ASK', label: 'Questions to Ask' },
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

  els.outputLabel.textContent = 'NEWS CRITIQUE';
  els.summaryBox.innerHTML = '';

  var disclaimer = document.createElement('p');
  disclaimer.className = 'critique-disclaimer';
  disclaimer.textContent = 'AI-generated analysis using a local model. Check all facts for accuracy.';
  els.summaryBox.appendChild(disclaimer);

  for (var j = 0; j < sections.length; j++) {
    var sLabel = sections[j].label;
    var sText = sections[j].text;
    if (!sText || !sText.trim()) continue;

    var heading = document.createElement('p');
    heading.className = 'critique-label';
    heading.textContent = sLabel;
    els.summaryBox.appendChild(heading);

    var lines = sText.split('\n').map(function(l) {
      return l.replace(/^[-*•\d.]+\s*/, '').trim();
    }).filter(function(l) {
      return l.length > 3;
    });

    // Special rendering for Tone Check
    if (sLabel === 'Tone Check') {
      var toneOptions = ['neutral', 'emotional', 'persuasive', 'alarming'];
      var firstWord = sText.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
      var detected = toneOptions.indexOf(firstWord) !== -1 ? firstWord : null;

      if (!detected) {
        var lower = sText.toLowerCase();
        for (var ti = 0; ti < toneOptions.length; ti++) {
          if (lower.indexOf(toneOptions[ti]) !== -1) { detected = toneOptions[ti]; break; }
        }
      }

      var pillRow = document.createElement('div');
      pillRow.className = 'tone-pills';
      var toneLabels = ['Neutral', 'Emotional', 'Persuasive', 'Alarming'];
      toneLabels.forEach(function(tLabel) {
        var pill = document.createElement('span');
        pill.className = 'tone-pill';
        if (detected === tLabel.toLowerCase()) pill.className += ' active-' + tLabel.toLowerCase();
        pill.textContent = tLabel;
        pillRow.appendChild(pill);
      });
      els.summaryBox.appendChild(pillRow);

      var explanationLines = (detected && firstWord === detected) ? lines.slice(1) : lines;
      if (explanationLines.length > 0) {
        var tp = document.createElement('p');
        tp.textContent = explanationLines.join(' ');
        els.summaryBox.appendChild(tp);
      }
      continue;
    }

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

  const labels = {
    'key-points': 'KEY POINTS',
    'tldr':       'TL;DR',
    'teaser':     'TEASER',
    'headline':   'HEADLINE'
  };
  els.outputLabel.textContent = labels[type] || 'SUMMARY';

  if (type === 'key-points') {
    const lines = text.split('\n').map(function(l) {
      return l.replace(/^[-*]\s*/, '').trim();
    }).filter(function(l) {
      return l.length > 5;
    });

    if (lines.length > 1) {
      const ul = document.createElement('ul');
      lines.forEach(function(line) {
        const li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      });
      els.summaryBox.innerHTML = '';
      els.summaryBox.appendChild(ul);
    } else {
      renderParagraphs(text);
    }
  } else {
    renderParagraphs(text);
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
