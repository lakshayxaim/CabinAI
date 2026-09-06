const pdfModule = require('pdf-parse');
const crypto = require('crypto');
const { normalizeDate } = require('../normalizers/dateNormalizer');
const { parseAmount, normalizeCurrency } = require('../normalizers/amountNormalizer');
const { DocumentType, SourceType } = require('../models/types');

/**
 * Extracts text and page count from a PDF buffer.
 * Supports both v1 (function) and v2 (PDFParse class) of pdf-parse safely.
 * @param {Buffer|Uint8Array} pdfBuffer 
 * @returns {Promise<{ text: string, numPages: number }>}
 */
async function extractPdfText(pdfBuffer) {
  if (typeof pdfModule === 'function') {
    const data = await pdfModule(pdfBuffer);
    return {
      text: (data && data.text) ? data.text : '',
      numPages: (data && data.numpages) || 1
    };
  }
  if (pdfModule.PDFParse) {
    const uint8 = (pdfBuffer && pdfBuffer.buffer)
      ? new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength)
      : new Uint8Array(pdfBuffer);
    const parser = new pdfModule.PDFParse(uint8);
    await parser.load();
    const data = await parser.getText();
    return {
      text: (data && data.text) ? data.text : '',
      numPages: (data && data.total) || 1
    };
  }
  throw new Error('Unsupported pdf-parse module format');
}

/**
 * Known document heading keywords and titles that cannot form a valid counterparty name.
 */
const DOCUMENT_HEADING_KEYWORDS = new Set([
  'bill', 'bills', 'invoice', 'invoices', 'tax', 'tax invoice', 'vendor bill',
  'commercial invoice', 'proforma invoice', 'sales invoice', 'customer invoice',
  'receipt', 'receipts', 'statement', 'statements', 'estimate', 'estimates',
  'credit note', 'debit note', 'purchase order', 'packing slip', 'notice',
  'notice of charge', 'remittance', 'remittance advice', 'payment receipt',
  'quote', 'quotation', 'draft', 'invoice draft', 'tax invoice / bill',
  'vendor bill / tax invoice', 'bill / tax invoice'
]);

/**
 * Validates whether an extracted string is a plausible counterparty candidate.
 * Rejects document headings, generic document types, separators, and ambiguous tokens.
 * 
 * @param {string} cand 
 * @returns {string|null} Cleaned counterparty string or null if invalid/ambiguous
 */
function cleanAndValidateCounterparty(cand) {
  if (!cand || typeof cand !== 'string') return null;
  const trimmed = cand.trim().replace(/^[:\s\-–—/]+/, '').replace(/[:\s\-–—/]+$/, '');
  if (trimmed.length < 2 || trimmed.length > 120) return null;

  // Pure punctuation or non-alphanumeric check
  if (!/[A-Za-z0-9]/.test(trimmed)) return null;

  const lower = trimmed.toLowerCase();

  // Exact heading match
  if (DOCUMENT_HEADING_KEYWORDS.has(lower)) return null;

  // Check composite headings with slashes or separators: e.g. "BILL / TAX INVOICE", "VENDOR BILL / TAX INVOICE"
  const parts = lower.split(/[/\\|\-–—]+/).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1 && parts.every(p => DOCUMENT_HEADING_KEYWORDS.has(p) || /^(vendor|customer|bill|invoice|tax|receipt|statement)$/.test(p))) {
    return null;
  }

  // Token-based check: if all words in the candidate are generic document heading tokens
  const tokens = lower.split(/\s+/).filter(t => t.length > 0 && !/^[/\\|\-–—:]+$/.test(t));
  if (tokens.length > 0 && tokens.every(t => /^(vendor|customer|bill|bills|tax|invoice|invoices|commercial|proforma|sales|receipt|receipts|statement|statements|estimate|estimates|credit|debit|note|notes|order|orders|slip|slips|notice|payment|quote|quotation|charge|and|or|of)$/.test(t))) {
    return null;
  }

  return trimmed;
}

