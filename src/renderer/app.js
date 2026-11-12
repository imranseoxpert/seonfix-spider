'use strict';
/* Seonfix Spider renderer. All crawl data arrives from the main process via
 * the window.spider preload bridge; the renderer never touches the network. */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isHtml = (p) => /text\/html|xhtml/.test(p.contentType || '') || (p.title !== undefined && !p.external);
const dupOf = (pages, pick) => { const m = new Map(); for (const p of pages) { const v = pick(p); if (v) m.set(String(v).toLowerCase(), (m.get(String(v).toLowerCase()) || 0) + 1); } return m; };

let state = { crawl: null, tab: 'overview', filter: 'All', search: '', sortKey: null, sortDir: 1, selected: null, issueFilter: null, config: null, uaPresets: {}, compare: null, btab: 'details' };
window.__spiderState = state;

/* ---------- tab definitions ---------- */
const C = (key, label, get, num) => ({ key, label, get: get || ((p) => p[key]), num: !!num });
const F = (label, test) => ({ label, test });
const ALL = F('All', () => true);
const statusFilters = [ALL, F('Success (2xx)', (p) => p.statusCode >= 200 && p.statusCode < 300), F('Redirect (3xx)', (p) => p.statusCode >= 300 && p.statusCode < 400), F('Client Error (4xx)', (p) => p.statusCode >= 400 && p.statusCode < 500), F('Server Error (5xx)', (p) => p.statusCode >= 500), F('No Response', (p) => !p.statusCode)];
const baseCols = [C('address', 'Address'), C('statusCode', 'Status Code', null, true), C('status', 'Status')];

function titlesDup(pages) { return dupOf(pages, (p) => p.title); }
function descDup(pages) { return dupOf(pages, (p) => p.metaDescription); }
function h1Dup(pages) { return dupOf(pages, (p) => p.h1s && p.h1s[0]); }
function h2Dup(pages) { return dupOf(pages, (p) => p.h2s && p.h2s[0]); }

