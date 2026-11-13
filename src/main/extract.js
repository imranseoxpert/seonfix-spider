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
const { checkGrammar } = require('./grammar');
const { checkAccessibility } = require('./accessibility');

/* SF-style default link position rules: the first rule whose substring
 * matches the link's ancestor path (tag, id and classes) wins; custom rules
 * from Configuration > Custom > Custom Link Positions are checked first. */
const DEFAULT_LINK_POSITIONS = [
  { name: 'Navigation', pattern: 'nav' }, { name: 'Navigation', pattern: 'menu' },
  { name: 'Header', pattern: 'header' }, { name: 'Footer', pattern: 'footer' },
  { name: 'Sidebar', pattern: 'sidebar' }, { name: 'Sidebar', pattern: 'aside' },
];
const DEFAULT_CONTENT_AREA = { include: [], exclude: ['nav', 'footer'] };

function ancestorPath($, el) {
  const parts = [];
  let cur = el.parent;
  while (cur && cur.type === 'tag' && parts.length < 25) {
    const id = cur.attribs && cur.attribs.id ? '#' + cur.attribs.id : '';
    const cls = cur.attribs && cur.attribs.class ? '.' + String(cur.attribs.class).trim().split(/\s+/).join('.') : '';
    parts.unshift(cur.name + id + cls);
    cur = cur.parent;
  }
  return parts.join('/').toLowerCase();
}

function linkPosition(path, rules) {
  for (const r of rules) {
    if (!r || !r.pattern) continue;
    if (path.includes(String(r.pattern).toLowerCase())) return r.name || 'Content';
  }
  return 'Content';
}

function safeDecode(x) { try { return decodeURIComponent(x); } catch (_) { return x; } }
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

/* Simple HTML -> Markdown conversion of the content area (v2.2, for the
 * View Source "Markdown" view, Bulk Export > All Page Markdown and MCP). */
