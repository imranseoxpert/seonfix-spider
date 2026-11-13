'use strict';
/* v2.1 feature tests: grammar rules, accessibility checks, link positions,
 * content area, Spider > Crawl options (nofollow, canonicals, iframes,
 * resource types), Web Form login, SERP mode, per-filter Compare, issue
 * How To Fix coverage, Overview sections for every tab, Meta Keywords removed. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const cheerio = require('cheerio');
const { checkGrammar } = require('../src/main/grammar');
const { checkAccessibility } = require('../src/main/accessibility');
const { parsePage } = require('../src/main/extract');
const { Crawler, compareCrawls } = require('../src/main/crawler');
const { serpAnalyse, parseSerpInput } = require('../src/main/serp');
const { ISSUES, FILTER_META, FILTERS } = require('../src/main/filters');
const { SF_TABS } = require('../src/renderer/ui-data');

const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima '.repeat(6);

test('grammar rules catch common mistakes and leave clean text alone', () => {
  const bad = checkGrammar('We saw a apple and an banana. the end came. It could of worked,maybe not. Go to to the shop.');
  const rules = bad.matches.map((m) => m.rule);
  assert.ok(rules.some((r) => /"an"/.test(r)), 'a apple');
  assert.ok(rules.some((r) => /"a" before/.test(r)), 'an banana');
  assert.ok(rules.some((r) => /lowercase/.test(r)), 'lowercase sentence start');
  assert.ok(rules.some((r) => /could have/.test(r)), 'could of');
  assert.ok(rules.some((r) => /Missing space/.test(r)), 'missing space');
  assert.ok(rules.some((r) => /Repeated/.test(r)), 'to to');
  const good = checkGrammar('An hour later a user opened an issue. It was a one-off. The team fixed it, e.g. by testing.');
  assert.strictEqual(good.errors, 0, JSON.stringify(good.matches));
});

test('accessibility checks flag missing lang, unlabeled fields, empty links and zoom lock', () => {
  const $ = cheerio.load(`<html><head><title>T</title><meta name="viewport" content="width=device-width, user-scalable=no"></head><body>
    <a href="/x"></a><a href="/y" aria-label="Y">  </a><button></button><input type="text" name="q"><label for="e">Email</label><input id="e">
    <img src="/a.png"><div id="d"></div><div id="d"></div><h2></h2><iframe src="/f"></iframe><span tabindex="3">x</span></body></html>`);
  const r = checkAccessibility($);
  assert.strictEqual(r.checks['html-lang'].count, 1);
  assert.strictEqual(r.checks['link-name'].count, 1, 'only the empty link without aria-label');
  assert.strictEqual(r.checks['button-name'].count, 1);
  assert.strictEqual(r.checks.label.count, 1, 'labelled #e is fine, q is not');
  assert.strictEqual(r.checks['image-alt'].count, 1);
  assert.strictEqual(r.checks['duplicate-id'].count, 1);
  assert.strictEqual(r.checks['empty-heading'].count, 1);
  assert.strictEqual(r.checks['frame-title'].count, 1);
  assert.strictEqual(r.checks['meta-viewport'].count, 1);
  assert.strictEqual(r.checks.tabindex.count, 1);
  const clean = checkAccessibility(cheerio.load('<html lang="en"><head><title>Ok</title></head><body><h1>Hi</h1><a href="/">Home</a></body></html>'));
  assert.strictEqual(clean.violations, 0, JSON.stringify(clean.checks));
});

test('link positions, content area and Meta Keywords removal in parsePage', () => {
  const html = `<html lang="en"><head><title>T</title><meta name="keywords" content="a,b"></head><body>
    <header><a href="/h">H</a></header><nav><a href="/n">N</a></nav><div class="sidebar"><a href="/s">S</a></div>
    <main><p>${WORDS}</p><a href="/c">C</a><div class="promo-box"><a href="/p">P</a></div></main><footer><a href="/f">F</a> footer words here</footer></body></html>`;
  const p = parsePage({ url: 'https://ex.com/', html, linkPositions: [{ name: 'Promo', pattern: 'promo-box' }] });
  const pos = Object.fromEntries(p.links.map((l) => [new URL(l.url).pathname, l.position]));
  assert.deepStrictEqual(pos, { '/h': 'Header', '/n': 'Navigation', '/s': 'Sidebar', '/c': 'Content', '/p': 'Promo', '/f': 'Footer' });
  assert.ok(!/footer words/.test(p.textExcerpt), 'footer excluded from content area by default');
  const all = parsePage({ url: 'https://ex.com/', html, contentArea: { include: [], exclude: [] } });
  assert.ok(/footer words/.test(all.textExcerpt) && all.wordCount > p.wordCount);
  const onlyMain = parsePage({ url: 'https://ex.com/', html, contentArea: { include: ['main'], exclude: [] } });
  assert.ok(onlyMain.wordCount < all.wordCount && onlyMain.textExcerpt.startsWith('alpha'));
  assert.ok(!('metaKeywords' in p) && !('metaKeywordsLength' in p), 'meta keywords are not collected');
  assert.ok(!('rawHtml' in p));
  assert.ok(parsePage({ url: 'https://ex.com/', html, storeHtml: true }).rawHtml.includes('<main>'));
});

function server(routes) {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const r = routes[req.method + ' ' + u.pathname] || routes[u.pathname];
    if (!r) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<title>404</title>'); }
    return r(req, res);
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}
const html = (body, head = '') => (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<html><head><title>Fixture page title here</title>${head}</head><body><p>${WORDS}</p>${body}</body></html>`); };

test('Spider > Crawl options: nofollow, canonicals, iframes and resource types', async () => {
  const s = await server({
    '/': html('<a href="/nf" rel="nofollow">nf</a><a href="/ok">ok</a><iframe src="/frame"></iframe><img src="/i.png"><script src="/a.js"></script><link rel="stylesheet" href="/s.css">', '<link rel="canonical" href="/canon">'),
    '/nf': html(''), '/ok': html(''), '/frame': html(''), '/canon': html(''),
    '/i.png': (q, r) => { r.writeHead(200, { 'Content-Type': 'image/png' }); r.end('x'); },
    '/a.js': (q, r) => { r.writeHead(200, { 'Content-Type': 'application/javascript' }); r.end('1'); },
    '/s.css': (q, r) => { r.writeHead(200, { 'Content-Type': 'text/css' }); r.end('a{}'); },
  });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    const paths = (cr) => cr.pages.filter((p) => !p.sitemapOnly).map((p) => new URL(p.address).pathname).sort();
    const def = await new Crawler({ respectRobots: false, crawlExternal: false }).crawl([base + '/'], base + '/');
    assert.deepStrictEqual(paths(def), ['/', '/a.js', '/canon', '/frame', '/i.png', '/ok', '/s.css'], 'SF defaults: nofollow not followed, canonical + iframe crawled');
    const opt = await new Crawler({ respectRobots: false, crawlExternal: false, followInternalNofollow: true, crawlCanonicals: false, crawlIframes: false, crawlImages: false, crawlJs: false, checkImageSizes: false }).crawl([base + '/'], base + '/');
    assert.deepStrictEqual(paths(opt), ['/', '/nf', '/ok', '/s.css']);
  } finally { s.close(); }
});

test('Web Form login posts the form with hidden fields and reuses the session cookie', async () => {
  let posted = null;
  const s = await server({
    'GET /login': html('<form method="post" action="/do-login"><input type="hidden" name="csrf" value="tok123"><input type="email" name="email"><input type="password" name="pwd"><button>Go</button></form>'),
    'POST /do-login': (req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { posted = Object.fromEntries(new URLSearchParams(b)); res.writeHead(302, { Location: '/', 'Set-Cookie': 'sess=abc; Path=/; HttpOnly' }); res.end(); }); },
    '/': (req, res) => {
      if (!/sess=abc/.test(req.headers.cookie || '')) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return html('<a href="/members">m</a>')(req, res);
    },
    '/members': (req, res) => html('')(req, res),
  });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    const cr = await new Crawler({ respectRobots: false, crawlExternal: false, formAuth: { url: base + '/login', username: 'me@ex.com', password: 'secret' } }).crawl([base + '/'], base + '/');
    assert.deepStrictEqual(posted, { csrf: 'tok123', email: 'me@ex.com', pwd: 'secret' });
    const home = cr.pages.find((p) => p.address === base + '/');
    assert.strictEqual(home.statusCode, 200, 'home served with the session cookie');
    assert.ok(cr.pages.some((p) => p.address === base + '/members' && p.statusCode === 200));
    assert.ok(cr.login && cr.login.cookies === 1);
  } finally { s.close(); }
});

test('SERP mode measures titles and descriptions without crawling', () => {
  assert.deepStrictEqual(parseSerpInput('url\ttitle\tdescription\nhttps://a.com/\tA "quoted" title\tDesc'), [{ url: 'https://a.com/', title: 'A "quoted" title', description: 'Desc' }]);
  const cr = serpAnalyse('URL,Title,Description\nhttps://a.com/x,"Short, title",Too short\nhttps://a.com/y,' + 'Long '.repeat(20) + ',' + 'word '.repeat(50));
  assert.strictEqual(cr.mode, 'serp');
  const [a, b] = cr.pages;
  assert.strictEqual(a.title, 'Short, title');
  assert.ok(a.filters.includes('title-below-30') && a.filters.includes('desc-below-70'));
  assert.ok(b.filters.includes('title-over-60') && b.filters.includes('title-over-580px') && b.filters.includes('desc-over-155'));
  assert.ok(cr.issues.every((i) => /^(title|desc)-/.test(i.filterId)));
  assert.throws(() => serpAnalyse(''), /at least one row/);
});

test('Compare mode splits each filter into Added / New / Removed / Missing', () => {
  const prev = { pages: [{ address: 'u1', filters: ['title-missing'] }, { address: 'u2', filters: [] }, { address: 'u3', filters: ['title-missing'] }, { address: 'u4', filters: ['title-missing'] }], issues: [] };
  const cur = { pages: [{ address: 'u1', filters: ['title-missing'] }, { address: 'u2', filters: ['title-missing'] }, { address: 'u3', filters: [] }, { address: 'u5', filters: ['title-missing'] }], issues: [] };
  const d = compareCrawls(prev, cur).filterDeltas.find((f) => f.id === 'title-missing');
  assert.strictEqual(d.current, 3); assert.strictEqual(d.previous, 3);
  assert.deepStrictEqual(d.added, ['u2']); assert.deepStrictEqual(d.newUrls, ['u5']);
  assert.deepStrictEqual(d.removed, ['u3']); assert.deepStrictEqual(d.missing, ['u4']);
});

test('every issue has a description and How To Fix; every tab has an Overview section', () => {
  for (const i of ISSUES) {
    assert.ok(i.description && i.description.length > 20, i.id + ' description');
    assert.ok(i.howToFix && i.howToFix.length > 20, i.id + ' howToFix');
    if (i.filterId) assert.ok(FILTERS.some((f) => f.id === i.filterId), i.id + ' filter exists');
  }
  const tabsWithSections = new Set(FILTER_META.map((f) => f.tab));
  for (const t of SF_TABS) assert.ok(tabsWithSections.has(t.id), `tab ${t.id} has an Overview section`);
  assert.ok(!SF_TABS.some((t) => /keyword/i.test(t.label)) && !FILTER_META.some((f) => /keyword/i.test(f.section + f.name)));
});
