'use strict';
/* HTML parsing + per-page data extraction, custom extraction / search,
 * duplicate hashing and near-duplicate (simhash) similarity. */
const crypto = require('node:crypto');
const cheerio = require('cheerio');
const { normalizeUrl, pixelWidth } = require('./urlutil');

function md5(text) { return crypto.createHash('md5').update(String(text || '')).digest('hex'); }

function shingles(text, n = 3) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  if (!out.size && words.length) out.add(words.join(' '));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// 64-bit simhash over word tokens (BigInt).
function simhash(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const v = new Array(64).fill(0);
  for (const w of words) {
    const h = BigInt('0x' + md5(w).slice(0, 16));
    for (let i = 0; i < 64; i++) v[i] += ((h >> BigInt(i)) & 1n) ? 1 : -1;
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) if (v[i] > 0) out |= (1n << BigInt(i));
  return out;
}

function simhashSimilarity(a, b) {
  if (a == null || b == null) return 0;
  let x = BigInt(a) ^ BigInt(b); let dist = 0;
  while (x) { dist += Number(x & 1n); x >>= 1n; }
  return 1 - dist / 64;
}

function applyExtractors($, html, extractors) {
  const out = {};
  for (const ex of extractors || []) {
    if (!ex || !ex.name || !ex.value) continue;
    try {
      if (ex.type === 'regex') {
        const m = String(html).match(new RegExp(ex.value, 's'));
        out[ex.name] = m ? (m[1] !== undefined ? m[1] : m[0]).trim().slice(0, 500) : '';
      } else if (ex.type === 'xpath') {
        const sel = xpathToCss(ex.value);
        if (sel) { const el = $(sel).first(); out[ex.name] = (el.attr('content') || el.text() || '').trim().slice(0, 500); }
        else out[ex.name] = '';
      } else { // css
        const el = $(ex.value).first();
        out[ex.name] = (el.attr('content') || el.text() || '').trim().replace(/\s+/g, ' ').slice(0, 500);
      }
    } catch (_) { out[ex.name] = ''; }
  }
  return out;
}

// Very small XPath subset: //tag, //tag[@attr='v'], //tag/text() -> CSS approximations.
function xpathToCss(xpath) {
  const m = String(xpath || '').trim().match(/^\/\/(\*|[a-zA-Z][\w-]*)(?:\[@([\w:-]+)=['"]([^'"]+)['"]\])?(?:\/text\(\))?$/);
  if (!m) return null;
  const tag = m[1] === '*' ? '' : m[1];
  if (m[2]) return `${tag}[${m[2]}="${m[3]}"]`;
  return tag || null;
}

function applySearch(html, rules) {
  const out = {};
  for (const r of rules || []) {
    if (!r || !r.name || !r.needle) continue;
    const found = String(html).includes(r.needle);
    out[r.name] = r.mode === 'notcontains' ? !found : found;
  }
  return out;
}

const SECURITY_HEADERS = ['strict-transport-security', 'x-frame-options', 'x-content-type-options', 'content-security-policy', 'referrer-policy'];

