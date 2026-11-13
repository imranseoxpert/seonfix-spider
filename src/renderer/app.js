'use strict';
/* Seonfix Spider v2 renderer. All crawl data arrives from the main process
 * via the window.spider preload bridge; grid filtering uses the filter
 * registry membership (page.filters) computed in the main process, so the
 * sidebar counts and the grid always agree. Dark theme (user choice). */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k, d) => { try { const v = localStorage.getItem('sf2-' + k); return v ? JSON.parse(v) : d; } catch (_) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem('sf2-' + k, JSON.stringify(v)); } catch (_) {} };

const TABS = window.SF_TABS;
const DEFAULT_TAB_ORDER = TABS.map((t) => t.id);
let state = {
  crawl: null, livePages: [], crawling: false, paused: false,
  tab: 'internal', filterId: 'all', issueName: null, search: '', view: 'grid',
  sortKey: null, sortDir: 1, selected: null, selectedCellCount: 0,
  config: null, uaPresets: {}, filterMeta: [], compare: null, btab: 'details',
  stab: 'overview', sideFilter: null, sideSection: null, issueChip: 'Total', selectedIssue: null,
  visibleTabs: lsGet('visibleTabs', DEFAULT_TAB_ORDER), hiddenCols: lsGet('hiddenCols', {}),
  mode: 'spider', psi: [], schedules: [], hasPsiKey: false, recentUrls: [],
  bottomSearch: '', focusMode: false, scopeFilter: 'all', collapsed: new Set(lsGet('collapsedSections', [])),
  linkTypeFilter: 'all', linkPosFilter: 'all', rate: { started: 0, samples: [] },
};
window.__spiderState = state;

function crawlCtx(cr) {
  if (!cr) return null;
  if (cr._ctx) return cr._ctx;
  const mk = (pick) => { const m = new Map(); for (const p of cr.pages) { const v = pick(p); if (v) m.set(String(v).toLowerCase(), (m.get(String(v).toLowerCase()) || 0) + 1); } return m; };
  cr._ctx = { titles: mk((p) => p.title), descs: mk((p) => p.metaDescription), h1s: mk((p) => (p.h1s || [])[0]), h2s: mk((p) => (p.h2s || [])[0]) };
  return cr._ctx;
}
function currentTab() { return TABS.find((t) => t.id === state.tab) || TABS[0]; }
function tabFilters(tab) {
  const meta = state.filterMeta.filter((f) => f.tab === tab.id);
  return [{ id: 'all', name: 'All' }, ...meta.map((f) => ({ id: f.id, name: f.name }))];
}
function imageRows(cr) {
  const out = []; const seen = new Map();
  for (const p of cr.pages) {
    if (p.contentCategory === 'Images') {
      const row = { address: p.address, contentType: p.contentType || 'image', size: p.sizeBytes || 0, imgInlinks: p.uniqueInlinks || 0, alt: '', indexability: p.indexability, indexabilityReason: p.indexabilityReason, filters: p.filters || [], _page: p };
      seen.set(p.address, row); out.push(row);
    }
  }
  for (const p of cr.pages) {
    for (const im of p.images || []) {
      if (seen.has(im.url)) { const r = seen.get(im.url); if (!r.alt && im.alt) r.alt = im.alt; r.imgInlinks = Math.max(r.imgInlinks, 0); continue; }
      const row = { address: im.url, contentType: 'image', size: im.size || 0, imgInlinks: 1, alt: im.alt ?? '', indexability: '', indexabilityReason: '', _page: p, _img: im, filters: [] };
      seen.set(im.url, row); out.push(row);
    }
  }
  // per-image filter membership approximations for the Images tab
  for (const row of out) {
    const im = row._img; const f = [];
    if (im) {
      f.push('img-all');
      if ((im.size || 0) > 102400) f.push('img-over-100kb');
      if (im.hasAlt && !(im.alt || '').trim()) f.push('img-missing-alt-text');
      if (!im.hasAlt) f.push('img-missing-alt-attr');
      if ((im.alt || '').length > 100) f.push('img-alt-over-100');
      if (im.incorrectlySized) f.push('img-incorrect-size');
      if (!im.hasSizeAttrs) f.push('img-missing-size-attrs');
    }
    row.filters = [...new Set([...(row.filters || []), ...f])];
    row._imgFrom = row._page ? row._page.address : '';
  }
  return out;
}
function tabRows() {
  const cr = state.crawling && !state.crawl ? { pages: state.livePages } : state.crawl;
  if (!cr) return [];
  const t = currentTab();
  let rows;
  if (t.imagesTab) rows = imageRows(cr);
  else if (!t.rows) rows = [];
  else rows = t.rows(cr);
  if (state.filterId && state.filterId !== 'all') rows = rows.filter((r) => (r.filters || []).includes(state.filterId));
  if (t.id === 'responses' && state.scopeFilter !== 'all') rows = rows.filter((r) => (state.scopeFilter === 'external' ? !!r.external : !r.external));
  if (state.issueName) rows = rows.filter((r) => (r.issues || []).includes(state.issueName) || (r._page && (r._page.issues || []).includes(state.issueName)));
  if (state.search) { const q = state.search.toLowerCase(); rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)); }
  if (state.sortKey) {
    const cols = typeof t.columns === 'function' ? t.columns(cr) : t.columns;
    const col = cols.find((c) => c.key === state.sortKey);
    if (col) { const cx = crawlCtx(cr); rows = [...rows].sort((a, b) => { const va = col.get(a, cx), vb = col.get(b, cx); const na = Number(va), nb = Number(vb); const cmp = (!Number.isNaN(na) && !Number.isNaN(nb) && va !== '' && vb !== '') ? na - nb : String(va ?? '').localeCompare(String(vb ?? '')); return cmp * state.sortDir; }); }
  }
  return rows;
}
function visibleColumns() {
  const cr = state.crawl; const t = currentTab();
  const cols = cr ? (typeof t.columns === 'function' ? t.columns(cr) : t.columns) : (typeof t.columns === 'function' ? [] : t.columns);
  const hidden = state.hiddenCols[t.id] || [];
  return (cols || []).filter((c) => !hidden.includes(c.key));
}

