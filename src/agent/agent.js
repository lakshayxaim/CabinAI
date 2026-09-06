/**
 * CabinAI Bookkeeping Agent — Session 3
 *
 * Provider-agnostic agent harness that:
 *  1. Runs the tool-calling loop (model → tool → model → ... → final result)
 *  2. Dispatches tool calls through the deterministic tool registry ONLY
 *  3. Consumes Session 2 deterministic matcher results via find_matching_invoice tool
 *  4. Returns a stable, auditable AgentResult regardless of which provider responded
 *
 * Architecture:
 *
 *   BookkeepingAgent
 *       │
 *       ├─ Primary provider:  GeminiProvider
 *       ├─ Fallback provider: OpenRouterProvider
 *       │
 *       └─ Tool Registry
 *             ├─ lookup_vendor             → CounterpartiesRepository
 *             ├─ find_matching_invoice     → InvoicesRepository + Session 2 Matcher
 *             ├─ calculate_amount_difference → pure arithmetic
 *             ├─ check_duplicate_invoice   → InvoicesRepository
 *             └─ check_invoice_status      → InvoicesRepository
 *
 * The model has NO direct database access.
 * The model sees only what the tools return.
 */

'use strict';

const { RetryableProviderError } = require('./llm/llmClient');
const { getToolSchemas, executeTool } = require('./tools/registry');
const { AgentResult, AgentAudit, AgentDecision } = require('./types');

const DEFAULT_MAX_TOOL_ITERATIONS = 10;

function summarizeRetryableReason(err) {
  const msg = (err && err.message) || '';
  if (/unavailable/i.test(msg) || err.statusCode === 503) return 'UNAVAILABLE';
  if (/resource exhausted|rate limit|too many requests/i.test(msg) || err.statusCode === 429) {
    return 'RESOURCE_EXHAUSTED';
  }
  if (/timeout|timed out/i.test(msg)) return 'TIMEOUT';
  return msg.slice(0, 180) || 'retryable provider error';
}

/**
 * System prompt template.
 * Instructs the model about its role, constraints, and how to structure the final answer.
 */
function buildSystemPrompt() {
  return `You are a deterministic bookkeeping assistant for CabinAI.

Your role is to categorize and reconcile bank transactions using the evidence returned by deterministic tools.
You do NOT have direct database access. You interact with the financial system exclusively through the provided tools.

## Rules

1. ONLY use the tools provided. Never invent vendors, invoices, amounts, dates, or accounting facts.
2. Tool results are authoritative. If a tool returns a rejection (wrong direction, currency, or amount mismatch), accept it.
3. Never override a deterministic rejection with your own reasoning (e.g. "probably the same invoice").
4. If evidence is insufficient or ambiguous, return needsReview: true and confidence: 0.
5. Distinguish clearly between evidence from tools and your own inference.
6. When you are done reasoning, return a final JSON result ONLY (no other text).

## Final Result Format

Return a single JSON object:
{
  "category": string or null,
  "confidence": number (0.0 to 1.0),
  "decision": "matched" | "categorized" | "needs_review" | "unmatched" | "rejected",
  "matchedInvoiceId": string or null,
  "matchedVendorId": string or null,
  "reasoning": string,
  "evidence": [string, ...],
  "needsReview": boolean
}

Use null (not invented values) when evidence is unavailable.
If you cannot determine a category, set category to null and needsReview to true.`;
}

/**
 * Builds the initial user message describing the transaction to process.
 * @param {Object} transaction - Normalized bank transaction
 * @param {Object|null} session2Result - Pre-computed Session 2 match result (optional)
 * @returns {string}
 */
function buildTransactionMessage(transaction, session2Result) {
  let msg = `Please analyze the following bank transaction and categorize it.

## Transaction
${JSON.stringify(transaction, null, 2)}
`;

  if (session2Result) {
    msg += `
## Pre-computed Session 2 Deterministic Match Result
The deterministic reconciliation engine has already evaluated this transaction:
${JSON.stringify(session2Result, null, 2)}

This deterministic result is authoritative. You may investigate further using tools,
but you must not override direction, currency, amount, or date-window rejections.
`;
  }

  msg += `
Use the available tools to gather additional evidence, then return your final JSON result.`;

  return msg;
}

