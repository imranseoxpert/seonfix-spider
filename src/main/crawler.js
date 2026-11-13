'use strict';
/* Seonfix Spider crawl engine v2. Pure Node (no Electron imports) so it can
 * be unit/integration tested with `node --test` and reused by a CLI harness.
 * v2: crawl scopes (Subdomain/Subfolder/All Subdomains/Exact URL), resources
 * (CSS/JS/images/fonts) as their own crawl rows, external URLs status-checked
 * once and never followed, cookies, sitemap discovery + orphan detection,
 * Link Score, image natural-size sniffing, filter-registry finalisation. */
const { parseRobots, isAllowed } = require('./robots');
const { parsePage, simhashSimilarity, SECURITY_HEADERS } = require('./extract');
const { buildFilterContext, applyFilters, summariseIssues, categoryOf } = require('./filters');
const { buildAnalysis } = require('./analysis');
const { normalizeUrl, ensureUrl, classifyInternal, crawlDepthOf, shouldInclude, originOf, registrableDomain } = require('./urlutil');

const UA_PRESETS = {
  spider: 'SeonfixSpider/2.1 (Seonfix Spider; +https://seonfix.com/spider)',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'googlebot-smartphone': 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bingbot: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
};

const DEFAULT_CONFIG = {
  mode: 'spider', // spider | list | sitemap | serp
  scope: 'subdomain', // subdomain | subfolder | all-subdomains | exact
  concurrency: 5, delayMs: 0, maxDepth: 0, maxUrls: 10000,
  userAgent: UA_PRESETS.spider, respectRobots: true, customRobotsText: '',
  crawlExternal: true, crawlResources: true, checkImageSizes: true,
  includePatterns: [], excludePatterns: [],
  headers: {}, cookies: '',
  extractors: [], searchRules: [],
  segments: [], spellCheck: true, duplicatesThreshold: 0.92,
  contentAreaPct: 100, basicAuth: null, cdnPatterns: [],
  urlRewrites: [], pagespeedKey: '',
  timeoutMs: 15000, maxRedirects: 10,
  // v2.1 Spider > Crawl options (Screaming Frog defaults)
  crawlImages: true, crawlCss: true, crawlJs: true,
  followInternalNofollow: false, followExternalNofollow: false,
  crawlCanonicals: true, crawlPagination: false, crawlHreflang: false, crawlAmp: false,
  followMetaRefresh: true, crawlIframes: true,
  storeHtml: false, grammarCheck: true,
  contentArea: { include: [], exclude: ['nav', 'footer'] },
  linkPositions: [], formAuth: null,
};

function analyseChain(chain) {
  const seen = new Set(); let loop = false;
  for (const hop of chain || []) { if (seen.has(hop.to)) loop = true; seen.add(hop.from); seen.add(hop.to); }
  return { hops: (chain || []).length, isLoop: loop, isChain: (chain || []).length > 1 };
}

function parseSitemap(xml) {
  const urls = [];
  const locRe = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m;
  while ((m = locRe.exec(String(xml || '')))) {
    const u = normalizeUrl(m[1].replace(/&amp;/g, '&').trim());
    if (u) urls.push(u);
  }
  return [...new Set(urls)];
}

function isSitemapIndex(xml) { return /<sitemapindex[\s>]/i.test(String(xml || '')); }

function xmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function generateSitemap(pages, opts = {}) {
  const { lastmod = new Date().toISOString().slice(0, 10), priority = '0.5', changefreq = 'monthly', onlyIndexable = true } = opts;
  const urls = pages.filter((p) => p.statusCode === 200 && !p.sitemapOnly && (!onlyIndexable || p.indexability === 'Indexable'));
  const body = urls.map((p) => `  <url>\n    <loc>${xmlEscape(p.address)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function generateImageSitemap(pages, opts = {}) {
  const entries = [];
  for (const p of pages) {
    if (p.statusCode !== 200) continue;
    for (const img of p.images || []) entries.push({ page: p.address, img: img.url });
  }
  const byPage = new Map();
  for (const e of entries) { if (!byPage.has(e.page)) byPage.set(e.page, []); byPage.get(e.page).push(e.img); }
  const body = [...byPage.entries()].map(([page, imgs]) =>
    `  <url>\n    <loc>${xmlEscape(page)}</loc>\n${imgs.map((i) => `    <image:image><image:loc>${xmlEscape(i)}</image:loc></image:image>`).join('\n')}\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${body}\n</urlset>\n`;
}

/* Compare mode (SF model): for every filter, how many URLs are in it now
 * and before, split into Added (URL existed before but was not in this
 * filter), New (URL not in the previous crawl at all), Removed (URL still
 * exists but left this filter) and Missing (URL no longer in the crawl). */
function compareCrawls(a, b) {
  const ma = new Map((a.pages || []).map((p) => [p.address, p]));
  const mb = new Map((b.pages || []).map((p) => [p.address, p]));
  const added = [...mb.keys()].filter((u) => !ma.has(u));
  const removed = [...ma.keys()].filter((u) => !mb.has(u));
  const changed = [];
  for (const [u, pa] of ma) {
    const pb = mb.get(u); if (!pb) continue;
    const fields = ['statusCode', 'title', 'metaDescription', 'wordCount', 'indexability', 'canonical', 'h1'];
    const val = (p, f) => (f === 'h1' ? (p.h1s || [])[0] : p[f]);
    const diffs = fields.filter((f) => String(val(pa, f) ?? '') !== String(val(pb, f) ?? '')).map((f) => ({ field: f === 'h1' ? 'H1-1' : f, before: val(pa, f) ?? '', after: val(pb, f) ?? '' }));
    if (diffs.length) changed.push({ address: u, diffs });
  }
  const ia = new Map((a.issues || []).map((i) => [i.name, i.count]));
  const ib = new Map((b.issues || []).map((i) => [i.name, i.count]));
  const issueDeltas = [...new Set([...ia.keys(), ...ib.keys()])].map((name) => ({ name, before: ia.get(name) || 0, after: ib.get(name) || 0, delta: (ib.get(name) || 0) - (ia.get(name) || 0) }));
  const { FILTER_META } = require('./filters');
  const filterDeltas = FILTER_META.map((f) => {
    const prev = new Set((a.pages || []).filter((p) => (p.filters || []).includes(f.id)).map((p) => p.address));
    const cur = new Set((b.pages || []).filter((p) => (p.filters || []).includes(f.id)).map((p) => p.address));
    const r = { id: f.id, section: f.section, name: f.name, tab: f.tab, current: cur.size, previous: prev.size, added: [], newUrls: [], removed: [], missing: [] };
    for (const u of cur) if (!prev.has(u)) (ma.has(u) ? r.added : r.newUrls).push(u);
    for (const u of prev) if (!cur.has(u)) (mb.has(u) ? r.removed : r.missing).push(u);
    return r;
  });
  return { added, removed, changed, issueDeltas, filterDeltas };
}

/* Natural image dimensions from raw bytes (PNG / GIF / JPEG headers). */
function imageDimensions(buf) {
  try {
    if (!buf || buf.length < 10) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }; // PNG
    if (buf[0] === 0x47 && buf[1] === 0x49) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }; // GIF
    if (buf[0] === 0xFF && buf[1] === 0xD8) { // JPEG
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xFF) { off++; continue; }
        const marker = buf[off + 1];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
        }
        off += 2 + buf.readUInt16BE(off + 2);
      }
    }
    return null;
  } catch (_) { return null; }
}

function statusText(code) {
  if (code === 0) return 'No Response';
  if (code >= 200 && code < 300) return 'OK';
  if (code >= 300 && code < 400) return 'Redirect';
  if (code >= 400 && code < 500) return 'Client Error';
  if (code >= 500) return 'Server Error';
  return String(code);
}

function computeIndexability(p) {
  if (p.indexability && p.indexabilityReason === 'Blocked by robots.txt') return;
  if (p.sitemapOnly) { p.indexability = 'Non-Indexable'; p.indexabilityReason = 'Not Crawled'; return; }
  if (p.statusCode === 0 || p.statusCode == null) { p.indexability = 'Non-Indexable'; p.indexabilityReason = 'No Response'; return; }
  if (p.statusCode >= 300 && p.statusCode < 400) { p.indexability = 'Non-Indexable'; p.indexabilityReason = 'Redirected'; return; }
  if (p.statusCode >= 400) { p.indexability = 'Non-Indexable'; p.indexabilityReason = p.statusCode < 500 ? 'Client Error' : 'Server Error'; return; }
  if (/noindex/i.test((p.metaRobots || '') + ' ' + (p.xRobotsTag || ''))) { p.indexability = 'Non-Indexable'; p.indexabilityReason = 'Noindex'; return; }
  if (p.canonical && p.canonical !== p.address) { p.indexability = 'Non-Indexable'; p.indexabilityReason = 'Canonicalised'; return; }
  p.indexability = 'Indexable'; p.indexabilityReason = 'Indexable';
}

/* ---- Finalisation: shared by Crawler.finish(), Open-crawl (Analyse) ---- */
function finalizeCrawl(pages, rootUrl, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const scope = cfg.scope || 'subdomain';
  const internal = (u) => classifyInternal(u, rootUrl, scope) || (cfg.cdnPatterns || []).some((pat) => { try { return new RegExp(pat).test(u); } catch (_) { return u.includes(pat); } });
  for (const p of pages) {
    if (p.sitemapOnly) { p.external = !internal(p.address); continue; }
    p.external = !internal(p.address);
    p.contentCategory = categoryOf(p);
  }
  const crawled = pages.filter((p) => !p.sitemapOnly);
  // link counts
  const inlinkFrom = new Map(); const inlinkCount = new Map();
  for (const p of crawled) {
    const internalOut = new Set(); const externalOut = new Set(); const allOut = new Set();
    for (const l of p.links || []) {
      allOut.add(l.url);
      if (internal(l.url)) internalOut.add(l.url); else externalOut.add(l.url);
      if (!inlinkFrom.has(l.url)) inlinkFrom.set(l.url, new Set());
      inlinkFrom.get(l.url).add(p.address);
      inlinkCount.set(l.url, (inlinkCount.get(l.url) || 0) + 1);
    }
    p.outlinks = allOut.size; p.uniqueOutlinks = allOut.size;
    p.internalOutlinks = internalOut.size; p.externalOutlinks = externalOut.size;
  }
  for (const p of pages) {
    p.inlinks = inlinkCount.get(p.address) || 0;
    p.uniqueInlinks = inlinkFrom.has(p.address) ? inlinkFrom.get(p.address).size : 0;
    if (p.outlinks === undefined) { p.outlinks = 0; p.uniqueOutlinks = 0; p.internalOutlinks = 0; p.externalOutlinks = 0; }
  }
  for (const p of pages) computeIndexability(p);
  // Link Score: simple internal PageRank-style iteration, normalised 0-100.
  const htmlPages = crawled.filter((p) => !p.external);
  const N = Math.max(1, htmlPages.length);
  const score = new Map(htmlPages.map((p) => [p.address, 1]));
  const outInternal = new Map();
  for (const p of htmlPages) outInternal.set(p.address, new Set((p.links || []).filter((l) => internal(l.url)).map((l) => l.url)));
  for (let iter = 0; iter < 20; iter++) {
    const next = new Map();
    for (const p of htmlPages) {
      let sum = 0;
      for (const q of htmlPages) {
        const outs = outInternal.get(q.address);
        if (outs && outs.has(p.address) && outs.size) sum += (score.get(q.address) || 1) / outs.size;
      }
      next.set(p.address, 0.15 + 0.85 * sum);
    }
    for (const [k, v] of next) score.set(k, v);
  }
  const maxScore = Math.max(0.0001, ...score.values());
  for (const p of pages) p.linkScore = score.has(p.address) ? Math.round((score.get(p.address) / maxScore) * 1000) / 10 : 0;
  // near duplicates
  const htmlOk = crawled.filter((p) => (p.finalStatusCode === 200 || p.statusCode === 200) && !p.resourceOnly);
  for (let i = 0; i < htmlOk.length; i++) {
    for (let j = i + 1; j < htmlOk.length; j++) {
      const a = htmlOk[i], b = htmlOk[j];
      if (!a.simhash || !b.simhash || a.hash === b.hash || b.nearDuplicateOf) continue;
      if ((a.wordCount || 0) < 30 || (b.wordCount || 0) < 30) continue;
      if (simhashSimilarity(a.simhash, b.simhash) >= (cfg.duplicatesThreshold || 0.92)) b.nearDuplicateOf = a.address;
    }
  }
  // orphans: indexable HTML, no inlinks, not start, not in a sitemap
  for (const p of pages) {
    p.isOrphan = !p.external && !p.sitemapOnly && (p.contentCategory === 'HTML') && p.statusCode === 200 && (p.uniqueInlinks || 0) === 0 && !p.isStartUrl && !p.inSitemap;
    p.isAmp = false;
  }
  const ampTargets = new Set(pages.map((p) => p.ampUrl).filter(Boolean));
  for (const p of pages) if (ampTargets.has(p.address)) p.isAmp = true;
  const ctx = buildFilterContext(pages, rootUrl, cfg);
  applyFilters(pages, ctx);
  // per-page issue names via the catalogue (kept for grid issue filtering + v1 compat)
  const { issuesForPage } = require('./issues');
  for (const p of pages) p.issues = issuesForPage(p, ctx);
  for (const p of pages) { delete p.text; }
  const issues = summariseIssues(pages);
  const analysis = buildAnalysis(pages, cfg);
  const stats = {
    total: pages.length, crawled: crawled.length,
    internal: pages.filter((p) => !p.external).length,
    external: pages.filter((p) => p.external).length,
    indexable: pages.filter((p) => p.indexability === 'Indexable').length,
    nonIndexable: pages.filter((p) => p.indexability === 'Non-Indexable').length,
    errors4xx: pages.filter((p) => p.statusCode >= 400 && p.statusCode < 500).length,
    errors5xx: pages.filter((p) => p.statusCode >= 500).length,
    redirects: pages.filter((p) => p.statusCode >= 300 && p.statusCode < 400).length,
  };
  return { issues, analysis, stats, ctx };
}

class Crawler {
  constructor(config = {}, hooks = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.userAgentPreset && UA_PRESETS[this.config.userAgentPreset]) this.config.userAgent = UA_PRESETS[this.config.userAgentPreset];
    this.hooks = hooks;
    this.paused = false; this.stopped = false;
    this.pages = new Map(); this.queue = []; this.queued = new Set();
    this.robotsCache = new Map(); this.robotsTextCache = new Map(); this.imageInfo = new Map();
    this.startedAt = Date.now(); this.fetched = 0;
    this.sitemapList = []; this.sitemapUrlSet = new Set();
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  stop() { this.stopped = true; this.paused = false; }

  isInternalUrl(url) {
    const cfg = this.config;
    if (classifyInternal(url, this.rootUrl, cfg.scope || 'subdomain')) return true;
    return (cfg.cdnPatterns || []).some((pat) => { try { return new RegExp(pat).test(url); } catch (_) { return url.includes(pat); } });
  }

  applyRewrites(url) {
    let out = url;
    for (const r of this.config.urlRewrites || []) {
      if (!r || !r.pattern) continue;
      try { out = out.replace(new RegExp(r.pattern), r.replacement || ''); } catch (_) { if (out.includes(r.pattern)) out = out.split(r.pattern).join(r.replacement || ''); }
    }
    return normalizeUrl(out) || url;
  }

  async robotsFor(url) {
    const origin = originOf(url); if (!origin) return null;
    if (this.config.customRobotsText) {
      if (!this._customGroups) this._customGroups = parseRobots(this.config.customRobotsText);
      return this._customGroups;
    }
    if (this.robotsCache.has(origin)) return this.robotsCache.get(origin);
    let groups = [];
    try {
      const r = await fetch(origin + '/robots.txt', { headers: this.reqHeaders(), signal: AbortSignal.timeout(8000) });
      if (r.ok) { const text = await r.text(); this.robotsTextCache.set(origin, text); groups = parseRobots(text); }
    } catch (_) { groups = []; }
    this.robotsCache.set(origin, groups);
    return groups;
  }

  reqHeaders(extra = {}) {
    const headers = { 'User-Agent': this.config.userAgent, Accept: 'text/html,application/xhtml+xml,*/*', ...this.config.headers, ...extra };
    const cookie = [this.config.cookies, this.authCookie].filter(Boolean).join('; ');
    if (cookie) headers.Cookie = cookie;
    if (this.config.basicAuth && this.config.basicAuth.username) {
      headers.Authorization = 'Basic ' + Buffer.from(`${this.config.basicAuth.username}:${this.config.basicAuth.password || ''}`).toString('base64');
    }
    return headers;
  }

  enqueue(url, depth, kind = 'page', isStart = false) {
    url = this.applyRewrites(url);
    if (!url || this.queued.has(url)) return;
    if (this.queued.size >= this.config.maxUrls + 5000) return;
    if (!shouldInclude(url, this.config)) return;
    this.queued.add(url); this.queue.push({ url, depth, kind, isStart });
  }

  async fetchWithRedirects(url) {
    const chain = []; const visited = new Set([url]);
    let current = url; let loop = false; let firstStatus = null;
    const headers = this.reqHeaders();
    for (let hop = 0; hop <= this.config.maxRedirects; hop++) {
      const t0 = Date.now();
      const resp = await fetch(current, { redirect: 'manual', headers, signal: AbortSignal.timeout(this.config.timeoutMs) });
      const responseMs = Date.now() - t0;
      if (firstStatus === null) firstStatus = resp.status;
      const loc = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && loc) {
        const to = normalizeUrl(loc, current);
        chain.push({ from: current, to, status: resp.status, type: 'HTTP' });
        try { await resp.arrayBuffer(); } catch (_) {}
        if (!to) break;
        if (visited.has(to)) { loop = true; current = to; break; }
        visited.add(to); current = to; continue;
      }
      const hdrs = {}; resp.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v; });
      let cookies = [];
      try { cookies = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : (hdrs['set-cookie'] ? [hdrs['set-cookie']] : []); } catch (_) {}
      const buf = Buffer.from(await resp.arrayBuffer());
      return { status: resp.status, firstStatus, headers: hdrs, cookies, body: buf, chain, loop, finalUrl: current, responseMs, size: buf.length };
    }
    return { status: firstStatus || 0, firstStatus, headers: {}, cookies: [], body: Buffer.alloc(0), chain, loop, finalUrl: current, responseMs: 0, size: 0 };
  }

  basePage(url, depth, kind, isStart) {
    return { address: url, isStartUrl: !!isStart, depth, kind, statusCode: 0, status: 'No Response', contentType: '', redirectChain: [], redirectLoop: false, images: [], links: [], resources: [], hreflang: [], structuredData: [], issues: [], cookies: [], external: kind === 'external' };
  }

  async processOne({ url, depth, kind, isStart }) {
    const cfg = this.config;
    const page = this.basePage(url, depth, kind, isStart);
    if (cfg.respectRobots && kind !== 'external') {
      const groups = await this.robotsFor(url);
      const agent = /googlebot/i.test(cfg.userAgent) ? 'googlebot' : /bingbot/i.test(cfg.userAgent) ? 'bingbot' : '*';
      if (groups && groups.length && !isAllowed(groups, agent, url)) {
        page.status = 'Blocked by robots.txt'; page.indexability = 'Non-Indexable'; page.indexabilityReason = 'Blocked by robots.txt';
        this.pages.set(url, page); this.emitPage(page); return page;
      }
    }
    try {
      const r = await this.fetchWithRedirects(url);
      page.statusCode = r.firstStatus; page.finalStatusCode = r.status; page.redirectChain = r.chain;
      page.redirectLoop = r.loop || analyseChain(r.chain).isLoop;
      page.redirectUrl = r.chain.length ? r.finalUrl : '';
      page.redirectType = r.chain.length ? 'HTTP' : '';
      page.responseTimeMs = r.responseMs; page.sizeBytes = r.size;
      page.headers = r.headers; page.cookies = r.cookies || []; page.contentType = r.headers['content-type'] || '';
      page.status = statusText(r.firstStatus);
      page.contentCategory = categoryOf(page);
      // security headers are checked on every internal response (SF model), not just HTML
      if (kind !== 'external' && /^https:/i.test(url)) page.missingSecurityHeaders = SECURITY_HEADERS.filter((h) => !r.headers[h]);
      if (r.chain.length && r.finalUrl !== url && kind !== 'external') this.enqueue(r.finalUrl, depth, 'page');
      const isHtmlType = /text\/html|xhtml/.test(page.contentType) || (!page.contentType && r.body.length && kind === 'page');
      if (isHtmlType && kind === 'page') {
        const html = r.body.toString('utf8');
        page.htmlLength = html.length;
        const parsed = parsePage({ url, html, headers: r.headers, statusCode: r.status, extractors: cfg.extractors, searchRules: cfg.searchRules, spellCheck: cfg.spellCheck !== false, grammarCheck: cfg.grammarCheck !== false, contentArea: cfg.contentArea, linkPositions: cfg.linkPositions, storeHtml: !!cfg.storeHtml });
        Object.assign(page, parsed);
        page.rawTitle = parsed.title;
        page.contentCategory = 'HTML';
        // bad content type: parsed as HTML but served with a non-HTML type, or type missing
        page.badContentType = !page.contentType || !/text\/html|xhtml/.test(page.contentType);
        if (cfg.mode === 'spider' && cfg.scope !== 'exact') {
          const inDepth = !cfg.maxDepth || depth + 1 <= cfg.maxDepth;
          const follow = (u) => { if (this.isInternalUrl(u)) { if (inDepth) this.enqueue(u, depth + 1, 'page'); } else if (cfg.crawlExternal) this.enqueue(u, depth + 1, 'external'); };
          if (page.metaRefresh && page.metaRefresh.url && cfg.followMetaRefresh !== false) follow(page.metaRefresh.url);
          for (const link of parsed.links) {
            if (this.isInternalUrl(link.url)) {
              if (!link.follow && !cfg.followInternalNofollow) continue;
              if (inDepth) this.enqueue(link.url, depth + 1, 'page');
            } else if (cfg.crawlExternal && (link.follow || cfg.followExternalNofollow)) this.enqueue(link.url, depth + 1, 'external');
          }
          if (cfg.crawlCanonicals !== false) for (const c of parsed.canonicals || []) follow(c);
          if (cfg.crawlPagination) for (const u of [...(parsed.paginationAll.next || []), ...(parsed.paginationAll.prev || [])]) follow(u);
          if (cfg.crawlHreflang) for (const h of parsed.hreflang || []) follow(h.url);
          if (cfg.crawlAmp && parsed.ampUrl) follow(parsed.ampUrl);
          if (cfg.crawlIframes !== false) for (const u of parsed.iframes || []) follow(u);
          if (cfg.crawlResources) {
            for (const res of parsed.resources) {
              if (res.type === 'JavaScript' && cfg.crawlJs === false) continue;
              if (res.type === 'CSS' && cfg.crawlCss === false) continue;
              this.enqueue(res.url, depth + 1, this.isInternalUrl(res.url) ? 'resource' : 'external');
            }
            if (cfg.crawlImages !== false) for (const img of parsed.images) this.enqueue(img.url, depth + 1, this.isInternalUrl(img.url) ? 'resource' : 'external');
          }
        } else if (page.metaRefresh && page.metaRefresh.url && cfg.mode === 'spider' && cfg.followMetaRefresh !== false) this.enqueue(page.metaRefresh.url, depth + 1, 'page');
        // image natural sizes + incorrectly-sized detection (fetched bytes are
        // reused when the image is also crawled as a resource row; here we
        // only HEAD/GET small images when checkImageSizes is on)
        if (cfg.crawlResources && cfg.crawlImages !== false && cfg.checkImageSizes) {
          for (const img of parsed.images) {
            const info = await this.imageInfoFor(img.url);
            if (info) { img.size = info.size; if (info.width) { img.naturalWidth = info.width; img.naturalHeight = info.height; if (img.width && img.height) { const aw = Number(img.width), ah = Number(img.height); if (aw && ah && (Math.abs(aw - info.width) / info.width > 0.1 || Math.abs(ah - info.height) / info.height > 0.1)) img.incorrectlySized = true; } } }
          }
        }
      } else if (kind === 'resource' && page.contentCategory === 'Images') {
        const dims = imageDimensions(r.body);
        if (dims) { page.imageWidth = dims.width; page.imageHeight = dims.height; this.imageInfo.set(url, { size: r.size, width: dims.width, height: dims.height }); }
        else this.imageInfo.set(url, { size: r.size });
      }
    } catch (err) {
      page.statusCode = 0; page.status = 'No Response'; page.error = String(err && err.message || err);
    }
    this.pages.set(url, page);
    this.emitPage(page);
    return page;
  }

  async imageInfoFor(url) {
    if (this.imageInfo.has(url)) return this.imageInfo.get(url);
    try {
      const ir = await fetch(url, { headers: this.reqHeaders(), signal: AbortSignal.timeout(8000) });
      const b = Buffer.from(await ir.arrayBuffer());
      const dims = imageDimensions(b);
      const info = { size: b.byteLength, ...(dims || {}) };
      this.imageInfo.set(url, info);
      return info;
    } catch (_) { const info = { size: 0 }; this.imageInfo.set(url, info); return info; }
  }

  /* Configuration > Authentication > Web Form: load the login page, fill the
   * form that has a password field (keeping hidden fields such as CSRF
   * tokens), submit it and keep the session cookies for the whole crawl. */
  async formLogin() {
    const fa = this.config.formAuth || {};
    if (!fa.url || !fa.username) return null;
    const jar = new Map();
    const keep = (resp) => {
      let list = [];
      try { list = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : []; } catch (_) {}
      for (const c of list) { const pair = String(c).split(';')[0]; const i = pair.indexOf('='); if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); }
    };
    const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const base = { 'User-Agent': this.config.userAgent, ...this.config.headers };
    const r1 = await fetch(fa.url, { headers: base, redirect: 'follow', signal: AbortSignal.timeout(this.config.timeoutMs) });
    keep(r1);
    const html = await r1.text();
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);
    let form = $('form').filter((_, f) => $(f).find('input[type="password" i]').length > 0).first();
    if (!form.length) form = $('form').first();
    if (!form.length) throw new Error('Web Form login: no form found on ' + fa.url);
    const fields = new URLSearchParams();
    form.find('input[name]').each((_, el) => { const t = String($(el).attr('type') || '').toLowerCase(); if (['submit', 'button', 'image', 'checkbox', 'radio'].includes(t)) return; fields.set($(el).attr('name'), $(el).attr('value') || ''); });
    const userField = fa.userField || form.find('input[type="email" i][name], input[type="text" i][name], input:not([type])[name]').first().attr('name') || 'username';
    const passField = fa.passField || form.find('input[type="password" i][name]').first().attr('name') || 'password';
    fields.set(userField, fa.username); fields.set(passField, fa.password || '');
    const action = normalizeUrl(form.attr('action') || r1.url || fa.url, r1.url || fa.url) || fa.url;
    let resp = await fetch(action, { method: 'POST', redirect: 'manual', headers: { ...base, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() }, body: fields.toString(), signal: AbortSignal.timeout(this.config.timeoutMs) });
    keep(resp);
    for (let i = 0; i < 5 && resp.status >= 300 && resp.status < 400 && resp.headers.get('location'); i++) {
      resp = await fetch(normalizeUrl(resp.headers.get('location'), action), { redirect: 'manual', headers: { ...base, Cookie: cookieHeader() }, signal: AbortSignal.timeout(this.config.timeoutMs) });
      keep(resp);
    }
    this.authCookie = cookieHeader();
    this.loginResult = { status: resp.status, cookies: jar.size };
    return this.loginResult;
  }

  emitPage(page) { if (this.hooks.onPage) { try { this.hooks.onPage(page); } catch (_) {} } }

  async discoverSitemaps() {
    const origin = originOf(this.rootUrl); if (!origin) return;
    const found = new Set();
    const robotsText = this.robotsTextCache.get(origin) || this.config.customRobotsText || '';
    for (const m of String(robotsText).matchAll(/^\s*Sitemap:\s*(\S+)/gim)) { const u = normalizeUrl(m[1]); if (u) found.add(u); }
    found.add(origin + '/sitemap.xml');
    found.add(origin + '/sitemap_index.xml');
    const queue = [...found].slice(0, 8);
    const seenSitemaps = new Set();
    while (queue.length && this.sitemapUrlSet.size < 5000) {
      const smUrl = queue.shift();
      if (seenSitemaps.has(smUrl)) continue;
      seenSitemaps.add(smUrl);
      try {
        const r = await fetch(smUrl, { headers: this.reqHeaders(), signal: AbortSignal.timeout(this.config.timeoutMs) });
        if (!r.ok) continue;
        const xml = await r.text();
        const locs = parseSitemap(xml);
        if (!locs.length) continue;
        const isIndex = isSitemapIndex(xml);
        this.sitemapList.push({ url: smUrl, status: r.status, isIndex, urlCount: isIndex ? 0 : locs.length });
        if (isIndex) { for (const loc of locs.slice(0, 8)) if (!seenSitemaps.has(loc)) queue.push(loc); }
        else for (const loc of locs) this.sitemapUrlSet.add(loc);
      } catch (_) {}
    }
  }

  async crawl(seeds, rootUrl) {
    this.rootUrl = rootUrl || seeds[0];
    const cfg = this.config;
    if (cfg.formAuth && cfg.formAuth.url && cfg.formAuth.username) {
      try { await this.formLogin(); } catch (e) { this.loginResult = { error: String(e && e.message || e) }; }
    }
    if (cfg.mode === 'sitemap') {
      const xml = await (await fetch(seeds[0], { headers: this.reqHeaders(), signal: AbortSignal.timeout(cfg.timeoutMs) })).text();
      const urls = parseSitemap(xml);
      this.rootUrl = urls[0] || seeds[0];
      for (const u of urls) { this.enqueue(u, crawlDepthOf(u, this.rootUrl), 'page', u === urls[0]); this.sitemapUrlSet.add(u); }
      if (urls.length) this.sitemapList.push({ url: seeds[0], status: 200, isIndex: false, urlCount: urls.length });
    } else {
      seeds.forEach((u, i) => this.enqueue(u, 0, 'page', i === 0));
    }
    let active = 0;
    await new Promise((resolve) => {
      const tick = () => {
        while (active < cfg.concurrency && this.queue.length && !this.stopped) {
          if (this.fetched >= cfg.maxUrls) { this.queue.length = 0; break; }
          const item = this.queue.shift();
          this.fetched++;
          active++;
          (async () => {
            if (cfg.delayMs) await new Promise((r) => setTimeout(r, cfg.delayMs));
            while (this.paused && !this.stopped) await new Promise((r) => setTimeout(r, 120));
            if (!this.stopped) await this.processOne(item);
          })().finally(() => {
            active--;
            if (this.hooks.onProgress) this.hooks.onProgress({ crawled: this.pages.size, queued: this.queue.length, discovered: this.queued.size, currentUrl: item.url, elapsedMs: Date.now() - this.startedAt });
            tick();
          });
        }
        if ((this.queue.length === 0 && active === 0) || (this.stopped && active === 0)) resolve();
        else setTimeout(tick, 60);
      };
      tick();
    });
    if (cfg.mode === 'spider' && !this.stopped) { try { await this.discoverSitemaps(); } catch (_) {} }
    return this.finish();
  }

  finish() {
    const pages = [...this.pages.values()];
    // sitemap membership + orphan sitemap rows
    for (const smUrl of this.sitemapUrlSet) {
      const existing = this.pages.get(smUrl);
      if (existing) existing.inSitemap = true;
      else if (this.isInternalUrl(smUrl)) {
        const orphan = { ...this.basePage(smUrl, 0, 'page'), sitemapOnly: true, inSitemap: true, status: 'Not Crawled', statusCode: null };
        pages.push(orphan);
      }
    }
    const { issues, analysis, stats } = finalizeCrawl(pages, this.rootUrl, this.config);
    stats.durationMs = Date.now() - this.startedAt;
    const { FILTER_META } = require('./filters');
    return { app: 'Seonfix Spider', version: 2, startedAt: new Date(this.startedAt).toISOString(), rootUrl: this.rootUrl, mode: this.config.mode, scope: this.config.scope, pages, issues, stats, analysis, sitemaps: this.sitemapList, filterMeta: FILTER_META, login: this.loginResult || null };
  }
}

module.exports = { Crawler, DEFAULT_CONFIG, UA_PRESETS, analyseChain, parseSitemap, generateSitemap, generateImageSitemap, compareCrawls, computeIndexability, statusText, finalizeCrawl, imageDimensions, isSitemapIndex };
