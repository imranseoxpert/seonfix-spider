'use strict';
/* v2 filter registry: the single source of truth for Overview sidebar
 * sections, grid filtering, bulk exports and reports.
 * Each filter: { id, section, name, tab, test(page, ctx) }.
 * During crawl finalisation every page gets `filters: [ids]` = the filters
 * it matches, so sidebar counts and grid filtering always agree.
 * Also holds the Issues catalogue (SF model: type + priority + description),
 * where each issue is backed by a filter id. */
const { classifyInternal } = require('./urlutil');
const { A11Y_CHECKS } = require('./accessibility');

const HTML = (p) => /text\/html|xhtml/.test(p.contentType || '') || (p.contentCategory === 'HTML');
const isHtml200 = (p) => ((p.finalStatusCode === 200 || p.statusCode === 200) && HTML(p) && !p.resourceOnly) || !!p.serpOnly;
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
  // broken bookmarks: links to url#fragment where the target page has no matching id/name
  ctx.brokenBookmarks = new Map();
  for (const p of pages) {
    for (const l of p.links || []) {
      if (!l.fragment || l.external) continue;
      const t = ctx.byUrl.get(l.url);
      if (!t || !Array.isArray(t.anchorIds)) continue;
      if (!t.anchorIds.includes(l.fragment) && l.fragment !== 'top') { if (!ctx.brokenBookmarks.has(p.address)) ctx.brokenBookmarks.set(p.address, []); ctx.brokenBookmarks.get(p.address).push(l.url + '#' + l.fragment); }
    }
  }
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
  F('rc-no-response', 'Response Codes', 'No Response', 'responses', (p) => !p.statusCode && !p.sitemapOnly && !p.serpOnly && p.indexabilityReason !== 'Blocked by robots.txt'),
  F('rc-2xx', 'Response Codes', 'Success (2xx)', 'responses', sec200),
  F('rc-3xx', 'Response Codes', 'Redirection (3xx)', 'responses', (p) => p.statusCode >= 300 && p.statusCode < 400 && !p.metaRefresh),
  F('rc-3xx-js', 'Response Codes', 'Redirection (JavaScript)', 'responses', (p) => !!p.jsRedirect),
  F('rc-3xx-meta', 'Response Codes', 'Redirection (Meta Refresh)', 'responses', (p) => !!p.metaRefresh),
  F('rc-4xx', 'Response Codes', 'Client Error (4xx)', 'responses', (p) => p.statusCode >= 400 && p.statusCode < 500),
  F('rc-5xx', 'Response Codes', 'Server Error (5xx)', 'responses', (p) => p.statusCode >= 500),
  F('rc-int-all', 'Response Codes', 'Internal All', 'responses', (p) => !p.external),
  F('rc-int-blocked-robots', 'Response Codes', 'Internal Blocked by Robots.txt', 'responses', (p) => !p.external && p.indexabilityReason === 'Blocked by robots.txt'),
  F('rc-int-blocked-resource', 'Response Codes', 'Internal Blocked Resource', 'responses', (p) => !p.external && (p.blockedResources || []).length > 0),
  F('rc-int-no-response', 'Response Codes', 'Internal No Response', 'responses', (p) => !p.external && !p.statusCode && !p.sitemapOnly && !p.serpOnly && p.indexabilityReason !== 'Blocked by robots.txt'),
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
  F('url-broken-bookmarks', 'URL', 'Broken Bookmarks', 'url', (p, ctx) => ctx.brokenBookmarks.has(p.address)),
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
  F('content-grammar', 'Content', 'Grammar Errors', 'content', (p) => (p.grammarErrors || 0) > 0),
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
  F('img-missing-title', 'Images', 'Missing Image Title', 'images', (p) => (p.images || []).some((i) => i.title === undefined || i.title === null)),
  F('img-not-nextgen', 'Images', 'Not Next-Gen Format (JPG/PNG/GIF)', 'images', (p) => (p.images || []).some((i) => ['jpg', 'jpeg', 'png', 'gif', 'bmp'].includes(i.format))),
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
  F('hl-self-only', 'Hreflang', 'Self Reference Only', 'hreflang', (p) => (p.hreflang || []).length > 0 && (p.hreflang || []).every((h) => h.url === p.address)),
  F('hl-lang-mismatch', 'Hreflang', 'Mismatch With HTML Lang Attribute', 'hreflang', (p) => { const self = (p.hreflang || []).find((h) => h.url === p.address && String(h.lang).toLowerCase() !== 'x-default'); return !!self && !!p.htmlLang && String(self.lang).toLowerCase().split('-')[0] !== String(p.htmlLang).toLowerCase().split('-')[0]; }),
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
  F('links-empty-anchor', 'Links', 'Pages With Empty Anchor Tags', 'links', (p) => (p.links || []).some((l) => l.emptyAnchor)),
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
  // ---- PageSpeed (filled once scores are fetched from the API sidebar tab) ----
  F('psi-all', 'PageSpeed', 'All', 'pagespeed', (p) => typeof p.psiScore === 'number'),
  F('psi-good', 'PageSpeed', 'Good (90-100)', 'pagespeed', (p) => typeof p.psiScore === 'number' && p.psiScore >= 90),
  F('psi-ni', 'PageSpeed', 'Needs Improvement (50-89)', 'pagespeed', (p) => typeof p.psiScore === 'number' && p.psiScore >= 50 && p.psiScore < 90),
  F('psi-poor', 'PageSpeed', 'Poor (0-49)', 'pagespeed', (p) => typeof p.psiScore === 'number' && p.psiScore < 50),
  // ---- Custom Search / Custom Extraction ----
  F('cs-all', 'Custom Search', 'All', 'search', (p) => !!p.searchMatches && Object.keys(p.searchMatches).length > 0),
  F('cs-match', 'Custom Search', 'Pages With A Match', 'search', (p) => Object.values(p.searchMatches || {}).some(Boolean)),
  F('cs-nomatch', 'Custom Search', 'Pages Without A Match', 'search', (p) => !!p.searchMatches && Object.keys(p.searchMatches).length > 0 && !Object.values(p.searchMatches).some(Boolean)),
  F('ce-all', 'Custom Extraction', 'All', 'extraction', (p) => !!p.extractions && Object.keys(p.extractions).length > 0),
  F('ce-has', 'Custom Extraction', 'With Extracted Data', 'extraction', (p) => Object.values(p.extractions || {}).some((v) => String(v || '').trim())),
  F('ce-empty', 'Custom Extraction', 'Without Extracted Data', 'extraction', (p) => !!p.extractions && Object.keys(p.extractions).length > 0 && !Object.values(p.extractions).some((v) => String(v || '').trim())),
  // ---- Analytics / Search Console (need a Google connection; stay empty until connected) ----
  F('ga-all', 'Analytics', 'All', 'analytics', (p) => !!p.ga),
  F('gsc-all', 'Search Console', 'All', 'searchconsole', (p) => !!p.gsc),
  // ---- Accessibility (static WCAG checks) ----
  F('a11y-all', 'Accessibility', 'All', 'accessibility', (p) => HTML(p) && !!p.a11y),
  F('a11y-any', 'Accessibility', 'Pages With Violations', 'accessibility', (p) => (p.a11yViolations || 0) > 0),
  ...A11Y_CHECKS.map((c) => F('a11y-' + c.id, 'Accessibility', c.name, 'accessibility', (p) => ((p.a11y || {})[c.id] || {}).count > 0)),
  // ---- Social (Open Graph + X Cards) ----
  F('soc-all', 'Social', 'All', 'social', (p) => HTML(p) && !!p.social),
  F('soc-og-missing', 'Social', 'Open Graph Tags Missing', 'social', (p) => isHtml200(p) && !!p.social && !p.social.ogTitle && !p.social.ogDescription && !p.social.ogImage),
  F('soc-og-incomplete', 'Social', 'Open Graph Incomplete (title, description, image or url)', 'social', (p) => !!p.social && !!(p.social.ogTitle || p.social.ogImage || p.social.ogDescription) && !(p.social.ogTitle && p.social.ogDescription && p.social.ogImage && p.social.ogUrl)),
  F('soc-og-image-missing', 'Social', 'og:image Missing', 'social', (p) => isHtml200(p) && !!p.social && !p.social.ogImage),
  F('soc-og-image-non200', 'Social', 'og:image Not 200', 'social', (p, ctx) => { const u = (p.social || {}).ogImage; const t = u && ctx.byUrl.get(u); return !!t && !!t.statusCode && t.statusCode !== 200; }),
  F('soc-og-image-small', 'Social', 'og:image Smaller Than 1200x630', 'social', (p, ctx) => { const so = p.social || {}; const t = so.ogImage && ctx.byUrl.get(so.ogImage); const w = Number(so.ogImageWidth) || (t && t.imageWidth) || 0; const h = Number(so.ogImageHeight) || (t && t.imageHeight) || 0; return !!so.ogImage && w > 0 && h > 0 && (w < 1200 || h < 630); }),
  F('soc-og-url-mismatch', 'Social', 'og:url Does Not Match Canonical', 'social', (p) => !!(p.social || {}).ogUrl && !!(p.canonical || p.address) && (p.social.ogUrl.replace(/\/$/, '') !== (p.canonical || p.address).replace(/\/$/, ''))),
  F('soc-tw-missing', 'Social', 'X Card Missing', 'social', (p) => isHtml200(p) && !!p.social && !p.social.twitterCard),
  F('soc-tw-incomplete', 'Social', 'X Card Incomplete', 'social', (p) => !!(p.social || {}).twitterCard && !((p.social.twitterTitle || p.social.ogTitle) && (p.social.twitterImage || p.social.ogImage))),
  // ---- Mobile ----
  F('mob-all', 'Mobile', 'All', 'mobile', (p) => HTML(p) && p.viewport !== undefined),
  F('mob-viewport-missing', 'Mobile', 'Viewport Not Set', 'mobile', (p) => isHtml200(p) && p.viewport !== undefined && !p.viewport),
  F('mob-viewport-not-responsive', 'Mobile', 'Viewport Not Device Width', 'mobile', (p) => !!p.viewport && !/width\s*=\s*device-width/i.test(p.viewport)),
  F('mob-zoom-disabled', 'Mobile', 'Zoom Disabled', 'mobile', (p) => (((p.a11y || {})['meta-viewport']) || {}).count > 0),
  F('mob-alternate', 'Mobile', 'Has Mobile Alternate', 'mobile', (p) => !!p.mobileAlternate),
  // ---- Validation ----
  F('val-all', 'Validation', 'All', 'validation', (p) => HTML(p) && !!p.validation),
  F('val-invalid-head', 'Validation', 'Invalid HTML Elements In <head>', 'validation', (p) => ((p.validation || {}).invalidInHead || []).length > 0),
  F('val-missing-head', 'Validation', '<head> Missing', 'validation', (p) => !!(p.validation || {}).missingHead),
  F('val-multiple-head', 'Validation', 'Multiple <head>', 'validation', (p) => !!(p.validation || {}).multipleHead),
  F('val-missing-body', 'Validation', '<body> Missing', 'validation', (p) => !!(p.validation || {}).missingBody),
  F('val-multiple-body', 'Validation', 'Multiple <body>', 'validation', (p) => !!(p.validation || {}).multipleBody),
  F('val-body-before-head', 'Validation', '<body> Before <head>', 'validation', (p) => !!(p.validation || {}).bodyBeforeHead),
  F('val-missing-html', 'Validation', '<html> Missing', 'validation', (p) => !!(p.validation || {}).missingHtml),
  F('val-over-15mb', 'Validation', 'HTML Over 15MB (Google stops reading)', 'validation', (p) => !!(p.validation || {}).over15mb || !!p.truncatedOverMaxSize),
  // ---- AI Readiness (beyond SF) ----
  F('ai-all', 'AI Readiness', 'All', 'aireadiness', (p) => HTML(p) && Array.isArray(p.aiBlockedBots)),
  F('ai-blocked-some', 'AI Readiness', 'Blocked For Some AI Crawlers', 'aireadiness', (p) => (p.aiBlockedBots || []).length > 0),
  F('ai-blocked-search', 'AI Readiness', 'Blocked For AI Search (OAI-SearchBot / Claude-SearchBot / PerplexityBot)', 'aireadiness', (p) => (p.aiBlockedBots || []).some((b) => ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot'].includes(b))),
  F('ai-noai', 'AI Readiness', 'noai / noimageai Directive', 'aireadiness', (p) => (p.directives || []).some((d) => d === 'noai' || d === 'noimageai')),
  F('ai-nosnippet', 'AI Readiness', 'nosnippet (excluded from AI Overviews)', 'aireadiness', (p) => (p.directives || []).some((d) => d === 'nosnippet')),
  F('ai-no-sd', 'AI Readiness', 'Indexable Without Structured Data', 'aireadiness', (p) => Array.isArray(p.aiBlockedBots) && isHtml200(p) && p.indexability === 'Indexable' && !(p.structuredData || []).length),
  F('ai-thin', 'AI Readiness', 'Thin Content For AI Answers (<300 words)', 'aireadiness', (p) => Array.isArray(p.aiBlockedBots) && isHtml200(p) && p.indexability === 'Indexable' && (p.wordCount || 0) < 300),
  // ---- AI prompts (Configuration > API Access > AI) ----
  F('aip-all', 'AI', 'All', 'ai', (p) => HTML(p) && !!p.ai),
  F('aip-has', 'AI', 'With AI Results', 'ai', (p) => Object.values(p.ai || {}).some((v) => String(v || '').trim() && !String(v).startsWith('ERROR:'))),
  F('aip-errors', 'AI', 'AI Errors', 'ai', (p) => Object.values(p.ai || {}).some((v) => String(v || '').startsWith('ERROR:'))),
  // ---- Spelling & Grammar ----
  F('sg-all', 'Spelling & Grammar', 'All', 'spelling', (p) => HTML(p) && !p.external),
  F('sg-spelling', 'Spelling & Grammar', 'Spelling Errors', 'spelling', (p) => (p.spellingErrors || 0) > 0),
  F('sg-grammar', 'Spelling & Grammar', 'Grammar Errors', 'spelling', (p) => (p.grammarErrors || 0) > 0),
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

/* External URLs are only status-checked, never parsed, so (like Screaming
 * Frog) they only appear in the Crawl Data External and Response Codes
 * sections; every on-page section covers internal URLs only. */
const EXTERNAL_SECTIONS = new Set(['Crawl Data External', 'Response Codes']);
function applyFilters(pages, ctx) {
  for (const p of pages) {
    p.sdWarnings = sdWarningsFor(p);
    const matched = [];
    for (const f of FILTERS) {
      if (p.external && !EXTERNAL_SECTIONS.has(f.section)) continue;
      try { if (f.test(p, ctx)) matched.push(f.id); } catch (_) {}
    }
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
  I('iss-grammar', 'Content: Grammar Errors', 'Opportunity', 'Low', 'content-grammar', 'Pages where the built-in grammar rules found likely mistakes, such as repeated words, "a" before a vowel sound or a sentence starting in lowercase.'),
  I('iss-h2-missing', 'H2: Missing', 'Opportunity', 'Low', 'h2-missing', 'Indexable pages with no H2 heading. Subheadings break content into scannable sections and help search engines understand its structure.'),
  I('iss-h1-long', 'H1: Over 70 Characters', 'Opportunity', 'Low', 'h1-over-70', 'Pages whose first H1 is longer than 70 characters. Long headings are harder to scan and often dilute the page focus.'),
  I('iss-desc-multiple', 'Meta Description: Multiple', 'Issue', 'Medium', 'desc-multiple', 'Pages with more than one meta description tag. Search engines may pick either one, or ignore both.'),
  I('iss-can-relative', 'Canonicals: Canonical Is Relative', 'Opportunity', 'Low', 'can-relative', 'Pages whose canonical link uses a relative URL. Relative canonicals work but are easy to break and can point at the wrong host or protocol.'),
  I('iss-can-unlinked', 'Canonicals: Unlinked', 'Opportunity', 'Low', 'can-unlinked', 'Canonical URLs that were only discovered through the canonical tag and are not linked anywhere else on the site.'),
  I('iss-pg-non200', 'Pagination: Non-200 Pagination URLs', 'Warning', 'Medium', 'pg-non-200', 'Pages whose rel="next" or rel="prev" points at a URL that does not return a 200 status code.'),
  I('iss-sm-nonindexable', 'Sitemaps: Non-Indexable URLs in Sitemap', 'Warning', 'Medium', 'sm-nonindexable', 'URLs listed in the XML sitemap that are not indexable (redirects, errors, noindex or canonicalised).'),
  I('iss-sm-orphan', 'Sitemaps: Orphan URLs', 'Warning', 'Medium', 'sm-orphan', 'URLs listed in the XML sitemap that were not found by following internal links during the crawl.'),
  I('iss-js-errors', 'JavaScript: Pages with JavaScript Errors', 'Warning', 'Medium', 'js-errors', 'Pages that logged JavaScript errors in the console while being rendered.'),
  I('iss-a11y-lang', 'Accessibility: Missing Page Language', 'Issue', 'Medium', 'a11y-html-lang', 'Pages whose <html> element has no lang attribute, so screen readers cannot pick the right pronunciation.'),
  I('iss-a11y-link-name', 'Accessibility: Links Without Discernible Text', 'Issue', 'Medium', 'a11y-link-name', 'Links with no text, aria-label, title or image alt text, so assistive technology cannot announce where they go.'),
  I('iss-a11y-button-name', 'Accessibility: Buttons Without Discernible Text', 'Issue', 'Medium', 'a11y-button-name', 'Buttons with no visible text or accessible name.'),
  I('iss-a11y-label', 'Accessibility: Form Fields Without Labels', 'Issue', 'Medium', 'a11y-label', 'Form inputs, selects and text areas that have no associated label, aria-label or title.'),
  I('iss-a11y-duplicate-id', 'Accessibility: Duplicate ID Attributes', 'Warning', 'Low', 'a11y-duplicate-id', 'Pages where the same id attribute is used on more than one element, which can break labels and ARIA references.'),
  I('iss-a11y-empty-heading', 'Accessibility: Empty Headings', 'Warning', 'Low', 'a11y-empty-heading', 'Heading elements with no text content, which confuse screen-reader heading navigation.'),
  I('iss-a11y-frame-title', 'Accessibility: Iframes Without Title', 'Warning', 'Low', 'a11y-frame-title', 'Iframes with no title attribute describing their content.'),
  I('iss-a11y-viewport', 'Accessibility: Zooming Disabled', 'Warning', 'Medium', 'a11y-meta-viewport', 'Pages whose viewport meta tag stops users from zooming (user-scalable=no or a low maximum-scale).'),
  I('iss-img-title', 'Images: Missing Image Title', 'Opportunity', 'Low', 'img-missing-title', 'Images without a title attribute. Titles are optional but can add context in some browsers and image search.'),
  I('iss-img-nextgen', 'Images: Not Next-Gen Format', 'Opportunity', 'Medium', 'img-not-nextgen', 'Images served as JPG, PNG or GIF. Modern formats such as WebP and AVIF are usually 25-50% smaller at the same quality.'),
  I('iss-hl-self-only', 'Hreflang: Self Reference Only', 'Warning', 'Low', 'hl-self-only', 'Pages whose hreflang annotations only reference the page itself, so they do not point search engines at any alternate version.'),
  I('iss-hl-lang-mismatch', 'Hreflang: Mismatch With HTML Lang Attribute', 'Warning', 'Low', 'hl-lang-mismatch', 'Pages whose self-referencing hreflang language differs from the language declared in the <html lang> attribute.'),
  I('iss-empty-anchor', 'Links: Pages With Empty Anchor Tags', 'Warning', 'Low', 'links-empty-anchor', 'Pages containing <a> links with no text, image, aria-label or title, so neither users nor search engines know where they lead.'),
  I('iss-broken-bookmarks', 'URL: Broken Bookmarks', 'Warning', 'Low', 'url-broken-bookmarks', 'Internal links to a #fragment that does not exist as an id or name on the target page, so the link lands at the top of the page instead.'),
  I('iss-og-missing', 'Social: Open Graph Tags Missing', 'Opportunity', 'Low', 'soc-og-missing', 'Pages without Open Graph tags. Social networks and messaging apps then guess the title, description and image when the page is shared.'),
  I('iss-og-incomplete', 'Social: Open Graph Incomplete', 'Warning', 'Low', 'soc-og-incomplete', 'Pages with some Open Graph tags but missing at least one of og:title, og:description, og:image or og:url.'),
  I('iss-og-image-non200', 'Social: og:image Not 200', 'Issue', 'Medium', 'soc-og-image-non200', 'The og:image URL does not return a 200 status, so shares show no image.'),
  I('iss-og-image-small', 'Social: og:image Too Small', 'Opportunity', 'Low', 'soc-og-image-small', 'og:image is smaller than the recommended 1200x630 pixels, so large share cards may be blurry or fall back to small previews.'),
  I('iss-tw-incomplete', 'Social: X Card Incomplete', 'Warning', 'Low', 'soc-tw-incomplete', 'Pages declaring an X (Twitter) card without a title or image (directly or via Open Graph fallbacks).'),
  I('iss-viewport-missing', 'Mobile: Viewport Not Set', 'Issue', 'High', 'mob-viewport-missing', 'HTML pages without a viewport meta tag. Mobile browsers render them at desktop width, which hurts mobile usability.'),
  I('iss-viewport-width', 'Mobile: Viewport Not Device Width', 'Warning', 'Medium', 'mob-viewport-not-responsive', 'The viewport meta tag does not use width=device-width, so the page may not scale correctly on phones.'),
  I('iss-val-head', 'Validation: Invalid HTML Elements In <head>', 'Issue', 'High', 'val-invalid-head', 'Body elements (such as <img>, <div> or <iframe>) appear inside <head>. Browsers and Google close the <head> early when they meet them, so tags that follow (canonical, hreflang, meta robots) can be ignored.'),
  I('iss-val-multi-head', 'Validation: Multiple <head>', 'Warning', 'Medium', 'val-multiple-head', 'Pages with more than one <head> element.'),
  I('iss-val-multi-body', 'Validation: Multiple <body>', 'Warning', 'Medium', 'val-multiple-body', 'Pages with more than one <body> element.'),
  I('iss-val-missing-head', 'Validation: <head> Missing', 'Warning', 'Medium', 'val-missing-head', 'Pages with no <head> element in the source.'),
  I('iss-ai-blocked-search', 'AI Readiness: Blocked For AI Search', 'Warning', 'High', 'ai-blocked-search', 'robots.txt blocks AI search crawlers (OAI-SearchBot, Claude-SearchBot or PerplexityBot) from these pages, so they cannot be cited in ChatGPT, Claude or Perplexity answers.'),
  I('iss-ai-blocked-some', 'AI Readiness: Blocked For Some AI Crawlers', 'Opportunity', 'Low', 'ai-blocked-some', 'robots.txt blocks at least one AI crawler from these pages. This is often intentional for training bots; check it matches your AI policy.'),
  I('iss-ai-no-sd', 'AI Readiness: Indexable Without Structured Data', 'Opportunity', 'Low', 'ai-no-sd', 'Indexable pages without any structured data. Schema markup helps search engines and AI systems understand entities, products, articles and FAQs.'),
  I('iss-a11y-tabindex', 'Accessibility: Positive Tabindex', 'Warning', 'Low', 'a11y-tabindex', 'Elements with a tabindex above 0, which overrides the natural keyboard focus order.'),
];

/* "How To Fix" guidance shown under Issue Details (Issues sidebar tab). */
const HOW_TO_FIX = {
  'iss-4xx': 'Update internal links to point at a live URL, restore the page if it was removed by mistake, or 301 redirect the URL to the most relevant live page. Check Inlinks in the bottom pane to see which pages link to it.',
  'iss-5xx': 'Check server logs and hosting resources at the time of the crawl. Re-crawl the URLs to confirm whether the errors are intermittent, and lower crawl speed if the server struggles under load.',
  'iss-no-response': 'Confirm the URL resolves in a browser and that DNS, SSL and firewall or CDN settings are not blocking requests. Increase the request timeout in Configuration > Spider > Limits if the server is slow.',
  'iss-redirect-loop': 'Follow the chain in the HTTP Headers tab and change the redirect rules so each URL redirects once, straight to a final URL that returns 200.',
  'iss-title-multiple': 'Remove the extra <title> tags from the page HTML so the page has a single, concise and descriptive title in the <head>. Multiple titles usually come from conflicting plugins or theme templates.',
  'iss-title-missing': 'Add a unique, descriptive <title> to every page that describes its main topic and includes its target keyword near the start.',
  'iss-h1-missing': 'Add one H1 per page that clearly describes the page topic. It usually matches the main headline visitors see first.',
  'iss-multiple-canonical': 'Output a single rel="canonical" link per page. Remove the duplicates, which usually come from an SEO plugin and the theme both adding one.',
  'iss-img-missing-alt': 'Add short, descriptive alt text that says what the image shows. Use an empty alt only for purely decorative images.',
  'iss-img-missing-alt-attr': 'Add an alt attribute to every <img>. Describe meaningful images and use alt="" for decorative ones so screen readers skip them.',
  'iss-noindex': 'Review each URL. If it should rank, remove the noindex from the meta robots tag or X-Robots-Tag header. If it should stay out of the index, consider whether internal links to it are needed.',
  'iss-no-outlinks': 'Add contextual internal links from these pages to related pages. If the links only appear after JavaScript runs, turn on JavaScript rendering (Configuration > Spider > Rendering) to check them.',
  'iss-blocked-robots': 'Check the matching Disallow rule in robots.txt. Remove or narrow it if the URLs should be crawled and indexed, and avoid linking internally to URLs you intend to block.',
  'iss-redirect-chain': 'Point each redirect, and every internal link, directly at the final destination URL so there is only one hop.',
  'iss-title-duplicate': 'Write a unique title for each page. For template pages such as categories or pagination, add the distinguishing detail (category name, page number, location).',
  'iss-title-long': 'Shorten the title to around 50-60 characters, keeping the most important words first so they survive truncation.',
  'iss-title-short': 'Expand the title to describe the page better, for example by adding the product type, benefit or brand.',
  'iss-title-below-200px': 'Lengthen the title so it uses more of the available space in search results with useful, relevant wording.',
  'iss-title-over-580px': 'Shorten the title, or use narrower wording, so it fits within roughly 580 pixels and is not cut off.',
  'iss-title-same-h1': 'Keep both relevant, but vary the wording so the title and H1 together cover more of the ways people search for the topic.',
  'iss-desc-missing': 'Write a unique meta description of roughly 120-155 characters that summarises the page and gives a reason to click.',
  'iss-desc-duplicate': 'Write a unique meta description for every important page, or leave templated pages without one rather than repeating the same text.',
  'iss-desc-long': 'Trim the description to around 155 characters, putting the key message first.',
  'iss-desc-short': 'Expand the description with a clear summary of the page and a call to action.',
  'iss-desc-multiple': 'Remove the extra meta description tags so only one remains in the <head>.',
  'iss-h1-duplicate': 'Give each page its own H1 that reflects its unique topic.',
  'iss-h1-multiple': 'Keep one H1 for the main heading and change the others to H2 or lower to reflect the content hierarchy.',
  'iss-h1-long': 'Shorten the H1 so it states the topic concisely.',
  'iss-h2-missing': 'Break longer content into sections with descriptive H2 subheadings.',
  'iss-h2-multiple': 'Multiple H2s are normal. Check they form a logical outline of the page and are not used purely for styling.',
  'iss-h2-nonseq': 'Order headings logically: one H1 first, then H2s, then H3s within them, without skipping levels. Use CSS rather than heading tags for visual styling.',
  'iss-h1-nonseq': 'Make sure the H1 comes before lower-level headings and that no heading levels are skipped.',
  'iss-canonicalised': 'Check the canonical is intended. If the page should be indexed, make its canonical self-referencing. If not, update internal links to point at the canonical URL instead.',
  'iss-can-missing': 'Add a self-referencing rel="canonical" link to each indexable page to consolidate duplicate URL variations such as tracking parameters.',
  'iss-can-nonindexable': 'Point the canonical at the final, indexable 200 version of the URL rather than at a redirect, error or noindexed page.',
  'iss-can-relative': 'Use absolute URLs, including protocol and host, in canonical link elements.',
  'iss-can-unlinked': 'Link to the canonical URL internally, or check whether the canonical is pointing at the wrong URL.',
  'iss-exact-dup': 'Consolidate duplicates with a 301 redirect or a canonical to the preferred URL, or make each page substantially different.',
  'iss-near-dup': 'Review the matching pages (Duplicate Details in the bottom pane). Merge, canonicalise or rewrite them so each page has distinct value.',
  'iss-low-content': 'Expand thin pages with useful, original content, or noindex or merge pages that have no unique purpose.',
  'iss-soft-404': 'Return a real 404 or 410 status code for pages that no longer exist, or restore meaningful content if the page should exist.',
  'iss-lorem': 'Replace the placeholder text with real copy before the page is published or indexed.',
  'iss-readability': 'Use shorter sentences, simpler words and more subheadings and lists to make the content easier to read.',
  'iss-spelling': 'Review the flagged words in the Spelling & Grammar tab of the bottom pane and fix genuine mistakes. Brand and technical terms can be ignored.',
  'iss-grammar': 'Review the flagged phrases in the Spelling & Grammar tab of the bottom pane and correct them in the page copy.',
  'iss-orphan': 'Link to orphan pages from relevant internal pages, or remove them from the sitemap and redirect them if they are no longer needed.',
  'iss-unsafe-xorigin': 'Add rel="noopener" (or rel="noreferrer") to links that use target="_blank" and point at another origin.',
  'iss-hsts': 'Send a Strict-Transport-Security header (for example max-age=31536000; includeSubDomains) from the server or CDN on all HTTPS responses.',
  'iss-csp': 'Define a Content-Security-Policy header that lists the trusted sources for scripts, styles and other resources. Start in report-only mode to avoid breaking the site.',
  'iss-xfo': 'Send X-Frame-Options: SAMEORIGIN (or a CSP frame-ancestors rule) so other sites cannot frame the pages.',
  'iss-xcto': 'Send X-Content-Type-Options: nosniff on all responses.',
  'iss-referrer': 'Send a Referrer-Policy header such as strict-origin-when-cross-origin.',
  'iss-bad-ct': 'Configure the server to send the correct Content-Type header (for HTML pages: text/html; charset=UTF-8).',
  'iss-mixed': 'Change http:// resource URLs to https:// (or protocol-relative to https) and make sure every resource is available over HTTPS.',
  'iss-insecure': 'Move the site to HTTPS, 301 redirect HTTP URLs to their HTTPS versions and update internal links.',
  'iss-high-ext-out': 'Review the external links and remove ones that are not useful to visitors.',
  'iss-high-depth': 'Link to important deep pages from higher-level pages such as the homepage, category pages or navigation, so they are reachable in fewer clicks.',
  'iss-nondesc-anchor': 'Replace generic anchors with text that describes the destination page, for example "SEO audit pricing" rather than "click here".',
  'iss-no-anchor': 'Add descriptive anchor text, or alt text on the image inside the link, so the link destination is clear.',
  'iss-img-oversized': 'Compress the image, serve modern formats such as WebP or AVIF, and size it to the dimensions it is displayed at.',
  'iss-img-size-attrs': 'Add width and height attributes to images so the browser can reserve space and avoid layout shift.',
  'iss-img-alt-long': 'Shorten alt text to a concise description of the image, under about 100 characters.',
  'iss-url-long': 'Use shorter, readable URLs with only the key words. Redirect old URLs if you change them.',
  'iss-url-uppercase': 'Use lowercase URLs, and 301 redirect uppercase variants to the lowercase version.',
  'iss-url-underscore': 'Use hyphens to separate words in new URLs. Only change existing URLs if you can redirect them.',
  'iss-url-nonascii': 'Use ASCII characters in URLs where possible, or make sure the encoded form is used consistently in links.',
  'iss-url-params': 'Avoid linking internally to parameter variations, and use canonicals for parameters that do not change the content.',
  'iss-hreflang': 'Make sure every hreflang target links back with a matching hreflang annotation, uses valid ISO language and region codes, and points at indexable canonical URLs.',
  'iss-sd-warnings': 'Add the missing recommended properties to the structured data and validate it with Google\'s Rich Results Test.',
  'iss-redirect': 'Update internal links to point directly at the final destination URL instead of the redirecting URL.',
  'iss-nofollow-dir': 'Remove the nofollow directive if crawlers should follow the links on these pages.',
  'iss-pg-non200': 'Point rel="next" and rel="prev" at live, 200 status pagination URLs.',
  'iss-sm-nonindexable': 'List only indexable, canonical URLs that return 200 in the XML sitemap.',
  'iss-sm-orphan': 'Link to these URLs from relevant internal pages, or remove them from the sitemap if they should not be indexed.',
  'iss-js-errors': 'Open the Chrome Console Log tab in the bottom pane and fix the errors, prioritising any that stop content or links from rendering.',
  'iss-a11y-lang': 'Add a lang attribute to the <html> element, for example <html lang="en">.',
  'iss-a11y-link-name': 'Give each link visible text, an aria-label, or alt text on its image.',
  'iss-a11y-button-name': 'Add visible text or an aria-label to each button.',
  'iss-a11y-label': 'Associate a <label for="..."> with each field, or add an aria-label when a visible label is not possible.',
  'iss-a11y-duplicate-id': 'Make every id attribute unique on the page.',
  'iss-a11y-empty-heading': 'Remove empty headings or add meaningful text to them.',
  'iss-a11y-frame-title': 'Add a title attribute to each iframe describing its content.',
  'iss-a11y-viewport': 'Remove user-scalable=no and any maximum-scale below 2 from the viewport meta tag.',
  'iss-a11y-tabindex': 'Use tabindex="0" or -1 instead of positive values, and fix the focus order in the HTML source.',
  'iss-img-title': 'Optionally add a short title attribute to important images. Prioritise alt text first; titles are a minor enhancement.',
  'iss-img-nextgen': 'Convert images to WebP or AVIF (most CMS and CDNs can do this automatically) and serve them with <picture> or content negotiation.',
  'iss-hl-self-only': 'Add hreflang annotations for every language or region version of the page (plus x-default), or remove hreflang if there are no alternates.',
  'iss-hl-lang-mismatch': 'Make the <html lang> attribute and the self-referencing hreflang use the same language code.',
  'iss-empty-anchor': 'Add descriptive anchor text, an image with alt text or an aria-label to each empty link, or remove links that have no purpose.',
  'iss-broken-bookmarks': 'Add the missing id to the target section, or update the link to the correct #fragment.',
  'iss-og-missing': 'Add og:title, og:description, og:image and og:url (most SEO plugins can output them from the page title and description).',
  'iss-og-incomplete': 'Add the missing Open Graph properties so every share shows a title, description and image.',
  'iss-og-image-non200': 'Point og:image at a live, publicly accessible image URL that returns 200.',
  'iss-og-image-small': 'Use an og:image of at least 1200x630 pixels (1.91:1 ratio) and declare og:image:width and og:image:height.',
  'iss-tw-incomplete': 'Add twitter:title and twitter:image, or make sure the Open Graph equivalents exist so X can fall back to them.',
  'iss-viewport-missing': 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the <head> of every page.',
  'iss-viewport-width': 'Set width=device-width in the viewport meta tag and make the layout responsive.',
  'iss-val-head': 'Move body elements out of <head> (often injected by tag managers or plugins) and keep only meta, link, title, script, style, base and noscript there. Place critical tags (canonical, hreflang, robots) as early in the <head> as possible.',
  'iss-val-multi-head': 'Remove the duplicate <head> element so the document has exactly one.',
  'iss-val-multi-body': 'Remove the duplicate <body> element so the document has exactly one.',
  'iss-val-missing-head': 'Add an explicit <head> containing the title, meta and link elements.',
  'iss-ai-blocked-search': 'If you want to appear in AI answers, allow OAI-SearchBot, Claude-SearchBot and PerplexityBot in robots.txt (you can still block training bots such as GPTBot and ClaudeBot separately).',
  'iss-ai-blocked-some': 'Review the AI Readiness tab. Decide per bot whether to allow search/answer crawlers and training crawlers, and write explicit User-agent groups for each.',
  'iss-ai-no-sd': 'Add relevant schema.org JSON-LD (Organization, Article, Product, FAQPage, BreadcrumbList and so on) and validate it.',
};

for (const iss of ISSUES) iss.howToFix = HOW_TO_FIX[iss.id] || '';

/* % of Total uses the issue's section "All" count as the base (SF model:
 * e.g. Page Titles: Multiple = 7 of 11 HTML pages = 63.64%). */
const SECTION_ALL = new Map();
for (const f of FILTERS) if (!SECTION_ALL.has(f.section)) SECTION_ALL.set(f.section, f.id);
function summariseIssues(pages, overrides = {}) {
  const out = [];
  for (const base0 of ISSUES) {
    const ov = overrides[base0.id] || {};
    if (ov.disabled) continue;
    const iss = { ...base0, type: ov.type || base0.type, priority: ov.priority || base0.priority };
    let count; let base;
    if (iss.id === 'iss-orphan') { count = pages.filter((p) => p.isOrphan).length; base = pages.filter((p) => !p.external && HTML(p)).length; }
    else {
      count = pages.filter((p) => (p.filters || []).includes(iss.filterId)).length;
      const f = FILTERS.find((x) => x.id === iss.filterId);
      const allId = f ? SECTION_ALL.get(f.section) : null;
      base = allId ? pages.filter((p) => (p.filters || []).includes(allId)).length : pages.length;
    }
    const total = Math.max(base, count, 1);
    if (count > 0) out.push({ id: iss.id, name: iss.name, type: iss.type, priority: iss.priority, filterId: iss.filterId, description: iss.description, howToFix: HOW_TO_FIX[iss.id] || '', count, pct: Math.round((count / total) * 10000) / 100 });
  }
  const order = { High: 0, Medium: 1, Low: 2 };
  return out.sort((a, b) => (order[a.priority] - order[b.priority]) || (b.count - a.count));
}

/* SEO Health Score 0-100 (beyond SF): each issue costs weight x spread,
 * weight = type (Issue 3, Warning 2, Opportunity 1) x priority (3/2/1). */
function healthScore(issues) {
  const tw = { Issue: 3, Warning: 2, Opportunity: 1 }; const pw = { High: 3, Medium: 2, Low: 1 };
  let penalty = 0;
  for (const i of issues || []) penalty += (tw[i.type] || 1) * (pw[i.priority] || 1) * (0.3 + 0.7 * Math.min(1, (i.pct || 0) / 100));
  const score = Math.round(100 * Math.exp(-penalty / 70));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  return { score, grade, penalty: Math.round(penalty * 10) / 10 };
}

module.exports = { healthScore, HOW_TO_FIX, FILTERS, FILTER_META, SECTIONS, ISSUES, buildFilterContext, applyFilters, summariseIssues, categoryOf, countMap, sdWarningsFor, NONDESCRIPTIVE };
