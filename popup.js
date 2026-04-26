// popup.js — THE BRAIN OF THE EXTENSION

const $ = id => document.getElementById(id);

const els = {
  pageInfo:      $('pageInfo'),
  pageTitle:     $('pageTitle'),
  pageTypeBadge: $('pageTypeBadge'),
  unsupported:   $('unsupported'),
  controls:      $('controls'),
  btnSummarize:  $('btnSummarize'),
  loading:       $('loading'),
  loadingText:   $('loadingText'),
  output:        $('output'),
  outputLabel:   $('outputLabel'),
  summaryBox:    $('summaryBox'),
  errorBox:      $('errorBox'),
  errorText:     $('errorText'),
  btnCopy:       $('btnCopy'),
  summaryType:   $('summaryType'),
  summaryLength:   $('summaryLength'),
  summaryLanguage: $('summaryLanguage'),
  lengthWrap:      $('lengthWrap'),
};

let lastSummaryText = '';

// ── INITIALIZATION ────────────────────────────────────────────────────────────
async function init() {
  const supported = await checkSupportAsync();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.title) els.pageTitle.textContent = tab.title;

  const isYouTube = tab?.url?.includes('youtube.com/watch') || tab?.url?.includes('youtu.be/');
  if (isYouTube) {
    els.pageTypeBadge.textContent = 'YOUTUBE';
    els.pageTypeBadge.className = 'page-type-badge youtube';
  }

  document.getElementById('flagLink').addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://flags/#optimization-guide-on-device-model' });
  });

  const overlay = document.getElementById('aboutOverlay');
  document.getElementById('btnLearn').addEventListener('click', () => overlay.classList.add('visible'));
  document.getElementById('btnCloseAbout').addEventListener('click', () => overlay.classList.remove('visible'));

  if (!supported) {
    els.controls.style.display = 'none';
    els.unsupported.classList.add('visible');
    return;
  }

  // Restore saved settings
  const saved = await chrome.storage.local.get(['summaryType', 'summaryLength', 'summaryLanguage']);
  if (saved.summaryType)     els.summaryType.value     = saved.summaryType;
  if (saved.summaryLength)   els.summaryLength.value   = saved.summaryLength;
  if (saved.summaryLanguage) els.summaryLanguage.value = saved.summaryLanguage;

  // Apply recipe UI state on load if it was the last saved setting
  applyRecipeMode(saved.summaryType === 'recipe');

  els.btnSummarize.addEventListener('click', runSummary);
  els.btnCopy.addEventListener('click', copyText);

  // When format changes, save it and toggle recipe mode UI
  els.summaryType.addEventListener('change', () => {
    const val = els.summaryType.value;
    chrome.storage.local.set({ summaryType: val });
    applyRecipeMode(val === 'recipe');
  });

  els.summaryLength.addEventListener('change', () =>
    chrome.storage.local.set({ summaryLength: els.summaryLength.value }));

  els.summaryLanguage.addEventListener('change', () =>
    chrome.storage.local.set({ summaryLanguage: els.summaryLanguage.value }));
}

// Shows/hides the Length dropdown and updates button label for recipe mode
function applyRecipeMode(isRecipe) {
  els.lengthWrap.style.display = isRecipe ? 'none' : '';
  els.btnSummarize.querySelector('span').textContent = isRecipe ? 'Extract Recipe' : 'Summarize this page';
}

// ── SUPPORT CHECK ─────────────────────────────────────────────────────────────
async function checkSupportAsync() {
  if (!('Summarizer' in self)) return false;
  try {
    const avail = await Summarizer.availability({ outputLanguage: 'en' });
    return avail !== 'unavailable';
  } catch {
    return false;
  }
}

