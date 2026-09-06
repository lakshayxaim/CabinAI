/**
 * DecisionService — Session 4 review orchestration.
 *
 * Resolves and persists reconciliation outcomes WITHOUT embedding SQL.
 * All persistence goes through the repositories; this service only applies
 * the decision hierarchy:
 *
 *   human correction / final decision
 *       > deterministic accounting rules
 *       > agent reasoning
 *       > unknown / needs review
 *
 * Never stores API keys — provider/model names only (from agent audit).
 */

'use strict';

const { MatchDecision } = require('../reconciliation/types');
const { AgentDecision } = require('../agent/types');
const { deriveRedFlags, RedFlagMessages } = require('./redFlags');
const ReconciliationDecisionsRepository = require('../db/repositories/reconciliationDecisions');
const ReviewCorrectionsRepository = require('../db/repositories/reviewCorrections');

const NEEDS_REVIEW_FINALS = Object.freeze(['needs_review', 'failed']);

/**
 * Maps a Session 3 agent decision to a persisted final decision vocabulary.
 * @param {string|null} agentDecision
 * @returns {string}
 */
function mapAgentDecision(agentDecision) {
  switch (agentDecision) {
    case AgentDecision.MATCHED:
      return 'matched';
    case AgentDecision.CATEGORIZED:
      return 'categorized';
    case AgentDecision.REJECTED:
      return 'rejected';
    case AgentDecision.UNMATCHED:
      return 'unmatched';
    case AgentDecision.NEEDS_REVIEW:
    case AgentDecision.FAILED:
    default:
      return 'needs_review';
  }
}

class DecisionService {
  /**
   * @param {Object} deps
   * @param {ReconciliationDecisionsRepository} deps.decisions
   * @param {ReviewCorrectionsRepository} deps.corrections
   */
  constructor({ decisions, corrections }) {
    if (!decisions) throw new Error('DecisionService: decisions repository is required');
    if (!corrections) throw new Error('DecisionService: corrections repository is required');
    this.decisions = decisions;
    this.corrections = corrections;
  }

  /**
   * Applies the decision hierarchy to produce the proposed outcome.
   * Human state is handled by the repository (human-locked rows keep their outcome).
   *
   * @param {Object} [opts]
   * @param {Object|null} [opts.deterministicResult] - Session 2 MatchResult-like
   * @param {Object|null} [opts.agentResult] - Session 3 AgentResult-like
   * @returns {{ finalDecision, category, confidence, matchedInvoiceId, matchedVendorId, reasoning, evidence }}
   */
  resolveOutcome({ deterministicResult = null, agentResult = null } = {}) {
    const detDecision = deterministicResult ? deterministicResult.decision : null;
    const agentDecision = agentResult ? agentResult.decision : null;

    const agentEvidence = agentResult && Array.isArray(agentResult.evidence)
      ? agentResult.evidence.filter(e => typeof e === 'string')
      : [];
    const detSummary = deterministicResult && deterministicResult.reasons
      ? deterministicResult.reasons.summary || null
      : null;

    const reasoning = (agentResult && agentResult.reasoning) || detSummary || 'No reasoning available';
    const evidence = agentEvidence.length > 0
      ? agentEvidence
      : (detSummary ? [detSummary] : []);

    const base = {
      category: (agentResult && agentResult.category) || null,
      confidence: agentResult && typeof agentResult.confidence === 'number'
        ? agentResult.confidence
        : null,
      matchedInvoiceId: null,
      matchedVendorId: (agentResult && agentResult.matchedVendorId) || null,
      reasoning,
      evidence
    };

    // Deterministic accounting rules outrank agent reasoning.
    if (detDecision === MatchDecision.MATCH) {
      return {
        ...base,
        finalDecision: 'matched',
        matchedInvoiceId:
          (deterministicResult && (deterministicResult.candidateId || null)) ||
          (agentResult && agentResult.matchedInvoiceId) ||
          null
      };
    }

    if (detDecision === MatchDecision.REJECTED) {
      return { ...base, finalDecision: 'rejected', matchedInvoiceId: null };
    }

    // Ambiguous / unmatched deterministic outcome: agent may propose, but a
    // claimed agent match the engine could not confirm is an accounting
    // conflict and stays in review.
    if (agentDecision === AgentDecision.MATCHED || (agentResult && agentResult.matchedInvoiceId)) {
      return {
        ...base,
        finalDecision: 'needs_review',
        matchedInvoiceId: (agentResult && agentResult.matchedInvoiceId) || null
      };
    }

    if (agentDecision === AgentDecision.CATEGORIZED) {
      return { ...base, finalDecision: 'categorized' };
    }

    if (agentDecision === AgentDecision.REJECTED) {
      return { ...base, finalDecision: 'rejected', matchedInvoiceId: null };
    }

    if (agentDecision === AgentDecision.UNMATCHED) {
      return { ...base, finalDecision: 'unmatched', matchedInvoiceId: null };
    }

    return { ...base, finalDecision: mapAgentDecision(agentDecision), matchedInvoiceId: null };
  }