/* ---------- header / tabs / toolbar ---------- */
function renderTabs() {
  const vis = TABS.filter((t) => state.visibleTabs.includes(t.id));
  $('#tabs').innerHTML = vis.map((t) => `<button data-tab="${t.id}" class="${t.id === state.tab ? 'active' : ''}">${esc(t.label)}</button>`).join('') + '<button id="tabs-overflow" title="Configure tabs">&gt;&gt;</button>';
  document.querySelectorAll('#tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.filterId = 'all'; state.issueName = null; focusSidebarOnTab(state.tab); renderAll(); scrollSidebarToSection(); }));
  $('#tabs-overflow').addEventListener('click', (e) => { e.stopPropagation(); renderTabsPopup(); $('#tabs-popup').classList.toggle('hidden'); });
}
function renderTabsPopup() {
  $('#tabs-list').innerHTML = TABS.map((t) => `<label class="chk"><input type="checkbox" data-tabchk="${t.id}" ${state.visibleTabs.includes(t.id) ? 'checked' : ''}> ${esc(t.label)}</label>`).join('');
  document.querySelectorAll('[data-tabchk]').forEach((cb) => cb.addEventListener('change', () => {
    state.visibleTabs = TABS.filter((t) => document.querySelector(`[data-tabchk="${t.id}"]`).checked).map((t) => t.id);
    lsSet('visibleTabs', state.visibleTabs);
    if (!state.visibleTabs.includes(state.tab)) state.tab = state.visibleTabs[0] || 'internal';
    renderAll();
  }));
}
function renderToolbar() {
  const t = currentTab();
  const filters = tabFilters(t);
  if (!filters.some((f) => f.id === state.filterId)) state.filterId = 'all';
  $('#filter-select').innerHTML = filters.map((f) => `<option value="${esc(f.id)}" ${f.id === state.filterId ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  $('#scope-filter').classList.toggle('hidden', t.id !== 'responses');
  $('#scope-filter').value = state.scopeFilter;
  $('#view-grid').classList.toggle('active', state.view === 'grid');
  $('#view-tree').classList.toggle('active', state.view === 'tree');
  const note = $('#tab-note');
  if (t.note && (!state.crawl || !(t.rows && t.rows(state.crawl).length))) { note.textContent = t.note; note.classList.remove('hidden'); }
  else note.classList.add('hidden');
}
function directoryOf(address) {
  try { const u = new URL(address); const parts = u.pathname.split('/').filter(Boolean); return u.origin + '/' + (parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : ''); } catch (_) { return '/'; }
}
function renderGrid() {
  const t = currentTab();
  const isCompare = state.tab === 'compare';
  $('#compare-panel').classList.toggle('active', !!isCompare);
  $('#table-wrap').style.display = isCompare ? 'none' : '';
  $('#toolbar').style.display = isCompare ? 'none' : '';
  if (isCompare) { renderCompare(); updateCountsLine(0); return; }
  const rows = tabRows();
  const columns = visibleColumns();
  const cx = state.crawl ? crawlCtx(state.crawl) : null;
  $('#grid thead').innerHTML = '<tr><th class="rownum">#</th>' + columns.map((c) => `<th data-key="${c.key}" class="${c.num ? 'num' : ''}">${esc(c.label)}${state.sortKey === c.key ? (state.sortDir > 0 ? ' ^' : ' v') : ''}</th>`).join('') + '</tr>';
  document.querySelectorAll('#grid th[data-key]').forEach((th) => th.addEventListener('click', () => { if (state.sortKey === th.dataset.key) state.sortDir *= -1; else { state.sortKey = th.dataset.key; state.sortDir = 1; } renderGrid(); }));
  const cellHtml = (r) => columns.map((c, ci) => { const v = c.get(r, cx); const cls = c.key === 'statusCode' ? (v >= 400 ? 'st-err' : v >= 300 ? 'st-warn' : v ? 'st-ok' : '') : ''; return `<td class="${c.num ? 'num' : ''} ${cls}" data-ci="${ci}" title="${esc(v ?? '')}">${esc(v ?? '')}</td>`; }).join('');
  if (state.view === 'tree') {
    const groups = new Map();
    for (const r of rows) { const d = directoryOf(r.address || r.url || ''); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(r); }
    let n = 0; let html = '';
    for (const [dir, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      html += `<tr class="group-row"><td class="rownum"></td><td colspan="${columns.length}">${esc(dir)} (${list.length})</td></tr>`;
      for (const r of list) { n++; html += `<tr data-n="${n}"><td class="rownum">${n}</td>${cellHtml(r)}</tr>`; }
    }
    $('#grid tbody').innerHTML = html;
  } else {
    $('#grid tbody').innerHTML = rows.map((r, i) => `<tr data-n="${i + 1}"><td class="rownum">${i + 1}</td>${cellHtml(r)}</tr>`).join('');
  }
  $('#grid-empty').style.display = rows.length ? 'none' : '';
  document.querySelectorAll('#grid tbody tr[data-n]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      const idx = Number(tr.dataset.n) - 1;
      const flat = state.view === 'tree' ? null : rows[idx];
      const row = flat || rowByVisualIndex(idx);
      state.selectedCellCount = 1;
      selectRow(row, tr);
    });
    tr.addEventListener('dblclick', () => { const r = rowByVisualIndex(Number(tr.dataset.n) - 1); const u = r && (r.address || r.url); if (u) window.spider.openExternal(u); });
  });
  updateCountsLine(rows.length);
  function rowByVisualIndex(i) {
    if (state.view !== 'tree') return rows[i];
    let n = -1;
    const groups = new Map();
    for (const r of rows) { const d = directoryOf(r.address || r.url || ''); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(r); }
    for (const [, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) for (const r of list) { n++; if (n === i) return r; }
    return null;
  }
}
function updateCountsLine(total) {
  $('#selected-cells').textContent = `Selected Cells: ${state.selectedCellCount}`;
  $('#filter-total').textContent = `Filter Total: ${total}`;
}
function selectRow(row, tr) {
  document.querySelectorAll('#grid tbody tr').forEach((x) => x.classList.remove('selected'));
  if (tr) tr.classList.add('selected');
  state.selected = row && row._page ? row._page : row;
  state.selectedImage = row && row._img ? row : null;
  renderBottom();
}

/* ---------- bottom pane ---------- */
function serpSnippet(p) {
  let host = ''; let pathParts = [];
  try { const u = new URL(p.address); host = u.host; pathParts = u.pathname.split('/').filter(Boolean); } catch (_) {}
  const crumb = host + (pathParts.length ? ' › ' + pathParts.join(' › ') : '');
  return `<div class="serp-card"><div class="serp-url">${esc(crumb)}</div><div class="serp-title">${esc(p.title || p.address)}</div><div class="serp-desc">${esc(p.metaDescription || (p.textExcerpt || '').slice(0, 160))}</div></div>`;
}
function simhashSim(a, b) {
  try { let x = BigInt(a) ^ BigInt(b); let d = 0; while (x) { d += Number(x & 1n); x >>= 1n; } return 1 - d / 64; } catch (_) { return 0; }
}
function kvTable(rows) { return '<table class="kv">' + rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v ?? '')}</td></tr>`).join('') + '</table>'; }
function linkFilterBar(rows) {
  const positions = [...new Set(rows.map((r) => r.position || 'Content'))].sort();
  return `<select data-ltype><option value="all" ${state.linkTypeFilter === 'all' ? 'selected' : ''}>All Link Types</option><option value="follow" ${state.linkTypeFilter === 'follow' ? 'selected' : ''}>Follow</option><option value="nofollow" ${state.linkTypeFilter === 'nofollow' ? 'selected' : ''}>Nofollow</option></select>` +
    `<select data-lpos><option value="all">All Link Positions</option>${positions.map((p) => `<option ${state.linkPosFilter === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>`;
}
function filterLinkRows(rows) {
  return rows.filter((r) => (state.linkTypeFilter === 'all' || (state.linkTypeFilter === 'follow') === !!r.follow)
    && (state.linkPosFilter === 'all' || (r.position || 'Content') === state.linkPosFilter)
    && (!state.bottomSearch || JSON.stringify(r).toLowerCase().includes(state.bottomSearch.toLowerCase())));
}
function renderBottom() {
  const p = state.selected; const body = $('#bottom-body');
  document.querySelectorAll('#bottom-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.btab === state.btab));
  if (!p) { body.innerHTML = '<div class="empty-big">No URL selected</div>'; return; }
  const pages = state.crawl ? state.crawl.pages : state.livePages;
  const searchBox = `<input type="text" placeholder="Search..." data-bsearch value="${esc(state.bottomSearch)}">`;
  const bt = state.btab;
  if (bt === 'details') {
    const kv = [['Address', p.address], ['Content Type', p.contentType || p.contentCategory], ['Status Code', p.statusCode], ['Status', p.status], ['Indexability', p.indexability], ['Indexability Status', p.indexabilityReason], ['Title 1', p.title], ['Title 1 Length', p.titleLength], ['Title 1 Pixel Width', p.titlePixelWidth], ['Meta Description 1', p.metaDescription], ['Meta Description 1 Length', p.metaDescriptionLength], ['Meta Description 1 Pixel Width', p.metaDescriptionPixelWidth], ['H1-1', (p.h1s || [])[0] || ''], ['H1-2', (p.h1s || [])[1] || ''], ['H2-1', (p.h2s || [])[0] || ''], ['H2-2', (p.h2s || [])[1] || ''], ['Meta Robots 1', p.metaRobots], ['X-Robots-Tag 1', p.xRobotsTag], ['Canonical Link Element 1', p.canonical], ['rel="next" 1', (p.pagination || {}).next || ''], ['rel="prev" 1', (p.pagination || {}).prev || ''], ['Size (bytes)', p.sizeBytes], ['Word Count', p.wordCount], ['Sentence Count', p.sentenceCount], ['Average Words Per Sentence', p.avgWordsPerSentence], ['Flesch Reading Ease Score', p.flesch], ['Readability', p.readability], ['Text Ratio', p.textRatio], ['Crawl Depth', p.depth], ['Link Score', p.linkScore], ['Inlinks', p.inlinks], ['Unique Inlinks', p.uniqueInlinks], ['Outlinks', p.outlinks], ['Unique Outlinks', p.uniqueOutlinks], ['External Outlinks', p.externalOutlinks], ['Response Time', typeof p.responseTimeMs === 'number' ? Math.round(p.responseTimeMs) / 1000 : ''], ['Redirect URL', p.redirectUrl], ['Redirect Type', p.redirectType], ['In Sitemap', p.inSitemap ? 'Yes' : 'No'], ['Hash', p.hash], ['Near Duplicate Of', p.nearDuplicateOf || ''], ['Spelling Errors', p.spellingErrors ?? 0], ['Grammar Errors', p.grammarErrors ?? 0], ['Accessibility Violations', p.a11yViolations ?? ''], ['Language', p.htmlLang || ''], ['Issues', (p.issues || []).join('; ')]];
    const rows = kv.filter(([k, v]) => !state.bottomSearch || `${k} ${v}`.toLowerCase().includes(state.bottomSearch.toLowerCase()));
    body.innerHTML = `<div class="bt-toolbar"><button data-bexport>Export</button>${searchBox}</div>` + '<table class="kv"><tr><th>Name</th><th>Value</th></tr>' + rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v ?? '')}</td></tr>`).join('') + '</table>';
  } else if (bt === 'inlinks' || bt === 'outlinks') {
    let rows = [];
    if (bt === 'inlinks') { for (const q of pages) for (const l of q.links || []) if (l.url === p.address) rows.push({ type: 'Hyperlink', from: q.address, to: p.address, anchor: l.anchor, alt: l.alt || '', follow: l.follow, rel: l.rel || '', target: l.target || '', position: l.position || 'Content' }); }
    else rows = (p.links || []).map((l) => ({ type: 'Hyperlink', from: p.address, to: l.url, anchor: l.anchor, alt: l.alt || '', follow: l.follow, rel: l.rel || '', target: l.target || '', position: l.position || 'Content', status: (pages.find((x) => x.address === l.url) || {}).statusCode ?? '' }));
    const shown = filterLinkRows(rows);
    body.innerHTML = `<div class="bt-toolbar">${linkFilterBar(rows)}<button data-bexport>Export</button>${searchBox}<span class="hint">${shown.length} of ${rows.length}</span></div>` +
      (rows.length ? `<table><tr><th>Type</th><th>From</th><th>To</th><th>Anchor Text</th><th>Alt Text</th><th>Follow</th><th>Target</th><th>Rel</th>${bt === 'outlinks' ? '<th>Status Code</th>' : ''}<th>Link Position</th></tr>` + shown.map((r) => `<tr><td>${r.type}</td><td>${esc(r.from)}</td><td>${esc(r.to)}</td><td>${esc(r.anchor)}</td><td>${esc(r.alt)}</td><td>${r.follow ? 'True' : 'False'}</td><td>${esc(r.target)}</td><td>${esc(r.rel)}</td>${bt === 'outlinks' ? `<td>${esc(r.status)}</td>` : ''}<td>${esc(r.position)}</td></tr>`).join('') + '</table>' : `<div class="empty-big">No ${bt === 'inlinks' ? 'inlinks' : 'outlinks'} in this crawl</div>`);
  } else if (bt === 'images') {
    const imgs = p.images || [];
    const sel = state.selectedImage;
    const preview = sel ? `<img src="${esc(sel.address)}" style="max-width:${(state.zoom || 50) * 4}px;max-height:240px">` : '<div class="img-placeholder"><svg viewBox="0 0 60 45" width="80" height="60"><rect x="2" y="2" width="56" height="41" rx="3" fill="none" stroke="#5a636d" stroke-width="3"/><circle cx="18" cy="15" r="5" fill="#5a636d"/><path d="M4 40 L22 24 L34 34 L44 26 L56 38 L56 43 L4 43 Z" fill="#5a636d"/></svg><p>No Image selected</p></div>';
    const meta = sel && sel._img ? kvTable([['Image', sel.address], ['Alt Text', sel._img.alt ?? '(missing alt attribute)'], ['Size', sel._img.size ? Math.round(sel._img.size / 102.4) / 10 + ' KB' : ''], ['Dimensions (Attributes)', sel._img.width || sel._img.height ? `${sel._img.width || '?'} x ${sel._img.height || '?'}` : 'Missing'], ['Real Dimensions', sel._img.naturalWidth ? `${sel._img.naturalWidth} x ${sel._img.naturalHeight}` : '']]) : '';
    body.innerHTML = `<div class="images-split"><div class="images-left"><div class="bt-toolbar"><button data-bexport>Export</button></div>` +
      (imgs.length ? '<table><tr><th>From</th><th>To</th><th>Alt Text</th></tr>' + imgs.map((im, i) => `<tr data-imgrow="${i}" class="${sel && sel.address === im.url ? 'selected' : ''}"><td>${esc(p.address)}</td><td>${esc(im.url)}</td><td>${esc(im.alt ?? '')}</td></tr>`).join('') + '</table>' : '<div class="empty-big">No Image Info found</div>') +
      `</div><div class="images-right"><div class="bt-toolbar"><button data-zoom="-1" title="Zoom out">-</button><button data-zoom="1" title="Zoom in">+</button><span>Zoom: ${state.zoom || 50}%</span></div>${preview}${meta}</div></div>`;
    document.querySelectorAll('[data-imgrow]').forEach((tr) => tr.addEventListener('click', () => { const im = imgs[Number(tr.dataset.imgrow)]; state.selectedImage = { address: im.url, _img: im }; renderBottom(); }));
    document.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => { const z = state.zoom || 50; const steps = [25, 50, 75, 100, 150, 200]; const k = Math.max(0, Math.min(steps.length - 1, steps.indexOf(z) + Number(b.dataset.zoom))); state.zoom = steps[k]; renderBottom(); }));
  } else if (bt === 'resources') {
    const rows = (p.resources || []).filter((r) => !state.bottomSearch || r.url.toLowerCase().includes(state.bottomSearch.toLowerCase()));
    body.innerHTML = `<div class="bt-toolbar"><button data-bexport>Export</button>${searchBox}</div>` + (rows.length ? '<table><tr><th>Type</th><th>From</th><th>To</th><th>Status Code</th></tr>' + rows.map((r) => `<tr><td>${esc(r.type)}</td><td>${esc(p.address)}</td><td>${esc(r.url)}</td><td>${esc((pages.find((x) => x.address === r.url) || {}).statusCode ?? '')}</td></tr>`).join('') + '</table>' : '<div class="empty-big">No resources collected for this page</div>');
  } else if (bt === 'serp') {
    body.innerHTML = serpSnippet(p) + kvTable([['Title', p.title || ''], ['Title Length', `${p.titleLength ?? 0} characters (max 60)`], ['Title Pixel Width', `${p.titlePixelWidth ?? 0} px (max 580)`], ['Title Truncated', (p.titlePixelWidth || 0) > 580 ? 'Yes' : 'No'], ['Description', p.metaDescription || ''], ['Description Length', `${p.metaDescriptionLength ?? 0} characters (max 155)`], ['Description Pixel Width', `${p.metaDescriptionPixelWidth ?? 0} px (max 985)`], ['Description Truncated', (p.metaDescriptionPixelWidth || 0) > 985 ? 'Yes' : 'No']]);
  } else if (bt === 'rendered') {
    if (p.renderedTitle !== undefined || p.renderedCanonical !== undefined) {
      body.innerHTML = kvTable([['Raw Title', p.rawTitle || p.title || ''], ['Rendered Title', p.renderedTitle || ''], ['Raw Canonical', p.canonical || ''], ['Rendered Canonical', p.renderedCanonical || ''], ['Raw Meta Description', p.metaDescription || ''], ['Rendered Meta Description', p.renderedMetaDescription || ''], ['Raw H1', (p.h1s || [])[0] || ''], ['Rendered H1', p.renderedH1 || ''], ['Raw Links', (p.links || []).length], ['Rendered Links', p.renderedLinkCount ?? ''], ['Blocked Resources', (p.blockedResources || []).join(', ')]]);
    } else {
      body.innerHTML = '<p class="hint">JavaScript rendering is off for this crawl (Configuration &gt; Spider &gt; Rendering). Showing the text extracted from the raw HTML.</p><div class="rendered-text">' + esc((p.textExcerpt || '').slice(0, 3000)) + '</div>';
    }
  } else if (bt === 'console') {
    const msgs = [...(p.jsErrors || []).map((m) => ['Error', m]), ...(p.jsWarnings || []).map((m) => ['Warning', m])];
    body.innerHTML = msgs.length ? '<table><tr><th>Level</th><th>Message</th></tr>' + msgs.map(([l, m]) => `<tr><td>${l}</td><td>${esc(m)}</td></tr>`).join('') + '</table>'
      : `<div class="empty-big">${p.renderedTitle !== undefined ? 'No console messages' : 'Turn on JavaScript rendering (Configuration &gt; Spider &gt; Rendering) to capture the Chrome console log'}</div>`;
  } else if (bt === 'source') {
    body.innerHTML = p.rawHtml ? `<div class="bt-toolbar"><button data-bexport>Export</button><span class="hint">${p.rawHtml.length.toLocaleString()} characters</span></div><pre class="source">${esc(p.rawHtml)}</pre>`
      : '<div class="empty-big">HTML was not stored for this crawl. Turn on Configuration &gt; Spider &gt; Extraction &gt; Store HTML and crawl again.</div>';
  } else if (bt === 'headers') {
    const h = Object.entries(p.headers || {});
    body.innerHTML = h.length ? '<table class="kv"><tr><th>Header Name</th><th>Header Value</th></tr>' + h.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') + '</table>' + ((p.redirectChain || []).length ? '<h4>Redirect Chain</h4><table><tr><th>From</th><th>To</th><th>Status</th></tr>' + p.redirectChain.map((x) => `<tr><td>${esc(x.from)}</td><td>${esc(x.to)}</td><td>${esc(x.status)}</td></tr>`).join('') + '</table>' : '') : '<div class="empty-big">No HTTP headers recorded</div>';
  } else if (bt === 'cookies') {
    const ck = (p.cookies || []).map((c) => { const parts = String(c).split(';').map((x) => x.trim()); const [name, ...val] = parts[0].split('='); const attr = (k) => (parts.find((x) => x.toLowerCase().startsWith(k)) || '').split('=').slice(1).join('=') || (parts.some((x) => x.toLowerCase() === k) ? 'Yes' : ''); return { name, value: val.join('='), domain: attr('domain'), path: attr('path'), expires: attr('expires') || attr('max-age'), secure: attr('secure') || 'No', httpOnly: attr('httponly') || 'No', sameSite: attr('samesite') }; });
    body.innerHTML = ck.length ? '<table><tr><th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>Expiry</th><th>Secure</th><th>HttpOnly</th><th>SameSite</th></tr>' + ck.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.value.slice(0, 60))}</td><td>${esc(c.domain)}</td><td>${esc(c.path)}</td><td>${esc(c.expires)}</td><td>${esc(c.secure)}</td><td>${esc(c.httpOnly)}</td><td>${esc(c.sameSite)}</td></tr>`).join('') + '</table>' : '<div class="empty-big">No cookies set by this URL</div>';
  } else if (bt === 'duplicates') {
    const exact = p.hash ? pages.filter((q) => q !== p && q.hash === p.hash && (q.wordCount || 0) > 0) : [];
    const near = p.simhash ? pages.filter((q) => q !== p && q.simhash && q.hash !== p.hash && (q.wordCount || 0) >= 30).map((q) => ({ q, sim: simhashSim(p.simhash, q.simhash) })).filter((x) => x.sim >= ((state.config || {}).duplicatesThreshold || 0.92)).sort((a, b) => b.sim - a.sim) : [];
    body.innerHTML = (exact.length || near.length) ? '<table><tr><th>Address</th><th>Match</th><th>Similarity</th><th>Word Count</th></tr>' + exact.map((q) => `<tr><td>${esc(q.address)}</td><td>Exact Duplicate</td><td>100%</td><td>${q.wordCount ?? ''}</td></tr>`).join('') + near.map(({ q, sim }) => `<tr><td>${esc(q.address)}</td><td>Near Duplicate</td><td>${Math.round(sim * 100)}%</td><td>${q.wordCount ?? ''}</td></tr>`).join('') + '</table>' : '<div class="empty-big">No exact or near duplicates found for this URL</div>';
  } else if (bt === 'structured') {
    const items = p.sdItems || [];
    body.innerHTML = items.length ? '<table><tr><th>Format</th><th>Type</th><th>Properties</th></tr>' + items.map((it) => `<tr><td>${it.microdata ? 'Microdata' : 'JSON-LD'}</td><td>${esc(it.type)}</td><td>${esc((it.keys || []).filter((k) => !k.startsWith('@')).join(', '))}</td></tr>`).join('') + '</table>' + ((p.sdWarnings || []).length ? '<h4>Validation Warnings</h4><ul>' + p.sdWarnings.map((w) => `<li>${esc(w)}</li>`).join('') + '</ul>' : '') : '<div class="empty-big">No structured data found on this URL</div>';
  } else if (bt === 'spelling') {
    const sp = (p.spellingUnknown || []).map((w) => ['Spelling', w, 'Not in dictionary']);
    const gr = (p.grammarMatches || []).map((m) => ['Grammar', m.text, m.rule]);
    const rows = [...sp, ...gr];
    body.innerHTML = rows.length ? `<p class="hint">${p.spellingErrors || 0} spelling and ${p.grammarErrors || 0} grammar issues. Language: ${esc(p.htmlLang || 'not declared')}</p><table><tr><th>Type</th><th>Text</th><th>Reason</th></tr>` + rows.map(([t, x, r]) => `<tr><td>${t}</td><td>${esc(x)}</td><td>${esc(r)}</td></tr>`).join('') + '</table>' : '<div class="empty-big">No spelling or grammar issues found</div>';
  } else if (bt === 'a11y') {
    const a = p.a11y || {};
    const defs = state.a11yDefs || [];
    const rows = Object.entries(a).filter(([, v]) => v.count > 0);
    body.innerHTML = p.a11y ? (rows.length ? '<table><tr><th>Violation</th><th>WCAG</th><th>Count</th><th>Examples</th></tr>' + rows.map(([id, v]) => { const d = defs.find((x) => x.id === id) || { name: id, wcag: '' }; return `<tr><td>${esc(d.name)}</td><td>${esc(d.wcag)}</td><td>${v.count}</td><td>${(v.samples || []).map((x) => `<code>${esc(x)}</code>`).join('<br>')}</td></tr>`; }).join('') + '</table>' : '<div class="empty-big">No accessibility violations found by the static checks</div>') : '<div class="empty-big">Accessibility checks run on HTML pages only</div>';
  }
  const be = body.querySelector('[data-bexport]');
  if (be) be.addEventListener('click', () => window.spider.saveText({ defaultPath: `${bt}-${(p.address || 'url').replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.txt`, content: bt === 'source' ? (p.rawHtml || '') : body.innerText }));
  const bs = body.querySelector('[data-bsearch]');
  if (bs) bs.addEventListener('input', () => { state.bottomSearch = bs.value; renderBottom(); const nbs = $('#bottom-body [data-bsearch]'); if (nbs) { nbs.focus(); nbs.setSelectionRange(nbs.value.length, nbs.value.length); } });
  const lt = body.querySelector('[data-ltype]'); if (lt) lt.addEventListener('change', () => { state.linkTypeFilter = lt.value; renderBottom(); });
  const lp = body.querySelector('[data-lpos]'); if (lp) lp.addEventListener('change', () => { state.linkPosFilter = lp.value; renderBottom(); });
}

/* ---------- right sidebar ---------- */
const CHART_COLORS = ['#00C852', '#F5A623', '#D64541', '#35D273', '#9AA0A6', '#00A344', '#B9EBCB', '#7FB3D5', '#C39BD3', '#F0B27A'];
function donutSvg(entries, size = 190) {
  const total = entries.reduce((a, e) => a + e.value, 0);
  if (!total) return '<p class="chart-none">No data for graph.</p>';
  const cx = size / 2, cy = size / 2, r = size / 2 - 8, inner = r * 0.58;
  let a0 = -Math.PI / 2; let paths = '';
  entries.filter((e) => e.value > 0).forEach((e, i) => {
    const a1 = a0 + (e.value / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const ix1 = cx + inner * Math.cos(a1), iy1 = cy + inner * Math.sin(a1), ix0 = cx + inner * Math.cos(a0), iy0 = cy + inner * Math.sin(a0);
    paths += `<path d="M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1} L${ix1} ${iy1} A${inner} ${inner} 0 ${large} 0 ${ix0} ${iy0} Z" fill="${CHART_COLORS[i % CHART_COLORS.length]}"><title>${esc(e.label)}: ${e.value}</title></path>`;
    a0 = a1;
  });
  const legend = entries.filter((e) => e.value > 0).map((e, i) => `<div class="legend-row"><span class="swatch" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>${esc(e.label)} (${e.value})</div>`).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}</svg><div class="legend">${legend}</div>`;
}
function niceStep(max) { const raw = max / 5; const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9)))); const n = raw / mag; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag; }
/* Screaming Frog style vertical bar chart: "URLs" y-axis with gridlines,
 * green bars, x labels rotated to read top-to-bottom. */