// ── MAIN WORKFLOW ─────────────────────────────────────────────────────────────
async function runSummary() {
  setLoading(true);
  hideError();
  hideOutput();

  const type = els.summaryType.value;

  // ── RECIPE MODE — no AI needed ────────────────────────────────────────────
  if (type === 'recipe') {
    try {
      setLoadingText('FINDING RECIPE');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      let result;
      try {
        [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractRecipeFromPage,
        });
        result = result?.result;
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

  // ── SUMMARIZE MODE ────────────────────────────────────────────────────────
  try {
    setLoadingText('EXTRACTING CONTENT');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let extracted;
    try {
      [extracted] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractContentFromPage,
      });
      extracted = extracted?.result;
    } catch (e) {
      throw new Error("Couldn't access this page. Try a regular article or YouTube video.");
    }

    if (!extracted?.content || extracted.content.trim().length < 100) {
      throw new Error("Not enough readable text found on this page. Try navigating to a full article.");
    }

    setLoadingText('LOADING ON-DEVICE MODEL');
    const availability = await Summarizer.availability();
    const length = els.summaryLength.value;

    const options = {
      type,
      length,
      format: 'plain-text',
      outputLanguage: els.summaryLanguage.value,
      sharedContext: extracted.type === 'youtube'
        ? 'This is a YouTube video transcript.'
        : 'This is a web article or webpage.',
    };

    let summarizer;
    if (availability === 'downloadable') {
      setLoadingText('DOWNLOADING MODEL (ONCE)');
      summarizer = await Summarizer.create({
        ...options,
        monitor(m) {
          m.addEventListener('downloadprogress', e => {
            const pct = Math.round((e.loaded || 0) * 100);
            setLoadingText(`DOWNLOADING MODEL ${pct}%`);
          });
        }
      });
    } else {
      summarizer = await Summarizer.create(options);
    }

    setLoadingText('SUMMARIZING ON-DEVICE');
    const summary = await summarizer.summarize(extracted.content, {
      context: `Title: ${extracted.title}`
    });
    summarizer.destroy();

    displaySummary(summary, type);
    setLoading(false);

  } catch (err) {
    setLoading(false);
    showError(err.message || 'An unexpected error occurred.');
  }
}

// ── RECIPE EXTRACTOR (injected into the page) ─────────────────────────────────
// Self-contained — cannot reference anything else in this file.
function extractRecipeFromPage() {

  // STRATEGY 1: JSON-LD structured data (used by most major recipe sites)
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      let data = JSON.parse(script.textContent);

      const isRecipeType = t => t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));

      // Handle arrays and @graph wrappers
      if (Array.isArray(data)) data = data.find(d => isRecipeType(d['@type'])) || data[0];
      if (data?.['@graph']) data = data['@graph'].find(d => isRecipeType(d['@type'])) || data;

      if (!isRecipeType(data?.['@type'])) continue;

      const title = data.name || document.title;

      // Ingredients are a flat array of strings
      const ingredients = (data.recipeIngredient || [])
        .map(i => i.trim())
        .filter(Boolean);

      // Instructions can be strings or HowToStep objects
      const instructions = (data.recipeInstructions || []).map(step => {
        if (typeof step === 'string') return step.replace(/<[^>]+>/g, '').trim();
        // HowToSection — recurse into its itemListElement
        if (step['@type'] === 'HowToSection' && step.itemListElement) {
          return step.itemListElement.map(s => (s.text || s.name || '').trim()).join(' ');
        }
        return (step.text || step.name || '').replace(/<[^>]+>/g, '').trim();
      }).filter(Boolean);

      // Optional metadata
      const parseDuration = val => {
        if (!val) return null;
        if (typeof val !== 'string') return null;
        // Already human-readable (e.g. "30 mins", "1 hour 15 minutes")
        if (!val.startsWith('P')) return val.trim() || null;
        // ISO 8601 duration (e.g. "PT1H30M")
        const h = (val.match(/(\d+)H/) || [])[1];
        const m = (val.match(/(\d+)M/) || [])[1];
        const parts = [];
        if (h) parts.push(`${h} hr`);
        if (m) parts.push(`${m} min`);
        return parts.join(' ') || null;
      };

      const prepTime  = parseDuration(data.prepTime);
      const cookTime  = parseDuration(data.cookTime);
      const totalTime = parseDuration(data.totalTime);
      const servings  = data.recipeYield
        ? (Array.isArray(data.recipeYield) ? data.recipeYield[0] : data.recipeYield).toString().trim()
        : null;

      const authorRaw = data.author;
      const author = !authorRaw ? null
        : typeof authorRaw === 'string' ? authorRaw
        : Array.isArray(authorRaw) ? authorRaw.map(a => a.name || a).filter(Boolean).join(', ')
        : authorRaw.name || null;

      const siteName = document.querySelector('meta[property="og:site_name"]')?.content
        || document.querySelector('meta[name="application-name"]')?.content
        || null;

      if (ingredients.length || instructions.length) {
        return { title, ingredients, instructions, prepTime, cookTime, totalTime, servings, author, siteName, url: window.location.href };
      }

    } catch (e) { continue; }
  }

  // STRATEGY 2: DOM pattern matching (fallback for sites without structured data)
  const title = document.title;
  let ingredients = [];
  let instructions = [];

  const ingredientSelectors = [
    '[class*="ingredient" i]',
    '[itemprop="recipeIngredient"]',
    '[data-ingredient]',
  ];

  for (const sel of ingredientSelectors) {
    const found = document.querySelectorAll(sel);
    if (found.length > 2) {
      const items = Array.from(found)
        .map(el => el.textContent.trim())
        .filter(t => t.length > 2 && t.length < 300);
      if (items.length) { ingredients = items; break; }
    }
  }

  const instructionSelectors = [
    '[class*="instruction" i]',
    '[class*="direction" i]',
    '[class*="step" i] p',
    '[itemprop="recipeInstructions"]',
    '[class*="method" i]',
  ];

  for (const sel of instructionSelectors) {
    const found = document.querySelectorAll(sel);
    if (found.length > 1) {
      const items = Array.from(found)
        .map(el => el.textContent.trim())
        .filter(t => t.length > 15);
      if (items.length) { instructions = items; break; }
    }
  }

  const siteName = document.querySelector('meta[property="og:site_name"]')?.content
    || document.querySelector('meta[name="application-name"]')?.content
    || null;
  return { title, ingredients, instructions, prepTime: null, cookTime: null, totalTime: null, servings: null, author: null, siteName, url: window.location.href };
}

