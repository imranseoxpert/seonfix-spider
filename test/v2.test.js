'use strict';
/* v2 tests: filter registry vs independent predicates, scopes, security,
 * URL/content checks, Link Score, segments, response times, site structure,
 * spelling, issue type/priority completeness, Meta Keywords removal. */
const test = require('node:test');
const assert = require('node:assert');
const { finalizeCrawl } = require('../src/main/crawler');
const { FILTERS, FILTER_META } = require('../src/main/filters');
const { classifyInternal } = require('../src/main/urlutil');
const { parsePage } = require('../src/main/extract');
const { countSpellingErrors } = require('../src/main/spelling');
const { SF_TABS } = require('../src/renderer/ui-data');

const ROOT = 'https://site.test/';
const ALL_SEC_HEADERS = ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy'];
function pg(address, over = {}) {
  return {
    address, statusCode: 200, status: 'Success', contentType: 'text/html; charset=utf-8', contentCategory: 'HTML',
    title: 'A perfectly reasonable page title here', titleLength: 38, titlePixelWidth: 300,
    metaDescription: 'A unique description for ' + address, metaDescriptionLength: 60,
    h1s: ['Heading One'], h2s: [], canonical: address, canonicals: [address], wordCount: 400,
    images: [], links: [], resources: [], hreflang: [], headers: {}, missingSecurityHeaders: [], depth: 1,
    responseTimeMs: 300, sizeBytes: 5000, cookies: [], structuredData: [], sdItems: [], extractions: {}, searchMatches: {},
    ...over,
  };
}
function fixture() {
  const L = (url, anchor, external = false) => ({ url, anchor, external, follow: true, type: 'Hyperlink' });
  const home = pg(ROOT, {
    title: 'Fixture home page title for testing', responseTimeMs: 500, depth: 0,
    links: [L(ROOT + 'a', 'Page A'), L(ROOT + 'a', 'click here'), L(ROOT + 'b', 'Page B'), L('https://other.test/x', 'External Site', true)],
  });
  const pages = [
    home,
    pg(ROOT + 'a', { metaDescription: '', metaDescriptionLength: 0, links: [L(ROOT, 'Home')] }),
    pg(ROOT + 'b', { title: 'Shared duplicate title for two pages', links: [L(ROOT, 'Home')] }),
    pg(ROOT + 'dup', { title: 'Shared duplicate title for two pages' }),
    pg(ROOT + 'notitle', { title: '', titleLength: 0 }),
    pg(ROOT + 'soft', { title: '404 Not Found', soft404: true, wordCount: 12 }),
    pg(ROOT + 'lorem', { loremIpsum: true }),
    pg(ROOT + 'hard-read', { flesch: 22, readability: 'Difficult' }),
    pg(ROOT + 'deep/1/2/3/4', { depth: 5 }), // click-depth as a real crawl records it
    pg(ROOT + 'blog/post', {}),
    pg(ROOT + 'UPPER_case', {}),
    pg(ROOT + 'under_score', {}),
    pg(ROOT + 'a//b', {}),
    pg(ROOT + 'page?utm_source=google&id=3', {}),
    pg(ROOT + 'noheaders', { missingSecurityHeaders: [...ALL_SEC_HEADERS] }),
    pg(ROOT + 'slow', { responseTimeMs: 2600 }),
    pg(ROOT + 'gone', { statusCode: 404, status: 'Client Error' }),
    pg('http://site.test/plain-http', {}),
    { address: 'https://other.test/x', external: true, statusCode: 200, status: 'Success', contentType: 'text/html', contentCategory: 'HTML', responseTimeMs: 120, links: [], images: [], hreflang: [], headers: {}, cookies: [] },
  ];
  const config = { scope: 'subdomain', duplicatesThreshold: 0.92, segments: [{ name: 'Blog', pattern: '/blog/' }] };
  const fin = finalizeCrawl(pages, ROOT, config);
  return { pages, issues: fin.issues, analysis: fin.analysis, stats: fin.stats };
}
const has = (fin, addr, filterId) => { const p = fin.pages.find((x) => x.address === addr); return !!p && (p.filters || []).includes(filterId); };
const count = (fin, filterId) => fin.pages.filter((p) => (p.filters || []).includes(filterId)).length;

