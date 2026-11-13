'use strict';
/* Crawl store (v2.2): every finished crawl is auto-saved under
 * <userData>/crawls with a small index, so crawls can be reopened from
 * File > Crawls, compared, and read by AI assistants over MCP. Old crawls are
 * removed after the retention period unless locked. Pure Node (no Electron). */
const fs = require('node:fs');
const path = require('node:path');

class CrawlStore {
  constructor(baseDir) {
    this.dir = path.join(baseDir, 'crawls');
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexPath = path.join(this.dir, 'index.json');
  }
  readIndex() { try { return JSON.parse(fs.readFileSync(this.indexPath, 'utf8')); } catch (_) { return []; } }
  writeIndex(list) { fs.writeFileSync(this.indexPath, JSON.stringify(list, null, 1)); }
  makeId(crawl) {
    let host = 'crawl'; try { host = new URL(crawl.rootUrl).host.replace(/[^a-z0-9.-]/gi, '_'); } catch (_) {}
    const stamp = new Date(crawl.startedAt || Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${stamp}_${host}_${Math.random().toString(36).slice(2, 6)}`;
  }
  save(crawl, { name } = {}) {
    const id = crawl.storeId || this.makeId(crawl);
    crawl.storeId = id;
    const file = path.join(this.dir, id + '.json');
    fs.writeFileSync(file, JSON.stringify(crawl));
    const list = this.readIndex().filter((x) => x.id !== id);
    list.unshift({ id, name: name || '', rootUrl: crawl.rootUrl, mode: crawl.mode, startedAt: crawl.startedAt, savedAt: new Date().toISOString(), total: (crawl.stats || {}).total || (crawl.pages || []).length, issues: (crawl.issues || []).length, score: crawl.health ? crawl.health.score : null, locked: false, size: fs.statSync(file).size });
    this.writeIndex(list);
    return id;
  }
  list() { return this.readIndex().filter((x) => fs.existsSync(path.join(this.dir, x.id + '.json'))); }
  pathFor(id) { const safe = String(id).replace(/[^a-zA-Z0-9_.-]/g, ''); return path.join(this.dir, safe + '.json'); }
  load(id) { const f = this.pathFor(id); if (!fs.existsSync(f)) throw new Error('No saved crawl with id ' + id); return JSON.parse(fs.readFileSync(f, 'utf8')); }
  remove(id) { try { fs.unlinkSync(this.pathFor(id)); } catch (_) {} this.writeIndex(this.readIndex().filter((x) => x.id !== id)); }
  setLocked(id, locked) { this.writeIndex(this.readIndex().map((x) => (x.id === id ? { ...x, locked: !!locked } : x))); }
  rename(id, name) { this.writeIndex(this.readIndex().map((x) => (x.id === id ? { ...x, name: String(name || '') } : x))); }
  /* Delete unlocked crawls older than `days` (0 = keep forever); keep at most `maxCount`. */
  prune({ days = 0, maxCount = 0 } = {}) {
    const now = Date.now(); let removed = 0;
    let list = this.readIndex();
    for (const x of [...list]) {
      const old = days > 0 && now - new Date(x.savedAt || x.startedAt || 0).getTime() > days * 86400000;
      if (old && !x.locked) { this.remove(x.id); removed++; }
    }
    list = this.readIndex();
    if (maxCount > 0) { const unlocked = list.filter((x) => !x.locked); for (const x of unlocked.slice(maxCount)) { this.remove(x.id); removed++; } }
    return removed;
  }
}

module.exports = { CrawlStore };