const TABS = [
  { id: 'overview', label: 'Overview', panel: 'overview-panel' },
  { id: 'internal', label: 'Internal', rows: (cr) => cr.pages.filter((p) => !p.external), columns: [...baseCols, C('contentType', 'Content Type'), C('indexability', 'Indexability'), C('indexabilityReason', 'Indexability Reason'), C('title', 'Page Title'), C('titleLength', 'Title Length', null, true), C('metaDescriptionLength', 'Meta Desc Length', null, true), C('h1', 'H1', (p) => (p.h1s || [])[0] || ''), C('depth', 'Depth', null, true), C('inlinks', 'Inlinks', null, true), C('outlinks', 'Outlinks', null, true), C('wordCount', 'Word Count', null, true), C('responseTimeMs', 'Response Time (ms)', null, true)],
    filters: [ALL, F('Indexable', (p) => p.indexability === 'Indexable'), F('Non-Indexable', (p) => p.indexability === 'Non-Indexable'), F('HTML', isHtml), ...statusFilters.slice(1)] },
  { id: 'external', label: 'External', rows: (cr) => cr.pages.filter((p) => p.external), columns: [...baseCols, C('inlinks', 'Inlinks', null, true), C('depth', 'Depth', null, true)], filters: [ALL] },
  { id: 'responses', label: 'Response Codes', rows: (cr) => cr.pages, columns: [...baseCols, C('indexability', 'Indexability'), C('redirectUrl', 'Redirect URL'), C('depth', 'Depth', null, true), C('inlinks', 'Inlinks', null, true)], filters: statusFilters },
  { id: 'protocol', label: 'Protocol', rows: (cr) => cr.pages, columns: [...baseCols, C('protocol', 'Protocol', (p) => (p.address.startsWith('https:') ? 'HTTPS' : 'HTTP'))], filters: [ALL, F('HTTPS', (p) => p.address.startsWith('https:')), F('HTTP', (p) => p.address.startsWith('http:') && !p.address.startsWith('https:'))] },
  { id: 'url', label: 'URL', rows: (cr) => cr.pages, columns: [C('address', 'Address'), C('len', 'Length', (p) => p.address.length, true), C('depth', 'Depth', null, true), C('statusCode', 'Status Code', null, true)],
    filters: [ALL, F('Contains Parameters', (p) => p.address.includes('?')), F('Uppercase', (p) => /[A-Z]/.test(new URL(p.address).pathname)), F('Underscores', (p) => p.address.includes('_')), F('Over 115 Characters', (p) => p.address.length > 115), F('Non-ASCII', (p) => /[^\x00-\x7F]/.test(p.address))] },
  { id: 'titles', label: 'Page Titles', rows: (cr) => cr.pages.filter(isHtml), columns: [C('address', 'Address'), C('title', 'Page Title'), C('titleLength', 'Length', null, true), C('titlePixelWidth', 'Pixel Width', null, true), C('statusCode', 'Status Code', null, true)],
    filters: (cr) => { const d = titlesDup(cr.pages); return [ALL, F('Missing', (p) => !p.title), F('Duplicate', (p) => p.title && d.get(p.title.toLowerCase()) > 1), F('Over 60 Characters', (p) => p.titleLength > 60), F('Below 30 Characters', (p) => p.title && p.titleLength < 30), F('Over 561 Pixels', (p) => p.titlePixelWidth > 561), F('Same as H1', (p) => p.title && (p.h1s || [])[0] === p.title)]; } },
  { id: 'desc', label: 'Meta Description', rows: (cr) => cr.pages.filter(isHtml), columns: [C('address', 'Address'), C('metaDescription', 'Meta Description'), C('metaDescriptionLength', 'Length', null, true), C('statusCode', 'Status Code', null, true)],
    filters: (cr) => { const d = descDup(cr.pages); return [ALL, F('Missing', (p) => !p.metaDescription), F('Duplicate', (p) => p.metaDescription && d.get(p.metaDescription.toLowerCase()) > 1), F('Over 155 Characters', (p) => p.metaDescriptionLength > 155), F('Below 70 Characters', (p) => p.metaDescription && p.metaDescriptionLength < 70)]; } },
  { id: 'keywords', label: 'Meta Keywords', rows: (cr) => cr.pages.filter(isHtml), columns: [C('address', 'Address'), C('metaKeywords', 'Meta Keywords'), C('statusCode', 'Status Code', null, true)], filters: [ALL, F('Present', (p) => !!p.metaKeywords), F('Missing', (p) => !p.metaKeywords)] },
  { id: 'h1', label: 'H1', rows: (cr) => cr.pages.filter(isHtml), columns: [C('address', 'Address'), C('h1', 'H1', (p) => (p.h1s || [])[0] || ''), C('h1count', 'Count', (p) => (p.h1s || []).length, true), C('statusCode', 'Status Code', null, true)],
    filters: (cr) => { const d = h1Dup(cr.pages); return [ALL, F('Missing', (p) => !(p.h1s || []).length), F('Duplicate', (p) => (p.h1s || []).length && d.get(p.h1s[0].toLowerCase()) > 1), F('Multiple', (p) => (p.h1s || []).length > 1), F('Over 70 Characters', (p) => ((p.h1s || [])[0] || '').length > 70)]; } },
  { id: 'h2', label: 'H2', rows: (cr) => cr.pages.filter(isHtml), columns: [C('address', 'Address'), C('h2', 'H2', (p) => (p.h2s || [])[0] || ''), C('h2count', 'Count', (p) => (p.h2s || []).length, true), C('statusCode', 'Status Code', null, true)],
    filters: (cr) => { const d = h2Dup(cr.pages); return [ALL, F('Missing', (p) => !(p.h2s || []).length), F('Duplicate', (p) => (p.h2s || []).length && d.get(p.h2s[0].toLowerCase()) > 1), F('Multiple', (p) => (p.h2s || []).length > 1)]; } },
  { id: 'images', label: 'Images', rows: (cr) => { const out = []; for (const p of cr.pages) for (const im of p.images || []) out.push({ address: im.url, from: p.address, alt: im.alt ?? '', hasAlt: im.hasAlt, size: im.size || 0, width: im.width || '', height: im.height || '' }); return out; },
    columns: [C('address', 'Image Address'), C('from', 'From Page'), C('alt', 'Alt Text'), C('size', 'Size (bytes)', null, true), C('width', 'Width'), C('height', 'Height')],
    filters: [ALL, F('Missing Alt Text', (r) => !r.hasAlt || !String(r.alt).trim()), F('Over 100 KB', (r) => r.size > 102400)], imagesTab: true },
  { id: 'canonicals', label: 'Canonicals', rows: (cr) => cr.pages.filter(isHtml), columns: [C('address', 'Address'), C('canonical', 'Canonical URL'), C('ccount', 'Canonical Count', (p) => (p.canonicals || []).length, true), C('indexability', 'Indexability'), C('statusCode', 'Status Code', null, true)],
    filters: [ALL, F('Canonicalised', (p) => p.canonical && p.canonical !== p.address), F('Missing', (p) => !p.canonical), F('Multiple', (p) => (p.canonicals || []).length > 1), F('Self-Referencing', (p) => p.canonical === p.address)] },
  { id: 'pagination', label: 'Pagination', rows: (cr) => cr.pages.filter((p) => p.pagination && (p.pagination.next || p.pagination.prev)), columns: [C('address', 'Address'), C('next', 'rel Next', (p) => p.pagination.next || ''), C('prev', 'rel Prev', (p) => p.pagination.prev || '')], filters: [ALL] },
  { id: 'directives', label: 'Directives', rows: (cr) => cr.pages.filter(isHtml), columns: [C('address', 'Address'), C('metaRobots', 'Meta Robots'), C('xRobotsTag', 'X-Robots-Tag'), C('indexability', 'Indexability'), C('statusCode', 'Status Code', null, true)],
    filters: [ALL, F('Noindex', (p) => /noindex/i.test((p.metaRobots || '') + (p.xRobotsTag || ''))), F('Nofollow', (p) => /nofollow/i.test((p.metaRobots || '') + (p.xRobotsTag || ''))), F('None Set', (p) => !p.metaRobots && !p.xRobotsTag)] },
  { id: 'hreflang', label: 'hreflang', rows: (cr) => cr.pages.filter((p) => (p.hreflang || []).length), columns: [C('address', 'Address'), C('hcount', 'Entries', (p) => p.hreflang.length, true), C('hlist', 'Languages', (p) => p.hreflang.map((h) => h.lang).join(', ')), C('statusCode', 'Status Code', null, true)],
    filters: [ALL, F('With Issues', (p) => (p.issues || []).some((i) => i.startsWith('hreflang:')))] },
  { id: 'structured', label: 'Structured Data', rows: (cr) => cr.pages.filter((p) => (p.structuredData || []).length), columns: [C('address', 'Address'), C('types', 'Types Found', (p) => (p.structuredData || []).join(', ')), C('statusCode', 'Status Code', null, true)], filters: [ALL] },
  { id: 'sitemaps', label: 'Sitemaps', rows: (cr) => cr.pages.filter((p) => p.indexability === 'Indexable'), columns: [...baseCols, C('title', 'Page Title')], filters: [ALL], note: 'Indexable URLs - use File menu > Generate XML Sitemap to export them as a sitemap.' },
  { id: 'extraction', label: 'Custom Extraction', rows: (cr) => cr.pages.filter((p) => p.extractions && Object.keys(p.extractions).length), columns: (cr) => { const keys = [...new Set(cr.pages.flatMap((p) => Object.keys(p.extractions || {})))]; return [C('address', 'Address'), ...keys.map((k) => C('ex_' + k, k, (p) => (p.extractions || {})[k] || ''))]; }, filters: [ALL] },
  { id: 'search', label: 'Custom Search', rows: (cr) => cr.pages.filter((p) => p.searchMatches && Object.keys(p.searchMatches).length), columns: (cr) => { const keys = [...new Set(cr.pages.flatMap((p) => Object.keys(p.searchMatches || {})))]; return [C('address', 'Address'), ...keys.map((k) => C('cs_' + k, k, (p) => String((p.searchMatches || {})[k] ?? '')))]; }, filters: [ALL] },
  { id: 'visualisation', label: 'Visualisation', panel: 'visual-panel' },
  { id: 'compare', label: 'Crawl Compare', panel: 'compare-panel' },
];

