/**
 * Agent Result Types for CabinAI Session 3.
 *
 * Stable, structured return types for all agent outputs.
 * Provider-independent — the same type is returned regardless of
 * whether Gemini or OpenRouter produced the reasoning.
 */

'use strict';

/**
 * Possible agent decisions.
 */
const AgentDecision = Object.freeze({
  MATCHED: 'matched',            // Transaction matched to an invoice/record
  CATEGORIZED: 'categorized',   // Category identified but no exact invoice match
  NEEDS_REVIEW: 'needs_review', // Ambiguous / insufficient evidence — human review required
  UNMATCHED: 'unmatched',       // No candidate found
  REJECTED: 'rejected',          // Deterministically rejected (wrong direction/currency)
  FAILED: 'failed'               // Both providers unavailable / unrecoverable error
});

/**
 * Possible transaction categories (non-exhaustive; model may produce others).
 * These represent common expense/income types.
 */
const TransactionCategory = Object.freeze({
  SOFTWARE: 'software',
  CLOUD_INFRASTRUCTURE: 'cloud_infrastructure',
  OFFICE: 'office',
  PAYROLL: 'payroll',
  PROFESSIONAL_SERVICES: 'professional_services',
  MARKETING: 'marketing',
  TRAVEL: 'travel',
  UTILITIES: 'utilities',
  REVENUE: 'revenue',
  PAYMENT_PROVIDER_PAYOUT: 'payment_provider_payout',
  REFUND: 'refund',
  UNKNOWN: 'unknown'
});

/**
 * Immutable structured agent result.
 * Returned by the agent for every transaction it processes.
 */
class AgentResult {
  /**
   * @param {Object} opts
   * @param {string}          opts.transactionId
   * @param {string|null}     opts.category
   * @param {number}          opts.confidence       - 0.0–1.0
   * @param {string}          opts.decision
   * @param {string|null}     opts.matchedInvoiceId
   * @param {string|null}     opts.matchedVendorId
   * @param {string|null}     opts.reasoning
   * @param {Array<string>}   opts.evidence         - List of evidence strings
   * @param {Array<Object>}   opts.toolCalls        - [{toolName, arguments, result}]
   * @param {boolean}         opts.needsReview
   * @param {Object}          opts.audit
   */
  constructor({
    transactionId,
    category = null,
    confidence = 0,
    decision = AgentDecision.NEEDS_REVIEW,
    matchedInvoiceId = null,
    matchedVendorId = null,
    reasoning = null,
    evidence = [],
    toolCalls = [],
    needsReview = false,
    audit = {}
  }) {
    this.transactionId = transactionId;
    this.category = category;
    this.confidence = confidence;
    this.decision = decision;
    this.matchedInvoiceId = matchedInvoiceId;
    this.matchedVendorId = matchedVendorId;
    this.reasoning = reasoning;
    this.evidence = Object.freeze([...evidence]);
    this.toolCalls = Object.freeze([...toolCalls]);
    this.needsReview = needsReview;
    this.audit = Object.freeze({ ...audit });
    Object.freeze(this);
  }
}

/**
 * Audit record captured for every agent invocation.
 * Reconstructs the full decision lineage without storing secrets.
 */
class AgentAudit {
  constructor({
    provider,
    model,
    fallbackOccurred = false,
    fallbackFrom = null,
    fallbackReason = null,
    toolCalls = [],
    finalDecision,
    confidence,
    error = null
  }) {
    this.provider = provider;
    this.model = model;
    this.fallbackOccurred = fallbackOccurred;
    this.fallbackFrom = fallbackFrom;
    this.fallbackReason = fallbackReason;
    // Each entry: { toolName, arguments, result }
    this.toolCalls = Object.freeze([...toolCalls]);
    this.finalDecision = finalDecision;
    this.confidence = confidence;
    this.error = error;
    Object.freeze(this);
  }
}

module.exports = { AgentDecision, TransactionCategory, AgentResult, AgentAudit };
