'use strict';
/* Seonfix Spider v2 - Electron main process.
 * The crawl engine (crawler.js) is plain Node; this file wires it to IPC,
 * native menus/dialogs, persistence, profiles, scheduling, reports,
 * PageSpeed fetching, JS rendering and the visualisation window. */
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Crawler, DEFAULT_CONFIG, UA_PRESETS, generateSitemap, generateImageSitemap, compareCrawls, finalizeCrawl } = require('./crawler');
const { FILTER_META } = require('./filters');
const { ensureUrl, normalizeUrl } = require('./urlutil');
const { parsePage } = require('./extract');

const isMac = process.platform === 'darwin';
if (process.env.SPIDER_SMOKE) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'spider-profile-')));

let win = null;
let visWin = null;
let activeCrawler = null;
let currentCrawl = null;
let currentMode = 'spider';
let scheduleTimer = null;

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch (_) { return {}; } }
function saveSettings(s) { fs.mkdirSync(path.dirname(settingsPath()), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 1)); }

function csvEscape(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }
function toCsv(headers, rows) { return [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n'); }

const GENERIC_COLS = ['Address', 'Content Type', 'Status Code', 'Status', 'Indexability', 'Title 1', 'Word Count', 'Inlinks', 'Outlinks', 'Crawl Depth', 'Response Time (s)', 'Link Score'];
function genericRow(p) { return [p.address, p.contentType || p.contentCategory || '', p.statusCode ?? '', p.status || '', p.indexability || '', p.title || '', p.wordCount ?? '', p.inlinks ?? 0, p.outlinks ?? 0, p.depth ?? '', typeof p.responseTimeMs === 'number' ? Math.round(p.responseTimeMs) / 1000 : '', p.linkScore ?? '']; }
function pagesMatching(crawl, filterId) { return (crawl.pages || []).filter((p) => (p.filters || []).includes(filterId)); }

function redirectReportCsv(crawl) {
  const rows = [['Source URL', 'Status Code', 'Hop', 'From', 'To', 'Final URL', 'Loop']];
  for (const p of crawl.pages || []) (p.redirectChain || []).forEach((hop, i) => rows.push([p.address, p.statusCode, i + 1, hop.from, hop.to, p.redirectUrl || '', p.redirectLoop ? 'Yes' : 'No']));
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
}

function buildReport(kind, crawl) {
  const pages = crawl.pages || [];
  switch (kind) {
    case 'redirect-chains': return { filename: 'redirect-chains.csv', content: redirectReportCsv(crawl) };
    case 'redirects': return { filename: 'redirects.csv', content: toCsv(['Address', 'Status Code', 'Redirect URL', 'Redirect Type', 'Chain Length', 'Inlinks'], pages.filter((p) => p.statusCode >= 300 && p.statusCode < 400).map((p) => [p.address, p.statusCode, p.redirectUrl || '', p.redirectType || '', (p.redirectChain || []).length, p.inlinks ?? 0])) };
    case 'orphans': return { filename: 'orphan-pages.csv', content: toCsv(GENERIC_COLS, pages.filter((p) => p.isOrphan).map(genericRow)) };
    case 'serp-summary': return { filename: 'serp-summary.csv', content: toCsv(['Address', 'Title 1', 'Title 1 Length', 'Title 1 Pixel Width', 'Meta Description 1', 'Meta Description 1 Length', 'Meta Description 1 Pixel Width', 'Status Code', 'Indexability'], pages.filter((p) => p.contentCategory === 'HTML').map((p) => [p.address, p.title || '', p.titleLength ?? 0, p.titlePixelWidth ?? 0, p.metaDescription || '', p.metaDescriptionLength ?? 0, p.metaDescriptionPixelWidth ?? 0, p.statusCode ?? '', p.indexability || ''])) };
    case 'canonical-errors': return { filename: 'canonical-errors.csv', content: toCsv(['Address', 'Canonical', 'Problem'], pages.filter((p) => ['can-multiple', 'can-conflicting', 'can-nonindexable', 'can-relative', 'can-missing'].some((f) => (p.filters || []).includes(f))).map((p) => [p.address, p.canonical || '', ['can-multiple:Multiple', 'can-nonindexable:Non-Indexable Canonical', 'can-relative:Relative Canonical', 'can-missing:Missing'].filter((x) => (p.filters || []).includes(x.split(':')[0])).map((x) => x.split(':')[1]).join('; ')])) };
    case 'insecure-content': return { filename: 'insecure-content.csv', content: toCsv(GENERIC_COLS, pages.filter((p) => (p.filters || []).some((f) => f.startsWith('sec-'))).map(genericRow)) };
    case 'structured-data': return { filename: 'structured-data-summary.csv', content: toCsv(['Address', 'Types', 'Item Count', 'Warnings'], pages.filter((p) => (p.structuredData || []).length || (p.sdWarnings || []).length).map((p) => [p.address, (p.structuredData || []).join('; '), (p.sdItems || []).length, (p.sdWarnings || []).join('; ')])) };
    case 'http-headers': {
      const names = [...new Set(pages.flatMap((p) => Object.keys(p.headers || {})))].sort();
      return { filename: 'http-headers.csv', content: toCsv(['Address', 'Status Code', ...names], pages.filter((p) => p.headers).map((p) => [p.address, p.statusCode ?? '', ...names.map((n) => (p.headers || {})[n] || '')])) };
    }
    case 'cookies': {
      const rows = [];
      for (const p of pages) for (const c of p.cookies || []) rows.push([p.address, String(c).split(';')[0]]);
      return { filename: 'cookies.csv', content: toCsv(['Address', 'Set-Cookie'], rows) };
    }
    case 'overview': {
      const s = crawl.stats || {};
      const a = crawl.analysis || {};
      const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const issuesRows = (crawl.issues || []).map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.type)}</td><td>${esc(i.priority)}</td><td>${i.count}</td><td>${i.pct}%</td></tr>`).join('');
      const summaryRows = ((a.summary) || []).map((r) => `<tr><td>${esc(r.label)}</td><td>${r.count}</td></tr>`).join('');
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Crawl Overview - ${esc(crawl.rootUrl)}</title><style>body{font:14px/1.5 Arial,sans-serif;margin:32px;color:#222}h1{color:#00A344}table{border-collapse:collapse;margin:12px 0 28px}td,th{border:1px solid #ccc;padding:5px 10px;text-align:left}</style></head><body><h1>Seonfix Spider - Crawl Overview</h1><p>Root: ${esc(crawl.rootUrl)}<br>Started: ${esc(crawl.startedAt || '')}<br>Total URLs: ${s.total ?? ''} (Internal ${s.internal ?? ''} / External ${s.external ?? ''}) - Indexable: ${s.indexable ?? ''} - 4xx: ${s.errors4xx ?? ''} - 5xx: ${s.errors5xx ?? ''} - Redirects: ${s.redirects ?? ''}</p><h2>Summary</h2><table><tr><th>Measure</th><th>URLs</th></tr>${summaryRows}</table><h2>Issues (${(crawl.issues || []).length})</h2><table><tr><th>Issue</th><th>Type</th><th>Priority</th><th>URLs</th><th>% of Total</th></tr>${issuesRows}</table></body></html>`;
      return { filename: 'crawl-overview.html', content: html };
    }
    default: throw new Error('Unknown report: ' + kind);
  }
}

