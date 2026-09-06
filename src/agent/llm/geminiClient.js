/**
 * Gemini LLM Provider for CabinAI Session 3.
 *
 * Uses @google/genai (current SDK — NOT the deprecated @google/generative-ai).
 * API key sourced exclusively from environment variables (GEMINI_API_KEY).
 * Model name is configurable.
 *
 * Normalizes Gemini responses to the common LLMResponse format.
 * Throws RetryableProviderError for rate limits and transient availability errors.
 */

'use strict';

const { LLMProvider, LLMResponse, RetryableProviderError } = require('./llmClient');

// Retryable HTTP status codes from the Gemini API
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// Error message fragments that indicate transient/rate-limit failures
const RETRYABLE_ERROR_MESSAGES = [
  'rate limit',
  'quota exceeded',
  'resource exhausted',
  'service unavailable',
  'unavailable',
  'backend error',
  'internal error',
  'overloaded',
  'too many requests',
  'timeout',
  'timed out',
  'etimedout',
  'econnreset',
  'econnrefused',
  'socket hang up',
  'network',
];

const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404]);

function getErrorStatus(err) {
  if (err && (err.status || err.statusCode)) {
    return err.status || err.statusCode;
  }
  const nested = err && err.error && err.error.code;
  if (typeof nested === 'number') return nested;

  const msg = (err && err.message) || '';
  const jsonMatch = msg.match(/"code"\s*:\s*(\d+)/);
  if (jsonMatch) return Number(jsonMatch[1]);
  return null;
}

function isRetryable(err) {
  const status = getErrorStatus(err);
  if (NON_RETRYABLE_STATUS_CODES.has(status)) return false;
  if (RETRYABLE_STATUS_CODES.has(status)) return true;

  const msg = (err.message || '').toLowerCase();
  if (
    msg.includes('invalid_argument') ||
    msg.includes('invalid api key') ||
    msg.includes('api key not valid')
  ) {
    return false;
  }
  return RETRYABLE_ERROR_MESSAGES.some(frag => msg.includes(frag));
}

class GeminiProvider extends LLMProvider {
  /**
   * @param {Object} config
   * @param {string} [config.model]   - Gemini model identifier, default 'gemini-1.5-flash'
   * @param {string} [config.apiKey]  - Override; default: process.env.GEMINI_API_KEY
   */
  constructor(config = {}) {
    super(config);
    this.providerName = 'gemini';
    this.model = config.model || process.env.GEMINI_MODEL || 'gemini-1.5-flash';

    const apiKey = config.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GeminiProvider: GEMINI_API_KEY environment variable is required'
      );
    }

    this.maxRetries = config.maxRetries == null ? 2 : config.maxRetries;
    this.baseDelayMs = config.baseDelayMs == null ? 1000 : config.baseDelayMs;
    this._sleep = config.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));

    if (config.genAI) {
      this._genAI = config.genAI;
    } else {
      // Lazy-require so unit tests can run without the SDK installed
      let genAI;
      try {
        const { GoogleGenAI } = require('@google/genai');
        genAI = new GoogleGenAI({ apiKey });
      } catch (err) {
        throw new Error(
          `GeminiProvider: failed to initialize @google/genai SDK: ${err.message}`
        );
      }
      this._genAI = genAI;
    }
  }

  /**
   * Converts our internal tool definitions to Gemini function declarations.
   * @param {Array<Object>} tools
   * @returns {Array<Object>} Gemini FunctionDeclaration array
   */
  _buildFunctionDeclarations(tools) {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: 'OBJECT', properties: {}, required: [] }
    }));
  }

  /**
   * Converts our internal message history to Gemini Content array format.
   * @param {Array<Object>} messages
   * @returns {Array<Object>}
   */
  _buildContents(messages) {
    return messages.map(msg => {
      // Tool result -> Gemini functionResponse
      if (msg.role === 'tool') {
        let responseContent;
  
        if (typeof msg.content === 'string') {
          try {
            responseContent = JSON.parse(msg.content);
          } catch {
            responseContent = { result: msg.content };
          }
        } else if (
          typeof msg.content === 'object' &&
          msg.content !== null
        ) {
          responseContent = msg.content;
        } else {
          responseContent = { result: msg.content };
        }
  
        if (
          typeof responseContent !== 'object' ||
          responseContent === null
        ) {
          responseContent = { result: responseContent };
        }
  
        return {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: msg.toolName,
                response: responseContent
              }
            }
          ]
        };
      }
  
      // Previous Gemini model message containing function calls.
      // Preserve thought_signature when Gemini supplied one.
      if (
        msg.role === 'model' &&
        Array.isArray(msg.toolCalls) &&
        msg.toolCalls.length > 0
      ) {
        return {
          role: 'model',
          parts: msg.toolCalls.map(tc => ({
            functionCall: {
              name: tc.name,
              args: tc.args || {},
              ...(tc.thoughtSignature
                ? {
                    thought_signature: tc.thoughtSignature
                  }
                : {})
            },
            // @google/genai maps thoughtSignature on the Part, not FunctionCall.
            ...(tc.thoughtSignature
              ? { thoughtSignature: tc.thoughtSignature }
              : {})
          }))
        };
      }
  
      // Normal user/model text message
      const role = msg.role === 'model' ? 'model' : 'user';
  
      return {
        role,
        parts: [
          {
            text:
              typeof msg.content === 'string'
                ? msg.content
                : JSON.stringify(msg.content)
          }
        ]
      };
    });
  }
  /**
   * Normalizes a Gemini response to the common LLMResponse format.
   * @param {Object} response - Raw Gemini response
   * @returns {LLMResponse}
   */
  _normalizeResponse(response) {
    const toolCalls = [];
    let text = null;

    // response.candidates[0].content.parts contains either text parts or functionCall parts
    const candidate = response.candidates && response.candidates[0];
    if (!candidate) {
      return new LLMResponse({ text: null, toolCalls: [], raw: response });
    }

    const parts = (candidate.content && candidate.content.parts) || [];

    for (const part of parts) {
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.name + '_' + Date.now(),
          name: part.functionCall.name,
          args: part.functionCall.args || {},
          thoughtSignature:
            part.thoughtSignature ||
            part.thought_signature ||
            part.functionCall.thought_signature ||
            part.functionCall.thoughtSignature ||
            null
        });
      } else if (part.text) {
        text = (text || '') + part.text;
      }
    }

    return new LLMResponse({ text, toolCalls, raw: response });
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

    const contents = this._buildContents(messages);
    const functionDeclarations = this._buildFunctionDeclarations(tools);

    const generativeModel = this._genAI.models;

    const params = {
      model: this.model,
      contents,
      config: {
        systemInstruction: systemPrompt
          ? { parts: [{ text: systemPrompt }] }
          : undefined,
        tools: functionDeclarations.length > 0
          ? [{ functionDeclarations }]
          : undefined
      }
    };

    const maxAttempts = this.maxRetries + 1;
    let lastErr;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const raw = await generativeModel.generateContent(params);
        return this._normalizeResponse(raw);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt >= maxAttempts) {
          break;
        }
        const delayMs = this.baseDelayMs * Math.pow(2, attempt - 1);
        await this._sleep(delayMs);
      }
    }

    if (isRetryable(lastErr)) {
      throw new RetryableProviderError(
        `Gemini retryable error: ${lastErr.message}`,
        { statusCode: getErrorStatus(lastErr), cause: lastErr }
      );
    }
    throw lastErr;
  }
}

module.exports = GeminiProvider;