function currentTab() { return TABS.find((t) => t.id === state.tab) || TABS[0]; }
function tabRows() {
  const cr = state.crawl; if (!cr) return [];
  const t = currentTab(); if (!t.rows) return [];
  let rows = t.rows(cr);
  const filters = typeof t.filters === 'function' ? t.filters(cr) : (t.filters || [ALL]);
  const f = filters.find((x) => x.label === state.filter) || filters[0];
  rows = rows.filter((r) => { try { return f.test(r); } catch (_) { return true; } });
  if (state.issueFilter) rows = rows.filter((r) => (r.issues || []).includes(state.issueFilter));
  if (state.search) { const q = state.search.toLowerCase(); rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)); }
  if (state.sortKey) {
    const col = (typeof t.columns === 'function' ? t.columns(cr) : t.columns).find((c) => c.key === state.sortKey);
    if (col) rows = [...rows].sort((a, b) => { const va = col.get(a), vb = col.get(b); const na = Number(va), nb = Number(vb); const cmp = (!Number.isNaN(na) && !Number.isNaN(nb) && va !== '' && vb !== '') ? na - nb : String(va ?? '').localeCompare(String(vb ?? '')); return cmp * state.sortDir; });
  }
  return rows;
}

function renderTabs() {
  $('#tabs').innerHTML = TABS.map((t) => `<button data-tab="${t.id}" class="${t.id === state.tab ? 'active' : ''}">${esc(t.label)}</button>`).join('');
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.filter = 'All'; state.issueFilter = null; renderAll(); }));
}