// ── RECIPE TAB ────────────────────────────────────────────────────────────────
function openRecipeTab(recipe) {
  const meta = [];
  if (recipe.totalTime) meta.push(`⏱ Total: ${recipe.totalTime}`);
  if (recipe.prepTime)  meta.push(`Prep: ${recipe.prepTime}`);
  if (recipe.cookTime)  meta.push(`Cook: ${recipe.cookTime}`);
  if (recipe.servings)  meta.push(`🍽 Serves ${recipe.servings}`);

  const ingredientRows = recipe.ingredients
    .map(i => `<li><span class="cb"></span><span>${i}</span></li>`)
    .join('');
  const instructionRows = recipe.instructions
    .map(s => `<li>${s}</li>`)
    .join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>${recipe.title}</title>
  <style>
    @page { size: letter portrait; margin: 20mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Georgia, serif; color: #1a1a1a; line-height: 1.6; padding: 32px 40px; max-width: 860px; margin: 0 auto; }
    @media print { body { padding: 0; max-width: none; margin: 0; } }
    .header { text-align: center; margin-bottom: 28px; }
    h1 { font-size: 26px; margin-bottom: 10px; }
    .meta { color: #666; font-size: 12px; font-family: monospace; letter-spacing: 0.3px; }
    .meta span { display: inline-block; margin: 0 10px; }
    .source { font-size: 10px; color: #999; font-family: monospace; margin-top: 8px; }
    .source a { color: #999; text-decoration: none; }
    .source a:hover { text-decoration: underline; }
    .divider { border: none; border-top: 1px solid #ddd; margin-bottom: 24px; }
    .columns { display: grid; grid-template-columns: 2fr 3fr; gap: 32px; align-items: start; }
    h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: #888;
         border-bottom: 1px solid #ddd; padding-bottom: 5px; margin-bottom: 14px; }
    .ingredients { list-style: none; display: flex; flex-direction: column; gap: 9px; }
    .ingredients li { display: flex; align-items: flex-start; gap: 9px; font-size: 13px; line-height: 1.5; }
    .cb { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid #aaa;
          border-radius: 2px; margin-top: 2px; display: inline-block; }
    .instructions { list-style: decimal; padding-left: 18px; display: flex; flex-direction: column; gap: 12px; }
    .instructions li { font-size: 13px; line-height: 1.65; }
  </style></head><body>
  <div class="header">
    <h1>${recipe.title}</h1>
    ${meta.length ? `<p class="meta">${meta.map(m => `<span>${m}</span>`).join('')}</p>` : ''}
  ${recipe.url ? `<p class="source">${[recipe.siteName, recipe.author ? `By ${recipe.author}` : null, `<a href="${recipe.url}">${recipe.url}</a>`].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</p>` : ''}
  </div>
  <hr class="divider">
  <div class="columns">
    ${ingredientRows ? `<div><h2>Ingredients</h2><ul class="ingredients">${ingredientRows}</ul></div>` : '<div></div>'}
    ${instructionRows ? `<div><h2>Instructions</h2><ol class="instructions">${instructionRows}</ol></div>` : '<div></div>'}
  </div>
  </body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  win.addEventListener('load', () => URL.revokeObjectURL(url));
}

// ── PAGE CONTENT EXTRACTOR (injected into the page) ───────────────────────────
function extractContentFromPage() {
  const url = window.location.href;
  const isYouTube = url.includes('youtube.com/watch') || url.includes('youtu.be/');

  if (isYouTube) {
    const segments = document.querySelectorAll(
      'ytd-transcript-segment-renderer .segment-text, .ytd-transcript-segment-renderer'
    );
    if (segments.length > 0) {
      const text = Array.from(segments).map(s => s.textContent?.trim()).filter(Boolean).join(' ');
      return { type: 'youtube', title: document.title.replace(' - YouTube', ''), content: text.slice(0, 15000), url };
    }
    const desc = document.querySelector('#description-inline-expander, #description, ytd-text-inline-expander')?.textContent || '';
    return { type: 'youtube', title: document.title.replace(' - YouTube', ''), content: desc.slice(0, 8000), url };
  }

  const selectors = ['article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content', '#content', '#main-content'];
  let el = null;
  for (const sel of selectors) {
    const found = document.querySelector(sel);
    if (found && found.textContent.trim().length > 200) { el = found; break; }
  }
  if (!el) el = document.body;

  const clone = el.cloneNode(true);
  ['nav','header','footer','aside','script','style','noscript','.ad','.ads','.sidebar','.comments','.share','.social','.cookie','.popup','.modal','.newsletter','[aria-hidden="true"]'].forEach(sel => {
    try { clone.querySelectorAll(sel).forEach(n => n.remove()); } catch {}
  });

  const text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 15000);
  return { type: 'article', title: document.title, content: text, url };
}

// ── SUMMARY DISPLAY ───────────────────────────────────────────────────────────
function displaySummary(text, type) {
  lastSummaryText = text;

  const label = {
    'key-points': 'KEY POINTS',
    'tldr':       'TL;DR',
    'teaser':     'TEASER',
    'headline':   'HEADLINE'
  }[type] || 'SUMMARY';

  els.outputLabel.textContent = label;

  if (type === 'key-points') {
    const lines = text
      .split('\n')
      .map(l => l.replace(/^[-•*·]\s*/, '').trim())
      .filter(l => l.length > 5);

    if (lines.length > 1) {
      const ul = document.createElement('ul');
      lines.forEach(line => {
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
  text.split('\n').filter(l => l.trim()).forEach(line => {
    const p = document.createElement('p');
    p.textContent = line.trim();
    els.summaryBox.appendChild(p);
  });
}

// ── COPY TO CLIPBOARD ─────────────────────────────────────────────────────────
async function copyText() {
  if (!lastSummaryText) return;
  await navigator.clipboard.writeText(lastSummaryText);
  els.btnCopy.textContent = 'copied!';
  els.btnCopy.classList.add('copied');
  setTimeout(() => {
    els.btnCopy.textContent = 'copy';
    els.btnCopy.classList.remove('copied');
  }, 2000);
}

// ── UI HELPERS ────────────────────────────────────────────────────────────────
function setLoading(on) {
  els.loading.classList.toggle('visible', on);
  els.controls.style.opacity       = on ? '0.4' : '1';
  els.controls.style.pointerEvents = on ? 'none' : 'auto';
}

function setLoadingText(t) { els.loadingText.textContent = t; }
function showError(msg)     { els.errorText.textContent = msg; els.errorBox.classList.add('visible'); }
function hideError()        { els.errorBox.classList.remove('visible'); }
function hideOutput()       { els.output.classList.remove('visible'); }

init();
