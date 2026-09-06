/**
 * ReconciliationDecisionsRepository — Session 4 persistence layer.
 *
 * Owns ALL SQL for the reconciliation_decisions table. Agent orchestration
 * code must never embed SQL; it goes through this repository (or the
 * DecisionService) instead.
 *
 * Human-authority rule enforced here:
 * once review_status is 'approved' or 'corrected', saveDecision() refreshes
 * only diagnostic columns and NEVER overwrites the human's authoritative
 * outcome (final_decision / category / invoice / vendor / review state).
 */

'use strict';

const crypto = require('crypto');

const HUMAN_LOCKED_STATUSES = Object.freeze(['approved', 'corrected']);

function nowIso() {
  return new Date().toISOString();
}

function toIntBool(v) {
  return v ? 1 : 0;
}

class ReconciliationDecisionsRepository {
  constructor(db) {
    this.db = db;

    this.insertStmt = db.prepare(`
      INSERT INTO reconciliation_decisions (
        id, transaction_id, deterministic_decision, agent_decision, final_decision,
        category, confidence, matched_invoice_id, matched_vendor_id,
        reasoning, evidence, needs_review, provider, model, fallback_occurred,
        review_status
      ) VALUES (
        @id, @transaction_id, @deterministic_decision, @agent_decision, @final_decision,
        @category, @confidence, @matched_invoice_id, @matched_vendor_id,
        @reasoning, @evidence, @needs_review, @provider, @model, @fallback_occurred,
        @review_status
      )
      ON CONFLICT(transaction_id) DO UPDATE SET
        deterministic_decision = excluded.deterministic_decision,
        agent_decision = excluded.agent_decision,
        final_decision = excluded.final_decision,
        category = excluded.category,
        confidence = excluded.confidence,
        matched_invoice_id = excluded.matched_invoice_id,
        matched_vendor_id = excluded.matched_vendor_id,
        reasoning = excluded.reasoning,
        evidence = excluded.evidence,
        needs_review = excluded.needs_review,
        provider = excluded.provider,
        model = excluded.model,
        fallback_occurred = excluded.fallback_occurred
    `);

    // Diagnostic-only refresh used when a row is human-locked.
    this.refreshDiagnosticsStmt = db.prepare(`
      UPDATE reconciliation_decisions SET
        deterministic_decision = @deterministic_decision,
        agent_decision = @agent_decision,
        reasoning = @reasoning,
        evidence = @evidence,
        provider = @provider,
        model = @model,
        fallback_occurred = @fallback_occurred
      WHERE transaction_id = @transaction_id
    `);

    this.findByTxStmt = db.prepare(
      `SELECT * FROM reconciliation_decisions WHERE transaction_id = ?`
    );
    this.saveRedFlagsStmt = db.prepare(`
      UPDATE reconciliation_decisions SET red_flags = @red_flags
      WHERE transaction_id = @transaction_id
    `);
    this.findByIdStmt = db.prepare(
      `SELECT * FROM reconciliation_decisions WHERE id = ?`
    );
    this.reviewQueueStmt = db.prepare(`
      SELECT * FROM reconciliation_decisions
      WHERE needs_review = 1 AND review_status = 'pending'
      ORDER BY created_at ASC
    `);
    this.approveStmt = db.prepare(`
      UPDATE reconciliation_decisions SET
        review_status = 'approved',
        reviewed_at = @reviewed_at,
        reviewer_decision = @reviewer_decision,
        correction_reason = @correction_reason,
        needs_review = 0
      WHERE transaction_id = @transaction_id
    `);
    this.correctStmt = db.prepare(`
      UPDATE reconciliation_decisions SET
        final_decision = @final_decision,
        category = @category,
        matched_invoice_id = @matched_invoice_id,
        matched_vendor_id = @matched_vendor_id,
        review_status = 'corrected',
        reviewed_at = @reviewed_at,
        reviewer_decision = @reviewer_decision,
        correction_reason = @correction_reason,
        needs_review = 0
      WHERE transaction_id = @transaction_id
    `);
  }

  static isHumanLocked(row) {
    return Boolean(row) && HUMAN_LOCKED_STATUSES.includes(row.review_status);
  }

