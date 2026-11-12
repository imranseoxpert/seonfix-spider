'use strict';
/* HTML parsing + per-page data extraction, custom extraction / search,
 * duplicate hashing and near-duplicate (simhash) similarity.
 * v2 adds: heading sequence, in-head placement flags, directives tokens,
 * forms, unsafe cross-origin links, protocol-relative resources, background
 * images, AMP discovery, meta refresh, content metrics (sentences, Flesch),
 * lorem ipsum, detailed structured-data items, spelling error counts. */
const crypto = require('node:crypto');
const cheerio = require('cheerio');
const { normalizeUrl, pixelWidth } = require('./urlutil');
const { countSpellingErrors } = require('./spelling');

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
      } else {
        const el = $(ex.value).first();
        out[ex.name] = (el.attr('content') || el.text() || '').trim().replace(/\s+/g, ' ').slice(0, 500);
      }
    } catch (_) { out[ex.name] = ''; }
  }
  return out;
}

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

function syllables(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

function fleschReadingEase(words) {
  if (!words || words.length < 10) return null;
  const sentences = Math.max(1, words._sentences || 1);
  const syll = words.reduce((a, w) => a + syllables(w), 0);
  const score = 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syll / words.length);
  return Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
}

function parseDirectives(metaRobots, xRobots) {
  const out = [];
  for (const src of [metaRobots || '', xRobots || '']) {
    for (const part of String(src).split(',')) {
      const t = part.trim().toLowerCase();
      if (t) out.push(t);
    }
  }
  return out;
}

