'use strict';
/* Issue rules engine. Each rule: id, display name, severity, test(page, ctx).
 * ctx carries crawl-wide aggregates computed by buildContext(). */

const LANG_RE = /^[a-z]{2,3}(-[a-zA-Z]{2,4})?$/;

function countMap(pages, pick) {
  const m = new Map();
  for (const p of pages) { const v = pick(p); if (v) m.set(v, (m.get(v) || 0) + 1); }
  return m;
}

function buildContext(pages) {
  const ctx = {
    titles: countMap(pages, (p) => (p.title || '').toLowerCase()),
    descs: countMap(pages, (p) => (p.metaDescription || '').toLowerCase()),
    h1s: countMap(pages, (p) => (p.h1s && p.h1s[0] || '').toLowerCase()),
    h2s: countMap(pages, (p) => (p.h2s && p.h2s[0] || '').toLowerCase()),
    hashes: countMap(pages, (p) => p.hash),
    nearDup: new Set(),
    orphan: new Set(),
    hreflangBad: new Set(),
    byUrl: new Map(pages.map((p) => [p.address, p])),
  };
  for (const p of pages) if (p.nearDuplicateOf) ctx.nearDup.add(p.address);
  for (const p of pages) if (p.contentType && /text\/html/.test(p.contentType) && p.statusCode === 200 && (p.uniqueInlinks || 0) === 0 && !p.isStartUrl) ctx.orphan.add(p.address);
  // hreflang: invalid code, or targets that do not link back (within crawled set)
  const byUrl = new Map(pages.map((p) => [p.address, p]));
  for (const p of pages) {
    for (const h of p.hreflang || []) {
      if (!LANG_RE.test(h.lang) && h.lang !== 'x-default') { ctx.hreflangBad.add(p.address); break; }
      const target = byUrl.get(h.url);
      if (target && !(target.hreflang || []).some((t) => t.url === p.address)) { ctx.hreflangBad.add(p.address); break; }
    }
  }
  return ctx;
}

