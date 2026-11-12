'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseRobots, isAllowed } = require('../src/main/robots');

const TXT = `# comment
User-agent: *
Disallow: /private/
Allow: /private/public.html

User-agent: Googlebot
Disallow: /nogoogle/
`;

test('parseRobots builds groups', () => {
  const g = parseRobots(TXT);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].agents, ['*']);
  assert.equal(g[0].rules.length, 2);
});

test('isAllowed enforces disallow and allow longest match', () => {
  const g = parseRobots(TXT);
  assert.equal(isAllowed(g, '*', 'https://ex.com/private/x'), false);
  assert.equal(isAllowed(g, '*', 'https://ex.com/private/public.html'), true);
  assert.equal(isAllowed(g, '*', 'https://ex.com/open'), true);
});

test('isAllowed uses UA-specific group', () => {
  const g = parseRobots(TXT);
  assert.equal(isAllowed(g, 'googlebot', 'https://ex.com/nogoogle/x'), false);
  assert.equal(isAllowed(g, 'googlebot', 'https://ex.com/private/x'), true);
});

test('isAllowed wildcard patterns', () => {
  const g = parseRobots('User-agent: *\nDisallow: /*.pdf$\n');
  assert.equal(isAllowed(g, '*', 'https://ex.com/a/b.pdf'), false);
  assert.equal(isAllowed(g, '*', 'https://ex.com/a/b.pdfx'), true);
});
