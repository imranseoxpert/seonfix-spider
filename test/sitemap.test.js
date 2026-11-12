'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseSitemap, generateSitemap, generateImageSitemap, compareCrawls } = require('../src/main/crawler');

test('parseSitemap extracts locs', () => {
  const xml = `<?xml version="1.0"?><urlset><url><loc>https://ex.com/a</loc></url><url><loc>https://ex.com/b?x=1&amp;y=2</loc></url></urlset>`;
  assert.deepEqual(parseSitemap(xml), ['https://ex.com/a', 'https://ex.com/b?x=1&y=2']);
});

test('generateSitemap includes only indexable 200 pages', () => {
  const pages = [
    { address: 'https://ex.com/a', statusCode: 200, indexability: 'Indexable', images: [] },
    { address: 'https://ex.com/b', statusCode: 404, indexability: 'Non-Indexable', images: [] },
    { address: 'https://ex.com/c', statusCode: 200, indexability: 'Non-Indexable', images: [] },
  ];
  const xml = generateSitemap(pages, { lastmod: '2026-11-12' });
  assert.ok(xml.includes('<loc>https://ex.com/a</loc>'));
  assert.ok(!xml.includes('ex.com/b'));
  assert.ok(!xml.includes('ex.com/c'));
  assert.deepEqual(parseSitemap(xml), ['https://ex.com/a']);
});

test('generateImageSitemap lists images', () => {
  const xml = generateImageSitemap([{ address: 'https://ex.com/a', statusCode: 200, images: [{ url: 'https://ex.com/i.png' }] }]);
  assert.ok(xml.includes('image:image'));
  assert.ok(xml.includes('https://ex.com/i.png'));
});

test('compareCrawls finds added/removed/changed', () => {
  const a = { pages: [{ address: 'https://ex.com/1', title: 'Old', statusCode: 200 }, { address: 'https://ex.com/2', title: 'Gone', statusCode: 200 }], issues: [{ name: 'X', count: 2 }] };
  const b = { pages: [{ address: 'https://ex.com/1', title: 'New', statusCode: 200 }, { address: 'https://ex.com/3', title: 'Fresh', statusCode: 200 }], issues: [{ name: 'X', count: 5 }] };
  const d = compareCrawls(a, b);
  assert.deepEqual(d.added, ['https://ex.com/3']);
  assert.deepEqual(d.removed, ['https://ex.com/2']);
  assert.equal(d.changed.length, 1);
  assert.equal(d.issueDeltas[0].delta, 3);
});
