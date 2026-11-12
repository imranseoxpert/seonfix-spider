'use strict';
// Launches the real Electron app in self-test mode. Usage: node scripts/run-smoke.js [outputDir]
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const out = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'spider-smoke-')));
fs.mkdirSync(out, { recursive: true });
const bin = require('electron');
const r = spawnSync(bin, [path.join(__dirname, '..'), '--no-sandbox'], { stdio: 'inherit', env: { ...process.env, SPIDER_SMOKE: out }, timeout: 120000 });
console.log(`Smoke output: ${out}`);
process.exit(r.status == null ? 1 : r.status);
