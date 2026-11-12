'use strict';
/* Visualisation window: Crawl Tree (radial), Directory Tree, Force Directed. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let view = 'crawl-tree';
let crawl = null;
let raf = null;

function colorFor(p) { return p.statusCode >= 500 ? '#8B2E2E' : p.statusCode >= 400 ? '#D64541' : p.statusCode >= 300 ? '#F5A623' : p.statusCode >= 200 ? '#00C852' : '#9AA0A6'; }

function render() {
  const body = document.getElementById('vis-body');
  document.querySelectorAll('#vis-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (raf) cancelAnimationFrame(raf);
  if (!crawl) { body.textContent = 'No crawl data yet. Run a crawl in the main window first.'; return; }
  const pages = crawl.pages.filter((p) => !p.external).slice(0, 400);
  if (view === 'directory-tree') {
    const dirs = {};
    for (const p of pages) { const d = directoryOf(p.address); dirs[d] = (dirs[d] || 0) + 1; }
    body.innerHTML = '<h3>Directory Tree</h3>' + Object.entries(dirs).sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => {
      const depth = d.replace(/^https?:\/\/[^/]+/, '').split('/').filter(Boolean).length;
      return `<div class="dir-line">${'  '.repeat(depth)}${esc(d)} <span style="color:#9fb0bf">(${n} URLs)</span></div>`;
    }).join('');
    return;
  }
  if (view === 'force') return renderForce(body, pages);
  // crawl tree (radial by depth, lines to path ancestor)
  const W = 1000, H = 620, cx = W / 2, cy = H / 2;
  const byDepth = {};
  pages.forEach((p) => { (byDepth[p.depth || 0] = byDepth[p.depth || 0] || []).push(p); });
  const pos = new Map();
  Object.entries(byDepth).forEach(([depth, list]) => {
    const r = 30 + Number(depth) * 85;
    list.forEach((p, i) => { const a = (i / Math.max(1, list.length)) * Math.PI * 2 + Number(depth) * 0.4; pos.set(p.address, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), p }); });
  });
  const parentOf = (p) => {
    const parts = new URL(p.address).pathname.split('/').filter(Boolean);
    for (let n = parts.length - 1; n >= 0; n--) {
      const cand = new URL(p.address); cand.pathname = '/' + parts.slice(0, n).join('/') + (n ? '/' : '');
      const c = pages.find((q) => q.address === cand.toString() || q.address === cand.toString().replace(/\/$/, ''));
      if (c && c.address !== p.address) return c;
    }
    return pages[0] !== p ? pages[0] : null;
  };
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (const { x, y, p } of pos.values()) { const par = parentOf(p); if (par && pos.has(par.address)) { const pp = pos.get(par.address); svg += `<line x1="${pp.x}" y1="${pp.y}" x2="${x}" y2="${y}" stroke="#39424d" stroke-width="1"/>`; } }
  for (const { x, y, p } of pos.values()) svg += `<circle cx="${x}" cy="${y}" r="5" fill="${colorFor(p)}"><title>${esc(p.address)} (${esc(p.statusCode)})</title></circle>`;
  svg += '</svg>';
  body.innerHTML = '<h3>Crawl Tree Graph</h3><p class="hint">Ring = crawl depth. Green 2xx, orange 3xx, red 4xx/5xx, grey no response.</p>' + svg;
}

function directoryOf(address) {
  try { const u = new URL(address); const parts = u.pathname.split('/').filter(Boolean); return u.origin + '/' + (parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : ''); } catch (_) { return '/'; }
}

function renderForce(body, pages) {
  const W = 1000, H = 620;
  const nodes = pages.slice(0, 200).map((p, i) => ({ p, x: W / 2 + (Math.random() - 0.5) * 500, y: H / 2 + (Math.random() - 0.5) * 340, vx: 0, vy: 0 }));
  const byAddr = new Map(nodes.map((n) => [n.p.address, n]));
  const edges = [];
  for (const n of nodes) for (const l of n.p.links || []) { const t = byAddr.get(l.url); if (t && t !== n) edges.push([n, t]); }
  body.innerHTML = '<h3>Force Directed Graph</h3><p class="hint">Nodes repel, links attract. Hover a node for its URL.</p><svg id="force-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '"></svg>';
  const svg = document.getElementById('force-svg');
  let iter = 0;
  const step = () => {
    iter++;
    for (const n of nodes) { n.vx += (W / 2 - n.x) * 0.002; n.vy += (H / 2 - n.y) * 0.002; }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y; let d2 = dx * dx + dy * dy || 1;
      const f = 900 / d2; dx *= f; dy *= f; a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
    }
    for (const [a, b] of edges) { const dx = b.x - a.x, dy = b.y - a.y; a.vx += dx * 0.01; a.vy += dy * 0.01; b.vx -= dx * 0.01; b.vy -= dy * 0.01; }
    for (const n of nodes) { n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx; n.y += n.vy; }
    svg.innerHTML = edges.map(([a, b]) => `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#2c353f" stroke-width="1"/>`).join('') +
      nodes.map((n) => `<circle cx="${n.x}" cy="${n.y}" r="4.5" fill="${colorFor(n.p)}"><title>${esc(n.p.address)}</title></circle>`).join('');
    if (iter < 160) raf = requestAnimationFrame(step);
  };
  step();
}

document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('#vis-tabs button').forEach((b) => b.addEventListener('click', () => { view = b.dataset.view; render(); }));
  if (window.spider && window.spider.onVisView) window.spider.onVisView((v) => { view = v || 'crawl-tree'; render(); });
  try { crawl = await window.spider.visGetData(); } catch (_) {}
  render();
});
