'use strict';
const test = require('node:test');
const assert = require('node:assert');
const u = require('../src/main/urlutil');

test('normalizeUrl: lowercases host, strips fragment and default port, sorts query', () => {
  assert.equal(u.normalizeUrl('HTTP://Example.COM:80/a//b?z=1&a=2#frag'), 'http://example.com/a/b?a=2&z=1');
  assert.equal(u.normalizeUrl('https://example.com:443/x'), 'https://example.com/x');
  assert.equal(u.normalizeUrl('mailto:a@b.com'), null);
  assert.equal(u.normalizeUrl('/rel', 'https://ex.com/dir/page'), 'https://ex.com/rel');
});

test('ensureUrl adds https scheme', () => {
  assert.equal(u.ensureUrl('example.com/path'), 'https://example.com/path');
});

test('shouldInclude honours include/exclude regex', () => {
  assert.equal(u.shouldInclude('https://ex.com/blog/a', { includePatterns: ['/blog/'], excludePatterns: [] }), true);
  assert.equal(u.shouldInclude('https://ex.com/shop/a', { includePatterns: ['/blog/'], excludePatterns: [] }), false);
  assert.equal(u.shouldInclude('https://ex.com/blog/a?x=1', { includePatterns: [], excludePatterns: ['\\?'] }), false);
});

test('pixelWidth grows with length and wide chars', () => {
  assert.ok(u.pixelWidth('WWWW') > u.pixelWidth('iiii'));
  assert.equal(u.pixelWidth(''), 0);
});

test('crawlDepthOf and directoryOf', () => {
  assert.equal(u.crawlDepthOf('https://ex.com/a/b/c', 'https://ex.com/'), 3);
  assert.equal(u.directoryOf('https://ex.com/a/b/c'), '/a/b/');
});
