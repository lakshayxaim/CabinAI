'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  DeterministicMatcher,
  MatchDecision,
  MatchType,
  RejectionReason,
  DEFAULT_CONFIG,
  normalizeCounterparty,
  calculateCounterpartySimilarity
} = require('../src/reconciliation');
const { Direction, DocumentType, ProviderType, SourceType } = require('../src/models/types');
const { initDatabase } = require('../src/db/connection');
const IngestionService = require('../src/services/ingestionService');

const FIXTURES_DIR = path.join(__dirname, '../fixtures');

describe('CabinAI - Deterministic Reconciliation Matcher (Session 2)', () => {
  let matcher;

  beforeEach(() => {
    matcher = new DeterministicMatcher();
  });

  test('1. Exact amount + matching date + matching vendor -> high-confidence match', () => {
    const bankTx = {
      id: 'tx-aws-01',
      amount: 125.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-02',
      description: 'AMAZON WEB SERVICES'
    };

    const invoice = {
      id: 'inv-aws-01',
      invoice_number: 'INV-AWS-2024-9841',
      document_type: DocumentType.PAYABLE,
      counterparty_name: 'Amazon Web Services, Inc.',
      issue_date: '2024-03-01',
      due_date: '2024-03-31',
      currency: 'USD',
      total: 125.00
    };

    const result = matcher.match(bankTx, [invoice]);

    assert.equal(result.decision, MatchDecision.MATCH);
    assert.equal(result.matchType, MatchType.BANK_TO_INVOICE);
    assert.ok(result.score >= 0.90, `Score should be high-confidence (>= 0.90), got ${result.score}`);
    assert.equal(result.candidateId, invoice.id);
    assert.equal(result.amountComparison.isExact, true);
    assert.equal(result.dateDifference.isWithinWindow, true);
    assert.equal(result.counterpartySimilarity.isEvaluated, true);
    assert.ok(result.counterpartySimilarity.similarityScore >= 0.90);
    assert.ok(result.reasons.summary.includes('Deterministic match cleared confidence threshold'));
  });

  test('2. Exact amount + date outside window -> no match', () => {
    const bankTx = {
      id: 'tx-aws-late',
      amount: 125.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-06-15', // 76 days after due date (2024-03-31), well beyond 30-day window
      description: 'AMAZON WEB SERVICES'
    };

    const invoice = {
      id: 'inv-aws-01',
      document_type: DocumentType.PAYABLE,
      counterparty_name: 'Amazon Web Services Inc.',
      issue_date: '2024-03-01',
      due_date: '2024-03-31',
      currency: 'USD',
      total: 125.00
    };

    const result = matcher.match(bankTx, [invoice]);

    assert.notEqual(result.decision, MatchDecision.MATCH);
    assert.equal(result.decision, MatchDecision.UNMATCHED);
    assert.equal(result.score, 0.0);
    assert.equal(result.allCandidates[0].dateDifference.isWithinWindow, false);
    assert.equal(result.allCandidates[0].rejectionReason, RejectionReason.DATE_OUTSIDE_WINDOW);
  });

  test('3. Different amount -> no match', () => {
    const bankTx = {
      id: 'tx-diff-amt',
      amount: 150.00, // Different from invoice $125.00
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-02',
      description: 'AMAZON WEB SERVICES'
    };

    const invoice = {
      id: 'inv-aws-01',
      document_type: DocumentType.PAYABLE,
      counterparty_name: 'Amazon Web Services',
      issue_date: '2024-03-01',
      due_date: '2024-03-31',
      currency: 'USD',
      total: 125.00
    };

    const result = matcher.match(bankTx, [invoice]);

    assert.equal(result.decision, MatchDecision.UNMATCHED);
    assert.equal(result.score, 0.0);
    assert.equal(result.allCandidates[0].amountComparison.isExact, false);
    assert.equal(result.allCandidates[0].rejectionReason, RejectionReason.AMOUNT_MISMATCH);
  });

  test('4. Payable invoice + bank inflow -> rejected', () => {
    const bankInflow = {
      id: 'tx-inflow-payable',
      amount: 125.00,
      currency: 'USD',
      direction: Direction.INFLOW, // Incompatible with payable (AP)
      transaction_date: '2024-03-02',
      description: 'AMAZON WEB SERVICES'
    };

    const payableInvoice = {
      id: 'inv-ap-01',
      document_type: DocumentType.PAYABLE,
      counterparty_name: 'Amazon Web Services',
      issue_date: '2024-03-01',
      due_date: '2024-03-31',
      currency: 'USD',
      total: 125.00
    };

    const result = matcher.match(bankInflow, [payableInvoice]);

    assert.equal(result.decision, MatchDecision.REJECTED);
    assert.equal(result.score, 0.0);
    assert.equal(result.allCandidates[0].rejectionReason, RejectionReason.INCOMPATIBLE_DIRECTION);
    assert.ok(result.allCandidates[0].reasons.compatibility.includes('payable invoice corresponds to bank outflow'));
  });

  test('5. Receivable invoice + bank outflow -> rejected', () => {
    const bankOutflow = {
      id: 'tx-outflow-receivable',
      amount: 2700.00,
      currency: 'USD',
      direction: Direction.OUTFLOW, // Incompatible with receivable (AR)
      transaction_date: '2024-03-05',
      description: 'ACME CORP WIRE PAYMENT'
    };

    const receivableInvoice = {
      id: 'inv-ar-01',
      document_type: DocumentType.RECEIVABLE,
      counterparty_name: 'Acme Corporation',
      issue_date: '2024-03-05',
      due_date: '2024-04-05',
      currency: 'USD',
      total: 2700.00
    };

    const result = matcher.match(bankOutflow, [receivableInvoice]);

    assert.equal(result.decision, MatchDecision.REJECTED);
    assert.equal(result.score, 0.0);
    assert.equal(result.allCandidates[0].rejectionReason, RejectionReason.INCOMPATIBLE_DIRECTION);
    assert.ok(result.allCandidates[0].reasons.compatibility.includes('receivable invoice corresponds to bank inflow'));
  });

  test('6. Vendor spelling/case/punctuation variation -> still matches', () => {
    const variations = [
      { desc: 'AMAZON WEB SERVICES INC.', vendor: 'Amazon Web Services' },
      { desc: 'Amazon Web Services, Inc.', vendor: 'AMAZON WEB SERVICES' },
      { desc: 'amazon web services llc', vendor: 'Amazon Web Services' },
      { desc: 'Amazn Web Services', vendor: 'Amazon Web Services, Inc.' }, // minor typo
      { desc: 'GITHUB SUBSCRIPTION', vendor: 'GitHub, Inc.' }
    ];

    for (const v of variations) {
      const bankTx = {
        id: 'tx-var',
        amount: 100.00,
        currency: 'USD',
        direction: Direction.OUTFLOW,
        transaction_date: '2024-03-02',
        description: v.desc
      };

      const invoice = {
        id: 'inv-var',
        document_type: DocumentType.PAYABLE,
        counterparty_name: v.vendor,
        issue_date: '2024-03-01',
        currency: 'USD',
        total: 100.00
      };

      const result = matcher.match(bankTx, [invoice]);
      assert.equal(result.decision, MatchDecision.MATCH, `Should match variation: "${v.desc}" vs "${v.vendor}"`);
      assert.ok(result.score >= 0.80, `Score should clear threshold for "${v.desc}", got ${result.score}`);
    }
  });

  test('7. Different vendors with same amount -> does not automatically match', () => {
    const bankTx = {
      id: 'tx-office',
      amount: 500.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-02',
      description: 'OFFICE DEPOT'
    };

    const invoice = {
      id: 'inv-aws-diff',
      document_type: DocumentType.PAYABLE,
      counterparty_name: 'Amazon Web Services Inc.',
      issue_date: '2024-03-01',
      due_date: '2024-03-31',
      currency: 'USD',
      total: 500.00 // Same amount, completely different vendor
    };

    const result = matcher.match(bankTx, [invoice]);

    // Must NOT match: Counterparty mismatch pulls score below confidenceThreshold
    assert.notEqual(result.decision, MatchDecision.MATCH);
    assert.equal(result.decision, MatchDecision.UNMATCHED);
    assert.ok(result.score < DEFAULT_CONFIG.confidenceThreshold);
    assert.equal(result.candidateId, invoice.id);
  });

  test('8. Multiple plausible invoices -> ambiguous, not arbitrary', () => {
    const bankTx = {
      id: 'tx-ambig',
      amount: 125.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-05',
      description: 'AMAZON WEB SERVICES'
    };

    // Two equally plausible invoices with exact amount and same vendor within same window
    const invoiceA = {
      id: 'inv-aws-march-01',
      invoice_number: 'INV-AWS-01',
      document_type: DocumentType.PAYABLE,
      counterparty_name: 'Amazon Web Services',
      issue_date: '2024-03-01',
      due_date: '2024-03-31',
      currency: 'USD',
      total: 125.00
    };

    const invoiceB = {
      id: 'inv-aws-march-02',
      invoice_number: 'INV-AWS-02',
      document_type: DocumentType.PAYABLE,
      counterparty_name: 'Amazon Web Services',
      issue_date: '2024-03-02',
      due_date: '2024-04-01',
      currency: 'USD',
      total: 125.00
    };

    const result = matcher.match(bankTx, [invoiceA, invoiceB]);

    // Must return AMBIGUOUS rather than arbitrarily selecting invoiceA
    assert.equal(result.decision, MatchDecision.AMBIGUOUS);
    assert.equal(result.candidate, null, 'Ambiguous match must not arbitrarily bind a candidate');
    assert.ok(result.reasons.summary.includes('Ambiguous match'));
    assert.equal(result.allCandidates.length, 2);
  });

  test('9. Currency mismatch -> rejected', () => {
    const bankTx = {
      id: 'tx-usd',
      amount: 100.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-02',
      description: 'GLOBAL CLOUD SUPPLIES'
    };

    const invoiceEur = {
      id: 'inv-eur',
      document_type: DocumentType.PAYABLE,
      counterparty_name: 'Global Cloud Supplies',
      issue_date: '2024-03-01',
      currency: 'EUR', // Different currency
      total: 100.00
    };

    const result = matcher.match(bankTx, [invoiceEur]);

    assert.equal(result.decision, MatchDecision.REJECTED);
    assert.equal(result.score, 0.0);
    assert.equal(result.allCandidates[0].rejectionReason, RejectionReason.CURRENCY_MISMATCH);
    assert.ok(result.allCandidates[0].reasons.compatibility.includes('Currency mismatch'));
  });

  test('10. Provider payout -> compatible with bank inflow', () => {
    const bankInflow = {
      id: 'tx-stripe-payout',
      amount: 48.25,
      currency: 'USD',
      direction: Direction.INFLOW,
      transaction_date: '2024-03-01',
      description: 'STRIPE PAYOUT TRANSFER'
    };

    const stripePayout = {
      id: 'rec-po-01',
      provider: 'stripe',
      record_type: 'payout',
      provider_record_id: 'po_1MtwLwLkdIwHu7ix39b4trQc',
      amount: 48.25,
      net_amount: 48.25,
      currency: 'USD',
      transaction_time: '2024-03-01T12:00:00.000Z',
      status: 'paid'
    };

    const result = matcher.match(bankInflow, [stripePayout]);

    assert.equal(result.decision, MatchDecision.MATCH);
    assert.equal(result.matchType, MatchType.BANK_TO_PROVIDER_PAYOUT);
    assert.equal(result.candidateId, stripePayout.id);
    assert.ok(result.score >= 0.85);
    assert.equal(result.amountComparison.isExact, true);
    assert.equal(result.dateDifference.isWithinWindow, true);
  });

  test('11. Provider charge/payment -> not automatically treated as a bank payout', () => {
    const bankInflow = {
      id: 'tx-inflow-50',
      amount: 50.00,
      currency: 'USD',
      direction: Direction.INFLOW,
      transaction_date: '2024-03-01',
      description: 'STRIPE TRANSFER'
    };

    const stripeCharge = {
      id: 'rec-ch-01',
      provider: 'stripe',
      record_type: 'charge', // Charge is customer transaction, NOT payout
      provider_record_id: 'ch_3MtwLwLkdIwHu7ix28a3tqPa',
      amount: 50.00,
      currency: 'USD',
      transaction_time: '2024-03-01T10:00:00.000Z'
    };

    const result = matcher.match(bankInflow, [stripeCharge]);

    assert.equal(result.decision, MatchDecision.REJECTED);
    assert.equal(result.score, 0.0);
    assert.equal(result.allCandidates[0].rejectionReason, RejectionReason.PROVIDER_CHARGE_NOT_PAYOUT);
  });

  test('12. Refund/fee -> not incorrectly matched to an ordinary invoice payment', () => {
    const bankOutflow = {
      id: 'tx-outflow-refund',
      amount: 15.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-03',
      description: 'STRIPE REFUND'
    };

    const stripeRefund = {
      id: 'rec-re-01',
      provider: 'stripe',
      record_type: 'refund',
      provider_record_id: 're_3MtwLwLkdIwHu7ix40c5tsRd',
      amount: 15.00,
      currency: 'USD',
      transaction_time: '2024-03-03T12:00:00.000Z'
    };

    const result = matcher.match(bankOutflow, [stripeRefund]);

    assert.equal(result.decision, MatchDecision.REJECTED);
    assert.equal(result.score, 0.0);
    assert.equal(result.allCandidates[0].rejectionReason, RejectionReason.REFUND_OR_FEE_NOT_PAYMENT);
  });

  test('13. Null/unknown counterparty -> matcher still works using amount/date evidence but does not invent vendor identity', () => {
    const bankTx = {
      id: 'tx-check-101',
      amount: 850.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-04',
      description: 'CHECK #101' // Description has no identifiable vendor name
    };

    const invoiceWithUnknownCp = {
      id: 'inv-no-vendor',
      document_type: DocumentType.PAYABLE,
      counterparty_name: null, // Vendor unknown
      issue_date: '2024-03-04',
      due_date: '2024-04-04',
      currency: 'USD',
      total: 850.00
    };

    const result = matcher.match(bankTx, [invoiceWithUnknownCp]);

    // Should match based on strong amount + date evidence
    assert.equal(result.decision, MatchDecision.MATCH);
    assert.ok(result.score >= 0.80);
    assert.equal(result.counterpartySimilarity.isEvaluated, false);
    assert.equal(result.counterpartySimilarity.similarityScore, null);
    // Verifies matcher does NOT invent a synthetic vendor name
    assert.equal(result.candidate.counterparty_name, null);
    assert.ok(result.reasons.counterparty.includes('Counterparty unknown or missing'));
  });

  test('14. Configurable date window behaves correctly', () => {
    const bankTx = {
      id: 'tx-dated',
      amount: 200.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-15', // 14 days after issue_date (2024-03-01)
      description: 'DIGITALOCEAN'
    };

    const invoice = {
      id: 'inv-do',
      document_type: DocumentType.PAYABLE,
      counterparty_name: 'DigitalOcean LLC',
      issue_date: '2024-03-01',
      currency: 'USD',
      total: 200.00
    };

    // A) Window of 7 days: 14 days difference is OUTSIDE window -> no match
    const strictMatcher = new DeterministicMatcher({ dateWindowDays: 7 });
    const strictResult = strictMatcher.match(bankTx, [invoice]);
    assert.equal(strictResult.decision, MatchDecision.UNMATCHED);
    assert.equal(strictResult.score, 0.0);

    // B) Window of 20 days: 14 days difference is INSIDE window -> matches!
    const relaxedMatcher = new DeterministicMatcher({ dateWindowDays: 20 });
    const relaxedResult = relaxedMatcher.match(bankTx, [invoice]);
    assert.equal(relaxedResult.decision, MatchDecision.MATCH);
    assert.ok(relaxedResult.score >= 0.80);
  });

  test('15. Score and reasons are deterministic and reproducible', () => {
    const bankTx = {
      id: 'tx-repeat',
      amount: 125.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-02',
      description: 'AMAZON WEB SERVICES'
    };

    const invoice = {
      id: 'inv-repeat',
      document_type: DocumentType.PAYABLE,
      counterparty_name: 'Amazon Web Services Inc.',
      issue_date: '2024-03-01',
      due_date: '2024-03-31',
      currency: 'USD',
      total: 125.00
    };

    const runs = [];
    for (let i = 0; i < 10; i++) {
      runs.push(matcher.match(bankTx, [invoice]));
    }

    const firstRun = runs[0];
    for (let i = 1; i < 10; i++) {
      assert.equal(runs[i].score, firstRun.score, 'Score must be identical across runs');
      assert.equal(runs[i].decision, firstRun.decision, 'Decision must be identical across runs');
      assert.deepEqual(runs[i].reasons, firstRun.reasons, 'Reasons must be identical across runs');
      assert.deepEqual(runs[i].amountComparison, firstRun.amountComparison);
      assert.deepEqual(runs[i].dateDifference, firstRun.dateDifference);
    }
  });

  test('16. Generic word does NOT automatically match multi-word vendor without evidence', () => {
    const genericCp = 'Amazon';
    const specificCp = 'Amazon Web Services';

    const sim = calculateCounterpartySimilarity(genericCp, specificCp);
    assert.ok(sim.score <= 0.60, `Generic word similarity should be <= 0.60, got ${sim.score}`);

    // If an invoice is for "Amazon Web Services" and bank transaction is just "AMAZON"
    const bankTx = {
      id: 'tx-amazon-generic',
      amount: 125.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-02',
      description: 'AMAZON'
    };

    const invoiceAws = {
      id: 'inv-aws-spec',
      document_type: DocumentType.PAYABLE,
      counterparty_name: 'Amazon Web Services',
      issue_date: '2024-03-01',
      due_date: '2024-03-31',
      currency: 'USD',
      total: 125.00
    };

    const result = matcher.match(bankTx, [invoiceAws]);
    // Since counterparty similarity is low (0.50), overall score is ~0.70 < 0.80 threshold
    assert.notEqual(result.decision, MatchDecision.MATCH);
    assert.equal(result.decision, MatchDecision.UNMATCHED);
  });

  test('17. Output domain model is read-only and immutable', () => {
    const bankTx = {
      id: 'tx-immut',
      amount: 100.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-01',
      description: 'TEST VENDOR'
    };

    const invoice = {
      id: 'inv-immut',
      document_type: DocumentType.PAYABLE,
      counterparty_name: 'Test Vendor',
      issue_date: '2024-03-01',
      currency: 'USD',
      total: 100.00
    };

    const result = matcher.match(bankTx, [invoice]);

    assert.ok(Object.isFrozen(result), 'MatchResult must be frozen');
    assert.ok(Object.isFrozen(result.reasons), 'reasons must be frozen');
    assert.ok(Object.isFrozen(result.allCandidates), 'allCandidates must be frozen');

    // Modifying fields must throw or fail in strict mode
    assert.throws(() => {
      result.score = 999;
    }, TypeError);
  });

  test('18. End-to-End Fixture Reconciliation using Session 1 Ingested Data', async () => {
    const db = initDatabase(':memory:');
    const service = new IngestionService(db);

    // Ingest all Session 1 fixtures
    await service.ingestFile(path.join(FIXTURES_DIR, 'bank_transactions.csv'));
    await service.ingestFile(path.join(FIXTURES_DIR, 'ap_bill_aws.pdf'), { companyNames: ['CabinAI'] });
    await service.ingestFile(path.join(FIXTURES_DIR, 'ar_invoice_acme.pdf'), { companyNames: ['CabinAI'] });
    await service.ingestFile(path.join(FIXTURES_DIR, 'stripe_export.json'));
    await service.ingestFile(path.join(FIXTURES_DIR, 'dodo_export.json'));

    const bankTxs = service.bankTransactions.findAll();
    const invoices = service.invoices.findAll();
    const providerRecords = service.paymentProviderRecords.findAll();

    const allCandidates = [...invoices, ...providerRecords];

    // 1. AWS Outflow -> AP Bill AWS
    const awsBankTx = bankTxs.find(t => t.description === 'AMAZON WEB SERVICES');
    assert.ok(awsBankTx);
    const awsMatch = matcher.match(awsBankTx, allCandidates);
    assert.equal(awsMatch.decision, MatchDecision.MATCH);
    assert.equal(awsMatch.matchType, MatchType.BANK_TO_INVOICE);
    assert.equal(awsMatch.candidate.invoice_number, 'INV-AWS-2024-9841');
    assert.equal(awsMatch.amountComparison.isExact, true);

    // 2. Acme Inflow -> AR Invoice Acme
    const acmeBankTx = bankTxs.find(t => t.description === 'ACME CORP WIRE PAYMENT');
    assert.ok(acmeBankTx);
    const acmeMatch = matcher.match(acmeBankTx, allCandidates);
    assert.equal(acmeMatch.decision, MatchDecision.MATCH);
    assert.equal(acmeMatch.matchType, MatchType.BANK_TO_INVOICE);
    assert.equal(acmeMatch.candidate.invoice_number, 'INV-CABIN-2024-102');
    assert.equal(acmeMatch.amountComparison.isExact, true);

    // 3. Office Rent Outflow -> No matching invoice in fixtures
    const rentBankTx = bankTxs.find(t => t.description === 'OFFICE RENT MARCH');
    assert.ok(rentBankTx);
    const rentMatch = matcher.match(rentBankTx, allCandidates);
    assert.equal(rentMatch.decision, MatchDecision.UNMATCHED);
  });
});