  /**
   * Persists a reconciliation outcome idempotently.
   * Computes red flags, resolves the proposed final decision, and stores
   * everything via the decisions repository.
   *
   * @param {Object} [opts]
   * @param {Object} opts.transaction - Normalized bank transaction (must have id)
   * @param {Object|null} [opts.deterministicResult]
   * @param {Object|null} [opts.agentResult]
   * @returns {{ record, redFlags, created, humanLocked }}
   */
  persistDecision({ transaction, deterministicResult = null, agentResult = null } = {}) {
    const transactionId = transaction && (transaction.id || transaction.transaction_id);
    if (!transactionId) {
      throw new Error('DecisionService.persistDecision: transaction.id is required');
    }

    const outcome = this.resolveOutcome({ deterministicResult, agentResult });

    let redFlags = deriveRedFlags({ transaction, deterministicResult, agentResult });

    const agentNeedsReview = Boolean(
      (agentResult && agentResult.needsReview) ||
      (agentResult && NEEDS_REVIEW_FINALS.includes(agentResult.decision))
    );
    const needsReview = redFlags.length > 0 || agentNeedsReview ||
      NEEDS_REVIEW_FINALS.includes(outcome.finalDecision);

    // Every queued item must carry at least one human-readable reason.
    if (needsReview && redFlags.length === 0) {
      redFlags.push({
        code: 'INSUFFICIENT_EVIDENCE',
        message: RedFlagMessages.INSUFFICIENT_EVIDENCE
      });
    }

    const audit = (agentResult && agentResult.audit) || {};
    const { record, created, humanLocked } = this.decisions.saveDecision({
      transaction_id: transactionId,
      deterministic_decision: deterministicResult ? deterministicResult.decision : null,
      agent_decision: agentResult ? agentResult.decision : null,
      final_decision: outcome.finalDecision,
      category: outcome.category,
      confidence: outcome.confidence,
      matched_invoice_id: outcome.matchedInvoiceId,
      matched_vendor_id: outcome.matchedVendorId,
      reasoning: outcome.reasoning,
      evidence: outcome.evidence,
      needs_review: needsReview,
      provider: audit.provider || null,
      model: audit.model || null,
      fallback_occurred: audit.fallbackOccurred === true
    });

    // Persist computed red flags alongside the decision for the review queue.
    // (Stored via a dedicated update so the repository keeps owning all SQL.)
    this.decisions.saveRedFlags(transactionId, redFlags);

    return {
      record: this.decisions.findByTransactionId(transactionId),
      redFlags,
      created,
      humanLocked
    };
  }

  /**
   * Returns the human review queue. Confidence scores are NEVER exposed here.
   * @returns {Array<Object>}
   */
  getReviewQueue() {
    return this.decisions.listReviewQueue().map(row => ({
      transaction_id: row.transaction_id,
      final_decision: row.final_decision,
      category: row.category,
      matched_invoice_id: row.matched_invoice_id,
      matched_vendor_id: row.matched_vendor_id,
      reasoning: row.reasoning,
      red_flags: DecisionService.parseRedFlags(row.red_flags),
      review_status: row.review_status,
      created_at: row.created_at
    }));
  }

  static parseRedFlags(stored) {
    if (!stored) return [];
    try {
      const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Approves the proposed decision. Final decision becomes authoritative.
   * @returns {Object|null} Updated decision row
   */
  approve(transactionId, { reviewerDecision = null, reason = null } = {}) {
    return this.decisions.approve(transactionId, { reviewerDecision, reason });
  }

  /**
   * Corrects category / invoice match / vendor match / final decision and
   * appends the correction to the audit log.
   * @returns {{ decision: Object, correction: Object }|null}
   */
  correct(transactionId, { category, invoiceId, vendorId, finalDecision, reason = null } = {}) {
    const applied = this.decisions.applyCorrection(transactionId, {
      category, invoiceId, vendorId, finalDecision, reason
    });
    if (!applied) return null;

    const correction = this.corrections.logCorrection({
      transaction_id: transactionId,
      original_category: applied.original.category,
      corrected_category: applied.record.category,
      original_invoice_id: applied.original.invoiceId,
      corrected_invoice_id: applied.record.matched_invoice_id,
      original_vendor_id: applied.original.vendorId,
      corrected_vendor_id: applied.record.matched_vendor_id,
      reason
    });

    return { decision: applied.record, correction };
  }

  /**
   * Convenience factory wiring real repositories to a database handle.
   * @param {Object} db - better-sqlite3 database handle
   */
  static create(db) {
    return new DecisionService({
      decisions: new ReconciliationDecisionsRepository(db),
      corrections: new ReviewCorrectionsRepository(db)
    });
  }
}

module.exports = DecisionService;