  /**
   * Idempotent persist keyed on transaction_id.
   * Never overwrites a human-approved/corrected outcome.
   *
   * @param {Object} input
   * @returns {{ record: Object, created: boolean, humanLocked: boolean }}
   */
  saveDecision(input) {
    if (!input || !input.transaction_id) {
      throw new Error('ReconciliationDecisionsRepository.saveDecision: transaction_id is required');
    }
    if (!input.final_decision) {
      throw new Error('ReconciliationDecisionsRepository.saveDecision: final_decision is required');
    }

    const existing = this.findByTransactionId(input.transaction_id);

    const params = {
      deterministic_decision: input.deterministic_decision || null,
      agent_decision: input.agent_decision || null,
      reasoning: input.reasoning || null,
      evidence: typeof input.evidence === 'string' ? input.evidence : JSON.stringify(input.evidence || []),
      provider: input.provider || null,
      model: input.model || null,
      fallback_occurred: toIntBool(input.fallback_occurred)
    };

    // Human-locked rows: refresh diagnostics only, preserve the human outcome.
    if (ReconciliationDecisionsRepository.isHumanLocked(existing)) {
      this.refreshDiagnosticsStmt.run({ ...params, transaction_id: input.transaction_id });
      return { record: this.findByTransactionId(input.transaction_id), created: false, humanLocked: true };
    }

    const info = this.insertStmt.run({
      id: (existing && existing.id) || input.id || crypto.randomUUID(),
      transaction_id: input.transaction_id,
      ...params,
      final_decision: input.final_decision,
      category: input.category || null,
      confidence: typeof input.confidence === 'number' ? input.confidence : null,
      matched_invoice_id: input.matched_invoice_id || null,
      matched_vendor_id: input.matched_vendor_id || null,
      needs_review: toIntBool(input.needs_review),
      review_status: 'pending'
    });

    return {
      record: this.findByTransactionId(input.transaction_id),
      created: !existing && info.changes > 0,
      humanLocked: false
    };
  }

  findByTransactionId(transactionId) {
    return this.findByTxStmt.get(transactionId) || null;
  }

  /**
   * Stores the computed review red flags ({code, message}[]) for a decision.
   * Flags are structured data — never contains confidence scores.
   */
  saveRedFlags(transactionId, redFlags) {
    const value = typeof redFlags === 'string' ? redFlags : JSON.stringify(redFlags || []);
    this.saveRedFlagsStmt.run({ transaction_id: transactionId, red_flags: value });
    return this.findByTransactionId(transactionId);
  }

  findById(id) {
    return this.findByIdStmt.get(id) || null;
  }

  /**
   * Rows awaiting human review: flagged AND not yet approved/corrected.
   */
  listReviewQueue() {
    return this.reviewQueueStmt.all();
  }

  listAll() {
    return this.db
      .prepare(`SELECT * FROM reconciliation_decisions ORDER BY created_at ASC`)
      .all();
  }

  count() {
    return this.db.prepare(`SELECT COUNT(*) as count FROM reconciliation_decisions`).get().count;
  }

  /**
   * Approves the proposed decision. After approval the row is human-locked:
   * final_decision becomes authoritative and needs_review is cleared.
   * @returns {Object|null} Updated row, or null when transaction unknown
   */
  approve(transactionId, { reviewerDecision = null, reason = null } = {}) {
    const existing = this.findByTransactionId(transactionId);
    if (!existing) return null;
    this.approveStmt.run({
      transaction_id: transactionId,
      reviewed_at: nowIso(),
      reviewer_decision: reviewerDecision || existing.final_decision,
      correction_reason: reason || null
    });
    return this.findByTransactionId(transactionId);
  }

  /**
   * Applies a reviewer correction and human-locks the row.
   * @returns {{ record: Object, original: Object }|null}
   */
  applyCorrection(transactionId, { category, invoiceId, vendorId, finalDecision, reason = null } = {}) {
    const existing = this.findByTransactionId(transactionId);
    if (!existing) return null;

    const original = {
      category: existing.category,
      invoiceId: existing.matched_invoice_id,
      vendorId: existing.matched_vendor_id,
      finalDecision: existing.final_decision
    };

    const nextFinal = finalDecision || existing.final_decision;
    this.correctStmt.run({
      transaction_id: transactionId,
      final_decision: nextFinal,
      category: category !== undefined ? category : existing.category,
      matched_invoice_id: invoiceId !== undefined ? invoiceId : existing.matched_invoice_id,
      matched_vendor_id: vendorId !== undefined ? vendorId : existing.matched_vendor_id,
      reviewed_at: nowIso(),
      reviewer_decision: nextFinal,
      correction_reason: reason || null
    });

    return { record: this.findByTransactionId(transactionId), original };
  }
}

module.exports = ReconciliationDecisionsRepository;
