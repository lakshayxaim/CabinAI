/**
 * Tool: lookup_vendor
 *
 * Searches normalized counterparties/vendors deterministically.
 * Uses the same normalizeCounterparty + calculateCounterpartySimilarity
 * functions as Session 2 — no LLM reasoning, no external API calls.
 *
 * Returns structured evidence: matching entities with their similarity scores.
 * Never mutates financial records.
 */

'use strict';

const {
  normalizeCounterparty,
  calculateCounterpartySimilarity
} = require('../../reconciliation/normalizers');

// Minimum similarity score to include a vendor in results (not a decision gate)
const DEFAULT_MIN_SIMILARITY = 0.40;

/**
 * Validates lookup_vendor arguments.
 * @param {Object} args
 * @returns {{ valid: boolean, error?: string }}
 */
function validateArgs(args) {
  if (!args || typeof args !== 'object') {
    return { valid: false, error: 'Arguments must be an object' };
  }
  if (typeof args.query !== 'string' || !args.query.trim()) {
    return { valid: false, error: '"query" must be a non-empty string' };
  }
  if (
    args.minSimilarity !== undefined &&
    (typeof args.minSimilarity !== 'number' ||
      args.minSimilarity < 0 ||
      args.minSimilarity > 1)
  ) {
    return { valid: false, error: '"minSimilarity" must be a number between 0 and 1' };
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
    return { valid: false, error: '"limit" must be a positive integer' };
  }
  return { valid: true };
}

/**
 * Runs the vendor lookup deterministically against the counterparties repository.
 *
 * @param {Object} args
 * @param {string}  args.query         - Vendor name / search string
 * @param {number}  [args.minSimilarity] - Minimum similarity threshold (0-1), default 0.40
 * @param {number}  [args.limit]         - Maximum results to return, default 10
 * @param {Object} repos
 * @param {Object} repos.counterparties  - CounterpartiesRepository instance
 * @returns {Object} Structured tool result
 */
function lookupVendor(args, repos) {
  // --- Input validation ---
  const validation = validateArgs(args);
  if (!validation.valid) {
    return {
      error: true,
      code: 'INVALID_ARGUMENT',
      message: validation.error
    };
  }

  if (!repos || !repos.counterparties) {
    return {
      error: true,
      code: 'INTERNAL_ERROR',
      message: 'Counterparties repository not available'
    };
  }

  const query = args.query.trim();
  const minSimilarity = typeof args.minSimilarity === 'number'
    ? args.minSimilarity
    : DEFAULT_MIN_SIMILARITY;
  const limit = typeof args.limit === 'number' ? args.limit : 10;

  // --- Deterministic lookup ---
  let allCounterparties;
  try {
    allCounterparties = repos.counterparties.findAll();
  } catch (err) {
    return {
      error: true,
      code: 'REPOSITORY_ERROR',
      message: `Failed to query counterparties: ${err.message}`
    };
  }

  const normalizedQuery = normalizeCounterparty(query);

  const matches = [];
  for (const cp of allCounterparties) {
    const simResult = calculateCounterpartySimilarity(query, cp.name);
    if (simResult.score >= minSimilarity) {
      matches.push({
        id: cp.id,
        name: cp.name,
        type: cp.type,
        email: cp.email || null,
        normalizedName: normalizeCounterparty(cp.name),
        similarity: simResult.score
      });
    }
  }

  // Sort by similarity descending
  matches.sort((a, b) => b.similarity - a.similarity);

  const limited = matches.slice(0, limit);

  return {
    error: false,
    query,
    normalizedQuery,
    matches: limited,
    totalCandidatesChecked: allCounterparties.length,
    matchCount: limited.length
  };
}

/**
 * Tool schema for the LLM (Gemini/OpenRouter function calling format).
 */
const schema = {
  name: 'lookup_vendor',
  description:
    'Search normalized counterparties/vendors by name. ' +
    'Returns matching entities with similarity scores. ' +
    'Does not invent vendors — returns only records that exist in the system.',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: {
        type: 'STRING',
        description: 'Vendor or counterparty name to search for'
      },
      minSimilarity: {
        type: 'NUMBER',
        description: 'Minimum similarity score to include a result (0.0–1.0). Default 0.40.'
      },
      limit: {
        type: 'INTEGER',
        description: 'Maximum number of matches to return. Default 10.'
      }
    },
    required: ['query']
  }
};

module.exports = { lookupVendor, schema, validateArgs };