function parsePage({ url, html, headers = {}, statusCode = 200, extractors = [], searchRules = [], spellCheck = false }) {
  const $ = cheerio.load(html || '');
  const rawHtml = String(html || '');
  const title = $('title').first().text().trim().replace(/\s+/g, ' ');
  const metaDesc = $('meta[name="description" i]').attr('content') || '';
  const metaKeywords = $('meta[name="keywords" i]').attr('content') || '';
  const metaRobots = $('meta[name="robots" i]').attr('content') || '';
  const xRobots = headers['x-robots-tag'] || '';
  const h1s = $('h1').map((_, el) => $(el).text().trim().replace(/\s+/g, ' ')).get().filter(Boolean);
  const h2s = $('h2').map((_, el) => $(el).text().trim().replace(/\s+/g, ' ')).get().filter(Boolean);
  // heading sequence + H1 alt-text-in-heading
  const allHeadings = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => { allHeadings.push({ level: Number(el.tagName.slice(1)), text: $(el).text().trim().replace(/\s+/g, ' ') }); });
  const h1HasAltImg = $('h1 img[alt]').toArray().some((el) => String($(el).attr('alt') || '').trim().length > 0);
  // in-head placement flags (an element counts as outside <head> if it appears in <body>)
  const inBody = (sel) => $(`body ${sel}`).length > 0;
  const placement = {
    titleOutsideHead: inBody('title'),
    descOutsideHead: inBody('meta[name="description" i]'),
    canonicalOutsideHead: inBody('link[rel="canonical" i]'),
    hreflangOutsideHead: inBody('link[rel="alternate" i][hreflang]'),
    directivesOutsideHead: inBody('meta[name="robots" i]'),
  };
  const canonicalEls = $('link[rel="canonical" i]');
  const canonicalHrefs = canonicalEls.map((_, el) => $(el).attr('href') || '').get();
  const canonicals = canonicalHrefs.map((h) => normalizeUrl(h, url)).filter(Boolean);
  const hreflang = $('link[rel="alternate" i][hreflang]').map((_, el) => ({ lang: $(el).attr('hreflang'), url: normalizeUrl($(el).attr('href') || '', url) })).get().filter((h) => h.url);
  const nextAll = $('link[rel="next" i]').map((_, el) => normalizeUrl($(el).attr('href') || '', url)).get().filter(Boolean);
  const prevAll = $('link[rel="prev" i]').map((_, el) => normalizeUrl($(el).attr('href') || '', url)).get().filter(Boolean);
  const nextPrev = { next: nextAll[0] || null, prev: prevAll[0] || null };
  const ampUrl = normalizeUrl($('link[rel="amphtml" i]').attr('href') || '', url);
  const metaRefreshEl = $('meta[http-equiv="refresh" i]').attr('content') || '';
  const mrMatch = metaRefreshEl.match(/url\s*=\s*['"]?([^'";]+)/i);
  const metaRefresh = mrMatch ? { delay: parseFloat(metaRefreshEl) || 0, url: normalizeUrl(mrMatch[1].trim(), url) } : null;
  // links
  const links = []; const seenLink = new Set();
  const pageOrigin = (() => { try { return new URL(url).origin; } catch (_) { return ''; } })();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const abs = normalizeUrl(href || '', url);
    if (!abs) return;
    const rel = $(el).attr('rel') || '';
    const key = abs + '|' + rel + '|' + $(el).text().trim();
    if (seenLink.has(key)) return;
    seenLink.add(key);
    let external = false; try { external = new URL(abs).origin !== pageOrigin; } catch (_) {}
    const target = $(el).attr('target') || '';
    const unsafeCrossOrigin = external && /_blank/i.test(target) && !/noopener|noreferrer/i.test(rel);
    links.push({ url: abs, anchor: $(el).text().trim().replace(/\s+/g, ' ').slice(0, 200), rel, follow: !/nofollow/i.test(rel), target, external, unsafeCrossOrigin });
  });
  // forms
  const forms = [];
  $('form').each((_, el) => {
    const action = normalizeUrl($(el).attr('action') || url, url);
    forms.push({ action, method: ($(el).attr('method') || 'get').toLowerCase() });
  });
  // images
  const images = [];
  $('img').each((_, el) => {
    const src = normalizeUrl($(el).attr('src') || '', url);
    if (src) images.push({ url: src, alt: $(el).attr('alt'), hasAlt: $(el).attr('alt') !== undefined, width: $(el).attr('width') || '', height: $(el).attr('height') || '', hasSizeAttrs: !!($(el).attr('width') && $(el).attr('height')) });
  });
  const backgroundImages = (rawHtml.match(/background(-image)?\s*:[^;}]*url\(/gi) || []).length;
  // resources
  const resources = [];
  $('script[src]').each((_, el) => { const u = normalizeUrl($(el).attr('src') || '', url); if (u) resources.push({ url: u, type: 'JavaScript' }); });
  $('link[rel="stylesheet" i][href]').each((_, el) => { const u = normalizeUrl($(el).attr('href') || '', url); if (u) resources.push({ url: u, type: 'CSS' }); });
  $('link[rel="icon" i],link[rel="shortcut icon" i]').each((_, el) => { const u = normalizeUrl($(el).attr('href') || '', url); if (u) resources.push({ url: u, type: 'Other' }); });
  const protocolRelativeCount = (rawHtml.match(/(?:src|href)\s*=\s*["']\/\//gi) || []).length;
  // structured data (types list kept for v1 compat + detailed items for v2)
  const sdTypes = []; const sdItems = [];
  $('script[type="application/ld+json" i]').each((_, el) => {
    try {
      const json = JSON.parse($(el).text());
      const collect = (o) => {
        if (!o || typeof o !== 'object') return;
        if (o['@type']) {
          const types = Array.isArray(o['@type']) ? o['@type'] : [o['@type']];
          for (const t of types) {
            sdTypes.push(t);
            sdItems.push({ type: t, keys: Object.keys(o), headline: o.headline || o.name || '', image: !!(o.image), datePublished: o.datePublished || '', author: !!(o.author), offers: !!(o.offers), aggregateRating: !!(o.aggregateRating), faqCount: Array.isArray(o.mainEntity) ? o.mainEntity.length : 0 });
          }
        }
        if (Array.isArray(o['@graph'])) o['@graph'].forEach(collect);
      };
      (Array.isArray(json) ? json : [json]).forEach(collect);
    } catch (_) { sdTypes.push('Invalid JSON-LD'); sdItems.push({ type: 'Invalid JSON-LD', keys: [], parseError: true }); }
  });
  $('[itemscope][itemtype]').each((_, el) => { const t = ($(el).attr('itemtype') || '').split('/').pop(); if (t) { sdTypes.push(t); sdItems.push({ type: t, keys: [], microdata: true }); } });
  // body text + content metrics
  const bodyClone = $('body').clone();
  bodyClone.find('script,style,noscript').remove();
  const text = bodyClone.text().replace(/\s+/g, ' ').trim();
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  const sentenceList = text ? text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 1) : [];
  const sentenceCount = Math.max(sentenceList.length, words.length ? 1 : 0);
  const wordsArr = [...words]; wordsArr._sentences = sentenceCount;
  const flesch = fleschReadingEase(wordsArr);
  const spell = spellCheck ? countSpellingErrors(text) : { errors: 0, unknown: [] };
  const mixedContent = /^https:/i.test(url) ? [...rawHtml.matchAll(/http:\/\/[^\s"'<>]+/g)].map((m) => m[0]).slice(0, 20) : [];
  const missingSecHeaders = /^https:/i.test(url) ? SECURITY_HEADERS.filter((h) => !headers[h]) : [];
  const soft404 = statusCode === 200 && words.length < 60 && /(\b404\b|not found|page not found|error occurred|does not exist)/i.test(title + ' ' + text.slice(0, 300));
  return {
    title, titleLength: title.length, titlePixelWidth: pixelWidth(title),
    titles: $('title').map((_, el) => $(el).text().trim().replace(/\s+/g, ' ')).get().filter(Boolean),
    metaDescription: metaDesc.trim(), metaDescriptionLength: metaDesc.trim().length, metaDescriptionPixelWidth: pixelWidth(metaDesc.trim()),
    metaDescriptions: $('meta[name="description" i]').map((_, el) => $(el).attr('content') || '').get(),
    metaKeywords: metaKeywords.trim(), metaKeywordsLength: metaKeywords.trim().length,
    metaKeywordsCount: $('meta[name="keywords" i]').length,
    h1s, h2s, allHeadings, headingLevels: allHeadings.map((h) => h.level), h1HasAltImg,
    metaRobots: metaRobots.trim(), xRobotsTag: String(xRobots).trim(),
    directives: parseDirectives(metaRobots, xRobots),
    canonical: canonicals[0] || '', canonicals, canonicalHrefs,
    hreflang, pagination: nextPrev, paginationAll: { next: nextAll, prev: prevAll },
    ampUrl: ampUrl || '', metaRefresh,
    links, forms, images, backgroundImages, resources, protocolRelativeCount,
    structuredData: [...new Set(sdTypes)], sdItems,
    wordCount: words.length, sentenceCount, avgWordsPerSentence: sentenceCount ? Math.round((words.length / sentenceCount) * 10) / 10 : 0,
    flesch, readability: flesch === null ? '' : (flesch >= 60 ? 'Standard' : flesch >= 30 ? 'Difficult' : 'Very Difficult'),
    loremIpsum: /lorem ipsum/i.test(text),
    soft404: !!soft404,
    spellingErrors: spell.errors, spellingUnknown: spell.unknown || [],
    textRatio: rawHtml ? Math.round((text.length / rawHtml.length) * 1000) / 10 : 0,
    text, textExcerpt: text.slice(0, 3000), hash: md5(text), simhash: simhash(text).toString(),
    mixedContent, missingSecurityHeaders: missingSecHeaders,
    ...placement,
    extractions: applyExtractors($, rawHtml, extractors),
    searchMatches: applySearch(rawHtml, searchRules),
  };
}

module.exports = { parsePage, md5, shingles, jaccard, simhash, simhashSimilarity, applyExtractors, applySearch, xpathToCss, syllables, fleschReadingEase, parseDirectives, SECURITY_HEADERS };
