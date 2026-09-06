/**
 * Tool: check_duplicate_invoice
 *
 * Detects duplicate or highly similar invoice records using deterministic rules.
 * Returns evidence only — the tool does NOT make an LLM-style conclusion such as
 * "this is a duplicate". The model reasons over the returned evidence.
 *
 * Duplicate signals checked:
 *  1. Exact invoice number match (same string, case-insensitive)
 *  2. Same counterparty name (normalized similarity)
 *  3. Same total amount
 *  4. Same or close issue_date (within 1 day)
 *
 * Read-only. Never mutates financial records.
 */

'use strict';

const {
  normalizeCounterparty,
  calculateCounterpartySimilarity
} = require('../../reconciliation/normalizers');

// Minimum counterparty similarity to flag as potential duplicate
const COUNTERPARTY_DUPLICATE_THRESHOLD = 0.85;

/**
 * Validates check_duplicate_invoice arguments.
 * @param {Object} args
 * @returns {{ valid: boolean, error?: string }}
 */
function validateArgs(args) {
  if (!args || typeof args !== 'object') {
    return { valid: false, error: 'Arguments must be an object' };
  }
  if (
    args.invoiceId === undefined &&
    args.invoiceNumber === undefined
  ) {
    return {
      valid: false,
      error: 'At least one of "invoiceId" or "invoiceNumber" is required'
    };
  }
  if (args.invoiceId !== undefined && typeof args.invoiceId !== 'string') {
    return { valid: false, error: '"invoiceId" must be a string' };
  }
  if (args.invoiceNumber !== undefined && typeof args.invoiceNumber !== 'string') {
    return { valid: false, error: '"invoiceNumber" must be a string' };
  }
  return { valid: true };
}

/**
 * Computes whether two date strings (YYYY-MM-DD) are within N days of each other.
 * @param {string|null} d1
 * @param {string|null} d2
 * @param {number} toleranceDays
 * @returns {boolean}
 */
function datesWithinTolerance(d1, d2, toleranceDays = 1) {
  if (!d1 || !d2) return false;
  const ms1 = Date.parse(d1);
  const ms2 = Date.parse(d2);
  if (isNaN(ms1) || isNaN(ms2)) return false;
  return Math.abs(ms1 - ms2) <= toleranceDays * 24 * 60 * 60 * 1000;
}

/**
 * Checks for duplicate/similar invoice records deterministically.
 *
 * @param {Object} args
 * @param {string}  [args.invoiceId]     - ID of the invoice to check
 * @param {string}  [args.invoiceNumber] - Invoice number to search for duplicates of
 * @param {Object} repos
 * @param {Object} repos.invoices - InvoicesRepository instance
 * @returns {Object} Structured evidence result
 */
