'use strict';
/* OpenAI, Gemini and Ollama providers for AI prompts (plain REST calls). */
async function postJson(url, headers, body, timeoutMs = 120000) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  if (!r.ok) throw new Error(`${r.status} ${(j && (j.error && (j.error.message || j.error))) || text.slice(0, 200)}`);
  return j || {};
}

const openai = {
  defaultModel: 'gpt-5-mini',
  async complete({ apiKey, model, system, prompt }) {
    const j = await postJson('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${apiKey}` }, { model: model || this.defaultModel, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] });
    return { text: String((((j.choices || [])[0] || {}).message || {}).content || '').trim(), model: j.model || model };
  },
};

const gemini = {
  defaultModel: 'gemini-2.5-flash',
  async complete({ apiKey, model, system, prompt }) {
    const m = model || this.defaultModel;
    const j = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, { 'x-goog-api-key': apiKey }, { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] });
    const parts = ((((j.candidates || [])[0] || {}).content || {}).parts) || [];
    return { text: parts.map((p) => p.text || '').join('').trim(), model: m };
  },
};

const ollama = {
  defaultModel: 'llama3.2',
  async complete({ baseUrl, model, system, prompt }) {
    const j = await postJson(`${(baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/api/chat`, {}, { model: model || this.defaultModel, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }, 300000);
    return { text: String((j.message || {}).content || '').trim(), model: model || this.defaultModel };
  },
};

module.exports = { openai, gemini, ollama };