function barSvg(entries, width = 340) {
  const rows = entries;
  if (!rows.length || !rows.some((e) => e.value > 0)) return '<p class="chart-none">No data for graph.</p>';
  const maxV = Math.max(1, ...rows.map((e) => e.value));
  const step = niceStep(maxV); const top = Math.ceil(maxV / step) * step || 1;
  const labelLen = Math.min(26, Math.max(...rows.map((e) => e.label.length)));
  const left = 46, right = 8, topPad = 10, plotH = 150, labelH = Math.max(40, labelLen * 6 + 8);
  const plotW = width - left - right; const slot = plotW / rows.length; const bw = Math.max(4, Math.min(34, slot * 0.7));
  let g = '';
  for (let v = 0; v <= top + 1e-9; v += step) {
    const y = topPad + plotH - (v / top) * plotH;
    g += `<line x1="${left}" x2="${width - right}" y1="${y}" y2="${y}" class="grid-line"/><text x="${left - 5}" y="${y + 3}" text-anchor="end" class="axis-text">${Number.isInteger(step) ? v : v.toFixed(1)}</text>`;
  }
  rows.forEach((e, i) => {
    const h = (e.value / top) * plotH; const x = left + i * slot + (slot - bw) / 2; const y = topPad + plotH - h;
    const lx = left + i * slot + slot / 2; const label = e.label.length > 26 ? e.label.slice(0, 25) + '…' : e.label;
    g += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(0, h)}" fill="#00C852"><title>${esc(e.label)}: ${e.value}</title></rect>`;
    g += `<text transform="translate(${lx - 3},${topPad + plotH + 6}) rotate(90)" class="axis-text">${esc(label)}</text>`;
  });
  g += `<text transform="translate(12,${topPad + plotH / 2}) rotate(-90)" text-anchor="middle" class="axis-title">URLs</text>`;
  return `<svg class="vbar" width="${width}" height="${topPad + plotH + labelH}" viewBox="0 0 ${width} ${topPad + plotH + labelH}">${g}</svg>`;
}
/* Which Overview section belongs to a main tab (so clicking any tab opens
 * its section in the right-hand Overview, like Screaming Frog). */
function sectionForTab(tabId) {
  if (tabId === 'internal') return 'Crawl Data Internal';
  if (tabId === 'external') return 'Crawl Data External';
  const f = state.filterMeta.find((m) => m.tab === tabId);
  return f ? f.section : null;
}
function focusSidebarOnTab(tabId) {
  const sec = sectionForTab(tabId);
  if (!sec) return;
  state.stab = 'overview'; state.sideSection = sec;
  const first = state.filterMeta.find((m) => m.section === sec);
  state.sideFilter = first ? first.id : null;
  if (state.collapsed.has(sec)) { state.collapsed.delete(sec); lsSet('collapsedSections', [...state.collapsed]); }
  state.scrollToSection = sec;
}
function scrollSidebarToSection() {
  const sec = state.scrollToSection; if (!sec) return;
  state.scrollToSection = null;
  const body = $('#side-body');
  const row = [...body.querySelectorAll('tr.section-row')].find((r) => r.dataset.section === sec);
  if (row) body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - 24;
}
function sectionFilters(section) { return state.filterMeta.filter((f) => f.section === section); }
function filterCount(id) { const cr = state.crawl; if (!cr) return 0; return cr.pages.filter((p) => (p.filters || []).includes(id)).length; }

