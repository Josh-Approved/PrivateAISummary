chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extractContent') {
    sendResponse(extractPageText());
  }
});

function extractPageText() {
  const selectors = ['article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content', '#content'];
  let el = null;
  for (const sel of selectors) {
    el = document.querySelector(sel);
    if (el) break;
  }
  if (!el) el = document.body;

  const clone = el.cloneNode(true);
  const noiseSelectors = [
    'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript',
    '.ad', '.ads', '.advertisement', '.sidebar', '.comments', '.related',
    '.share', '.social', '[aria-hidden="true"]', '.cookie', '.popup', '.modal', '.newsletter'
  ];
  noiseSelectors.forEach(sel => clone.querySelectorAll(sel).forEach(n => n.remove()));

  const text = clone.innerText || clone.textContent || '';
  return {
    type: 'page',
    title: document.title.trim(),
    content: text.replace(/\s+/g, ' ').trim().slice(0, 15000),
    url: window.location.href
  };
}
