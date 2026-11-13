'use strict';
/* Minimal Model Context Protocol server core (JSON-RPC 2.0) plus two
 * transports: stdio (launched by an AI client, e.g. Claude Desktop) and
 * Streamable HTTP on 127.0.0.1 (the running app, bearer-token protected).
 * Implements initialize, ping, tools/list, tools/call, prompts/list,
 * prompts/get and resources/list (empty). No external dependencies. */
const http = require('node:http');
const crypto = require('node:crypto');
const readline = require('node:readline');

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

class McpServer {
  constructor({ name, version, instructions, tools, prompts = [], log = () => {} }) {
    this.info = { name, version };
    this.instructions = instructions;
    this.tools = tools; // [{ name, description, inputSchema, annotations?, handler(args, ctx) }]
    this.prompts = prompts; // [{ name, description, arguments, render(args) -> text }]
    this.log = log;
  }

  toolList() {
    return this.tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, ...(title ? { title } : {}), description, inputSchema, ...(annotations ? { annotations } : {}) }));
  }

  async handle(msg, ctx = {}) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg && msg.id !== undefined ? this.error(msg.id, -32600, 'Invalid Request') : null;
    }
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      const result = await this.dispatch(msg.method, msg.params || {}, ctx);
      if (isNotification) return null;
      return { jsonrpc: '2.0', id: msg.id, result };
    } catch (e) {
      if (isNotification) return null;
      return this.error(msg.id, e.code || -32603, e.message || String(e));
    }
  }

  error(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

  async dispatch(method, params, ctx) {
    switch (method) {
      case 'initialize': {
        const v = SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0];
        return { protocolVersion: v, capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false } }, serverInfo: this.info, instructions: this.instructions };
      }
      case 'notifications/initialized': case 'notifications/cancelled': return {};
      case 'ping': return {};
      case 'tools/list': return { tools: this.toolList() };
      case 'tools/call': {
        const tool = this.tools.find((t) => t.name === params.name);
        if (!tool) { const e = new Error('Unknown tool: ' + params.name); e.code = -32602; throw e; }
        try {
          const out = await tool.handler(params.arguments || {}, ctx);
          const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
          return { content: [{ type: 'text', text }], ...(out && typeof out === 'object' && !Array.isArray(out) ? { structuredContent: out } : {}), isError: false };
        } catch (e) {
          this.log('tool error', params.name, e && e.message);
          return { content: [{ type: 'text', text: 'Error: ' + (e && e.message || String(e)) }], isError: true };
        }
      }
      case 'prompts/list': return { prompts: this.prompts.map(({ name, title, description, arguments: a }) => ({ name, ...(title ? { title } : {}), description, arguments: a || [] })) };
      case 'prompts/get': {
        const p = this.prompts.find((x) => x.name === params.name);
        if (!p) { const e = new Error('Unknown prompt: ' + params.name); e.code = -32602; throw e; }
        return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.render(params.arguments || {}) } }] };
      }
      case 'resources/list': return { resources: [] };
      case 'resources/templates/list': return { resourceTemplates: [] };
      default: { const e = new Error('Method not found: ' + method); e.code = -32601; throw e; }
    }
  }

  /* stdio: newline-delimited JSON-RPC on stdin/stdout. stdout must carry
   * protocol messages only, so all logging goes to stderr. */
  serveStdio({ input = process.stdin, output = process.stdout } = {}) {
    const rl = readline.createInterface({ input });
    const write = (obj) => output.write(JSON.stringify(obj) + '\n');
    rl.on('line', async (line) => {
      if (!line.trim()) return;
      let msg; try { msg = JSON.parse(line); } catch (_) { write(this.error(null, -32700, 'Parse error')); return; }
      const batch = Array.isArray(msg) ? msg : [msg];
      const replies = (await Promise.all(batch.map((m) => this.handle(m, { transport: 'stdio' })))).filter(Boolean);
      if (Array.isArray(msg)) { if (replies.length) write(replies); } else if (replies[0]) write(replies[0]);
    });
    return rl;
  }

  /* Streamable HTTP (POST /mcp -> JSON response). Bound to 127.0.0.1 only,
   * requires "Authorization: Bearer <token>" and rejects foreign Origins
   * (DNS-rebinding protection). */
  serveHttp({ port, token, host = '127.0.0.1' }) {
    const sessions = new Set();
    const server = http.createServer(async (req, res) => {
      const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)); };
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/mcp') return send(404, { error: 'Not found. The MCP endpoint is /mcp' });
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) return send(403, { error: 'Forbidden origin' });
      const auth = String(req.headers.authorization || '');
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const ok = given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
      if (!ok) return send(401, { error: 'Missing or invalid bearer token. Copy the token from Seonfix Spider > Configuration > MCP Server.' }, { 'WWW-Authenticate': 'Bearer' });
      if (req.method === 'GET') return send(405, { error: 'This server does not offer an SSE stream; use POST.' }, { Allow: 'POST, DELETE' });
      if (req.method === 'DELETE') { sessions.delete(req.headers['mcp-session-id']); return send(204); }
      if (req.method !== 'POST') return send(405, { error: 'Method not allowed' }, { Allow: 'POST, DELETE' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 5 * 1024 * 1024) return send(413, { error: 'Request too large' }); }
      let msg; try { msg = JSON.parse(raw); } catch (_) { return send(400, this.error(null, -32700, 'Parse error')); }
      const batch = Array.isArray(msg) ? msg : [msg];
      const headers = {};
      if (batch.some((m) => m && m.method === 'initialize')) { const sid = crypto.randomUUID(); sessions.add(sid); headers['Mcp-Session-Id'] = sid; }
      const replies = (await Promise.all(batch.map((m) => this.handle(m, { transport: 'http' })))).filter(Boolean);
      if (!replies.length) return send(202, undefined, headers);
      return send(200, Array.isArray(msg) ? replies : replies[0], headers);
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server); });
    });
  }
}

module.exports = { McpServer, SUPPORTED_VERSIONS };
