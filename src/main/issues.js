'use strict';
/* v2 compatibility wrapper: the v1 issues API (buildContext / issuesForPage /
 * summarise) is now backed by the filter registry + issues catalogue in
 * filters.js. Per-page `issues` are issue NAMES; crawl summaries carry
 * type + priority. */
const { buildFilterContext, applyFilters, summariseIssues, ISSUES } = require('./filters');

function buildContext(pages) {
  return buildFilterContext(pages, pages && pages[0] ? pages[0].address : '', {});
}

const ISSUE_BY_FILTER = new Map();
for (const iss of ISSUES) if (iss.filterId) { if (!ISSUE_BY_FILTER.has(iss.filterId)) ISSUE_BY_FILTER.set(iss.filterId, []); ISSUE_BY_FILTER.get(iss.filterId).push(iss); }

function issuesForPage(page, ctx) {
  if (!page.filters) {
    const c = ctx && ctx.byUrl ? ctx : buildFilterContext([page], page.address, {});
    const { FILTERS } = require('./filters');
    page.filters = FILTERS.filter((f) => { try { return f.test(page, c); } catch (_) { return false; } }).map((f) => f.id);
  }
  const names = [];
  for (const fid of page.filters || []) {
    for (const iss of ISSUE_BY_FILTER.get(fid) || []) if (!names.includes(iss.name)) names.push(iss.name);
  }
  if (page.isOrphan) names.push('Orphan Pages (No Inlinks)');
  return names;
}

function summarise(pages, ctx) {
  if (pages.some((p) => !p.filters)) applyFilters(pages, ctx && ctx.byUrl ? ctx : buildFilterContext(pages, '', {}));
  return summariseIssues(pages).map((i) => ({ id: i.id, name: i.name, severity: i.type === 'Issue' ? 'Error' : i.type, type: i.type, priority: i.priority, count: i.count, pct: i.pct }));
}

module.exports = { buildContext, issuesForPage, summarise };
