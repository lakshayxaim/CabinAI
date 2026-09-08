/**
 * Deterministic Reconciliation Matcher for CabinAI Session 2.
 * Matches normalized cash movements (bank transactions) against invoices/bills
 * and payment-provider records before any LLM call.
 * Pure in-memory logic: decoupled from SQLite, CLI, and external APIs.
 */

const {
  MatchDecision,
  MatchType,
  RejectionReason,
  DEFAULT_CONFIG,
  CandidateEvaluation,
  MatchResult
} = require('./types');
const { calculateCounterpartySimilarity, extractBankCounterparty } = require('./normalizers');
const { compareAmount, compareDate, calculateDeterministicScore } = require('./scoring');
const { Direction, DocumentType, ProviderType } = require('../models/types');
const { normalizeCurrency } = require('../normalizers/amountNormalizer');
const { normalizeDate } = require('../normalizers/dateNormalizer');

class DeterministicMatcher {
  /**
   * @param {Object} [config] Custom configuration options
   */
  constructor(config = {}) {
    this.config = Object.freeze({
      ...DEFAULT_CONFIG,
      ...config
    });
  }

  /**
   * Stage 1: Direction and type compatibility check.
   * Deterministically rejects incompatible candidate pairs before detailed scoring.
   *
   * Accounting rules:
   * 1. Bank OUTFLOW <-> AP / Payable invoice (business paying vendor).
   *    Bank OUTFLOW + AR / Receivable invoice -> REJECTED.
   * 2. Bank INFLOW <-> AR / Receivable invoice (customer paying business).
   *    Bank INFLOW + AP / Payable invoice -> REJECTED.
   * 3. Bank INFLOW <-> Payment Provider Payout (provider depositing funds to company bank).
   *    Bank OUTFLOW + Provider Payout -> REJECTED.
   * 4. Provider Charge / Payment is NOT a payout -> REJECTED.
   * 5. Provider Refund / Fee is NOT an invoice payment or payout -> REJECTED.
   * 6. Unknown document type invoices -> REJECTED (insufficient evidence).
   * 7. Currency mismatch -> REJECTED.
   *
   * @param {Object} source Source bank transaction
   * @param {Object} candidate Candidate record (invoice or payment_provider_record)
   * @returns {{ isCompatible: boolean, matchType: string, rejectionReason: string|null, explanation: string }}
   */
  checkCompatibility(source, candidate) {
    if (!source || !candidate) {
      return {
        isCompatible: false,
        matchType: MatchType.UNKNOWN,
        rejectionReason: RejectionReason.INCOMPATIBLE_TYPE,
        explanation: 'Source or candidate record is missing'
      };
    }

    // Currency check
    const sourceCurr = normalizeCurrency(source.currency);
    const candCurr = normalizeCurrency(candidate.currency);
    if (sourceCurr !== candCurr) {
      return {
        isCompatible: false,
        matchType: MatchType.UNKNOWN,
        rejectionReason: RejectionReason.CURRENCY_MISMATCH,
        explanation: `Currency mismatch: source currency is ${sourceCurr}, candidate currency is ${candCurr}`
      };
    }

    // Identify candidate entity type
    const isInvoice = candidate.document_type !== undefined || candidate.invoice_number !== undefined;
    const isProviderRecord = candidate.provider !== undefined || candidate.record_type !== undefined;

    if (isInvoice) {
      const docType = candidate.document_type;

      // Reject unknown/ambiguous document types
      if (docType === DocumentType.UNKNOWN || !docType) {
        return {
          isCompatible: false,
          matchType: MatchType.BANK_TO_INVOICE,
          rejectionReason: RejectionReason.INCOMPATIBLE_TYPE,
          explanation: 'Invoice has unknown document_type; cannot be deterministically matched'
        };
      }

      // Check if invoice has valid total
      if (candidate.total === null || candidate.total === undefined || isNaN(candidate.total)) {
        return {
          isCompatible: false,
          matchType: MatchType.BANK_TO_INVOICE,
          rejectionReason: RejectionReason.MISSING_AMOUNT,
          explanation: 'Invoice total is null or missing; cannot match cash movement'
        };
      }

      // AP (Payable) matches bank OUTFLOW
      if (docType === DocumentType.PAYABLE) {
        if (source.direction === Direction.OUTFLOW) {
          return {
            isCompatible: true,
            matchType: MatchType.BANK_TO_INVOICE,
            rejectionReason: null,
            explanation: 'Compatible: payable invoice matches bank cash outflow'
          };
        } else {
          return {
            isCompatible: false,
            matchType: MatchType.BANK_TO_INVOICE,
            rejectionReason: RejectionReason.INCOMPATIBLE_DIRECTION,
            explanation: `Direction mismatch: payable invoice corresponds to bank outflow, but transaction is ${source.direction}`
          };
        }
      }

      // AR (Receivable) matches bank INFLOW
      if (docType === DocumentType.RECEIVABLE) {
        if (source.direction === Direction.INFLOW) {
          return {
            isCompatible: true,
            matchType: MatchType.BANK_TO_INVOICE,
            rejectionReason: null,
            explanation: 'Compatible: receivable invoice matches bank cash inflow'
          };
        } else {
          return {
            isCompatible: false,
            matchType: MatchType.BANK_TO_INVOICE,
            rejectionReason: RejectionReason.INCOMPATIBLE_DIRECTION,
            explanation: `Direction mismatch: receivable invoice corresponds to bank inflow, but transaction is ${source.direction}`
          };
        }
      }

      return {
        isCompatible: false,
        matchType: MatchType.BANK_TO_INVOICE,
        rejectionReason: RejectionReason.INCOMPATIBLE_TYPE,
        explanation: `Unsupported document type: ${docType}`
      };
    }

    if (isProviderRecord) {
      const recType = candidate.record_type;

      // Fees and refunds must not accidentally be matched as ordinary payments or payouts
      if (recType === 'refund' || recType === 'fee' || recType === 'dispute') {
        return {
          isCompatible: false,
          matchType: MatchType.BANK_TO_PROVIDER_RECORD,
          rejectionReason: RejectionReason.REFUND_OR_FEE_NOT_PAYMENT,
          explanation: `Payment provider ${recType} records cannot be matched as ordinary cash movements`
        };
      }

      // Customer charges/payments are not cash payouts to the company bank account
      if (recType === 'charge' || recType === 'payment') {
        return {
          isCompatible: false,
          matchType: MatchType.BANK_TO_PROVIDER_RECORD,
          rejectionReason: RejectionReason.PROVIDER_CHARGE_NOT_PAYOUT,
          explanation: 'Payment provider charge/payment is an individual customer transaction, not a bank cash payout'
        };
      }

      // Provider payouts correspond strictly to bank INFLOW
      if (recType === 'payout') {
        if (source.direction === Direction.INFLOW) {
          return {
            isCompatible: true,
            matchType: MatchType.BANK_TO_PROVIDER_PAYOUT,
            rejectionReason: null,
            explanation: 'Compatible: payment provider payout matches bank cash inflow'
          };
        } else {
          return {
            isCompatible: false,
            matchType: MatchType.BANK_TO_PROVIDER_PAYOUT,
            rejectionReason: RejectionReason.INCOMPATIBLE_DIRECTION,
            explanation: `Direction mismatch: provider payout corresponds to bank inflow, but transaction is ${source.direction}`
          };
        }
      }

      return {
        isCompatible: false,
        matchType: MatchType.BANK_TO_PROVIDER_RECORD,
        rejectionReason: RejectionReason.INCOMPATIBLE_TYPE,
        explanation: `Unknown provider record_type: ${recType}`
      };
    }

    return {
      isCompatible: false,
      matchType: MatchType.UNKNOWN,
      rejectionReason: RejectionReason.INCOMPATIBLE_TYPE,
      explanation: 'Unrecognized candidate entity type'
    };
  }

