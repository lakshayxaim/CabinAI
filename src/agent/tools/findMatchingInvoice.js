/**
 * Tool: find_matching_invoice
 *
 * Searches invoices using deterministic Session 2 matching logic.
 * The tool reuses DeterministicMatcher.evaluateCandidate() exactly —
 * it does NOT implement a competing algorithm.
 *
 * The LLM receives structured evidence (match result, score, reasons).
 * The LLM may NOT override a Session 2 rejection (wrong direction, wrong currency,
 * wrong amount, date outside window).
 *
 * Read-only. Never mutates financial records.
 */

'use strict';

const DeterministicMatcher = require('../../reconciliation/matcher');
const { MatchDecision } = require('../../reconciliation/types');

const matcher = new DeterministicMatcher();

/**
 * Validates find_matching_invoice arguments.
 * @param {Object} args
 * @returns {{ valid: boolean, error?: string }}
 */
function validateArgs(args) {
  if (!args || typeof args !== 'object') {
    return { valid: false, error: 'Arguments must be an object' };
  }

  // Need at least a transaction to match against
  if (!args.transaction || typeof args.transaction !== 'object') {
    return {
      valid: false,
      error: '"transaction" must be an object with amount, currency, direction, transaction_date'
    };
  }

  const tx = args.transaction;

  if (typeof tx.amount !== 'number' || isNaN(tx.amount)) {
    return { valid: false, error: '"transaction.amount" must be a valid number' };
  }
  if (typeof tx.currency !== 'string' || !tx.currency.trim()) {
    return { valid: false, error: '"transaction.currency" must be a non-empty string' };
  }
  if (!['inflow', 'outflow'].includes(tx.direction)) {
    return {
      valid: false,
      error: '"transaction.direction" must be "inflow" or "outflow"'
    };
  }
  if (typeof tx.transaction_date !== 'string' || !tx.transaction_date.trim()) {
    return { valid: false, error: '"transaction.transaction_date" must be a YYYY-MM-DD string' };
  }
  if (
    args.invoiceIds !== undefined &&
    (!Array.isArray(args.invoiceIds) || args.invoiceIds.some(id => typeof id !== 'string'))
  ) {
    return { valid: false, error: '"invoiceIds" must be an array of strings when provided' };
  }

  return { valid: true };
}

/**
 * Runs deterministic invoice matching via Session 2 DeterministicMatcher.
 *
 * @param {Object} args
 * @param {Object}          args.transaction   - Normalized bank transaction
 * @param {Array<string>}   [args.invoiceIds]  - Optional: restrict search to specific invoice IDs
 * @param {Object} repos
 * @param {Object} repos.invoices - InvoicesRepository instance
 * @returns {Object} Structured tool result with match evidence
 */
function findMatchingInvoice(args, repos) {
  // --- Input validation ---
  const validation = validateArgs(args);
  if (!validation.valid) {
    return {
      error: true,
      code: 'INVALID_ARGUMENT',
      message: validation.error
    };
  }

  if (!repos || !repos.invoices) {
    return {
      error: true,
      code: 'INTERNAL_ERROR',
      message: 'Invoices repository not available'
    };
  }

  const tx = args.transaction;

  // --- Load invoice candidates from repository ---
  let candidates;
  try {
    if (args.invoiceIds && args.invoiceIds.length > 0) {
      candidates = args.invoiceIds
        .map(id => repos.invoices.findById(id))
        .filter(Boolean);
    } else {
      candidates = repos.invoices.findAll();
    }
  } catch (err) {
    return {
      error: true,
      code: 'REPOSITORY_ERROR',
      message: `Failed to query invoices: ${err.message}`
    };
  }

  if (candidates.length === 0) {
    return {
      error: false,
      decision: MatchDecision.UNMATCHED,
      matches: [],
      ambiguous: false,
      candidatesChecked: 0,
      evidence: { reason: 'No invoice candidates available' }
    };
  }

  // --- Run Session 2 deterministic matching ---
  const matchResult = matcher.matchTransaction(tx, candidates);

  // Build a readable evidence summary
  const evaluations = matchResult.allCandidates.map(ev => ({
    invoiceId: ev.candidateId,
    score: ev.score,
    isCompatible: ev.isCompatible,
    rejectionReason: ev.rejectionReason || null,
    amountComparison: ev.amountComparison,
    dateDifference: ev.dateDifference,
    counterpartySimilarity: ev.counterpartySimilarity,
    reasons: ev.reasons
  }));

  return {
    error: false,
    decision: matchResult.decision,
    matchedInvoiceId: matchResult.candidateId || null,
    score: matchResult.score,
    ambiguous: matchResult.decision === MatchDecision.AMBIGUOUS,
    candidatesChecked: candidates.length,
    evidence: {
      amountComparison: matchResult.amountComparison,
      dateDifference: matchResult.dateDifference,
      counterpartySimilarity: matchResult.counterpartySimilarity,
      reasons: matchResult.reasons
    },
    matches: matchResult.candidate ? [{
      invoiceId: matchResult.candidateId,
      score: matchResult.score,
      decision: matchResult.decision
    }] : [],
    allEvaluations: evaluations
  };
}

/**
 * Tool schema for the LLM.
 */
const schema = {
  name: 'find_matching_invoice',
  description:
    'Search invoices using deterministic Session 2 matching logic. ' +
    'Returns evidence including compatibility result, score, and rejection reasons. ' +
    'Preserves all Session 2 accounting invariants: direction, currency, exact amount gate, date window. ' +
    'The model must not override a deterministic rejection.',
  parameters: {
    type: 'OBJECT',
    properties: {
      transaction: {
        type: 'OBJECT',
        description: 'The bank transaction to match against invoices',
        properties: {
          amount: { type: 'NUMBER', description: 'Transaction amount (positive)' },
          currency: { type: 'STRING', description: 'Currency code, e.g. USD' },
          direction: {
            type: 'STRING',
            description: '"inflow" (money received) or "outflow" (money paid)'
          },
          transaction_date: { type: 'STRING', description: 'ISO date YYYY-MM-DD' },
          description: { type: 'STRING', description: 'Bank statement description / memo' }
        },
        required: ['amount', 'currency', 'direction', 'transaction_date']
      },
      invoiceIds: {
        type: 'ARRAY',
        description: 'Optional: restrict search to specific invoice IDs. If omitted, searches all invoices.',
        items: { type: 'STRING' }
      }
    },
    required: ['transaction']
  }
};

module.exports = { findMatchingInvoice, schema, validateArgs };
