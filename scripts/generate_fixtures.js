const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const FIXTURES_DIR = path.join(__dirname, '../fixtures');

if (!fs.existsSync(FIXTURES_DIR)) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
}

// 1. Bank CSV fixture
const bankCsvContent = `Transaction Date,Description,Reference,Debit,Credit,Balance
2024-03-01,STRIPE PAYOUT TRANSFER,REF-STRIPE-001,,4825.00,14825.00
2024-03-02,AMAZON WEB SERVICES,AWS-PAY-9841,125.00,,14700.00
2024-03-03,ACME CORP WIRE PAYMENT,WIRE-ACME-01,,2700.00,17400.00
2024-03-04,GITHUB SUBSCRIPTION,GH-SUB-2024,42.00,,17358.00
2024-03-05,OFFICE RENT MARCH,RENT-MARCH,1500.00,,15858.00
`;
fs.writeFileSync(path.join(FIXTURES_DIR, 'bank_transactions.csv'), bankCsvContent.trim(), 'utf8');

// 2. Stripe JSON fixture
const stripeJsonContent = [
  {
    id: "ch_3MtwLwLkdIwHu7ix28a3tqPa",
    object: "charge",
    amount: 5000,
    currency: "usd",
    fee: 175,
    net: 4825,
    created: 1709294400,
    customer: "cus_N5v8uH6h0oPqRt",
    customer_details: {
      name: "Jane Smith",
      email: "jane.smith@example.com"
    },
    status: "succeeded",
    paid: true,
    balance_transaction: "txn_1MtwLwLkdIwHu7ix11a2b3c4"
  },
  {
    id: "po_1MtwLwLkdIwHu7ix39b4trQc",
    object: "payout",
    amount: 4825,
    currency: "usd",
    fee: 0,
    net: 4825,
    arrival_date: 1709380800,
    status: "paid",
    balance_transaction: "txn_1MtwLwLkdIwHu7ix99z8y7x6"
  },
  {
    id: "re_3MtwLwLkdIwHu7ix40c5tsRd",
    object: "refund",
    amount: 1500,
    currency: "usd",
    fee: 0,
    net: 1500,
    created: 1709467200,
    charge: "ch_3MtwLwLkdIwHu7ix28a3tqPa",
    status: "succeeded"
  }
];
fs.writeFileSync(path.join(FIXTURES_DIR, 'stripe_export.json'), JSON.stringify(stripeJsonContent, null, 2), 'utf8');

// 3. Dodo Payments JSON fixture
const dodoJsonContent = {
  payments: [
    {
      payment_id: "dodopay_98765",
      type: "payment",
      amount: 9900,
      fee: 320,
      settlement_amount: 9580,
      currency: "USD",
      status: "succeeded",
      created_at: "2024-03-02T10:15:30.000Z",
      customer: {
        customer_id: "dodocus_4321",
        name: "Alice Wonderland",
        email: "alice@example.com"
      },
      invoice_id: "dodoinv_8812"
    },
    {
      payment_id: "dodopo_54321",
      type: "payout",
      amount: 9580,
      fee: 0,
      settlement_amount: 9580,
      currency: "USD",
      status: "completed",
      created_at: "2024-03-03T16:45:00.000Z",
      customer: null
    }
  ]
};
fs.writeFileSync(path.join(FIXTURES_DIR, 'dodo_export.json'), JSON.stringify(dodoJsonContent, null, 2), 'utf8');

// Helper to create PDF
function createPdfFile(filePath, writeCallback) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    writeCallback(doc);
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function generateAllPdfs() {
  // 4. AP Invoice/Bill (AWS Bill to CabinAI)
  await createPdfFile(path.join(FIXTURES_DIR, 'ap_bill_aws.pdf'), (doc) => {
    doc.fontSize(20).text('VENDOR BILL / TAX INVOICE', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text('Vendor: Amazon Web Services Inc.');
    doc.text('Bill To: CabinAI Inc.');
    doc.text('Invoice #: INV-AWS-2024-9841');
    doc.text('Issue Date: 2024-03-01');
    doc.text('Due Date: 2024-03-31');
    doc.moveDown();
    doc.text('Description: Cloud Infrastructure - Elastic Compute Cloud (EC2)');
    doc.text('Subtotal: $125.00');
    doc.text('Tax: $0.00');
    doc.fontSize(14).text('Total Due: $125.00');
    doc.moveDown();
    doc.fontSize(10).text('Remit payment to AWS Banking Corp.');
  });

  // 5. AR Customer Invoice (CabinAI to Acme Corp)
  await createPdfFile(path.join(FIXTURES_DIR, 'ar_invoice_acme.pdf'), (doc) => {
    doc.fontSize(20).text('SALES INVOICE / ACCOUNTS RECEIVABLE', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text('From: CabinAI Inc.');
    doc.text('Bill To: Acme Corporation');
    doc.text('Invoice #: INV-CABIN-2024-102');
    doc.text('Issue Date: 2024-03-05');
    doc.text('Due Date: 2024-04-05');
    doc.moveDown();
    doc.text('Description: Enterprise AI Autonomous Bookkeeping Platform License');
    doc.text('Subtotal: $2,500.00');
    doc.text('Tax: $200.00');
    doc.fontSize(14).text('Total Due: $2,700.00');
  });

  // 6. Missing/Uncertain fields invoice (generic Amount, no explicit Total, no AP/AR evidence)
  await createPdfFile(path.join(FIXTURES_DIR, 'uncertain_invoice.pdf'), (doc) => {
    doc.fontSize(16).text('Receipt / Notice of Charge', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text('Thank you for your business.');
    doc.text('Service period: March 2024');
    doc.text('Amount: $75.50');
    doc.text('Paid via credit card ending in 4242');
  });

  // 7. Negative Test: Line-item Amounts and Subtotal appear before actual Total Due
  await createPdfFile(path.join(FIXTURES_DIR, 'negative_multiamount_invoice.pdf'), (doc) => {
    doc.fontSize(20).text('TAX INVOICE', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text('Vendor: Global Cloud Supplies');
    doc.text('Bill To: CabinAI Inc.');
    doc.text('Invoice #: INV-MULTI-2024-88');
    doc.text('Issue Date: 2024-03-10');
    doc.moveDown();
    doc.text('Item 1: Premium Hosting  Amount: $45.00');
    doc.text('Item 2: Domain Renewal   Amount: $55.00');
    doc.text('Subtotal: $100.00');
    doc.text('Tax: $10.00');
    doc.fontSize(14).text('Total Due: $110.00');
  });

  // 8. Negative Test: Subtotal only, NO explicit total line (must not fallback to subtotal)
  await createPdfFile(path.join(FIXTURES_DIR, 'negative_subtotal_only_invoice.pdf'), (doc) => {
    doc.fontSize(20).text('ESTIMATE / INVOICE DRAFT', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text('Invoice #: INV-NO-TOTAL-001');
    doc.text('Subtotal: $250.00');
    doc.text('Tax: $20.00');
    doc.text('Status: Pending final calculations');
  });

  console.log('All fixtures generated successfully in fixtures/');
}

generateAllPdfs().catch(err => {
  console.error('Error generating PDF fixtures:', err);
  process.exit(1);
});
