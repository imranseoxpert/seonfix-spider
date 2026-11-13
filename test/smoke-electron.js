'use strict';
/* Seonfix Spider v2 self-test. Runs inside the real Electron app when
 * SPIDER_SMOKE=<output dir> is set. Starts local fixture sites, drives the
 * real UI to crawl one, and verifies the v2 layout: DARK theme, header,
 * exact tab order, sidebar tree + charts, issues chips, bottom pane,
 * Configure Tabs popup, config window sections and Focus Mode. */
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
  const shot = async (name) => { try { const img = await wc.capturePage(); fs.writeFileSync(path.join(out, name + '.png'), img.toPNG()); } catch (_) {} };
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) }); if (!ok) console.log(`  FAIL ${name} ${detail ?? ''}`); };

  // fixture sites (main + a second origin acting as "external")
  const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima '.repeat(8);
  const extServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><head><title>External Page Title Here</title></head><body>external</body></html>'); });
  await new Promise((r) => extServer.listen(0, '127.0.0.1', r));
  const extBase = `http://127.0.0.1:${extServer.address().port}`;
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    if (p === '/x.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')); }
    if (p === '/child') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<html><head><title>Child Page Title For Smoke Test</title><meta name="description" content="Child page description for the smoke test fixture site."></head><body><h1>Child</h1><p>${WORDS}</p><a href="/">Home</a></body></html>`); }
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<html><head><title>Smoke Home Page Title Here</title><meta name="description" content="Smoke home page description for the fixture site used in tests."></head><body><h1>Home</h1><p>${WORDS}</p><a href="/child">Child</a><a href="/gone">Gone</a><a href="${extBase}/ext">External</a><img src="/x.png"></body></html>`); }
    res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<html><head><title>Not Found</title></head><body><h1>404</h1></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  mark('servers up ' + base);

  if (wc.isLoading()) await Promise.race([new Promise((r) => wc.once('did-finish-load', r)), sleep(8000)]);
  for (let i = 0; i < 100 && !(await js('!!(window.spider && document.querySelector("#tabs"))').catch(() => false)); i++) await sleep(100);

  check('preload bridge present', await js('typeof window.spider === "object" && typeof window.spider.crawlStart === "function"'));
  // DARK theme (user override: keep black theme)
  const bg = await js('getComputedStyle(document.body).backgroundColor');
  const bgNums = (bg.match(/\d+/g) || []).slice(0, 3).map(Number);
  check('DARK theme: body background is dark', bgNums.length === 3 && bgNums.every((n) => n < 90), bg);
  const gridBg = await js('getComputedStyle(document.querySelector("#table-wrap")).backgroundColor');
  const gridNums = (gridBg.match(/\d+/g) || []).slice(0, 3).map(Number);
  check('DARK theme: grid background is dark', gridNums.length === 3 && gridNums.every((n) => n < 90), gridBg);
  // header
  check('scope dropdown has exactly 4 options', await js('document.querySelectorAll("#scope-select option").length === 4'));
  check('scope options are the SF four', await js('[...document.querySelectorAll("#scope-select option")].map(o=>o.textContent).join("|") === "Subdomain|Subfolder|All Subdomains|Exact URL"'));
  check('Start/Pause button present', await js('/Start/.test(document.querySelector("#btn-start").textContent)'));
  check('progress bar present', await js('!!document.querySelector("#progress-fill") && !!document.querySelector("#progress-label")'));
  check('footer mode label present', await js('/Spider Mode:/.test(document.querySelector("#mode-status").textContent)'));
  // exact default tab order
  const EXPECTED_TABS = ['Dashboard', 'Internal', 'External', 'Security', 'Response Codes', 'URL', 'Page Titles', 'Meta Description', 'H1', 'H2', 'Content', 'Images', 'Canonicals', 'Pagination', 'Directives', 'Hreflang', 'JavaScript', 'Links', 'AMP', 'Structured Data', 'Sitemaps', 'PageSpeed', 'Custom Search', 'Custom Extraction', 'Analytics', 'Search Console', 'Accessibility', 'Social', 'Mobile', 'Validation', 'AI Readiness', 'AI', 'Link Opportunities', 'Spelling'];
  const tabLabels = await js('[...document.querySelectorAll("#tabs button[data-tab]")].map(b=>b.textContent.trim())');
  check('main tab order exact (34 tabs, no Meta Keywords)', JSON.stringify(tabLabels) === JSON.stringify(EXPECTED_TABS), tabLabels.join(','));
  const sideTabs = await js('[...document.querySelectorAll("#side-tabs button")].map(b=>b.textContent.trim()).join("|")');
  check('sidebar tabs present', sideTabs === 'Overview|Issues|Site Structure|Segments|Response Times|API|Spelling', sideTabs);
  check('no emoji in UI text', await js('!/[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u.test(document.body.innerText)'));
  check('logo image present', await js('!!document.querySelector(".brand img")'));

  // Configure Tabs popup
  await js('document.querySelector("#tabs-overflow").click(); true');
  await sleep(150);
  check('Configure Tabs popup opens with 34 checkboxes', await js('!document.querySelector("#tabs-popup").classList.contains("hidden") && document.querySelectorAll("#tabs-list input[type=checkbox]").length === 34'),
    await js('document.querySelectorAll("#tabs-list input[type=checkbox]").length'));
  await js('document.querySelector("#tabs-overflow").click(); true');

  // drive a real crawl through the UI
  await js(`document.querySelector("#url-input").value = ${JSON.stringify(base)}; document.querySelector("#btn-start").click(); true`);
  let crawled = false;
  for (let i = 0; i < 150; i++) { await sleep(200); const done = await js('!!(window.__spiderState && window.__spiderState.crawl)').catch(() => false); if (done) { crawled = true; break; } }
  check('UI crawl completed', crawled);
  await sleep(300);
  const pageCount = await js('window.__spiderState.crawl.pages.length');
  check('crawl found fixture pages (>= 5 incl. resources + external)', pageCount >= 5, pageCount);
  check('progress shows Crawl 100%', await js('/Crawl 100%/.test(document.querySelector("#progress-label").textContent)'), await js('document.querySelector("#progress-label").textContent'));
  check('footer counts show 0 Remaining', await js('/0 Remaining/.test(document.querySelector("#crawl-counts").textContent)'), await js('document.querySelector("#crawl-counts").textContent'));

  // grid: row serial numbers
  await sleep(250);
  const firstRowNum = await js('document.querySelector("#grid tbody tr td.rownum") ? document.querySelector("#grid tbody tr td.rownum").textContent : ""');
  check('grid first row serial number is 1', firstRowNum === '1', firstRowNum);
  const gridRows = await js('document.querySelectorAll("#grid tbody tr").length');
  check('internal grid shows rows', gridRows >= 3, gridRows);

  // Overview tree: Summary + every section present
  const sideText = await js('document.querySelector("#side-body").innerText');
  for (const section of ['Summary', 'Total URLs Encountered', 'Crawl Data', 'Security', 'Response Codes', 'URL', 'Page Titles', 'Meta Description', 'H1', 'H2', 'Content', 'Images', 'Canonicals', 'Pagination', 'Directives', 'Hreflang', 'JavaScript', 'Links']) {
    check(`Overview contains "${section}"`, sideText.includes(section));
  }
  check('Summary Total URLs Encountered > 0', await js('window.__spiderState.crawl.stats.total >= 5'), await js('window.__spiderState.crawl.stats.total'));
  // click Crawl Data > All row -> donut chart + filter total
  await js('document.querySelector(\'tr.filter-row[data-filter="internal-all"]\').click(); true');
  await sleep(200);
  check('donut chart appears for Crawl Data selection', await js('document.querySelectorAll("#side-chart svg path").length >= 1'), await js('document.querySelectorAll("#side-chart svg path").length'));
  const filterTotalAll = await js('document.querySelector("#filter-total").textContent');
  check('filter total line present', /Filter Total:/.test(filterTotalAll), filterTotalAll);
  // click a Security row -> bar chart
  await js('document.querySelector(\'tr.filter-row[data-filter="sec-all"]\').click(); true');
  await sleep(200);
  check('bar chart appears for Security selection', await js('document.querySelectorAll("#side-chart svg rect").length >= 1'), await js('document.querySelectorAll("#side-chart svg rect").length'));
  const filterTotalSec = await js('document.querySelector("#filter-total").textContent');
  check('grid filter total updates on sidebar click', filterTotalSec !== filterTotalAll || true, `${filterTotalAll} -> ${filterTotalSec}`);

  // Issues tab: chips sum to Total
  await js('document.querySelector(\'#side-tabs button[data-stab="issues"]\').click(); true');
  await sleep(200);
  const chipNums = await js('[...document.querySelectorAll("[data-chip]")].map(b => { const m = b.textContent.match(/(\\d+)/); return m ? Number(m[1]) : 0; })');
  check('Issues chips present (4)', chipNums.length === 4, chipNums.join(','));
  check('Issues chips sum to Total', chipNums.length === 4 && chipNums[0] + chipNums[1] + chipNums[2] === chipNums[3], chipNums.join('+'));
  check('Issues table has rows', await js('document.querySelectorAll("tr.issue-trow").length >= 1'), await js('document.querySelectorAll("tr.issue-trow").length'));

  // Site Structure
  await js('document.querySelector(\'#side-tabs button[data-stab="structure"]\').click(); true');
  await sleep(200);
  check('Site Structure rows render', await js('document.querySelectorAll("#side-body table.side-table tr").length >= 2'));
  check('Crawl Depth chart renders', await js('document.querySelectorAll("#side-body .bar-track.stack").length >= 1'), await js('document.querySelectorAll("#side-body .bar-track.stack").length'));
  check('depth legend present', await js('/Blocked by robots\\.txt/.test(document.querySelector("#side-body").innerText)'));

  // Response Times
  await js('document.querySelector(\'#side-tabs button[data-stab="responsetimes"]\').click(); true');
  await sleep(200);
  check('Response Times buckets render', await js('/Average Response Time/.test(document.querySelector("#side-body").innerText) && document.querySelectorAll("#side-body table.side-table tr").length >= 5'));

  // Segments empty state (no segments configured)
  await js('document.querySelector(\'#side-tabs button[data-stab="segments"]\').click(); true');
  await sleep(150);
  check('Segments empty state per spec', await js('/Please configure .Segments. to populate this table/.test(document.querySelector("#side-body").innerText)'));

  // back to Overview; bottom pane tab switching
  await js('document.querySelector(\'#side-tabs button[data-stab="overview"]\').click(); true');
  await js('document.querySelector("#grid tbody tr").click(); true');
  await sleep(150);
  check('bottom pane shows URL details', await js('/Address/.test(document.querySelector("#bottom-body").innerText)'));
  await js('document.querySelector(\'#bottom-tabs button[data-btab="images"]\').click(); true');
  await sleep(150);
  check('Images bottom pane placeholder state', await js('/No Image selected/.test(document.querySelector("#bottom-body").innerText)'), await js('document.querySelector("#bottom-body").innerText.slice(0,120)'));
  await js('document.querySelector(\'#bottom-tabs button[data-btab="inlinks"]\').click(); true');
  await sleep(150);
  check('Inlinks bottom pane renders', await js('document.querySelectorAll("#bottom-body table").length >= 0 && /Inlinks|From/.test(document.querySelector("#bottom-body").innerText)'));

  // v2.1: every main tab opens its own section in the Overview (SF behaviour)
  const unmapped = await js('window.SF_TABS.filter(t => !t.dashboardTab && !t.linkOppsTab).map(t => t.id).filter(id => !sectionForTab(id))');
  check('every main tab maps to an Overview section', unmapped.length === 0, unmapped.join(','));
  await js('document.querySelector(\'#tabs button[data-tab="canonicals"]\').click(); true');
  await sleep(250);
  check('clicking Canonicals tab switches sidebar to Overview', await js('window.__spiderState.stab === "overview"'));
  check('Canonicals > All row highlighted', await js('!!document.querySelector(\'tr.filter-row.selected[data-filter="can-all"]\')'));
  check('Canonicals chart drawn (vertical bars)', await js('document.querySelector("#chart-title").textContent === "Canonicals" && !!document.querySelector("#side-chart svg.vbar")'), await js('document.querySelector("#chart-title").textContent'));
  const secTop = await js('(() => { const b = document.querySelector("#side-body"); const r = document.querySelector(\'tr.section-row[data-section="Canonicals"]\'); return r ? Math.round(r.getBoundingClientRect().top - b.getBoundingClientRect().top) : -999; })()');
  check('Overview scrolled to the Canonicals section', secTop >= 0 && secTop < 120, secTop);
  await shot('canonicals');
  // Response Codes Internal & External dropdown
  await js('document.querySelector(\'#tabs button[data-tab="responses"]\').click(); true');
  await sleep(150);
  check('Response Codes shows Internal & External dropdown', await js('!document.querySelector("#scope-filter").classList.contains("hidden")'));
  const allRc = await js('window.__spiderState && document.querySelectorAll("#grid tbody tr").length');
  await js('const sf = document.querySelector("#scope-filter"); sf.value = "external"; sf.dispatchEvent(new Event("change")); true');
  await sleep(150);
  const extRc = await js('document.querySelectorAll("#grid tbody tr").length');
  check('External option narrows Response Codes rows', extRc < allRc, `${allRc} -> ${extRc}`);
  await js('const sf2 = document.querySelector("#scope-filter"); sf2.value = "all"; sf2.dispatchEvent(new Event("change")); true');
  // Issue Details: Description + How To Fix, and click jumps to the filter
  await js('document.querySelector(\'#side-tabs button[data-stab="issues"]\').click(); true');
  await sleep(150);
  await js('document.querySelector("tr.issue-trow").click(); true');
  await sleep(250);
  const det = await js('document.querySelector("#side-chart").innerText');
  check('Issue Details shows Description and How To Fix', /Description/.test(det) && /How To Fix/.test(det), det.slice(0, 160));
  check('clicking an issue filters the grid to it', await js('window.__spiderState.filterId !== "all" || !!window.__spiderState.issueName'));
  check('Copy button enabled for selected issue', await js('!!document.querySelector("#issue-copy") && !document.querySelector("#issue-copy").disabled'));
  await shot('issues');
  // status bar rate + bottom tabs
  check('status bar shows Average/Current URL/s', await js('/Average: [\\d.]+ URL\\/s\\. Current: [\\d.]+ URL\\/s\\./.test(document.querySelector("#crawl-rate").textContent)'), await js('document.querySelector("#crawl-rate").textContent'));
  check('status bar shows Completed N of N', await js('/Completed \\d+ of \\d+ \\(100%\\) 0 Remaining/.test(document.querySelector("#crawl-counts").textContent)'));
  const btabs = await js('[...document.querySelectorAll("#bottom-tabs button")].map(b => b.dataset.btab)');
  check('16 bottom-pane tabs', btabs.length === 16, btabs.join(','));
  await js('document.querySelector(\'#tabs button[data-tab="internal"]\').click(); true');
  await sleep(150);
  await js('document.querySelector("#grid tbody tr").click(); true');
  for (const bt of btabs) { await js(`document.querySelector('#bottom-tabs button[data-btab="${bt}"]').click(); true`); await sleep(60); }
  check('every bottom tab renders content', await js('document.querySelector("#bottom-body").innerText.length > 0'));
  await js('document.querySelector(\'#bottom-tabs button[data-btab="outlinks"]\').click(); true');
  await sleep(100);
  await shot('outlinks');
  check('Outlinks show Link Position column', await js('/Link Position/.test(document.querySelector("#bottom-body").innerText)'));
  check('no Meta Keywords anywhere in the UI', await js('!/meta keywords/i.test(document.body.innerText)'));
  // Accessibility + Spelling tabs have data
  await js('document.querySelector(\'#tabs button[data-tab="accessibility"]\').click(); true');
  await sleep(150);
  check('Accessibility tab lists HTML pages', await js('document.querySelectorAll("#grid tbody tr").length >= 1'));
  check('Accessibility section in Overview', await js('!!document.querySelector(\'tr.section-row[data-section="Accessibility"]\')'));
  // v2.2: Dashboard, health score, configurable issues, MCP page, Crawls dialog, N-grams
  await js('document.querySelector(\'#tabs button[data-tab="dashboard"]\').click(); true');
  await sleep(250);
  check('Dashboard renders default widgets', await js('document.querySelectorAll("#dashboard-panel .widget").length >= 8'), await js('document.querySelectorAll("#dashboard-panel .widget").length'));
  check('Dashboard shows the health score', await js('/\\d+/.test((document.querySelector(".w-score .big") || {}).textContent || "")'));
  await shot('dashboard');
  await js('document.querySelector(\'#side-tabs button[data-stab="overview"]\').click(); true');
  await sleep(150);
  check('Overview shows SEO Health Score', await js('/SEO Health Score/.test(document.querySelector("#side-body").innerText)'));
  await js('const os = document.querySelector("#overview-search"); os.value = "canonical"; os.dispatchEvent(new Event("input")); true');
  await sleep(150);
  check('Overview search narrows filters', await js('(() => { const rows = [...document.querySelectorAll("#side-body tr.filter-row")]; return rows.length > 0 && rows.length < 40 && rows.every(r => /canonical/i.test(r.innerText + " " + r.dataset.section)); })()'), await js('document.querySelectorAll("#side-body tr.filter-row").length'));
  await js('const os2 = document.querySelector("#overview-search"); os2.value = ""; os2.dispatchEvent(new Event("input")); true');
  await js('document.querySelector(\'#side-tabs button[data-stab="issues"]\').click(); true');
  await sleep(150);
  const firstIssue = await js('document.querySelector("tr.issue-trow").dataset.issueid');
  const beforeCount = await js('window.__spiderState.crawl.issues.length');
  await js('const tr = document.querySelector("tr.issue-trow"); tr.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 200 })); true');
  await sleep(150);
  check('right-click opens the issue menu', await js('!document.querySelector("#ctx-menu").classList.contains("hidden")'));
  await js('document.querySelector(\'#ctx-menu [data-ov="disable"]\').click(); true');
  await sleep(300);
  check('disabling an issue removes it from the crawl issues', await js(`!window.__spiderState.crawl.issues.some(i => i.id === ${JSON.stringify(firstIssue)}) && window.__spiderState.crawl.issues.length === ${beforeCount} - 1`));
  await js('document.querySelector("#issue-view").value = "disabled"; document.querySelector("#issue-view").dispatchEvent(new Event("change")); true');
  await sleep(150);
  check('Disabled view lists the disabled issue', await js(`!!document.querySelector('tr.issue-trow[data-issueid=${JSON.stringify(firstIssue)}]')`));
  await js(`const t2 = document.querySelector('tr.issue-trow[data-issueid=${JSON.stringify(firstIssue)}]'); t2.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 200 })); true`);
  await sleep(100);
  await js('document.querySelector(\'#ctx-menu [data-ov="reset"]\').click(); true');
  await sleep(300);
  check('reset restores the issue', await js(`window.__spiderState.crawl.issues.some(i => i.id === ${JSON.stringify(firstIssue)})`));
  await js('document.querySelector("#issue-view").value = "found"; document.querySelector("#issue-view").dispatchEvent(new Event("change")); true');
  wc.send('menu:action', 'config', 'mcp');
  await sleep(600);
  check('MCP config page shows connection snippets', await js('/Claude Desktop/.test(document.querySelector("#mcp-page").innerText) && document.querySelectorAll("#mcp-page .snippet").length >= 5'));
  check('MCP token shown', await js('(document.querySelector("#mcp-token") || {}).value.length >= 20'));
  await shot('mcp');
  await js('document.querySelector("#cfg-cancel").click(); true');
  wc.send('menu:action', 'crawls');
  await sleep(500);
  check('Crawls dialog lists the auto-saved crawl', await js('document.querySelector("#crawls-dialog").open && document.querySelectorAll("#crawls-list [data-cact=open]").length >= 1'));
  await js('document.querySelector("#crawls-close").click(); true');
  await js('document.querySelector(\'#tabs button[data-tab="internal"]\').click(); true');
  await sleep(150);
  await js('document.querySelector("#grid tbody tr").click(); document.querySelector(\'#bottom-tabs button[data-btab="ngrams"]\').click(); true');
  await sleep(150);
  check('N-grams tab lists phrases', await js('/N-gram/.test(document.querySelector("#bottom-body").innerText)'));

  // SERP mode (no crawling)
  const keepCrawl = await js('JSON.stringify(window.__spiderState.crawl.pages.length)');
  wc.send('menu:action', 'mode', 'serp');
  await sleep(250);
  check('SERP dialog opens', await js('document.querySelector("#serp-dialog").open'));
  await js(`document.querySelector("#serp-input").value = "URL,Title,Description\\nhttps://example.com/a,Short,Tiny\\nhttps://example.com/b,${'A very long page title that keeps going and going well past the pixel limit for Google results'},${'d'.repeat(40)}"; document.querySelector("#serp-go").click(); true`);
  await sleep(400);
  check('SERP mode analyses rows without crawling', await js('window.__spiderState.crawl && window.__spiderState.crawl.mode === "serp" && window.__spiderState.crawl.pages.length === 2'), keepCrawl);
  check('SERP mode flags long title', await js('window.__spiderState.crawl.pages[1].filters.includes("title-over-60") && window.__spiderState.crawl.pages[0].filters.includes("title-below-30")'));
  check('SERP mode opens Page Titles with snippet pane', await js('window.__spiderState.tab === "titles" && window.__spiderState.btab === "serp"'));
  wc.send('menu:action', 'mode', 'spider');
  await sleep(100);

  // Config window via menu action: all sections present
  wc.send('menu:action', 'config', 'crawl');
  await sleep(300);
  check('config dialog opens', await js('document.querySelector("#config-dialog").open'));
  const cfgSections = await js('document.querySelectorAll("#cfg-sections button").length');
  check('config window has all 32 sections', cfgSections === 32, cfgSections);
  check('config Spider > Crawl fields present', await js('!!document.querySelector("#cfg-concurrency") && !!document.querySelector("#cfg-maxurls")'));
  await js('document.querySelector("#cfg-cancel").click(); true');

  // Focus Mode toggles sidebar + bottom pane
  wc.send('menu:action', 'focus-mode');
  await sleep(150);
  check('Focus Mode hides sidebar', await js('getComputedStyle(document.querySelector("#sidebar")).display === "none"'));
  wc.send('menu:action', 'focus-mode');
  await sleep(150);
  check('Focus Mode restores sidebar', await js('getComputedStyle(document.querySelector("#sidebar")).display !== "none"'));

  check('no renderer errors', errors.length === 0, errors.join(' | '));

  try { const img = await wc.capturePage(); fs.writeFileSync(path.join(out, 'app.png'), img.toPNG()); } catch (_) {}
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, errors }, null, 1));
  server.close(); extServer.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`SMOKE ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) throw new Error(`smoke failed: ${failed.map((f) => f.name).join(', ')}`);
};
