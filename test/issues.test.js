'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildContext, issuesForPage, summarise } = require('../src/main/issues');
const { analyseChain } = require('../src/main/crawler');

function page(over = {}) {
  // v2: a "clean" page must also carry response headers (security-header
  // issues are real SF checks) and internal outlinks (Links checks).
  return { address: 'https://ex.com/', statusCode: 200, contentType: 'text/html', title: 'A perfectly fine title of good length', titleLength: 38, titlePixelWidth: 300, metaDescription: 'x'.repeat(100), metaDescriptionLength: 100, h1s: ['Heading'], h2s: ['Sub'], canonical: 'https://ex.com/', canonicals: ['https://ex.com/'], wordCount: 500, images: [], hreflang: [], indexability: 'Indexable', uniqueInlinks: 3, internalOutlinks: 2, headers: { 'strict-transport-security': 'max-age=31536000', 'content-security-policy': "default-src 'self'", 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' }, ...over };
}

test('clean page has no issues', () => {
  const p = page();
  const ctx = buildContext([p]); ctx.byUrl = new Map([[p.address, p]]);
  assert.deepEqual(issuesForPage(p, ctx), []);
});

test('missing title, duplicate desc, 4xx rules fire', () => {
  const a = page({ title: '', titleLength: 0 });
  const b = page({ address: 'https://ex.com/b' });
  const c = page({ address: 'https://ex.com/c', statusCode: 404 });
  const ctx = buildContext([a, b, c]);
  assert.ok(issuesForPage(a, ctx).includes('Page Titles: Missing')); // v2: SF plural naming
  assert.ok(issuesForPage(b, ctx).includes('Meta Description: Duplicate'));
  assert.ok(issuesForPage(c, ctx).includes('Client Error (4xx)'));
  const s = summarise([a, b, c], ctx);
  assert.ok(s.find((i) => i.name === 'Client Error (4xx)').count === 1);
});

test('redirect chain analysis detects loops', () => {
  assert.equal(analyseChain([{ from: 'a', to: 'b', status: 301 }, { from: 'b', to: 'a', status: 301 }]).isLoop, true);
  assert.equal(analyseChain([{ from: 'a', to: 'b', status: 301 }]).isChain, false);
  assert.equal(analyseChain([{ from: 'a', to: 'b', status: 301 }, { from: 'b', to: 'c', status: 301 }]).isChain, true);
});

test('noindex and canonicalised rules', () => {
  const p = page({ metaRobots: 'noindex, follow', directives: ['noindex', 'follow'], canonical: 'https://ex.com/other' }); // v2: extract() exposes parsed `directives` tokens
  const ctx = buildContext([p]);
  const iss = issuesForPage(p, ctx);
  assert.ok(iss.includes('Directives: Noindex')); // v2: SF section-prefixed naming
  assert.ok(iss.includes('Canonicals: Canonicalised'));
});
