/**
 * Structured Red Flags for CabinAI Session 4 — Human Review Layer.
 *
 * Red flags are structured { code, message } reasons, NOT hardcoded UI strings
 * scattered throughout the codebase. All user-facing review reasons originate
 * from RedFlagCode + RedFlagMessages defined here.
 *
 * IMPORTANT: model confidence scores are NEVER exposed in review output.
 * deriveRedFlags() only uses decisions, rejection reasons, and evidence.
 */

'use strict';

const { MatchDecision, RejectionReason } = require('../reconciliation/types');

/**
 * Stable machine-readable red-flag codes.
 */
const RedFlagCode = Object.freeze({
  NO_INVOICE_MATCH: 'NO_INVOICE_MATCH',
  MULTIPLE_INVOICES_MATCH: 'MULTIPLE_INVOICES_MATCH',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  VENDOR_UNKNOWN: 'VENDOR_UNKNOWN',
  DIRECTION_CONFLICT: 'DIRECTION_CONFLICT',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  DATE_OUTSIDE_WINDOW: 'DATE_OUTSIDE_WINDOW',
  POSSIBLE_DUPLICATE: 'POSSIBLE_DUPLICATE',
  PROVIDER_PAYOUT_UNRECONCILED: 'PROVIDER_PAYOUT_UNRECONCILED',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE'
});

/**
 * Single source of truth for human-readable review reasons.
 * Keyed by RedFlagCode. No other module should hardcode these strings.
 */
const RedFlagMessages = Object.freeze({
  NO_INVOICE_MATCH: 'No matching invoice found',
  MULTIPLE_INVOICES_MATCH: 'Multiple invoices could match',
  AMOUNT_MISMATCH: 'Amount does not match',
  VENDOR_UNKNOWN: 'Vendor could not be identified',
  DIRECTION_CONFLICT: 'Transaction direction conflicts with invoice',
  CURRENCY_MISMATCH: 'Currency mismatch',
  DATE_OUTSIDE_WINDOW: 'Payment date outside normal window',
  POSSIBLE_DUPLICATE: 'Possible duplicate invoice',
  PROVIDER_PAYOUT_UNRECONCILED: 'Provider payout could not be reconciled',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence to categorize'
});

/**
 * Maps a Session 2 deterministic rejection reason to a red-flag code.
 * @param {string|null} rejectionReason - RejectionReason value
 * @returns {string|null} RedFlagCode or null if no mapping applies
 */
function redFlagForRejectionReason(rejectionReason) {
  switch (rejectionReason) {
    case RejectionReason.INCOMPATIBLE_DIRECTION:
      return RedFlagCode.DIRECTION_CONFLICT;
    case RejectionReason.CURRENCY_MISMATCH:
      return RedFlagCode.CURRENCY_MISMATCH;
    case RejectionReason.AMOUNT_MISMATCH:
      return RedFlagCode.AMOUNT_MISMATCH;
    case RejectionReason.DATE_OUTSIDE_WINDOW:
      return RedFlagCode.DATE_OUTSIDE_WINDOW;
    case RejectionReason.COUNTERPARTY_MISMATCH:
      return RedFlagCode.VENDOR_UNKNOWN;
    case RejectionReason.PROVIDER_CHARGE_NOT_PAYOUT:
    case RejectionReason.REFUND_OR_FEE_NOT_PAYMENT:
      return RedFlagCode.PROVIDER_PAYOUT_UNRECONCILED;
    case RejectionReason.MISSING_AMOUNT:
    case RejectionReason.INCOMPATIBLE_TYPE:
      return RedFlagCode.INSUFFICIENT_EVIDENCE;
    default:
      return null;
  }
}

/**
 * Heuristic: does this transaction look like a payment-provider payout
 * (e.g. a Stripe/Dodo transfer into the bank account)?
 * @param {Object|null} transaction - Normalized bank transaction
 * @returns {boolean}
 */
