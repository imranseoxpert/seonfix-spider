'use strict';
/* Crawl analysis aggregates shared by the sidebar panels, exports and
 * reports: Summary counts, response-time buckets, site structure
 * (directory aggregation + crawl depth) and segment statistics. */
const { directoryChain } = require('./urlutil');

function summaryCounts(pages) {
  const encountered = pages.length;
  const intBlocked = pages.filter((p) => !p.external && p.indexabilityReason === 'Blocked by robots.txt').length;
  const extBlocked = pages.filter((p) => p.external && p.indexabilityReason === 'Blocked by robots.txt').length;
  const crawledPages = pages.filter((p) => !p.sitemapOnly);
  const internal = pages.filter((p) => !p.external);
  const external = pages.filter((p) => p.external);
  return [
    { label: 'Total URLs Encountered', count: encountered },
    { label: 'Total Internal Blocked by robots.txt', count: intBlocked },
    { label: 'Total External Blocked by robots.txt', count: extBlocked },
    { label: 'Total URLs Crawled', count: crawledPages.length },
    { label: 'Total Internal URLs', count: internal.length },
    { label: 'Total External URLs', count: external.length },
    { label: 'Total Internal Indexable URLs', count: internal.filter((p) => p.indexability === 'Indexable').length },
    { label: 'Total Internal Non-Indexable URLs', count: internal.filter((p) => p.indexability === 'Non-Indexable').length },
  ];
}

function responseTimeBuckets(pages) {
  const times = pages.filter((p) => typeof p.responseTimeMs === 'number' && p.statusCode > 0).map((p) => p.responseTimeMs / 1000);
  const average = times.length ? Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100 : 0;
  const defs = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, Infinity]];
  const buckets = defs.map(([lo, hi]) => {
    const count = times.filter((t) => t >= lo && t < hi).length;
    return { label: hi === Infinity ? '5+' : `${lo}-${hi}`, count, pct: times.length ? Math.round((count / times.length) * 1000) / 10 : 0 };
  });
  return { average, buckets, sampled: times.length };
}

function siteStructure(pages) {
  const rowsMap = new Map();
  const internal = pages.filter((p) => !p.external && !p.sitemapOnly);
  for (const p of internal) {
    for (const seg of directoryChain(p.address)) {
      if (!rowsMap.has(seg)) rowsMap.set(seg, { segment: seg, urls: 0, indexable: 0, nonIndexable: 0 });
    }
    // attribute the page to every ancestor segment in its chain
    for (const seg of directoryChain(p.address)) {
      const row = rowsMap.get(seg);
      row.urls++;
      if (p.indexability === 'Indexable') row.indexable++;
      else if (p.indexability === 'Non-Indexable') row.nonIndexable++;
    }
  }
  const total = internal.length || 1;
  const rows = [...rowsMap.values()].map((r) => ({ ...r, pct: Math.round((r.urls / total) * 1000) / 10 }))
    .sort((a, b) => (a.segment.split('/').length - b.segment.split('/').length) || (b.urls - a.urls));
  // crawl depth distribution with status buckets (legend per spec)
  const depthMap = new Map();
  for (const p of internal) {
    const d = typeof p.depth === 'number' ? p.depth : 0;
    if (!depthMap.has(d)) depthMap.set(d, { depth: d, total: 0, blocked: 0, noResponse: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 });
    const row = depthMap.get(d); row.total++;
    if (p.indexabilityReason === 'Blocked by robots.txt') row.blocked++;
    else if (!p.statusCode) row.noResponse++;
    else if (p.statusCode < 300) row.s2xx++;
    else if (p.statusCode < 400) row.s3xx++;
    else if (p.statusCode < 500) row.s4xx++;
    else row.s5xx++;
  }
  const depthChart = [...depthMap.values()].sort((a, b) => a.depth - b.depth);
  return { rows, depthChart };
}

function matchSegment(url, segment) {
  if (!segment || !segment.pattern) return false;
  try { return new RegExp(segment.pattern).test(url); } catch (_) { return String(url).includes(segment.pattern); }
}

function segmentStats(pages, segments) {
  const total = pages.length || 1;
  return (segments || []).map((s) => {
    const matched = pages.filter((p) => matchSegment(p.address, s));
    return {
      name: s.name || s.pattern, pattern: s.pattern,
      urls: matched.length, pct: Math.round((matched.length / total) * 1000) / 10,
      indexable: matched.filter((p) => p.indexability === 'Indexable').length,
      nonIndexable: matched.filter((p) => p.indexability === 'Non-Indexable').length,
      addresses: matched.map((p) => p.address),
    };
  });
}

function buildAnalysis(pages, config = {}) {
  return {
    summary: summaryCounts(pages),
    responseTimes: responseTimeBuckets(pages),
    siteStructure: siteStructure(pages),
    segments: segmentStats(pages, config.segments || []),
    spelling: {
      pagesWithErrors: pages.filter((p) => (p.spellingErrors || 0) > 0).length,
      totalErrors: pages.reduce((a, p) => a + (p.spellingErrors || 0), 0),
      grammarErrors: 0,
    },
  };
}

module.exports = { buildAnalysis, summaryCounts, responseTimeBuckets, siteStructure, segmentStats, matchSegment };
