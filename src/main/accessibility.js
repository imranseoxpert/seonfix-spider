'use strict';
/* Basic accessibility (WCAG 2.x) checks run on the parsed HTML (v2.1).
 * These are static-markup checks (no rendering, no colour contrast), in the
 * spirit of the axe rules they are named after. Each check returns a count of
 * offending elements and up to 10 short samples for the bottom pane. */

function textOf($, el) { return $(el).text().replace(/\s+/g, ' ').trim(); }
function short(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120); }
function outer($, el) { return short($.html(el) || ''); }

function accessibleName($, el) {
  const $el = $(el);
  if (($el.attr('aria-label') || '').trim()) return true;
  if (($el.attr('aria-labelledby') || '').trim()) return true;
  if (($el.attr('title') || '').trim()) return true;
  if (textOf($, el)) return true;
  if ($el.find('img[alt]').toArray().some((i) => ($(i).attr('alt') || '').trim())) return true;
  if ($el.find('svg title').toArray().some((t) => textOf($, t))) return true;
  if ($el.is('input') && ($el.attr('value') || '').trim()) return true;
  return false;
}

const CHECKS = [
  { id: 'html-lang', name: 'Missing Page Language', wcag: '3.1.1 (A)', run: ($) => ($('html').attr('lang') || '').trim() ? [] : ['<html> has no lang attribute'] },
  { id: 'document-title', name: 'Missing Document Title', wcag: '2.4.2 (A)', run: ($) => textOf($, $('title').first()) ? [] : ['<title> is missing or empty'] },
  { id: 'image-alt', name: 'Images Missing Alt Attribute', wcag: '1.1.1 (A)', run: ($) => $('img').toArray().filter((el) => $(el).attr('alt') === undefined && $(el).attr('role') !== 'presentation' && $(el).attr('aria-hidden') !== 'true').map((el) => outer($, el)) },
  { id: 'link-name', name: 'Links Without Discernible Text', wcag: '2.4.4 (A)', run: ($) => $('a[href]').toArray().filter((el) => $(el).attr('aria-hidden') !== 'true' && !accessibleName($, el)).map((el) => outer($, el)) },
  { id: 'button-name', name: 'Buttons Without Discernible Text', wcag: '4.1.2 (A)', run: ($) => $('button, [role="button"], input[type="submit"], input[type="button"]').toArray().filter((el) => !accessibleName($, el)).map((el) => outer($, el)) },
  {
    id: 'label', name: 'Form Fields Without Labels', wcag: '1.3.1 (A)',
    run: ($) => $('input, select, textarea').toArray().filter((el) => {
      const $el = $(el); const type = ($el.attr('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return false;
      if (($el.attr('aria-label') || '').trim() || ($el.attr('aria-labelledby') || '').trim() || ($el.attr('title') || '').trim()) return false;
      const id = $el.attr('id');
      if (id && $('label').toArray().some((l) => $(l).attr('for') === id)) return false;
      if ($el.closest('label').length) return false;
      return true;
    }).map((el) => outer($, el)),
  },
  {
    id: 'duplicate-id', name: 'Duplicate ID Attributes', wcag: '4.1.1 (A)',
    run: ($) => { const seen = new Map(); $('[id]').each((_, el) => { const id = $(el).attr('id'); seen.set(id, (seen.get(id) || 0) + 1); }); return [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `id="${short(id)}" used ${n} times`); },
  },
  { id: 'empty-heading', name: 'Empty Headings', wcag: '1.3.1 (A)', run: ($) => $('h1,h2,h3,h4,h5,h6').toArray().filter((el) => !textOf($, el) && !$(el).find('img[alt]').toArray().some((i) => ($(i).attr('alt') || '').trim())).map((el) => outer($, el)) },
  { id: 'frame-title', name: 'Iframes Without Title', wcag: '4.1.2 (A)', run: ($) => $('iframe').toArray().filter((el) => !($(el).attr('title') || '').trim() && $(el).attr('aria-hidden') !== 'true').map((el) => outer($, el)) },
  {
    id: 'meta-viewport', name: 'Zooming Disabled (Viewport)', wcag: '1.4.4 (AA)',
    run: ($) => { const c = String($('meta[name="viewport" i]').attr('content') || '').toLowerCase(); const max = c.match(/maximum-scale\s*=\s*([\d.]+)/); return (/user-scalable\s*=\s*(no|0)/.test(c) || (max && Number(max[1]) < 2)) ? [short(c)] : []; },
  },
  { id: 'tabindex', name: 'Positive Tabindex', wcag: '2.4.3 (A)', run: ($) => $('[tabindex]').toArray().filter((el) => Number($(el).attr('tabindex')) > 0).map((el) => outer($, el)) },
  { id: 'skipped-heading', name: 'Heading Levels Skipped', wcag: '1.3.1 (A)', run: ($) => { const lv = $('h1,h2,h3,h4,h5,h6').toArray().map((el) => Number(el.tagName.slice(1))); const out = []; for (let i = 1; i < lv.length; i++) if (lv[i] > lv[i - 1] + 1) out.push(`h${lv[i - 1]} followed by h${lv[i]}`); return out; } },
];

/* Returns { violations: total count, checks: { [id]: { count, samples } } } */
function checkAccessibility($) {
  const checks = {}; let violations = 0;
  for (const c of CHECKS) {
    let found = [];
    try { found = c.run($) || []; } catch (_) { found = []; }
    checks[c.id] = { count: found.length, samples: found.slice(0, 10) };
    violations += found.length;
  }
  return { violations, checks };
}

module.exports = { checkAccessibility, A11Y_CHECKS: CHECKS.map(({ id, name, wcag }) => ({ id, name, wcag })) };