function parsePage({ url, html, headers = {}, statusCode = 200, extractors = [], searchRules = [] }) {
  const $ = cheerio.load(html || '');
  const head = (sel) => $(sel).first();
  const title = head('title').text().trim().replace(/\s+/g, ' ');
  const metaDesc = $('meta[name="description" i]').attr('content') || '';
  const metaKeywords = $('meta[name="keywords" i]').attr('content') || '';
  const metaRobots = $('meta[name="robots" i]').attr('content') || '';
  const xRobots = headers['x-robots-tag'] || '';
  const h1s = $('h1').map((_, el) => $(el).text().trim().replace(/\s+/g, ' ')).get().filter(Boolean);
  const h2s = $('h2').map((_, el) => $(el).text().trim().replace(/\s+/g, ' ')).get().filter(Boolean);
  const canonicals = $('link[rel="canonical" i]').map((_, el) => normalizeUrl($(el).attr('href') || '', url)).get().filter(Boolean);
  const hreflang = $('link[rel="alternate" i][hreflang]').map((_, el) => ({ lang: $(el).attr('hreflang'), url: normalizeUrl($(el).attr('href') || '', url) })).get().filter((h) => h.url);
  const nextPrev = {
    next: normalizeUrl($('link[rel="next" i]').attr('href') || '', url),
    prev: normalizeUrl($('link[rel="prev" i]').attr('href') || '', url),
  };
  // links
  const links = []; const seenLink = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const abs = normalizeUrl(href || '', url);
    if (!abs || seenLink.has(abs + '|' + ($(el).attr('rel') || ''))) return;
    seenLink.add(abs + '|' + ($(el).attr('rel') || ''));
    links.push({ url: abs, anchor: $(el).text().trim().replace(/\s+/g, ' ').slice(0, 200), rel: $(el).attr('rel') || '', follow: !/nofollow/i.test($(el).attr('rel') || '') });
  });
  // images
  const images = [];
  $('img').each((_, el) => {
    const src = normalizeUrl($(el).attr('src') || '', url);
    if (src) images.push({ url: src, alt: $(el).attr('alt'), hasAlt: $(el).attr('alt') !== undefined, width: $(el).attr('width') || '', height: $(el).attr('height') || '' });
  });
  // resources
  const resources = [];
  $('script[src]').each((_, el) => { const u = normalizeUrl($(el).attr('src') || '', url); if (u) resources.push({ url: u, type: 'JavaScript' }); });
  $('link[rel="stylesheet" i][href]').each((_, el) => { const u = normalizeUrl($(el).attr('href') || '', url); if (u) resources.push({ url: u, type: 'CSS' }); });
  // structured data types
  const sdTypes = [];
  $('script[type="application/ld+json" i]').each((_, el) => {
    try {
      const json = JSON.parse($(el).text());
      const collect = (o) => { if (!o || typeof o !== 'object') return; if (o['@type']) sdTypes.push(...(Array.isArray(o['@type']) ? o['@type'] : [o['@type']])); if (Array.isArray(o['@graph'])) o['@graph'].forEach(collect); };
      (Array.isArray(json) ? json : [json]).forEach(collect);
    } catch (_) { sdTypes.push('Invalid JSON-LD'); }
  });
  $('[itemscope][itemtype]').each((_, el) => { const t = ($(el).attr('itemtype') || '').split('/').pop(); if (t) sdTypes.push(t); });
  // body text
  const bodyClone = $('body').clone();
  bodyClone.find('script,style,noscript').remove();
  const text = bodyClone.text().replace(/\s+/g, ' ').trim();
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  const mixedContent = /^https:/i.test(url) ? [...String(html).matchAll(/http:\/\/[^\s"'<>]+/g)].map((m) => m[0]).slice(0, 20) : [];
  const missingSecHeaders = /^https:/i.test(url) ? SECURITY_HEADERS.filter((h) => !headers[h]) : [];
  return {
    title, titleLength: title.length, titlePixelWidth: pixelWidth(title),
    metaDescription: metaDesc.trim(), metaDescriptionLength: metaDesc.trim().length,
    metaKeywords: metaKeywords.trim(),
    h1s, h2s, metaRobots: metaRobots.trim(), xRobotsTag: String(xRobots).trim(),
    canonical: canonicals[0] || '', canonicals,
    hreflang, pagination: nextPrev,
    links, images, resources,
    structuredData: [...new Set(sdTypes)],
    wordCount: words.length, textRatio: html ? Math.round((text.length / String(html).length) * 1000) / 10 : 0,
    text, hash: md5(text), simhash: simhash(text).toString(),
    mixedContent, missingSecurityHeaders: missingSecHeaders,
    extractions: applyExtractors($, html, extractors),
    searchMatches: applySearch(html, searchRules),
  };
}

module.exports = { parsePage, md5, shingles, jaccard, simhash, simhashSimilarity, applyExtractors, applySearch, xpathToCss };