const isHtml200 = (p) => p.statusCode === 200 && /text\/html/.test(p.contentType || 'text/html');
const RULES = [
  { id: 'client-error', name: 'Client Error (4xx)', severity: 'Error', test: (p) => p.statusCode >= 400 && p.statusCode < 500 },
  { id: 'server-error', name: 'Server Error (5xx)', severity: 'Error', test: (p) => p.statusCode >= 500 },
  { id: 'redirect', name: 'Redirect (3xx)', severity: 'Warning', test: (p) => p.statusCode >= 300 && p.statusCode < 400 },
  { id: 'redirect-chain', name: 'Redirect Chain', severity: 'Warning', test: (p) => (p.redirectChain || []).length > 1 },
  { id: 'redirect-loop', name: 'Redirect Loop', severity: 'Error', test: (p) => !!p.redirectLoop },
  { id: 'no-response', name: 'No Response', severity: 'Error', test: (p) => p.statusCode === 0 },
  { id: 'blocked-robots', name: 'Blocked by robots.txt', severity: 'Warning', test: (p) => p.indexabilityReason === 'Blocked by robots.txt' },
  { id: 'noindex', name: 'Noindex', severity: 'Warning', test: (p) => /noindex/i.test((p.metaRobots || '') + ' ' + (p.xRobotsTag || '')) },
  { id: 'nofollow', name: 'Nofollow Directive', severity: 'Opportunity', test: (p) => /nofollow/i.test((p.metaRobots || '') + ' ' + (p.xRobotsTag || '')) },
  { id: 'canonicalised', name: 'Canonicalised', severity: 'Warning', test: (p) => !!p.canonical && p.canonical !== p.address },
  { id: 'missing-canonical', name: 'Missing Canonical', severity: 'Opportunity', test: (p) => isHtml200(p) && !p.canonical },
  { id: 'multiple-canonical', name: 'Multiple Canonicals', severity: 'Error', test: (p) => (p.canonicals || []).length > 1 },
  { id: 'nonindexable-canonical', name: 'Canonical to Non-Indexable URL', severity: 'Warning', test: (p, ctx) => !!p.canonical && !!ctx.byUrl && ctx.byUrl.has(p.canonical) && ctx.byUrl.get(p.canonical).indexability !== 'Indexable' },
  { id: 'title-missing', name: 'Page Title: Missing', severity: 'Error', test: (p) => isHtml200(p) && !p.title },
  { id: 'title-duplicate', name: 'Page Title: Duplicate', severity: 'Warning', test: (p, ctx) => !!p.title && ctx.titles.get(p.title.toLowerCase()) > 1 },
  { id: 'title-long', name: 'Page Title: Over 60 Characters', severity: 'Warning', test: (p) => (p.titleLength || 0) > 60 },
  { id: 'title-short', name: 'Page Title: Below 30 Characters', severity: 'Opportunity', test: (p) => !!p.title && p.titleLength < 30 },
  { id: 'title-wide', name: 'Page Title: Over 561 Pixels', severity: 'Warning', test: (p) => (p.titlePixelWidth || 0) > 561 },
  { id: 'desc-missing', name: 'Meta Description: Missing', severity: 'Warning', test: (p) => isHtml200(p) && !p.metaDescription },
  { id: 'desc-duplicate', name: 'Meta Description: Duplicate', severity: 'Warning', test: (p, ctx) => !!p.metaDescription && ctx.descs.get(p.metaDescription.toLowerCase()) > 1 },
  { id: 'desc-long', name: 'Meta Description: Over 155 Characters', severity: 'Warning', test: (p) => (p.metaDescriptionLength || 0) > 155 },
  { id: 'desc-short', name: 'Meta Description: Below 70 Characters', severity: 'Opportunity', test: (p) => !!p.metaDescription && p.metaDescriptionLength < 70 },
  { id: 'h1-missing', name: 'H1: Missing', severity: 'Error', test: (p) => isHtml200(p) && !(p.h1s || []).length },
  { id: 'h1-duplicate', name: 'H1: Duplicate', severity: 'Warning', test: (p, ctx) => !!(p.h1s || []).length && ctx.h1s.get(p.h1s[0].toLowerCase()) > 1 },
  { id: 'h1-multiple', name: 'H1: Multiple', severity: 'Warning', test: (p) => (p.h1s || []).length > 1 },
  { id: 'h1-long', name: 'H1: Over 70 Characters', severity: 'Opportunity', test: (p) => !!(p.h1s || []).length && p.h1s[0].length > 70 },
  { id: 'h2-missing', name: 'H2: Missing', severity: 'Opportunity', test: (p) => isHtml200(p) && !(p.h2s || []).length },
  { id: 'h2-duplicate', name: 'H2: Duplicate', severity: 'Opportunity', test: (p, ctx) => !!(p.h2s || []).length && ctx.h2s.get(p.h2s[0].toLowerCase()) > 1 },
  { id: 'h2-multiple', name: 'H2: Multiple', severity: 'Opportunity', test: (p) => (p.h2s || []).length > 1 },
  { id: 'duplicate-content', name: 'Exact Duplicate Content', severity: 'Warning', test: (p, ctx) => !!p.hash && p.wordCount > 0 && ctx.hashes.get(p.hash) > 1 },
  { id: 'near-duplicate', name: 'Near Duplicate Content', severity: 'Opportunity', test: (p, ctx) => ctx.nearDup.has(p.address) },
  { id: 'low-content', name: 'Low Content Pages (Under 200 Words)', severity: 'Opportunity', test: (p) => isHtml200(p) && (p.wordCount || 0) < 200 },
  { id: 'orphan', name: 'Orphan Pages (No Inlinks)', severity: 'Warning', test: (p, ctx) => ctx.orphan.has(p.address) },
  { id: 'url-long', name: 'URL: Over 115 Characters', severity: 'Opportunity', test: (p) => (p.address || '').length > 115 },
  { id: 'url-uppercase', name: 'URL: Uppercase Characters', severity: 'Warning', test: (p) => /[A-Z]/.test(new URL(p.address).pathname) },
  { id: 'url-underscore', name: 'URL: Underscores', severity: 'Opportunity', test: (p) => new URL(p.address).pathname.includes('_') },
  { id: 'url-nonascii', name: 'URL: Non-ASCII Characters', severity: 'Warning', test: (p) => /[^\x00-\x7F]/.test(p.address) },
  { id: 'url-params', name: 'URL: Parameters', severity: 'Opportunity', test: (p) => p.address.includes('?') },
  { id: 'img-alt-missing', name: 'Images: Missing Alt Text', severity: 'Warning', test: (p) => (p.images || []).some((i) => !i.hasAlt || !(i.alt || '').trim()) },
  { id: 'img-oversized', name: 'Images: Over 100 KB', severity: 'Opportunity', test: (p) => (p.images || []).some((i) => (i.size || 0) > 100 * 1024) },
  { id: 'hreflang-issues', name: 'hreflang: Missing Return Tag or Invalid Language Code', severity: 'Warning', test: (p, ctx) => ctx.hreflangBad.has(p.address) },
  { id: 'insecure', name: 'Insecure Pages (HTTP)', severity: 'Warning', test: (p) => /^http:/.test(p.address) && isHtml200(p) },
  { id: 'mixed-content', name: 'Mixed Content', severity: 'Warning', test: (p) => (p.mixedContent || []).length > 0 },
  { id: 'security-headers', name: 'Missing Security Headers', severity: 'Opportunity', test: (p) => /^https:/.test(p.address) && isHtml200(p) && (p.missingSecurityHeaders || []).length >= 3 },
];

function issuesForPage(page, ctx) {
  const out = [];
  for (const rule of RULES) { try { if (rule.test(page, ctx)) out.push(rule.name); } catch (_) {} }
  return out;
}

function summarise(pages, ctx) {
  const total = pages.length || 1;
  return RULES.map((rule) => {
    let count = 0;
    for (const p of pages) { try { if (rule.test(p, ctx)) count++; } catch (_) {} }
    return { id: rule.id, name: rule.name, severity: rule.severity, count, pct: Math.round((count / total) * 1000) / 10 };
  }).filter((i) => i.count > 0).sort((a, b) => b.count - a.count);
}

module.exports = { RULES, buildContext, issuesForPage, summarise };