  /**
   * Evaluates a single candidate against a source bank transaction across all 4 stages.
   * @param {Object} source Bank transaction
   * @param {Object} candidate Candidate record (invoice or payment_provider_record)
   * @param {Object} [options] Evaluation options overriding instance defaults
   * @returns {CandidateEvaluation}
   */
  evaluateCandidate(source, candidate, options = {}) {
    const opts = { ...this.config, ...options };

    // Stage 1: Direction and Type Compatibility
    const compat = this.checkCompatibility(source, candidate);
    if (!compat.isCompatible) {
      return new CandidateEvaluation({
        candidate,
        candidateId: candidate.id || candidate.provider_record_id,
        candidateType: compat.matchType,
        score: 0.0,
        isCompatible: false,
        isStage1Compatible: false,
        rejectionReason: compat.rejectionReason,
        reasons: {
          compatibility: compat.explanation,
          summary: `Candidate rejected: ${compat.explanation}`
        }
      });
    }

    // Extract normalized candidate values
    const isInvoice = candidate.document_type !== undefined || candidate.invoice_number !== undefined;
    let candidateAmount;
    let candidateCurrency = candidate.currency;
    let candidateDates = {};
    let candidateCounterparty;

    if (isInvoice) {
      candidateAmount = candidate.total;
      candidateDates = {
        issueDate: candidate.issue_date,
        dueDate: candidate.due_date
      };
      candidateCounterparty = candidate.counterparty_name || null;
    } else {
      // Provider record (payout)
      candidateAmount = candidate.amount !== undefined ? candidate.amount : candidate.net_amount;
      candidateDates = {
        transactionDate: candidate.transaction_time ? candidate.transaction_time.slice(0, 10) : null,
        arrivalDate: candidate.arrival_date ? normalizeDate(candidate.arrival_date) : null
      };
      candidateCounterparty = candidate.provider; // 'stripe' or 'dodo'
    }

    // Stage 2: Amount Comparison
    const amountResult = compareAmount(
      source.amount,
      candidateAmount,
      source.currency,
      candidateCurrency,
      opts,
      { matchType: compat.matchType }
    );

    // Stage 3: Date Window Comparison
    const dateResult = compareDate(
      source.transaction_date,
      candidateDates,
      opts
    );

    // Stage 4: Counterparty / Vendor Similarity
    const sourceCounterparty = source.description || null;
    const counterpartyResult = calculateCounterpartySimilarity(
      sourceCounterparty,
      candidateCounterparty
    );

    // Scoring & Explanations
    const { score, reasons } = calculateDeterministicScore({
      amountResult,
      dateResult,
      counterpartyResult,
      options: opts
    });

    const isScoreCompatible = amountResult.isCompatible && dateResult.isWithinWindow;

    return new CandidateEvaluation({
      candidate,
      candidateId: candidate.id || candidate.provider_record_id,
      candidateType: compat.matchType,
      score,
      isCompatible: isScoreCompatible,
      isStage1Compatible: true,
      rejectionReason: !amountResult.isCompatible
        ? amountResult.rejectionReason
        : (!dateResult.isWithinWindow ? dateResult.rejectionReason : null),
      amountComparison: {
        sourceAmount: source.amount,
        candidateAmount,
        sourceCurrency: source.currency,
        candidateCurrency,
        isExact: amountResult.isExact,
        difference: amountResult.difference,
        score: amountResult.score
      },
      dateDifference: {
        sourceDate: source.transaction_date,
        candidateDates,
        daysDifference: dateResult.daysDifference,
        isWithinWindow: dateResult.isWithinWindow,
        score: dateResult.score
      },
      counterpartySimilarity: {
        source: sourceCounterparty,
        candidate: candidateCounterparty,
        normalizedSource: counterpartyResult.normalized1,
        normalizedCandidate: counterpartyResult.normalized2,
        similarityScore: counterpartyResult.score,
        isEvaluated: counterpartyResult.isEvaluated
      },
      reasons: {
        compatibility: compat.explanation,
        ...reasons
      }
    });
  }

