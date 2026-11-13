'use strict';
/* Internal link suggestions (v2.2, beyond SF): for indexable pages with few
 * internal inlinks, find other crawled pages that mention the target's key
 * phrase in their text but do not link to it yet, and propose the phrase as
 * anchor text. Works on the stored text excerpt of each page. */
const STOP = new Set('a an and are as at be by for from has have how in is it its of on or our that the their this to was we what when where which who why will with you your about into more most not over than then them they us via vs best top new home page'.split(' '));

function words(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)); }

function keyPhrases(p) {
  const title = String(p.title || '').split(/\s[|–—-]\s/)[0]; // drop "| Brand"
  const src = [(p.h1s || [])[0] || '', title];
  const phrases = new Set();
  for (const s of src) {
    const w = words(s);
    for (let n = 3; n >= 2; n--) for (let i = 0; i + n <= w.length; i++) phrases.add(w.slice(i, i + n).join(' '));
    if (w.length === 1) phrases.add(w[0]);
  }
  return [...phrases].filter((x) => x.length >= 6).slice(0, 12);
}

function suggestLinks(pages, { maxInlinks = 3, perTarget = 5, limit = 200, target } = {}) {
  const html = pages.filter((p) => !p.external && !p.sitemapOnly && p.contentCategory === 'HTML' && p.statusCode === 200);
  const linksFrom = new Map(html.map((p) => [p.address, new Set((p.links || []).map((l) => l.url))]));
  const texts = new Map(html.map((p) => [p.address, ' ' + String(p.textExcerpt || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ') + ' ']));
  const targets = html.filter((p) => (target ? p.address === target : p.indexability === 'Indexable' && (p.uniqueInlinks || 0) <= maxInlinks));
  const out = [];
  for (const t of targets) {
    const phrases = keyPhrases(t);
    if (!phrases.length) continue;
    const found = [];
    for (const s of html) {
      if (s.address === t.address || linksFrom.get(s.address).has(t.address)) continue;
      const text = texts.get(s.address);
      let best = null;
      for (const ph of phrases) { const n = text.split(' ' + ph + ' ').length - 1; if (n > 0 && (!best || ph.length * n > best.score)) best = { anchor: ph, score: ph.length * n, mentions: n }; }
      if (best) found.push({ target: t.address, targetTitle: t.title || '', targetInlinks: t.uniqueInlinks || 0, source: s.address, sourceLinkScore: s.linkScore || 0, anchor: best.anchor, mentions: best.mentions, score: Math.round(best.score * (1 + (s.linkScore || 0) / 100)) });
    }
    found.sort((a, b) => b.score - a.score);
    out.push(...found.slice(0, perTarget));
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

module.exports = { suggestLinks, keyPhrases };
