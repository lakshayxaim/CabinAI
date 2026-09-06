/**
 * Canonical financial constants and types for CabinAI.
 */

const Direction = Object.freeze({
  INFLOW: 'inflow',
  OUTFLOW: 'outflow'
});

const DocumentType = Object.freeze({
  PAYABLE: 'payable',      // Accounts Payable (AP): What business owes vendor
  RECEIVABLE: 'receivable', // Accounts Receivable (AR): What customer owes business
  UNKNOWN: 'unknown'       // Ambiguous / insufficient evidence for AP or AR
});

const CounterpartyType = Object.freeze({
  VENDOR: 'vendor',
  CUSTOMER: 'customer',
  BOTH: 'both',
  UNKNOWN: 'unknown'
});

const InvoiceStatus = Object.freeze({
  DRAFT: 'draft',
  ISSUED: 'issued',
  UNPAID: 'unpaid',
  PAID: 'paid',
  VOID: 'void',
  UNKNOWN: 'unknown'
});

const ProviderType = Object.freeze({
  STRIPE: 'stripe',
  DODO: 'dodo'
});

const SourceType = Object.freeze({
  BANK_CSV: 'bank_csv',
  INVOICE_PDF: 'invoice_pdf',
  STRIPE_JSON: 'stripe_json',
  DODO_JSON: 'dodo_json'
});

module.exports = {
  Direction,
  DocumentType,
  CounterpartyType,
  InvoiceStatus,
  ProviderType,
  SourceType
};