/* ------- API key storage (safeStorage-encrypted when available) ------- */
function storeApiKeys(settings, keys) {
  settings.apiKeysEnc = settings.apiKeysEnc || {};
  for (const [k, v] of Object.entries(keys || {})) {
    if (v === undefined) continue;
    if (!v) { delete settings.apiKeysEnc[k]; continue; }
    settings.apiKeysEnc[k] = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(String(v)).toString('base64') : 'plain:' + Buffer.from(String(v)).toString('base64');
  }
}
function readApiKey(settings, name) {
  const enc = (settings.apiKeysEnc || {})[name];
  if (!enc) return '';
  try {
    if (enc.startsWith('plain:')) return Buffer.from(enc.slice(6), 'base64').toString('utf8');
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch (_) { return ''; }
}

/* ------- JS rendering (extended for v2 JavaScript tab) ------- */
async function renderPage(url) {
  const { session } = require('electron');
  const partition = 'render-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const ses = session.fromPartition(partition);
  const blocked = [];
  ses.webRequest.onErrorOccurred((details) => { if (details.url && details.url !== url) blocked.push(details.url); });
  const w = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, session: ses } });
  const jsErrors = [];
  w.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) jsErrors.push(String(e.message).slice(0, 200)); });
  try {
    await w.loadURL(url, { userAgent: DEFAULT_CONFIG.userAgent });
    await new Promise((r) => setTimeout(r, 700));
    const html = await w.webContents.executeJavaScript('document.documentElement.outerHTML', true);
    return { html, blocked, jsErrors };
  } finally { try { w.destroy(); } catch (_) {} try { await ses.clearStorageData(); } catch (_) {} }
}

