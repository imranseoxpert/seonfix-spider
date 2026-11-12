'use strict';
// Preload bridge: the ONLY way the renderer can reach the main process.
const { contextBridge, ipcRenderer } = require('electron');
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('spider', {
  configGet: call('config:get'),
  configSave: call('config:save'),
  crawlStart: call('crawl:start'),
  crawlPause: call('crawl:pause'),
  crawlResume: call('crawl:resume'),
  crawlStop: call('crawl:stop'),
  crawlGet: call('crawl:get'),
  crawlSave: call('crawl:save'),
  crawlOpen: call('crawl:open'),
  crawlComparePick: call('crawl:comparePick'),
  saveText: call('file:saveText'),
  redirectReport: call('export:redirectReport'),
  sitemapGenerate: call('sitemap:generate'),
  openExternal: call('shell:open'),
  appInfo: call('app:info'),
  onProgress: (fn) => ipcRenderer.on('crawl:progress', (_e, p) => fn(p)),
  onMenu: (fn) => ipcRenderer.on('menu:action', (_e, action, arg) => fn(action, arg)),
});
