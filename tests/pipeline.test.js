/**
 * Session 5 — ReconciliationPipeline tests.
 *
 * Uses the REAL production chain with a faked LLM provider only:
 *   REAL Session 1 ingestion (fixtures) → REAL DeterministicMatcher (Session 2)
 *   → REAL BookkeepingAgent (Session 3) → REAL DecisionService (Session 4)
 *   → REAL SQLite (:memory:).
 *
 * Verifies:
 *  - deterministic match persists and stays out of the review queue
 *  - unmatched → review queue
 *  - ambiguous → review queue
 *  - agent needsReview → review queue
 *  - approve → re-reconciliation preserves the human decision (no new LLM call)
 *  - correct → re-reconciliation preserves the correction (audit row kept)
 *  - deterministic-only mode (no agent) still reconciles + queues correctly
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { initDatabase } = require('../src/db/connection');
const IngestionService = require('../src/services/ingestionService');
const { SourceType } = require('../src/models/types');
const { LLMProvider, LLMResponse } = require('../src/agent/llm/llmClient');
const { BookkeepingAgent } = require('../src/agent');
const InvoicesRepository = require('../src/db/repositories/invoices');
const CounterpartiesRepository = require('../src/db/repositories/counterparties');
const ReconciliationPipeline = require('../src/services/reconciliationPipeline');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

// --- Minimal fake LLM provider: returns queued final JSON answers, no tools ---

class FakeProvider extends LLMProvider {
  constructor({ name = 'fake', model = 'fake-model', answers = [] } = {}) {
    super({ model });
    this.providerName = name;
    this.answers = [...answers];
    this.callCount = 0;
  }

  enqueue(answer) {
    this.answers.push(answer);
  }

  async generate() {
    this.callCount++;
    if (this.answers.length === 0) {
      throw new Error(`FakeProvider: no more queued answers (call #${this.callCount})`);
    }
    const next = this.answers.shift();
    if (next instanceof Error) throw next;
    return new LLMResponse({ text: JSON.stringify(next), toolCalls: [], raw: {} });
  }
}

function matchedAnswer(overrides = {}) {
  return {
    category: 'cloud_infrastructure',
    confidence: 0.9,
    decision: 'matched',
    matchedInvoiceId: null,
    matchedVendorId: null,
    reasoning: 'Fake provider evidence-backed match.',
    evidence: ['amount matches', 'date within window'],
    needsReview: false,
    ...overrides
  };
}

function needsReviewAnswer() {
  return {
    category: null,
    confidence: 0,
    decision: 'needs_review',
    matchedInvoiceId: null,
    matchedVendorId: null,
    reasoning: 'Fake provider found insufficient evidence.',
    evidence: [],
    needsReview: true
  };
}

function unmatchedAnswer() {
  return {
    category: null,
    confidence: 0,
    decision: 'unmatched',
    matchedInvoiceId: null,
    matchedVendorId: null,
    reasoning: 'Fake provider found no candidate.',
    evidence: ['no matching invoice found by tools'],
    needsReview: false
  };
}

// --- Helpers ---

async function seedFixtures(db) {
  const ingestion = new IngestionService(db);
  await ingestion.ingestContent(
    fs.readFileSync(path.join(FIXTURES_DIR, 'bank_transactions.csv'), 'utf8'),
    SourceType.BANK_CSV,
    { filename: 'bank_transactions.csv' }
  );
  await ingestion.ingestContent(
    fs.readFileSync(path.join(FIXTURES_DIR, 'ap_bill_aws.pdf')),
    SourceType.INVOICE_PDF,
    { filename: 'ap_bill_aws.pdf', companyNames: ['CabinAI'] }
  );
  await ingestion.ingestContent(
    fs.readFileSync(path.join(FIXTURES_DIR, 'ar_invoice_acme.pdf')),
    SourceType.INVOICE_PDF,
    { filename: 'ar_invoice_acme.pdf', companyNames: ['CabinAI'] }
  );
  await ingestion.ingestContent(
    fs.readFileSync(path.join(FIXTURES_DIR, 'stripe_export.json'), 'utf8'),
    SourceType.STRIPE_JSON,
    { filename: 'stripe_export.json' }
  );
  await ingestion.ingestContent(
    fs.readFileSync(path.join(FIXTURES_DIR, 'dodo_export.json'), 'utf8'),
    SourceType.DODO_JSON,
    { filename: 'dodo_export.json' }
  );
  return ingestion;
}

function buildAgent(db, provider) {
  return new BookkeepingAgent({
    primaryProvider: provider,
    repos: {
      invoices: new InvoicesRepository(db),
      counterparties: new CounterpartiesRepository(db)
    }
  });
}

function findTx(db, description) {
  return db
    .prepare('SELECT * FROM bank_transactions WHERE description = ?')
    .get(description);
}

describe('Session 5 — ReconciliationPipeline (real Matcher/Agent/DecisionService)', () => {
  let db;

  beforeEach(() => {
    db = initDatabase(':memory:');
  });

  test('deterministic match persists as matched and stays out of the review queue', async () => {
    await seedFixtures(db);
    // The fake agent claims "unmatched": deterministic MATCH must still win.
    const provider = new FakeProvider({ answers: [unmatchedAnswer()] });
    const pipeline = ReconciliationPipeline.create(db, { agent: buildAgent(db, provider) });

    const awsTx = findTx(db, 'AMAZON WEB SERVICES');
    assert.ok(awsTx);
    const { record, redFlags } = await pipeline.reconcileTransaction(awsTx);

    assert.equal(record.transaction_id, awsTx.id);
    assert.equal(record.final_decision, 'matched');
    assert.equal(Number(record.needs_review), 0);
    assert.deepEqual(redFlags, []);
    const queue = pipeline.decisions.getReviewQueue();
    assert.ok(!queue.some(item => item.transaction_id === awsTx.id));
  });

  test('unmatched transaction enters the review queue with a human-readable flag', async () => {
    await seedFixtures(db);
    const provider = new FakeProvider({ answers: [needsReviewAnswer()] });
    const pipeline = ReconciliationPipeline.create(db, { agent: buildAgent(db, provider) });

    const rentTx = findTx(db, 'OFFICE RENT MARCH');
    assert.ok(rentTx);
    const { record, redFlags } = await pipeline.reconcileTransaction(rentTx);

    assert.equal(Number(record.needs_review), 1);
    assert.ok(redFlags.length > 0);
    assert.ok(redFlags.every(f => typeof f.code === 'string' && typeof f.message === 'string'));
    const queue = pipeline.decisions.getReviewQueue();
    assert.ok(queue.some(item => item.transaction_id === rentTx.id));
  });

  test('ambiguous match enters the review queue as multiple-invoices-could-match', async () => {
    await seedFixtures(db);
    const invoices = new InvoicesRepository(db);
    // Two identical payable invoices: same amount, dates, counterparty → tie.
    for (const n of ['AMB-001', 'AMB-002']) {
      invoices.insert({
        invoice_number: n,
        document_type: 'payable',
        counterparty_name: 'Test Vendor',
        issue_date: '2024-03-01',
        due_date: '2024-03-31',
        currency: 'USD',
        subtotal: 500,
        tax: 0,
        total: 500,
        source: 'test',
        source_file: 'test.json',
        source_record_id: n
      });
    }
    db.prepare(
      `INSERT INTO bank_transactions (id, transaction_date, amount, currency, direction, description, source, source_record_id)
       VALUES ('tx-amb-01', '2024-03-05', 500, 'USD', 'outflow', 'TEST VENDOR', 'test', 'tx-amb-01')`
    ).run();
    const tx = findTx(db, 'TEST VENDOR');

    const provider = new FakeProvider({ answers: [needsReviewAnswer(), needsReviewAnswer()] });
    const pipeline = ReconciliationPipeline.create(db, { agent: buildAgent(db, provider) });
    const { record, redFlags } = await pipeline.reconcileTransaction(tx);

    assert.equal(record.deterministic_decision, 'ambiguous');
    assert.equal(Number(record.needs_review), 1);
    assert.ok(redFlags.some(f => f.code === 'MULTIPLE_INVOICES_MATCH'));
  });

  test('agent needsReview forces the transaction into the review queue', async () => {
    await seedFixtures(db);
    const provider = new FakeProvider({ answers: [needsReviewAnswer()] });
    const pipeline = ReconciliationPipeline.create(db, { agent: buildAgent(db, provider) });

    const tx = findTx(db, 'GITHUB SUBSCRIPTION');
    const { record } = await pipeline.reconcileTransaction(tx);
    assert.equal(Number(record.needs_review), 1);
    const queue = pipeline.decisions.getReviewQueue();
    assert.ok(queue.some(item => item.transaction_id === tx.id));
  });

  test('approve → re-reconciliation preserves the human decision without new LLM calls', async () => {
    await seedFixtures(db);
    const provider = new FakeProvider({ answers: [needsReviewAnswer()] });
    const pipeline = ReconciliationPipeline.create(db, { agent: buildAgent(db, provider) });

    const tx = findTx(db, 'OFFICE RENT MARCH');
    await pipeline.reconcileTransaction(tx);
    const callsAfterFirstRun = provider.callCount;
    assert.ok(callsAfterFirstRun > 0);

    const approved = pipeline.decisions.approve(tx.id, { reason: 'looks right' });
    assert.equal(approved.review_status, 'approved');

    const rerun = await pipeline.reconcileTransaction(tx);
    assert.equal(rerun.humanLocked, true);
    assert.equal(rerun.record.review_status, 'approved');
    assert.equal(rerun.record.final_decision, approved.final_decision);
    assert.equal(provider.callCount, callsAfterFirstRun);
  });

  test('correct → re-reconciliation preserves the correction and keeps the audit row', async () => {
    await seedFixtures(db);
    const provider = new FakeProvider({ answers: [needsReviewAnswer()] });
    const pipeline = ReconciliationPipeline.create(db, { agent: buildAgent(db, provider) });

    const tx = findTx(db, 'OFFICE RENT MARCH');
    await pipeline.reconcileTransaction(tx);

    const { decision } = pipeline.decisions.correct(tx.id, {
      category: 'office',
      finalDecision: 'categorized',
      reason: 'rent for march'
    });
    assert.equal(decision.review_status, 'corrected');
    assert.equal(decision.category, 'office');

    const rerun = await pipeline.reconcileTransaction(tx);
    assert.equal(rerun.humanLocked, true);
    assert.equal(rerun.record.category, 'office');
    assert.equal(rerun.record.final_decision, 'categorized');

    const auditRows = db
      .prepare('SELECT * FROM review_corrections WHERE transaction_id = ?')
      .all(tx.id);
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].corrected_category, 'office');
  });

  test('reconcileAll reconciles every transaction and summarizes the run', async () => {
    await seedFixtures(db);
    // One queued agent answer per bank transaction (5 fixture rows).
    const provider = new FakeProvider({
      answers: [matchedAnswer(), matchedAnswer(), matchedAnswer(), matchedAnswer(), matchedAnswer()]
    });
    const pipeline = ReconciliationPipeline.create(db, { agent: buildAgent(db, provider) });

    const summary = await pipeline.reconcileAll();
    const txCount = db.prepare('SELECT COUNT(*) AS n FROM bank_transactions').get().n;
    assert.equal(summary.total, txCount);
    assert.equal(summary.reconciled + summary.needsReview, summary.total);
    // Fixture-backed deterministic matches (AWS bill, Acme invoice) reconcile.
    assert.ok(summary.reconciled >= 2);
    assert.ok(summary.needsReview >= 1);
  });

  test('deterministic-only mode (no agent) still reconciles and queues correctly', async () => {
    await seedFixtures(db);
    const pipeline = ReconciliationPipeline.create(db, { agent: null });

    const awsTx = findTx(db, 'AMAZON WEB SERVICES');
    const matched = await pipeline.reconcileTransaction(awsTx);
    assert.equal(matched.record.final_decision, 'matched');
    assert.equal(Number(matched.record.needs_review), 0);

    const rentTx = findTx(db, 'OFFICE RENT MARCH');
    const queued = await pipeline.reconcileTransaction(rentTx);
    assert.equal(Number(queued.record.needs_review), 1);
    assert.ok(queued.redFlags.length > 0);
  });
});
