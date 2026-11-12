'use strict';
/* Seonfix Spider - Electron main process.
 * The crawl engine (crawler.js) is plain Node; this file wires it to IPC,
 * native dialogs/menus, crawl persistence and optional JS rendering. */
const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Crawler, DEFAULT_CONFIG, UA_PRESETS, generateSitemap, generateImageSitemap, compareCrawls } = require('./crawler');
const { ensureUrl, normalizeUrl } = require('./urlutil');
const { parsePage } = require('./extract');

const isMac = process.platform === 'darwin';
if (process.env.SPIDER_SMOKE) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'spider-profile-')));

let win = null;
let activeCrawler = null;
let currentCrawl = null;

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch (_) { return {}; }
}
function saveSettings(s) { fs.mkdirSync(path.dirname(settingsPath()), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 1)); }

function redirectReportCsv(crawl) {
  const rows = [['Source URL', 'Status Code', 'Hop', 'From', 'To', 'Final URL', 'Loop']];
  for (const p of crawl.pages || []) {
    (p.redirectChain || []).forEach((hop, i) => rows.push([p.address, p.statusCode, i + 1, hop.from, hop.to, p.redirectUrl || '', p.redirectLoop ? 'Yes' : 'No']));
  }
  return rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

// Basic JS rendering: load the URL in a hidden window, grab rendered HTML,
// parse it and record how it differs from the raw HTML version.
async function renderPage(url) {
  const w = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true } });
  try {
    await w.loadURL(url, { userAgent: DEFAULT_CONFIG.userAgent });
    await new Promise((r) => setTimeout(r, 600));
    const html = await w.webContents.executeJavaScript('document.documentElement.outerHTML', true);
    return html;
  } finally { try { w.destroy(); } catch (_) {} }
}

async function applyRendering(crawl, config) {
  const targets = crawl.pages.filter((p) => !p.external && (p.finalStatusCode === 200 || p.statusCode === 200)).slice(0, 200);
  for (const p of targets) {
    try {
      const html = await renderPage(p.address);
      const parsed = parsePage({ url: p.address, html, headers: p.headers || {}, statusCode: 200 });
      p.renderedTitle = parsed.title;
      p.renderedH1 = (parsed.h1s || [])[0] || '';
      p.renderedLinkCount = (parsed.links || []).length;
      p.renderDiffers = parsed.title !== (p.rawTitle || p.title || '') || (parsed.h1s || []).length !== (p.h1s || []).length || (parsed.links || []).length !== (p.links || []).length;
    } catch (e) { p.renderError = String(e && e.message || e); }
  }
  return crawl;
}

