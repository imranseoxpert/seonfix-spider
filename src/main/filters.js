'use strict';
/* v2 filter registry: the single source of truth for Overview sidebar
 * sections, grid filtering, bulk exports and reports.
 * Each filter: { id, section, name, tab, test(page, ctx) }.
 * During crawl finalisation every page gets `filters: [ids]` = the filters
 * it matches, so sidebar counts and grid filtering always agree.
 * Also holds the Issues catalogue (SF model: type + priority + description),
 * where each issue is backed by a filter id. */
const { classifyInternal } = require('./urlutil');

const HTML = (p) => /text\/html|xhtml/.test(p.contentType || '') || (p.contentCategory === 'HTML');
const isHtml200 = (p) => (p.finalStatusCode === 200 || p.statusCode === 200) && HTML(p) && !p.resourceOnly;
const LANG_RE = /^[a-z]{2,3}(-[a-zA-Z]{2,4})?$/;

function countMap(pages, pick) {
  const m = new Map();
  for (const p of pages) { const v = pick(p); if (v) m.set(v, (m.get(v) || 0) + 1); }
  return m;
}

function categoryOf(p) {
  if (p.contentCategory) return p.contentCategory;
  const ct = (p.contentType || '').toLowerCase();
  if (/text\/html|xhtml/.test(ct)) return 'HTML';
  if (/javascript|ecmascript/.test(ct)) return 'JavaScript';
  if (/text\/css/.test(ct)) return 'CSS';
  if (/image\//.test(ct)) return 'Images';
  if (/application\/pdf/.test(ct)) return 'PDF';
  if (/flash/.test(ct)) return 'Flash';
  if (!ct) return 'Unknown';
  return 'Other';
}

/* Build crawl-wide aggregates used by filter predicates. */
function buildFilterContext(pages, rootUrl, config = {}) {
  const ctx = {
    rootUrl, config,
    titles: countMap(pages, (p) => (p.title || '').toLowerCase()),
    descs: countMap(pages, (p) => (p.metaDescription || '').toLowerCase()),
    h1s: countMap(pages, (p) => (p.h1s && p.h1s[0] || '').toLowerCase()),
    h2s: countMap(pages, (p) => (p.h2s && p.h2s[0] || '').toLowerCase()),
    hashes: countMap(pages, (p) => p.hash),
    byUrl: new Map(pages.map((p) => [p.address, p])),
    nearDup: new Set(), orphan: new Set(),
    hl: { non200: new Set(), unlinked: new Set(), missingReturn: new Set(), inconsistent: new Set(), nonCanonicalReturn: new Set(), noindexReturn: new Set(), badCodes: new Set(), multiple: new Set(), missingSelf: new Set(), notCanonical: new Set(), missingXDefault: new Set() },
    pg: { non200: new Set(), unlinked: new Set(), multiple: new Set(), loop: new Set(), sequenceError: new Set(), notInAnchor: new Set() },
    ampTargets: new Set(), sitemapUrls: new Set(),
  };
  for (const p of pages) if (p.nearDuplicateOf) ctx.nearDup.add(p.address);
  for (const p of pages) if (HTML(p) && p.statusCode === 200 && (p.uniqueInlinks || 0) === 0 && !p.isStartUrl && !p.sitemapOnly) ctx.orphan.add(p.address);
  for (const p of pages) if (p.ampUrl) ctx.ampTargets.add(p.ampUrl);
  for (const p of pages) if (p.inSitemap) ctx.sitemapUrls.add(p.address);
  // hreflang analysis
  for (const p of pages) {
    const hl = p.hreflang || [];
    if (!hl.length) continue;
    const langs = hl.map((h) => String(h.lang || '').toLowerCase());
    if (new Set(langs).size !== langs.length) ctx.hl.multiple.add(p.address);
    if (!hl.some((h) => h.url === p.address)) ctx.hl.missingSelf.add(p.address);
    if (!langs.includes('x-default')) ctx.hl.missingXDefault.add(p.address);
    if (p.canonical && hl.some((h) => h.url === p.address) && !hl.some((h) => h.url === p.canonical)) ctx.hl.notCanonical.add(p.address);
    for (const h of hl) {
      if (!LANG_RE.test(String(h.lang || '')) && String(h.lang).toLowerCase() !== 'x-default') ctx.hl.badCodes.add(p.address);
      const t = ctx.byUrl.get(h.url);
      if (!t) { ctx.hl.unlinked.add(p.address); continue; }
      if (t.statusCode !== 200) ctx.hl.non200.add(p.address);
      const back = (t.hreflang || []).find((x) => x.url === p.address);
      if (!back) { ctx.hl.missingReturn.add(p.address); continue; }
      const myEntry = hl.find((x) => x.url === t.address);
      if (myEntry && String(back.lang || '').toLowerCase() !== String(myEntry.lang || '').toLowerCase()) ctx.hl.inconsistent.add(p.address);
      if (t.canonical && back.url !== t.canonical) ctx.hl.nonCanonicalReturn.add(p.address);
      if (/noindex/i.test((t.metaRobots || '') + ' ' + (t.xRobotsTag || ''))) ctx.hl.noindexReturn.add(p.address);
    }
  }
  // pagination analysis
  for (const p of pages) {
    const nx = (p.paginationAll && p.paginationAll.next) || [];
    const pv = (p.paginationAll && p.paginationAll.prev) || [];
    if (nx.length > 1 || pv.length > 1) ctx.pg.multiple.add(p.address);
    const anchorUrls = new Set((p.links || []).map((l) => l.url));
    for (const t of [...nx, ...pv]) {
      if (!anchorUrls.has(t)) ctx.pg.notInAnchor.add(p.address);
      const tp = ctx.byUrl.get(t);
      if (!tp) { ctx.pg.unlinked.add(p.address); continue; }
      if (tp.statusCode !== 200) ctx.pg.non200.add(p.address);
    }
    if (nx.length) {
      const n1 = ctx.byUrl.get(nx[0]);
      if (n1 && ((n1.paginationAll && n1.paginationAll.next) || []).includes(p.address)) ctx.pg.loop.add(p.address);
      if (n1 && n1.pagination && n1.pagination.prev && n1.pagination.prev !== p.address) ctx.pg.sequenceError.add(p.address);
    }
  }
  return ctx;
}

const F = (id, section, name, tab, test) => ({ id, section, name, tab, test });
const sec200 = (p) => p.statusCode >= 200 && p.statusCode < 300;
const hasHeaderMissing = (p, h) => (p.missingSecurityHeaders || []).includes(h);
const dirTokens = (p) => p.directives || [];
const hasDir = (p, name) => dirTokens(p).some((d) => d === name || d.startsWith(name + ':') || d.startsWith(name + '='));

const FILTERS = [
  // ---- Crawl Data (Internal / External) ----
  ...['Internal', 'External'].flatMap((side) => {
    const isSide = side === 'Internal' ? (p) => !p.external : (p) => !!p.external;
    const pre = side.toLowerCase();
    return [
      F(`${pre}-all`, `Crawl Data ${side}`, 'All', side.toLowerCase(), isSide),
      ...['HTML', 'JavaScript', 'CSS', 'Images', 'PDF', 'Flash', 'Other', 'Unknown'].map((cat) =>
        F(`${pre}-${cat.toLowerCase()}`, `Crawl Data ${side}`, cat, side.toLowerCase(), (p) => isSide(p) && categoryOf(p) === cat)),
    ];
  }),
  // ---- Security ----
  F('sec-all', 'Security', 'All', 'security', (p) => HTML(p) || p.statusCode > 0),
  F('sec-http', 'Security', 'HTTP URLs', 'security', (p) => /^http:/i.test(p.address) && !/^https:/i.test(p.address)),
  F('sec-https', 'Security', 'HTTPS URLs', 'security', (p) => /^https:/i.test(p.address)),
  F('sec-mixed', 'Security', 'Mixed Content', 'security', (p) => (p.mixedContent || []).length > 0),
  F('sec-form-insecure', 'Security', 'Form URL Insecure', 'security', (p) => /^https:/i.test(p.address) && (p.forms || []).some((f) => /^http:/i.test(f.action))),
  F('sec-form-http', 'Security', 'Form on HTTP URL', 'security', (p) => /^http:/i.test(p.address) && !/^https:/i.test(p.address) && (p.forms || []).length > 0),
  F('sec-unsafe-xorigin', 'Security', 'Unsafe Cross-Origin Links', 'security', (p) => (p.links || []).some((l) => l.unsafeCrossOrigin)),
  F('sec-protocol-relative', 'Security', 'Protocol-Relative Resource Links', 'security', (p) => (p.protocolRelativeCount || 0) > 0),
  F('sec-hsts', 'Security', 'Missing HSTS Header', 'security', (p) => /^https:/i.test(p.address) && p.statusCode > 0 && hasHeaderMissing(p, 'strict-transport-security')),
  F('sec-csp', 'Security', 'Missing Content-Security-Policy Header', 'security', (p) => /^https:/i.test(p.address) && p.statusCode > 0 && hasHeaderMissing(p, 'content-security-policy')),
  F('sec-xcto', 'Security', 'Missing X-Content-Type-Options Header', 'security', (p) => /^https:/i.test(p.address) && p.statusCode > 0 && hasHeaderMissing(p, 'x-content-type-options')),
  F('sec-xfo', 'Security', 'Missing X-Frame-Options Header', 'security', (p) => /^https:/i.test(p.address) && p.statusCode > 0 && hasHeaderMissing(p, 'x-frame-options')),
  F('sec-referrer', 'Security', 'Missing Secure Referrer-Policy Header', 'security', (p) => /^https:/i.test(p.address) && p.statusCode > 0 && hasHeaderMissing(p, 'referrer-policy')),
  F('sec-bad-content-type', 'Security', 'Bad Content Type', 'security', (p) => !!p.badContentType),
  // ---- Response Codes ----
  F('rc-all', 'Response Codes', 'All', 'responses', () => true),
  F('rc-blocked-robots', 'Response Codes', 'Blocked by Robots.txt', 'responses', (p) => p.indexabilityReason === 'Blocked by robots.txt'),
  F('rc-blocked-resource', 'Response Codes', 'Blocked Resource', 'responses', (p) => (p.blockedResources || []).length > 0),
  F('rc-no-response', 'Response Codes', 'No Response', 'responses', (p) => !p.statusCode && !p.external),
  F('rc-2xx', 'Response Codes', 'Success (2xx)', 'responses', sec200),
  F('rc-3xx', 'Response Codes', 'Redirection (3xx)', 'responses', (p) => p.statusCode >= 300 && p.statusCode < 400 && !p.metaRefresh),
  F('rc-3xx-js', 'Response Codes', 'Redirection (JavaScript)', 'responses', (p) => !!p.jsRedirect),
  F('rc-3xx-meta', 'Response Codes', 'Redirection (Meta Refresh)', 'responses', (p) => !!p.metaRefresh),
  F('rc-4xx', 'Response Codes', 'Client Error (4xx)', 'responses', (p) => p.statusCode >= 400 && p.statusCode < 500),
  F('rc-5xx', 'Response Codes', 'Server Error (5xx)', 'responses', (p) => p.statusCode >= 500),
  F('rc-int-all', 'Response Codes', 'Internal All', 'responses', (p) => !p.external),
  F('rc-int-blocked-robots', 'Response Codes', 'Internal Blocked by Robots.txt', 'responses', (p) => !p.external && p.indexabilityReason === 'Blocked by robots.txt'),
  F('rc-int-blocked-resource', 'Response Codes', 'Internal Blocked Resource', 'responses', (p) => !p.external && (p.blockedResources || []).length > 0),
  F('rc-int-no-response', 'Response Codes', 'Internal No Response', 'responses', (p) => !p.external && !p.statusCode),
  F('rc-int-2xx', 'Response Codes', 'Internal Success (2xx)', 'responses', (p) => !p.external && sec200(p)),
  F('rc-int-3xx', 'Response Codes', 'Internal Redirection (3xx)', 'responses', (p) => !p.external && p.statusCode >= 300 && p.statusCode < 400 && !p.metaRefresh),
  F('rc-int-3xx-js', 'Response Codes', 'Internal Redirection (JavaScript)', 'responses', (p) => !p.external && !!p.jsRedirect),
  F('rc-int-3xx-meta', 'Response Codes', 'Internal Redirection (Meta Refresh)', 'responses', (p) => !p.external && !!p.metaRefresh),
  F('rc-int-chain', 'Response Codes', 'Internal Redirect Chain', 'responses', (p) => !p.external && (p.redirectChain || []).length > 1),
  F('rc-int-5xx', 'Response Codes', 'Internal Server Error (5xx)', 'responses', (p) => !p.external && p.statusCode >= 500),
  F('rc-int-loop', 'Response Codes', 'Internal Redirect Loop', 'responses', (p) => !p.external && !!p.redirectLoop),
  // ---- URL ----
  F('url-all', 'URL', 'All', 'url', () => true),
  F('url-nonascii', 'URL', 'Non ASCII Characters', 'url', (p) => /[^\x00-\x7F]/.test(p.address)),
  F('url-underscores', 'URL', 'Underscores', 'url', (p) => { try { return new URL(p.address).pathname.includes('_'); } catch (_) { return false; } }),
  F('url-uppercase', 'URL', 'Uppercase', 'url', (p) => { try { return /[A-Z]/.test(new URL(p.address).pathname); } catch (_) { return false; } }),
  F('url-multiple-slashes', 'URL', 'Multiple Slashes', 'url', (p) => { try { return /\/{2,}/.test(new URL(p.address).pathname.replace(/^\//, '')); } catch (_) { return false; } }),
  F('url-repetitive-path', 'URL', 'Repetitive Path', 'url', (p) => { try { const parts = new URL(p.address).pathname.split('/').filter(Boolean); return parts.some((s, i) => i > 0 && parts[i - 1] === s); } catch (_) { return false; } }),
  F('url-space', 'URL', 'Contains Space', 'url', (p) => /%20|\s/.test(p.address)),
  F('url-parameters', 'URL', 'Parameters', 'url', (p) => p.address.includes('?')),
  F('url-ga-params', 'URL', 'GA Tracking Parameters', 'url', (p) => /[?&](utm_|gclid|fbclid|mc_eid|_ga)/.test(p.address)),
  F('url-over-115', 'URL', 'Over 115 Characters', 'url', (p) => p.address.length > 115),
  F('url-broken-bookmarks', 'URL', 'Broken Bookmarks', 'url', (p) => (p.links || []).some((l) => /#/.test(l.rawHref || '')) && false),
  F('url-internal-search', 'URL', 'Internal Search', 'url', (p) => /[?&](s|q|query|search|keyword)=/.test(p.address)),
  F('url-hash', 'URL', 'Hash Value', 'url', (p) => (p.hashLinks || 0) > 0),
  F('url-multiple-params', 'URL', 'Multiple Parameters', 'url', (p) => { try { return [...new URL(p.address).searchParams.keys()].length > 1; } catch (_) { return false; } }),
  F('url-query-only', 'URL', 'Query String Only', 'url', (p) => { try { const u = new URL(p.address); return !!u.search && (u.pathname === '/' || u.pathname === ''); } catch (_) { return false; } }),
  // ---- Page Titles ----
  F('title-all', 'Page Titles', 'All', 'titles', (p) => HTML(p)),
  F('title-missing', 'Page Titles', 'Missing', 'titles', (p) => isHtml200(p) && !p.title),
  F('title-duplicate', 'Page Titles', 'Duplicate', 'titles', (p, ctx) => !!p.title && ctx.titles.get(p.title.toLowerCase()) > 1),
  F('title-over-60', 'Page Titles', 'Over 60 Characters', 'titles', (p) => (p.titleLength || 0) > 60),
  F('title-below-30', 'Page Titles', 'Below 30 Characters', 'titles', (p) => !!p.title && p.titleLength < 30),
  F('title-over-580px', 'Page Titles', 'Over 580 Pixels', 'titles', (p) => (p.titlePixelWidth || 0) > 580),
  F('title-below-200px', 'Page Titles', 'Below 200 Pixels', 'titles', (p) => !!p.title && (p.titlePixelWidth || 0) < 200),
  F('title-multiple', 'Page Titles', 'Multiple', 'titles', (p) => (p.titles || []).length > 1),
  F('title-same-h1', 'Page Titles', 'Same as H1', 'titles', (p) => !!p.title && (p.h1s || [])[0] === p.title),
  F('title-outside-head', 'Page Titles', 'Outside <head>', 'titles', (p) => !!p.titleOutsideHead),
  // ---- Meta Description ----
  F('desc-all', 'Meta Description', 'All', 'desc', (p) => HTML(p)),
  F('desc-missing', 'Meta Description', 'Missing', 'desc', (p) => isHtml200(p) && !p.metaDescription),
  F('desc-duplicate', 'Meta Description', 'Duplicate', 'desc', (p, ctx) => !!p.metaDescription && ctx.descs.get(p.metaDescription.toLowerCase()) > 1),
  F('desc-over-155', 'Meta Description', 'Over 155 Characters', 'desc', (p) => (p.metaDescriptionLength || 0) > 155),
  F('desc-below-70', 'Meta Description', 'Below 70 Characters', 'desc', (p) => !!p.metaDescription && p.metaDescriptionLength < 70),
  F('desc-over-985px', 'Meta Description', 'Over 985 Pixels', 'desc', (p) => (p.metaDescriptionPixelWidth || 0) > 985),
  F('desc-below-400px', 'Meta Description', 'Below 400 Pixels', 'desc', (p) => !!p.metaDescription && (p.metaDescriptionPixelWidth || 0) < 400),
  F('desc-multiple', 'Meta Description', 'Multiple', 'desc', (p) => (p.metaDescriptions || []).length > 1),
  F('desc-outside-head', 'Meta Description', 'Outside <head>', 'desc', (p) => !!p.descOutsideHead),
  // ---- H1 ----
  F('h1-all', 'H1', 'All', 'h1', (p) => HTML(p)),
  F('h1-missing', 'H1', 'Missing', 'h1', (p) => isHtml200(p) && !(p.h1s || []).length),
  F('h1-duplicate', 'H1', 'Duplicate', 'h1', (p, ctx) => !!(p.h1s || []).length && ctx.h1s.get(p.h1s[0].toLowerCase()) > 1),
  F('h1-over-70', 'H1', 'Over 70 Characters', 'h1', (p) => !!((p.h1s || [])[0] || '').length && p.h1s[0].length > 70),
  F('h1-multiple', 'H1', 'Multiple', 'h1', (p) => (p.h1s || []).length > 1),
  F('h1-alt-text', 'H1', 'Alt Text in H1', 'h1', (p) => !!p.h1HasAltImg),
  F('h1-non-sequential', 'H1', 'Non-Sequential', 'h1', (p) => nonSequential(p, 1)),
  // ---- H2 ----
  F('h2-all', 'H2', 'All', 'h2', (p) => HTML(p)),
  F('h2-missing', 'H2', 'Missing', 'h2', (p) => isHtml200(p) && !(p.h2s || []).length),
  F('h2-duplicate', 'H2', 'Duplicate', 'h2', (p, ctx) => !!(p.h2s || []).length && ctx.h2s.get(p.h2s[0].toLowerCase()) > 1),
  F('h2-over-70', 'H2', 'Over 70 Characters', 'h2', (p) => !!((p.h2s || [])[0] || '').length && p.h2s[0].length > 70),
  F('h2-multiple', 'H2', 'Multiple', 'h2', (p) => (p.h2s || []).length > 1),
  F('h2-non-sequential', 'H2', 'Non-Sequential', 'h2', (p) => nonSequential(p, 2)),
  // ---- Content ----
  F('content-all', 'Content', 'All', 'content', (p) => HTML(p)),
  F('content-exact-dup', 'Content', 'Exact Duplicates', 'content', (p, ctx) => !!p.hash && (p.wordCount || 0) > 0 && ctx.hashes.get(p.hash) > 1),
  F('content-near-dup', 'Content', 'Near Duplicates', 'content', (p, ctx) => ctx.nearDup.has(p.address)),
  F('content-low', 'Content', 'Low Content Pages', 'content', (p) => isHtml200(p) && (p.wordCount || 0) < 200),
  F('content-soft-404', 'Content', 'Soft 404 Pages', 'content', (p) => !!p.soft404),
  F('content-spelling', 'Content', 'Spelling Errors', 'content', (p) => (p.spellingErrors || 0) > 0),
  F('content-grammar', 'Content', 'Grammar Errors', 'content', () => false),
  F('content-read-difficult', 'Content', 'Readability Difficult', 'content', (p) => p.readability === 'Difficult'),
  F('content-read-very-difficult', 'Content', 'Readability Very Difficult', 'content', (p) => p.readability === 'Very Difficult'),
  F('content-lorem', 'Content', 'Lorem Ipsum Placeholder', 'content', (p) => !!p.loremIpsum),
  // ---- Images ----
  F('img-all', 'Images', 'All', 'images', (p) => (p.images || []).length > 0 || categoryOf(p) === 'Images'),
  F('img-over-100kb', 'Images', 'Over 100 KB', 'images', (p) => (p.images || []).some((i) => (i.size || 0) > 100 * 1024) || (categoryOf(p) === 'Images' && (p.sizeBytes || 0) > 100 * 1024)),
  F('img-missing-alt-text', 'Images', 'Missing Alt Text', 'images', (p) => (p.images || []).some((i) => i.hasAlt && !(i.alt || '').trim())),
  F('img-missing-alt-attr', 'Images', 'Missing Alt Attribute', 'images', (p) => (p.images || []).some((i) => !i.hasAlt)),
  F('img-alt-over-100', 'Images', 'Alt Text Over 100 Characters', 'images', (p) => (p.images || []).some((i) => (i.alt || '').length > 100)),
  F('img-background', 'Images', 'Background Images', 'images', (p) => (p.backgroundImages || 0) > 0),
  F('img-incorrect-size', 'Images', 'Incorrectly Sized Images', 'images', (p) => (p.images || []).some((i) => i.incorrectlySized)),
  F('img-missing-size-attrs', 'Images', 'Missing Size Attributes', 'images', (p) => (p.images || []).some((i) => !i.hasSizeAttrs)),
  // ---- Canonicals ----
  F('can-all', 'Canonicals', 'All', 'canonicals', (p) => HTML(p)),
  F('can-contains', 'Canonicals', 'Contains Canonical', 'canonicals', (p) => !!p.canonical),
  F('can-self', 'Canonicals', 'Self Referencing', 'canonicals', (p) => !!p.canonical && p.canonical === p.address),
  F('can-canonicalised', 'Canonicals', 'Canonicalised', 'canonicals', (p) => !!p.canonical && p.canonical !== p.address),
  F('can-missing', 'Canonicals', 'Missing', 'canonicals', (p) => isHtml200(p) && !p.canonical),
  F('can-multiple', 'Canonicals', 'Multiple', 'canonicals', (p) => (p.canonicals || []).length > 1),
  F('can-conflicting', 'Canonicals', 'Multiple Conflicting', 'canonicals', (p) => new Set(p.canonicals || []).size > 1),
  F('can-nonindexable', 'Canonicals', 'Non-Indexable Canonical', 'canonicals', (p, ctx) => !!p.canonical && !!ctx.byUrl.get(p.canonical) && ctx.byUrl.get(p.canonical).indexability !== 'Indexable'),
  F('can-relative', 'Canonicals', 'Canonical Is Relative', 'canonicals', (p) => (p.canonicalHrefs || []).some((h) => h && !/^https?:\/\//i.test(h))),
  F('can-unlinked', 'Canonicals', 'Unlinked', 'canonicals', (p, ctx) => !!p.canonical && !ctx.byUrl.has(p.canonical)),
  F('can-outside-head', 'Canonicals', 'Outside <head>', 'canonicals', (p) => !!p.canonicalOutsideHead),
  // ---- Pagination ----
  F('pg-all', 'Pagination', 'All', 'pagination', (p) => HTML(p)),
  F('pg-contains', 'Pagination', 'Contains Pagination', 'pagination', (p) => !!((p.pagination || {}).next || (p.pagination || {}).prev)),
  F('pg-first', 'Pagination', 'First Page', 'pagination', (p) => !!((p.pagination || {}).next) && !((p.pagination || {}).prev)),
  F('pg-2plus', 'Pagination', 'Paginated 2+ Pages', 'pagination', (p) => !!((p.pagination || {}).prev)),
  F('pg-not-in-anchor', 'Pagination', 'Pagination URL Not in Anchor Tag', 'pagination', (p, ctx) => ctx.pg.notInAnchor.has(p.address)),
  F('pg-non-200', 'Pagination', 'Non-200 Pagination URLs', 'pagination', (p, ctx) => ctx.pg.non200.has(p.address)),
  F('pg-unlinked', 'Pagination', 'Unlinked Pagination URLs', 'pagination', (p, ctx) => ctx.pg.unlinked.has(p.address)),
  F('pg-multiple', 'Pagination', 'Multiple Pagination URLs', 'pagination', (p, ctx) => ctx.pg.multiple.has(p.address)),
  F('pg-loop', 'Pagination', 'Pagination Loop', 'pagination', (p, ctx) => ctx.pg.loop.has(p.address)),
  F('pg-sequence-error', 'Pagination', 'Sequence Error', 'pagination', (p, ctx) => ctx.pg.sequenceError.has(p.address)),
  // ---- Directives ----
  F('dir-all', 'Directives', 'All', 'directives', (p) => HTML(p)),
  F('dir-index', 'Directives', 'Index', 'directives', (p) => hasDir(p, 'index') && !hasDir(p, 'noindex')),
  F('dir-noindex', 'Directives', 'Noindex', 'directives', (p) => hasDir(p, 'noindex')),
  F('dir-follow', 'Directives', 'Follow', 'directives', (p) => hasDir(p, 'follow') && !hasDir(p, 'nofollow')),
  F('dir-nofollow', 'Directives', 'Nofollow', 'directives', (p) => hasDir(p, 'nofollow')),
  F('dir-none', 'Directives', 'None', 'directives', (p) => hasDir(p, 'none')),
  F('dir-noarchive', 'Directives', 'NoArchive', 'directives', (p) => hasDir(p, 'noarchive')),
  F('dir-nosnippet', 'Directives', 'NoSnippet', 'directives', (p) => hasDir(p, 'nosnippet')),
  F('dir-max-snippet', 'Directives', 'Max-Snippet', 'directives', (p) => hasDir(p, 'max-snippet')),
  F('dir-max-image', 'Directives', 'Max-Image-Preview', 'directives', (p) => hasDir(p, 'max-image-preview')),
  F('dir-max-video', 'Directives', 'Max-Video-Preview', 'directives', (p) => hasDir(p, 'max-video-preview')),
  F('dir-noodp', 'Directives', 'NoODP', 'directives', (p) => hasDir(p, 'noodp')),
  F('dir-noydir', 'Directives', 'NoYDIR', 'directives', (p) => hasDir(p, 'noydir')),
  F('dir-noimageindex', 'Directives', 'NoImageIndex', 'directives', (p) => hasDir(p, 'noimageindex')),
  F('dir-notranslate', 'Directives', 'NoTranslate', 'directives', (p) => hasDir(p, 'notranslate')),
  F('dir-unavailable-after', 'Directives', 'Unavailable_After', 'directives', (p) => hasDir(p, 'unavailable_after')),
  F('dir-refresh', 'Directives', 'Refresh', 'directives', (p) => !!p.metaRefresh),
  F('dir-outside-head', 'Directives', 'Outside <head>', 'directives', (p) => !!p.directivesOutsideHead),
  // ---- Hreflang ----
  F('hl-all', 'Hreflang', 'All', 'hreflang', (p) => HTML(p)),
  F('hl-contains', 'Hreflang', 'Contains hreflang', 'hreflang', (p) => (p.hreflang || []).length > 0),
  F('hl-non-200', 'Hreflang', 'Non-200 hreflang URLs', 'hreflang', (p, ctx) => ctx.hl.non200.has(p.address)),
  F('hl-unlinked', 'Hreflang', 'Unlinked hreflang URLs', 'hreflang', (p, ctx) => ctx.hl.unlinked.has(p.address)),
  F('hl-missing-return', 'Hreflang', 'Missing Return Links', 'hreflang', (p, ctx) => ctx.hl.missingReturn.has(p.address)),
  F('hl-inconsistent', 'Hreflang', 'Inconsistent Language & Region Return Links', 'hreflang', (p, ctx) => ctx.hl.inconsistent.has(p.address)),
  F('hl-noncanonical-return', 'Hreflang', 'Non-Canonical Return Links', 'hreflang', (p, ctx) => ctx.hl.nonCanonicalReturn.has(p.address)),
  F('hl-noindex-return', 'Hreflang', 'Noindex Return Links', 'hreflang', (p, ctx) => ctx.hl.noindexReturn.has(p.address)),
  F('hl-bad-codes', 'Hreflang', 'Incorrect Language & Region Codes', 'hreflang', (p, ctx) => ctx.hl.badCodes.has(p.address)),
  F('hl-multiple', 'Hreflang', 'Multiple Entries', 'hreflang', (p, ctx) => ctx.hl.multiple.has(p.address)),
  F('hl-missing-self', 'Hreflang', 'Missing Self Reference', 'hreflang', (p, ctx) => ctx.hl.missingSelf.has(p.address)),
  F('hl-not-canonical', 'Hreflang', 'Not Using Canonical', 'hreflang', (p, ctx) => ctx.hl.notCanonical.has(p.address)),
  F('hl-missing-xdefault', 'Hreflang', 'Missing X-Default', 'hreflang', (p, ctx) => ctx.hl.missingXDefault.has(p.address)),
  F('hl-outside-head', 'Hreflang', 'Outside <head>', 'hreflang', (p) => !!p.hreflangOutsideHead),
  // ---- JavaScript ----
  F('js-all', 'JavaScript', 'All', 'javascript', (p) => HTML(p)),
  F('js-blocked-resources', 'JavaScript', 'Pages with Blocked Resources', 'javascript', (p) => (p.blockedResources || []).length > 0),
  F('js-errors', 'JavaScript', 'Pages with JavaScript Errors', 'javascript', (p) => (p.jsErrors || []).length > 0),
  F('js-title-rendered-only', 'JavaScript', 'Page Title Only in Rendered HTML', 'javascript', (p) => !!p.renderedTitle && !(p.rawTitle || p.title)),
  F('js-title-updated', 'JavaScript', 'Page Title Updated by JavaScript', 'javascript', (p) => !!p.renderedTitle && !!(p.rawTitle || p.title) && p.renderedTitle !== (p.rawTitle || p.title)),
  F('js-canonical-rendered-only', 'JavaScript', 'Canonical Only in Rendered HTML', 'javascript', (p) => !!p.renderedCanonical && !p.canonical),
  F('js-canonical-updated', 'JavaScript', 'Canonical Updated by JavaScript', 'javascript', (p) => !!p.renderedCanonical && !!p.canonical && p.renderedCanonical !== p.canonical),
  F('js-desc-rendered-only', 'JavaScript', 'Meta Description Only in Rendered HTML', 'javascript', (p) => !!p.renderedMetaDescription && !p.metaDescription),
  F('js-desc-updated', 'JavaScript', 'Meta Description Updated by JavaScript', 'javascript', (p) => !!p.renderedMetaDescription && !!p.metaDescription && p.renderedMetaDescription !== p.metaDescription),
  F('js-h1-rendered-only', 'JavaScript', 'H1 Only in Rendered HTML', 'javascript', (p) => !!p.renderedH1 && !(p.h1s || []).length),
  F('js-h1-updated', 'JavaScript', 'H1 Updated by JavaScript', 'javascript', (p) => !!p.renderedH1 && !!((p.h1s || [])[0]) && p.renderedH1 !== p.h1s[0]),
  F('js-ajax-scheme-urls', 'JavaScript', 'Uses Old AJAX Crawling Scheme URLs', 'javascript', (p) => /#!/.test(p.address) || /[?&]_escaped_fragment_/.test(p.address)),
  F('js-ajax-scheme-meta', 'JavaScript', 'Uses Old AJAX Crawling Scheme Meta Fragment Tags', 'javascript', (p) => !!p.hasMetaFragment),
  F('js-warnings', 'JavaScript', 'Pages with JavaScript Warnings', 'javascript', (p) => (p.jsWarnings || []).length > 0),
  F('js-chrome-issues', 'JavaScript', 'Pages with Chrome Issues', 'javascript', (p) => (p.chromeIssues || []).length > 0),
  // ---- Links ----
  F('links-all', 'Links', 'All', 'links', (p) => HTML(p)),
  F('links-high-depth', 'Links', 'Pages With High Crawl Depth', 'links', (p) => (p.depth || 0) >= 5),
  F('links-no-outlinks', 'Links', 'Pages Without Internal Outlinks', 'links', (p) => isHtml200(p) && (p.internalOutlinks || 0) === 0),
  F('links-nofollow-out', 'Links', 'Internal Nofollow Outlinks', 'links', (p) => (p.links || []).some((l) => !l.follow && !l.external)),
  F('links-no-anchor', 'Links', 'Internal Outlinks With No Anchor Text', 'links', (p) => (p.links || []).some((l) => !l.external && !(l.anchor || '').trim())),
  F('links-nondesc-anchor', 'Links', 'Non-Descriptive Anchor Text in Internal Outlinks', 'links', (p) => (p.links || []).some((l) => !l.external && NONDESCRIPTIVE.has((l.anchor || '').trim().toLowerCase()))),
  F('links-high-external', 'Links', 'Pages With High External Outlinks', 'links', (p) => (p.externalOutlinks || 0) > 50),
  // ---- AMP ----
  F('amp-all', 'AMP', 'All', 'amp', (p) => !!p.ampUrl || !!p.isAmp),
  F('amp-urls', 'AMP', 'AMP URLs', 'amp', (p) => !!p.isAmp),
  F('amp-non-200', 'AMP', 'Non-200 AMP URLs', 'amp', (p) => !!p.isAmp && p.statusCode !== 200),
  F('amp-missing-canonical', 'AMP', 'AMP Missing Canonical', 'amp', (p) => !!p.isAmp && !p.canonical),
  F('amp-linked', 'AMP', 'Pages Linking to AMP', 'amp', (p) => !!p.ampUrl),
  // ---- Structured Data ----
  F('sd-all', 'Structured Data', 'All', 'structured', (p) => HTML(p)),
  F('sd-present', 'Structured Data', 'Contains Structured Data', 'structured', (p) => (p.structuredData || []).length > 0),
  F('sd-missing', 'Structured Data', 'Missing Structured Data', 'structured', (p) => isHtml200(p) && !(p.structuredData || []).length),
  F('sd-warnings', 'Structured Data', 'With Validation Warnings', 'structured', (p) => (p.sdWarnings || []).length > 0),
  F('sd-invalid', 'Structured Data', 'Invalid JSON-LD', 'structured', (p) => (p.structuredData || []).includes('Invalid JSON-LD')),
  // ---- Sitemaps ----
  F('sm-all', 'Sitemaps', 'All', 'sitemaps', () => true),
  F('sm-in-sitemap', 'Sitemaps', 'In Sitemap', 'sitemaps', (p) => !!p.inSitemap),
  F('sm-orphan', 'Sitemaps', 'Orphan URLs (In Sitemap, Not Crawled)', 'sitemaps', (p) => !!p.sitemapOnly),
  F('sm-nonindexable', 'Sitemaps', 'Non-Indexable In Sitemap', 'sitemaps', (p) => !!p.inSitemap && p.indexability !== 'Indexable'),
  F('sm-not-in-sitemap', 'Sitemaps', 'Indexable Not In Sitemap', 'sitemaps', (p) => p.indexability === 'Indexable' && !p.inSitemap && !p.sitemapOnly),
];

const NONDESCRIPTIVE = new Set(['click here', 'here', 'this', 'link', 'read more', 'learn more', 'more', 'go', 'this link', 'page', 'website', 'article', 'info']);

function nonSequential(p, level) {
  const levels = p.headingLevels || [];
  const firstIdx = levels.indexOf(level);
  if (firstIdx < 0) return false;
  // an H2 before any H1, or a heading that skips a level, is non-sequential
  if (level === 2 && (levels.indexOf(1) < 0 || levels.indexOf(1) > firstIdx)) return true;
  for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) return true;
  return false;
}

/* Structured-data warnings (simple, honest required-property checks). */
function sdWarningsFor(p) {
  const out = [];
  for (const item of p.sdItems || []) {
    if (item.parseError) { out.push('Invalid JSON-LD: could not be parsed'); continue; }
    if (item.microdata) continue;
    if (item.type === 'Article' || item.type === 'BlogPosting' || item.type === 'NewsArticle') {
      if (!item.headline) out.push(`${item.type}: missing headline`);
      if (!item.image) out.push(`${item.type}: missing image`);
      if (!item.datePublished) out.push(`${item.type}: missing datePublished`);
    } else if (item.type === 'Product') {
      if (!item.headline) out.push('Product: missing name');
      if (!item.image) out.push('Product: missing image');
      if (!item.offers) out.push('Product: missing offers');
    } else if (item.type === 'FAQPage') {
      if (!item.faqCount) out.push('FAQPage: no Question items in mainEntity');
    }
  }
  return out;
}

function applyFilters(pages, ctx) {
  for (const p of pages) {
    p.sdWarnings = sdWarningsFor(p);
    const matched = [];
    for (const f of FILTERS) { try { if (f.test(p, ctx)) matched.push(f.id); } catch (_) {} }
    p.filters = matched;
  }
}

const FILTER_META = FILTERS.map(({ id, section, name, tab }) => ({ id, section, name, tab }));
const SECTIONS = [...new Set(FILTERS.map((f) => f.section))];

/* ---- Issues catalogue (SF type/priority model) ---- */
const I = (id, name, type, priority, filterId, description) => ({ id, name, type, priority, filterId, description });
const ISSUES = [
  I('iss-4xx', 'Client Error (4xx)', 'Issue', 'High', 'rc-4xx', 'Pages returning a 4xx client error status code. These URLs are broken for visitors and search engines and should be fixed, redirected or removed.'),
  I('iss-5xx', 'Server Error (5xx)', 'Issue', 'High', 'rc-5xx', 'Pages returning a 5xx server error. The server failed to fulfil the request; investigate hosting or application errors.'),
  I('iss-no-response', 'No Response', 'Issue', 'High', 'rc-no-response', 'URLs that did not respond at all (timeout, DNS or connection failure) during the crawl.'),
  I('iss-redirect-loop', 'Redirect Loop', 'Issue', 'High', 'rc-int-loop', 'URLs caught in a redirect loop, so the final page never loads. Point the chain at a single live URL.'),
  I('iss-title-multiple', 'Page Titles: Multiple', 'Issue', 'High', 'title-multiple', 'Pages with more than one page title element. Only one title should exist per page, inside the head.'),
  I('iss-title-missing', 'Page Titles: Missing', 'Issue', 'High', 'title-missing', 'Pages with no page title. Titles are a primary on-page ranking element and the clickable text in search results.'),
  I('iss-h1-missing', 'H1: Missing', 'Issue', 'High', 'h1-missing', 'Pages with no H1 heading. Every indexable page should have a single, descriptive H1.'),
  I('iss-multiple-canonical', 'Canonicals: Multiple', 'Issue', 'High', 'can-multiple', 'Pages declaring more than one canonical URL, which can cause search engines to ignore all of them.'),
  I('iss-img-missing-alt', 'Images: Missing Alt Text', 'Issue', 'Low', 'img-missing-alt-text', 'Images whose alt attribute is present but empty, or missing meaningful text. Alt text helps accessibility and image search.'),
  I('iss-img-missing-alt-attr', 'Images: Missing Alt Attribute', 'Issue', 'Low', 'img-missing-alt-attr', 'Images with no alt attribute at all. Add descriptive alt text, or an empty alt for purely decorative images.'),
  I('iss-noindex', 'Directives: Noindex', 'Warning', 'High', 'dir-noindex', 'Pages carrying a noindex directive. They will be removed from the index; confirm this is intentional for each URL.'),
  I('iss-no-outlinks', 'Links: Pages Without Internal Outlinks', 'Warning', 'High', 'links-no-outlinks', 'HTML pages with no internal outlinks. Dead-end pages pass no authority on and give visitors nowhere to go.'),
  I('iss-blocked-robots', 'Blocked by robots.txt', 'Warning', 'High', 'rc-blocked-robots', 'URLs disallowed by robots.txt. Blocked pages cannot be crawled; check none of them should be indexable.'),
  I('iss-redirect-chain', 'Redirect Chain', 'Warning', 'Medium', 'rc-int-chain', 'URLs that redirect through more than one hop. Chains slow users and crawlers and dilute link signals.'),
  I('iss-title-duplicate', 'Page Titles: Duplicate', 'Opportunity', 'Low', 'title-duplicate', 'Pages sharing the same title as another page. Unique titles help search engines tell pages apart.'),
  I('iss-title-long', 'Page Titles: Over 60 Characters', 'Warning', 'Medium', 'title-over-60', 'Titles longer than 60 characters are likely to be truncated in search results.'),
  I('iss-title-short', 'Page Titles: Below 30 Characters', 'Opportunity', 'Medium', 'title-below-30', 'Very short titles may waste an opportunity to describe the page and include relevant terms.'),
  I('iss-title-below-200px', 'Page Titles: Below 200 Pixels', 'Opportunity', 'Medium', 'title-below-200px', 'Titles narrower than 200 pixels in search results are usually too short to be descriptive.'),
  I('iss-title-over-580px', 'Page Titles: Over 580 Pixels', 'Warning', 'Medium', 'title-over-580px', 'Titles wider than 580 pixels will be truncated or rewritten in search results.'),
  I('iss-title-same-h1', 'Page Titles: Same as H1', 'Opportunity', 'Low', 'title-same-h1', 'Pages where the title and H1 are identical. Vary them to target more phrasing and intent.'),
  I('iss-desc-missing', 'Meta Description: Missing', 'Opportunity', 'Low', 'desc-missing', 'Pages with no meta description. Search engines will pick their own snippet text, which may not sell the page.'),
  I('iss-desc-duplicate', 'Meta Description: Duplicate', 'Warning', 'Low', 'desc-duplicate', 'Pages sharing a meta description with another page. Write a unique description per page.'),
  I('iss-desc-long', 'Meta Description: Over 155 Characters', 'Warning', 'Low', 'desc-over-155', 'Meta descriptions over 155 characters are likely to be truncated in search results.'),
  I('iss-desc-short', 'Meta Description: Below 70 Characters', 'Opportunity', 'Low', 'desc-below-70', 'Very short meta descriptions may not describe the page well enough to earn the click.'),
  I('iss-h1-duplicate', 'H1: Duplicate', 'Warning', 'Low', 'h1-duplicate', 'Pages sharing the same H1 as another page.'),
  I('iss-h1-multiple', 'H1: Multiple', 'Warning', 'Low', 'h1-multiple', 'Pages with more than one H1 heading, which can dilute the main topic signal.'),
  I('iss-h2-multiple', 'H2: Multiple', 'Warning', 'Low', 'h2-multiple', 'Pages with more than one H2 heading. Multiple H2s are common in templates; check they structure content sensibly.'),
  I('iss-h2-nonseq', 'H2: Non-Sequential', 'Warning', 'Low', 'h2-non-sequential', 'Pages where H2 headings appear out of sequence (for example before the H1, or skipping levels), harming document structure.'),
  I('iss-h1-nonseq', 'H1: Non-Sequential', 'Warning', 'Low', 'h1-non-sequential', 'Pages where the heading sequence skips levels around the H1.'),
  I('iss-canonicalised', 'Canonicals: Canonicalised', 'Warning', 'Medium', 'can-canonicalised', 'Pages whose canonical points to a different URL, so this URL will not be indexed itself.'),
  I('iss-can-missing', 'Canonicals: Missing', 'Opportunity', 'Low', 'can-missing', 'Indexable pages with no canonical link element. Self-referencing canonicals reduce duplicate-content risk.'),
  I('iss-can-nonindexable', 'Canonicals: Non-Indexable Canonical', 'Warning', 'Medium', 'can-nonindexable', 'Pages canonicalising to a URL that is itself non-indexable (redirect, error or noindex).'),
  I('iss-exact-dup', 'Content: Exact Duplicates', 'Warning', 'Medium', 'content-exact-dup', 'Pages with byte-identical body content (same content hash) as another crawled page.'),
  I('iss-near-dup', 'Content: Near Duplicates', 'Opportunity', 'Low', 'content-near-dup', 'Pages whose content is highly similar (simhash) to another page. Consider consolidating or differentiating them.'),
  I('iss-low-content', 'Content: Low Content Pages', 'Opportunity', 'Low', 'content-low', 'Pages with fewer than 200 words of body content, which may be seen as thin.'),
  I('iss-soft-404', 'Content: Soft 404 Pages', 'Warning', 'Medium', 'content-soft-404', 'Pages returning 200 but looking like error pages (short content with error wording). Return a real 404 or fix the page.'),
  I('iss-lorem', 'Content: Lorem Ipsum Placeholder', 'Warning', 'Medium', 'content-lorem', 'Pages still containing lorem ipsum placeholder text.'),
  I('iss-readability', 'Content: Readability Difficult', 'Opportunity', 'Low', 'content-read-difficult', 'Pages whose Flesch reading-ease score is in the Difficult band (30-60). Simplify sentences for a wider audience.'),
  I('iss-spelling', 'Content: Spelling Errors', 'Warning', 'Low', 'content-spelling', 'Pages with words flagged by the basic dictionary spell check. The checker is approximate and may flag brand or technical terms.'),
  I('iss-orphan', 'Orphan Pages (No Inlinks)', 'Warning', 'Medium', null, 'Indexable HTML pages with no internal inlinks found in the crawl and not present in a sitemap. They can only be found via the sitemap or external links.'),
  I('iss-unsafe-xorigin', 'Security: Unsafe Cross-Origin Links', 'Warning', 'Low', 'sec-unsafe-xorigin', 'Links opening a new tab (target=_blank) to another origin without rel=noopener or noreferrer, a tabnabbing risk.'),
  I('iss-hsts', 'Security: Missing HSTS Header', 'Warning', 'Low', 'sec-hsts', 'HTTPS pages served without a Strict-Transport-Security header, so browsers are not forced onto HTTPS.'),
  I('iss-csp', 'Security: Missing Content-Security-Policy Header', 'Warning', 'Low', 'sec-csp', 'HTTPS pages served without a Content-Security-Policy header, which helps mitigate XSS and data injection.'),
  I('iss-xfo', 'Security: Missing X-Frame-Options Header', 'Warning', 'Low', 'sec-xfo', 'HTTPS pages served without an X-Frame-Options header, leaving them open to clickjacking.'),
  I('iss-xcto', 'Security: Missing X-Content-Type-Options Header', 'Warning', 'Low', 'sec-xcto', 'HTTPS pages served without X-Content-Type-Options: nosniff, so browsers may MIME-sniff responses.'),
  I('iss-referrer', 'Security: Missing Secure Referrer-Policy Header', 'Warning', 'Low', 'sec-referrer', 'HTTPS pages served without a Referrer-Policy header, so full URLs may leak to third parties.'),
  I('iss-bad-ct', 'Security: Bad Content Type', 'Warning', 'Low', 'sec-bad-content-type', 'Pages whose served Content-Type does not match what the URL appears to be (for example HTML served as a non-HTML type, or a missing Content-Type).'),
  I('iss-mixed', 'Security: Mixed Content', 'Warning', 'Medium', 'sec-mixed', 'HTTPS pages referencing insecure http:// resources, which browsers may block or warn about.'),
  I('iss-insecure', 'Insecure Pages (HTTP)', 'Warning', 'Medium', 'sec-http', 'Pages served over plain HTTP. Migrate to HTTPS to avoid browser warnings and mixed signals.'),
  I('iss-high-ext-out', 'Links: Pages With High External Outlinks', 'Warning', 'Low', 'links-high-external', 'Pages linking out to more than 50 unique external URLs, which can leak attention and look like link lists.'),
  I('iss-high-depth', 'Links: Pages With High Crawl Depth', 'Opportunity', 'Low', 'links-high-depth', 'Pages five or more clicks from the start URL. Important pages should sit closer to the homepage.'),
  I('iss-nondesc-anchor', 'Links: Non-Descriptive Anchor Text', 'Opportunity', 'Low', 'links-nondesc-anchor', 'Internal links using anchors like "click here" or "read more", which tell users and engines nothing about the target.'),
  I('iss-no-anchor', 'Links: Internal Outlinks With No Anchor Text', 'Warning', 'Low', 'links-no-anchor', 'Internal links with empty anchor text (often image links without alt text).'),
  I('iss-img-oversized', 'Images: Over 100 KB', 'Opportunity', 'Low', 'img-over-100kb', 'Images larger than 100 KB, which can slow page loads, especially on mobile connections.'),
  I('iss-img-size-attrs', 'Images: Missing Size Attributes', 'Opportunity', 'Low', 'img-missing-size-attrs', 'Images without width and height attributes, which can cause layout shift (CLS) while pages load.'),
  I('iss-img-alt-long', 'Images: Alt Text Over 100 Characters', 'Opportunity', 'Low', 'img-alt-over-100', 'Alt text longer than 100 characters; screen readers may cut it off. Keep alt text concise.'),
  I('iss-url-long', 'URL: Over 115 Characters', 'Opportunity', 'Low', 'url-over-115', 'URLs longer than 115 characters are hard to read, share and display in search results.'),
  I('iss-url-uppercase', 'URL: Uppercase Characters', 'Warning', 'Low', 'url-uppercase', 'URLs containing uppercase characters, which can cause duplicate URLs on case-sensitive servers.'),
  I('iss-url-underscore', 'URL: Underscores', 'Opportunity', 'Low', 'url-underscores', 'URLs using underscores in the path; hyphens are the recommended word separator.'),
  I('iss-url-nonascii', 'URL: Non-ASCII Characters', 'Warning', 'Low', 'url-nonascii', 'URLs containing non-ASCII characters, which get percent-encoded and can break when shared.'),
  I('iss-url-params', 'URL: Parameters', 'Opportunity', 'Low', 'url-parameters', 'URLs with query-string parameters, which can create crawl and duplication issues at scale.'),
  I('iss-hreflang', 'Hreflang: Missing Return Links or Invalid Codes', 'Warning', 'Medium', 'hl-missing-return', 'Pages whose hreflang annotations are not returned by the target page, or use invalid language/region codes. Unreturned hreflang is ignored.'),
  I('iss-sd-warnings', 'Structured Data: Validation Warnings', 'Warning', 'Low', 'sd-warnings', 'Pages whose structured data is missing commonly required properties for its type (basic checks only, not a full schema.org validation).'),
  I('iss-redirect', 'Redirect (3xx)', 'Warning', 'Low', 'rc-3xx', 'URLs answering with a 3xx redirect. Internal links should point directly at the final URL where possible.'),
  I('iss-nofollow-dir', 'Directives: Nofollow', 'Opportunity', 'Low', 'dir-nofollow', 'Pages carrying a nofollow directive, so crawlers will not follow their links.'),
];

function summariseIssues(pages) {
  const total = pages.length || 1;
  const out = [];
  for (const iss of ISSUES) {
    let count;
    if (iss.id === 'iss-orphan') count = pages.filter((p) => p.isOrphan).length;
    else count = pages.filter((p) => (p.filters || []).includes(iss.filterId)).length;
    if (count > 0) out.push({ id: iss.id, name: iss.name, type: iss.type, priority: iss.priority, filterId: iss.filterId, description: iss.description, count, pct: Math.round((count / total) * 1000) / 10 });
  }
  const order = { High: 0, Medium: 1, Low: 2 };
  return out.sort((a, b) => (order[a.priority] - order[b.priority]) || (b.count - a.count));
}

module.exports = { FILTERS, FILTER_META, SECTIONS, ISSUES, buildFilterContext, applyFilters, summariseIssues, categoryOf, countMap, sdWarningsFor, NONDESCRIPTIVE };
