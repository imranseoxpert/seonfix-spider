'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parsePage, md5, simhash, simhashSimilarity, applyExtractors, xpathToCss } = require('../src/main/extract');
const cheerio = require('cheerio');

const HTML = `<html><head>
<title>Test Page Title Here</title>
<meta name="description" content="A description">
<meta name="keywords" content="a,b">
<link rel="canonical" href="/self">
<link rel="alternate" hreflang="en" href="/en">
<link rel="next" href="/p2">
<script type="application/ld+json">{"@type":"Article","headline":"x"}</script>
</head><body>
<h1>Main Heading</h1><h2>Sub One</h2><h2>Sub Two</h2>
<a href="/a">A page</a> <a href="https://other.com/x" rel="nofollow">Ext</a>
<img src="/i.png" alt="pic" width="10" height="10"><img src="/j.png">
<p>${'word '.repeat(50)}</p>
<span class="price">$42</span>
</body></html>`;

test('parsePage extracts core fields', () => {
  const p = parsePage({ url: 'https://ex.com/self', html: HTML, headers: {}, statusCode: 200 });
  assert.equal(p.title, 'Test Page Title Here');
  assert.equal(p.metaDescription, 'A description');
  assert.deepEqual(p.h1s, ['Main Heading']);
  assert.equal(p.h2s.length, 2);
  assert.equal(p.canonical, 'https://ex.com/self');
  assert.equal(p.hreflang.length, 1);
  assert.equal(p.pagination.next, 'https://ex.com/p2');
  assert.deepEqual(p.structuredData, ['Article']);
  assert.equal(p.images.length, 2);
  assert.equal(p.images[1].hasAlt, false);
  assert.ok(p.wordCount >= 50);
  assert.equal(p.links.length, 2);
});

test('md5 stable and simhash similarity high for near-identical text', () => {
  assert.equal(md5('abc'), md5('abc'));
  const a = simhash('the quick brown fox jumps over the lazy dog again and again today');
  const b = simhash('the quick brown fox jumps over the lazy dog again and again tomorrow');
  assert.ok(simhashSimilarity(a.toString(), b.toString()) > 0.8);
  const c = simhash('completely unrelated content about cooking recipes and ingredients list');
  assert.ok(simhashSimilarity(a.toString(), c.toString()) < simhashSimilarity(a.toString(), b.toString()));
});

test('custom extraction CSS + regex', () => {
  const $ = cheerio.load(HTML);
  const out = applyExtractors($, HTML, [
    { name: 'Price', type: 'css', value: '.price' },
    { name: 'TitleTag', type: 'regex', value: '<title>(.*?)</title>' },
  ]);
  assert.equal(out.Price, '$42');
  assert.equal(out.TitleTag, 'Test Page Title Here');
});

test('xpathToCss subset', () => {
  assert.equal(xpathToCss("//meta[@name='description']"), 'meta[name="description"]');
  assert.equal(xpathToCss('//h1'), 'h1');
  assert.equal(xpathToCss('//div/a[2]'), null);
});