async function applyRendering(crawl, config) {
  const targets = crawl.pages.filter((p) => !p.external && !p.sitemapOnly && p.contentCategory === 'HTML' && (p.finalStatusCode === 200 || p.statusCode === 200)).slice(0, 200);
  for (const p of targets) {
    try {
      const { html, blocked, jsErrors } = await renderPage(p.address);
      const parsed = parsePage({ url: p.address, html, headers: p.headers || {}, statusCode: 200 });
      p.renderedTitle = parsed.title;
      p.renderedCanonical = parsed.canonical;
      p.renderedMetaDescription = parsed.metaDescription;
      p.renderedH1 = (parsed.h1s || [])[0] || '';
      p.renderedLinkCount = (parsed.links || []).length;
      p.blockedResources = blocked.slice(0, 50);
      p.jsErrors = jsErrors.slice(0, 10);
      p.renderDiffers = parsed.title !== (p.rawTitle || p.title || '') || (parsed.h1s || []).length !== (p.h1s || []).length || (parsed.links || []).length !== (p.links || []).length;
    } catch (e) { p.renderError = String(e && e.message || e); }
  }
  // re-finalise JS filters now rendered fields exist
  const fin = finalizeCrawl(crawl.pages, crawl.rootUrl, { ...DEFAULT_CONFIG, ...(config || {}) });
  crawl.issues = fin.issues; crawl.analysis = fin.analysis; crawl.stats = { ...crawl.stats, ...fin.stats, durationMs: crawl.stats.durationMs };
  return crawl;
}

/* ------- Scheduling (runs only while the app is open) ------- */
function scheduleDue(s, now) {
  const [hh, mm] = String(s.time || '09:00').split(':').map(Number);
  const due = new Date(now); due.setHours(hh || 0, mm || 0, 0, 0);
  if (now < due) return false;
  const last = s.lastRunAt ? new Date(s.lastRunAt) : null;
  if (s.repeat === 'weekly') {
    if (due.getDay() !== (s.weekday ?? 1)) return false;
    return !last || (now - last) > 6 * 24 * 3600 * 1000;
  }
  return !last || last.toDateString() !== now.toDateString();
}