/**
 * Tries to parse a final structured result from the model's text response.
 * Extracts the first JSON object found in the text.
 * @param {string|null} text
 * @returns {Object|null}
 */
function parseModelFinalResponse(text) {
  if (!text) return null;

  // Try to extract JSON from a markdown code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Try to parse the whole text as JSON
  try {
    return JSON.parse(text.trim());
  } catch {
    // fall through
  }

  // Try to find a JSON object in the text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Converts a parsed model JSON result into a validated, normalized shape.
 * Sanitizes confidence values and fills in safe defaults.
 * @param {Object} parsed
 * @param {string} transactionId
 * @returns {Object}
 */
function normalizeModelResult(parsed, transactionId) {
  if (!parsed || typeof parsed !== 'object') {
    return {
      transactionId,
      category: null,
      confidence: 0,
      decision: AgentDecision.NEEDS_REVIEW,
      matchedInvoiceId: null,
      matchedVendorId: null,
      reasoning: 'Model did not return a parseable structured result',
      evidence: [],
      needsReview: true
    };
  }

  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0;

  const validDecisions = new Set(Object.values(AgentDecision));
  const decision = validDecisions.has(parsed.decision)
    ? parsed.decision
    : AgentDecision.NEEDS_REVIEW;

  return {
    transactionId,
    category: typeof parsed.category === 'string' ? parsed.category : null,
    confidence,
    decision,
    matchedInvoiceId: typeof parsed.matchedInvoiceId === 'string'
      ? parsed.matchedInvoiceId
      : null,
    matchedVendorId: typeof parsed.matchedVendorId === 'string'
      ? parsed.matchedVendorId
      : null,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : null,
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter(e => typeof e === 'string') : [],
    needsReview: Boolean(parsed.needsReview)
  };
}

class BookkeepingAgent {
  /**
   * @param {Object} opts
   * @param {import('./llm/llmClient').LLMProvider} opts.primaryProvider
   * @param {import('./llm/llmClient').LLMProvider} [opts.fallbackProvider]
   * @param {Object} opts.repos  - { invoices, counterparties, ... }
   * @param {number} [opts.maxToolIterations] - Max tool-calling rounds before stopping
   */
  constructor({ primaryProvider, fallbackProvider = null, repos, maxToolIterations }) {
    if (!primaryProvider) {
      throw new Error('BookkeepingAgent: primaryProvider is required');
    }
    if (!repos) {
      throw new Error('BookkeepingAgent: repos is required');
    }

    this.primaryProvider = primaryProvider;
    this.fallbackProvider = fallbackProvider;
    this.repos = repos;
    this.maxToolIterations = maxToolIterations || DEFAULT_MAX_TOOL_ITERATIONS;
  }

  /**
   * Core tool-calling loop.
   * Sends messages to the provider and executes requested tools until the model
   * produces a text-only response (final answer) or we hit maxToolIterations.
   *
   * @param {import('./llm/llmClient').LLMProvider} provider
   * @param {Array<Object>} messages  - Mutable conversation history
   * @param {Array<Object>} toolCallLog - Mutable log of executed tool calls
   * @returns {Promise<{ text: string|null, limitReached: boolean }>}
   */
  async _runToolLoop(provider, messages, toolCallLog) {
    const toolSchemas = getToolSchemas();
    let iterations = 0;

    while (iterations < this.maxToolIterations) {
      iterations++;

      const response = await provider.generate({
        systemPrompt: buildSystemPrompt(),
        messages,
        tools: toolSchemas
      });

      // No tool calls — model gave a final text response
      if (!response.hasToolCalls) {
        return { text: response.text, limitReached: false };
      }

      // Model requested one or more tool calls
      // Add the model's tool-call message to history
      messages.push({
        role: 'model',
        toolCalls: response.toolCalls,
        content: response.toolCalls.map(tc =>
          `Calling tool: ${tc.name}(${JSON.stringify(tc.args)})`
        ).join('\n')
      });

      // Execute each requested tool and add results to history
      for (const toolCall of response.toolCalls) {
        const { result } = executeTool(toolCall.name, toolCall.args, this.repos);

        // Record in audit log
        toolCallLog.push({
          toolName: toolCall.name,
          arguments: toolCall.args,
          result
        });

        // Return tool result to the model
        messages.push({
          role: 'tool',
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          content: JSON.stringify(result)
        });
      }
    }

    // Reached max iterations — ask model to conclude
    messages.push({
      role: 'user',
      content:
        'You have reached the maximum number of tool calls. ' +
        'Based on the evidence gathered so far, please return your final JSON result now.'
    });

    const finalResponse = await provider.generate({
      systemPrompt: buildSystemPrompt(),
      messages,
      tools: [] // No more tools — force text response
    });

    return { text: finalResponse.text, limitReached: true };
  }

  /**
   * Processes a single bank transaction through the agent harness.
   *
   * @param {Object} transaction - Normalized bank transaction
   *   { id, amount, currency, direction, transaction_date, description, ... }
   * @param {Object} [opts]
   * @param {Object|null} [opts.session2Result] - Pre-computed Session 2 match result
   * @returns {Promise<AgentResult>}
   */
  async processTransaction(transaction, opts = {}) {
    const { session2Result = null } = opts;
    const transactionId = transaction.id || transaction.transaction_id || 'unknown';

    const toolCallLog = [];
    const messages = [
      {
        role: 'user',
        content: buildTransactionMessage(transaction, session2Result)
      }
    ];

    let provider = this.primaryProvider;
    let usedProvider = this.primaryProvider.providerName;
    let usedModel = this.primaryProvider.model;
    let fallbackOccurred = false;
    let fallbackFrom = null;
    let fallbackReason = null;
    let agentError = null;

    let text = null;
    let limitReached = false;

    // --- Attempt primary provider ---
    try {
      const result = await this._runToolLoop(provider, messages, toolCallLog);
      text = result.text;
      limitReached = result.limitReached;
    } catch (err) {
      if (err instanceof RetryableProviderError && this.fallbackProvider) {
        // --- Fallback to secondary provider ---
        fallbackOccurred = true;
        fallbackFrom = this.primaryProvider.providerName;
        fallbackReason = err.statusCode
          ? `${err.statusCode} ${summarizeRetryableReason(err)}`
          : summarizeRetryableReason(err);
        provider = this.fallbackProvider;
        usedProvider = this.fallbackProvider.providerName;
        usedModel = this.fallbackProvider.model;

        try {
          const result = await this._runToolLoop(provider, messages, toolCallLog);
          text = result.text;
          limitReached = result.limitReached;
        } catch (fallbackErr) {
          // Both providers failed
          agentError = `Primary provider (${this.primaryProvider.providerName}) failed: ${err.message}. ` +
            `Fallback provider (${this.fallbackProvider.providerName}) also failed: ${fallbackErr.message}`;
        }
      } else {
        agentError = err.message;
      }
    }

    // --- Build audit record ---
    const audit = new AgentAudit({
      provider: usedProvider,
      model: usedModel,
      fallbackOccurred,
      fallbackFrom,
      fallbackReason,
      toolCalls: toolCallLog,
      finalDecision: null, // filled in below
      confidence: null,
      error: agentError
    });

    // --- Handle total failure ---
    if (agentError) {
      const failResult = new AgentResult({
        transactionId,
        category: null,
        confidence: 0,
        decision: AgentDecision.FAILED,
        matchedInvoiceId: null,
        matchedVendorId: null,
        reasoning: agentError,
        evidence: [],
        toolCalls: toolCallLog,
        needsReview: true,
        audit: {
          ...audit,
          finalDecision: AgentDecision.FAILED,
          confidence: 0
        }
      });
      return failResult;
    }

    // --- Parse model's final response ---
    const parsed = parseModelFinalResponse(text);
    const normalized = normalizeModelResult(parsed, transactionId);

    // If limit was reached and model still didn't produce structured output,
    // flag for review
    if (limitReached && !parsed) {
      normalized.needsReview = true;
      normalized.decision = AgentDecision.NEEDS_REVIEW;
      normalized.reasoning = (normalized.reasoning || '') +
        ' [Max tool iterations reached without structured result]';
    }

    return new AgentResult({
      ...normalized,
      toolCalls: toolCallLog,
      audit: {
        provider: usedProvider,
        model: usedModel,
        fallbackOccurred,
        fallbackFrom,
        fallbackReason,
        toolCalls: toolCallLog,
        finalDecision: normalized.decision,
        confidence: normalized.confidence,
        error: null
      }
    });
  }
}

module.exports = BookkeepingAgent;
