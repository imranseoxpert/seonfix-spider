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
  bottomSearch: '', focusMode: false,
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
  else if (t.psiTab) rows = state.psi;
  else if (!t.rows) rows = [];
  else rows = t.rows(cr);
  if (state.filterId && state.filterId !== 'all') rows = rows.filter((r) => (r.filters || []).includes(state.filterId));
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
  document.querySelectorAll('#tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.filterId = 'all'; state.issueName = null; renderAll(); }));
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
  $('#view-grid').classList.toggle('active', state.view === 'grid');
  $('#view-tree').classList.toggle('active', state.view === 'tree');
  const note = $('#tab-note');
  if (t.note && (!state.crawl || t.psiTab || !(t.rows && t.rows(state.crawl).length))) { note.textContent = t.note; note.classList.remove('hidden'); }
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
function renderBottom() {
  const p = state.selected; const body = $('#bottom-body');
  document.querySelectorAll('#bottom-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.btab === state.btab));
  if (!p) { body.innerHTML = state.btab === 'images' ? 'No URL selected' : 'No URL selected'; return; }
  const pages = state.crawl ? state.crawl.pages : state.livePages;
  const byAddr = new Map(pages.map((x) => [x.address, x]));
  if (state.btab === 'details') {
    const kv = [['Address', p.address], ['Content Type', p.contentType || p.contentCategory], ['Status Code', p.statusCode], ['Status', p.status], ['Indexability', (p.indexability || '') + (p.indexabilityReason ? ' - ' + p.indexabilityReason : '')], ['Title 1', p.title], ['Title Length / Pixels', `${p.titleLength ?? ''} / ${p.titlePixelWidth ?? ''}`], ['Meta Description 1', p.metaDescription], ['H1-1', (p.h1s || [])[0] || ''], ['H2-1', (p.h2s || [])[0] || ''], ['Canonical 1', p.canonical], ['Meta Robots 1', p.metaRobots], ['X-Robots-Tag', p.xRobotsTag], ['Word Count', p.wordCount], ['Sentence Count', p.sentenceCount], ['Readability', p.readability ? `${p.readability} (${p.flesch ?? ''})` : ''], ['Crawl Depth', p.depth], ['Link Score', p.linkScore], ['Inlinks / Unique', `${p.inlinks ?? ''} / ${p.uniqueInlinks ?? ''}`], ['Outlinks / Internal / External', `${p.outlinks ?? ''} / ${p.internalOutlinks ?? ''} / ${p.externalOutlinks ?? ''}`], ['Response Time (s)', typeof p.responseTimeMs === 'number' ? Math.round(p.responseTimeMs) / 1000 : ''], ['Size (bytes)', p.sizeBytes], ['Redirect URL', p.redirectUrl], ['In Sitemap', p.inSitemap ? 'Yes' : 'No'], ['Content Hash (MD5)', p.hash], ['Near Duplicate Of', p.nearDuplicateOf || ''], ['Spelling Errors', p.spellingErrors ?? 0], ['Issues', (p.issues || []).join('; ')]];
    body.innerHTML = '<div class="bt-toolbar"><button data-bexport>Export</button></div><table class="kv">' + kv.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v ?? '')}</td></tr>`).join('') + '</table>';
  } else if (state.btab === 'inlinks') {
    const rows = [];
    for (const q of pages) for (const l of q.links || []) if (l.url === p.address) rows.push({ from: q.address, type: q.contentCategory === 'HTML' ? 'Hyperlink' : (q.contentCategory || 'Hyperlink'), anchor: l.anchor, alt: '', follow: l.follow });
    body.innerHTML = `<div class="bt-toolbar"><select><option>All Link Types</option></select><select><option>All Link Origin Types</option></select><button data-bexport>Export</button><input type="text" placeholder="Search..." data-bsearch value="${esc(state.bottomSearch)}"></div>` +
      (rows.length ? '<table><tr><th>Type</th><th>From</th><th>Anchor Text</th><th>Alt Text</th><th>Follow</th><th>To</th></tr>' + rows.filter((r) => !state.bottomSearch || JSON.stringify(r).toLowerCase().includes(state.bottomSearch.toLowerCase())).map((r) => `<tr><td>${esc(r.type)}</td><td>${esc(r.from)}</td><td>${esc(r.anchor)}</td><td>${esc(r.alt)}</td><td>${r.follow ? 'Follow' : 'Nofollow'}</td><td>${esc(p.address)}</td></tr>`).join('') + '</table>' : 'No inlinks in this crawl.');
  } else if (state.btab === 'outlinks') {
    body.innerHTML = `<div class="bt-toolbar"><button data-bexport>Export</button><input type="text" placeholder="Search..." data-bsearch value="${esc(state.bottomSearch)}"></div>` +
      ((p.links || []).length ? '<table><tr><th>From</th><th>To</th><th>Anchor Text</th><th>Follow</th></tr>' + p.links.filter((l) => !state.bottomSearch || JSON.stringify(l).toLowerCase().includes(state.bottomSearch.toLowerCase())).map((l) => `<tr><td>${esc(p.address)}</td><td>${esc(l.url)}</td><td>${esc(l.anchor)}</td><td>${l.follow ? 'Follow' : 'Nofollow'}</td></tr>`).join('') + '</table>' : 'No outlinks recorded.');
  } else if (state.btab === 'images') {
    const imgs = p.images || [];
    const sel = state.selectedImage;
    const preview = sel ? `<img src="${esc(sel.address)}" style="max-width:${(state.zoom || 50) * 4}px;max-height:220px">` : '<div class="img-placeholder"><svg viewBox="0 0 60 45" width="60" height="45"><rect x="2" y="2" width="56" height="41" fill="none" stroke="#39424d" stroke-width="2"/><circle cx="18" cy="15" r="5" fill="#39424d"/><path d="M4 40 L22 24 L34 34 L44 26 L56 38 L56 43 L4 43 Z" fill="#39424d"/></svg><p>No Image selected</p></div>';
    body.innerHTML = `<div class="images-split"><div class="images-left">` +
      (imgs.length ? '<table><tr><th>From</th><th>To</th></tr>' + imgs.map((im, i) => `<tr data-imgrow="${i}"><td>${esc(p.address)}</td><td>${esc(im.url)}</td></tr>`).join('') + '</table>' : 'No Image Info found') +
      `</div><div class="images-right"><div class="bt-toolbar"><button data-bexport>Export</button><input type="text" placeholder="Search..."><label>Zoom: <select id="zoom-sel"><option ${state.zoom === 25 ? 'selected' : ''}>25%</option><option ${!state.zoom || state.zoom === 50 ? 'selected' : ''}>50%</option><option ${state.zoom === 100 ? 'selected' : ''}>100%</option><option ${state.zoom === 200 ? 'selected' : ''}>200%</option></select></label></div>${preview}</div></div>`;
    document.querySelectorAll('[data-imgrow]').forEach((tr) => tr.addEventListener('click', () => { const im = imgs[Number(tr.dataset.imgrow)]; state.selectedImage = { address: im.url, _img: im }; renderBottom(); }));
    const zs = $('#zoom-sel'); if (zs) zs.addEventListener('change', () => { state.zoom = Number(zs.value.replace('%', '')); renderBottom(); });
  } else if (state.btab === 'resources') {
    body.innerHTML = (p.resources || []).length ? '<table><tr><th>Resource URL</th><th>Type</th></tr>' + p.resources.map((r) => `<tr><td>${esc(r.url)}</td><td>${esc(r.type)}</td></tr>`).join('') + '</table>' : 'No resources collected for this page.';
  } else if (state.btab === 'headers') {
    const h = Object.entries(p.headers || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
    const ck = (p.cookies || []).map((c) => `<tr><td>set-cookie</td><td>${esc(c)}</td></tr>`).join('');
    body.innerHTML = '<table class="kv">' + h + ck + '</table>' + ((p.redirectChain || []).length ? '<p>Redirect chain: ' + p.redirectChain.map((x) => `${esc(x.from)} -[${x.status}]-&gt; `).join('') + esc(p.redirectUrl || '') + '</p>' : '');
  } else if (state.btab === 'rendered') {
    if (p.renderedTitle !== undefined || p.renderedCanonical !== undefined) {
      body.innerHTML = '<table class="kv">' + [['Raw Title', p.rawTitle || p.title || ''], ['Rendered Title', p.renderedTitle || ''], ['Raw Canonical', p.canonical || ''], ['Rendered Canonical', p.renderedCanonical || ''], ['Raw Meta Description', p.metaDescription || ''], ['Rendered Meta Description', p.renderedMetaDescription || ''], ['Raw H1', (p.h1s || [])[0] || ''], ['Rendered H1', p.renderedH1 || ''], ['Blocked Resources', (p.blockedResources || []).join(', ')], ['JS Errors', (p.jsErrors || []).join('; ')]].map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') + '</table>';
    } else {
      body.innerHTML = '<p class="hint">JavaScript rendering is off for this crawl, so rendered fields come from the raw HTML only.</p><div class="rendered-text">' + esc((p.textExcerpt || '').slice(0, 1500)) + '</div>';
    }
  } else if (state.btab === 'serp') {
    body.innerHTML = serpSnippet(p);
  }
  const be = body.querySelector('[data-bexport]');
  if (be) be.addEventListener('click', () => window.spider.saveText({ defaultPath: 'url-details.txt', content: body.innerText }));
  const bs = body.querySelector('[data-bsearch]');
  if (bs) bs.addEventListener('input', () => { state.bottomSearch = bs.value; renderBottom(); const nbs = $('#bottom-body [data-bsearch]'); if (nbs) { nbs.focus(); nbs.setSelectionRange(nbs.value.length, nbs.value.length); } });
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
function barSvg(entries, width = 330) {
  const rows = entries.filter((e) => e.value > 0);
  if (!rows.length) return '<p class="chart-none">No data for graph.</p>';
  const max = Math.max(1, ...rows.map((e) => e.value));
  const labelW = 118, valW = 30, barW = width - labelW - valW, rowH = 17;
  const rects = rows.map((e, i) => {
    const w = Math.max(1, Math.round((e.value / max) * barW));
    const y = i * rowH;
    const label = e.label.length > 19 ? e.label.slice(0, 18) + '…' : e.label;
    return `<text x="0" y="${y + 11}">${esc(label)}</text><rect x="${labelW}" y="${y + 2}" width="${w}" height="11" fill="${CHART_COLORS[i % CHART_COLORS.length]}"><title>${esc(e.label)}: ${e.value}</title></rect><text x="${labelW + w + 5}" y="${y + 11}">${e.value}</text>`;
  }).join('');
  return `<svg width="${width}" height="${rows.length * rowH + 2}" viewBox="0 0 ${width} ${rows.length * rowH + 2}">${rects}</svg>`;
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
  const pct = (n) => Math.round((n / total) * 1000) / 10;
  let html = '<table class="side-table"><tr><th></th><th>URLs</th><th>% of Total</th></tr>';
  html += '<tr class="section-row"><td colspan="3">Summary</td></tr>';
  for (const row of (cr.analysis ? cr.analysis.summary : [])) html += `<tr><td>${esc(row.label)}</td><td>${row.count}</td><td>${pct(row.count)}%</td></tr>`;
  const sections = [...new Set(state.filterMeta.map((f) => f.section))];
  for (const section of sections) {
    const filters = sectionFilters(section);
    html += `<tr class="section-row"><td colspan="3"><span class="collapse-arrow">&#9660;</span> ${esc(section)}</td></tr>`;
    for (const f of filters) {
      const n = filterCount(f.id);
      html += `<tr class="filter-row ${state.sideFilter === f.id ? 'selected' : ''}" data-filter="${esc(f.id)}" data-section="${esc(section)}"><td>${esc(f.name)}</td><td>${n}</td><td>${pct(n)}%</td></tr>`;
    }
  }
  body.innerHTML = html + '</table>';
  body.querySelectorAll('.filter-row').forEach((tr) => tr.addEventListener('click', () => {
    const meta = state.filterMeta.find((f) => f.id === tr.dataset.filter);
    state.sideFilter = tr.dataset.filter; state.sideSection = tr.dataset.section;
    state.tab = meta ? meta.tab : 'internal'; state.filterId = tr.dataset.filter; state.issueName = null;
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
  setChart(section, hasData ? (useDonut ? donutSvg(entries.slice(0, 10)) : barSvg(entries.slice(0, 14))) : '<p class="chart-none">No data for graph.</p>');
}
function renderIssuesSide(body, cr) {
  if (!cr) { body.innerHTML = '<p class="hint">No crawl yet.</p>'; return; }
  const counts = { Issue: 0, Warning: 0, Opportunity: 0 };
  for (const i of cr.issues) counts[i.type] = (counts[i.type] || 0) + 1;
  const totalIssues = cr.issues.length;
  const chips = [['Issue', counts.Issue, 'Issues'], ['Warning', counts.Warning, 'Warnings'], ['Opportunity', counts.Opportunity, 'Opportunities'], ['Total', totalIssues, 'Total']];
  let list = cr.issues;
  if (state.issueChip !== 'Total') list = list.filter((i) => i.type === state.issueChip);
  const marker = { Issue: '#D64541', Warning: '#F5A623', Opportunity: '#7FB3D5' };
  const dot = { High: '#D64541', Medium: '#F5A623', Low: '#9AA0A6' };
  body.innerHTML = `<div class="bt-toolbar"><button id="issues-export">Export</button></div>
  <div class="chips">${chips.map(([key, n, label]) => `<button class="chip ${(state.issueChip === key || (key === 'Total' && state.issueChip === 'Total')) ? 'active' : ''}" data-chip="${key}">${label}: ${n}</button>`).join('')}</div>
  <table class="side-table"><tr><th>Issue Name</th><th>Issue Type</th><th>Issue Priority</th><th>URLs</th><th>% of Total</th></tr>
  ${list.map((i) => `<tr class="issue-trow ${state.selectedIssue === i.id ? 'selected' : ''}" data-issueid="${esc(i.id)}"><td><span class="marker" style="background:${marker[i.type]}"></span>${esc(i.name)}</td><td>${esc(i.type)}</td><td><span class="dot" style="background:${dot[i.priority]}"></span>${esc(i.priority)}</td><td>${i.count}</td><td>${i.pct}%</td></tr>`).join('') || '<tr><td colspan="5">No issues</td></tr>'}</table>
  <div class="issue-details"><div class="bt-toolbar"><button id="issue-copy">Copy</button><label>View: <select><option>Details</option></select></label></div>
  <div id="issue-detail-body">${state.selectedIssue ? esc((cr.issues.find((i) => i.id === state.selectedIssue) || {}).description || '') : 'No Issue Selected'}</div></div>`;
  body.querySelectorAll('[data-chip]').forEach((b) => b.addEventListener('click', () => { state.issueChip = b.dataset.chip; renderSidebar(); }));
  body.querySelectorAll('.issue-trow').forEach((tr) => {
    tr.addEventListener('click', () => { state.selectedIssue = tr.dataset.issueid; renderSidebar(); });
    tr.addEventListener('dblclick', () => {
      const iss = cr.issues.find((i) => i.id === tr.dataset.issueid);
      if (!iss) return;
      state.selectedIssue = iss.id;
      if (iss.filterId) { const meta = state.filterMeta.find((f) => f.id === iss.filterId); state.tab = meta ? meta.tab : 'internal'; state.filterId = iss.filterId; state.issueName = null; }
      else { state.tab = 'internal'; state.filterId = 'all'; state.issueName = iss.name; }
      renderAll();
    });
  });
  const ex = $('#issues-export'); if (ex) ex.addEventListener('click', exportIssues);
  const cp = $('#issue-copy'); if (cp) cp.addEventListener('click', () => { const iss = cr.issues.find((i) => i.id === state.selectedIssue); if (iss && navigator.clipboard) navigator.clipboard.writeText(`${iss.name} (${iss.type}/${iss.priority}) - ${iss.count} URLs (${iss.pct}%)\n${iss.description}`); });
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
    try { state.psi = await window.spider.psiFetch(urls); } catch (e) { $('#psi-results').textContent = 'PageSpeed fetch failed: ' + e.message; }
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
  <tr><td>Grammar Errors</td><td>0</td></tr></table>
  <p class="hint">Basic dictionary check only; grammar checking requires a language tool and is not performed.</p>
  ${rows.length ? '<table class="side-table"><tr><th>URL</th><th>Errors</th></tr>' + rows.map((p) => `<tr><td>${esc(p.address)}</td><td>${p.spellingErrors}</td></tr>`).join('') + '</table>' : ''}`;
}

/* ---------- compare panel ---------- */
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
  const cols = [{ label: 'Issue Name', get: (i) => i.name }, { label: 'Issue Type', get: (i) => i.type }, { label: 'Issue Priority', get: (i) => i.priority }, { label: 'URLs', get: (i) => i.count }, { label: '% of Total', get: (i) => i.pct }, { label: 'Description', get: (i) => i.description }];
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
  { id: 'api-ga', label: 'API Access > Google Analytics' }, { id: 'api-gsc', label: 'API Access > Search Console' }, { id: 'api-psi', label: 'API Access > PageSpeed' },
  { id: 'api-backlinks', label: 'API Access > Backlink APIs' }, { id: 'api-ai', label: 'API Access > AI' },
  { id: 'auth-basic', label: 'Authentication > Basic' }, { id: 'auth-form', label: 'Authentication > Web Form' },
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
    'crawl': () => n('cfg-concurrency', 'Threads / Concurrency', c.concurrency) + n('cfg-depth', 'Max Crawl Depth (0 = unlimited)', c.maxDepth) + n('cfg-maxurls', 'Max URLs', c.maxUrls) + chk('cfg-external', 'Status-check External URLs (fetched once, never followed)', c.crawlExternal !== false) + chk('cfg-resources', 'Crawl Resources (CSS / JS / Images as rows)', c.crawlResources !== false) + chk('cfg-imagesizes', 'Check Image Sizes', c.checkImageSizes !== false) + `<label>Default Scope <select id="cfg-scope"><option value="subdomain">Subdomain</option><option value="subfolder">Subfolder</option><option value="all-subdomains">All Subdomains</option><option value="exact">Exact URL</option></select></label>`,
    'extraction-note': () => '<p class="hint">Custom extraction rules are defined under Custom &gt; Custom Extraction; content extraction for titles, meta, headings, links, images and structured data always runs.</p>',
    'limits': () => n('cfg-timeout', 'Request Timeout (ms)', c.timeoutMs) + n('cfg-maxredirects', 'Max Redirects', c.maxRedirects),
    'rendering': () => `<label>Rendering <select id="cfg-rendering"><option value="text">Text Only (raw HTML)</option><option value="rendered">JavaScript Rendering (rendered HTML comparison)</option></select></label><p class="hint">Rendered mode loads up to 200 HTML pages in a hidden Chromium window after the crawl and records rendered-vs-raw differences for the JavaScript tab.</p>`,
    'advanced': () => ta('cfg-headers-x', 'Custom Headers (one per line, Name: Value)', Object.entries(c.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'), 3) + t('cfg-cookies', 'Cookies', c.cookies, 'name=value; name2=value2'),
    'preferences': () => chk('cfg-spell', 'Enable basic spell check', c.spellCheck !== false) + '<p class="hint">Preferences are stored with the configuration.</p>',
    'contentarea': () => n('cfg-contentarea', 'Content Area % (stored; word counts use full body text)', c.contentAreaPct ?? 100),
    'duplicates': () => `<label>Near-Duplicate Similarity Threshold (0-1) <input type="text" id="cfg-dupthreshold" value="${esc(c.duplicatesThreshold ?? 0.92)}"></label>`,
    'spelling': () => chk('cfg-spell2', 'Enable Spell Check', c.spellCheck !== false) + '<p class="hint">Grammar checking is not performed (grammar counts stay 0); a language tool integration is required for grammar.</p>',
    'robots': () => chk('cfg-robots', 'Respect robots.txt', c.respectRobots !== false) + ta('cfg-customrobots', 'Custom robots.txt (overrides the live file when filled)', c.customRobotsText, 6),
    'rewriting': () => ta('cfg-rewrites', 'URL Rewrite Rules (one per line: pattern => replacement, regex)', linesOf((c.urlRewrites || []).map((r) => `${r.pattern} => ${r.replacement}`)), 4),
    'cdns': () => ta('cfg-cdns', 'CDN Host Patterns Treated as Internal (one regex per line)', linesOf(c.cdnPatterns), 3),
    'include': () => ta('cfg-include', 'Include Regex (one per line)', linesOf(c.includePatterns), 4),
    'exclude': () => ta('cfg-exclude', 'Exclude Regex (one per line)', linesOf(c.excludePatterns), 4),
    'speed': () => n('cfg-delay', 'Crawl Delay Between Requests (ms)', c.delayMs) + n('cfg-concurrency2', 'Threads / Concurrency', c.concurrency),
    'useragent': () => `<label>User-Agent Preset <select id="cfg-uapreset"><option value="spider">Seonfix Spider</option><option value="chrome">Chrome (Desktop)</option><option value="googlebot">Googlebot</option><option value="googlebot-smartphone">Googlebot Smartphone</option><option value="bingbot">Bingbot</option><option value="custom">Custom</option></select></label>` + t('cfg-uacustom', 'Custom User-Agent', c.userAgentPreset ? '' : (c.userAgent || '')),
    'httpheader': () => '<p class="hint">Custom headers and cookies are edited under Spider &gt; Advanced.</p>',
    'customsearch': () => '<p class="hint">One per line: Name | contains / notcontains | text or code to find.</p>' + ta('cfg-search', 'Custom Search Rules', linesOf((c.searchRules || []).map((e) => `${e.name} | ${e.mode} | ${e.needle}`)), 4),
    'customextraction': () => '<p class="hint">One per line: Name | css / regex / xpath | selector or pattern. XPath covers a basic subset such as //tag and //tag[@attr=\'value\'].</p>' + ta('cfg-extractors', 'Custom Extraction Rules', linesOf((c.extractors || []).map((e) => `${e.name} | ${e.type} | ${e.value}`)), 4),
    'customlinkpos': () => ta('cfg-linkpos', 'Custom Link Positions (notes stored with the configuration; the crawler records navigation/content/footer positions only when templates expose them)', c.customLinkPositionsNote || '', 3),
    'api-ga': () => t('cfg-ga-id', 'Google Analytics Property ID', c.gaPropertyId || '') + '<p class="hint">Stored with the configuration. Pulling GA data requires Google OAuth, which is not yet connected.</p>',
    'api-gsc': () => t('cfg-gsc-site', 'Search Console Site URL', c.gscSiteUrl || '') + '<p class="hint">Stored with the configuration. Pulling Search Console data requires Google OAuth, which is not yet connected.</p>',
    'api-psi': () => `<label>PageSpeed Insights API Key <input type="password" id="cfg-psi-key" placeholder="${state.hasPsiKey ? 'Saved (enter to replace)' : 'AIza...'}"></label><p class="hint">The key is stored encrypted on this computer and powers the API sidebar tab and the PageSpeed tab.</p>`,
    'api-backlinks': () => t('cfg-ahrefs-key', 'Ahrefs API Key', '') + t('cfg-moz-key', 'Moz API Key', '') + '<p class="hint">Backlink API connections are not yet implemented; keys entered here are not stored or sent anywhere.</p>',
    'api-ai': () => t('cfg-openai-key', 'OpenAI API Key', '') + '<p class="hint">AI provider connections are not yet implemented; keys entered here are not stored or sent anywhere.</p>',
    'auth-basic': () => t('cfg-basic-user', 'Basic Auth Username', (c.basicAuth || {}).username || '') + `<label>Basic Auth Password <input type="password" id="cfg-basic-pass" value="${esc((c.basicAuth || {}).password || '')}"></label><p class="hint">Sent as an Authorization: Basic header with every crawl request.</p>`,
    'auth-form': () => t('cfg-form-url', 'Web Form Login URL', ((c.formAuth || {}).url) || '') + t('cfg-form-user-field', 'Username Field Name', ((c.formAuth || {}).userField) || '') + t('cfg-form-user', 'Username', ((c.formAuth || {}).username) || '') + '<p class="hint">Stored with the configuration. Automated form login is not yet implemented; use Basic auth or cookies (Spider &gt; Advanced) for protected sites in this version.</p>',
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
  num('cfg-timeout', 'timeoutMs'); num('cfg-maxredirects', 'maxRedirects'); num('cfg-delay', 'delayMs'); num('cfg-contentarea', 'contentAreaPct');
  chkV('cfg-external', 'crawlExternal'); chkV('cfg-resources', 'crawlResources'); chkV('cfg-imagesizes', 'checkImageSizes');
  chkV('cfg-robots', 'respectRobots'); chkV('cfg-spell', 'spellCheck'); chkV('cfg-spell2', 'spellCheck');
  txt('cfg-scope', 'scope'); txt('cfg-rendering', 'rendering'); txt('cfg-customrobots', 'customRobotsText');
  txt('cfg-cookies', 'cookies'); txt('cfg-ga-id', 'gaPropertyId'); txt('cfg-gsc-site', 'gscSiteUrl'); txt('cfg-linkpos', 'customLinkPositionsNote');
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
  const fu = cfgField('cfg-form-url'); if (fu) c.formAuth = { url: fu.value, userField: (cfgField('cfg-form-user-field') || {}).value || '', username: (cfgField('cfg-form-user') || {}).value || '' };
  configDraft = c;
  return c;
}
async function saveConfigFromDialog() {
  const config = readConfigPage();
  const psi = cfgField('cfg-psi-key');
  const payload = { config };
  if (psi && psi.value) payload.apiKeys = { pagespeed: psi.value };
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
function setModeStatus() { $('#mode-status').textContent = `Spider Mode: ${state.crawling ? (state.paused ? 'Paused' : 'Active') : 'Idle'}`; }
function setCountsLine() {
  if (state.crawling) {
    const d = state.discovered || 0; const c = state.livePages.length;
    const pct = d ? Math.round((c / d) * 100) : 0;
    $('#crawl-counts').textContent = `${c} of ${d} (${pct}%) ${Math.max(0, d - c)} Remaining`;
  } else if (state.crawl) {
    const t = state.crawl.stats.total;
    $('#crawl-counts').textContent = `${t} of ${t} (100%) 0 Remaining`;
  } else $('#crawl-counts').textContent = '';
}
function currentConfig() {
  const c = { ...(state.config || {}), mode: state.mode === 'compare' ? 'spider' : state.mode, scope: $('#scope-select').value };
  return c;
}
async function startCrawl(urlOverride) {
  const config = currentConfig();
  if (config.mode === 'list' || config.mode === 'serp') { $('#list-title').textContent = config.mode === 'serp' ? 'SERP Mode - URLs to Crawl' : 'List Mode - URLs to Crawl'; $('#list-dialog').showModal(); return; }
  const url = urlOverride || $('#url-input').value.trim();
  if (!url) { setProgress('Enter a URL to spider.'); return; }
  await runCrawl({ url, config });
}
async function runCrawl({ url, listText, config }) {
  state.crawling = true; state.paused = false; state.livePages = []; state.discovered = 0;
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
  state.crawling = false;
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
  state.hasPsiKey = !!got.hasPagespeedKey;
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
  document.querySelectorAll('#side-tabs button').forEach((b) => b.addEventListener('click', () => { state.stab = b.dataset.stab; renderSidebar(); if (state.stab !== 'overview') setChart('', '<div class="chart-placeholder"><svg viewBox="0 0 60 60" width="52" height="52"><circle cx="30" cy="30" r="22" fill="none" stroke="#39424d" stroke-width="7"/><path d="M30 8a22 22 0 0 1 19 12" fill="none" stroke="#00C852" stroke-width="7"/></svg><p>Click on an SEO Element to display a graph.</p></div>'); }));

  /* config dialog */
  $('#cfg-cancel').addEventListener('click', () => { configDraft = null; $('#config-dialog').close(); });
  $('#cfg-save').addEventListener('click', saveConfigFromDialog);

  /* list dialog */
  $('#list-cancel').addEventListener('click', () => $('#list-dialog').close());
  $('#list-go').addEventListener('click', () => { const listText = $('#list-urls').value; $('#list-dialog').close(); runCrawl({ listText, config: currentConfig() }); });

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
    state.livePages.push(page);
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
        else if (arg === 'list' || arg === 'serp') { $('#list-title').textContent = arg === 'serp' ? 'SERP Mode - URLs to Crawl' : 'List Mode - URLs to Crawl'; $('#list-dialog').showModal(); }
      }
      else if (action === 'config') openConfig();
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