async function runSchedule(s) {
  const start = ensureUrl(s.url || '');
  if (!start || activeCrawler) return;
  const settings = loadSettings();
  const config = { ...DEFAULT_CONFIG, ...(settings.config || {}), mode: 'spider' };
  const crawler = new Crawler(config, {});
  activeCrawler = crawler;
  try {
    const crawl = await crawler.crawl([start], start);
    currentCrawl = crawl;
    const dir = s.folder || app.getPath('documents');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const host = (() => { try { return new URL(start).host; } catch (_) { return 'site'; } })();
    fs.writeFileSync(path.join(dir, `${host}-internal-${stamp}.csv`), toCsv(GENERIC_COLS, crawl.pages.filter((p) => !p.external).map(genericRow)));
    fs.writeFileSync(path.join(dir, `${host}-issues-${stamp}.csv`), toCsv(['Issue', 'Type', 'Priority', 'URLs', '% of Total', 'Description'], crawl.issues.map((i) => [i.name, i.type, i.priority, i.count, i.pct, i.description])));
    s.lastRunAt = new Date().toISOString();
    s.lastRunNote = `Exported ${crawl.stats.total} URLs to ${dir}`;
    if (win && !win.isDestroyed()) win.webContents.send('crawl:progress', { crawled: crawl.stats.total, queued: 0, discovered: crawl.stats.total, currentUrl: 'Scheduled crawl finished: ' + s.url });
  } catch (e) { s.lastRunAt = new Date().toISOString(); s.lastRunNote = 'Failed: ' + (e && e.message || e); }
  finally {
    activeCrawler = null;
    const st = loadSettings();
    st.schedules = (st.schedules || []).map((x) => (x.id === s.id ? s : x));
    saveSettings(st);
  }
}

function startScheduleTimer() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(async () => {
    const st = loadSettings();
    for (const s of st.schedules || []) if (scheduleDue(s, new Date())) await runSchedule(s);
  }, 30000);
}