function renderGrid() {
  const t = currentTab();
  const panels = ['overview-panel', 'visual-panel', 'compare-panel'];
  panels.forEach((id) => document.getElementById(id).classList.toggle('active', t.panel === id));
  $('#table-wrap').style.display = t.panel ? 'none' : '';
  $('#filter-row').style.display = t.panel ? 'none' : '';
  if (t.panel === 'overview-panel') return renderOverview();
  if (t.panel === 'visual-panel') return renderVisual();
  if (t.panel === 'compare-panel') return renderCompare();
  const cr = state.crawl;
  const filters = cr ? (typeof t.filters === 'function' ? t.filters(cr) : (t.filters || [ALL])) : [ALL];
  $('#tab-filter').innerHTML = filters.map((f) => `<option ${f.label === state.filter ? 'selected' : ''}>${esc(f.label)}</option>`).join('');
  const columns = cr ? (typeof t.columns === 'function' ? t.columns(cr) : t.columns) : [];
  const rows = tabRows();
  $('#row-count').textContent = cr ? `${rows.length} rows${state.issueFilter ? ' - issue: ' + state.issueFilter : ''}${t.note ? ' - ' + t.note : ''}` : 'No crawl loaded';
  $('#grid thead').innerHTML = '<tr>' + columns.map((c) => `<th data-key="${c.key}" class="${c.num ? 'num' : ''}">${esc(c.label)}${state.sortKey === c.key ? (state.sortDir > 0 ? ' ^' : ' v') : ''}</th>`).join('') + '</tr>';
  document.querySelectorAll('#grid th').forEach((th) => th.addEventListener('click', () => { if (state.sortKey === th.dataset.key) state.sortDir *= -1; else { state.sortKey = th.dataset.key; state.sortDir = 1; } renderGrid(); }));
  $('#grid tbody').innerHTML = rows.map((r, i) => '<tr data-i="' + i + '">' + columns.map((c) => { const v = c.get(r); const cls = c.key === 'statusCode' ? (v >= 500 || v >= 400 ? 'st-err' : v >= 300 ? 'st-warn' : v ? 'st-ok' : '') : ''; return `<td class="${c.num ? 'num' : ''} ${cls}" title="${esc(v ?? '')}">${esc(v ?? '')}</td>`; }).join('') + '</tr>').join('');
  document.querySelectorAll('#grid tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => selectRow(rows[Number(tr.dataset.i)], tr));
    tr.addEventListener('dblclick', () => { const r = rows[Number(tr.dataset.i)]; if (r && r.address) window.spider.openExternal(r.address); });
  });
}

function selectRow(row, tr) {
  document.querySelectorAll('#grid tbody tr').forEach((x) => x.classList.remove('selected'));
  if (tr) tr.classList.add('selected');
  state.selected = row;
  renderBottom();
}

