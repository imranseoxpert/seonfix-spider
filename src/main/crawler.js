'use strict';
/* Seonfix Spider crawl engine. Pure Node (no Electron imports) so it can be
 * unit/integration tested with `node --test` and reused by a CLI harness. */
const { parseRobots, isAllowed } = require('./robots');
const { parsePage, simhashSimilarity } = require('./extract');
const { buildContext, issuesForPage, summarise } = require('./issues');
const { normalizeUrl, ensureUrl, isInternal, crawlDepthOf, shouldInclude, originOf } = require('./urlutil');

const UA_PRESETS = {
  spider: 'SeonfixSpider/1.0 (Seonfix Spider; +https://seonfix.com/spider)',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'googlebot-smartphone': 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bingbot: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
};

const DEFAULT_CONFIG = {
  mode: 'spider', // spider | list | sitemap
  concurrency: 5, delayMs: 0, maxDepth: 0 /* 0 = unlimited */, maxUrls: 10000,
  userAgent: UA_PRESETS.spider, respectRobots: true, customRobotsText: '',
  crawlExternal: false, crawlResources: true, checkImageSizes: true,
  includePatterns: [], excludePatterns: [],
  headers: {}, cookies: '',
  extractors: [], searchRules: [],
  timeoutMs: 15000, maxRedirects: 10,
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

function xmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function generateSitemap(pages, opts = {}) {
  const { lastmod = new Date().toISOString().slice(0, 10), priority = '0.5', changefreq = 'monthly', onlyIndexable = true } = opts;
  const urls = pages.filter((p) => p.statusCode === 200 && (!onlyIndexable || p.indexability === 'Indexable'));
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

function compareCrawls(a, b) {
  const ma = new Map((a.pages || []).map((p) => [p.address, p]));
  const mb = new Map((b.pages || []).map((p) => [p.address, p]));
  const added = [...mb.keys()].filter((u) => !ma.has(u));
  const removed = [...ma.keys()].filter((u) => !mb.has(u));
  const changed = [];
  for (const [u, pa] of ma) {
    const pb = mb.get(u); if (!pb) continue;
    const fields = ['statusCode', 'title', 'metaDescription', 'wordCount', 'indexability'];
    const diffs = fields.filter((f) => String(pa[f] ?? '') !== String(pb[f] ?? '')).map((f) => ({ field: f, before: pa[f] ?? '', after: pb[f] ?? '' }));
    if (diffs.length) changed.push({ address: u, diffs });
  }
  const ia = new Map((a.issues || []).map((i) => [i.name, i.count]));
  const ib = new Map((b.issues || []).map((i) => [i.name, i.count]));
  const issueDeltas = [...new Set([...ia.keys(), ...ib.keys()])].map((name) => ({ name, before: ia.get(name) || 0, after: ib.get(name) || 0, delta: (ib.get(name) || 0) - (ia.get(name) || 0) }));
  return { added, removed, changed, issueDeltas };
}

class Crawler {
  constructor(config = {}, hooks = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.userAgentPreset && UA_PRESETS[this.config.userAgentPreset]) this.config.userAgent = UA_PRESETS[this.config.userAgentPreset];
    this.hooks = hooks;
    this.paused = false; this.stopped = false;
    this.pages = new Map(); this.queue = []; this.queued = new Set();
    this.robotsCache = new Map(); this.imageSizes = new Map();
    this.startedAt = Date.now(); this.fetched = 0;
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  stop() { this.stopped = true; this.paused = false; }

  async robotsFor(url) {
    const origin = originOf(url); if (!origin) return null;
    if (this.config.customRobotsText) {
      if (!this._customGroups) this._customGroups = parseRobots(this.config.customRobotsText);
      return this._customGroups;
    }
    if (this.robotsCache.has(origin)) return this.robotsCache.get(origin);
    let groups = [];
    try {
      const r = await fetch(origin + '/robots.txt', { headers: { 'User-Agent': this.config.userAgent }, signal: AbortSignal.timeout(8000) });
      if (r.ok) groups = parseRobots(await r.text());
    } catch (_) { groups = []; }
    this.robotsCache.set(origin, groups);
    return groups;
  }

  enqueue(url, depth, isStart = false) {
    if (!url || this.queued.has(url)) return;
    if (this.queued.size >= this.config.maxUrls + 5000) return;
    if (!shouldInclude(url, this.config)) return;
    this.queued.add(url); this.queue.push({ url, depth, isStart });
  }

  async fetchWithRedirects(url) {
    const chain = []; const visited = new Set([url]);
    let current = url; let loop = false; let firstStatus = null;
    const headers = { 'User-Agent': this.config.userAgent, Accept: 'text/html,application/xhtml+xml,*/*', ...this.config.headers };
    if (this.config.cookies) headers.Cookie = this.config.cookies;
    for (let hop = 0; hop <= this.config.maxRedirects; hop++) {
      const t0 = Date.now();
      const resp = await fetch(current, { redirect: 'manual', headers, signal: AbortSignal.timeout(this.config.timeoutMs) });
      const responseMs = Date.now() - t0;
      if (firstStatus === null) firstStatus = resp.status;
      const loc = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && loc) {
        const to = normalizeUrl(loc, current);
        chain.push({ from: current, to, status: resp.status });
        try { await resp.arrayBuffer(); } catch (_) {}
        if (!to) break;
        if (visited.has(to)) { loop = true; current = to; break; }
        visited.add(to); current = to; continue;
      }
      const hdrs = {}; resp.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v; });
      const buf = Buffer.from(await resp.arrayBuffer());
      return { status: resp.status, firstStatus, headers: hdrs, body: buf, chain, loop, finalUrl: current, responseMs, size: buf.length };
    }
    return { status: firstStatus || 0, firstStatus, headers: {}, body: Buffer.alloc(0), chain, loop, finalUrl: current, responseMs: 0, size: 0 };
  }

  async processOne({ url, depth, isStart }) {
    const cfg = this.config;
    const page = { address: url, isStartUrl: !!isStart, depth, statusCode: 0, status: 'No Response', contentType: '', redirectChain: [], redirectLoop: false, images: [], links: [], resources: [], hreflang: [], structuredData: [], issues: [] };
    // robots
    if (cfg.respectRobots) {
      const groups = await this.robotsFor(url);
      const agent = /googlebot/i.test(cfg.userAgent) ? 'googlebot' : /bingbot/i.test(cfg.userAgent) ? 'bingbot' : '*';
      if (groups && groups.length && !isAllowed(groups, agent, url)) {
        page.status = 'Blocked by robots.txt'; page.indexability = 'Non-Indexable'; page.indexabilityReason = 'Blocked by robots.txt';
        this.pages.set(url, page); return page;
      }
    }
    try {
      const r = await this.fetchWithRedirects(url);
      page.statusCode = r.firstStatus; page.finalStatusCode = r.status; page.redirectChain = r.chain;
      page.redirectLoop = r.loop || analyseChain(r.chain).isLoop;
      page.redirectUrl = r.chain.length ? r.finalUrl : '';
      page.responseTimeMs = r.responseMs; page.sizeBytes = r.size;
      page.headers = r.headers; page.contentType = r.headers['content-type'] || '';
      page.status = statusText(r.firstStatus);
      if (r.chain.length && r.finalUrl !== url) this.enqueue(r.finalUrl, depth);
      if (/text\/html|xhtml/.test(page.contentType) || (!page.contentType && r.body.length)) {
        const html = r.body.toString('utf8');
        page.htmlLength = html.length;
        const parsed = parsePage({ url, html, headers: r.headers, statusCode: r.status, extractors: cfg.extractors, searchRules: cfg.searchRules });
        Object.assign(page, parsed);
        page.rawTitle = parsed.title;
        // rendered comparison fields are filled by main process when JS rendering is on
        // discover links
        if (cfg.mode === 'spider') {
          for (const link of parsed.links) {
            const internal = isInternal(link.url, this.rootUrl);
            if (internal) {
              if (!cfg.maxDepth || depth + 1 <= cfg.maxDepth) this.enqueue(link.url, depth + 1);
            } else if (cfg.crawlExternal) this.enqueue(link.url, depth + 1);
          }
        }
        if (cfg.crawlResources && cfg.checkImageSizes) {
          for (const img of parsed.images) {
            if (!this.imageSizes.has(img.url)) {
              try {
                const ir = await fetch(img.url, { headers: { 'User-Agent': cfg.userAgent }, signal: AbortSignal.timeout(8000) });
                const b = await ir.arrayBuffer(); this.imageSizes.set(img.url, b.byteLength);
              } catch (_) { this.imageSizes.set(img.url, 0); }
            }
            img.size = this.imageSizes.get(img.url) || 0;
          }
        }
      }
    } catch (err) {
      page.statusCode = 0; page.status = 'No Response'; page.error = String(err && err.message || err);
    }
    this.pages.set(url, page);
    return page;
  }

  async crawl(seeds, rootUrl) {
    this.rootUrl = rootUrl || seeds[0];
    const cfg = this.config;
    if (cfg.mode === 'sitemap') {
      const xml = await (await fetch(seeds[0], { headers: { 'User-Agent': cfg.userAgent }, signal: AbortSignal.timeout(cfg.timeoutMs) })).text();
      const urls = parseSitemap(xml);
      this.rootUrl = urls[0] || seeds[0];
      for (const u of urls) this.enqueue(u, crawlDepthOf(u, this.rootUrl), u === urls[0]);
    } else {
      seeds.forEach((u, i) => this.enqueue(u, 0, i === 0));
    }
    const workers = [];
    const runWorker = async () => {
      while (!this.stopped) {
        if (this.paused) { await new Promise((r) => setTimeout(r, 120)); continue; }
        const item = this.queue.shift();
        if (!item) return;
        if (this.fetched >= cfg.maxUrls) return;
        this.fetched++;
        if (cfg.delayMs) await new Promise((r) => setTimeout(r, cfg.delayMs));
        await this.processOne(item);
        if (this.hooks.onProgress) this.hooks.onProgress({ crawled: this.pages.size, queued: this.queue.length, discovered: this.queued.size, currentUrl: item.url, elapsedMs: Date.now() - this.startedAt });
      }
    };
    // Dynamic pool: workers respawn while queue grows from discovery.
    let active = 0;
    await new Promise((resolve) => {
      const tick = () => {
        while (active < cfg.concurrency && this.queue.length && !this.stopped) {
          active++;
          runWorker().finally(() => { active--; tick(); });
        }
        if ((this.queue.length === 0 && active === 0) || this.stopped && active === 0) resolve();
        else setTimeout(tick, 60);
      };
      tick();
    });
    return this.finish();
  }

  finish() {
    const pages = [...this.pages.values()];
    // external stubs
    const known = new Set(pages.map((p) => p.address));
    const external = new Map();
    for (const p of pages) {
      for (const l of p.links || []) {
        if (!isInternal(l.url, this.rootUrl) && !known.has(l.url) && !external.has(l.url)) {
          external.set(l.url, { address: l.url, external: true, statusCode: null, status: 'Not Crawled', contentType: '', depth: (p.depth || 0) + 1, images: [], links: [], resources: [], hreflang: [], structuredData: [], issues: [] });
        }
      }
    }
    const all = [...pages, ...external.values()];
    // link counts
    const inlinkFrom = new Map(); const inlinkCount = new Map();
    for (const p of pages) {
      const internalOut = new Set(); const externalOut = new Set(); const allOut = new Set();
      for (const l of p.links || []) {
        allOut.add(l.url);
        if (isInternal(l.url, this.rootUrl)) internalOut.add(l.url); else externalOut.add(l.url);
        if (!inlinkFrom.has(l.url)) inlinkFrom.set(l.url, new Set());
        inlinkFrom.get(l.url).add(p.address);
        inlinkCount.set(l.url, (inlinkCount.get(l.url) || 0) + 1);
      }
      p.outlinks = allOut.size; p.uniqueOutlinks = allOut.size; p.externalOutlinks = externalOut.size;
    }
    for (const p of all) { p.inlinks = inlinkCount.get(p.address) || 0; p.uniqueInlinks = inlinkFrom.has(p.address) ? inlinkFrom.get(p.address).size : 0; if (p.outlinks === undefined) { p.outlinks = 0; p.uniqueOutlinks = 0; p.externalOutlinks = 0; } }
    // indexability
    for (const p of pages) computeIndexability(p);
    // near duplicates
    const htmlPages = pages.filter((p) => p.finalStatusCode === 200 || p.statusCode === 200);
    for (let i = 0; i < htmlPages.length; i++) {
      for (let j = i + 1; j < htmlPages.length; j++) {
        const a = htmlPages[i], b = htmlPages[j];
        if (!a.simhash || !b.simhash || a.hash === b.hash) continue;
        if ((a.wordCount || 0) < 30 || (b.wordCount || 0) < 30) continue;
        if (simhashSimilarity(a.simhash, b.simhash) >= 0.92) { b.nearDuplicateOf = a.address; }
      }
    }
    const ctx = buildContext(all);
    for (const p of all) p.issues = issuesForPage(p, ctx);
    for (const p of all) { delete p.text; }
    const issues = summarise(all, ctx);
    const stats = {
      total: all.length, crawled: pages.length,
      indexable: all.filter((p) => p.indexability === 'Indexable').length,
      nonIndexable: all.filter((p) => p.indexability === 'Non-Indexable').length,
      errors4xx: all.filter((p) => p.statusCode >= 400 && p.statusCode < 500).length,
      errors5xx: all.filter((p) => p.statusCode >= 500).length,
      redirects: all.filter((p) => p.statusCode >= 300 && p.statusCode < 400).length,
      durationMs: Date.now() - this.startedAt,
    };
    return { app: 'Seonfix Spider', version: 1, startedAt: new Date(this.startedAt).toISOString(), rootUrl: this.rootUrl, mode: this.config.mode, pages: all, issues, stats };
  }
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
  if (p.statusCode === 0) { p.indexability = 'Non-Indexable'; p.indexabilityReason = 'No Response'; return; }
  if (p.statusCode >= 300 && p.statusCode < 400) { p.indexability = 'Non-Indexable'; p.indexabilityReason = 'Redirected'; return; }
  if (p.statusCode >= 400) { p.indexability = 'Non-Indexable'; p.indexabilityReason = p.statusCode < 500 ? 'Client Error' : 'Server Error'; return; }
  if (/noindex/i.test((p.metaRobots || '') + ' ' + (p.xRobotsTag || ''))) { p.indexability = 'Non-Indexable'; p.indexabilityReason = 'Noindex'; return; }
  if (p.canonical && p.canonical !== p.address) { p.indexability = 'Non-Indexable'; p.indexabilityReason = 'Canonicalised'; return; }
  p.indexability = 'Indexable'; p.indexabilityReason = 'Indexable';
}

module.exports = { Crawler, DEFAULT_CONFIG, UA_PRESETS, analyseChain, parseSitemap, generateSitemap, generateImageSitemap, compareCrawls, computeIndexability, statusText };