/**
 * Extracts key invoice fields from raw text using deterministic regex patterns.
 * Adheres strictly to accounting safety:
 * - Does not guess or hallucinate missing fields
 * - Does not fallback subtotal to total
 * - Does not treat generic 'Amount:' as invoice total
 * - Does not default ambiguous documents to PAYABLE
 * - Preserves extraction confidence and provenance
 * 
 * @param {string} text Extracted PDF text
 * @param {object} [options]
 * @param {string[]} [options.companyNames=['CabinAI', 'Cabin AI']] Known company names for AP/AR classification
 * @returns {object} Extracted fields with confidence ratings
 */
function extractFieldsFromText(text, options = {}) {
  const companyNames = options.companyNames || ['CabinAI', 'Cabin AI'];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // 1. Invoice Number Extraction
  let invoiceNumber = null;
  let invoiceNumberConfidence = 'none';

  // Strict patterns requiring explicit invoice/bill identifier prefixes
  const invNumPatterns = [
    { regex: /(?:Invoice|Bill)\s*(?:#|Number|No\.?|Num)\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9\-_/]*\d[A-Za-z0-9\-_/]*)/i, conf: 'high' },
    { regex: /(?:Invoice|Bill)\s*(?:#|Number|No\.?|Num)\s*[:#]\s*([A-Za-z0-9\-_]+)/i, conf: 'high' },
    { regex: /\b(?:INV|BILL)[-_]\d{3,}[A-Za-z0-9-_]*/i, conf: 'high' },
    { regex: /Invoice\s*ID[:\s]+([A-Za-z0-9\-_/]+)/i, conf: 'medium' }
  ];

  for (const { regex, conf } of invNumPatterns) {
    const match = text.match(regex);
    if (match) {
      const candidate = (match[1] || match[0]).trim();
      // Ensure candidate is not a lone symbol, punctuation, or generic dictionary word
      if (candidate.length > 2 && candidate !== '/' && !/^(and|or|of|tax|invoice|bill|receipt|statement)$/i.test(candidate)) {
        invoiceNumber = candidate;
        invoiceNumberConfidence = conf;
        break;
      }
    }
  }

  // 2. Issue Date Extraction
  let issueDate = null;
  let issueDateConfidence = 'none';

  const issueDatePatterns = [
    { regex: /(?:Invoice\s*Date|Issue\s*Date|Date\s*of\s*Issue|Billing\s*Date|Billed\s*On)[:\s]+([A-Za-z0-9\s,/-]+?)(?=\s{2,}|\n|Due|Total|$)/i, conf: 'high' },
    { regex: /\bDate[:\s]+([A-Za-z0-9\s,/-]+?)(?=\s{2,}|\n|Due|Total|$)/i, conf: 'medium' }
  ];

  for (const { regex, conf } of issueDatePatterns) {
    const match = text.match(regex);
    if (match) {
      const parsed = normalizeDate(match[1]);
      if (parsed) {
        issueDate = parsed;
        issueDateConfidence = conf;
        break;
      }
    }
  }

  // 3. Due Date Extraction
  let dueDate = null;
  let dueDateConfidence = 'none';

  const dueDatePatterns = [
    { regex: /(?:Due\s*Date|Payment\s*Due|Pay\s*By)[:\s]+([A-Za-z0-9\s,/-]+?)(?=\s{2,}|\n|Total|Balance|$)/i, conf: 'high' }
  ];

  for (const { regex, conf } of dueDatePatterns) {
    const match = text.match(regex);
    if (match) {
      const parsed = normalizeDate(match[1]);
      if (parsed) {
        dueDate = parsed;
        dueDateConfidence = conf;
        break;
      }
    }
  }

  // 4. Currency Detection
  let currency = 'USD';
  if (text.includes('€') || /\bEUR\b/i.test(text)) {
    currency = 'EUR';
  } else if (text.includes('£') || /\bGBP\b/i.test(text)) {
    currency = 'GBP';
  } else if (/\bCAD\b/i.test(text)) {
    currency = 'CAD';
  } else if (text.includes('$') || /\bUSD\b/i.test(text)) {
    currency = 'USD';
  }

  // 5. Total, Subtotal, and Tax Extraction
  // Accounting Safety Rule: Never use generic 'Amount:' or 'Subtotal' as invoice total.
  // Prefer explicit, conclusive final total labels.
  let total = null;
  let totalConfidence = 'none';
  let subtotal = null;
  let tax = null;
  const unclassifiedAmounts = [];

  // High-confidence explicit final total patterns
  const explicitTotalPatterns = [
    /(?:Total\s*Due|Amount\s*Due|Grand\s*Total|Balance\s*Due|Invoice\s*Total|Net\s*Payable)[:\s]+([$€£]?\s*[\d,]+\.\d{2})/i,
    /(?:^|\n|\r)\s*Total\s*[:$€£]\s*([$€£]?\s*[\d,]+\.\d{2})/i,
    /\bTotal[:\s]+([$€£]?\s*[\d,]+\.\d{2})/i
  ];

  for (const pat of explicitTotalPatterns) {
    const match = text.match(pat);
    if (match) {
      const val = parseAmount(match[1]);
      if (val !== null) {
        total = Math.abs(val);
        totalConfidence = 'high';
        break;
      }
    }
  }

  // Subtotal extraction
  const subtotalMatch = text.match(/(?:Subtotal|Sub\s*Total|Net\s*Amount)[:\s]+([$€£]?\s*[\d,]+\.\d{2})/i);
  if (subtotalMatch) {
    const val = parseAmount(subtotalMatch[1]);
    if (val !== null) {
      subtotal = Math.abs(val);
    }
  }

  // Tax extraction
  const taxMatch = text.match(/(?:Tax|VAT|GST|Sales\s*Tax)[:\s]+([$€£]?\s*[\d,]+\.\d{2})/i);
  if (taxMatch) {
    const val = parseAmount(taxMatch[1]);
    if (val !== null) {
      tax = Math.abs(val);
    }
  }

  // Collect generic "Amount: $..." for audit metadata (DO NOT treat as total)
  const amountMatches = text.matchAll(/\bAmount[:\s]+([$€£]?\s*[\d,]+\.\d{2})/gi);
  for (const m of amountMatches) {
    const parsedAmt = parseAmount(m[1]);
    if (parsedAmt !== null) {
      unclassifiedAmounts.push(Math.abs(parsedAmt));
    }
  }

  // 6. Vendor & Customer Extraction
  let vendorName = null;
  let customerName = null;

  // Strict labeled patterns requiring explicit colon delimiter to avoid matching headings like "VENDOR BILL"
  const vendorMatch = text.match(/(?:From|Vendor|Supplier|Issued\s+By|Billed\s+By|Seller)\s*:\s*([^\n\r,;]+)/i);
  if (vendorMatch) {
    vendorName = cleanAndValidateCounterparty(vendorMatch[1]);
  }

  const customerMatch = text.match(/(?:Bill\s+To|Sold\s+To|Customer|Client|Recipient)\s*:\s*([^\n\r,;]+)/i);
  if (customerMatch) {
    customerName = cleanAndValidateCounterparty(customerMatch[1]);
  }

  // 7. AP (payable) vs AR (receivable) vs UNKNOWN determination
  // Accounting Safety Rule: Never default ambiguous documents to PAYABLE.
  // When evidence is insufficient, classify strictly as UNKNOWN with 'none' confidence.
  let documentType = DocumentType.UNKNOWN;
  let typeConfidence = 'none';

  const isCompanyRecipient = customerName && companyNames.some(cn => customerName.toLowerCase().includes(cn.toLowerCase()));
  const isCompanyIssuer = vendorName && companyNames.some(cn => vendorName.toLowerCase().includes(cn.toLowerCase()));

  if (isCompanyRecipient && !isCompanyIssuer) {
    // Our business is the recipient -> Accounts Payable (we owe vendor)
    documentType = DocumentType.PAYABLE;
    typeConfidence = 'high';
  } else if (isCompanyIssuer && !isCompanyRecipient) {
    // Our business is the issuer -> Accounts Receivable (customer owes us)
    documentType = DocumentType.RECEIVABLE;
    typeConfidence = 'high';
  } else if (/\bAccounts\s*Receivable\b|\bAR\s*Invoice\b|\bSales\s*Invoice\b|\bCustomer\s*Invoice\b/i.test(text)) {
    documentType = DocumentType.RECEIVABLE;
    typeConfidence = 'high';
  } else if (/\bAccounts\s*Payable\b|\bVendor\s*Bill\b|\bAP\s*Bill\b|\bBill\s*From\b/i.test(text)) {
    documentType = DocumentType.PAYABLE;
    typeConfidence = 'high';
  } else {
    // Insufficient evidence: leave as UNKNOWN
    documentType = DocumentType.UNKNOWN;
    typeConfidence = 'none';
  }

  // 8. Counterparty Determination
  // Accounting Safety Rule: Never create synthetic "Unknown Vendor" or "Unknown Customer".
  // Preserve null if counterparty is not clearly known.
  let counterpartyName = null;
  let counterpartyConfidence = 'none';

  if (documentType === DocumentType.PAYABLE) {
    if (vendorName) {
      counterpartyName = vendorName;
      counterpartyConfidence = 'high';
    }
  } else if (documentType === DocumentType.RECEIVABLE) {
    if (customerName) {
      counterpartyName = customerName;
      counterpartyConfidence = 'high';
    }
  }

  return {
    invoiceNumber,
    invoiceNumberConfidence,
    issueDate,
    issueDateConfidence,
    dueDate,
    dueDateConfidence,
    currency,
    subtotal,
    tax,
    total, // null if no explicit total label matched!
    totalConfidence,
    unclassifiedAmounts,
    vendorName,
    customerName,
    counterpartyName, // null if unknown!
    counterpartyConfidence,
    documentType, // UNKNOWN if ambiguous!
    typeConfidence,
    rawText: text
  };
}

/**
 * Parses PDF buffer into normalized Invoice record.
 * 
 * @param {Buffer|Uint8Array} pdfBuffer 
 * @param {object} [options]
 * @param {string} [options.sourceFile='invoice.pdf']
 * @param {string[]} [options.companyNames]
 * @returns {Promise<object>} Normalized invoice record
 */
async function parseInvoicePdf(pdfBuffer, options = {}) {
  const sourceFile = options.sourceFile || 'invoice.pdf';
  const pdfData = await extractPdfText(pdfBuffer);
  const text = pdfData.text || '';

  const extracted = extractFieldsFromText(text, options);

  // Compute a content hash for unique source_record_id
  const contentHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex').slice(0, 16);
  const sourceRecordId = extracted.invoiceNumber
    ? `${extracted.invoiceNumber}_${contentHash.slice(0, 6)}`
    : `pdf_${contentHash}`;

  // Accounting Safety: Do NOT fallback subtotal to total, and do NOT fake 0.0
  const total = extracted.total;

  return {
    invoice_number: extracted.invoiceNumber,
    document_type: extracted.documentType,
    counterparty_name: extracted.counterpartyName,
    issue_date: extracted.issueDate,
    due_date: extracted.dueDate,
    currency: extracted.currency,
    subtotal: extracted.subtotal,
    tax: extracted.tax,
    total,
    source: SourceType.INVOICE_PDF,
    source_file: sourceFile,
    source_record_id: sourceRecordId,
    status: 'unpaid',
    raw_data: {
      raw_text: extracted.rawText.slice(0, 4000),
      extraction_metadata: {
        confidences: {
          document_type: extracted.typeConfidence,
          total: extracted.totalConfidence,
          invoice_number: extracted.invoiceNumberConfidence,
          counterparty: extracted.counterpartyConfidence,
          issue_date: extracted.issueDateConfidence,
          due_date: extracted.dueDateConfidence
        },
        raw_entities: {
          vendor_candidate: extracted.vendorName,
          customer_candidate: extracted.customerName,
          unclassified_amounts: extracted.unclassifiedAmounts
        },
        page_count: pdfData.numPages || 1,
        source_file: sourceFile
      }
    }
  };
}

module.exports = {
  parseInvoicePdf,
  extractFieldsFromText,
  extractPdfText,
  cleanAndValidateCounterparty,
  DOCUMENT_HEADING_KEYWORDS
};