function htmlToMarkdown($, root) {
  const out = [];
  const inline = (el) => {
    let t = '';
    $(el).contents().each((_, n) => {
      if (n.type === 'text') t += n.data;
      else if (n.type === 'tag') {
        const tag = n.name;
        if (tag === 'br') t += '\n';
        else if (tag === 'a') { const href = $(n).attr('href') || ''; const txt = inline(n).trim(); t += href && txt ? `[${txt}](${href})` : txt; }
        else if (tag === 'strong' || tag === 'b') { const x = inline(n).trim(); t += x ? `**${x}**` : ''; }
        else if (tag === 'em' || tag === 'i') { const x = inline(n).trim(); t += x ? `*${x}*` : ''; }
        else if (tag === 'code') t += '`' + $(n).text() + '`';
        else if (tag === 'img') { const alt = $(n).attr('alt') || ''; const src = $(n).attr('src') || ''; if (src) t += `![${alt}](${src})`; }
        else if (!['script', 'style', 'noscript', 'svg'].includes(tag)) t += inline(n);
      }
    });
    return t.replace(/[ \t]+/g, ' ');
  };
  const walk = (el) => {
    $(el).children().each((_, n) => {
      const tag = n.name;
      if (['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'form', 'button'].includes(tag)) return;
      if (/^h[1-6]$/.test(tag)) { const x = inline(n).trim(); if (x) out.push('#'.repeat(Number(tag[1])) + ' ' + x); }
      else if (tag === 'p') { const x = inline(n).trim(); if (x) out.push(x); }
      else if (tag === 'ul' || tag === 'ol') { const items = $(n).children('li').map((i, li) => (tag === 'ol' ? `${i + 1}. ` : '- ') + inline(li).trim()).get().filter((x) => x.length > 2); if (items.length) out.push(items.join('\n')); }
      else if (tag === 'blockquote') { const x = inline(n).trim(); if (x) out.push('> ' + x); }
      else if (tag === 'pre') out.push('```\n' + $(n).text().trim() + '\n```');
      else if (tag === 'table') {
        const rows = $(n).find('tr').map((_, tr) => '| ' + $(tr).children('th,td').map((__, c) => $(c).text().replace(/\s+/g, ' ').trim()).get().join(' | ') + ' |').get();
        if (rows.length) { const cols = $(n).find('tr').first().children('th,td').length; rows.splice(1, 0, '|' + ' --- |'.repeat(Math.max(1, cols))); out.push(rows.join('\n')); }
      }
      else if (['a', 'span', 'strong', 'em', 'b', 'i', 'img'].includes(tag)) { const x = inline($('<span></span>').append($(n).clone())).trim(); if (x) out.push(x); }
      else walk(n);
    });
  };
  walk(root);
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* Open Graph + X (Twitter) Card tags (Social tab, v2.2). */
function socialTags($) {
  const meta = (attr, name) => ($(`meta[${attr}="${name}" i]`).attr('content') || '').trim();
  const both = (name) => meta('name', name) || meta('property', name);
  return {
    ogTitle: meta('property', 'og:title'), ogDescription: meta('property', 'og:description'), ogImage: meta('property', 'og:image'),
    ogUrl: meta('property', 'og:url'), ogType: meta('property', 'og:type'), ogSiteName: meta('property', 'og:site_name'),
    ogImageWidth: meta('property', 'og:image:width'), ogImageHeight: meta('property', 'og:image:height'), ogImageAlt: meta('property', 'og:image:alt'),
    twitterCard: both('twitter:card'), twitterTitle: both('twitter:title'), twitterDescription: both('twitter:description'),
    twitterImage: both('twitter:image'), twitterSite: both('twitter:site'),
  };
}

/* Basic HTML validation (Validation tab, v2.2). Works on the raw source,
 * because HTML parsers silently repair broken documents. */
function validateHtml(rawHtml) {
  const src = String(rawHtml || '');
  const clean = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  const count = (re) => (clean.match(re) || []).length;
  const headMatch = clean.match(/<head[\s>][\s\S]*?(<\/head>|<body[\s>])/i);
  const headSrc = headMatch ? headMatch[0] : '';
  const invalidInHead = [...new Set((headSrc.match(/<(img|div|p|span|a|h[1-6]|iframe|ul|ol|li|table|section|article|header|footer|nav|main|form|input|button|br|hr)[\s>/]/gi) || []).map((x) => x.replace(/[<\s>/]/g, '').toLowerCase()))];
  const bodyIdx = clean.search(/<body[\s>]/i); const headIdx = clean.search(/<head[\s>]/i);
  return {
    missingHtml: count(/<html[\s>]/gi) === 0, multipleHtml: count(/<html[\s>]/gi) > 1,
    missingHead: count(/<head[\s>]/gi) === 0, multipleHead: count(/<head[\s>]/gi) > 1,
    missingBody: count(/<body[\s>]/gi) === 0, multipleBody: count(/<body[\s>]/gi) > 1,
    invalidInHead, bodyBeforeHead: bodyIdx >= 0 && headIdx >= 0 && bodyIdx < headIdx,
    over15mb: src.length > 15 * 1024 * 1024,
  };
}

function parsePage({ url, html, headers = {}, statusCode = 200, extractors = [], searchRules = [], spellCheck = false, grammarCheck = true, contentArea = DEFAULT_CONTENT_AREA, linkPositions = [], storeHtml = false, excludeLinkPaths = [], maxLinksPerUrl = 0 }) {
  const $ = cheerio.load(html || '');
  const rawHtml = String(html || '');
  const title = $('title').first().text().trim().replace(/\s+/g, ' ');
  const metaDesc = $('meta[name="description" i]').attr('content') || '';
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
  const posRules = [...(linkPositions || []), ...DEFAULT_LINK_POSITIONS];
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
    const imgAlt = $(el).find('img[alt]').first().attr('alt') || '';
    if (maxLinksPerUrl && links.length >= maxLinksPerUrl) return;
    const path = ancestorPath($, el);
    const excludedByPath = (excludeLinkPaths || []).some((pat) => { try { return new RegExp(pat, 'i').test(path); } catch (_) { return path.includes(String(pat).toLowerCase()); } });
    const emptyAnchor = !$(el).text().trim() && !$(el).find('img').length && !($(el).attr('aria-label') || '').trim() && !($(el).attr('title') || '').trim();
    const fragment = (() => { try { return new URL(href, url).hash.slice(1); } catch (_) { return ''; } })();
    links.push({ url: abs, anchor: $(el).text().trim().replace(/\s+/g, ' ').slice(0, 200), alt: imgAlt.trim().slice(0, 200), rel, follow: !/nofollow/i.test(rel), target, external, unsafeCrossOrigin, position: linkPosition(path, posRules),
      ...(emptyAnchor ? { emptyAnchor: true } : {}), ...(excludedByPath ? { excludedByPath: true } : {}), ...(fragment && !fragment.startsWith('!') && !fragment.includes('=') ? { fragment: safeDecode(fragment).slice(0, 120) } : {}) });
  });
  // iframes (followed only when Configuration > Spider > Crawl > Iframes is on)
  const iframes = $('iframe[src]').map((_, el) => normalizeUrl($(el).attr('src') || '', url)).get().filter(Boolean);
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
    if (src) images.push({ url: src, title: $(el).attr('title'), loading: $(el).attr('loading') || '', format: ((src.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1] || '').toLowerCase(), alt: $(el).attr('alt'), hasAlt: $(el).attr('alt') !== undefined, width: $(el).attr('width') || '', height: $(el).attr('height') || '', hasSizeAttrs: !!($(el).attr('width') && $(el).attr('height')) });
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
  // body text + content metrics, limited to the configured Content Area
  const area = { ...DEFAULT_CONTENT_AREA, ...(contentArea || {}) };
  const bodyClone = $('body').clone();
  bodyClone.find('script,style,noscript,template').remove();
  for (const sel of area.exclude || []) { try { if (sel) bodyClone.find(sel).remove(); } catch (_) {} }
  let text;
  const inc = (area.include || []).filter(Boolean);
  if (inc.length) {
    const parts = [];
    for (const sel of inc) { try { bodyClone.find(sel).each((_, el) => { parts.push($(el).text()); }); } catch (_) {} }
    text = parts.join(' ').replace(/\s+/g, ' ').trim();
  } else text = bodyClone.text().replace(/\s+/g, ' ').trim();
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  const sentenceList = text ? text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 1) : [];
  const sentenceCount = Math.max(sentenceList.length, words.length ? 1 : 0);
  const wordsArr = [...words]; wordsArr._sentences = sentenceCount;
  const flesch = fleschReadingEase(wordsArr);
  const spell = spellCheck ? countSpellingErrors(text) : { errors: 0, unknown: [] };
  const grammar = grammarCheck ? checkGrammar(text) : { errors: 0, matches: [] };
  const a11y = checkAccessibility($);
  const social = socialTags($);
  const validation = validateHtml(rawHtml);
  const anchorIds = [...new Set($('[id],a[name]').map((_, el) => $(el).attr('id') || $(el).attr('name')).get().filter(Boolean))].slice(0, 3000);
  const viewport = ($('meta[name="viewport" i]').attr('content') || '').trim();
  const mobileAlternate = normalizeUrl($('link[rel="alternate" i][media*="max-width" i]').attr('href') || '', url) || '';
  let markdown = '';
  if (storeHtml) { try { const md$ = cheerio.load(html || ''); const b = md$('body'); b.find('script,style,noscript,template').remove(); for (const sel of (area.exclude || [])) { try { if (sel) b.find(sel).remove(); } catch (_) {} } markdown = htmlToMarkdown(md$, b).slice(0, 500000); } catch (_) { markdown = ''; } }
  const mixedContent = /^https:/i.test(url) ? [...rawHtml.matchAll(/http:\/\/[^\s"'<>]+/g)].map((m) => m[0]).slice(0, 20) : [];
  const missingSecHeaders = /^https:/i.test(url) ? SECURITY_HEADERS.filter((h) => !headers[h]) : [];
  const soft404 = statusCode === 200 && words.length < 60 && /(\b404\b|not found|page not found|error occurred|does not exist)/i.test(title + ' ' + text.slice(0, 300));
  return {
    title, titleLength: title.length, titlePixelWidth: pixelWidth(title),
    titles: $('title').map((_, el) => $(el).text().trim().replace(/\s+/g, ' ')).get().filter(Boolean),
    metaDescription: metaDesc.trim(), metaDescriptionLength: metaDesc.trim().length, metaDescriptionPixelWidth: pixelWidth(metaDesc.trim()),
    metaDescriptions: $('meta[name="description" i]').map((_, el) => $(el).attr('content') || '').get(),
    h1s, h2s, allHeadings, headingLevels: allHeadings.map((h) => h.level), h1HasAltImg,
    metaRobots: metaRobots.trim(), xRobotsTag: String(xRobots).trim(),
    directives: parseDirectives(metaRobots, xRobots),
    canonical: canonicals[0] || '', canonicals, canonicalHrefs,
    hreflang, pagination: nextPrev, paginationAll: { next: nextAll, prev: prevAll },
    ampUrl: ampUrl || '', metaRefresh,
    links, iframes, forms, images, backgroundImages, resources, protocolRelativeCount,
    structuredData: [...new Set(sdTypes)], sdItems,
    wordCount: words.length, sentenceCount, avgWordsPerSentence: sentenceCount ? Math.round((words.length / sentenceCount) * 10) / 10 : 0,
    flesch, readability: flesch === null ? '' : (flesch >= 60 ? 'Standard' : flesch >= 30 ? 'Difficult' : 'Very Difficult'),
    loremIpsum: /lorem ipsum/i.test(text),
    soft404: !!soft404,
    spellingErrors: spell.errors, spellingUnknown: spell.unknown || [],
    grammarErrors: grammar.errors, grammarMatches: grammar.matches,
    htmlLang: ($('html').attr('lang') || '').trim(),
    a11yViolations: a11y.violations, a11y: a11y.checks,
    social, validation, anchorIds, viewport, mobileAlternate,
    ...(markdown ? { markdown } : {}),
    ...(storeHtml ? { rawHtml: rawHtml.slice(0, 2 * 1024 * 1024) } : {}),
    textRatio: rawHtml ? Math.round((text.length / rawHtml.length) * 1000) / 10 : 0,
    text, textExcerpt: text.slice(0, 3000), hash: md5(text), simhash: simhash(text).toString(),
    mixedContent, missingSecurityHeaders: missingSecHeaders,
    ...placement,
    extractions: applyExtractors($, rawHtml, extractors),
    searchMatches: applySearch(rawHtml, searchRules),
  };
}

module.exports = { parsePage, htmlToMarkdown, socialTags, validateHtml, DEFAULT_LINK_POSITIONS, DEFAULT_CONTENT_AREA, ancestorPath, linkPosition, md5, shingles, jaccard, simhash, simhashSimilarity, applyExtractors, applySearch, xpathToCss, syllables, fleschReadingEase, parseDirectives, SECURITY_HEADERS };
