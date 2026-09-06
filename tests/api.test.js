/**
 * Session 5 — API adapter tests.
 *
 * Exercises the Express API against a real pipeline (REAL Matcher, REAL
 * BookkeepingAgent with faked LLM provider only, REAL DecisionService, REAL
 * :memory: SQLite) over HTTP. No Gemini/OpenRouter network calls.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
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
const createApp = require('../src/api/createApp');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

class FakeProvider extends LLMProvider {
  constructor({ answers = [] } = {}) {
    super({ model: 'fake-model' });
    this.providerName = 'fake';
    this.answers = [...answers];
  }

  async generate() {
    if (this.answers.length === 0) {
      throw new Error('FakeProvider: no more queued answers');
    }
    return new LLMResponse({ text: JSON.stringify(this.answers.shift()), toolCalls: [], raw: {} });
  }
}

function matchedAnswer() {
  return {
    category: 'revenue',
    confidence: 0.9,
    decision: 'matched',
    matchedInvoiceId: null,
    matchedVendorId: null,
    reasoning: 'fake provider confirmed the deterministic evidence',
    evidence: ['amount matches', 'date within window'],
    needsReview: false
  };
}

async function seed(db) {
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
  return ingestion;
}

describe('Session 5 — API adapter', () => {
  let db;
  let server;
  let baseUrl;

  beforeEach(async () => {
    db = initDatabase(':memory:');
    const ingestion = await seed(db);
    const provider = new FakeProvider({
      answers: Array.from({ length: 10 }, matchedAnswer)
    });
    const agent = new BookkeepingAgent({
      primaryProvider: provider,
      repos: {
        invoices: new InvoicesRepository(db),
        counterparties: new CounterpartiesRepository(db)
      }
    });
    const pipeline = ReconciliationPipeline.create(db, { agent });
    const app = createApp({ db, pipeline, decisions: pipeline.decisions, ingestion });
    server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });

  async function reconcileAll() {
    const res = await fetch(`${baseUrl}/api/reconcile`, { method: 'POST' });
    assert.equal(res.status, 200);
    return res.json();
  }

  test('GET /api/transactions returns persisted reconciliation decisions', async () => {
    await reconcileAll();
    const res = await fetch(`${baseUrl}/api/transactions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.transactions));
    assert.equal(body.transactions.length, 5);

    const aws = body.transactions.find(t => t.description === 'AMAZON WEB SERVICES');
    assert.ok(aws);
    assert.equal(aws.status, 'matched');
    assert.equal(aws.needsReview, false);
    assert.ok(aws.matchedInvoice && aws.matchedInvoice.number === 'INV-AWS-2024-9841');

    // Confidence scores must never leak to the browser.
    assert.ok(!('confidence' in aws));
    assert.ok(!JSON.stringify(body).includes('confidence'));
  });

  test('GET /api/reviews returns the real review queue with red flags', async () => {
    await reconcileAll();
    const res = await fetch(`${baseUrl}/api/reviews`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.reviews));
    assert.ok(body.reviews.length >= 1);
    const rent = body.reviews.find(r => r.transaction && r.transaction.description === 'OFFICE RENT MARCH');
    assert.ok(rent);
    assert.ok(rent.red_flags.length > 0);
    assert.ok(rent.reasoning);
    assert.ok(!JSON.stringify(body).includes('confidence'));
  });

  test('GET /api/transactions/:id returns one transaction with review info', async () => {
    await reconcileAll();
    const list = await (await fetch(`${baseUrl}/api/transactions`)).json();
    const rent = list.transactions.find(t => t.description === 'OFFICE RENT MARCH');
    const res = await fetch(`${baseUrl}/api/transactions/${rent.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.transaction.id, rent.id);
    assert.equal(body.transaction.needsReview, true);
    assert.ok(body.transaction.redFlags.length > 0);

    const missing = await fetch(`${baseUrl}/api/transactions/does-not-exist`);
    assert.equal(missing.status, 404);
  });

  test('POST /api/reconcile runs the real pipeline and summarizes', async () => {
    const before = await (await fetch(`${baseUrl}/api/transactions`)).json();
    assert.ok(before.transactions.every(t => t.status === 'pending'));

    const summary = await reconcileAll();
    assert.equal(summary.total, 5);
    assert.equal(summary.reconciled + summary.needsReview, 5);
    assert.ok(summary.reconciled >= 2);

    const after = await (await fetch(`${baseUrl}/api/transactions`)).json();
    assert.ok(after.transactions.some(t => t.status === 'matched'));
  });

  test('POST /api/reviews/:id/approve makes the decision authoritative', async () => {
    await reconcileAll();
    const list = await (await fetch(`${baseUrl}/api/transactions`)).json();
    const rent = list.transactions.find(t => t.description === 'OFFICE RENT MARCH');

    const res = await fetch(`${baseUrl}/api/reviews/${rent.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'verified in demo' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.transaction.reviewStatus, 'approved');
    assert.equal(body.transaction.needsReview, false);
  });

  test('POST /api/reviews/:id/correct persists the correction with supported fields only', async () => {
    await reconcileAll();
    const list = await (await fetch(`${baseUrl}/api/transactions`)).json();
    const rent = list.transactions.find(t => t.description === 'OFFICE RENT MARCH');

    const res = await fetch(`${baseUrl}/api/reviews/${rent.id}/correct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'office', finalDecision: 'categorized', reason: 'march rent' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.transaction.reviewStatus, 'corrected');
    assert.equal(body.transaction.category, 'office');
    assert.ok(body.correction);

    const missing = await fetch(`${baseUrl}/api/reviews/does-not-exist/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(missing.status, 404);
  });

  test('human-approved decisions survive another reconciliation run', async () => {
    await reconcileAll();
    const list = await (await fetch(`${baseUrl}/api/transactions`)).json();
    const rent = list.transactions.find(t => t.description === 'OFFICE RENT MARCH');

    await fetch(`${baseUrl}/api/reviews/${rent.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    await reconcileAll();

    const detail = await (await fetch(`${baseUrl}/api/transactions/${rent.id}`)).json();
    assert.equal(detail.transaction.reviewStatus, 'approved');
    assert.equal(detail.transaction.needsReview, false);
  });
});