  /**
   * Matches a single source bank transaction against a list of candidates.
   * Performs candidate filtering, scoring, ranking, threshold check, and ambiguity resolution.
   *
   * @param {Object} sourceTransaction Source bank transaction
   * @param {Array<Object>} candidates Candidate records (invoices, provider records)
   * @param {Object} [options] Configuration overrides
   * @returns {MatchResult}
   */
  matchTransaction(sourceTransaction, candidates = [], options = {}) {
    const opts = { ...this.config, ...options };
    const { confidenceThreshold, ambiguityMargin } = opts;

    if (!candidates || candidates.length === 0) {
      return new MatchResult({
        source: sourceTransaction,
        candidate: null,
        score: 0.0,
        decision: MatchDecision.UNMATCHED,
        reasons: {
          summary: 'No candidate records provided for reconciliation'
        },
        allCandidates: []
      });
    }

    // Evaluate all candidates
    const evaluations = candidates.map(c => this.evaluateCandidate(sourceTransaction, c, opts));

    // Filter compatible candidates that have valid scores
    const compatible = evaluations.filter(e => e.isCompatible && e.score > 0);

    // If no candidates were compatible
    if (compatible.length === 0) {
      // If there was only 1 candidate and it was fundamentally incompatible in Stage 1
      // (e.g. direction mismatch, currency mismatch, provider charge instead of payout)
      if (evaluations.length === 1 && !evaluations[0].isStage1Compatible) {
        const rejected = evaluations[0];
        return new MatchResult({
          source: sourceTransaction,
          candidate: null,
          candidateId: null,
          matchType: rejected.candidateType,
          score: 0.0,
          decision: MatchDecision.REJECTED,
          amountComparison: rejected.amountComparison,
          dateDifference: rejected.dateDifference,
          counterpartySimilarity: rejected.counterpartySimilarity,
          reasons: rejected.reasons,
          allCandidates: evaluations
        });
      }

      // Otherwise (amount difference, date outside window, or multiple incompatible candidates)
      return new MatchResult({
        source: sourceTransaction,
        candidate: null,
        candidateId: null,
        matchType: MatchType.UNKNOWN,
        score: 0.0,
        decision: MatchDecision.UNMATCHED,
        amountComparison: null,
        dateDifference: null,
        counterpartySimilarity: null,
        reasons: {
          summary: `None of the ${candidates.length} candidate(s) met compatibility and matching criteria`
        },
        allCandidates: evaluations
      });
    }

    // Rank compatible candidates descending by score
    compatible.sort((a, b) => b.score - a.score);

    const best = compatible[0];

    // Check if best candidate clears the confidence threshold
    if (best.score < confidenceThreshold) {
      return new MatchResult({
        source: sourceTransaction,
        candidate: null,
        candidateId: null,
        matchType: best.candidateType,
        score: best.score,
        decision: MatchDecision.UNMATCHED,
        amountComparison: best.amountComparison,
        dateDifference: best.dateDifference,
        counterpartySimilarity: best.counterpartySimilarity,
        reasons: {
          ...best.reasons,
          summary: `Best candidate score (${(best.score * 100).toFixed(1)}%) is below confidence threshold (${(confidenceThreshold * 100).toFixed(1)}%)`
        },
        allCandidates: evaluations
      });
    }

    // Check for ambiguity if there are multiple candidates
    if (compatible.length > 1) {
      const secondBest = compatible[1];
      const scoreDelta = Math.round((best.score - secondBest.score) * 1000) / 1000;

      // If second candidate is also plausible and score delta is within ambiguity margin
      if (scoreDelta < ambiguityMargin && secondBest.score >= (confidenceThreshold - ambiguityMargin)) {
        return new MatchResult({
          source: sourceTransaction,
          candidate: null, // Do not arbitrarily select one
          matchType: best.candidateType,
          score: best.score,
          decision: MatchDecision.AMBIGUOUS,
          reasons: {
            amount: best.reasons.amount,
            date: best.reasons.date,
            counterparty: best.reasons.counterparty,
            summary: `Ambiguous match: Candidate ${best.candidateId} (score: ${(best.score * 100).toFixed(1)}%) ` +
                     `and Candidate ${secondBest.candidateId} (score: ${(secondBest.score * 100).toFixed(1)}%) ` +
                     `are separated by only ${(scoreDelta * 100).toFixed(1)}% (margin required: ${(ambiguityMargin * 100).toFixed(1)}%)`
          },
          allCandidates: evaluations
        });
      }
    }

    // Clear winner clearing threshold with sufficient separation
    return new MatchResult({
      source: sourceTransaction,
      candidate: best.candidate,
      candidateId: best.candidateId,
      matchType: best.candidateType,
      score: best.score,
      decision: MatchDecision.MATCH,
      amountComparison: best.amountComparison,
      dateDifference: best.dateDifference,
      counterpartySimilarity: best.counterpartySimilarity,
      reasons: {
        ...best.reasons,
        summary: `Deterministic match cleared confidence threshold (${(best.score * 100).toFixed(1)}% >= ${(confidenceThreshold * 100).toFixed(1)}%)`
      },
      allCandidates: evaluations
    });
  }

  /**
   * Alias for matchTransaction.
   */
  match(sourceTransaction, candidates = [], options = {}) {
    return this.matchTransaction(sourceTransaction, candidates, options);
  }

  /**
   * Reconciles a batch of source transactions against available candidates.
   * @param {Array<Object>} transactions Source bank transactions
   * @param {Array<Object>} candidates Candidate records
   * @param {Object} [options] Configuration overrides
   * @returns {Array<MatchResult>}
   */
  reconcileBatch(transactions = [], candidates = [], options = {}) {
    return transactions.map(tx => this.matchTransaction(tx, candidates, options));
  }
}

module.exports = DeterministicMatcher;
