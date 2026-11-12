'use strict';
/* robots.txt parsing + enforcement (simplified RFC 9309):
 * user-agent groups, Allow / Disallow rules, longest-match wins, Allow wins ties. */

function parseRobots(text) {
  const groups = []; // { agents: [lowercase], rules: [{type, path}] }
  let current = null;
  let sawRule = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || sawRule) { current = { agents: [], rules: [] }; groups.push(current); sawRule = false; }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'allow' || field === 'disallow') && current) {
      sawRule = true;
      if (value) current.rules.push({ type: field, path: value });
    }
  }
  return groups;
}

function ruleMatches(rulePath, path) {
  // Convert robots pattern (* wildcard, $ end anchor) to regex.
  let p = rulePath;
  const anchor = p.endsWith('$');
  if (anchor) p = p.slice(0, -1);
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + (anchor ? '$' : '')).test(path);
}

function isAllowed(groups, userAgent, url) {
  let pathname;
  try { const u = new URL(url); pathname = u.pathname + u.search; } catch (_) { return true; }
  const ua = String(userAgent || '*').toLowerCase();
  // Choose the most specific matching group: exact UA beats '*'.
  let group = null;
  for (const g of groups) if (g.agents.includes(ua)) { group = g; break; }
  if (!group) for (const g of groups) if (g.agents.includes('*')) { group = g; break; }
  if (!group) return true;
  let best = null;
  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, pathname)) continue;
    if (!best || rule.path.length > best.path.length ||
        (rule.path.length === best.path.length && rule.type === 'allow')) best = rule;
  }
  if (!best) return true;
  return best.type === 'allow';
}

module.exports = { parseRobots, isAllowed, ruleMatches };
