'use strict';
/* Claude (Anthropic) provider for AI prompts, via the official SDK. */
const Anthropic = require('@anthropic-ai/sdk');
const AnthropicClient = Anthropic.default || Anthropic;

const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const DEFAULT_MODEL = 'claude-opus-5-5';
// Models that accept the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

async function complete({ apiKey, model, system, prompt, maxTokens = 16000, effort = 'low' }) {
  const client = new AnthropicClient({ apiKey });
  const m = model || DEFAULT_MODEL;
  const params = {
    model: m,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
    // per-page SEO prompts are short, routine tasks: keep effort low to control cost
    output_config: { effort },
  };
  let response;
  if (FALLBACK_MODELS.has(m)) {
    response = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } else {
    response = await client.messages.create(params);
  }
  if (response.stop_reason === 'refusal') {
    const why = response.stop_details && (response.stop_details.explanation || response.stop_details.category);
    throw new Error('Claude declined this request' + (why ? ': ' + why : ''));
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { text, model: response.model, truncated: response.stop_reason === 'max_tokens' };
}

function describeError(err) {
  if (err instanceof AnthropicClient.AuthenticationError) return 'Invalid Anthropic API key';
  if (err instanceof AnthropicClient.RateLimitError) return 'Anthropic rate limit reached - try again later or lower the URL limit';
  if (err instanceof AnthropicClient.BadRequestError) return 'Anthropic rejected the request: ' + err.message;
  if (err instanceof AnthropicClient.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return String(err && err.message || err);
}

module.exports = { complete, describeError, CLAUDE_MODELS, DEFAULT_MODEL };
