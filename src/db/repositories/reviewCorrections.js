/**
 * ReviewCorrectionsRepository — Session 4 persistence layer.
 *
 * Append-only audit log of human reviewer corrections. Owns ALL SQL for the
 * review_corrections table. One row is written per correction event; rows are
 * never updated or deleted.
 */

'use strict';

const crypto = require('crypto');

class ReviewCorrectionsRepository {
  constructor(db) {
    this.db = db;

    this.insertStmt = db.prepare(`
      INSERT INTO review_corrections (
        id, transaction_id,
        original_category, corrected_category,
        original_invoice_id, corrected_invoice_id,
        original_vendor_id, corrected_vendor_id,
        reason
      ) VALUES (
        @id, @transaction_id,
        @original_category, @corrected_category,
        @original_invoice_id, @corrected_invoice_id,
        @original_vendor_id, @corrected_vendor_id,
        @reason
      )
    `);

    this.findByTxStmt = db.prepare(`
      SELECT * FROM review_corrections WHERE transaction_id = ? ORDER BY created_at ASC
    `);
  }

  /**
   * Appends a correction event to the audit log.
   * @param {Object} input
   * @returns {Object} The inserted correction row
   */
  logCorrection(input) {
    if (!input || !input.transaction_id) {
      throw new Error('ReviewCorrectionsRepository.logCorrection: transaction_id is required');
    }
    const id = input.id || crypto.randomUUID();
    this.insertStmt.run({
      id,
      transaction_id: input.transaction_id,
      original_category: input.original_category || null,
      corrected_category: input.corrected_category || null,
      original_invoice_id: input.original_invoice_id || null,
      corrected_invoice_id: input.corrected_invoice_id || null,
      original_vendor_id: input.original_vendor_id || null,
      corrected_vendor_id: input.corrected_vendor_id || null,
      reason: input.reason || null
    });
    return this.db.prepare(`SELECT * FROM review_corrections WHERE id = ?`).get(id);
  }

  findByTransactionId(transactionId) {
    return this.findByTxStmt.all(transactionId);
  }

  count() {
    return this.db.prepare(`SELECT COUNT(*) as count FROM review_corrections`).get().count;
  }
}

module.exports = ReviewCorrectionsRepository;
