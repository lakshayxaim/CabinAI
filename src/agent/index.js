/**
 * Agent module entry point for CabinAI Session 3.
 */

'use strict';

const BookkeepingAgent = require('./agent');
const { LLMProvider, LLMResponse, RetryableProviderError } = require('./llm/llmClient');
const GeminiProvider = require('./llm/geminiClient');
const OpenRouterProvider = require('./llm/openRouterClient');
const { getToolSchemas, executeTool, isToolRegistered, TOOLS } = require('./tools/registry');
const { AgentDecision, TransactionCategory, AgentResult, AgentAudit } = require('./types');

// Individual tools (for direct unit-testing)
const { lookupVendor } = require('./tools/lookupVendor');
const { findMatchingInvoice } = require('./tools/findMatchingInvoice');
const { calculateAmountDifference } = require('./tools/calculateAmountDifference');
const { checkDuplicateInvoice } = require('./tools/checkDuplicateInvoice');
const { checkInvoiceStatus } = require('./tools/checkInvoiceStatus');

module.exports = {
  // Agent
  BookkeepingAgent,

  // Providers
  LLMProvider,
  LLMResponse,
  RetryableProviderError,
  GeminiProvider,
  OpenRouterProvider,

  // Tool registry
  TOOLS,
  getToolSchemas,
  executeTool,
  isToolRegistered,

  // Individual tools
  lookupVendor,
  findMatchingInvoice,
  calculateAmountDifference,
  checkDuplicateInvoice,
  checkInvoiceStatus,

  // Types
  AgentDecision,
  TransactionCategory,
  AgentResult,
  AgentAudit
};