/* ---------- bottom pane ---------- */
function renderBottom() {
  const p = state.selected; const body = $('#bottom-body');
  if (!p) { body.textContent = 'Select a URL row to see its details.'; return; }
  const pages = state.crawl ? state.crawl.pages : [];
  if (state.btab === 'details') {
    const kv = [['Address', p.address], ['Content Type', p.contentType], ['Status Code', p.statusCode], ['Status', p.status], ['Indexability', (p.indexability || '') + (p.indexabilityReason ? ' - ' + p.indexabilityReason : '')], ['Page Title', p.title], ['Title Length / Pixels', `${p.titleLength ?? ''} / ${p.titlePixelWidth ?? ''}`], ['Meta Description', p.metaDescription], ['H1', (p.h1s || []).join(' | ')], ['H2', (p.h2s || []).join(' | ')], ['Canonical', p.canonical], ['Meta Robots', p.metaRobots], ['X-Robots-Tag', p.xRobotsTag], ['Word Count', p.wordCount], ['Text Ratio %', p.textRatio], ['Crawl Depth', p.depth], ['Inlinks / Unique', `${p.inlinks ?? ''} / ${p.uniqueInlinks ?? ''}`], ['Outlinks / External', `${p.outlinks ?? ''} / ${p.externalOutlinks ?? ''}`], ['Response Time (ms)', p.responseTimeMs], ['Size (bytes)', p.sizeBytes], ['Redirect URL', p.redirectUrl], ['Content Hash (MD5)', p.hash], ['Near Duplicate Of', p.nearDuplicateOf || ''], ['Rendered Title', p.renderedTitle || ''], ['Issues', (p.issues || []).join('; ')]]; 
    body.innerHTML = '<table class="kv">' + kv.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v ?? '')}</td></tr>`).join('') + '</table>';
  } else if (state.btab === 'inlinks') {
    const rows = pages.filter((q) => (q.links || []).some((l) => l.url === p.address));
    body.innerHTML = rows.length ? '<table><tr><th>From URL</th><th>Anchor Text</th><th>Follow</th></tr>' + rows.map((q) => { const l = q.links.find((x) => x.url === p.address); return `<tr><td>${esc(q.address)}</td><td>${esc(l.anchor)}</td><td>${l.follow ? 'Follow' : 'Nofollow'}</td></tr>`; }).join('') + '</table>' : 'No inlinks in this crawl.';
  } else if (state.btab === 'outlinks') {
    body.innerHTML = (p.links || []).length ? '<table><tr><th>To URL</th><th>Anchor Text</th><th>Follow</th></tr>' + p.links.map((l) => `<tr><td>${esc(l.url)}</td><td>${esc(l.anchor)}</td><td>${l.follow ? 'Follow' : 'Nofollow'}</td></tr>`).join('') + '</table>' : 'No outlinks recorded.';
  } else if (state.btab === 'images') {
    body.innerHTML = (p.images || []).length ? '<table><tr><th>Image URL</th><th>Alt Text</th><th>Size (bytes)</th><th>Width</th><th>Height</th></tr>' + p.images.map((im) => `<tr><td>${esc(im.url)}</td><td>${esc(im.alt ?? '')}</td><td>${esc(im.size ?? '')}</td><td>${esc(im.width)}</td><td>${esc(im.height)}</td></tr>`).join('') + '</table>' : 'No images on this page.';
  } else if (state.btab === 'resources') {
    body.innerHTML = (p.resources || []).length ? '<table><tr><th>Resource URL</th><th>Type</th></tr>' + p.resources.map((r) => `<tr><td>${esc(r.url)}</td><td>${esc(r.type)}</td></tr>`).join('') + '</table>' : 'No resources collected for this page.';
  } else {
    body.innerHTML = '<table class="kv">' + Object.entries(p.headers || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') + '</table>' + ((p.redirectChain || []).length ? '<p>Redirect chain: ' + p.redirectChain.map((h) => `${esc(h.from)} -[${h.status}]-> `).join('') + esc(p.redirectUrl || '') + '</p>' : '');
  }
}

/* ---------- sidebar / overview / visual / compare ---------- */
function renderSidebar() {
  const cr = state.crawl;
  if (!cr) { $('#side-overview').textContent = 'No crawl yet.'; $('#side-responses').textContent = '-'; $('#side-indexability').textContent = '-'; $('#side-issues').textContent = 'No crawl yet.'; return; }
  const s = cr.stats;
  $('#side-overview').innerHTML = [['Total URLs', s.total], ['Crawled', s.crawled], ['Indexable', s.indexable], ['Non-Indexable', s.nonIndexable], ['Duration (s)', Math.round(s.durationMs / 100) / 10], ['Root', cr.rootUrl]].map(([k, v]) => `<div class="tree-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  const groups = [['Success (2xx)', (p) => p.statusCode >= 200 && p.statusCode < 300], ['Redirect (3xx)', (p) => p.statusCode >= 300 && p.statusCode < 400], ['Client Error (4xx)', (p) => p.statusCode >= 400 && p.statusCode < 500], ['Server Error (5xx)', (p) => p.statusCode >= 500], ['No Response', (p) => !p.statusCode]];
  $('#side-responses').innerHTML = groups.map(([label, test]) => `<div class="tree-row" data-resp="${esc(label)}"><span>${esc(label)}</span><b>${cr.pages.filter(test).length}</b></div>`).join('');
  document.querySelectorAll('[data-resp]').forEach((el) => el.addEventListener('click', () => { state.tab = 'responses'; state.filter = el.dataset.resp; state.issueFilter = null; renderAll(); }));
  const reasons = {};
  for (const p of cr.pages) { const r = p.indexabilityReason || p.indexability || 'Unknown'; reasons[r] = (reasons[r] || 0) + 1; }
  $('#side-indexability').innerHTML = Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="tree-row"><span>${esc(k)}</span><b>${v}</b></div>`).join('');
  $('#side-issues').innerHTML = cr.issues.map((i) => `<div class="issue-row" data-issue="${esc(i.name)}"><span>${esc(i.name)} <span class="sev sev-${i.severity}">${esc(i.severity)}</span></span><b>${i.count} (${i.pct}%)</b></div>`).join('') || 'No issues found.';
  document.querySelectorAll('[data-issue]').forEach((el) => el.addEventListener('click', () => { state.tab = 'internal'; state.filter = 'All'; state.issueFilter = el.dataset.issue; renderAll(); }));
}

function renderOverview() {
  const el = $('#overview-panel'); const cr = state.crawl;
  if (!cr) { el.innerHTML = '<h2>Crawl Overview</h2><p>No crawl yet. Enter a URL at the top and press Start, or open a saved crawl from the File menu.</p>'; return; }
  const s = cr.stats;
  el.innerHTML = `<h2>Crawl Overview - ${esc(cr.rootUrl)}</h2>
  <div class="cards">${[['Total URLs', s.total], ['Crawled', s.crawled], ['Indexable', s.indexable], ['Non-Indexable', s.nonIndexable], ['4xx Errors', s.errors4xx], ['5xx Errors', s.errors5xx], ['Redirects', s.redirects]].map(([l, n]) => `<div class="card"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>
  <h3>Issues Summary</h3>
  <table><tr><th>Issue</th><th>Severity</th><th>URLs</th><th>% of Total</th></tr>
  ${cr.issues.map((i) => `<tr><td>${esc(i.name)}</td><td><span class="sev sev-${i.severity}">${esc(i.severity)}</span></td><td>${i.count}</td><td>${i.pct}%</td></tr>`).join('')}
  </table>`;
}

function renderVisual() {
  const el = $('#visual-panel'); const cr = state.crawl;
  if (!cr) { el.innerHTML = '<h2>Site Structure Visualisation</h2><p>Run a crawl first.</p>'; return; }
  // Directory tree (text) + radial SVG: nodes placed on rings by crawl depth,
  // lines drawn to the nearest crawled ancestor by URL path.
  const pages = cr.pages.filter((p) => !p.external).slice(0, 300);
  const dirs = {};
  for (const p of pages) { const d = new URL(p.address).pathname.replace(/[^/]*$/, '') || '/'; dirs[d] = (dirs[d] || 0) + 1; }
  const W = 880, H = 560, cx = W / 2, cy = H / 2;
  const byDepth = {};
  pages.forEach((p) => { (byDepth[p.depth || 0] = byDepth[p.depth || 0] || []).push(p); });
  const pos = new Map();
  Object.entries(byDepth).forEach(([depth, list]) => {
    const r = 40 + Number(depth) * 85;
    list.forEach((p, i) => { const a = (i / Math.max(1, list.length)) * Math.PI * 2; pos.set(p.address, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), p }); });
  });
  const parentOf = (p) => { const parts = new URL(p.address).pathname.split('/').filter(Boolean); for (let n = parts.length - 1; n >= 0; n--) { const cand = new URL(p.address); cand.pathname = '/' + parts.slice(0, n).join('/') + (n ? '/' : ''); const c = pages.find((q) => q.address === cand.toString() || q.address === cand.toString().replace(/\/$/, '')); if (c && c.address !== p.address) return c; } return pages[0]; };
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (const { x, y, p } of pos.values()) { const par = parentOf(p); if (par && pos.has(par.address)) { const pp = pos.get(par.address); svg += `<line x1="${pp.x}" y1="${pp.y}" x2="${x}" y2="${y}" stroke="#39424d" stroke-width="1"/>`; } }
  for (const { x, y, p } of pos.values()) { const col = p.statusCode >= 400 ? '#f87171' : p.statusCode >= 300 ? '#fbbf24' : '#22c55e'; svg += `<circle cx="${x}" cy="${y}" r="5" fill="${col}"><title>${esc(p.address)} (${esc(p.statusCode)})</title></circle>`; }
  svg += '</svg>';
  el.innerHTML = `<h2>Site Structure Visualisation</h2><p>Radial crawl graph (first ${pages.length} URLs, ring = crawl depth, green = 2xx, amber = 3xx, red = 4xx/5xx). Hover a node for its URL.</p>${svg}
  <h3>Directory Tree</h3><table><tr><th>Directory</th><th>URLs</th></tr>${Object.entries(dirs).sort((a, b) => b[1] - a[1]).map(([d, n]) => `<tr><td>${esc(d)}</td><td>${n}</td></tr>`).join('')}</table>`;
}

