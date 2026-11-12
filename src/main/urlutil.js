'use strict';
/* URL helpers: normalisation, resolution, host checks. No Electron deps. */

function normalizeUrl(input, base) {
  if (!input || typeof input !== 'string') return null;
  let u;
  try { u = base ? new URL(input.trim(), base) : new URL(input.trim()); }
  catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  // Lowercase host, drop default ports, collapse duplicate slashes in path.
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  // Sort query params for stable identity.
  if (u.search) {
    const params = [...u.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : String(a[1]) < String(b[1]) ? -1 : 1));
    u.search = '';
    for (const [k, v] of params) u.searchParams.append(k, v);
  }
  return u.toString();
}

function ensureUrl(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !s.startsWith('//')) s = 'https://' + s;
  return normalizeUrl(s);
}

function originOf(url) { try { return new URL(url).origin; } catch (_) { return null; } }
function hostOf(url) { try { return new URL(url).host; } catch (_) { return ''; } }
function isInternal(url, rootUrl) { return originOf(url) === originOf(rootUrl); }

function crawlDepthOf(url, rootUrl) {
  try {
    const a = new URL(url).pathname.split('/').filter(Boolean);
    const b = new URL(rootUrl).pathname.split('/').filter(Boolean);
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    return Math.max(0, a.length - common);
  } catch (_) { return 0; }
}

function directoryOf(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts.length <= 1) return '/';
    return '/' + parts.slice(0, -1).join('/') + '/';
  } catch (_) { return '/'; }
}

// Approximate rendered pixel width of a title at ~15px Arial-ish metrics.
function pixelWidth(text) {
  if (!text) return 0;
  let w = 0;
  for (const ch of String(text)) {
    if (ch === ' ') w += 4;
    else if (/[iljtf.,:;'!]/.test(ch)) w += 4;
    else if (/[mwMW]/.test(ch)) w += 13;
    else if (/[A-Z]/.test(ch)) w += 10;
    else if (/[0-9]/.test(ch)) w += 8;
    else w += 8;
  }
  return Math.round(w);
}

function matchPattern(pattern, url) {
  if (!pattern) return false;
  try { return new RegExp(pattern).test(url); } catch (_) { return url.includes(pattern); }
}

function shouldInclude(url, config) {
  const inc = (config.includePatterns || []).filter(Boolean);
  const exc = (config.excludePatterns || []).filter(Boolean);
  for (const p of exc) if (matchPattern(p, url)) return false;
  if (inc.length && !inc.some((p) => matchPattern(p, url))) return false;
  return true;
}

module.exports = { normalizeUrl, ensureUrl, originOf, hostOf, isInternal, crawlDepthOf, directoryOf, pixelWidth, matchPattern, shouldInclude };
