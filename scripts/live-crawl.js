'use strict';
/* Real live crawl through the engine. Usage:
 *   node scripts/live-crawl.js [url] [maxUrls]
 * Defaults: https://mdimrankhan.com/ capped at 200 URLs (the site from the
 * user's Screaming Frog video; the video crawl found 140 URLs). */
const { Crawler } = require('../src/main/crawler');
(async () => {
  const url = process.argv[2] || 'https://mdimrankhan.com/';
  const maxUrls = Number(process.argv[3]) || 200;
  const started = Date.now();
  const crawler = new Crawler({ maxUrls, concurrency: 5, timeoutMs: 15000 });
  const crawl = await crawler.crawl([url], url);
  const s = crawl.stats;
  console.log(JSON.stringify({
    root: crawl.rootUrl,
    durationSec: Math.round((Date.now() - started) / 1000),
    stats: { total: s.total, crawled: s.crawled, internal: s.internal, external: s.external, indexable: s.indexable, nonIndexable: s.nonIndexable },
    statusMix: crawl.pages.reduce((a, p) => { const k = p.statusCode ? String(Math.floor(p.statusCode / 100)) + 'xx' : (p.status || 'none'); a[k] = (a[k] || 0) + 1; return a; }, {}),
    sitemaps: crawl.sitemaps,
    topIssues: crawl.issues.slice(0, 15).map((i) => ({ name: i.name, type: i.type, priority: i.priority, urls: i.count })),
    issueTotals: {
      issueTypes: crawl.issues.length,
      byType: crawl.issues.reduce((a, i) => { a[i.type] = (a[i.type] || 0) + 1; return a; }, {}),
    },
    summary: crawl.analysis.summary,
  }, null, 1));
})().catch((e) => { console.error('LIVE CRAWL FAILED', e); process.exit(1); });