/* ------- Menus (per v2 spec) ------- */
function buildMenu() {
  const send = (action, arg) => () => { if (win) win.webContents.send('menu:action', action, arg); };
  const settings = loadSettings();
  const recentFiles = (settings.recentFiles || []).slice(0, 8);
  const recentCrawls = (settings.recent || []).slice(0, 8);
  const recentProfiles = (settings.recentProfiles || []).slice(0, 5);
  const modeItem = (label, mode) => ({ label, type: 'radio', checked: currentMode === mode, click: () => { currentMode = mode; buildMenu(); if (win) win.webContents.send('menu:action', 'mode', mode); } });
  const bulkSection = (label, section, tab) => ({ label, click: send('bulk-section', { section, tab }) });
  const template = [
    ...(isMac ? [{ label: 'Seonfix Spider', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
      { label: 'Open...', accelerator: 'CmdOrCtrl+O', click: send('open') },
      { label: 'Open Recent', submenu: recentFiles.length ? recentFiles.map((f) => ({ label: path.basename(f), click: send('open-path', f) })) : [{ label: 'No Recent Crawls', enabled: false }] },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
      { label: 'Save As...', click: send('save-as') },
      { label: 'Crawl Recent', submenu: recentCrawls.length ? recentCrawls.map((r) => ({ label: r.rootUrl, click: send('crawl-url', r.rootUrl) })) : [{ label: 'No Recent Crawls', enabled: false }] },
      { type: 'separator' },
      { label: 'Scheduling', click: send('scheduling') },
      { type: 'separator' },
      { label: 'Export Current Tab (CSV)', click: send('export') },
      isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { label: 'View', submenu: [
      { label: 'Reset Columns for All Tables', click: send('reset-columns') },
      { label: 'Reset Tabs', click: send('reset-tabs') },
      { label: 'Focus Mode', accelerator: 'CmdOrCtrl+Shift+F', click: send('focus-mode') },
    ] },
    { label: 'Mode', submenu: [modeItem('Spider', 'spider'), modeItem('List', 'list'), modeItem('SERP', 'serp'), modeItem('Compare', 'compare')] },
    { label: 'Configuration', submenu: [
      { label: 'Crawl Config', click: send('config') },
      { label: 'Profiles', submenu: [
        { label: 'Load...', click: send('profile-load') },
        { label: 'Load Recent', submenu: recentProfiles.length ? recentProfiles.map((f) => ({ label: path.basename(f), click: send('profile-load-path', f) })) : [{ label: 'No Recent Profiles', enabled: false }] },
        { label: 'Save As...', click: send('profile-save') },
        { label: 'Save Current Configuration as Default', click: send('profile-set-default') },
        { label: 'Clear Default Configuration', click: send('profile-clear-default') },
      ] },
    ] },
    { label: 'Bulk Export', submenu: [
      { label: 'Queued URLs', click: send('bulk-queued') },
      { label: 'Links', submenu: [
        { label: 'All Inlinks', click: send('bulk-links', 'inlinks') },
        { label: 'All Outlinks', click: send('bulk-links', 'outlinks') },
        { label: 'Internal Inlinks', click: send('bulk-links', 'int-inlinks') },
        { label: 'External Outlinks', click: send('bulk-links', 'ext-outlinks') },
      ] },
      { label: 'Web', submenu: [
        { label: 'All URLs', click: send('bulk-web', 'all') },
        { label: 'Internal URLs', click: send('bulk-web', 'internal') },
        { label: 'External URLs', click: send('bulk-web', 'external') },
      ] },
      { label: 'Path Type', submenu: ['HTML', 'JavaScript', 'CSS', 'Images', 'PDF', 'Other'].map((c) => ({ label: c, click: send('bulk-category', c) })) },
      bulkSection('Security', 'Security', 'security'),
      bulkSection('Response Codes', 'Response Codes', 'responses'),
      bulkSection('Content', 'Content', 'content'),
      bulkSection('Images', 'Content', 'images'),
      bulkSection('Canonicals', 'Canonicals', 'canonicals'),
      bulkSection('Directives', 'Directives', 'directives'),
      bulkSection('JavaScript', 'JavaScript', 'javascript'),
      bulkSection('AMP', 'AMP', 'amp'),
      bulkSection('Structured Data', 'Structured Data', 'structured'),
      bulkSection('Sitemaps', 'Sitemaps', 'sitemaps'),
      { label: 'Custom Search', click: send('bulk-tab', 'search') },
      { label: 'Custom Extraction', click: send('bulk-tab', 'extraction') },
      { label: 'URL Inspection', click: send('bulk-inspection') },
      { label: 'Issues', click: send('bulk-issues') },
    ] },
    { label: 'Reports', submenu: ['overview', 'redirect-chains', 'redirects', 'orphans', 'serp-summary', 'canonical-errors', 'insecure-content', 'structured-data', 'http-headers', 'cookies'].map((k) => ({ label: { overview: 'Crawl Overview', 'redirect-chains': 'Redirect Chains', redirects: 'Redirects', orphans: 'Orphan Pages', 'serp-summary': 'SERP Summary', 'canonical-errors': 'Canonical Errors', 'insecure-content': 'Insecure Content', 'structured-data': 'Structured Data', 'http-headers': 'HTTP Headers', cookies: 'Cookies' }[k], click: send('report', k) })) },
    { label: 'Sitemaps', submenu: [
      { label: 'Create XML Sitemap...', click: send('sitemap-config', 'xml') },
      { label: 'Create Images Sitemap...', click: send('sitemap-config', 'image') },
    ] },
    { label: 'Visualisations', submenu: [
      { label: 'Crawl Tree Graph', click: send('visualisation', 'crawl-tree') },
      { label: 'Directory Tree Graph', click: send('visualisation', 'directory-tree') },
      { label: 'Force Directed Graph', click: send('visualisation', 'force') },
    ] },
    { label: 'Crawl Analysis', submenu: [{ label: 'Analyse', click: send('analyse') }] },
    { label: 'Licence', submenu: [{ label: 'About / Licence Info', click: () => dialog.showMessageBox(win, { type: 'info', title: 'Licence', message: 'Seonfix Spider', detail: 'Seonfix Spider is free for Seonfix use. Built for the Seonfix agency; crawls run locally on this computer. No licence key is required.' }) }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    { label: 'Help', submenu: [{ label: 'About Seonfix Spider', click: send('about') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function rememberFile(settings, filePath) {
  settings.recentFiles = [filePath, ...(settings.recentFiles || []).filter((f) => f !== filePath)].slice(0, 8);
}

function registerIpc() {
  ipcMain.handle('config:get', () => {
    const s = loadSettings();
    const config = { ...DEFAULT_CONFIG, ...(s.defaultConfig || {}), ...(s.config || {}) };
    return { config, recent: s.recent || [], recentUrls: (s.recent || []).map((r) => r.rootUrl), schedules: s.schedules || [], hasPagespeedKey: !!(s.apiKeysEnc || {}).pagespeed, uaPresets: UA_PRESETS, filterMeta: FILTER_META };
  });
  ipcMain.handle('config:save', (_e, payload) => {
    const s = loadSettings();
    if (payload && payload.config) { s.config = payload.config; if (payload.apiKeys) storeApiKeys(s, payload.apiKeys); }
    else s.config = payload;
    saveSettings(s); return { ok: true };
  });
  ipcMain.handle('crawl:start', async (e, payload) => {
    if (activeCrawler) throw new Error('A crawl is already running.');
    const saved = loadSettings();
    const config = { ...DEFAULT_CONFIG, ...(saved.defaultConfig || {}), ...(saved.config || {}), ...(payload.config || {}) };
    const psiKey = readApiKey(saved, 'pagespeed'); if (psiKey) config.pagespeedKey = psiKey;
    let seeds = [];
    if (config.mode === 'list' || config.mode === 'serp') {
      seeds = (payload.listText || '').split(/\r?\n/).map((l) => normalizeUrl(l.trim())).filter(Boolean);
      if (!seeds.length) throw new Error((config.mode === 'serp' ? 'SERP' : 'List') + ' mode needs at least one valid URL.');
    } else {
      const start = ensureUrl(payload.url || '');
      if (!start) throw new Error('Enter a valid URL to spider.');
      seeds = [start];
    }
    const crawler = new Crawler(config, {
      onProgress: (p) => { if (win && !win.isDestroyed()) win.webContents.send('crawl:progress', p); },
      onPage: (page) => { if (win && !win.isDestroyed()) win.webContents.send('crawl:page', page); },
    });
    activeCrawler = crawler;
    try {
      let crawl = await crawler.crawl(seeds, seeds[0]);
      if (config.rendering === 'rendered') {
        if (win) win.webContents.send('crawl:progress', { crawled: crawl.pages.length, queued: 0, discovered: crawl.pages.length, currentUrl: 'Rendering pages (JavaScript)...' });
        crawl = await applyRendering(crawl, config);
      }
      crawl.configSnapshot = { mode: config.mode, scope: config.scope, segments: config.segments || [] };
      currentCrawl = crawl;
      const s = loadSettings();
      s.recent = [{ rootUrl: crawl.rootUrl, mode: crawl.mode, total: crawl.stats.total, at: new Date().toISOString() }, ...(s.recent || [])].slice(0, 10);
      saveSettings(s);
      buildMenu();
      return crawl;
    } finally { activeCrawler = null; }
  });
  ipcMain.handle('crawl:pause', () => { if (activeCrawler) activeCrawler.pause(); return { ok: true }; });
  ipcMain.handle('crawl:resume', () => { if (activeCrawler) activeCrawler.resume(); return { ok: true }; });
  ipcMain.handle('crawl:stop', () => { if (activeCrawler) activeCrawler.stop(); return { ok: true }; });
  ipcMain.handle('crawl:get', () => currentCrawl);
  ipcMain.handle('crawl:analyse', () => {
    if (!currentCrawl) throw new Error('No crawl to analyse yet.');
    const cfg = { ...DEFAULT_CONFIG, ...(currentCrawl.configSnapshot || {}) };
    const fin = finalizeCrawl(currentCrawl.pages, currentCrawl.rootUrl, cfg);
    currentCrawl.issues = fin.issues; currentCrawl.analysis = fin.analysis;
    currentCrawl.stats = { ...currentCrawl.stats, ...fin.stats, durationMs: currentCrawl.stats.durationMs };
    return currentCrawl;
  });
  function openCrawlData(data, filePath) {
    if (!data || !Array.isArray(data.pages)) throw new Error('That file is not a saved Seonfix Spider crawl.');
    if ((data.version || 1) < 2) {
      // v1 crawl: recompute v2 fields (filters, issues, analysis) offline.
      const cfg = { ...DEFAULT_CONFIG, ...(data.configSnapshot || {}) };
      const fin = finalizeCrawl(data.pages, data.rootUrl, cfg);
      data.issues = fin.issues; data.analysis = fin.analysis; data.filterMeta = FILTER_META;
      data.stats = { ...data.stats, ...fin.stats };
      data.version = 2; data.upgradedFrom = 1;
    }
    currentCrawl = data;
    if (filePath) { const s = loadSettings(); rememberFile(s, filePath); saveSettings(s); buildMenu(); }
    return data;
  }
  ipcMain.handle('crawl:save', async (_e, saveAs) => {
    if (!currentCrawl) throw new Error('No crawl to save yet.');
    const r = await dialog.showSaveDialog(win, { title: saveAs ? 'Save Crawl As' : 'Save Crawl', defaultPath: 'crawl.seonfixspider.json', filters: [{ name: 'Seonfix Spider Crawl', extensions: ['json'] }] });
    if (r.canceled) return { saved: false };
    fs.writeFileSync(r.filePath, JSON.stringify(currentCrawl));
    const s = loadSettings(); rememberFile(s, r.filePath); saveSettings(s); buildMenu();
    return { saved: true, path: r.filePath };
  });
  ipcMain.handle('crawl:open', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open Crawl', properties: ['openFile'], filters: [{ name: 'Seonfix Spider Crawl', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    return openCrawlData(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')), r.filePaths[0]);
  });
  ipcMain.handle('crawl:openPath', async (_e, filePath) => openCrawlData(JSON.parse(fs.readFileSync(filePath, 'utf8')), filePath));
  ipcMain.handle('crawl:comparePick', async () => {
    if (!currentCrawl) throw new Error('Run or open a crawl first, then pick another saved crawl to compare it with.');
    const r = await dialog.showOpenDialog(win, { title: 'Pick Saved Crawl to Compare', properties: ['openFile'], filters: [{ name: 'Seonfix Spider Crawl', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    const other = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    return { otherRoot: other.rootUrl, otherAt: other.startedAt, diff: compareCrawls(other, currentCrawl) };
  });
  ipcMain.handle('file:saveText', async (_e, { defaultPath, content }) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultPath || 'export.csv' });
    if (r.canceled) return { saved: false };
    fs.writeFileSync(r.filePath, content);
    return { saved: true, path: r.filePath };
  });
  ipcMain.handle('report:generate', async (_e, kind) => {
    if (!currentCrawl) throw new Error('No crawl yet.');
    const rep = buildReport(kind, currentCrawl);
    const r = await dialog.showSaveDialog(win, { defaultPath: rep.filename });
    if (r.canceled) return { saved: false };
    fs.writeFileSync(r.filePath, rep.content);
    return { saved: true, path: r.filePath };
  });
  ipcMain.handle('export:pagesForFilter', (_e, filterId) => {
    if (!currentCrawl) return [];
    return pagesMatching(currentCrawl, filterId).map(genericRow);
  });
  ipcMain.handle('sitemap:generate', async (_e, kind, opts) => {
    if (!currentCrawl) throw new Error('No crawl yet.');
    const xml = kind === 'image' ? generateImageSitemap(currentCrawl.pages, opts || {}) : generateSitemap(currentCrawl.pages, opts || {});
    const r = await dialog.showSaveDialog(win, { defaultPath: kind === 'image' ? 'image-sitemap.xml' : 'sitemap.xml', filters: [{ name: 'XML', extensions: ['xml'] }] });
    if (r.canceled) return { saved: false };
    fs.writeFileSync(r.filePath, xml);
    return { saved: true, path: r.filePath };
  });
  ipcMain.handle('psi:fetch', async (_e, urls) => {
    const s = loadSettings();
    const key = readApiKey(s, 'pagespeed');
    if (!key) throw new Error('No PageSpeed API key saved. Add one in Configuration > API Access > PageSpeed.');
    const out = [];
    for (const url of (urls || []).slice(0, 100)) {
      try {
        const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${encodeURIComponent(key)}`;
        const r = await fetch(api, { signal: AbortSignal.timeout(60000) });
        const j = await r.json();
        const cats = j.lighthouseResult && j.lighthouseResult.categories;
        const audits = (j.lighthouseResult && j.lighthouseResult.audits) || {};
        out.push({ url, score: cats && cats.performance ? Math.round(cats.performance.score * 100) : null, lcp: audits['largest-contentful-paint'] ? audits['largest-contentful-paint'].displayValue : '', cls: audits['cumulative-layout-shift'] ? audits['cumulative-layout-shift'].displayValue : '', tbt: audits['total-blocking-time'] ? audits['total-blocking-time'].displayValue : '', error: j.error ? j.error.message : '' });
      } catch (e) { out.push({ url, score: null, error: String(e && e.message || e) }); }
    }
    return out;
  });
  ipcMain.handle('profile:save', async (_e, config) => {
    const r = await dialog.showSaveDialog(win, { title: 'Save Configuration Profile', defaultPath: 'spider-profile.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return { saved: false };
    fs.writeFileSync(r.filePath, JSON.stringify(config || {}, null, 1));
    const s = loadSettings(); s.recentProfiles = [r.filePath, ...(s.recentProfiles || []).filter((f) => f !== r.filePath)].slice(0, 5); saveSettings(s); buildMenu();
    return { saved: true, path: r.filePath };
  });
  ipcMain.handle('profile:load', async (_e, filePath) => {
    let p = filePath;
    if (!p) {
      const r = await dialog.showOpenDialog(win, { title: 'Load Configuration Profile', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths.length) return null;
      p = r.filePaths[0];
    }
    const config = JSON.parse(fs.readFileSync(p, 'utf8'));
    const s = loadSettings(); s.config = { ...DEFAULT_CONFIG, ...config }; s.recentProfiles = [p, ...(s.recentProfiles || []).filter((f) => f !== p)].slice(0, 5); saveSettings(s); buildMenu();
    return { config: s.config, path: p };
  });
  ipcMain.handle('profile:setDefault', (_e, config) => { const s = loadSettings(); s.defaultConfig = config; saveSettings(s); return { ok: true }; });
  ipcMain.handle('profile:clearDefault', () => { const s = loadSettings(); delete s.defaultConfig; saveSettings(s); return { ok: true }; });
  ipcMain.handle('schedule:list', () => (loadSettings().schedules || []));
  ipcMain.handle('schedule:save', (_e, schedules) => { const s = loadSettings(); s.schedules = schedules || []; saveSettings(s); return { ok: true }; });
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose Export Folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('vis:open', (_e, view) => {
    if (visWin && !visWin.isDestroyed()) { visWin.focus(); visWin.webContents.send('vis:view', view); return { ok: true }; }
    visWin = new BrowserWindow({ width: 1100, height: 760, title: 'Seonfix Spider - Visualisations', backgroundColor: '#101418', icon: path.join(__dirname, '..', '..', 'build', 'icon.png'), webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    visWin.loadFile(path.join(__dirname, '..', 'renderer', 'visual.html'));
    visWin.webContents.once('did-finish-load', () => visWin.webContents.send('vis:view', view || 'crawl-tree'));
    visWin.on('closed', () => { visWin = null; });
    return { ok: true };
  });
  ipcMain.handle('vis:getData', () => currentCrawl);
  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1000, minHeight: 640,
    backgroundColor: '#101418', title: 'Seonfix Spider',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  return win;
}

app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  startScheduleTimer();
  const w = createWindow();
  if (process.env.SPIDER_SMOKE) {
    let started = false;
    const startSmoke = async () => {
      if (started) return; started = true;
      console.log('SMOKE starting');
      try { await require(path.join(__dirname, '..', '..', 'test', 'smoke-electron.js')).run(w); console.log('SMOKE done'); app.exit(0); }
      catch (e) { console.error('SMOKE FAILED', e); app.exit(1); }
    };
    w.webContents.once('did-finish-load', startSmoke);
    w.webContents.on('did-fail-load', (_e, code, desc) => console.error('LOAD FAILED', code, desc));
    setTimeout(startSmoke, 15000);
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
