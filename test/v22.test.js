'use strict';
/* v2.2 tests: MCP server (protocol, HTTP auth + origin checks, stdio,
 * tools through an adapter), crawl store, link suggestions, social /
 * validation / markdown extraction, limits, Auto Throttle, AI prompts
 * (Ollama REST path against a local fake), configurable issues, health score. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { McpServer } = require('../src/main/mcp/protocol');
const { buildTools } = require('../src/main/mcp/tools');
const { CrawlStore } = require('../src/main/store');
const { suggestLinks } = require('../src/main/linksuggest');
const { parsePage } = require('../src/main/extract');
const { Crawler, finalizeCrawl, compareCrawls } = require('../src/main/crawler');
const { summariseIssues, healthScore, ISSUES } = require('../src/main/filters');
const { runPrompts } = require('../src/main/ai/prompts');
const { serpAnalyse } = require('../src/main/serp');

const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet '.repeat(10);
const listen = (handler) => new Promise((ok) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => ok(s)); });

async function fixtureCrawl() {
  const s = await listen((req, res) => {
    const u = new URL(req.url, 'http://x').pathname;
    if (u === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n'); }
    if (u === '/llms.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('# Site\n\n- [Home](http://x/)\n'); }
    res.writeHead(u === '/gone' ? 404 : 200, { 'Content-Type': 'text/html' });
    if (u === '/') return res.end(`<html lang="en"><head><title>Technical SEO Audit Services</title><meta property="og:title" content="Audit"><div>bad head</div></head><body><h1>Technical SEO Audit</h1><p>${WORDS}</p><a href="/blog">Blog</a><a href="/gone">gone</a><a href="/blog#missing-anchor">jump</a><a href="/blog"></a></body></html>`);
    return res.end(`<html lang="en"><head><title>Blog</title><meta name="viewport" content="width=device-width"></head><body><h1 id="top">Blog</h1><p>${WORDS} we offer a technical seo audit for every client.</p><a href="/">home</a></body></html>`);
  });
  const base = `http://127.0.0.1:${s.address().port}/`;
  const crawl = await new Crawler({ crawlExternal: false, storeHtml: true }).crawl([base], base);
  s.close();
  return { crawl, base };
}

test('crawl extracts social, validation, markdown, bookmarks, empty anchors and AI readiness', async () => {
  const { crawl, base } = await fixtureCrawl();
  const home = crawl.pages.find((p) => p.address === base);
  const has = (p, f) => (p.filters || []).includes(f);
  assert.strictEqual(home.social.ogTitle, 'Audit');
  assert.ok(has(home, 'soc-og-incomplete') && has(home, 'soc-tw-missing'));
  assert.deepStrictEqual(home.validation.invalidInHead, ['div']);
  assert.ok(has(home, 'val-invalid-head'));
  assert.ok(home.markdown.startsWith('# Technical SEO Audit'));
  assert.ok(has(home, 'url-broken-bookmarks'), 'link to /blog#missing-anchor is a broken bookmark');
  assert.ok(has(home, 'links-empty-anchor'));
  assert.ok(has(home, 'mob-viewport-missing') && !has(crawl.pages.find((p) => p.address === base + 'blog'), 'mob-viewport-missing'));
  assert.ok(crawl.aiReadiness && crawl.aiReadiness.llmsTxt.valid);
  assert.strictEqual(crawl.aiReadiness.bots.find((b) => b.bot === 'GPTBot').allowedRoot, false);
  assert.strictEqual(crawl.aiReadiness.bots.find((b) => b.bot === 'ClaudeBot').allowedRoot, true);
  assert.ok(home.aiBlockedBots.includes('GPTBot') && has(home, 'ai-blocked-some') && !has(home, 'ai-blocked-search'));
  assert.ok(crawl.health && crawl.health.score >= 0 && crawl.health.score <= 100);
  const sugg = suggestLinks(crawl.pages, { maxInlinks: 5 });
  assert.ok(sugg.some((x) => x.target === base && x.source === base + 'blog' && x.anchor === 'technical seo audit') === false, 'blog already links home, so no suggestion');
});

test('configurable issues: disable and retype change the summary and the health score', () => {
  const pages = [{ address: 'a', filters: ['title-missing', 'h1-missing'] }, { address: 'b', filters: ['title-all'] }];
  const base = summariseIssues(pages);
  const t = base.find((i) => i.id === 'iss-title-missing');
  assert.ok(t && t.type === 'Issue');
  const ov = summariseIssues(pages, { 'iss-title-missing': { type: 'Opportunity', priority: 'Low' }, 'iss-h1-missing': { disabled: true } });
  assert.strictEqual(ov.find((i) => i.id === 'iss-title-missing').type, 'Opportunity');
  assert.ok(!ov.some((i) => i.id === 'iss-h1-missing'));
  assert.ok(healthScore(ov).score > healthScore(base).score);
  assert.strictEqual(healthScore([]).score, 100);
  for (const i of ISSUES) assert.ok(i.howToFix, i.id + ' has How To Fix');
});

test('Spider > Limits: URLs per depth, query strings and folder depth', async () => {
  const s = await listen((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<html><head><title>t</title></head><body><a href="/a/b/c/deep">d</a><a href="/q?x=1&y=2">q</a><a href="/one">1</a><a href="/two">2</a><a href="/three">3</a></body></html>`); });
  const base = `http://127.0.0.1:${s.address().port}/`;
  try {
    const cr = await new Crawler({ respectRobots: false, crawlExternal: false, checkAiReadiness: false, maxFolderDepth: 1, maxQueryStrings: 1, limitUrlsPerDepth: 2 }).crawl([base], base);
    const paths = cr.pages.filter((p) => !p.sitemapOnly).map((p) => new URL(p.address).pathname + new URL(p.address).search);
    assert.ok(!paths.includes('/a/b/c/deep') && !paths.includes('/q?x=1&y=2'));
    assert.strictEqual(cr.pages.filter((p) => p.depth === 1).length, 2, 'only 2 URLs at depth 1 (the limit applies per depth)');
  } finally { s.close(); }
});

test('Auto Throttle retries 429 responses and recovers', async () => {
  let hits = 0;
  const s = await listen((req, res) => { if (req.url === '/' && hits++ < 2) { res.writeHead(429, { 'Retry-After': '0' }); return res.end(); } res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><head><title>ok page</title></head><body>ok</body></html>'); });
  const base = `http://127.0.0.1:${s.address().port}/`;
  try {
    const c = new Crawler({ respectRobots: false, checkAiReadiness: false, rateLimitRetries: 3 });
    const cr = await c.crawl([base], base);
    assert.strictEqual(cr.pages.find((p) => p.address === base).statusCode, 200);
    assert.ok(cr.throttle.events >= 2);
  } finally { s.close(); }
});

test('crawl store saves, lists, locks, prunes and compares', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  try {
    const st = new CrawlStore(dir);
    const id = st.save({ rootUrl: 'https://a.com/', startedAt: new Date().toISOString(), pages: [{ address: 'https://a.com/', filters: [] }], stats: { total: 1 }, issues: [], health: { score: 90 } });
    assert.strictEqual(st.list()[0].score, 90);
    st.setLocked(id, true); st.rename(id, 'Before launch');
    assert.strictEqual(st.list()[0].name, 'Before launch');
    assert.strictEqual(st.prune({ maxCount: 0, days: 0 }), 0);
    assert.strictEqual(st.load(id).rootUrl, 'https://a.com/');
    assert.throws(() => st.load('../../etc/passwd'));
    st.setLocked(id, false); st.remove(id); assert.strictEqual(st.list().length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fakeApp(crawl, opts = {}) {
  let cfg = { maxUrls: 100, userAgent: 'x' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
  const store = new CrawlStore(dir);
  return {
    dir, getCrawl: () => crawl, setCrawl: (c) => { crawl = c; }, store,
    startCrawl: async () => crawl, progress: () => ({ running: false }), control: () => ({}),
    getConfig: () => cfg, setConfig: (ch) => { cfg = { ...cfg, ...ch }; return ch; },
    permissions: () => ({ allowCrawl: opts.allowCrawl !== false, allowConfig: true, allowFiles: false }),
    buildReport: () => ({ filename: 'x.csv', content: 'a,b' }), saveExport: () => '/tmp/x',
    serpAnalyse, compare: compareCrawls, analyzeUrl: async () => crawl,
  };
}

test('MCP: initialize, tools/list, tools/call and prompts over stdio', async () => {
  const { crawl, base } = await fixtureCrawl();
  const app = fakeApp(crawl);
  const { tools, prompts } = buildTools(app);
  const server = new McpServer({ name: 'seonfix-spider', version: 't', tools, prompts });
  const input = new PassThrough(); const output = new PassThrough();
  server.serveStdio({ input, output });
  const replies = [];
  output.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => replies.push(JSON.parse(l))));
  const send = (m) => input.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spider_overview', arguments: {} } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'spider_get_issue', arguments: { issue: 'iss-4xx' } } });
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'spider_url_links', arguments: { url: base, direction: 'outlinks' } } });
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'spider_nope', arguments: {} } });
  send({ jsonrpc: '2.0', id: 7, method: 'prompts/get', params: { name: 'seo_audit', arguments: { url: 'https://x.com' } } });
  send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'spider_url_content', arguments: { url: base, format: 'markdown' } } });
  input.write('{not json\n');
  await new Promise((r) => setTimeout(r, 300));
  const by = (id) => replies.find((r) => r.id === id);
  assert.strictEqual(by(1).result.protocolVersion, '2025-06-18');
  assert.strictEqual(by(1).result.serverInfo.name, 'seonfix-spider');
  assert.ok(by(2).result.tools.length >= 20 && by(2).result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
  assert.ok(by(3).result.structuredContent.stats.total >= 2);
  const iss = by(4).result.structuredContent; assert.strictEqual(iss.totalUrls, 1); assert.ok(iss.howToFix && iss.urls[0].address.endsWith('/gone'));
  assert.ok(by(5).result.structuredContent.links.some((l) => l.status === 404));
  assert.strictEqual(by(6).error.code, -32602);
  assert.ok(by(7).result.messages[0].content.text.includes('https://x.com'));
  assert.ok(by(8).result.structuredContent.content.startsWith('# Technical SEO Audit'));
  assert.ok(replies.some((r) => r.error && r.error.code === -32700), 'parse error reported');
  assert.ok(!replies.some((r) => r.id === undefined && r.result), 'no reply to notifications');
  fs.rmSync(app.dir, { recursive: true, force: true });
});

test('MCP over HTTP requires the bearer token, rejects foreign origins and honours permissions', async () => {
  const app = fakeApp(null, { allowCrawl: false });
  const { tools } = buildTools(app);
  const srv = await new McpServer({ name: 's', version: '1', tools }).serveHttp({ port: 0, token: 'secret-token-123' });
  const url = `http://127.0.0.1:${srv.address().port}/mcp`;
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
  try {
    assert.strictEqual((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
    assert.strictEqual((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer wrong-token-xxx' })).status, 401);
    assert.strictEqual((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer secret-token-123', Origin: 'https://evil.example' })).status, 403);
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, { Authorization: 'Bearer secret-token-123' });
    assert.strictEqual(init.status, 200); assert.ok(init.headers.get('mcp-session-id'));
    assert.strictEqual((await init.json()).result.protocolVersion, '2025-03-26');
    const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { Authorization: 'Bearer secret-token-123' });
    assert.strictEqual(note.status, 202);
    const crawl = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spider_crawl', arguments: { url: 'https://example.com' } } }, { Authorization: 'Bearer secret-token-123' })).json();
    assert.strictEqual(crawl.result.isError, true); assert.match(crawl.result.content[0].text, /turned off/);
    const ov = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spider_overview', arguments: {} } }, { Authorization: 'Bearer secret-token-123' })).json();
    assert.match(ov.result.content[0].text, /No crawl is loaded/);
    const get = await fetch(url, { headers: { Authorization: 'Bearer secret-token-123' } });
    assert.strictEqual(get.status, 405);
  } finally { srv.close(); fs.rmSync(app.dir, { recursive: true, force: true }); }
});

test('AI prompts run per page through a provider (local Ollama-compatible fake)', async () => {
  const seen = [];
  const s = await listen((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { const j = JSON.parse(b); seen.push(j); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: { content: 'informational' } })); }); });
  try {
    const pages = [{ address: 'https://a.com/', contentCategory: 'HTML', statusCode: 200, textExcerpt: 'hello world', title: 'Hi' }, { address: 'https://a.com/x', external: true, contentCategory: 'HTML', statusCode: 200 }];
    const r = await runPrompts(pages, { provider: 'ollama', baseUrl: `http://127.0.0.1:${s.address().port}`, model: 'm', prompts: [{ name: 'Intent', target: 'page text', prompt: 'Classify intent' }] });
    assert.strictEqual(r.done, 1); assert.strictEqual(pages[0].ai.Intent, 'informational'); assert.ok(!pages[1].ai);
    assert.ok(seen[0].messages[1].content.includes('<page_content>\nhello world'));
    await assert.rejects(runPrompts(pages, { provider: 'anthropic', prompts: [{ name: 'x', target: 'title', prompt: 'p' }] }), /API key/);
  } finally { s.close(); }
});