function buildMenu() {
  const send = (action, arg) => () => { if (win) win.webContents.send('menu:action', action, arg); };
  const template = [
    ...(isMac ? [{ label: 'Seonfix Spider', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
      { label: 'New Crawl', accelerator: 'CmdOrCtrl+N', click: send('new') },
      { label: 'Open Crawl...', accelerator: 'CmdOrCtrl+O', click: send('open') },
      { label: 'Save Crawl', accelerator: 'CmdOrCtrl+S', click: send('save') },
      { type: 'separator' },
      { label: 'Export Current Tab (CSV)', click: send('export') },
      { label: 'Bulk Export (CSV Bundle)', click: send('bulk-export') },
      { label: 'Generate XML Sitemap...', click: send('sitemap') },
      { label: 'Generate Image Sitemap...', click: send('image-sitemap') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { label: 'Mode', submenu: [
      { label: 'Spider', click: send('mode', 'spider') },
      { label: 'List', click: send('mode', 'list') },
      { label: 'Sitemap', click: send('mode', 'sitemap') },
    ] },
    { label: 'Configuration', submenu: [
      { label: 'Spider Configuration...', click: send('config') },
      { label: 'Settings (Integrations)...', click: send('settings') },
    ] },
    { label: 'Reports', submenu: [
      { label: 'Redirect Chains Report (CSV)', click: send('redirect-report') },
      { label: 'Crawl Comparison...', click: send('compare') },
    ] },
    { label: 'Visualisation', submenu: [
      { label: 'Site Structure', click: send('visualisation') },
    ] },
    { label: 'Help', submenu: [
      { label: 'About Seonfix Spider', click: send('about') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('config:get', () => {
    const s = loadSettings();
    return { config: { ...DEFAULT_CONFIG, ...(s.config || {}) }, recent: s.recent || [], uaPresets: UA_PRESETS };
  });
  ipcMain.handle('config:save', (_e, config) => {
    const s = loadSettings(); s.config = config; saveSettings(s); return { ok: true };
  });
  ipcMain.handle('crawl:start', async (e, payload) => {
    if (activeCrawler) throw new Error('A crawl is already running.');
    const config = { ...DEFAULT_CONFIG, ...(payload.config || {}) };
    let seeds = [];
    if (config.mode === 'list') {
      seeds = (payload.listText || '').split(/\r?\n/).map((l) => normalizeUrl(l.trim())).filter(Boolean);
      if (!seeds.length) throw new Error('List mode needs at least one valid URL.');
    } else {
      const start = ensureUrl(payload.url || '');
      if (!start) throw new Error('Enter a valid URL to spider.');
      seeds = [start];
    }
    const crawler = new Crawler(config, {
      onProgress: (p) => { if (win && !win.isDestroyed()) win.webContents.send('crawl:progress', p); },
    });
    activeCrawler = crawler;
    try {
      let crawl = await crawler.crawl(seeds, seeds[0]);
      if (config.rendering === 'rendered') {
        if (win) win.webContents.send('crawl:progress', { crawled: crawl.pages.length, queued: 0, discovered: crawl.pages.length, currentUrl: 'Rendering pages (JavaScript)...' });
        crawl = await applyRendering(crawl, config);
      }
      currentCrawl = crawl;
      const s = loadSettings();
      s.recent = [{ rootUrl: crawl.rootUrl, mode: crawl.mode, total: crawl.stats.total, at: new Date().toISOString() }, ...(s.recent || [])].slice(0, 10);
      saveSettings(s);
      return crawl;
    } finally { activeCrawler = null; }
  });
  ipcMain.handle('crawl:pause', () => { if (activeCrawler) activeCrawler.pause(); return { ok: true }; });
  ipcMain.handle('crawl:resume', () => { if (activeCrawler) activeCrawler.resume(); return { ok: true }; });
  ipcMain.handle('crawl:stop', () => { if (activeCrawler) activeCrawler.stop(); return { ok: true }; });
  ipcMain.handle('crawl:get', () => currentCrawl);
  ipcMain.handle('crawl:save', async () => {
    if (!currentCrawl) throw new Error('No crawl to save yet.');
    const r = await dialog.showSaveDialog(win, { title: 'Save Crawl', defaultPath: 'crawl.seonfixspider.json', filters: [{ name: 'Seonfix Spider Crawl', extensions: ['json'] }] });
    if (r.canceled) return { saved: false };
    fs.writeFileSync(r.filePath, JSON.stringify(currentCrawl));
    return { saved: true, path: r.filePath };
  });
  ipcMain.handle('crawl:open', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open Crawl', properties: ['openFile'], filters: [{ name: 'Seonfix Spider Crawl', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (!data || !Array.isArray(data.pages)) throw new Error('That file is not a saved Seonfix Spider crawl.');
    currentCrawl = data;
    return data;
  });
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
  ipcMain.handle('export:redirectReport', async () => {
    if (!currentCrawl) throw new Error('No crawl yet.');
    const r = await dialog.showSaveDialog(win, { defaultPath: 'redirect-chains.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled) return { saved: false };
    fs.writeFileSync(r.filePath, redirectReportCsv(currentCrawl));
    return { saved: true, path: r.filePath };
  });
  ipcMain.handle('sitemap:generate', async (_e, kind) => {
    if (!currentCrawl) throw new Error('No crawl yet.');
    const xml = kind === 'image' ? generateImageSitemap(currentCrawl.pages) : generateSitemap(currentCrawl.pages);
    const r = await dialog.showSaveDialog(win, { defaultPath: kind === 'image' ? 'image-sitemap.xml' : 'sitemap.xml', filters: [{ name: 'XML', extensions: ['xml'] }] });
    if (r.canceled) return { saved: false };
    fs.writeFileSync(r.filePath, xml);
    return { saved: true, path: r.filePath };
  });
  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1000, minHeight: 640,
    backgroundColor: '#14181d', title: 'Seonfix Spider',
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
    setTimeout(startSmoke, 15000); // fallback if the load event was missed
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