function renderSidebar() {
  document.querySelectorAll('#side-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.stab === state.stab));
  const body = $('#side-body');
  const cr = state.crawl;
  if (state.stab === 'overview') return renderOverviewSide(body, cr);
  if (state.stab === 'issues') return renderIssuesSide(body, cr);
  if (state.stab === 'structure') return renderStructureSide(body, cr);
  if (state.stab === 'segments') return renderSegmentsSide(body, cr);
  if (state.stab === 'responsetimes') return renderResponseTimesSide(body, cr);
  if (state.stab === 'api') return renderApiSide(body, cr);
  if (state.stab === 'spelling') return renderSpellingSide(body, cr);
}
function renderOverviewSide(body, cr) {
  if (!cr) { body.innerHTML = '<p class="hint">No crawl yet.</p>'; setChart(null); return; }
  const total = cr.pages.length || 1;
  const pctOf = (n, base) => (base ? Math.round((n / base) * 10000) / 100 : 0);
  let html = '<table class="side-table overview"><tr><th></th><th class="num">URLs</th><th class="num">% of Total</th></tr>';
  const sumCollapsed = state.collapsed.has('Summary');
  html += `<tr class="section-row" data-section="Summary"><td colspan="3"><span class="collapse-arrow">${sumCollapsed ? '&#9654;' : '&#9660;'}</span> Summary</td></tr>`;
  if (!sumCollapsed) for (const row of (cr.analysis ? cr.analysis.summary : [])) html += `<tr><td class="ind1">${esc(row.label)}</td><td class="num">${row.count}</td><td class="num">${pctOf(row.count, total)}%</td></tr>`;
  const sections = [...new Set(state.filterMeta.map((f) => f.section))];
  for (const section of sections) {
    const filters = sectionFilters(section);
    const closed = state.collapsed.has(section);
    html += `<tr class="section-row" data-section="${esc(section)}"><td colspan="3"><span class="collapse-arrow">${closed ? '&#9654;' : '&#9660;'}</span> ${esc(section)}</td></tr>`;
    if (closed) continue;
    const base = filters.length && filters[0].name === 'All' ? filterCount(filters[0].id) : total;
    for (const f of filters) {
      const n = filterCount(f.id);
      html += `<tr class="filter-row ${state.sideFilter === f.id ? 'selected' : ''}" data-filter="${esc(f.id)}" data-section="${esc(section)}"><td class="ind1">${esc(f.name)}</td><td class="num">${n}</td><td class="num">${pctOf(n, base)}%</td></tr>`;
    }
  }
  body.innerHTML = html + '</table>';
  body.querySelectorAll('.section-row').forEach((tr) => tr.addEventListener('click', () => {
    const sec = tr.dataset.section;
    if (state.collapsed.has(sec)) state.collapsed.delete(sec); else state.collapsed.add(sec);
    lsSet('collapsedSections', [...state.collapsed]);
    renderSidebar();
  }));
  body.querySelectorAll('.filter-row').forEach((tr) => tr.addEventListener('click', () => {
    const meta = state.filterMeta.find((f) => f.id === tr.dataset.filter);
    state.sideFilter = tr.dataset.filter; state.sideSection = tr.dataset.section;
    state.tab = meta ? meta.tab : 'internal'; state.filterId = meta && meta.name === 'All' && (meta.tab === 'internal' || meta.tab === 'external') ? 'all' : tr.dataset.filter; state.issueName = null;
    if (!state.visibleTabs.includes(state.tab)) { state.visibleTabs.push(state.tab); lsSet('visibleTabs', state.visibleTabs); }
    renderAll();
  }));
  updateChart();
}
function setChart(title, html) {
  $('#chart-title').textContent = title || '';
  if (html !== undefined && html !== null) $('#chart-body').innerHTML = html;
}
function updateChart() {
  if (!state.sideFilter || !state.crawl) {
    setChart('', '<div class="chart-placeholder"><svg viewBox="0 0 60 60" width="52" height="52"><circle cx="30" cy="30" r="22" fill="none" stroke="#39424d" stroke-width="7"/><path d="M30 8a22 22 0 0 1 19 12" fill="none" stroke="#00C852" stroke-width="7"/></svg><p>Click on an SEO Element to display a graph.</p></div>');
    return;
  }
  const section = state.sideSection;
  const filters = sectionFilters(section).filter((f) => f.name !== 'All');
  const entries = filters.map((f) => ({ label: f.name, value: filterCount(f.id) }));
  const useDonut = section.startsWith('Crawl Data') || section === 'Response Codes';
  const hasData = entries.some((e) => e.value > 0);
  const title = section.startsWith('Crawl Data') ? section.replace('Crawl Data ', '') : section;
  setChart(title, hasData ? (useDonut ? donutSvg(entries.slice(0, 10)) : barSvg(entries.slice(0, 24))) : '<p class="chart-none">No data for graph.</p>');
}
const ISSUE_ICONS = {
  Issue: '<svg class="ico" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.5" fill="#D64541"/><rect x="6.2" y="3" width="1.6" height="5.2" fill="#fff"/><rect x="6.2" y="9.4" width="1.6" height="1.6" fill="#fff"/></svg>',
  Warning: '<svg class="ico" viewBox="0 0 14 14"><path d="M7 .8 13.6 13H.4z" fill="#F5A623"/><rect x="6.3" y="4.8" width="1.4" height="4.4" fill="#222"/><rect x="6.3" y="10.2" width="1.4" height="1.4" fill="#222"/></svg>',
  Opportunity: '<svg class="ico" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.5" fill="#4A90D9"/><rect x="6.2" y="6" width="1.6" height="5" fill="#fff"/><rect x="6.2" y="3.2" width="1.6" height="1.6" fill="#fff"/></svg>',
};
const PRIORITY_ICONS = {
  High: '<svg class="ico" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.8" fill="none" stroke="#D64541" stroke-width="1.6"/><path d="M7 3.6 10 7.4H8v3H6v-3H4z" fill="#D64541"/></svg>',
  Medium: '<svg class="ico" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.6" fill="none" stroke="#F5A623" stroke-width="1.8"/></svg>',
  Low: '<svg class="ico" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.8" fill="none" stroke="#4A90D9" stroke-width="1.6"/><path d="M7 10.4 4 6.6h2v-3h2v3h2z" fill="#4A90D9"/></svg>',
};
function issueDetailsHtml(iss) {
  if (!iss) return '<div class="issue-details"><div class="issue-detail-head"><button id="issue-copy" disabled>Copy</button><b>Issue Details</b><label>View: <select id="issue-view"><option>Details</option></select></label></div><p class="empty-state">No Issue Selected</p></div>';
  return `<div class="issue-details"><div class="issue-detail-head"><button id="issue-copy">Copy</button><b>Issue Details</b><label>View: <select id="issue-view"><option>Details</option></select></label></div>
    <div class="issue-detail-body"><h3>Description</h3><p>${esc(iss.description || '')}</p><h3>How To Fix</h3><p>${esc(iss.howToFix || 'No specific fix guidance for this issue.')}</p>
    <p class="hint">${ISSUE_ICONS[iss.type] || ''} ${esc(iss.type)} &nbsp; ${PRIORITY_ICONS[iss.priority] || ''} ${esc(iss.priority)} priority &nbsp; ${iss.count} URLs (${iss.pct}%)</p></div></div>`;
}
function selectIssue(cr, id) {
  const iss = cr.issues.find((i) => i.id === id);
  if (!iss) return;
  state.selectedIssue = iss.id;
  if (iss.filterId) {
    const meta = state.filterMeta.find((f) => f.id === iss.filterId);
    state.tab = meta ? meta.tab : 'internal'; state.filterId = iss.filterId; state.issueName = null;
    if (!state.visibleTabs.includes(state.tab)) { state.visibleTabs.push(state.tab); lsSet('visibleTabs', state.visibleTabs); }
  } else { state.tab = 'internal'; state.filterId = 'all'; state.issueName = iss.name; }
  renderAll();
}
function renderIssuesSide(body, cr) {
  if (!cr) { body.innerHTML = '<p class="hint">No crawl yet.</p>'; setChart('', issueDetailsHtml(null)); return; }
  const counts = { Issue: 0, Warning: 0, Opportunity: 0 };
  for (const i of cr.issues) counts[i.type] = (counts[i.type] || 0) + 1;
  const chips = [['Issue', counts.Issue, 'Issues'], ['Warning', counts.Warning, 'Warnings'], ['Opportunity', counts.Opportunity, 'Opportunities'], ['Total', cr.issues.length, 'Total']];
  let list = cr.issues;
  if (state.issueChip !== 'Total') list = list.filter((i) => i.type === state.issueChip);
  body.innerHTML = `<div class="issues-bar"><button id="issues-export">Export</button><span class="spacer"></span>${chips.map(([key, n, label]) => `<button class="chip ${state.issueChip === key ? 'active' : ''}" data-chip="${key}">${label}: ${n}</button>`).join('')}</div>
  <table class="side-table issues-table"><tr><th>Issue Name</th><th>Issue Type</th><th>Issue Priority</th><th class="num">URLs</th><th class="num">% of Total</th></tr>
  ${list.map((i) => `<tr class="issue-trow ${state.selectedIssue === i.id ? 'selected' : ''}" data-issueid="${esc(i.id)}"><td>${esc(i.name)}</td><td class="nowrap">${ISSUE_ICONS[i.type] || ''} ${esc(i.type)}</td><td class="nowrap">${PRIORITY_ICONS[i.priority] || ''} ${esc(i.priority)}</td><td class="num">${i.count}</td><td class="num">${i.pct}%</td></tr>`).join('') || '<tr><td colspan="5">No issues</td></tr>'}</table>`;
  const sel = cr.issues.find((i) => i.id === state.selectedIssue);
  setChart('', issueDetailsHtml(sel));
  body.querySelectorAll('[data-chip]').forEach((b) => b.addEventListener('click', () => { state.issueChip = b.dataset.chip; renderSidebar(); }));
  body.querySelectorAll('.issue-trow').forEach((tr) => tr.addEventListener('click', () => selectIssue(cr, tr.dataset.issueid)));
  const ex = $('#issues-export'); if (ex) ex.addEventListener('click', exportIssues);
  const cp = $('#issue-copy');
  if (cp && sel) cp.addEventListener('click', () => { const text = `${sel.name}\nType: ${sel.type} | Priority: ${sel.priority} | URLs: ${sel.count} (${sel.pct}%)\n\nDescription\n${sel.description}\n\nHow To Fix\n${sel.howToFix || ''}`; if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => { cp.textContent = 'Copied'; setTimeout(() => { cp.textContent = 'Copy'; }, 1200); }); });
}
function renderStructureSide(body, cr) {
  if (!cr || !cr.analysis) { body.innerHTML = '<p class="hint">No crawl yet.</p>'; return; }
  const st = cr.analysis.siteStructure;
  let html = '<table class="side-table"><tr><th>Segment</th><th>URLs</th><th>% of Total</th><th>Indexable</th><th>Non-Indexable</th></tr>' +
    st.rows.map((r) => `<tr><td>${esc(r.segment)}</td><td>${r.urls}</td><td>${r.pct}%</td><td>${r.indexable}</td><td>${r.nonIndexable}</td></tr>`).join('') + '</table>';
  html += '<h4>Crawl Depth</h4><div class="legend-chips"><span class="lchip"><span class="swatch" style="background:#9AA0A6"></span>Blocked by robots.txt</span><span class="lchip"><span class="swatch" style="background:#666"></span>No Response</span><span class="lchip"><span class="swatch" style="background:#00C852"></span>2xx</span><span class="lchip"><span class="swatch" style="background:#F5A623"></span>3xx</span><span class="lchip"><span class="swatch" style="background:#D64541"></span>4xx</span><span class="lchip"><span class="swatch" style="background:#8B2E2E"></span>5xx</span></div>';
  html += '<label>View: <select id="depth-view"><option>Chart</option><option>Table</option></select></label> <label>Max Level: <input type="number" id="depth-max" value="9" min="1" max="30" style="width:56px"></label><div id="depth-chart"></div>';
  body.innerHTML = html;
  const draw = () => {
    const max = Number($('#depth-max').value) || 9;
    const view = $('#depth-view').value;
    const rows = st.depthChart.filter((d) => d.depth <= max);
    if (view === 'Table') { $('#depth-chart').innerHTML = '<table class="side-table"><tr><th>Depth</th><th>URLs</th><th>2xx</th><th>3xx</th><th>4xx</th><th>5xx</th></tr>' + rows.map((d) => `<tr><td>${d.depth}</td><td>${d.total}</td><td>${d.s2xx}</td><td>${d.s3xx}</td><td>${d.s4xx}</td><td>${d.s5xx}</td></tr>`).join('') + '</table>'; return; }
    const maxTotal = Math.max(1, ...rows.map((d) => d.total));
    $('#depth-chart').innerHTML = rows.map((d) => {
      const seg = (v, col) => v ? `<span class="stack-seg" style="width:${(v / maxTotal) * 100}%;background:${col}" title="${v}"></span>` : '';
      return `<div class="bar-row"><span class="bar-label">${d.depth}</span><span class="bar-track stack">${seg(d.blocked, '#9AA0A6')}${seg(d.noResponse, '#666')}${seg(d.s2xx, '#00C852')}${seg(d.s3xx, '#F5A623')}${seg(d.s4xx, '#D64541')}${seg(d.s5xx, '#8B2E2E')}</span><span class="bar-val">${d.total}</span></div>`;
    }).join('');
  };
  $('#depth-max').addEventListener('change', draw); $('#depth-view').addEventListener('change', draw); draw();
}
function renderSegmentsSide(body, cr) {
  if (!cr || !cr.analysis) { body.innerHTML = '<p class="hint">No crawl yet.</p>'; return; }
  const segs = cr.analysis.segments || [];
  if (!segs.length) { body.innerHTML = "<p class=\"empty-state\">Please configure 'Segments' to populate this table</p>"; return; }
  let html = '<table class="side-table"><tr><th>Segment</th><th>URLs</th><th>% of Total</th><th>Indexable</th><th>Non-Indexable</th></tr>' +
    segs.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.urls}</td><td>${s.pct}%</td><td>${s.indexable}</td><td>${s.nonIndexable}</td></tr>`).join('') + '</table>';
  html += '<h4>Overview</h4><div class="chips"><button class="chip seg-chip active" data-segchip="Issues">Issues</button><button class="chip seg-chip" data-segchip="URLs">URLs</button><button class="chip seg-chip" data-segchip="Issue Priority">Issue Priority</button><button class="chip seg-chip" data-segchip="Issue Type">Issue Type</button></div><div id="seg-detail"></div>';
  body.innerHTML = html;
  const detail = (kind) => {
    const el = $('#seg-detail'); if (!el) return;
    if (kind === 'URLs') el.innerHTML = segs.map((s) => `<div class="tree-row"><span>${esc(s.name)}</span><b>${s.urls}</b></div>`).join('');
    else if (kind === 'Issue Priority' || kind === 'Issue Type') {
      const key = kind === 'Issue Priority' ? 'priority' : 'type';
      const counts = {};
      for (const i of cr.issues) counts[i[key]] = (counts[i[key]] || 0) + 1;
      el.innerHTML = Object.entries(counts).map(([k, v]) => `<div class="tree-row"><span>${esc(k)}</span><b>${v}</b></div>`).join('');
    } else el.innerHTML = cr.issues.slice(0, 8).map((i) => `<div class="tree-row"><span>${esc(i.name)}</span><b>${i.count}</b></div>`).join('');
  };
  body.querySelectorAll('.seg-chip').forEach((b) => b.addEventListener('click', () => { body.querySelectorAll('.seg-chip').forEach((x) => x.classList.toggle('active', x === b)); detail(b.dataset.segchip); }));
  detail('Issues');
}
function renderResponseTimesSide(body, cr) {
  if (!cr || !cr.analysis) { body.innerHTML = '<p class="hint">No crawl yet.</p>'; return; }
  const rt = cr.analysis.responseTimes;
  body.innerHTML = `<p><b>Average Response Time: ${rt.average} secs</b> <span class="hint">(${rt.sampled} URLs sampled)</span></p>
  <table class="side-table"><tr><th>Response Time (In Seconds)</th><th>URLs</th><th>% of Total</th></tr>
  ${rt.buckets.map((b) => `<tr><td>${esc(b.label)}</td><td>${b.count}</td><td>${b.pct}%</td></tr>`).join('')}</table>
  <div class="rt-chart">${barSvg(rt.buckets.map((b) => ({ label: b.label, value: b.count })))}</div>`;
  setChart('Response Times', '');
}
function renderApiSide(body, cr) {
  if (!state.hasPsiKey) {
    body.innerHTML = '<div class="empty-state"><p>PageSpeed Insights is not connected.</p><p class="hint">Add a PageSpeed API key in Configuration &gt; API Access &gt; PageSpeed, then this tab can fetch live scores for crawled URLs. Google Analytics and Search Console connections require OAuth and are not connected.</p></div>';
    return;
  }
  const urls = cr ? cr.pages.filter((p) => p.contentCategory === 'HTML' && p.statusCode === 200).map((p) => p.address).slice(0, 100) : [];
  body.innerHTML = `<p class="hint">PageSpeed API key saved. ${urls.length} HTML URLs available.</p><button id="psi-fetch" class="primary" ${urls.length ? '' : 'disabled'}>Fetch PageSpeed Insights</button><div id="psi-results">${state.psi.length ? psiTable() : ''}</div>`;
  const btn = $('#psi-fetch');
  if (btn) btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Fetching...';
    try {
      state.psi = await window.spider.psiFetch(urls);
      const byUrl = new Map(state.psi.map((r) => [r.url, r]));
      for (const p of (state.crawl ? state.crawl.pages : [])) { const r = byUrl.get(p.address); if (r && typeof r.score === 'number') { p.psiScore = r.score; p.psiLcp = r.lcp; p.psiCls = r.cls; p.psiTbt = r.tbt; p.filters = (p.filters || []).filter((f) => !f.startsWith('psi-')).concat(['psi-all', r.score >= 90 ? 'psi-good' : r.score >= 50 ? 'psi-ni' : 'psi-poor']); } }
    } catch (e) { $('#psi-results').textContent = 'PageSpeed fetch failed: ' + e.message; }
    btn.disabled = false; btn.textContent = 'Fetch PageSpeed Insights';
    renderSidebar();
    if (state.tab === 'pagespeed') renderGrid();
  });
}
function psiTable() {
  return '<table class="side-table"><tr><th>URL</th><th>Score</th><th>LCP</th><th>CLS</th><th>TBT</th></tr>' + state.psi.map((r) => `<tr><td>${esc(r.url)}</td><td>${r.score ?? ''}</td><td>${esc(r.lcp || '')}</td><td>${esc(r.cls || '')}</td><td>${esc(r.tbt || '')}</td></tr>`).join('') + '</table>';
}
function renderSpellingSide(body, cr) {
  if (!cr || !cr.analysis) { body.innerHTML = '<p class="hint">No crawl yet.</p>'; return; }
  const sp = cr.analysis.spelling;
  const rows = cr.pages.filter((p) => (p.spellingErrors || 0) > 0).sort((a, b) => b.spellingErrors - a.spellingErrors).slice(0, 100);
  body.innerHTML = `<table class="side-table"><tr><th>Measure</th><th>Count</th></tr>
  <tr><td>Pages With Spelling Errors</td><td>${sp.pagesWithErrors}</td></tr>
  <tr><td>Total Spelling Errors</td><td>${sp.totalErrors}</td></tr>
  <tr><td>Pages With Grammar Errors</td><td>${cr.pages.filter((p) => (p.grammarErrors || 0) > 0).length}</td></tr>
  <tr><td>Total Grammar Errors</td><td>${cr.pages.reduce((a, p) => a + (p.grammarErrors || 0), 0)}</td></tr></table>
  <p class="hint">Dictionary spell check plus built-in grammar rules (repeated words, a/an, "could of", sentence case, missing spaces). Select a URL and open the Spelling &amp; Grammar tab in the bottom pane for details.</p>
  ${rows.length ? '<table class="side-table"><tr><th>URL</th><th>Errors</th></tr>' + rows.map((p) => `<tr><td>${esc(p.address)}</td><td>${p.spellingErrors}</td></tr>`).join('') + '</table>' : ''}`;
}

/* ---------- compare panel ---------- */
function renderCompare() {
  const el = $('#compare-panel');
  if (!state.compare) { el.innerHTML = '<h2>Crawl Comparison</h2><p>Compare mode shows how every Overview filter changed between a previous crawl and the current one. Run or open the current crawl first, then pick the previous saved crawl.</p><button id="btn-compare-pick" class="primary">Pick Previous Crawl...</button>'; const b = $('#btn-compare-pick'); if (b) b.addEventListener('click', doCompare); return; }
  const d = state.compare.diff;
  const fd = (d.filterDeltas || []).filter((f) => f.current || f.previous);
  const secs = [...new Set(fd.map((f) => f.section))];
  const cell = (f, key, list) => list.length ? `<td class="num link" data-cmp="${esc(f.id)}" data-kind="${key}">${list.length}</td>` : '<td class="num">0</td>';
  let rows = '';
  for (const sec of secs) {
    rows += `<tr class="section-row"><td colspan="8">${esc(sec)}</td></tr>`;
    for (const f of fd.filter((x) => x.section === sec)) {
      const ch = f.current - f.previous;
      rows += `<tr><td class="ind1">${esc(f.name)}</td><td class="num">${f.current}</td><td class="num">${f.previous}</td><td class="num ${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}">${ch > 0 ? '+' : ''}${ch}</td>${cell(f, 'added', f.added)}${cell(f, 'newUrls', f.newUrls)}${cell(f, 'removed', f.removed)}${cell(f, 'missing', f.missing)}</tr>`;
    }
  }
  const sel = state.compareSel;
  const selF = sel && fd.find((f) => f.id === sel.id);
  const label = { added: 'Added', newUrls: 'New', removed: 'Removed', missing: 'Missing' };
  el.innerHTML = `<h2>Crawl Comparison</h2><p>Current crawl vs previous crawl: ${esc(state.compare.otherRoot || '')} (${esc(state.compare.otherAt || '')}).</p>
  <div class="cards"><div class="card"><div class="n">${d.added.length}</div><div class="l">New URLs</div></div><div class="card"><div class="n">${d.removed.length}</div><div class="l">Missing URLs</div></div><div class="card"><div class="n">${d.changed.length}</div><div class="l">Changed URLs</div></div><button id="btn-compare-pick" class="secondary">Compare With Another Crawl...</button></div>
  <p class="hint"><b>Added</b>: URL was in the previous crawl but not in this filter. <b>New</b>: URL was not in the previous crawl. <b>Removed</b>: URL is still crawled but left this filter. <b>Missing</b>: URL is no longer in the crawl. Click a number to list the URLs.</p>
  <div class="cmp-split"><table class="cmp-table"><tr><th>Filter</th><th class="num">Current</th><th class="num">Previous</th><th class="num">Change</th><th class="num">Added</th><th class="num">New</th><th class="num">Removed</th><th class="num">Missing</th></tr>${rows || '<tr><td colspan="8">No filter data to compare.</td></tr>'}</table>
  <div class="cmp-list">${selF ? `<h3>${esc(selF.section)} : ${esc(selF.name)} - ${label[sel.kind]} (${selF[sel.kind].length})</h3><ul>${selF[sel.kind].map((u) => `<li>${esc(u)}</li>`).join('')}</ul>` : '<p class="hint">Select a number to see its URLs.</p>'}</div></div>
  <h3>Changed URLs</h3><table><tr><th>Address</th><th>Field</th><th>Previous</th><th>Current</th></tr>
  ${d.changed.flatMap((c) => c.diffs.map((df) => `<tr><td>${esc(c.address)}</td><td>${esc(df.field)}</td><td>${esc(df.before)}</td><td>${esc(df.after)}</td></tr>`)).join('') || '<tr><td colspan="4">No changes</td></tr>'}</table>`;
  el.querySelectorAll('[data-cmp]').forEach((td) => td.addEventListener('click', () => { state.compareSel = { id: td.dataset.cmp, kind: td.dataset.kind }; renderCompare(); }));
  const b = $('#btn-compare-pick'); if (b) b.addEventListener('click', doCompare);
}
async function doCompare() {
  try { const r = await window.spider.crawlComparePick(); if (r) { state.compare = r; state.tab = 'compare'; renderAll(); } }
  catch (e) { setProgress('Compare failed: ' + e.message); }
}

/* ---------- exports ---------- */
function toCsv(rows, columns, cx) {
  const head = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(',');
  const lines = rows.map((r) => columns.map((c) => `"${String(c.get(r, cx) ?? '').replace(/"/g, '""')}"`).join(','));
  return [head, ...lines].join('\n');
}
async function exportCurrentTab() {
  const cr = state.crawl; if (!cr) return;
  const t = currentTab(); const columns = visibleColumns();
  await window.spider.saveText({ defaultPath: `seonfix-spider-${t.id}.csv`, content: toCsv(tabRows(), columns, crawlCtx(cr)) });
}
async function exportIssues() {
  const cr = state.crawl; if (!cr) return;
  const cols = [{ label: 'Issue Name', get: (i) => i.name }, { label: 'Issue Type', get: (i) => i.type }, { label: 'Issue Priority', get: (i) => i.priority }, { label: 'URLs', get: (i) => i.count }, { label: '% of Total', get: (i) => i.pct }, { label: 'Description', get: (i) => i.description }, { label: 'How To Fix', get: (i) => i.howToFix || '' }]; 
  await window.spider.saveText({ defaultPath: 'seonfix-spider-issues.csv', content: toCsv(cr.issues, cols) });
}
const GEN_COLS = [{ label: 'Address', get: (p) => p.address }, { label: 'Content Type', get: (p) => p.contentType || p.contentCategory || '' }, { label: 'Status Code', get: (p) => p.statusCode ?? '' }, { label: 'Status', get: (p) => p.status || '' }, { label: 'Indexability', get: (p) => p.indexability || '' }, { label: 'Title 1', get: (p) => p.title || '' }, { label: 'Word Count', get: (p) => p.wordCount ?? '' }, { label: 'Inlinks', get: (p) => p.inlinks ?? 0 }, { label: 'Outlinks', get: (p) => p.outlinks ?? 0 }, { label: 'Crawl Depth', get: (p) => p.depth ?? '' }, { label: 'Link Score', get: (p) => p.linkScore ?? '' }];
async function exportPages(pages, name) { await window.spider.saveText({ defaultPath: name, content: toCsv(pages, GEN_COLS) }); }
async function bulkExport(action, arg) {
  const cr = state.crawl; if (!cr) { setProgress('Run a crawl first.'); return; }
  if (action === 'bulk-queued') return exportPages(cr.pages.filter((p) => !p.statusCode && !p.sitemapOnly), 'queued-urls.csv');
  if (action === 'bulk-links') {
    const rows = [];
    for (const p of cr.pages) for (const l of p.links || []) rows.push({ from: p.address, to: l.url, anchor: l.anchor, follow: l.follow ? 'Follow' : 'Nofollow', external: l.external });
    let filtered = rows;
    if (arg === 'inlinks' || arg === 'int-inlinks') filtered = rows;
    if (arg === 'ext-outlinks') filtered = rows.filter((r) => r.external);
    if (arg === 'int-inlinks') filtered = rows.filter((r) => !r.external);
    const cols = [{ label: 'From', get: (r) => r.from }, { label: 'To', get: (r) => r.to }, { label: 'Anchor Text', get: (r) => r.anchor }, { label: 'Follow', get: (r) => r.follow }];
    return window.spider.saveText({ defaultPath: `links-${arg}.csv`, content: toCsv(filtered, cols) });
  }
  if (action === 'bulk-web') return exportPages(arg === 'all' ? cr.pages : cr.pages.filter((p) => (arg === 'internal' ? !p.external : p.external)), `web-${arg}.csv`);
  if (action === 'bulk-category') return exportPages(cr.pages.filter((p) => p.contentCategory === arg), `path-type-${String(arg).toLowerCase()}.csv`);
  if (action === 'bulk-section') {
    const ids = state.filterMeta.filter((f) => f.section === arg.section).map((f) => f.id);
    const allId = ids.find((id) => id.endsWith('-all')) || ids[0];
    return exportPages(cr.pages.filter((p) => (p.filters || []).includes(allId)), `${arg.section.toLowerCase().replace(/\s+/g, '-')}.csv`);
  }
  if (action === 'bulk-tab') { state.tab = arg; state.filterId = 'all'; renderAll(); return exportCurrentTab(); }
  if (action === 'bulk-inspection') {
    if (!state.selected) { setProgress('Select a URL row first for URL Inspection export.'); return; }
    return window.spider.saveText({ defaultPath: 'url-inspection.txt', content: JSON.stringify(state.selected, null, 1) });
  }
  if (action === 'bulk-issues') return exportIssues();
}

