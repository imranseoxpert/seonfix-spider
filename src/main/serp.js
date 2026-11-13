'use strict';
const { FILTER_META, buildFilterContext, applyFilters, summariseIssues } = require('./filters');
const { normalizeUrl, pixelWidth } = require('./urlutil');

/* SERP mode: no crawling. Each row (URL, Title, Description) is
 * measured for length and pixel width exactly like crawled pages, so the
 * Page Titles / Meta Description tabs, filters and SERP Snippet pane work. */
function parseSerpInput(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  const split = (l) => {
    if (l.includes('\t')) return l.split('\t');
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i]; if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out;
  };
  let rows = lines.map(split).map((r) => r.map((c) => c.trim()));
  if (rows.length && /^(url|address)$/i.test(rows[0][0] || '')) rows = rows.slice(1);
  return rows.filter((r) => r[0]).map((r) => ({ url: r[0], title: r[1] || '', description: r.slice(2).join(', ') }));
}
function serpAnalyse(text) {
  const rows = parseSerpInput(text);
  if (!rows.length) throw new Error('SERP mode needs at least one row: URL, Title, Description.');
  const pages = rows.map((r, i) => {
    const address = normalizeUrl(r.url) || r.url;
    const title = r.title.replace(/\s+/g, ' ').trim(); const desc = r.description.replace(/\s+/g, ' ').trim();
    return { address, serpOnly: true, isStartUrl: i === 0, contentType: 'text/html', contentCategory: 'HTML', statusCode: null, status: 'SERP Mode (not crawled)', indexability: '', indexabilityReason: '',
      title, titles: title ? [title] : [], titleLength: title.length, titlePixelWidth: pixelWidth(title),
      metaDescription: desc, metaDescriptions: desc ? [desc] : [], metaDescriptionLength: desc.length, metaDescriptionPixelWidth: pixelWidth(desc),
      h1s: [], h2s: [], links: [], images: [], resources: [], hreflang: [], structuredData: [], issues: [], depth: 0, external: false };
  });
  const ctx = buildFilterContext(pages, pages[0].address, {});
  applyFilters(pages, ctx);
  const keep = (p) => (p.filters || []).filter((id) => /^(title|desc)-/.test(id));
  for (const p of pages) p.filters = ['internal-all', 'internal-html', ...keep(p)];
  const issues = summariseIssues(pages).filter((i) => /^(title|desc)-/.test(i.filterId || ''));
  for (const p of pages) p.issues = issues.filter((i) => (p.filters || []).includes(i.filterId)).map((i) => i.name);
  return { app: 'Seonfix Spider', version: 2, mode: 'serp', startedAt: new Date().toISOString(), rootUrl: pages[0].address, pages, issues, filterMeta: FILTER_META,
    stats: { total: pages.length, crawled: 0, internal: pages.length, external: 0, indexable: 0, nonIndexable: 0, errors4xx: 0, errors5xx: 0, redirects: 0, durationMs: 0 },
    analysis: { summary: [{ label: 'Total URLs Encountered', count: pages.length }, { label: 'Total URLs Crawled', count: 0 }], responseTimes: { average: 0, buckets: [], sampled: 0 }, siteStructure: { rows: [], depthChart: [] }, segments: [], spelling: { pagesWithErrors: 0, totalErrors: 0, grammarErrors: 0 } } };
}

module.exports = { parseSerpInput, serpAnalyse };
