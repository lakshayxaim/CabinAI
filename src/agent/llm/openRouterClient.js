/**
 * OpenRouter LLM Provider for CabinAI Session 3.
 *
 * Used as fallback when Gemini encounters retryable failures (rate limit, 503, etc.).
 * Connects via the OpenAI-compatible REST API that OpenRouter exposes.
 * API key sourced exclusively from OPENROUTER_API_KEY environment variable.
 *
 * Normalizes OpenRouter responses to the common LLMResponse format so the
 * agent loop is completely provider-agnostic.
 *
 * No external SDK is used — only Node.js built-in https.
 */

'use strict';

const https = require('https');
const { LLMProvider, LLMResponse, RetryableProviderError } = require('./llmClient');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

class OpenRouterProvider extends LLMProvider {
  /**
   * @param {Object} config
   * @param {string} [config.model]   - OpenRouter model ID, default 'openai/gpt-4o-mini'
   * @param {string} [config.apiKey]  - Override; default: process.env.OPENROUTER_API_KEY
   * @param {string} [config.baseUrl] - Override base URL (useful for tests)
   */
  constructor(config = {}) {
    super(config);
    this.providerName = 'openrouter';
    this.model = config.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
    this.baseUrl = config.baseUrl || OPENROUTER_BASE_URL;

    const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OpenRouterProvider: OPENROUTER_API_KEY environment variable is required'
      );
    }
    this._apiKey = apiKey;
  }

  /**
   * Makes an HTTPS POST request. Returns parsed JSON body.
   * @param {string} path
   * @param {Object} body
   * @returns {Promise<{ statusCode: number, body: Object }>}
   */
  _post(path, body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const url = new URL(path, this.baseUrl);

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`,
          'Content-Length': Buffer.byteLength(payload),
          'HTTP-Referer': 'https://cabinai.app',
          'X-Title': 'CabinAI'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ statusCode: res.statusCode, body: parsed });
          } catch (err) {
            reject(new Error(`OpenRouter: failed to parse response JSON: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Converts our internal tool definitions to OpenAI function-call format.
   * @param {Array<Object>} tools
   * @returns {Array<Object>}
   */
  _buildTools(tools) {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || { type: 'object', properties: {}, required: [] }
      }
    }));
  }

  /**
   * Converts our internal messages to OpenAI chat message format.
   * @param {string} systemPrompt
   * @param {Array<Object>} messages
   * @returns {Array<Object>}
   */
  _buildMessages(systemPrompt, messages) {
    const result = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId || msg.toolName,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        });
      } else if (msg.role === 'model' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: null,
          tool_calls: msg.toolCalls.map((tc, idx) => ({
            id: tc.id || `call_${tc.name}_${idx}`,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {})
            }
          }))
        });
      } else {
        const role = msg.role === 'model' ? 'assistant' : msg.role;
        const content = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
        result.push({ role, content });
      }
    }

    return result;
  }

  /**
   * Normalizes an OpenRouter/OpenAI response to the common LLMResponse format.
   * @param {Object} body - Parsed OpenAI-format response body
   * @returns {LLMResponse}
   */
  _normalizeResponse(body) {
    const choice = body.choices && body.choices[0];
    if (!choice) {
      return new LLMResponse({ text: null, toolCalls: [], raw: body });
    }

    const message = choice.message || {};
    const text = message.content || null;
    const toolCalls = [];

    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        let args = {};
        try {
          args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        } catch {
          args = {};
        }
        toolCalls.push({
          id: tc.id || tc.function.name,
          name: tc.function.name,
          args
        });
      }
    }

    return new LLMResponse({ text, toolCalls, raw: body });
  }

  /**
   * @param {Object} request
   * @param {string}        request.systemPrompt
   * @param {Array<Object>} request.messages
   * @param {Array<Object>} request.tools
   * @returns {Promise<LLMResponse>}
   * @throws {RetryableProviderError} for rate limits / availability errors
   */
  async generate(request) {
    const { systemPrompt, messages, tools = [] } = request;

    const body = {
      model: this.model,
      messages: this._buildMessages(systemPrompt, messages),
    };

    if (tools.length > 0) {
      body.tools = this._buildTools(tools);
      body.tool_choice = 'auto';
    }

    let response;
    try {
      response = await this._post('/chat/completions', body);
    } catch (err) {
      throw new RetryableProviderError(
        `OpenRouter network error: ${err.message}`,
        { cause: err }
      );
    }

    if (RETRYABLE_STATUS_CODES.has(response.statusCode)) {
      throw new RetryableProviderError(
        `OpenRouter HTTP ${response.statusCode}: ${response.body.error?.message || 'provider error'}`,
        { statusCode: response.statusCode }
      );
    }

    if (response.statusCode !== 200) {
      throw new Error(
        `OpenRouter HTTP ${response.statusCode}: ${response.body.error?.message || 'unknown error'}`
      );
    }

    return this._normalizeResponse(response.body);
  }
}

module.exports = OpenRouterProvider;
