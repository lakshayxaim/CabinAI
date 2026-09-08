/**
 * LLM Provider base interface for CabinAI Session 3.
 *
 * All LLM providers must implement generate(request) -> LLMResponse.
 * The agent loop depends only on this interface, never on provider-specific types.
 *
 * Request shape:
 * {
 *   systemPrompt: string,
 *   messages:     Array<{ role: 'user'|'model'|'tool', content: string|Object }>,
 *   tools:        Array<ToolDefinition>   // Gemini-style JSON schema tool definitions
 * }
 *
 * Response shape (LLMResponse):
 * {
 *   text:       string | null,           // Final text when no more tool calls
 *   toolCalls:  Array<ToolCallRequest>,  // [{id, name, args}] when model wants tools
 *   raw:        Object                   // Provider-specific raw response (for debugging)
 * }
 *
 * ToolCallRequest shape:
 * { id: string, name: string, args: Object }
 */

'use strict';

class LLMProvider {
  /**
   * @param {Object} config
   * @param {string} config.model  - model identifier
   */
  constructor(config = {}) {
    if (new.target === LLMProvider) {
      throw new Error('LLMProvider is abstract — use GeminiProvider or OpenRouterProvider');
    }
    this.model = config.model || 'unknown';
    this.providerName = 'unknown';
  }

  /**
   * Generate a response from the LLM.
   *
   * @param {Object} request
   * @param {string}        request.systemPrompt
   * @param {Array<Object>} request.messages
   * @param {Array<Object>} request.tools
   * @returns {Promise<LLMResponse>}
   */
  // eslint-disable-next-line no-unused-vars
  async generate(request) {
    throw new Error(`${this.constructor.name}.generate() not implemented`);
  }
}

/**
 * Normalized LLM response returned by every provider.
 */
class LLMResponse {
  /**
   * @param {Object} opts
   * @param {string|null}       opts.text
   * @param {Array<Object>}     opts.toolCalls  [{id, name, args}]
   * @param {Object}            opts.raw
   */
  constructor({ text = null, toolCalls = [], raw = {} } = {}) {
    this.text = text;
    this.toolCalls = toolCalls;
    this.raw = raw;
    Object.freeze(this.toolCalls);
    Object.freeze(this);
  }

  get hasToolCalls() {
    return this.toolCalls.length > 0;
  }
}

/**
 * Error thrown when a retryable provider failure occurs (rate limit, 503, etc.).
 * The agent uses this to trigger fallback to the next provider.
 */
class RetryableProviderError extends Error {
  constructor(message, { statusCode, cause } = {}) {
    super(message);
    this.name = 'RetryableProviderError';
    this.statusCode = statusCode || null;
    this.cause = cause || null;
  }
}

module.exports = { LLMProvider, LLMResponse, RetryableProviderError };