/* ---------- config dialog ---------- */
const CFG_SECTIONS = [
  { id: 'crawl', label: 'Spider > Crawl' }, { id: 'extraction-note', label: 'Spider > Extraction' }, { id: 'limits', label: 'Spider > Limits' },
  { id: 'rendering', label: 'Spider > Rendering' }, { id: 'advanced', label: 'Spider > Advanced' }, { id: 'preferences', label: 'Spider > Preferences' },
  { id: 'contentarea', label: 'Content > Content Area' }, { id: 'duplicates', label: 'Content > Duplicates' }, { id: 'spelling', label: 'Content > Spelling & Grammar' },
  { id: 'robots', label: 'robots.txt' }, { id: 'rewriting', label: 'URL Rewriting' }, { id: 'cdns', label: 'CDNs' },
  { id: 'include', label: 'Include' }, { id: 'exclude', label: 'Exclude' }, { id: 'speed', label: 'Speed' },
  { id: 'useragent', label: 'User-Agent' }, { id: 'httpheader', label: 'HTTP Header' },
  { id: 'customsearch', label: 'Custom > Custom Search' }, { id: 'customextraction', label: 'Custom > Custom Extraction' }, { id: 'customlinkpos', label: 'Custom > Custom Link Positions' },
  { id: 'api-ga', label: 'API Access > Google Analytics' }, { id: 'api-gsc', label: 'API Access > Search Console' }, { id: 'api-psi', label: 'API Access > PageSpeed Insights' },
  { id: 'api-backlinks', label: 'API Access > Backlink APIs' }, { id: 'api-ai', label: 'API Access > AI' },
  { id: 'auth-basic', label: 'Authentication > Standards Based' }, { id: 'auth-form', label: 'Authentication > Forms Based' },
  { id: 'segments', label: 'Segments' }, { id: 'analysis', label: 'Crawl Analysis' }, { id: 'profiles', label: 'Profiles' },
];
let cfgSection = 'crawl';
function cfgField(id) { return document.getElementById(id); }
function renderConfigSections() {
  $('#cfg-sections').innerHTML = CFG_SECTIONS.map((s) => `<button data-cfgsec="${s.id}" class="${s.id === cfgSection ? 'active' : ''}">${esc(s.label)}</button>`).join('');
  document.querySelectorAll('[data-cfgsec]').forEach((b) => b.addEventListener('click', () => { cfgSection = b.dataset.cfgsec; renderConfigSections(); renderConfigPage(); }));
}
function renderConfigPage() {
  const el = $('#cfg-pages'); const c = collectConfigDraft();
  const n = (id, label, val, extra = '') => `<label>${label} <input type="number" id="${id}" value="${esc(val ?? '')}" ${extra}></label>`;
  const t = (id, label, val, ph = '') => `<label>${label} <input type="text" id="${id}" value="${esc(val ?? '')}" spellcheck="false" placeholder="${esc(ph)}"></label>`;
  const ta = (id, label, val, rows = 4) => `<label>${label} <textarea id="${id}" rows="${rows}" spellcheck="false">${esc(val ?? '')}</textarea></label>`;
  const chk = (id, label, val) => `<label class="chk"><input type="checkbox" id="${id}" ${val ? 'checked' : ''}> ${label}</label>`;
  const linesOf = (arr) => (arr || []).join('\n');
  const pages = {
    'crawl': () => '<h4>Resource Links</h4><div class="cfg-grid">' + chk('cfg-resources', 'Crawl Resources (master switch)', c.crawlResources !== false) + chk('cfg-crawlimages', 'Images', c.crawlImages !== false) + chk('cfg-crawlcss', 'CSS', c.crawlCss !== false) + chk('cfg-crawljs', 'JavaScript', c.crawlJs !== false) + chk('cfg-imagesizes', 'Check Image Sizes', c.checkImageSizes !== false) + '</div>' +
      '<h4>Page Links</h4><div class="cfg-grid">' + chk('cfg-external', 'Check External Links (status checked once, never followed)', c.crawlExternal !== false) + chk('cfg-follow-int-nf', 'Follow Internal "nofollow"', !!c.followInternalNofollow) + chk('cfg-follow-ext-nf', 'Follow External "nofollow"', !!c.followExternalNofollow) + chk('cfg-iframes', 'Crawl Iframes', c.crawlIframes !== false) + chk('cfg-metarefresh', 'Follow Meta Refresh', c.followMetaRefresh !== false) + '</div>' +
      '<h4>Crawl Behaviour</h4><div class="cfg-grid">' + chk('cfg-canonicals', 'Crawl Canonicals', c.crawlCanonicals !== false) + chk('cfg-pagination', 'Crawl Pagination (rel="next" / "prev")', !!c.crawlPagination) + chk('cfg-hreflang', 'Crawl Hreflang', !!c.crawlHreflang) + chk('cfg-amp', 'Crawl AMP', !!c.crawlAmp) + '</div>' +
      '<h4>Limits &amp; Scope</h4>' + n('cfg-concurrency', 'Threads / Concurrency', c.concurrency) + n('cfg-depth', 'Max Crawl Depth (0 = unlimited)', c.maxDepth) + n('cfg-maxurls', 'Max URLs', c.maxUrls) + `<label>Default Scope <select id="cfg-scope"><option value="subdomain">Subdomain</option><option value="subfolder">Subfolder</option><option value="all-subdomains">All Subdomains</option><option value="exact">Exact URL</option></select></label>`,
    'extraction-note': () => '<h4>HTML</h4>' + chk('cfg-storehtml', 'Store HTML (needed for the View Source tab; makes saved crawls larger)', !!c.storeHtml) + '<p class="hint">Page titles, meta descriptions, headings, directives, links, images, hreflang and structured data are always extracted. Meta Keywords are not collected. Custom extraction rules live under Custom &gt; Custom Extraction.</p>',
    'limits': () => n('cfg-timeout', 'Request Timeout (ms)', c.timeoutMs) + n('cfg-maxredirects', 'Max Redirects', c.maxRedirects),
    'rendering': () => `<label>Rendering <select id="cfg-rendering"><option value="text">Text Only (raw HTML)</option><option value="rendered">JavaScript Rendering (rendered HTML comparison)</option></select></label><p class="hint">Rendered mode loads up to 200 HTML pages in a hidden Chromium window after the crawl and records rendered-vs-raw differences for the JavaScript tab.</p>`,
    'advanced': () => t('cfg-cookies', 'Cookies Sent With Every Request', c.cookies, 'name=value; name2=value2') + '<p class="hint">Custom request headers are set under HTTP Header.</p>',
    'preferences': () => chk('cfg-spell', 'Enable basic spell check', c.spellCheck !== false) + '<p class="hint">Preferences are stored with the configuration.</p>',
    'contentarea': () => '<p class="hint">Word count, readability, spelling, grammar and duplicate checks use only the content area. One CSS selector per line (element, .class or #id).</p>' + ta('cfg-ca-include', 'Include Only These Elements (leave empty for the whole body)', linesOf((c.contentArea || {}).include), 3) + ta('cfg-ca-exclude', 'Exclude These Elements', linesOf((c.contentArea || { exclude: ['nav', 'footer'] }).exclude), 4),
    'duplicates': () => `<label>Near-Duplicate Similarity Threshold (0-1) <input type="text" id="cfg-dupthreshold" value="${esc(c.duplicatesThreshold ?? 0.92)}"></label>`,
    'spelling': () => chk('cfg-spell2', 'Enable Spell Check', c.spellCheck !== false) + chk('cfg-grammar', 'Enable Grammar Check', c.grammarCheck !== false) + '<p class="hint">Spelling uses the bundled English dictionary. Grammar uses built-in rules (repeated words, a/an, "could of", sentence case, missing spaces); it is not a full grammar engine.</p>',
    'robots': () => chk('cfg-robots', 'Respect robots.txt', c.respectRobots !== false) + ta('cfg-customrobots', 'Custom robots.txt (overrides the live file when filled)', c.customRobotsText, 6),
    'rewriting': () => ta('cfg-rewrites', 'URL Rewrite Rules (one per line: pattern => replacement, regex)', linesOf((c.urlRewrites || []).map((r) => `${r.pattern} => ${r.replacement}`)), 4),
    'cdns': () => ta('cfg-cdns', 'CDN Host Patterns Treated as Internal (one regex per line)', linesOf(c.cdnPatterns), 3),
    'include': () => ta('cfg-include', 'Include Regex (one per line)', linesOf(c.includePatterns), 4),
    'exclude': () => ta('cfg-exclude', 'Exclude Regex (one per line)', linesOf(c.excludePatterns), 4),
    'speed': () => n('cfg-delay', 'Crawl Delay Between Requests (ms)', c.delayMs) + n('cfg-concurrency2', 'Threads / Concurrency', c.concurrency),
    'useragent': () => `<label>User-Agent Preset <select id="cfg-uapreset"><option value="spider">Seonfix Spider</option><option value="chrome">Chrome (Desktop)</option><option value="googlebot">Googlebot</option><option value="googlebot-smartphone">Googlebot Smartphone</option><option value="bingbot">Bingbot</option><option value="custom">Custom</option></select></label>` + t('cfg-uacustom', 'Custom User-Agent', c.userAgentPreset ? '' : (c.userAgent || '')),
    'httpheader': () => ta('cfg-headers-x', 'Custom HTTP Request Headers (one per line, Name: Value)', Object.entries(c.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'), 6) + '<p class="hint">For example Accept-Language: en-GB. The User-Agent is set on the User-Agent page.</p>',
    'customsearch': () => '<p class="hint">One per line: Name | contains / notcontains | text or code to find.</p>' + ta('cfg-search', 'Custom Search Rules', linesOf((c.searchRules || []).map((e) => `${e.name} | ${e.mode} | ${e.needle}`)), 4),
    'customextraction': () => '<p class="hint">One per line: Name | css / regex / xpath | selector or pattern. XPath covers a basic subset such as //tag and //tag[@attr=\'value\'].</p>' + ta('cfg-extractors', 'Custom Extraction Rules', linesOf((c.extractors || []).map((e) => `${e.name} | ${e.type} | ${e.value}`)), 4),
    'customlinkpos': () => '<p class="hint">One rule per line: Position Name | text to match. The text is matched against the link\'s ancestor elements (tag names, ids and classes), first match wins, and your rules run before the defaults (nav/menu = Navigation, header = Header, footer = Footer, sidebar/aside = Sidebar, otherwise Content).</p>' + ta('cfg-linkpos', 'Custom Link Positions', linesOf((c.linkPositions || []).map((r) => `${r.name} | ${r.pattern}`)), 5),
    'api-ga': () => t('cfg-ga-id', 'Google Analytics Property ID', c.gaPropertyId || '') + '<p class="hint">Stored with the configuration. Pulling GA data requires Google OAuth, which is not yet connected.</p>',
    'api-gsc': () => t('cfg-gsc-site', 'Search Console Site URL', c.gscSiteUrl || '') + '<p class="hint">Stored with the configuration. Pulling Search Console data requires Google OAuth, which is not yet connected.</p>',
    'api-psi': () => `<label>PageSpeed Insights API Key <input type="password" id="cfg-psi-key" placeholder="${state.hasPsiKey ? 'Saved (enter to replace)' : 'AIza...'}"></label><p class="hint">The key is stored encrypted on this computer and powers the API sidebar tab and the PageSpeed tab.</p>`,
    'api-backlinks': () => t('cfg-ahrefs-key', 'Ahrefs API Key', '') + t('cfg-moz-key', 'Moz API Key', '') + '<p class="hint">Backlink API connections are not yet implemented; keys entered here are not stored or sent anywhere.</p>',
    'api-ai': () => t('cfg-openai-key', 'OpenAI API Key', '') + '<p class="hint">AI provider connections are not yet implemented; keys entered here are not stored or sent anywhere.</p>',
    'auth-basic': () => t('cfg-basic-user', 'Basic Auth Username', (c.basicAuth || {}).username || '') + `<label>Basic Auth Password <input type="password" id="cfg-basic-pass" value="${esc((c.basicAuth || {}).password || '')}"></label><p class="hint">Sent as an Authorization: Basic header with every crawl request.</p>`,
    'auth-form': () => t('cfg-form-url', 'Login Page URL', ((c.formAuth || {}).url) || '', 'https://example.com/login') + t('cfg-form-user', 'Username', ((c.formAuth || {}).username) || '') + `<label>Password <input type="password" id="cfg-form-pass" placeholder="${state.hasFormPassword ? 'Saved (enter to replace)' : ''}"></label>` + t('cfg-form-user-field', 'Username Field Name (optional, detected automatically)', ((c.formAuth || {}).userField) || '') + t('cfg-form-pass-field', 'Password Field Name (optional, detected automatically)', ((c.formAuth || {}).passField) || '') + '<p class="hint">Before crawling, Seonfix Spider opens the login page, fills the form that has a password field (keeping hidden fields such as CSRF tokens), submits it and uses the session cookies for the whole crawl. The password is stored encrypted on this computer. Only use this on sites you are allowed to crawl, and exclude logout URLs.</p>' + '',
    'segments': () => '<p class="hint">One per line: Name | URL pattern or regex.</p>' + ta('cfg-segments', 'Segments', linesOf((c.segments || []).map((s) => `${s.name} | ${s.pattern}`)), 5),
    'analysis': () => '<p class="hint">Crawl Analysis &gt; Analyse in the menu recomputes Link Score, orphan pages and near-duplicate groups for the current crawl.</p>' + `<label>Near-Duplicate Similarity Threshold (0-1) <input type="text" id="cfg-dupthreshold2" value="${esc(c.duplicatesThreshold ?? 0.92)}"></label>`,
    'profiles': () => '<p class="hint">Use the Configuration &gt; Profiles menu to load/save profiles, or set the current configuration as the default.</p>',
  };
  el.innerHTML = (pages[cfgSection] || pages.crawl)();
  const scope = cfgField('cfg-scope'); if (scope) scope.value = c.scope || 'subdomain';
  const rend = cfgField('cfg-rendering'); if (rend) rend.value = c.rendering || 'text';
  const ua = cfgField('cfg-uapreset'); if (ua) ua.value = c.userAgentPreset || 'spider';
}
let configDraft = null;
function collectConfigDraft() { return configDraft || state.config || {}; }
function readConfigPage() {
  const c = { ...(configDraft || state.config || {}) };
  const num = (id, key) => { const e = cfgField(id); if (e) c[key] = Number(e.value) || c[key] || 0; };
  const txt = (id, key) => { const e = cfgField(id); if (e) c[key] = e.value; };
  const chkV = (id, key) => { const e = cfgField(id); if (e) c[key] = e.checked; };
  const linesV = (id) => { const e = cfgField(id); return e ? e.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : null; };
  num('cfg-concurrency', 'concurrency'); num('cfg-concurrency2', 'concurrency'); num('cfg-depth', 'maxDepth'); num('cfg-maxurls', 'maxUrls');
  num('cfg-timeout', 'timeoutMs'); num('cfg-maxredirects', 'maxRedirects'); num('cfg-delay', 'delayMs');
  chkV('cfg-external', 'crawlExternal'); chkV('cfg-resources', 'crawlResources'); chkV('cfg-imagesizes', 'checkImageSizes');
  chkV('cfg-robots', 'respectRobots'); chkV('cfg-spell', 'spellCheck'); chkV('cfg-spell2', 'spellCheck'); chkV('cfg-grammar', 'grammarCheck');
  chkV('cfg-crawlimages', 'crawlImages'); chkV('cfg-crawlcss', 'crawlCss'); chkV('cfg-crawljs', 'crawlJs');
  chkV('cfg-follow-int-nf', 'followInternalNofollow'); chkV('cfg-follow-ext-nf', 'followExternalNofollow'); chkV('cfg-iframes', 'crawlIframes'); chkV('cfg-metarefresh', 'followMetaRefresh');
  chkV('cfg-canonicals', 'crawlCanonicals'); chkV('cfg-pagination', 'crawlPagination'); chkV('cfg-hreflang', 'crawlHreflang'); chkV('cfg-amp', 'crawlAmp'); chkV('cfg-storehtml', 'storeHtml');
  const cai = linesV('cfg-ca-include'); const cae = linesV('cfg-ca-exclude'); if (cai || cae) c.contentArea = { include: cai || [], exclude: cae || [] };
  const lpos = linesV('cfg-linkpos'); if (lpos) c.linkPositions = lpos.map((l) => { const [name, ...rest] = l.split('|').map((x) => x.trim()); return rest.length ? { name, pattern: rest.join('|') } : null; }).filter(Boolean);
  txt('cfg-scope', 'scope'); txt('cfg-rendering', 'rendering'); txt('cfg-customrobots', 'customRobotsText');
  txt('cfg-cookies', 'cookies'); txt('cfg-ga-id', 'gaPropertyId'); txt('cfg-gsc-site', 'gscSiteUrl'); 
  const dt = cfgField('cfg-dupthreshold') || cfgField('cfg-dupthreshold2'); if (dt) c.duplicatesThreshold = Math.min(1, Math.max(0, Number(dt.value) || 0.92));
  const ua = cfgField('cfg-uapreset'); if (ua) { c.userAgentPreset = ua.value === 'custom' ? '' : ua.value; c.userAgent = ua.value === 'custom' ? (cfgField('cfg-uacustom').value || '') : (state.uaPresets[ua.value] || ''); }
  const hdrs = linesV('cfg-headers-x'); if (hdrs) { c.headers = {}; for (const l of hdrs) { const i = l.indexOf(':'); if (i > 0) c.headers[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } }
  const inc = linesV('cfg-include'); if (inc) c.includePatterns = inc;
  const exc = linesV('cfg-exclude'); if (exc) c.excludePatterns = exc;
  const cdns = linesV('cfg-cdns'); if (cdns) c.cdnPatterns = cdns;
  const rw = linesV('cfg-rewrites'); if (rw) c.urlRewrites = rw.map((l) => { const [pattern, ...rest] = l.split('=>'); return { pattern: (pattern || '').trim(), replacement: rest.join('=>').trim() }; }).filter((r) => r.pattern);
  const srch = linesV('cfg-search'); if (srch) c.searchRules = srch.map((l) => { const [name, mode, ...rest] = l.split('|').map((s) => s.trim()); return name && rest.length ? { name, mode: (mode || 'contains').toLowerCase(), needle: rest.join('|') } : null; }).filter(Boolean);
  const extr = linesV('cfg-extractors'); if (extr) c.extractors = extr.map((l) => { const [name, type, ...rest] = l.split('|').map((s) => s.trim()); return name && rest.length ? { name, type: (type || 'css').toLowerCase(), value: rest.join('|') } : null; }).filter(Boolean);
  const segs = linesV('cfg-segments'); if (segs) c.segments = segs.map((l) => { const [name, ...rest] = l.split('|').map((s) => s.trim()); return rest.length ? { name, pattern: rest.join('|') } : { name, pattern: name }; }).filter((s) => s.pattern);
  const bu = cfgField('cfg-basic-user'); if (bu) c.basicAuth = { username: bu.value, password: (cfgField('cfg-basic-pass') || {}).value || '' };
  const fu = cfgField('cfg-form-url'); if (fu) { c.formAuth = { url: fu.value.trim(), userField: (cfgField('cfg-form-user-field') || {}).value || '', passField: (cfgField('cfg-form-pass-field') || {}).value || '', username: (cfgField('cfg-form-user') || {}).value || '' }; const fp = cfgField('cfg-form-pass'); if (fp && fp.value) state.pendingFormPassword = fp.value; }
  configDraft = c;
  return c;
}
async function saveConfigFromDialog() {
  const config = readConfigPage();
  const psi = cfgField('cfg-psi-key');
  const payload = { config };
  if (psi && psi.value) payload.apiKeys = { pagespeed: psi.value };
  if (state.pendingFormPassword) { payload.apiKeys = { ...(payload.apiKeys || {}), formPassword: state.pendingFormPassword }; state.hasFormPassword = true; state.pendingFormPassword = null; }
  await window.spider.configSave(payload);
  state.config = config; configDraft = null;
  if (psi && psi.value) state.hasPsiKey = true;
  $('#config-dialog').close();
  setProgress('Configuration saved.');
}
function openConfig(section) {
  configDraft = { ...(state.config || {}) };
  if (section) cfgSection = section;
  renderConfigSections(); renderConfigPage();
  $('#config-dialog').showModal();
}

/* ---------- crawl control ---------- */
function setProgress(text, pct) {
  if (text !== undefined) state.progressText = text;
  if (pct !== undefined && pct !== null) {
    $('#progress-fill').style.width = Math.min(100, Math.round(pct)) + '%';
    $('#progress-label').textContent = `Crawl ${Math.min(100, Math.round(pct))}%`;
  }
}
function setModeStatus() { const m = { spider: 'Spider', list: 'List', serp: 'SERP', compare: 'Compare' }[state.mode] || 'Spider'; $('#mode-status').textContent = `${m} Mode: ${state.crawling ? (state.paused ? 'Paused' : 'Active') : 'Idle'}`; }
function setCountsLine() {
  const el = $('#crawl-counts');
  if (state.crawling) {
    const d = state.discovered || 0; const c = state.livePages.length;
    const pct = d ? Math.round((c / d) * 100) : 0;
    el.textContent = `${state.paused ? 'Paused' : 'Crawling'} ${c} of ${d} (${pct}%) ${Math.max(0, d - c)} Remaining`;
  } else if (state.crawl) {
    const t = state.crawl.stats.total;
    el.textContent = state.crawl.mode === 'serp' ? `SERP Mode: ${t} rows analysed` : `Completed ${t} of ${t} (100%) 0 Remaining`;
  } else el.textContent = '';
  el.classList.toggle('done', !!state.crawl && !state.crawling);
  setRateLine();
}
/* "Average: N URL/s. Current: N URL/s." like the SF status bar; current is
 * measured over the last 5 seconds of crawled pages. */
function setRateLine() {
  const el = $('#crawl-rate'); const r = state.rate;
  if (!r.started) { el.textContent = ''; return; }
  const now = state.crawling ? Date.now() : (r.ended || Date.now());
  const n = state.crawling ? state.livePages.length : (state.crawl ? state.crawl.stats.crawled || state.crawl.stats.total : 0);
  const avg = n / Math.max(0.5, (now - r.started) / 1000);
  const recent = r.samples.filter((t) => t >= now - 5000).length / 5;
  el.textContent = `Average: ${avg.toFixed(2)} URL/s. Current: ${(state.crawling ? recent : 0).toFixed(2)} URL/s.`;
}
function currentConfig() {
  const c = { ...(state.config || {}), mode: state.mode === 'compare' ? 'spider' : state.mode, scope: $('#scope-select').value };
  return c;
}
async function startCrawl(urlOverride) {
  const config = currentConfig();
  if (config.mode === 'serp') { $('#serp-dialog').showModal(); return; }
  if (config.mode === 'list') { $('#list-title').textContent = 'List Mode - URLs to Crawl'; $('#list-dialog').showModal(); return; }
  const url = urlOverride || $('#url-input').value.trim();
  if (!url) { setProgress('Enter a URL to spider.'); return; }
  await runCrawl({ url, config });
}
async function runCrawl({ url, listText, config }) {
  state.crawling = true; state.paused = false; state.livePages = []; state.discovered = 0;
  state.rate = { started: Date.now(), samples: [], ended: 0 };
  state.crawl = null; state.selected = null; state.sideFilter = null; state.selectedIssue = null;
  $('#btn-start').textContent = 'Pause'; $('#btn-clear').classList.add('hidden');
  setProgress(null, 0); setModeStatus(); setCountsLine(); renderAll();
  try {
    const crawl = await window.spider.crawlStart({ url, listText, config });
    state.crawl = crawl;
    if (crawl.filterMeta) state.filterMeta = crawl.filterMeta;
    setProgress(null, 100);
    const u = crawl.rootUrl;
    if (u && !state.recentUrls.includes(u)) { state.recentUrls = [u, ...state.recentUrls].slice(0, 12); }
  } catch (e) { setProgress('Crawl failed: ' + e.message); }
  state.crawling = false; state.rate.ended = Date.now();
  if (state.crawl && state.crawl.login && state.crawl.login.error) setProgress('Web Form login failed: ' + state.crawl.login.error);
  $('#btn-start').textContent = 'Start'; $('#btn-clear').classList.remove('hidden');
  setModeStatus(); setCountsLine(); renderAll();
}
function renderAll() { renderTabs(); renderToolbar(); renderGrid(); renderSidebar(); renderBottom(); setCountsLine(); }

/* ---------- scheduling dialog ---------- */
async function openScheduling() {
  state.schedules = await window.spider.scheduleList();
  renderSchedules();
  $('#schedule-dialog').showModal();
}
function renderSchedules() {
  const el = $('#schedule-list');
  el.innerHTML = state.schedules.length ? state.schedules.map((s, i) => `<div class="tree-row"><span>${esc(s.url)} - ${esc(s.time)} (${esc(s.repeat)}) -&gt; ${esc(s.folder)}</span><span>${esc(s.lastRunNote || 'Never run')}</span><button data-delsch="${i}">Delete</button></div>`).join('') : 'No schedules yet.';
  el.querySelectorAll('[data-delsch]').forEach((b) => b.addEventListener('click', async () => { state.schedules.splice(Number(b.dataset.delsch), 1); await window.spider.scheduleSave(state.schedules); renderSchedules(); }));
}

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  renderTabs(); renderAll();
  const got = await window.spider.configGet();
  state.config = got.config; state.uaPresets = got.uaPresets || {};
  state.filterMeta = got.filterMeta || [];
  state.hasPsiKey = !!got.hasPagespeedKey; state.hasFormPassword = !!got.hasFormPassword; state.a11yDefs = got.a11yDefs || [];
  state.recentUrls = got.recentUrls || [];
  state.schedules = got.schedules || [];
  if (state.config.scope) $('#scope-select').value = state.config.scope;
  renderAll();

  $('#btn-start').addEventListener('click', async () => {
    if (state.crawling) {
      if (state.paused) { await window.spider.crawlResume(); state.paused = false; $('#btn-start').textContent = 'Pause'; }
      else { await window.spider.crawlPause(); state.paused = true; $('#btn-start').textContent = 'Resume'; }
      setModeStatus(); return;
    }
    startCrawl();
  });
  $('#url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') startCrawl(); });
  $('#url-input').addEventListener('focus', () => {
    const h = $('#url-history');
    if (!state.recentUrls.length) return;
    h.innerHTML = state.recentUrls.map((u) => `<div class="hist-item" data-url="${esc(u)}">${esc(u)}</div>`).join('') + '<div class="hist-item clear-all">&lt;Clear All&gt;</div>';
    h.classList.remove('hidden');
    h.querySelectorAll('.hist-item').forEach((item) => item.addEventListener('mousedown', () => {
      if (item.classList.contains('clear-all')) { state.recentUrls = []; h.classList.add('hidden'); return; }
      $('#url-input').value = item.dataset.url; h.classList.add('hidden');
    }));
  });
  $('#url-input').addEventListener('blur', () => setTimeout(() => $('#url-history').classList.add('hidden'), 150));
  $('#url-clear').addEventListener('click', () => { $('#url-input').value = ''; $('#url-input').focus(); });
  $('#scope-select').addEventListener('change', async () => { state.config = { ...(state.config || {}), scope: $('#scope-select').value }; await window.spider.configSave({ config: state.config }); });
  $('#btn-clear').addEventListener('click', async () => {
    await window.spider.crawlStop();
    state.crawl = null; state.livePages = []; state.selected = null; state.compare = null;
    setProgress(null, 0); $('#progress-label').textContent = 'Crawl 0%';
    $('#btn-clear').classList.add('hidden'); setCountsLine(); renderAll();
  });
  $('#filter-select').addEventListener('change', (e) => { state.filterId = e.target.value; state.issueName = null; renderGrid(); });
  $('#table-search').addEventListener('input', (e) => { state.search = e.target.value; renderGrid(); });
  $('#view-grid').addEventListener('click', () => { state.view = 'grid'; renderToolbar(); renderGrid(); });
  $('#view-tree').addEventListener('click', () => { state.view = 'tree'; renderToolbar(); renderGrid(); });
  $('#btn-export').addEventListener('click', exportCurrentTab);
  $('#btn-columns').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('#columns-popup'); const t = currentTab();
    const cols = typeof t.columns === 'function' ? (state.crawl ? t.columns(state.crawl) : []) : t.columns;
    const hidden = state.hiddenCols[t.id] || [];
    pop.innerHTML = '<b>Columns</b>' + (cols || []).map((c) => `<label class="chk"><input type="checkbox" data-colchk="${c.key}" ${hidden.includes(c.key) ? '' : 'checked'}> ${esc(c.label)}</label>`).join('');
    pop.classList.toggle('hidden');
    pop.querySelectorAll('[data-colchk]').forEach((cb) => cb.addEventListener('change', () => {
      const h = new Set(state.hiddenCols[t.id] || []);
      if (cb.checked) h.delete(cb.dataset.colchk); else h.add(cb.dataset.colchk);
      state.hiddenCols[t.id] = [...h]; lsSet('hiddenCols', state.hiddenCols); renderGrid();
    }));
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#columns-popup') && !e.target.closest('#btn-columns')) $('#columns-popup').classList.add('hidden'); if (!e.target.closest('#tabs-popup') && !e.target.closest('#tabs-overflow')) $('#tabs-popup').classList.add('hidden'); });
  $('#tabs-reset').addEventListener('click', () => { state.visibleTabs = [...DEFAULT_TAB_ORDER]; lsSet('visibleTabs', state.visibleTabs); renderTabsPopup(); renderAll(); });
  document.querySelectorAll('#bottom-tabs button').forEach((b) => b.addEventListener('click', () => { state.btab = b.dataset.btab; state.bottomSearch = ''; renderBottom(); }));
  document.querySelectorAll('#side-tabs button').forEach((b) => b.addEventListener('click', () => { state.stab = b.dataset.stab; renderSidebar(); if (!['overview', 'issues'].includes(state.stab)) setChart(state.stab === 'responsetimes' ? 'Response Times' : '', '<div class="chart-placeholder"><svg viewBox="0 0 60 60" width="52" height="52"><circle cx="30" cy="30" r="22" fill="none" stroke="#39424d" stroke-width="7"/><path d="M30 8a22 22 0 0 1 19 12" fill="none" stroke="#00C852" stroke-width="7"/></svg><p>Click on an SEO Element to display a graph.</p></div>'); }));

  /* config dialog */
  $('#cfg-cancel').addEventListener('click', () => { configDraft = null; $('#config-dialog').close(); });
  $('#cfg-save').addEventListener('click', saveConfigFromDialog);

  /* list dialog */
  $('#list-cancel').addEventListener('click', () => $('#list-dialog').close());
  $('#list-go').addEventListener('click', () => { const listText = $('#list-urls').value; $('#list-dialog').close(); runCrawl({ listText, config: currentConfig() }); });

  /* SERP mode dialog */
  $('#serp-cancel').addEventListener('click', () => $('#serp-dialog').close());
  $('#serp-file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { $('#serp-input').value = String(rd.result || ''); }; rd.readAsText(f); });
  $('#serp-go').addEventListener('click', async () => {
    try {
      const crawl = await window.spider.serpAnalyse($('#serp-input').value);
      $('#serp-dialog').close();
      state.crawl = crawl; state.livePages = []; state.selected = null; state.rate = { started: 0, samples: [] };
      if (crawl.filterMeta) state.filterMeta = crawl.filterMeta;
      state.tab = 'titles'; state.filterId = 'all'; state.btab = 'serp'; focusSidebarOnTab('titles');
      setProgress('SERP mode: ' + crawl.pages.length + ' rows analysed', 100); $('#btn-clear').classList.remove('hidden'); renderAll(); scrollSidebarToSection();
    } catch (e) { alert(e.message); }
  });

  /* Response Codes: Internal & External dropdown */
  $('#scope-filter').addEventListener('change', (e) => { state.scopeFilter = e.target.value; renderGrid(); });

  /* sitemap dialog */
  let sitemapKind = 'xml';
  $('#sm-cancel').addEventListener('click', () => $('#sitemap-dialog').close());
  $('#sm-go').addEventListener('click', async () => { const opts = { priority: $('#sm-priority').value || '0.5', changefreq: $('#sm-changefreq').value, lastmod: $('#sm-lastmod').value || new Date().toISOString().slice(0, 10) }; $('#sitemap-dialog').close(); const r = await window.spider.sitemapGenerate(sitemapKind, opts); if (r && r.saved) setProgress('Sitemap saved to ' + r.path); });

  /* scheduling */
  $('#sch-pick').addEventListener('click', async () => { const f = await window.spider.pickFolder(); if (f) $('#sch-folder').value = f; });
  $('#sch-add').addEventListener('click', async () => {
    const url = $('#sch-url').value.trim(); const folder = $('#sch-folder').value.trim();
    if (!url || !folder) { alert('Enter a start URL and an export folder.'); return; }
    state.schedules.push({ id: 'sch' + Date.now(), url, time: $('#sch-time').value || '09:00', repeat: $('#sch-repeat').value, weekday: 1, folder, lastRunAt: null, lastRunNote: '' });
    await window.spider.scheduleSave(state.schedules); renderSchedules();
  });
  $('#sch-close').addEventListener('click', () => $('#schedule-dialog').close());
  $('#about-close').addEventListener('click', () => $('#about-dialog').close());

  window.spider.onProgress((p) => {
    state.discovered = p.discovered || state.discovered;
    const total = Math.max(1, p.discovered || 1);
    setProgress(null, state.crawl ? 100 : (p.crawled / total) * 100);
    setCountsLine();
  });
  window.spider.onPage((page) => {
    if (!state.crawling) return;
    state.livePages.push(page); state.rate.samples.push(Date.now()); if (state.rate.samples.length > 400) state.rate.samples.splice(0, 200);
    if (state.livePages.length % 3 === 0 || state.livePages.length < 10) { renderGrid(); }
    setCountsLine();
  });
  window.spider.onMenu(async (action, arg) => {
    try {
      if (action === 'open') { const data = await window.spider.crawlOpen(); if (data) { state.crawl = data; if (data.filterMeta) state.filterMeta = data.filterMeta; state.selected = null; setProgress(null, 100); renderAll(); } }
      else if (action === 'open-path') { const data = await window.spider.crawlOpenPath(arg); if (data) { state.crawl = data; if (data.filterMeta) state.filterMeta = data.filterMeta; state.selected = null; setProgress(null, 100); renderAll(); } }
      else if (action === 'save') { const r = await window.spider.crawlSave(false); if (r && r.saved) setProgress('Crawl saved'); }
      else if (action === 'save-as') { const r = await window.spider.crawlSave(true); if (r && r.saved) setProgress('Crawl saved'); }
      else if (action === 'crawl-url') { $('#url-input').value = arg; startCrawl(arg); }
      else if (action === 'scheduling') openScheduling();
      else if (action === 'export') exportCurrentTab();
      else if (action === 'reset-columns') { state.hiddenCols = {}; lsSet('hiddenCols', {}); renderGrid(); }
      else if (action === 'reset-tabs') { state.visibleTabs = [...DEFAULT_TAB_ORDER]; lsSet('visibleTabs', state.visibleTabs); renderAll(); }
      else if (action === 'focus-mode') { state.focusMode = !state.focusMode; document.body.classList.toggle('focus', state.focusMode); }
      else if (action === 'mode') {
        state.mode = arg;
        if (arg === 'compare') { state.tab = 'compare'; renderAll(); doCompare(); }
        else if (arg === 'serp') $('#serp-dialog').showModal();
        else if (arg === 'list') { $('#list-title').textContent = 'List Mode - URLs to Crawl'; $('#list-dialog').showModal(); }
        setModeStatus();
      }
      else if (action === 'config') openConfig(arg);
      else if (action === 'profile-load') { const r = await window.spider.profileLoad(); if (r) { state.config = r.config; setProgress('Profile loaded: ' + r.path); } }
      else if (action === 'profile-load-path') { const r = await window.spider.profileLoad(arg); if (r) { state.config = r.config; setProgress('Profile loaded: ' + r.path); } }
      else if (action === 'profile-save') { const r = await window.spider.profileSave(state.config || {}); if (r && r.saved) setProgress('Profile saved'); }
      else if (action === 'profile-set-default') { await window.spider.profileSetDefault(state.config || {}); setProgress('Current configuration saved as default.'); }
      else if (action === 'profile-clear-default') { await window.spider.profileClearDefault(); setProgress('Default configuration cleared.'); }
      else if (action.startsWith('bulk-')) bulkExport(action, arg);
      else if (action === 'report') { const r = await window.spider.reportGenerate(arg); if (r && r.saved) setProgress('Report saved to ' + r.path); }
      else if (action === 'sitemap-config') { sitemapKind = arg; $('#sitemap-dialog').showModal(); }
      else if (action === 'visualisation') { await window.spider.visOpen(arg); }
      else if (action === 'analyse') { setProgress('Analysing crawl (Link Score, orphans, near-duplicates)...'); state.crawl = await window.spider.crawlAnalyse(); setProgress('Crawl analysis complete.'); renderAll(); }
      else if (action === 'about') { const info = await window.spider.appInfo(); $('#about-body').textContent = `Seonfix Spider v${info.version} - Electron ${info.electron} - ${info.platform}`; $('#about-dialog').showModal(); }
    } catch (e) { setProgress('Failed: ' + e.message); }
  });
});
