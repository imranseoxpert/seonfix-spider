'use strict';
/* Client-ready SEO audit report (v2.2, beyond SF): one self-contained HTML
 * file (print / Save as PDF friendly) with the health score, prioritised
 * issues with How To Fix and example URLs, AI readiness and internal link
 * opportunities. */
const { suggestLinks } = require('./linksuggest');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function gauge(score) {
  const r = 52; const c = 2 * Math.PI * r; const off = c * (1 - score / 100);
  const col = score >= 75 ? '#00A344' : score >= 50 ? '#E8A317' : '#D64541';
  return `<svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Health score ${score} of 100"><circle cx="70" cy="70" r="${r}" fill="none" stroke="#e6e9ee" stroke-width="14"/><circle cx="70" cy="70" r="${r}" fill="none" stroke="${col}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 70 70)"/><text x="70" y="78" text-anchor="middle" font-size="34" font-weight="700" fill="#1d2433">${score}</text></svg>`;
}

function buildAuditHtml(crawl, { brand = 'Seonfix Spider' } = {}) {
  const st = crawl.stats || {}; const h = crawl.health || { score: 0, grade: '-' };
  const issues = crawl.issues || [];
  const urlsFor = (i) => crawl.pages.filter((p) => (i.filterId ? (p.filters || []).includes(i.filterId) : (p.issues || []).includes(i.name))).slice(0, 5).map((p) => p.address);
  const byPrio = ['High', 'Medium', 'Low'].map((pr) => [pr, issues.filter((i) => i.priority === pr)]);
  const typeCls = { Issue: 'iss', Warning: 'warn', Opportunity: 'opp' };
  const issueBlocks = byPrio.map(([pr, list]) => list.length ? `<h3>${pr} priority (${list.length})</h3>` + list.map((i) => `<div class="issue"><div class="ih"><span class="tag ${typeCls[i.type]}">${esc(i.type)}</span><b>${esc(i.name)}</b><span class="cnt">${i.count} URLs (${i.pct}%)</span></div><p>${esc(i.description)}</p><p class="fix"><b>How to fix:</b> ${esc(i.howToFix || '')}</p>${urlsFor(i).length ? '<ul class="urls">' + urlsFor(i).map((u) => `<li>${esc(u)}</li>`).join('') + (i.count > 5 ? `<li class="more">+ ${i.count - 5} more</li>` : '') + '</ul>' : ''}</div>`).join('') : '').join('');
  const ai = crawl.aiReadiness;
  const aiHtml = ai ? `<table><tr><th>AI crawler</th><th>Owner</th><th>Purpose</th><th>Homepage access</th></tr>${ai.bots.map((b) => `<tr><td>${esc(b.bot)}</td><td>${esc(b.owner)}</td><td>${esc(b.purpose)}</td><td class="${b.allowedRoot ? 'ok' : 'bad'}">${b.allowedRoot ? 'Allowed' : 'Blocked'}</td></tr>`).join('')}</table><p>llms.txt: <b class="${ai.llmsTxt.valid ? 'ok' : 'bad'}">${ai.llmsTxt.valid ? 'Present' : ai.llmsTxt.status === 200 ? 'Present but not valid Markdown' : 'Not found'}</b> &middot; llms-full.txt: <b>${ai.llmsFullTxt.valid ? 'Present' : 'Not found'}</b></p>` : '<p>AI readiness was not checked for this crawl.</p>';
  const sugg = suggestLinks(crawl.pages, { limit: 15 });
  const suggHtml = sugg.length ? `<table><tr><th>Add a link on</th><th>Pointing to</th><th>Suggested anchor</th></tr>${sugg.map((s) => `<tr><td>${esc(s.source)}</td><td>${esc(s.target)}</td><td>${esc(s.anchor)}</td></tr>`).join('')}</table>` : '<p>No obvious internal link opportunities were found.</p>';
  const counts = issues.reduce((a, i) => { a[i.type] = (a[i.type] || 0) + 1; return a; }, {});
  const date = new Date(crawl.startedAt || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SEO Audit - ${esc(crawl.rootUrl)}</title><style>
:root{--g:#00A344;--ink:#1d2433;--mute:#5b6577;--line:#e3e7ee}*{box-sizing:border-box}body{font:14px/1.55 -apple-system,"Segoe UI",Arial,sans-serif;color:var(--ink);margin:0;background:#f6f8fa}
.wrap{max-width:980px;margin:0 auto;padding:32px 28px;background:#fff}header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid var(--g);padding-bottom:16px;gap:20px}
h1{margin:0;font-size:26px}h2{margin:34px 0 10px;font-size:19px;border-bottom:1px solid var(--line);padding-bottom:6px}h3{margin:22px 0 8px;font-size:15px;color:var(--mute)}
.brand{color:var(--g);font-weight:700}.meta{color:var(--mute)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:18px}
.card{border:1px solid var(--line);border-radius:8px;padding:12px}.card .n{font-size:22px;font-weight:700}.card .l{color:var(--mute);font-size:12px}
.score{display:flex;align-items:center;gap:14px}.grade{font-size:15px;color:var(--mute)}.issue{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0;page-break-inside:avoid}
.ih{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.cnt{margin-left:auto;color:var(--mute)}.tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;color:#fff}
.tag.iss{background:#D64541}.tag.warn{background:#E8A317}.tag.opp{background:#4A90D9}.fix{background:#f2faf5;border-left:3px solid var(--g);padding:6px 10px}
.urls{margin:6px 0 0;padding-left:18px;color:var(--mute);font-size:12.5px;word-break:break-all}.more{list-style:none;font-style:italic}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;word-break:break-word}th{background:#f3f5f8}
.ok{color:var(--g)}.bad{color:#D64541}footer{margin-top:40px;color:var(--mute);font-size:12px;border-top:1px solid var(--line);padding-top:10px}
@media print{body{background:#fff}.wrap{padding:0}.noprint{display:none}}</style></head><body><div class="wrap">
<header><div><div class="brand">${esc(brand)}</div><h1>SEO Audit Report</h1><div class="meta">${esc(crawl.rootUrl)} &middot; crawled ${esc(date)}</div></div><div class="score">${gauge(h.score)}<div><b>Health score</b><div class="grade">Grade ${esc(h.grade)}</div></div></div></header>
<div class="cards"><div class="card"><div class="n">${st.internal ?? '-'}</div><div class="l">Internal URLs</div></div><div class="card"><div class="n">${st.indexable ?? '-'}</div><div class="l">Indexable</div></div><div class="card"><div class="n">${st.errors4xx ?? 0}</div><div class="l">4xx errors</div></div><div class="card"><div class="n">${st.redirects ?? 0}</div><div class="l">Redirects</div></div><div class="card"><div class="n">${counts.Issue || 0} / ${counts.Warning || 0} / ${counts.Opportunity || 0}</div><div class="l">Issues / Warnings / Opportunities</div></div></div>
<h2>Prioritised issues</h2>${issueBlocks || '<p>No issues found.</p>'}
<h2>AI search readiness</h2>${aiHtml}
<h2>Internal linking opportunities</h2>${suggHtml}
<footer>Generated by Seonfix Spider on ${esc(new Date().toLocaleString('en-GB'))}. Counts reflect the crawl configuration used.</footer></div></body></html>`;
}

module.exports = { buildAuditHtml };