test('filter registry: counts match independent predicates (14 filters)', () => {
  const fin = fixture(); const crawl = fin;
  const pages = crawl.pages;
  const isHtml200 = (p) => p.contentCategory === 'HTML' && p.statusCode >= 200 && p.statusCode < 300;
  const checks = {
    'title-missing': (p) => isHtml200(p) && !p.title,
    'desc-missing': (p) => isHtml200(p) && !p.metaDescription,
    'title-duplicate': (p) => !!p.title && pages.filter((q) => q.title && q.title.toLowerCase() === p.title.toLowerCase()).length > 1,
    'sec-hsts': (p) => /^https:/i.test(p.address) && p.statusCode > 0 && (p.missingSecurityHeaders || []).includes('strict-transport-security'),
    'url-uppercase': (p) => /[A-Z]/.test(new URL(p.address).pathname),
    'url-underscores': (p) => new URL(p.address).pathname.includes('_'),
    'url-multiple-slashes': (p) => new URL(p.address).pathname.includes('//'),
    'url-ga-params': (p) => /[?&](utm_|gclid|fbclid|mc_eid|_ga)/.test(p.address),
    'url-parameters': (p) => p.address.includes('?'),
    'content-soft-404': (p) => !!p.soft404,
    'content-lorem': (p) => !!p.loremIpsum,
    'content-read-difficult': (p) => p.readability === 'Difficult',
    'rc-4xx': (p) => p.statusCode >= 400 && p.statusCode < 500,
    'links-nondesc-anchor': (p) => (p.links || []).some((l) => !l.external && /^(click here|here|this|link|read more|learn more)$/i.test((l.anchor || '').trim())),
  };
  assert.ok(Object.keys(checks).length >= 12);
  for (const [id, pred] of Object.entries(checks)) {
    assert.ok(FILTERS.some((f) => f.id === id), `filter ${id} exists in registry`);
    assert.equal(count(crawl, id), pages.filter(pred).length, `count mismatch for ${id}`);
  }
  assert.ok(has(crawl, ROOT + 'a', 'desc-missing'));
  assert.ok(has(crawl, ROOT + 'notitle', 'title-missing'));
  assert.ok(has(crawl, ROOT + 'b', 'title-duplicate') && has(crawl, ROOT + 'dup', 'title-duplicate'));
  assert.ok(has(crawl, ROOT + 'noheaders', 'sec-hsts'));
  assert.ok(has(crawl, ROOT, 'links-nondesc-anchor'));
  assert.ok(has(crawl, ROOT + 'deep/1/2/3/4', 'links-high-depth'));
  assert.ok(has(crawl, 'http://site.test/plain-http', 'sec-http'));
  assert.ok(has(crawl, ROOT + 'gone', 'rc-4xx'));
});

test('scope classification: all four scopes', () => {
  const root = 'https://www.site.com/blog/post';
  assert.equal(classifyInternal('https://www.site.com/x', root, 'subdomain'), true);
  assert.equal(classifyInternal('https://site.com/x', root, 'subdomain'), true);
  assert.equal(classifyInternal('https://blog.site.com/x', root, 'subdomain'), false);
  assert.equal(classifyInternal('https://other.com/x', root, 'subdomain'), false);
  assert.equal(classifyInternal('https://site.com/blog/x', 'https://site.com/blog/', 'subfolder'), true);
  assert.equal(classifyInternal('https://site.com/other', 'https://site.com/blog/', 'subfolder'), false);
  assert.equal(classifyInternal('https://blog.site.com/x', 'https://site.com/', 'all-subdomains'), true);
  assert.equal(classifyInternal('https://deep.blog.site.com/x', 'https://site.com/', 'all-subdomains'), true);
  assert.equal(classifyInternal('https://notsite.com/x', 'https://site.com/', 'all-subdomains'), false);
  assert.equal(classifyInternal('https://site.com/only', 'https://site.com/only', 'exact'), true);
  assert.equal(classifyInternal('https://site.com/', 'https://site.com/only', 'exact'), false);
});