function renderCompare() {
  const el = $('#compare-panel');
  if (!state.compare) { el.innerHTML = '<h2>Crawl Comparison</h2><p>Run or open a crawl, then pick another saved crawl to compare against it.</p><button id="btn-compare-pick" class="primary">Pick Saved Crawl to Compare...</button>'; const b = $('#btn-compare-pick'); if (b) b.addEventListener('click', doCompare); return; }
  const d = state.compare.diff;
  el.innerHTML = `<h2>Crawl Comparison</h2><p>Compared against: ${esc(state.compare.otherRoot || '')} (${esc(state.compare.otherAt || '')}). Direction: saved crawl -&gt; current crawl.</p>
  <div class="cards"><div class="card"><div class="n">${d.added.length}</div><div class="l">New URLs</div></div><div class="card"><div class="n">${d.removed.length}</div><div class="l">Removed URLs</div></div><div class="card"><div class="n">${d.changed.length}</div><div class="l">Changed URLs</div></div></div>
  <h3>Changed URLs</h3><table><tr><th>Address</th><th>Field</th><th>Before</th><th>After</th></tr>
  ${d.changed.flatMap((c) => c.diffs.map((df) => `<tr><td>${esc(c.address)}</td><td>${esc(df.field)}</td><td>${esc(df.before)}</td><td>${esc(df.after)}</td></tr>`)).join('') || '<tr><td colspan="4">No changes</td></tr>'}</table>
  <h3>Issue Deltas</h3><table><tr><th>Issue</th><th>Before</th><th>After</th><th>Delta</th></tr>
  ${d.issueDeltas.map((i) => `<tr><td>${esc(i.name)}</td><td>${i.before}</td><td>${i.after}</td><td>${i.delta > 0 ? '+' : ''}${i.delta}</td></tr>`).join('')}</table>
  <h3>New URLs</h3><p>${d.added.map(esc).join('<br>') || 'None'}</p>
  <h3>Removed URLs</h3><p>${d.removed.map(esc).join('<br>') || 'None'}</p>`;
}

async function doCompare() {
  try { const r = await window.spider.crawlComparePick(); if (r) { state.compare = r; state.tab = 'compare'; renderAll(); } }
  catch (e) { setProgress('Compare failed: ' + e.message); }
}

