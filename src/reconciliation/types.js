/**
 * Reconciliation Domain Types and Constants for CabinAI Session 2.
 * Pure domain models, free from SQLite, CLI, or external dependencies.
 */

const MatchDecision = Object.freeze({
  MATCH: 'match',
  AMBIGUOUS: 'ambiguous',
  UNMATCHED: 'unmatched',
  REJECTED: 'rejected'
});

const MatchType = Object.freeze({
  BANK_TO_INVOICE: 'bank_to_invoice',
  BANK_TO_PROVIDER_PAYOUT: 'bank_to_provider_payout',
  BANK_TO_PROVIDER_RECORD: 'bank_to_provider_record',
  UNKNOWN: 'unknown'
});

const RejectionReason = Object.freeze({
  INCOMPATIBLE_DIRECTION: 'incompatible_direction',
  INCOMPATIBLE_TYPE: 'incompatible_type',
  CURRENCY_MISMATCH: 'currency_mismatch',
  AMOUNT_MISMATCH: 'amount_mismatch',
  DATE_OUTSIDE_WINDOW: 'date_outside_window',
  COUNTERPARTY_MISMATCH: 'counterparty_mismatch',
  PROVIDER_CHARGE_NOT_PAYOUT: 'provider_charge_not_payout',
  REFUND_OR_FEE_NOT_PAYMENT: 'refund_or_fee_not_payment',
  MISSING_AMOUNT: 'missing_amount'
});

const DEFAULT_CONFIG = Object.freeze({
  confidenceThreshold: 0.80,     // Minimum overall score to qualify as a match
  ambiguityMargin: 0.10,         // Minimum score delta between #1 and #2 to prevent ambiguity
  dateWindowDays: 30,            // Default acceptable days difference for dates
  maxDaysBeforeIssue: 2,         // Max allowable days payment can appear before invoice issue date
  maxDaysAfterDue: 30,           // Max allowable days payment can appear after invoice due date
  amountTolerance: 0.00,         // Strict monetary equality by default (0.00 difference)
  counterpartyThreshold: 0.70,   // Minimum similarity score for vendor matching
  explicitAccountingToleranceReason: null, // Disallow tolerance as generic rescue mechanism
  allowedToleranceMatchTypes: Object.freeze([]) // Match types explicitly authorized for tolerance
});

/**
 * Immutable candidate evaluation representation.
 */
class CandidateEvaluation {
  constructor({
    candidate,
    candidateId,
    candidateType,
    score = 0.0,
    isCompatible = false,
    isStage1Compatible = true,
    rejectionReason = null,
    amountComparison = null,
    dateDifference = null,
    counterpartySimilarity = null,
    reasons = {}
  }) {
    this.candidate = candidate;
    this.candidateId = candidateId || candidate?.id || candidate?.provider_record_id || null;
    this.candidateType = candidateType;
    this.score = score;
    this.isCompatible = isCompatible;
    this.isStage1Compatible = isStage1Compatible;
    this.rejectionReason = rejectionReason;
    this.amountComparison = amountComparison ? Object.freeze({ ...amountComparison }) : null;
    this.dateDifference = dateDifference ? Object.freeze({ ...dateDifference }) : null;
    this.counterpartySimilarity = counterpartySimilarity ? Object.freeze({ ...counterpartySimilarity }) : null;
    this.reasons = Object.freeze({ ...reasons });
    Object.freeze(this);
  }
}

/**
 * Immutable reconciliation match result.
 */
class MatchResult {
  constructor({
    source,
    candidate = null,
    candidateId = null,
    matchType = MatchType.UNKNOWN,
    score = 0.0,
    decision = MatchDecision.UNMATCHED,
    amountComparison = null,
    dateDifference = null,
    counterpartySimilarity = null,
    reasons = {},
    allCandidates = []
  }) {
    this.source = source;
    this.candidate = candidate;
    this.candidateId = candidateId || candidate?.id || candidate?.provider_record_id || null;
    this.matchType = matchType;
    this.score = score;
    this.decision = decision;
    this.amountComparison = amountComparison ? Object.freeze({ ...amountComparison }) : null;
    this.dateDifference = dateDifference ? Object.freeze({ ...dateDifference }) : null;
    this.counterpartySimilarity = counterpartySimilarity ? Object.freeze({ ...counterpartySimilarity }) : null;
    this.reasons = Object.freeze({ ...reasons });
    this.allCandidates = Object.freeze([...allCandidates]);
    Object.freeze(this);
  }
}

module.exports = {
  MatchDecision,
  MatchType,
  RejectionReason,
  DEFAULT_CONFIG,
  CandidateEvaluation,
  MatchResult
};
