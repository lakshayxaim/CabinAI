/**
 * Tool: calculate_amount_difference
 *
 * Deterministic monetary arithmetic. Returns absolute and signed difference
 * between two amounts. Does NOT make tolerance decisions. Does NOT infer
 * that a difference represents a fee, discount, or rounding.
 *
 * The tool returns evidence only. Reasoning is the model's responsibility.
 * Read-only. No repository access needed.
 */

'use strict';

const { normalizeCurrency } = require('../../normalizers/amountNormalizer');

/**
 * Validates calculate_amount_difference arguments.
 * @param {Object} args
 * @returns {{ valid: boolean, error?: string }}
 */
function validateArgs(args) {
  if (!args || typeof args !== 'object') {
    return { valid: false, error: 'Arguments must be an object' };
  }
  if (args.expectedAmount === undefined || args.expectedAmount === null) {
    return { valid: false, error: '"expectedAmount" is required' };
  }
  if (typeof args.expectedAmount !== 'number' || isNaN(args.expectedAmount)) {
    return { valid: false, error: '"expectedAmount" must be a valid number' };
  }
  if (args.actualAmount === undefined || args.actualAmount === null) {
    return { valid: false, error: '"actualAmount" is required' };
  }
  if (typeof args.actualAmount !== 'number' || isNaN(args.actualAmount)) {
    return { valid: false, error: '"actualAmount" must be a valid number' };
  }
  if (args.currency !== undefined) {
    if (typeof args.currency !== 'string' || !args.currency.trim()) {
      return { valid: false, error: '"currency" must be a non-empty string when provided' };
    }
  }
  return { valid: true };
}

/**
 * Calculates the difference between two monetary amounts deterministically.
 *
 * @param {Object} args
 * @param {number}  args.expectedAmount  - Reference amount (e.g. invoice total)
 * @param {number}  args.actualAmount    - Observed amount (e.g. bank transaction)
 * @param {string}  [args.currency]      - Currency code for context
 * @returns {Object} Structured result with difference information
 */
function calculateAmountDifference(args) {
  // --- Input validation ---
  const validation = validateArgs(args);
  if (!validation.valid) {
    return {
      error: true,
      code: 'INVALID_ARGUMENT',
      message: validation.error
    };
  }

  const expected = args.expectedAmount;
  const actual = args.actualAmount;
  const currency = args.currency
    ? normalizeCurrency(args.currency)
    : null;

  // Signed difference: positive means actual > expected; negative means actual < expected
  const signedDifference = actual - expected;

  // Absolute difference — always non-negative
  const absoluteDifference = Math.abs(signedDifference);

  // Round to avoid floating-point noise (2 decimal places for currency)
  const roundedSigned = Math.round(signedDifference * 100) / 100;
  const roundedAbsolute = Math.round(absoluteDifference * 100) / 100;

  const isExact = roundedAbsolute === 0;

  return {
    error: false,
    currency: currency || null,
    expectedAmount: expected,
    actualAmount: actual,
    absoluteDifference: roundedAbsolute,
    signedDifference: roundedSigned,
    isExact,
    // Provide directional context without making a business conclusion
    direction: isExact
      ? 'equal'
      : signedDifference > 0
        ? 'actual_exceeds_expected'
        : 'actual_below_expected',
    // Percentage difference relative to expected (for context only)
    percentageDifference:
      expected !== 0
        ? Math.round((absoluteDifference / Math.abs(expected)) * 10000) / 100
        : null
  };
}

/**
 * Tool schema for the LLM.
 */
const schema = {
  name: 'calculate_amount_difference',
  description:
    'Deterministic monetary arithmetic. Returns the absolute and signed difference ' +
    'between an expected amount and an actual amount. ' +
    'Does NOT make tolerance decisions. Does NOT infer whether a difference is acceptable. ' +
    'Returns evidence only.',
  parameters: {
    type: 'OBJECT',
    properties: {
      expectedAmount: {
        type: 'NUMBER',
        description: 'Reference or expected amount (e.g. invoice total)'
      },
      actualAmount: {
        type: 'NUMBER',
        description: 'Observed amount (e.g. bank transaction amount)'
      },
      currency: {
        type: 'STRING',
        description: 'Currency code for context, e.g. USD. Optional.'
      }
    },
    required: ['expectedAmount', 'actualAmount']
  }
};

module.exports = { calculateAmountDifference, schema, validateArgs };
