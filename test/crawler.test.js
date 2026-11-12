'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Crawler } = require('../src/main/crawler');

const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu '.repeat(3);
function page(title, body, extraHead = '') {
  return `<html><head>${title ? `<title>${title}</title>` : ''}<meta name="description" content="Fixture description long enough to not be short at all really yes">${extraHead}</head><body>${body}</body></html>`;
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function buildServer() {
  const routes = {
    '/': () => page('Home Fixture Page Title For Testing', `
      <h1>Home</h1><p>${WORDS}</p>
      <a href="/a">A</a><a href="/b">B</a><a href="/dup1">D1</a><a href="/dup2">D2</a>
      <a href="/missing-title">MT</a><a href="/noindex">NI</a><a href="/redirect1">R</a>
      <a href="/chain1">CH</a><a href="/loop1">L</a><a href="/missing">404</a>
      <a href="/private/blocked">P</a><a href="/hreflang">H</a><a href="/hreflang-b">HB</a>
      <a href="http://example.org/external-page">External</a>
      <img src="/img.png" alt="A picture"><img src="/noalt.png">`),
    '/a': () => page('Page A Unique Title For Testing', `<h1>A</h1><p>${WORDS}</p><a href="/">Home</a>`),
    '/b': () => page('Page B Unique Title For Testing', `<h1>B</h1><p>${WORDS} extra unique words about bicycles and mountains</p><a href="/">Home</a>`),
    '/dup1': () => page('Identical Twin Title For Fixture Pages', `<h1>Twin</h1><p>${WORDS}</p><a href="/">Home</a>`),
    '/dup2': () => page('Identical Twin Title For Fixture Pages', `<h1>Twin</h1><p>${WORDS.replace('alpha', 'omega')}</p><a href="/">Home</a>`),
    '/missing-title': () => page('', `<h1>No title here</h1><p>${WORDS}</p><a href="/">Home</a>`),
    '/noindex': () => page('Noindex Fixture Page Title Here', `<h1>NI</h1><p>${WORDS}</p><a href="/">Home</a>`, '<meta name="robots" content="noindex, follow">'),
    '/target': () => page('Redirect Target Page Title Here', `<h1>Target</h1><p>${WORDS}</p>`),
    '/hreflang': () => page('Hreflang Fixture Page Title Here', `<h1>H</h1><p>${WORDS}</p><a href="/">Home</a>`,
      '<link rel="alternate" hreflang="english" href="/hreflang-b"><link rel="alternate" hreflang="fr" href="/hreflang-b">'),
    '/hreflang-b': () => page('Hreflang B Fixture Page Title', `<h1>HB</h1><p>${WORDS}</p><a href="/">Home</a>`),
    '/private/blocked': () => page('Blocked Fixture Page', `<h1>Blocked</h1><p>${WORDS}</p>`),
  };
  return http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /private/\n'); }
    if (path === '/img.png' || path === '/noalt.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    if (path === '/redirect1') { res.writeHead(301, { Location: '/target' }); return res.end(); }
    if (path === '/chain1') { res.writeHead(301, { Location: '/chain2' }); return res.end(); }
    if (path === '/chain2') { res.writeHead(301, { Location: '/a' }); return res.end(); }
    if (path === '/loop1') { res.writeHead(301, { Location: '/loop2' }); return res.end(); }
    if (path === '/loop2') { res.writeHead(301, { Location: '/loop1' }); return res.end(); }
    if (routes[path]) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(routes[path]()); }
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(page('Not Found', '<h1>404</h1>'));
  });
}

test('crawler integration: fixture site audit matches expectations', async () => {
  const server = buildServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    const crawler = new Crawler({ concurrency: 5, maxUrls: 500 });
    const crawl = await crawler.crawl([base], base);
    const by = new Map(crawl.pages.map((p) => [p.address, p]));
    const at = (path) => by.get(base.replace(/\/$/, '') + path) || by.get(new URL(path, base).toString());

    assert.ok(crawl.stats.crawled >= 14, `expected >=14 crawled, got ${crawl.stats.crawled}`);
    assert.equal(at('/missing').statusCode, 404);
    assert.ok(at('/missing').issues.includes('Client Error (4xx)'));
    assert.equal(at('/redirect1').statusCode, 301);
    assert.ok(at('/redirect1').redirectUrl.endsWith('/target'));
    assert.equal(at('/chain1').redirectChain.length, 2);
    assert.ok(at('/chain1').issues.includes('Redirect Chain'));
    assert.equal(at('/loop1').redirectLoop, true);
    assert.ok(at('/loop1').issues.includes('Redirect Loop'));
    assert.equal(at('/noindex').indexability, 'Non-Indexable');
    assert.equal(at('/noindex').indexabilityReason, 'Noindex');
    assert.ok(at('/missing-title').issues.includes('Page Title: Missing'));
    assert.ok(at('/dup1').issues.includes('Page Title: Duplicate'));
    assert.ok(at('/dup2').issues.includes('Near Duplicate Content') || at('/dup2').nearDuplicateOf, 'near duplicate flagged');
    assert.ok(at('/').issues.includes('Images: Missing Alt Text'));
    assert.equal(at('/private/blocked').status, 'Blocked by robots.txt');
    assert.ok(at('/hreflang').issues.some((i) => i.startsWith('hreflang:')), 'hreflang issue flagged');
    assert.ok(at('/target').issues.includes('Orphan Pages (No Inlinks)'), 'redirect target is orphan');
    const ext = crawl.pages.find((p) => p.external);
    assert.ok(ext && ext.address.includes('example.org'), 'external stub recorded');
    assert.ok(at('/a').uniqueInlinks >= 1);
    assert.ok(crawl.issues.length >= 8, `issues summary has ${crawl.issues.length} entries`);
  } finally {
    server.close();
  }
});

test('list mode audits only the given URLs', async () => {
  const server = buildServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const crawler = new Crawler({ mode: 'list', maxUrls: 50 });
    const crawl = await crawler.crawl([base + '/a', base + '/b'], base + '/a');
    const urls = crawl.pages.filter((p) => !p.external).map((p) => p.address);
    assert.deepEqual(urls.sort(), [base + '/a', base + '/b'].sort());
  } finally { server.close(); }
});
