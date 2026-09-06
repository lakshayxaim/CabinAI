const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { initDatabase } = require('../src/db/connection');
const IngestionService = require('../src/services/ingestionService');
const { Direction, DocumentType, ProviderType, SourceType } = require('../src/models/types');
const { cleanAndValidateCounterparty, extractFieldsFromText } = require('../src/parsers/invoicePdfParser');

const FIXTURES_DIR = path.join(__dirname, '../fixtures');

describe('CabinAI - Financial Data Ingestion (Session 1)', () => {
  let db;
  let service;

  beforeEach(() => {
    // Fresh in-memory database for isolated, fast, deterministic testing
    db = initDatabase(':memory:');
    service = new IngestionService(db);
  });

  test('1. Bank Inflow - normalizes credit transactions into cash inflows', async () => {
    const csvContent = `Date,Description,Reference,Debit,Credit
2024-03-01,STRIPE PAYOUT TRANSFER,REF-STRIPE-001,,4825.00
2024-03-03,ACME CORP WIRE PAYMENT,WIRE-ACME-01,,2700.00`;

    const result = await service.ingestContent(csvContent, SourceType.BANK_CSV, {
      filename: 'bank_inflow_test.csv'
    });

    assert.equal(result.totalParsed, 2);
    assert.equal(result.insertedCount, 2);

    const inflows = service.bankTransactions.findByDirection(Direction.INFLOW);
    assert.equal(inflows.length, 2);

    const stripePayoutTx = inflows.find(t => t.bank_reference === 'REF-STRIPE-001');
    assert.ok(stripePayoutTx, 'Stripe payout transaction must exist');
    assert.equal(stripePayoutTx.amount, 4825.00);
    assert.equal(stripePayoutTx.direction, Direction.INFLOW);
    assert.equal(stripePayoutTx.currency, 'USD');
    assert.equal(stripePayoutTx.transaction_date, '2024-03-01');
    assert.equal(stripePayoutTx.source, SourceType.BANK_CSV);
    assert.ok(stripePayoutTx.source_record_id.length > 0);
  });

  test('2. Bank Outflow - normalizes debit transactions into cash outflows', async () => {
    const csvContent = `Date,Description,Reference,Debit,Credit
2024-03-02,AMAZON WEB SERVICES,AWS-PAY-9841,125.00,
2024-03-04,GITHUB SUBSCRIPTION,GH-SUB-2024,42.00,`;

    const result = await service.ingestContent(csvContent, SourceType.BANK_CSV, {
      filename: 'bank_outflow_test.csv'
    });

    assert.equal(result.totalParsed, 2);
    assert.equal(result.insertedCount, 2);

    const outflows = service.bankTransactions.findByDirection(Direction.OUTFLOW);
    assert.equal(outflows.length, 2);

    const awsTx = outflows.find(t => t.bank_reference === 'AWS-PAY-9841');
    assert.ok(awsTx, 'AWS transaction must exist');
    assert.equal(awsTx.amount, 125.00);
    assert.equal(awsTx.direction, Direction.OUTFLOW);
    assert.equal(awsTx.currency, 'USD');
    assert.equal(awsTx.transaction_date, '2024-03-02');
    assert.equal(awsTx.description, 'AMAZON WEB SERVICES');
  });

  test('3. Accounts Payable (AP) - ingests vendor bill PDF with payable document_type', async () => {
    const pdfPath = path.join(FIXTURES_DIR, 'ap_bill_aws.pdf');
    assert.ok(fs.existsSync(pdfPath), 'AP fixture PDF must exist');

    const result = await service.ingestFile(pdfPath, {
      companyNames: ['CabinAI']
    });

    assert.equal(result.totalParsed, 1);
    assert.equal(result.insertedCount, 1);

    const payables = service.invoices.findByDocumentType(DocumentType.PAYABLE);
    assert.equal(payables.length, 1);

    const bill = payables[0];
    assert.equal(bill.document_type, DocumentType.PAYABLE, 'Must be classified as Accounts Payable (payable)');
    assert.equal(bill.invoice_number, 'INV-AWS-2024-9841');
    assert.equal(bill.issue_date, '2024-03-01');
    assert.equal(bill.due_date, '2024-03-31');
    assert.equal(bill.total, 125.00);
    assert.equal(bill.currency, 'USD');
    assert.ok(bill.counterparty_name.includes('Amazon Web Services'));

    // Verify vendor counterparty was registered
    const vendor = service.counterparties.findByName(bill.counterparty_name);
    assert.ok(vendor, 'Vendor counterparty must be created');
    assert.equal(vendor.type, 'vendor');
  });

  test('4. Accounts Receivable (AR) - ingests customer invoice PDF with receivable document_type', async () => {
    const pdfPath = path.join(FIXTURES_DIR, 'ar_invoice_acme.pdf');
    assert.ok(fs.existsSync(pdfPath), 'AR fixture PDF must exist');

    const result = await service.ingestFile(pdfPath, {
      companyNames: ['CabinAI']
    });

    assert.equal(result.totalParsed, 1);
    assert.equal(result.insertedCount, 1);

    const receivables = service.invoices.findByDocumentType(DocumentType.RECEIVABLE);
    assert.equal(receivables.length, 1);

    const invoice = receivables[0];
    assert.equal(invoice.document_type, DocumentType.RECEIVABLE, 'Must be classified as Accounts Receivable (receivable)');
    assert.equal(invoice.invoice_number, 'INV-CABIN-2024-102');
    assert.equal(invoice.issue_date, '2024-03-05');
    assert.equal(invoice.due_date, '2024-04-05');
    assert.equal(invoice.subtotal, 2500.00);
    assert.equal(invoice.tax, 200.00);
    assert.equal(invoice.total, 2700.00);
    assert.ok(invoice.counterparty_name.includes('Acme Corporation'));

    // Verify customer counterparty was registered
    const customer = service.counterparties.findByName(invoice.counterparty_name);
    assert.ok(customer, 'Customer counterparty must be created');
    assert.equal(customer.type, 'customer');
  });

  test('5. Stripe JSON - normalizes payment and payout data preserving provider attributes', async () => {
    const stripePath = path.join(FIXTURES_DIR, 'stripe_export.json');
    const result = await service.ingestFile(stripePath);

    assert.equal(result.totalParsed, 3);
    assert.equal(result.insertedCount, 3);

    const stripeRecords = service.paymentProviderRecords.findByProvider(ProviderType.STRIPE);
    assert.equal(stripeRecords.length, 3);

    // Verify charge
    const charge = stripeRecords.find(r => r.provider_record_id === 'ch_3MtwLwLkdIwHu7ix28a3tqPa');
    assert.ok(charge, 'Stripe charge record must exist');
    assert.equal(charge.record_type, 'charge');
    assert.equal(charge.amount, 50.00);
    assert.equal(charge.fee, 1.75);
    assert.equal(charge.net_amount, 48.25);
    assert.equal(charge.status, 'succeeded');
    assert.equal(charge.customer_name, 'Jane Smith');

    // Verify payout
    const payout = stripeRecords.find(r => r.provider_record_id === 'po_1MtwLwLkdIwHu7ix39b4trQc');
    assert.ok(payout, 'Stripe payout record must exist');
    assert.equal(payout.record_type, 'payout');
    assert.equal(payout.amount, 48.25);
    assert.equal(payout.fee, 0);
    assert.equal(payout.net_amount, 48.25);

    // Verify refund
    const refund = stripeRecords.find(r => r.provider_record_id === 're_3MtwLwLkdIwHu7ix40c5tsRd');
    assert.ok(refund, 'Stripe refund record must exist');
    assert.equal(refund.record_type, 'refund');
    assert.equal(refund.amount, 15.00);

    const related = JSON.parse(refund.related_provider_ids);
    assert.equal(related.charge_id, 'ch_3MtwLwLkdIwHu7ix28a3tqPa');
  });

  test('6. Dodo Payments JSON - normalizes payment and payout data preserving provider attributes', async () => {
    const dodoPath = path.join(FIXTURES_DIR, 'dodo_export.json');
    const result = await service.ingestFile(dodoPath);

    assert.equal(result.totalParsed, 2);
    assert.equal(result.insertedCount, 2);

    const dodoRecords = service.paymentProviderRecords.findByProvider(ProviderType.DODO);
    assert.equal(dodoRecords.length, 2);

    const payment = dodoRecords.find(r => r.provider_record_id === 'dodopay_98765');
    assert.ok(payment, 'Dodo payment must exist');
    assert.equal(payment.record_type, 'payment');
    assert.equal(payment.amount, 99.00);
    assert.equal(payment.fee, 3.20);
    assert.equal(payment.net_amount, 95.80);
    assert.equal(payment.status, 'succeeded');
    assert.equal(payment.customer_name, 'Alice Wonderland');

    const payout = dodoRecords.find(r => r.provider_record_id === 'dodopo_54321');
    assert.ok(payout, 'Dodo payout must exist');
    assert.equal(payout.record_type, 'payout');
    assert.equal(payout.amount, 95.80);
  });

  test('7. Duplicate Import - guarantees idempotency across all source types', async () => {
    const csvPath = path.join(FIXTURES_DIR, 'bank_transactions.csv');

    // First import
    const res1 = await service.ingestFile(csvPath);
    assert.equal(res1.insertedCount, 5);
    assert.equal(res1.skippedCount, 0);
    const initialCount = service.bankTransactions.count();
    assert.equal(initialCount, 5);

    // Second import of the EXACT SAME file
    const res2 = await service.ingestFile(csvPath);
    assert.equal(res2.insertedCount, 0, 'Must insert 0 duplicate transactions');
    assert.equal(res2.skippedCount, 5, 'Must skip all 5 duplicate transactions');
    assert.equal(service.bankTransactions.count(), 5, 'Database row count must remain unchanged');

    // Also verify PDF idempotency
    const pdfPath = path.join(FIXTURES_DIR, 'ap_bill_aws.pdf');
    const pdfRes1 = await service.ingestFile(pdfPath);
    assert.equal(pdfRes1.insertedCount, 1);
    const pdfRes2 = await service.ingestFile(pdfPath);
    assert.equal(pdfRes2.insertedCount, 0);
    assert.equal(pdfRes2.skippedCount, 1);
    assert.equal(service.invoices.count(), 1);

    // Also verify Stripe idempotency
    const stripePath = path.join(FIXTURES_DIR, 'stripe_export.json');
    const stRes1 = await service.ingestFile(stripePath);
    assert.equal(stRes1.insertedCount, 3);
    const stRes2 = await service.ingestFile(stripePath);
    assert.equal(stRes2.insertedCount, 0);
    assert.equal(stRes2.skippedCount, 3);
    assert.equal(service.paymentProviderRecords.count(), 3);
  });

  test('8. Missing/Uncertain Fields - does not hallucinate, does not default to PAYABLE, preserves null', async () => {
    const uncertainPath = path.join(FIXTURES_DIR, 'uncertain_invoice.pdf');
    const result = await service.ingestFile(uncertainPath);

    assert.equal(result.totalParsed, 1);
    assert.equal(result.insertedCount, 1);

    const inv = service.invoices.findAll()[0];
    assert.ok(inv, 'Invoice record must exist');
    // Verify unhallucinated missing fields
    assert.equal(inv.invoice_number, null, 'Must NOT hallucinate invoice number');
    assert.equal(inv.due_date, null, 'Must NOT hallucinate due date');
    assert.equal(inv.issue_date, null, 'Must NOT hallucinate issue date');

    // Generic "Amount:" must NOT be treated as high-confidence invoice total
    assert.equal(inv.total, null, 'Must NOT treat generic Amount as high-confidence invoice total');

    // Ambiguous documents must NOT default to PAYABLE
    assert.equal(inv.document_type, DocumentType.UNKNOWN, 'Must be classified as unknown when evidence is insufficient');

    // Counterparty must remain null rather than synthetic "Unknown Vendor"
    assert.equal(inv.counterparty_name, null, 'Must NOT invent synthetic counterparty name');
    assert.equal(inv.counterparty_id, null, 'Must NOT link to synthetic counterparty');
    assert.equal(service.counterparties.findAll().length, 0, 'Must NOT create counterparty record in database');

    // Verify raw data and provenance preservation
    const rawData = JSON.parse(inv.raw_data);
    assert.ok(rawData.raw_text.includes('Thank you for your business'));
    assert.ok(rawData.extraction_metadata);
    assert.deepEqual(rawData.extraction_metadata.raw_entities.unclassified_amounts, [75.50]);
    assert.equal(rawData.extraction_metadata.confidences.total, 'none');
    assert.equal(rawData.extraction_metadata.confidences.document_type, 'none');
  });

  test('9. Provenance Tracking - import_batches retains source metadata and links', async () => {
    const csvPath = path.join(FIXTURES_DIR, 'bank_transactions.csv');
    const res = await service.ingestFile(csvPath);

    const batch = service.importBatches.findById(res.batchId);
    assert.ok(batch, 'Import batch must be stored');
    assert.equal(batch.source_type, SourceType.BANK_CSV);
    assert.equal(batch.filename, 'bank_transactions.csv');
    assert.ok(batch.file_hash, 'File hash must be computed');
    assert.equal(batch.status, 'completed');
    assert.equal(batch.total_records, 5);

    // Verify transactions reference this batch id
    const txs = service.bankTransactions.findAll();
    for (const tx of txs) {
      assert.equal(tx.import_batch_id, batch.id);
    }
  });

  test('10. Negative Test - Monetary values (Amount, Subtotal, Tax) before actual Total are not chosen as Total', async () => {
    const multiAmountPath = path.join(FIXTURES_DIR, 'negative_multiamount_invoice.pdf');
    const result = await service.ingestFile(multiAmountPath, { companyNames: ['CabinAI'] });

    assert.equal(result.totalParsed, 1);
    assert.equal(result.insertedCount, 1);

    const inv = service.invoices.findAll()[0];
    assert.ok(inv, 'Invoice record must exist');

    // Verify that the explicit Total Due is extracted, NOT earlier item amounts (45.00, 55.00) or subtotal (100.00)
    assert.equal(inv.total, 110.00, 'Must extract explicit Total Due (110.00), not earlier item amounts or subtotal');
    assert.equal(inv.subtotal, 100.00, 'Subtotal must be accurately separated');
    assert.equal(inv.tax, 10.00, 'Tax must be accurately separated');
    assert.equal(inv.invoice_number, 'INV-MULTI-2024-88');
    assert.equal(inv.document_type, DocumentType.PAYABLE);

    const rawData = JSON.parse(inv.raw_data);
    assert.equal(rawData.extraction_metadata.confidences.total, 'high');
  });

  test('11. Negative Test - Subtotal is not used as fallback for Total when Total is missing', async () => {
    const noTotalPath = path.join(FIXTURES_DIR, 'negative_subtotal_only_invoice.pdf');
    const result = await service.ingestFile(noTotalPath);

    assert.equal(result.totalParsed, 1);
    assert.equal(result.insertedCount, 1);

    const inv = service.invoices.findAll()[0];
    assert.ok(inv, 'Invoice record must exist');

    // Subtotal was present ($250.00), but Total line was missing
    assert.equal(inv.subtotal, 250.00, 'Subtotal was extracted');
    assert.equal(inv.total, null, 'Must NOT use subtotal as fallback for missing total');
    assert.equal(inv.invoice_number, 'INV-NO-TOTAL-001');

    const rawData = JSON.parse(inv.raw_data);
    assert.equal(rawData.extraction_metadata.confidences.total, 'none');
  });

  test('12. Negative Test - Ambiguous AP/AR documents do not default to PAYABLE and do not create synthetic counterparties', async () => {
    const noTotalPath = path.join(FIXTURES_DIR, 'negative_subtotal_only_invoice.pdf');
    await service.ingestFile(noTotalPath);

    const inv = service.invoices.findAll()[0];
    assert.equal(inv.document_type, DocumentType.UNKNOWN, 'Must be unknown document_type');
    assert.equal(inv.counterparty_name, null, 'Must not create Unknown Vendor or Unknown Customer');
    assert.equal(inv.counterparty_id, null);
    assert.equal(service.counterparties.findAll().length, 0, 'Counterparties table must remain pristine');
  });

  test('13. Reusable Counterparty Validation - Rejects document headings and validates genuine counterparties', () => {
    // Document headings that must ALWAYS be rejected as counterparty candidates
    const invalidHeadings = [
      'BILL / TAX INVOICE',
      'VENDOR BILL / TAX INVOICE',
      'INVOICE',
      'TAX INVOICE',
      'COMMERCIAL INVOICE',
      'PROFORMA INVOICE',
      'SALES INVOICE',
      'CUSTOMER INVOICE',
      'RECEIPT / NOTICE OF CHARGE',
      'STATEMENT',
      'PURCHASE ORDER',
      'ESTIMATE',
      'CREDIT NOTE',
      'PACKING SLIP',
      '---',
      '/',
      '   '
    ];

    for (const heading of invalidHeadings) {
      const validated = cleanAndValidateCounterparty(heading);
      assert.equal(validated, null, `Heading "${heading}" must be rejected as counterparty name`);
    }

    // Genuine counterparties that must be accepted
    const validCounterparties = [
      'Amazon Web Services Inc.',
      'Acme Corporation',
      'Global Cloud Supplies',
      'GitHub, Inc.',
      'DigitalOcean LLC'
    ];

    for (const cp of validCounterparties) {
      const validated = cleanAndValidateCounterparty(cp);
      assert.equal(validated, cp, `Genuine counterparty "${cp}" must be accepted`);
    }
  });

  test('14. Document Heading Safety - Heading without explicit labels does not leak into counterparty_name', () => {
    const headingText = `COMMERCIAL INVOICE / TAX INVOICE
Date: 2024-03-15
Invoice #: INV-HEAD-001
Total Due: $500.00`;

    const extracted = extractFieldsFromText(headingText);
    assert.equal(extracted.vendorName, null, 'Heading must not be extracted as vendorName');
    assert.equal(extracted.customerName, null, 'Heading must not be extracted as customerName');
    assert.equal(extracted.counterpartyName, null, 'Heading must not leak into counterpartyName');
    assert.equal(extracted.total, 500.00);
    assert.equal(extracted.invoiceNumber, 'INV-HEAD-001');
    assert.equal(extracted.documentType, DocumentType.UNKNOWN, 'Document without AP/AR evidence must be unknown');
  });
});