/* ---------- exports ---------- */
function toCsv(rows, columns) {
  const head = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(',');
  const lines = rows.map((r) => columns.map((c) => `"${String(c.get(r) ?? '').replace(/"/g, '""')}"`).join(','));
  return [head, ...lines].join('\n');
}
async function exportCurrentTab() {
  const cr = state.crawl; if (!cr) return;
  const t = currentTab(); if (!t.rows) { setProgress('This view has no CSV table. Switch to a data tab to export.'); return; }
  const columns = typeof t.columns === 'function' ? t.columns(cr) : t.columns;
  await window.spider.saveText({ defaultPath: `seonfix-spider-${t.id}.csv`, content: toCsv(tabRows(), columns) });
}
async function bulkExport() {
  const cr = state.crawl; if (!cr) return;
  // CSV bundle: one combined text file with a section per tab (the app does
  // not write native XLSX; each section is valid CSV on its own).
  const parts = [];
  for (const t of TABS.filter((x) => x.rows && x.columns)) {
    const prevTab = state.tab, prevFilter = state.filter, prevIssue = state.issueFilter;
    state.tab = t.id; state.filter = 'All'; state.issueFilter = null;
    const columns = typeof t.columns === 'function' ? t.columns(cr) : t.columns;
    parts.push(`# Tab: ${t.label}\n` + toCsv(tabRows(), columns));
    state.tab = prevTab; state.filter = prevFilter; state.issueFilter = prevIssue;
  }
  await window.spider.saveText({ defaultPath: 'seonfix-spider-bulk-export.csv', content: parts.join('\n\n') });
  renderAll();
}

