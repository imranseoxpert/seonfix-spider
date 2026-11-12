'use strict';
/* Real live crawl smoke: crawls https://example.com through the real engine. */
const { Crawler } = require('../src/main/crawler');
(async () => {
  const crawler = new Crawler({ maxUrls: 10, concurrency: 3 });
  const crawl = await crawler.crawl(['https://example.com/'], 'https://example.com/');
  console.log(JSON.stringify({
    root: crawl.rootUrl, stats: crawl.stats,
    pages: crawl.pages.map((p) => ({ address: p.address, status: p.statusCode, title: p.title || '', indexability: p.indexability || '', issues: (p.issues || []).length })),
    issueSummary: crawl.issues.slice(0, 10),
  }, null, 1));
})().catch((e) => { console.error('LIVE CRAWL FAILED', e); process.exit(1); });
