'use strict';
// Preload bridge: the ONLY way the renderer can reach the main process.
const { contextBridge, ipcRenderer } = require('electron');
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('spider', {
  configGet: call('config:get'),
  configSave: call('config:save'),
  crawlStart: call('crawl:start'),
  serpAnalyse: call('serp:analyse'),
  crawlPause: call('crawl:pause'),
  crawlResume: call('crawl:resume'),
  crawlStop: call('crawl:stop'),
  crawlGet: call('crawl:get'),
  crawlAnalyse: call('crawl:analyse'),
  crawlSave: call('crawl:save'),
  crawlOpen: call('crawl:open'),
  crawlOpenPath: call('crawl:openPath'),
  crawlComparePick: call('crawl:comparePick'),
  saveText: call('file:saveText'),
  reportGenerate: call('report:generate'),
  sitemapGenerate: call('sitemap:generate'),
  psiFetch: call('psi:fetch'),
  profileSave: call('profile:save'),
  profileLoad: call('profile:load'),
  profileSetDefault: call('profile:setDefault'),
  profileClearDefault: call('profile:clearDefault'),
  scheduleList: call('schedule:list'),
  scheduleSave: call('schedule:save'),
  pickFolder: call('dialog:pickFolder'),
  visOpen: call('vis:open'),
  visGetData: call('vis:getData'),
  openExternal: call('shell:open'),
  appInfo: call('app:info'),
  onProgress: (fn) => ipcRenderer.on('crawl:progress', (_e, p) => fn(p)),
  onPage: (fn) => ipcRenderer.on('crawl:page', (_e, p) => fn(p)),
  onMenu: (fn) => ipcRenderer.on('menu:action', (_e, action, arg) => fn(action, arg)),
  onVisView: (fn) => ipcRenderer.on('vis:view', (_e, view) => fn(view)),
});