test('Link Score: homepage ranks highest on the fixture', () => {
  const fin = fixture(); const crawl = fin;
  const internal = crawl.pages.filter((p) => !p.external && p.contentCategory === 'HTML' && typeof p.linkScore === 'number');
  const home = crawl.pages.find((p) => p.address === ROOT);
  assert.ok(internal.length >= 5);
  for (const p of internal) assert.ok(home.linkScore >= p.linkScore, `home ${home.linkScore} >= ${p.address} ${p.linkScore}`);
  assert.ok(home.linkScore > 0);
});

test('segments, response times and site structure analysis', () => {
  const { analysis } = fixture();
  const blog = analysis.segments.find((s) => s.name === 'Blog');
  assert.ok(blog && blog.urls === 1, 'blog segment has 1 URL');
  const totalBuckets = analysis.responseTimes.buckets.reduce((a, b) => a + b.count, 0);
  assert.ok(totalBuckets >= 15, `buckets cover pages (${totalBuckets})`);
  assert.ok(analysis.responseTimes.average > 0);
  const rootSeg = analysis.siteStructure.rows.find((s) => s.urls >= 15);
  assert.ok(rootSeg, 'a host-root segment aggregates the crawl');
  const depth5 = analysis.siteStructure.depthChart.find((d) => d.depth === 5);
  assert.ok(depth5 && depth5.total >= 1, 'depth 5 present in chart data');
});

test('every issue carries a type and a priority; chips sum to total', () => {
  const fin = fixture(); const crawl = fin;
  assert.ok(crawl.issues.length >= 8, `fixture produces issues (${crawl.issues.length})`);
  for (const i of crawl.issues) {
    assert.ok(['Issue', 'Warning', 'Opportunity'].includes(i.type), `${i.name} type`);
    assert.ok(['High', 'Medium', 'Low'].includes(i.priority), `${i.name} priority`);
    assert.ok(i.count >= 1 && i.description && i.description.length > 10, `${i.name} described`);
  }
  const byType = ['Issue', 'Warning', 'Opportunity'].reduce((a, t) => a + crawl.issues.filter((i) => i.type === t).length, 0);
  assert.equal(byType, crawl.issues.length, 'chips sum to total');
});

test('content metrics from extraction: soft 404, lorem, spelling', () => {
  const soft = parsePage({ url: 'https://x.test/missing', html: '<html><head><title>404 Not Found</title></head><body><p>short</p></body></html>', statusCode: 200 });
  assert.equal(soft.soft404, true);
  const lorem = parsePage({ url: 'https://x.test/l', html: '<html><head><title>Lorem Page With A Decent Title</title></head><body><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim.</p></body></html>', statusCode: 200 });
  assert.equal(lorem.loremIpsum, true);
  assert.ok(typeof lorem.flesch === 'number');
  const spell = parsePage({ url: 'https://x.test/s', html: '<html><head><title>Spelling Test Page Title Here</title></head><body><p>Teh quik brown fox recieve teh adress wrongly today.</p></body></html>', statusCode: 200, spellCheck: true });
  assert.ok(spell.spellingErrors >= 3, `spelling errors found (${spell.spellingErrors}: ${(spell.spellingUnknown || []).join(',')})`);
  assert.ok(spell.spellingUnknown.includes('teh'));
  const clean = countSpellingErrors('The quick brown fox jumps over the lazy dog near the river bank today.');
  assert.equal(clean.errors, 0, `clean sentence flagged: ${clean.unknown.join(',')}`);
  const dirty = countSpellingErrors('Teh recieve adress seperate occured goverment');
  assert.ok(dirty.errors >= 5, `dirty count ${dirty.errors}`);
});

test('Meta Keywords tab and filters are removed (user request)', () => {
  assert.ok(!SF_TABS.some((t) => /meta keywords/i.test(t.label)), 'no Meta Keywords tab');
  assert.equal(SF_TABS.length, 27, 'tab bar has 27 tabs');
  assert.ok(!FILTER_META.some((f) => /meta keywords/i.test(f.section)), 'no Meta Keywords sidebar section');
  assert.ok(!FILTERS.some((f) => /meta keywords/i.test(f.section)), 'no meta keyword filters');
});
