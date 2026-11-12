'use strict';
/* Seonfix Spider self-test. Runs inside the real Electron app when
 * SPIDER_SMOKE=<output dir> is set. Starts a local fixture site, drives the
 * real UI to crawl it, and verifies tabs, table, sidebar and dialogs. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

exports.run = async function run(win) {
  const out = process.env.SPIDER_SMOKE;
  fs.mkdirSync(out, { recursive: true });
  const mark = (s) => { try { fs.writeFileSync(path.join(out, 'step.txt'), s); } catch (_) {} console.log('SMOKE STEP', s); };
  mark('entered');
  const wc = win.webContents;
  const results = [];
  const errors = [];
  wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
  wc.on('render-process-gone', (_e, d) => errors.push('renderer gone: ' + d.reason));
  wc.on('preload-error', (_e, p, err) => errors.push('preload error: ' + err.message));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => wc.executeJavaScript(code, true);
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) }); if (!ok) console.log(`  FAIL ${name} ${detail ?? ''}`); };

  // fixture site
  const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet '.repeat(8);
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    if (p === '/child') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<html><head><title>Child Page Title For Smoke Test</title></head><body><h1>Child</h1><p>${WORDS}</p><a href="/">Home</a></body></html>`); }
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<html><head><title>Smoke Home Page Title Here</title></head><body><h1>Home</h1><p>${WORDS}</p><a href="/child">Child</a><a href="/gone">Gone</a><img src="/x.png"></body></html>`); }
    res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<html><head><title>Not Found</title></head><body><h1>404</h1></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  mark('server up ' + base);

  if (wc.isLoading()) await Promise.race([new Promise((r) => wc.once('did-finish-load', r)), sleep(8000)]);
  mark('page loaded, isLoading=' + wc.isLoading());
  for (let i = 0; i < 100 && !(await js('!!(window.spider && document.querySelector("#tabs"))').catch(() => false)); i++) await sleep(100);

  check('preload bridge present', await js('typeof window.spider === "object" && typeof window.spider.crawlStart === "function"'));
  const tabCount = await js('document.querySelectorAll("#tabs button").length');
  check('all tabs rendered (>= 20)', tabCount >= 20, tabCount);
  check('no emoji in UI text', await js('!/[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u.test(document.body.innerText)'));
  check('logo image present', await js('!!document.querySelector(".brand img")'));

  // drive a real crawl through the UI
  await js(`document.querySelector("#url-input").value = ${JSON.stringify(base)}; document.querySelector("#btn-start").click(); true`);
  let crawled = false;
  for (let i = 0; i < 150; i++) { await sleep(200); const done = await js('!!(window.__spiderState && window.__spiderState.crawl)').catch(() => false); if (done) { crawled = true; break; } }
  check('UI crawl completed', crawled);
  check('crawl found fixture pages', await js('window.__spiderState.crawl.pages.length >= 3'), await js('window.__spiderState.crawl.pages.length'));
  let completeShown = false;
  for (let i = 0; i < 25 && !completeShown; i++) { completeShown = await js('/Crawl complete/.test(document.querySelector("#progress-text").textContent)').catch(() => false); if (!completeShown) await sleep(200); }
  check('progress shows complete', completeShown, await js('document.querySelector("#progress-text").textContent'));
  await js('document.querySelector(\'[data-tab="internal"]\').click(); true');
  await sleep(200);
  const rowCount = await js('document.querySelectorAll("#grid tbody tr").length');
  check('internal tab shows rows', rowCount >= 3, rowCount);
  check('sidebar issues rendered', await js('document.querySelectorAll("#side-issues .issue-row").length >= 1'), await js('document.querySelectorAll("#side-issues .issue-row").length'));
  // click first row -> bottom pane fills
  await js('document.querySelector("#grid tbody tr").click(); true');
  await sleep(150);
  check('bottom pane shows URL details', await js('/Address/.test(document.querySelector("#bottom-body").textContent)'));
  // config dialog opens with fields
  await js('document.querySelector("#btn-config").click(); true');
  await sleep(200);
  check('config dialog opens', await js('document.querySelector("#config-dialog").open && !!document.querySelector("#cfg-concurrency")'));
  await js('document.querySelector("#cfg-cancel").click(); true');
  // settings dialog shows honest integrations placeholder
  await js('document.querySelector("#btn-settings").click(); true');
  await sleep(150);
  check('settings shows v1.1 integrations note', await js('/coming in v1\\.1/i.test(document.querySelector("#settings-dialog").textContent)'));
  await js('document.querySelector("#settings-close").click(); true');
  // visualisation renders an SVG graph
  await js('document.querySelector(\'[data-tab="visualisation"]\').click(); true');
  await sleep(200);
  check('visualisation renders SVG', await js('!!document.querySelector("#visual-panel svg")'));
  check('no renderer errors', errors.length === 0, errors.join(' | '));

  try { const img = await wc.capturePage(); fs.writeFileSync(path.join(out, 'app.png'), img.toPNG()); } catch (_) {}
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, errors }, null, 1));
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`SMOKE ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) throw new Error(`smoke failed: ${failed.map((f) => f.name).join(', ')}`);
};