function checkDuplicateInvoice(args, repos) {
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

  // --- Load the reference invoice ---
  let referenceInvoice = null;
  try {
    if (args.invoiceId) {
      referenceInvoice = repos.invoices.findById(args.invoiceId);
    } else {
      // findByInvoiceNumber returns an array
      const byNum = repos.invoices.findByInvoiceNumber(args.invoiceNumber);
      referenceInvoice = byNum && byNum.length > 0 ? byNum[0] : null;
    }
  } catch (err) {
    return {
      error: true,
      code: 'REPOSITORY_ERROR',
      message: `Failed to query invoices: ${err.message}`
    };
  }

  if (!referenceInvoice) {
    return {
      error: false,
      referenceInvoiceId: args.invoiceId || null,
      referenceInvoiceNumber: args.invoiceNumber || null,
      found: false,
      duplicates: [],
      duplicateCount: 0,
      evidence: { reason: 'Reference invoice not found' }
    };
  }

  // --- Load all other invoices to compare against ---
  let allInvoices;
  try {
    allInvoices = repos.invoices.findAll();
  } catch (err) {
    return {
      error: true,
      code: 'REPOSITORY_ERROR',
      message: `Failed to query invoices: ${err.message}`
    };
  }

  // Exclude the reference invoice itself
  const candidates = allInvoices.filter(inv => inv.id !== referenceInvoice.id);

  const duplicates = [];

  for (const candidate of candidates) {
    const signals = {};

    // Signal 1: Exact invoice number match (case-insensitive)
    if (
      referenceInvoice.invoice_number &&
      candidate.invoice_number &&
      referenceInvoice.invoice_number.trim().toLowerCase() ===
        candidate.invoice_number.trim().toLowerCase()
    ) {
      signals.invoiceNumberMatch = true;
    }

    // Signal 2: Counterparty similarity
    if (referenceInvoice.counterparty_name && candidate.counterparty_name) {
      const simResult = calculateCounterpartySimilarity(
        referenceInvoice.counterparty_name,
        candidate.counterparty_name
      );
      signals.counterpartySimilarity = simResult.score;
      signals.counterpartyMatch = simResult.score >= COUNTERPARTY_DUPLICATE_THRESHOLD;
    }

    // Signal 3: Exact amount match
    if (
      referenceInvoice.total !== null &&
      candidate.total !== null &&
      referenceInvoice.total === candidate.total
    ) {
      signals.amountMatch = true;
      signals.amount = referenceInvoice.total;
    }

    // Signal 4: Close issue date
    if (referenceInvoice.issue_date && candidate.issue_date) {
      const withinDay = datesWithinTolerance(
        referenceInvoice.issue_date,
        candidate.issue_date,
        1
      );
      signals.dateMatch = withinDay;
      signals.referenceDateDate = referenceInvoice.issue_date;
      signals.candidateIssueDate = candidate.issue_date;
    }

    // Count how many strong signals fired
    const strongSignals = [
      signals.invoiceNumberMatch,
      signals.counterpartyMatch,
      signals.amountMatch,
      signals.dateMatch
    ].filter(Boolean).length;

    // Include in duplicates list if at least 2 signals match, or invoice number is identical
    if (strongSignals >= 2 || signals.invoiceNumberMatch) {
      duplicates.push({
        invoiceId: candidate.id,
        invoiceNumber: candidate.invoice_number || null,
        counterpartyName: candidate.counterparty_name || null,
        total: candidate.total,
        currency: candidate.currency,
        issueDate: candidate.issue_date,
        status: candidate.status,
        strongSignalCount: strongSignals,
        evidence: signals
      });
    }
  }

  // Sort by signal strength
  duplicates.sort((a, b) => b.strongSignalCount - a.strongSignalCount);

  return {
    error: false,
    referenceInvoiceId: referenceInvoice.id,
    referenceInvoiceNumber: referenceInvoice.invoice_number || null,
    found: true,
    duplicates,
    duplicateCount: duplicates.length,
    evidence: {
      referenceAmount: referenceInvoice.total,
      referenceCurrency: referenceInvoice.currency,
      referenceCounterparty: referenceInvoice.counterparty_name,
      referenceIssueDate: referenceInvoice.issue_date,
      candidatesChecked: candidates.length
    }
  };
}

/**
 * Tool schema for the LLM.
 */
const schema = {
  name: 'check_duplicate_invoice',
  description:
    'Detect duplicate or highly similar invoice records using deterministic rules. ' +
    'Checks invoice number, counterparty, amount, and date signals. ' +
    'Returns evidence only — does NOT make a final duplicate conclusion. ' +
    'Read-only, never mutates records.',
  parameters: {
    type: 'OBJECT',
    properties: {
      invoiceId: {
        type: 'STRING',
        description: 'The ID of the invoice to check for duplicates'
      },
      invoiceNumber: {
        type: 'STRING',
        description: 'Invoice number to search for duplicates of (alternative to invoiceId)'
      }
    }
  }
};

module.exports = { checkDuplicateInvoice, schema, validateArgs };