function looksLikeProviderPayout(transaction) {
  if (!transaction) return false;
  const haystack = [
    transaction.description,
    transaction.bank_reference,
    transaction.source
  ]
    .filter(v => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  return /(stripe|dodo|payout|transfer|payment.?provider)/.test(haystack);
}

/**
 * Derives structured red flags from deterministic + agent outcomes.
 *
 * Inputs are evidence only — confidence scores are never read here and
 * never appear in the output.
 *
 * @param {Object} [opts]
 * @param {Object|null} [opts.transaction] - Normalized bank transaction
 * @param {Object|null} [opts.deterministicResult] - Session 2 MatchResult-like
 *   { decision, rejectionReason?, matchType?, allCandidates?: [{rejectionReason}] }
 * @param {Object|null} [opts.agentResult] - Session 3 AgentResult-like
 *   { decision, needsReview, matchedInvoiceId, matchedVendorId, category, evidence, toolCalls }
 * @returns {Array<{code: string, message: string}>} Ordered, de-duplicated flags
 */
function deriveRedFlags({ transaction = null, deterministicResult = null, agentResult = null } = {}) {
  const codes = [];

  const push = (code) => {
    if (code && !codes.includes(code)) codes.push(code);
  };

  const detDecision = deterministicResult ? deterministicResult.decision : null;

  // --- Deterministic signals ---
  if (detDecision === MatchDecision.AMBIGUOUS) {
    push(RedFlagCode.MULTIPLE_INVOICES_MATCH);
  } else if (detDecision === MatchDecision.UNMATCHED || detDecision === MatchDecision.REJECTED) {
    // Collect specific rejection signals from every evaluated candidate.
    const evaluations = Array.isArray(deterministicResult.allCandidates)
      ? deterministicResult.allCandidates
      : [];
    for (const ev of evaluations) {
      push(redFlagForRejectionReason(ev && ev.rejectionReason));
    }
    // Single-candidate rejections may only carry a top-level rejectionReason.
    push(redFlagForRejectionReason(deterministicResult.rejectionReason));

    if (detDecision === MatchDecision.UNMATCHED) {
      // Provider payouts that cannot be reconciled get their own flag.
      const matchType = deterministicResult.matchType || null;
      if (
        matchType === 'bank_to_provider_payout' ||
        matchType === 'bank_to_provider_record' ||
        looksLikeProviderPayout(transaction)
      ) {
        push(RedFlagCode.PROVIDER_PAYOUT_UNRECONCILED);
      }
      // Fall back to the generic flag when no specific signal fired.
      if (codes.length === 0) {
        push(RedFlagCode.NO_INVOICE_MATCH);
      }
    } else {
      // REJECTED with no mappable reason is still an accounting conflict.
      if (codes.length === 0) {
        push(RedFlagCode.INSUFFICIENT_EVIDENCE);
      }
    }
  }

  // --- Agent signals ---
  if (agentResult) {
    const toolCalls = Array.isArray(agentResult.toolCalls) ? agentResult.toolCalls : [];
    const evidence = Array.isArray(agentResult.evidence) ? agentResult.evidence : [];

    // Duplicate-invoice evidence surfaced by the deterministic duplicate tool.
    for (const tc of toolCalls) {
      const res = tc && tc.result ? tc.result : null;
      if (
        tc && tc.toolName === 'check_duplicate_invoice' &&
        res && !res.error && typeof res.duplicateCount === 'number' && res.duplicateCount > 0
      ) {
        push(RedFlagCode.POSSIBLE_DUPLICATE);
        break;
      }
    }

    // Vendor lookup explicitly returned zero matches.
    for (const tc of toolCalls) {
      const res = tc && tc.result ? tc.result : null;
      if (
        tc && tc.toolName === 'lookup_vendor' &&
        res && !res.error && res.matchCount === 0
      ) {
        push(RedFlagCode.VENDOR_UNKNOWN);
        break;
      }
    }

    // Agent explicitly asks for review / failed / has nothing to go on.
    const decision = agentResult.decision || null;
    if (
      agentResult.needsReview === true ||
      decision === 'needs_review' ||
      decision === 'failed'
    ) {
      if (!agentResult.category && !agentResult.matchedInvoiceId) {
        push(RedFlagCode.INSUFFICIENT_EVIDENCE);
      } else if (evidence.length === 0) {
        push(RedFlagCode.INSUFFICIENT_EVIDENCE);
      }
    }

    // Agent claims a match the deterministic engine could not confirm.
    if (
      (decision === 'matched' || agentResult.matchedInvoiceId) &&
      detDecision && detDecision !== MatchDecision.MATCH
    ) {
      push(RedFlagCode.NO_INVOICE_MATCH);
    }
  }

  return codes.map(code => ({ code, message: RedFlagMessages[code] }));
}

module.exports = {
  RedFlagCode,
  RedFlagMessages,
  redFlagForRejectionReason,
  looksLikeProviderPayout,
  deriveRedFlags
};
