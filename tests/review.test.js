'use strict';

/**
 * Session 4 — Persistence + Human Review tests.
 *
 * Covers: decision persistence, review queue creation, red-flag generation,
 * approval, correction, human-authority (no silent overwrite), correction
 * persistence, unknown/unmatched + ambiguous transactions, needsReview agent
 * results, and idempotent persistence.
 *
 * Uses the REAL Session 2 DeterministicMatcher (matching semantics untouched)
 * and real SQLite repositories on :memory: databases.
 * Agent outcomes are plain AgentResult-shaped objects — NO real
 * Gemini/OpenRouter calls are made in these tests.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { initDatabase } = require('../src/db/connection');
const IngestionService = require('../src/services/ingestionService');
const { SourceType } = require('../src/models/types');
const DeterministicMatcher = require('../src/reconciliation/matcher');
const { AgentDecision } = require('../src/agent/types');
const {
  DecisionService,
  RedFlagCode,
  RedFlagMessages,
  deriveRedFlags
} = require('../src/review');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createService() {
  const db = initDatabase(':memory:');
  return { db, service: DecisionService.create(db), matcher: new DeterministicMatcher() };
}

function makeTx(overrides = {}) {
  return {
    id: 'tx-01',
    amount: 125.00,
    currency: 'USD',
    direction: 'outflow',
    transaction_date: '2024-03-02',
    description: 'AMAZON WEB SERVICES',
    ...overrides
  };
}

function makeInvoice(overrides = {}) {
  return {
    id: 'inv-aws-01',
    invoice_number: 'INV-AWS-2024-9841',
    document_type: 'payable',
    counterparty_name: 'Amazon Web Services, Inc.',
    issue_date: '2024-03-01',
    due_date: '2024-03-31',
    currency: 'USD',
    total: 125.00,
    ...overrides
  };
}

function makeAgentResult(overrides = {}) {
  return {
    transactionId: 'tx-01',
    category: 'cloud_infrastructure',
    confidence: 0.95,
    decision: AgentDecision.MATCHED,
    matchedInvoiceId: 'inv-aws-01',
    matchedVendorId: 'cp-aws-01',
    reasoning: 'Exact deterministic match confirmed by tools',
    evidence: ['find_matching_invoice returned match for inv-aws-01'],
    toolCalls: [],
    needsReview: false,
    audit: { provider: 'gemini', model: 'gemini-1.5-flash', fallbackOccurred: false },
    ...overrides
  };
}

function needsReviewAgent(overrides = {}) {
  return makeAgentResult({
    category: null,
    confidence: 0,
    decision: AgentDecision.NEEDS_REVIEW,
    matchedInvoiceId: null,
    matchedVendorId: null,
    reasoning: 'Insufficient evidence to categorize',
    evidence: [],
    needsReview: true,
    ...overrides
  });
}

const REQUIRED_DECISION_COLUMNS = [
  'id', 'transaction_id', 'deterministic_decision', 'agent_decision',
  'final_decision', 'category', 'confidence', 'matched_invoice_id',
  'matched_vendor_id', 'reasoning', 'evidence', 'needs_review',
  'provider', 'model', 'fallback_occurred', 'created_at',
  'reviewed_at', 'review_status', 'reviewer_decision', 'correction_reason'
];

// ---------------------------------------------------------------------------
// 1. Decision persistence
// ---------------------------------------------------------------------------

describe('Session 4 — Decision persistence', () => {
  let service;
  let matcher;

  beforeEach(() => {
    ({ service, matcher } = createService());
  });

  test('persists a reconciliation decision with all required columns', () => {
    const tx = makeTx();
    const det = matcher.matchTransaction(tx, [makeInvoice()]);
    assert.equal(det.decision, 'match');

    const { record, created, humanLocked } = service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: makeAgentResult()
    });

    assert.equal(created, true);
    assert.equal(humanLocked, false);
    for (const col of REQUIRED_DECISION_COLUMNS) {
      assert.ok(col in record, `missing column: ${col}`);
    }
    assert.equal(record.transaction_id, 'tx-01');
    assert.equal(record.deterministic_decision, 'match');
    assert.equal(record.agent_decision, 'matched');
    assert.equal(record.final_decision, 'matched');
    assert.equal(record.category, 'cloud_infrastructure');
    assert.equal(record.confidence, 0.95);
    assert.equal(record.matched_invoice_id, 'inv-aws-01');
    assert.equal(record.matched_vendor_id, 'cp-aws-01');
    assert.deepEqual(JSON.parse(record.evidence), ['find_matching_invoice returned match for inv-aws-01']);
    assert.equal(record.needs_review, 0);
    assert.equal(record.provider, 'gemini');
    assert.equal(record.model, 'gemini-1.5-flash');
    assert.equal(record.fallback_occurred, 0);
    assert.ok(record.created_at);
    assert.equal(record.review_status, 'pending');
  });

  test('records OpenRouter fallback provenance without storing API keys', () => {
    const tx = makeTx();
    const det = matcher.matchTransaction(tx, [makeInvoice()]);
    const agent = makeAgentResult({
      audit: { provider: 'openrouter', model: 'openai/gpt-4o-mini', fallbackOccurred: true }
    });

    const { record } = service.persistDecision({ transaction: tx, deterministicResult: det, agentResult: agent });

    assert.equal(record.provider, 'openrouter');
    assert.equal(record.model, 'openai/gpt-4o-mini');
    assert.equal(record.fallback_occurred, 1);
    // Audit info preserved, secrets never stored.
    const serialized = JSON.stringify(record);
    assert.ok(!/sk-[A-Za-z0-9]|AIza|api[_-]?key/i.test(serialized));
  });

  test('idempotent persistence: re-persisting updates the row instead of duplicating', () => {
    const tx = makeTx();
    const det = matcher.matchTransaction(tx, [makeInvoice()]);

    const first = service.persistDecision({ transaction: tx, deterministicResult: det, agentResult: makeAgentResult() });
    assert.equal(first.created, true);
    assert.equal(service.decisions.count(), 1);

    const second = service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: makeAgentResult({ category: 'software', confidence: 0.88 })
    });
    assert.equal(second.created, false);
    assert.equal(second.humanLocked, false);
    assert.equal(service.decisions.count(), 1);
    assert.equal(second.record.category, 'software');
    assert.equal(second.record.transaction_id, first.record.transaction_id);
    assert.equal(second.record.id, first.record.id);
  });

  test('deterministic rules outrank agent reasoning (match wins over agent unmatched)', () => {
    const tx = makeTx();
    const det = matcher.matchTransaction(tx, [makeInvoice()]);
    assert.equal(det.decision, 'match');

    const { record } = service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: makeAgentResult({
        decision: AgentDecision.UNMATCHED,
        matchedInvoiceId: null,
        category: null,
        confidence: 0,
        needsReview: true
      })
    });

    assert.equal(record.final_decision, 'matched');
    assert.equal(record.matched_invoice_id, 'inv-aws-01');
  });

  test('agent-claimed match without deterministic confirmation stays in review (conflict)', () => {
    const tx = makeTx({ amount: 999.99 });
    const det = matcher.matchTransaction(tx, [makeInvoice()]);
    assert.equal(det.decision, 'unmatched');

    const { record, redFlags } = service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: makeAgentResult({ decision: AgentDecision.MATCHED, needsReview: false })
    });

    assert.equal(record.final_decision, 'needs_review');
    assert.equal(record.needs_review, 1);
    assert.ok(redFlags.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Review queue + red flags
// ---------------------------------------------------------------------------

describe('Session 4 — Review queue creation and red-flag generation', () => {
  let service;
  let matcher;

  beforeEach(() => {
    ({ service, matcher } = createService());
  });

  test('unknown/unmatched transaction enters the queue with "No matching invoice found"', () => {
    const tx = makeTx({ id: 'tx-unknown', amount: 99.99, description: 'MYSTERY CORP' });
    const det = matcher.matchTransaction(tx, []);
    assert.equal(det.decision, 'unmatched');

    const { record } = service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: needsReviewAgent({ transactionId: 'tx-unknown' })
    });
    assert.equal(record.needs_review, 1);

    const queue = service.getReviewQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].transaction_id, 'tx-unknown');
    const codes = queue[0].red_flags.map(f => f.code);
    assert.ok(codes.includes(RedFlagCode.NO_INVOICE_MATCH));
    assert.ok(queue[0].red_flags.some(f => f.message === 'No matching invoice found'));
  });

  test('ambiguous transaction enters the queue with "Multiple invoices could match"', () => {
    const tx = makeTx({ id: 'tx-amb', amount: 500.00, description: 'ACME SOFTWARE' });
    const candidates = [
      makeInvoice({ id: 'inv-a', invoice_number: 'INV-A', counterparty_name: 'Acme Software LLC', total: 500.00 }),
      makeInvoice({ id: 'inv-b', invoice_number: 'INV-B', counterparty_name: 'Acme Software Inc', total: 500.00 })
    ];
    const det = matcher.matchTransaction(tx, candidates);
    assert.equal(det.decision, 'ambiguous');

    service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: needsReviewAgent({ transactionId: 'tx-amb', category: 'software' })
    });

    const queue = service.getReviewQueue();
    assert.equal(queue.length, 1);
    assert.ok(queue[0].red_flags.some(f =>
      f.code === RedFlagCode.MULTIPLE_INVOICES_MATCH &&
      f.message === 'Multiple invoices could match'));
  });

  test('needsReview agent result enters the queue with a human-readable reason', () => {
    const tx = makeTx({ id: 'tx-agent-review' });
    const det = matcher.matchTransaction(tx, [makeInvoice()]);
    assert.equal(det.decision, 'match');

    // Deterministic engine is happy, but the agent explicitly asks for review.
    service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: needsReviewAgent({ transactionId: 'tx-agent-review' })
    });

    const queue = service.getReviewQueue();
    assert.equal(queue.length, 1);
    assert.ok(queue[0].red_flags.length >= 1);
    for (const flag of queue[0].red_flags) {
      assert.equal(typeof flag.code, 'string');
      assert.equal(typeof flag.message, 'string');
      assert.equal(flag.message, RedFlagMessages[flag.code]);
    }
  });

  test('red-flag derivation covers every accounting-conflict category', () => {
    // Direction conflict: outflow cannot pay a receivable invoice.
    let det = matcher.matchTransaction(
      makeTx({ direction: 'outflow', amount: 2700.00, description: 'ACME' }),
      [makeInvoice({ id: 'inv-ar', document_type: 'receivable', counterparty_name: 'Acme Corporation', total: 2700.00 })]
    );
    assert.equal(det.decision, 'rejected');
    assert.ok(deriveRedFlags({ deterministicResult: det }).some(f => f.code === RedFlagCode.DIRECTION_CONFLICT));

    // Currency mismatch.
    det = matcher.matchTransaction(makeTx({ currency: 'EUR' }), [makeInvoice()]);
    assert.ok(deriveRedFlags({ deterministicResult: det }).some(f => f.code === RedFlagCode.CURRENCY_MISMATCH));

    // Amount mismatch (exact-amount hard gate).
    det = matcher.matchTransaction(makeTx({ amount: 130.00 }), [makeInvoice()]);
    assert.ok(deriveRedFlags({ deterministicResult: det }).some(f => f.code === RedFlagCode.AMOUNT_MISMATCH));

    // Date outside window.
    det = matcher.matchTransaction(makeTx({ transaction_date: '2024-06-15' }), [makeInvoice()]);
    assert.ok(deriveRedFlags({ deterministicResult: det }).some(f => f.code === RedFlagCode.DATE_OUTSIDE_WINDOW));

    // Possible duplicate via agent tool evidence.
    const dupAgent = needsReviewAgent({
      toolCalls: [{
        toolName: 'check_duplicate_invoice',
        arguments: { invoiceId: 'inv-aws-01' },
        result: { error: false, duplicateCount: 1, duplicates: [{ invoiceId: 'inv-copy' }] }
      }]
    });
    assert.ok(deriveRedFlags({ agentResult: dupAgent }).some(f =>
      f.code === RedFlagCode.POSSIBLE_DUPLICATE &&
      f.message === 'Possible duplicate invoice'));

    // Vendor could not be identified via zero-match lookup.
    const vendorAgent = needsReviewAgent({
      toolCalls: [{
        toolName: 'lookup_vendor',
        arguments: { query: 'MYSTERY CORP' },
        result: { error: false, matches: [], matchCount: 0 }
      }]
    });
    assert.ok(deriveRedFlags({ agentResult: vendorAgent }).some(f => f.code === RedFlagCode.VENDOR_UNKNOWN));

    // Provider payout that cannot be reconciled.
    const payoutTx = makeTx({ id: 'tx-payout', direction: 'inflow', description: 'STRIPE PAYOUT po_123' });
    det = matcher.matchTransaction(payoutTx, []);
    assert.ok(deriveRedFlags({ transaction: payoutTx, deterministicResult: det })
      .some(f => f.code === RedFlagCode.PROVIDER_PAYOUT_UNRECONCILED));

    // Insufficient evidence: agent gives up with nulls.
    assert.ok(deriveRedFlags({ agentResult: needsReviewAgent() })
      .some(f => f.code === RedFlagCode.INSUFFICIENT_EVIDENCE));
  });

  test('red-flag messages come from the central registry (no scattered UI strings)', () => {
    assert.equal(RedFlagMessages[RedFlagCode.NO_INVOICE_MATCH], 'No matching invoice found');
    assert.equal(RedFlagMessages[RedFlagCode.MULTIPLE_INVOICES_MATCH], 'Multiple invoices could match');
    assert.equal(RedFlagMessages[RedFlagCode.AMOUNT_MISMATCH], 'Amount does not match');
    assert.equal(RedFlagMessages[RedFlagCode.VENDOR_UNKNOWN], 'Vendor could not be identified');
    assert.equal(RedFlagMessages[RedFlagCode.DIRECTION_CONFLICT], 'Transaction direction conflicts with invoice');
    assert.equal(RedFlagMessages[RedFlagCode.CURRENCY_MISMATCH], 'Currency mismatch');
    assert.equal(RedFlagMessages[RedFlagCode.DATE_OUTSIDE_WINDOW], 'Payment date outside normal window');
    assert.equal(RedFlagMessages[RedFlagCode.POSSIBLE_DUPLICATE], 'Possible duplicate invoice');
    assert.equal(RedFlagMessages[RedFlagCode.PROVIDER_PAYOUT_UNRECONCILED], 'Provider payout could not be reconciled');
    assert.equal(RedFlagMessages[RedFlagCode.INSUFFICIENT_EVIDENCE], 'Insufficient evidence to categorize');
  });

  test('review queue never exposes model confidence scores', () => {
    const tx = makeTx({ id: 'tx-hidden-conf', amount: 77.77 });
    const det = matcher.matchTransaction(tx, []);
    service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: needsReviewAgent({ transactionId: 'tx-hidden-conf', confidence: 0.42 })
    });

    const queue = service.getReviewQueue();
    assert.equal(queue.length, 1);
    assert.ok(!('confidence' in queue[0]));
    assert.ok(!JSON.stringify(queue).toLowerCase().includes('confidence'));
    // Confidence is still preserved in storage for audit purposes.
    assert.equal(service.decisions.findByTransactionId('tx-hidden-conf').confidence, 0.42);
  });

  test('matched transactions with no flags stay out of the review queue', () => {
    const tx = makeTx();
    const det = matcher.matchTransaction(tx, [makeInvoice()]);
    service.persistDecision({ transaction: tx, deterministicResult: det, agentResult: makeAgentResult() });
    assert.equal(service.getReviewQueue().length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Approval flow
// ---------------------------------------------------------------------------

describe('Session 4 — Approval flow', () => {
  let service;
  let matcher;

  beforeEach(() => {
    ({ service, matcher } = createService());
  });

  test('approving a proposed decision makes it authoritative', () => {
    const tx = makeTx({ id: 'tx-approve', amount: 99.99 });
    const det = matcher.matchTransaction(tx, []);
    service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: needsReviewAgent({ transactionId: 'tx-approve' })
    });
    assert.equal(service.getReviewQueue().length, 1);

    const approved = service.approve('tx-approve');
    assert.equal(approved.review_status, 'approved');
    assert.equal(approved.final_decision, 'needs_review');
    assert.equal(approved.reviewer_decision, 'needs_review');
    assert.equal(approved.needs_review, 0);
    assert.ok(approved.reviewed_at);

    // Leaves the queue once approved.
    assert.equal(service.getReviewQueue().length, 0);
  });

  test('approving an unknown transaction returns null', () => {
    assert.equal(service.approve('tx-does-not-exist'), null);
  });
});

// ---------------------------------------------------------------------------
// 4. Correction flow + human authority
// ---------------------------------------------------------------------------

describe('Session 4 — Correction flow and human authority', () => {
  let service;
  let matcher;

  beforeEach(() => {
    ({ service, matcher } = createService());
  });

  test('reviewer can correct category, invoice match, vendor match, and final decision', () => {
    const tx = makeTx({ id: 'tx-correct', amount: 99.99 });
    const det = matcher.matchTransaction(tx, []);
    service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: needsReviewAgent({ transactionId: 'tx-correct' })
    });

    const { decision, correction } = service.correct('tx-correct', {
      category: 'software',
      invoiceId: 'inv-manual-01',
      vendorId: 'cp-manual-01',
      finalDecision: 'matched',
      reason: 'Reviewer verified against paper invoice'
    });

    assert.equal(decision.review_status, 'corrected');
    assert.equal(decision.category, 'software');
    assert.equal(decision.matched_invoice_id, 'inv-manual-01');
    assert.equal(decision.matched_vendor_id, 'cp-manual-01');
    assert.equal(decision.final_decision, 'matched');
    assert.equal(decision.needs_review, 0);
    assert.ok(decision.reviewed_at);
    assert.equal(decision.correction_reason, 'Reviewer verified against paper invoice');

    assert.equal(correction.transaction_id, 'tx-correct');
    assert.equal(correction.corrected_category, 'software');
    assert.equal(correction.corrected_invoice_id, 'inv-manual-01');
    assert.equal(correction.corrected_vendor_id, 'cp-manual-01');
    assert.equal(correction.reason, 'Reviewer verified against paper invoice');
  });

  test('corrections persist in the review_corrections audit table', () => {
    const tx = makeTx({ id: 'tx-audit', amount: 42.00, description: 'GITHUB' });
    const det = matcher.matchTransaction(tx, []);
    service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: needsReviewAgent({ transactionId: 'tx-audit', category: 'office' })
    });

    service.correct('tx-audit', {
      category: 'software',
      invoiceId: 'inv-github-01',
      vendorId: 'cp-github-01',
      finalDecision: 'matched',
      reason: 'GitHub receipt attached'
    });

    const history = service.corrections.findByTransactionId('tx-audit');
    assert.equal(history.length, 1);
    assert.equal(history[0].original_category, 'office');
    assert.equal(history[0].corrected_category, 'software');
    assert.equal(history[0].original_invoice_id, null);
    assert.equal(history[0].corrected_invoice_id, 'inv-github-01');
    assert.equal(history[0].original_vendor_id, null);
    assert.equal(history[0].corrected_vendor_id, 'cp-github-01');
    assert.equal(history[0].reason, 'GitHub receipt attached');
    assert.ok(history[0].created_at);
  });

  test('human approval cannot be silently overwritten by another agent run', () => {
    const tx = makeTx({ id: 'tx-locked' });
    const det = matcher.matchTransaction(tx, [makeInvoice()]);
    service.persistDecision({ transaction: tx, deterministicResult: det, agentResult: makeAgentResult({ transactionId: 'tx-locked' }) });
    service.approve('tx-locked', { reviewerDecision: 'matched' });

    // A later agent run proposes something completely different.
    const rerun = service.persistDecision({
      transaction: tx,
      deterministicResult: matcher.matchTransaction(tx, []),
      agentResult: makeAgentResult({
        transactionId: 'tx-locked',
        category: 'travel',
        confidence: 0.99,
        decision: AgentDecision.CATEGORIZED,
        matchedInvoiceId: null,
        matchedVendorId: null
      })
    });

    assert.equal(rerun.humanLocked, true);
    assert.equal(rerun.record.review_status, 'approved');
    assert.equal(rerun.record.final_decision, 'matched');
    assert.equal(rerun.record.category, 'cloud_infrastructure');
    assert.equal(rerun.record.matched_invoice_id, 'inv-aws-01');
    assert.equal(rerun.record.matched_vendor_id, 'cp-aws-01');
    assert.equal(rerun.record.needs_review, 0);
  });

  test('human correction cannot be overwritten by another agent run', () => {
    const tx = makeTx({ id: 'tx-corr-locked', amount: 10.00 });
    const det = matcher.matchTransaction(tx, []);
    service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: needsReviewAgent({ transactionId: 'tx-corr-locked' })
    });
    service.correct('tx-corr-locked', {
      category: 'office',
      invoiceId: 'inv-office-01',
      vendorId: 'cp-office-01',
      finalDecision: 'matched',
      reason: 'Verified by finance'
    });

    const rerun = service.persistDecision({
      transaction: tx,
      deterministicResult: det,
      agentResult: makeAgentResult({
        transactionId: 'tx-corr-locked',
        category: 'travel',
        decision: AgentDecision.CATEGORIZED,
        matchedInvoiceId: null,
        matchedVendorId: null
      })
    });

    assert.equal(rerun.humanLocked, true);
    assert.equal(rerun.record.review_status, 'corrected');
    assert.equal(rerun.record.final_decision, 'matched');
    assert.equal(rerun.record.category, 'office');
    assert.equal(rerun.record.matched_invoice_id, 'inv-office-01');
  });

  test('correcting an unknown transaction returns null', () => {
    assert.equal(service.correct('tx-missing', { category: 'software' }), null);
  });
});

// ---------------------------------------------------------------------------
// 5. End-to-end with Session 1 fixtures (no LLM calls)
// ---------------------------------------------------------------------------

describe('Session 4 — Fixture-backed flow (Sessions 1+2+4)', () => {
  test('real ingested bank transaction flows through matcher into persistence + queue', async () => {
    const db = initDatabase(':memory:');
    const ingestion = new IngestionService(db);
    const bankCsv = fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'bank_transactions.csv'), 'utf8');
    const result = await ingestion.ingestContent(bankCsv, SourceType.BANK_CSV, { filename: 'bank_transactions.csv' });
    assert.ok(result.insertedCount > 0);

    const bankTx = ingestion.bankTransactions.findAll()[0];
    assert.ok(bankTx && bankTx.id);

    const service = DecisionService.create(db);
    const matcher = new DeterministicMatcher();
    // No invoices ingested here: an unmatched bank movement must queue for review.
    const det = matcher.matchTransaction(bankTx, []);
    assert.equal(det.decision, 'unmatched');

    const agent = needsReviewAgent({ transactionId: bankTx.id });
    const { record } = service.persistDecision({
      transaction: bankTx,
      deterministicResult: det,
      agentResult: agent
    });

    assert.equal(record.transaction_id, bankTx.id);
    assert.equal(record.needs_review, 1);
    const queue = service.getReviewQueue();
    assert.ok(queue.some(item => item.transaction_id === bankTx.id));
    assert.ok(queue[0].red_flags.length > 0);
  });
});
