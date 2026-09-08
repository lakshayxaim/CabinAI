/**
 * Tool: check_invoice_status
 *
 * Returns normalized invoice status and key fields for a given invoice ID.
 * Uses the existing InvoicesRepository — no LLM, no external API calls.
 *
 * Read-only. Never mutates financial records.
 */

'use strict';

const { InvoiceStatus } = require('../../models/types');

const VALID_STATUSES = new Set(Object.values(InvoiceStatus));

/**
 * Validates check_invoice_status arguments.
 * @param {Object} args
 * @returns {{ valid: boolean, error?: string }}
 */
function validateArgs(args) {
  if (!args || typeof args !== 'object') {
    return { valid: false, error: 'Arguments must be an object' };
  }
  if (typeof args.invoiceId !== 'string' || !args.invoiceId.trim()) {
    return { valid: false, error: '"invoiceId" must be a non-empty string' };
  }
  return { valid: true };
}

/**
 * Fetches normalized invoice status and relevant fields.
 *
 * @param {Object} args
 * @param {string}  args.invoiceId  - The invoice UUID to look up
 * @param {Object} repos
 * @param {Object} repos.invoices  - InvoicesRepository instance
 * @returns {Object} Structured result
 */
function checkInvoiceStatus(args, repos) {
  // --- Input validation ---
  const validation = validateArgs(args);
  if (!validation.valid) {
    return {
      error: true,
      code: 'INVALID_ARGUMENT',
      message: validation.error
    };
  }

  if (!repos || !repos.invoices) {
    return {
      error: true,
      code: 'INTERNAL_ERROR',
      message: 'Invoices repository not available'
    };
  }

  // --- Fetch invoice ---
  let invoice;
  try {
    invoice = repos.invoices.findById(args.invoiceId.trim());
  } catch (err) {
    return {
      error: true,
      code: 'REPOSITORY_ERROR',
      message: `Failed to query invoice: ${err.message}`
    };
  }

  if (!invoice) {
    return {
      error: false,
      invoiceId: args.invoiceId,
      found: false,
      status: null,
      message: 'Invoice not found'
    };
  }

  // Normalize status: fall back to 'unknown' for unrecognized values
  const rawStatus = invoice.status || null;
  const normalizedStatus = rawStatus && VALID_STATUSES.has(rawStatus)
    ? rawStatus
    : InvoiceStatus.UNKNOWN;

  return {
    error: false,
    invoiceId: invoice.id,
    found: true,
    invoiceNumber: invoice.invoice_number || null,
    status: normalizedStatus,
    documentType: invoice.document_type || null,
    issueDate: invoice.issue_date || null,
    dueDate: invoice.due_date || null,
    total: invoice.total !== undefined ? invoice.total : null,
    currency: invoice.currency || null,
    counterpartyId: invoice.counterparty_id || null,
    counterpartyName: invoice.counterparty_name || null,
    source: invoice.source || null,
    importBatchId: invoice.import_batch_id || null,
    createdAt: invoice.created_at || null
  };
}

/**
 * Tool schema for the LLM.
 */
const schema = {
  name: 'check_invoice_status',
  description:
    'Return the normalized status and key fields for a given invoice ID. ' +
    'Status values: draft, issued, unpaid, paid, void, unknown. ' +
    'Returns null status if invoice is not found. Read-only.',
  parameters: {
    type: 'OBJECT',
    properties: {
      invoiceId: {
        type: 'STRING',
        description: 'UUID of the invoice to look up'
      }
    },
    required: ['invoiceId']
  }
};

module.exports = { checkInvoiceStatus, schema, validateArgs };
