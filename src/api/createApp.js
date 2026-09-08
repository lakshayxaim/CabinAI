/**
 * Session 5 — Minimal HTTP API adapter around the existing CabinAI backend.
 *
 * Thin adapter only: every route delegates to an existing service —
 * IngestionService, ReconciliationPipeline, DecisionService or a repository.
 * No accounting logic lives here, and provider credentials / model confidence
 * scores are never exposed to the browser.
 */

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const { DecisionService } = require('../review');
const BankTransactionsRepository = require('../db/repositories/bankTransactions');
const InvoicesRepository = require('../db/repositories/invoices');

function parseJsonArray(stored) {
  if (!stored) return [];
  try {
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Shapes one transaction + its persisted decision for the UI.
 * Confidence scores are deliberately omitted (debug views can read the DB).
 */
function presentTransaction(tx, decision, invoicesById) {
  const matchedInvoice = decision && decision.matched_invoice_id
    ? invoicesById.get(decision.matched_invoice_id) || null
    : null;
  return {
    id: tx.id,
    date: tx.transaction_date,
    description: tx.description,
    amount: tx.amount,
    currency: tx.currency,
    direction: tx.direction,
    bankReference: tx.bank_reference || null,
    status: decision ? decision.final_decision : 'pending',
    category: decision ? decision.category : null,
    matchedInvoice: matchedInvoice
      ? {
        id: matchedInvoice.id,
        number: matchedInvoice.invoice_number,
        counterparty: matchedInvoice.counterparty_name,
        total: matchedInvoice.total,
        currency: matchedInvoice.currency
      }
      : null,
    matchedVendorId: decision ? decision.matched_vendor_id : null,
    needsReview: decision ? Number(decision.needs_review) === 1 : false,
    reviewStatus: decision ? decision.review_status : 'pending',
    redFlags: decision ? DecisionService.parseRedFlags(decision.red_flags) : [],
    reasoning: decision ? decision.reasoning : null,
    evidence: decision ? parseJsonArray(decision.evidence) : []
  };
}

/**
 * @param {Object} deps
 * @param {Object} deps.db - better-sqlite3 handle
 * @param {import('../services/reconciliationPipeline')} deps.pipeline
 * @param {DecisionService} deps.decisions
 * @param {import('../services/ingestionService')} deps.ingestion
 * @returns {express.Express}
 */
function createApp({ db, pipeline, decisions, ingestion } = {}) {
  if (!db) throw new Error('createApp: db is required');
  if (!pipeline) throw new Error('createApp: pipeline is required');
  if (!decisions) throw new Error('createApp: decisions is required');
  if (!ingestion) throw new Error('createApp: ingestion is required');

  const app = express();
  app.use(express.json());

  const bankTransactions = new BankTransactionsRepository(db);
  const invoices = new InvoicesRepository(db);

  const invoiceIndex = () => {
    const map = new Map();
    for (const inv of invoices.findAll()) map.set(inv.id, inv);
    return map;
  };

  // --- Transactions --------------------------------------------------------

  app.get('/api/transactions', (req, res) => {
    const byId = invoiceIndex();
    const rows = bankTransactions.findAll().map(tx => {
      const decision = decisions.decisions.findByTransactionId(tx.id);
      return presentTransaction(tx, decision, byId);
    });
    res.json({ transactions: rows });
  });

  app.get('/api/transactions/:id', (req, res) => {
    const tx = bankTransactions.findById(req.params.id);
    if (!tx) return res.status(404).json({ error: 'transaction not found' });
    const decision = decisions.decisions.findByTransactionId(tx.id);
    res.json({ transaction: presentTransaction(tx, decision, invoiceIndex()) });
  });

  // --- Review queue (existing DecisionService, joined with transactions) ---

  app.get('/api/reviews', (req, res) => {
    const reviews = decisions.getReviewQueue().map(item => {
      const tx = bankTransactions.findById(item.transaction_id);
      return {
        ...item,
        transaction: tx
          ? {
            id: tx.id,
            date: tx.transaction_date,
            description: tx.description,
            amount: tx.amount,
            currency: tx.currency,
            direction: tx.direction
          }
          : null
      };
    });
    res.json({ reviews });
  });

  app.post('/api/reviews/:id/approve', (req, res) => {
    const { reviewerDecision = null, reason = null } = req.body || {};
    const updated = decisions.approve(req.params.id, { reviewerDecision, reason });
    if (!updated) return res.status(404).json({ error: 'review not found' });
    const tx = bankTransactions.findById(req.params.id);
    res.json({
      transaction: presentTransaction(tx, updated, invoiceIndex())
    });
  });

  // Only the fields supported by DecisionService.correct() are accepted.
  app.post('/api/reviews/:id/correct', (req, res) => {
    const { category, invoiceId, vendorId, finalDecision, reason = null } = req.body || {};
    const result = decisions.correct(req.params.id, {
      category,
      invoiceId,
      vendorId,
      finalDecision,
      reason
    });
    if (!result) return res.status(404).json({ error: 'review not found' });
    const tx = bankTransactions.findById(req.params.id);
    res.json({
      transaction: presentTransaction(tx, result.decision, invoiceIndex()),
      correction: result.correction
    });
  });

  // --- Reconciliation (existing production pipeline) -----------------------

  app.post('/api/reconcile', async (req, res, next) => {
    try {
      const summary = await pipeline.reconcileAll();
      res.json({
        total: summary.total,
        reconciled: summary.reconciled,
        needsReview: summary.needsReview
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Demo seeding (existing ingestion code, idempotent) ------------------

  app.post('/api/demo/seed', async (req, res, next) => {
    try {
      const fixturesDir = path.join(__dirname, '..', '..', 'fixtures');
      const files = [
        'bank_transactions.csv',
        'ap_bill_aws.pdf',
        'ar_invoice_acme.pdf',
        'stripe_export.json',
        'dodo_export.json'
      ];
      const results = [];
      for (const file of files) {
        const fullPath = path.join(fixturesDir, file);
        if (!fs.existsSync(fullPath)) {
          results.push({ file, skipped: true, reason: 'fixture not found' });
          continue;
        }
        const options = file.endsWith('.pdf') ? { companyNames: ['CabinAI'] } : {};
        const r = await ingestion.ingestFile(fullPath, options);
        results.push({
          file,
          parsed: r.totalParsed,
          inserted: r.insertedCount,
          skipped: r.skippedCount
        });
      }
      res.json({ seeded: results });
    } catch (err) {
      next(err);
    }
  });

  // --- Errors ---------------------------------------------------------------

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message || 'internal error' });
  });

  return app;
}

module.exports = createApp;