/* ---------- config dialog ---------- */
function lines(id) { return document.getElementById(id).value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
function parseRuleLines(id, kind) {
  return lines(id).map((l) => { const [name, type, ...rest] = l.split('|').map((s) => s.trim()); if (!name || !rest.length) return null; return kind === 'extract' ? { name, type: (type || 'css').toLowerCase(), value: rest.join('|') } : { name, mode: (type || 'contains').toLowerCase(), needle: rest.join('|') }; }).filter(Boolean);
}
function collectConfig() {
  const preset = $('#cfg-uapreset').value;
  const headers = {};
  for (const l of lines('cfg-headers')) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return {
    mode: $('#mode-select').value,
    concurrency: Number($('#cfg-concurrency').value) || 5,
    delayMs: Number($('#cfg-delay').value) || 0,
    maxDepth: Number($('#cfg-depth').value) || 0,
    maxUrls: Number($('#cfg-maxurls').value) || 10000,
    crawlExternal: $('#cfg-external').checked,
    crawlResources: $('#cfg-resources').checked,
    checkImageSizes: $('#cfg-imagesizes').checked,
    rendering: $('#cfg-rendering').value,
    respectRobots: $('#cfg-robots').checked,
    customRobotsText: $('#cfg-customrobots').value,
    userAgentPreset: preset === 'custom' ? '' : preset,
    userAgent: preset === 'custom' ? $('#cfg-uacustom').value : (state.uaPresets[preset] || ''),
    cookies: $('#cfg-cookies').value,
    headers,
    includePatterns: lines('cfg-include'),
    excludePatterns: lines('cfg-exclude'),
    extractors: parseRuleLines('cfg-extractors', 'extract'),
    searchRules: parseRuleLines('cfg-search', 'search'),
  };
}
function fillConfig(cfg) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
  set('cfg-concurrency', cfg.concurrency ?? 5); set('cfg-delay', cfg.delayMs ?? 0); set('cfg-depth', cfg.maxDepth ?? 0); set('cfg-maxurls', cfg.maxUrls ?? 10000);
  $('#cfg-external').checked = !!cfg.crawlExternal; $('#cfg-resources').checked = cfg.crawlResources !== false; $('#cfg-imagesizes').checked = cfg.checkImageSizes !== false;
  set('cfg-rendering', cfg.rendering || 'text');
  $('#cfg-robots').checked = cfg.respectRobots !== false;
  set('cfg-customrobots', cfg.customRobotsText || '');
  set('cfg-uapreset', cfg.userAgentPreset || 'spider'); set('cfg-uacustom', cfg.userAgentPreset ? '' : (cfg.userAgent || '')); set('cfg-cookies', cfg.cookies || '');
  set('cfg-headers', Object.entries(cfg.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'));
  set('cfg-include', (cfg.includePatterns || []).join('\n')); set('cfg-exclude', (cfg.excludePatterns || []).join('\n'));
  set('cfg-extractors', (cfg.extractors || []).map((e) => `${e.name} | ${e.type} | ${e.value}`).join('\n'));
  set('cfg-search', (cfg.searchRules || []).map((e) => `${e.name} | ${e.mode} | ${e.needle}`).join('\n'));
}

/* ---------- crawl control ---------- */
function setProgress(text, pct) {
  $('#progress-text').textContent = text;
  if (pct !== undefined) $('#progress-bar').style.width = Math.min(100, Math.round(pct)) + '%';
}
async function startCrawl() {
  const config = collectConfigSilent();
  const url = $('#url-input').value.trim();
  const listText = $('#cfg-listurls').value;
  setProgress('Starting crawl...', 0);
  try {
    const crawl = await window.spider.crawlStart({ url, listText, config });
    state.crawl = crawl; state.selected = null; state.issueFilter = null; state.compare = null;
    setProgress(`Crawl complete: ${crawl.stats.crawled} URLs crawled, ${crawl.stats.total} total rows, ${crawl.issues.length} issue types found.`, 100);
    renderAll();
  } catch (e) { setProgress('Crawl failed: ' + e.message, 0); }
}
function collectConfigSilent() {
  // Reads the dialog fields if they were filled, else the saved config.
  try { return collectConfig(); } catch (_) { return state.config || {}; }
}
function renderAll() { renderTabs(); renderGrid(); renderSidebar(); renderBottom(); }

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  renderTabs(); renderAll();
  const got = await window.spider.configGet();
  state.config = got.config; state.uaPresets = got.uaPresets || {};
  fillConfig(state.config);
  if (state.config.mode) $('#mode-select').value = state.config.mode;
  $('#recent-list').innerHTML = (got.recent || []).map((r) => `<div class="tree-row"><span>${esc(r.rootUrl)}</span><b>${esc(r.total)} URLs - ${esc(String(r.at).slice(0, 10))}</b></div>`).join('') || 'None yet.';

  $('#btn-start').addEventListener('click', startCrawl);
  $('#url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') startCrawl(); });
  $('#btn-pause').addEventListener('click', () => window.spider.crawlPause());
  $('#btn-resume').addEventListener('click', () => window.spider.crawlResume());
  $('#btn-clear').addEventListener('click', async () => { await window.spider.crawlStop(); state.crawl = null; state.selected = null; setProgress('Cleared.', 0); renderAll(); });
  $('#btn-config').addEventListener('click', () => $('#config-dialog').showModal());
  $('#btn-settings').addEventListener('click', () => $('#settings-dialog').showModal());
  $('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
  $('#about-close').addEventListener('click', () => $('#about-dialog').close());
  $('#cfg-cancel').addEventListener('click', () => $('#config-dialog').close());
  $('#cfg-save').addEventListener('click', async () => { state.config = collectConfig(); await window.spider.configSave(state.config); $('#config-dialog').close(); setProgress('Configuration saved.'); });
  $('#tab-filter').addEventListener('change', (e) => { state.filter = e.target.value; renderGrid(); });
  $('#table-search').addEventListener('input', (e) => { state.search = e.target.value; renderGrid(); });
  $('#btn-export').addEventListener('click', exportCurrentTab);
  document.querySelectorAll('#bottom-tabs button').forEach((b) => b.addEventListener('click', () => { state.btab = b.dataset.btab; document.querySelectorAll('#bottom-tabs button').forEach((x) => x.classList.toggle('active', x === b)); renderBottom(); }));

  window.spider.onProgress((p) => {
    const total = Math.max(1, p.discovered || 1);
    setProgress(`Crawling: ${p.crawled} crawled, ${p.queued} queued, ${p.discovered} discovered - ${p.currentUrl || ''}`, (p.crawled / total) * 100);
  });
  window.spider.onMenu(async (action, arg) => {
    if (action === 'new') { state.crawl = null; state.selected = null; renderAll(); $('#url-input').focus(); }
    else if (action === 'open') { const data = await window.spider.crawlOpen(); if (data) { state.crawl = data; state.selected = null; setProgress(`Opened saved crawl: ${data.stats ? data.stats.total : data.pages.length} URLs.`, 100); renderAll(); } }
    else if (action === 'save') { const r = await window.spider.crawlSave(); if (r && r.saved) setProgress('Crawl saved to ' + r.path); }
    else if (action === 'export') exportCurrentTab();
    else if (action === 'bulk-export') bulkExport();
    else if (action === 'sitemap') await window.spider.sitemapGenerate('xml');
    else if (action === 'image-sitemap') await window.spider.sitemapGenerate('image');
    else if (action === 'redirect-report') { const r = await window.spider.redirectReport(); if (r && r.saved) setProgress('Redirect chains report saved to ' + r.path); }
    else if (action === 'compare') { state.tab = 'compare'; renderAll(); doCompare(); }
    else if (action === 'visualisation') { state.tab = 'visualisation'; renderAll(); }
    else if (action === 'config') $('#config-dialog').showModal();
    else if (action === 'settings') $('#settings-dialog').showModal();
    else if (action === 'mode') { $('#mode-select').value = arg; }
    else if (action === 'about') { const info = await window.spider.appInfo(); $('#about-body').textContent = `Seonfix Spider v${info.version} - Electron ${info.electron} - ${info.platform}`; $('#about-dialog').showModal(); }
  });
});
