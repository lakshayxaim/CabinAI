const { parse } = require('csv-parse/sync');
const crypto = require('crypto');
const { normalizeDate } = require('../normalizers/dateNormalizer');
const { parseAmount, normalizeCurrency } = require('../normalizers/amountNormalizer');
const { Direction, SourceType } = require('../models/types');

/**
 * Detects column mapping from header row.
 * @param {Array<string>} headers 
 * @returns {object} Column index map
 */
function detectColumns(headers) {
  const cleanHeaders = headers.map(h => (h || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''));

  const findIdx = (patterns) => {
    for (const pat of patterns) {
      const idx = cleanHeaders.findIndex(h => h.includes(pat));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  return {
    date: findIdx(['transactiondate', 'postingdate', 'bookingdate', 'transdate', 'date']),
    valueDate: findIdx(['valuedate', 'effectivedate']),
    description: findIdx(['description', 'details', 'narrative', 'memo', 'transactiondescription', 'payee', 'merchant', 'name']),
    reference: findIdx(['reference', 'refno', 'referencenumber', 'transactionid', 'txnid', 'checknum', 'chequeno', 'fitid']),
    amount: findIdx(['amount', 'transamount', 'total']),
    debit: findIdx(['debit', 'withdrawal', 'moneyout', 'outflow', 'paidout', 'debitamount']),
    credit: findIdx(['credit', 'deposit', 'moneyin', 'inflow', 'paidin', 'creditamount']),
    type: findIdx(['type', 'transtype', 'direction', 'drcr', 'crdr']),
    currency: findIdx(['currency', 'curr', 'ccy']),
    balance: findIdx(['balance', 'runningbalance'])
  };
}

/**
 * Parses Bank CSV content or buffer into normalized BankTransaction objects.
 * 
 * @param {string|Buffer} csvContent 
 * @param {object} [options] 
 * @param {string} [options.sourceFile='bank_statement.csv']
 * @param {string} [options.defaultAccountId='default_account']
 * @param {string} [options.defaultCurrency='USD']
 * @returns {Array<object>} Array of normalized bank transaction records
 */
function parseBankCsv(csvContent, options = {}) {
  const sourceFile = options.sourceFile || 'bank_statement.csv';
  const defaultAccountId = options.defaultAccountId || 'default_account';
  const defaultCurrency = options.defaultCurrency || 'USD';

  const rows = parse(csvContent, {
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true
  });

  if (!rows || rows.length < 2) {
    return [];
  }

  // Find header row: scan first few rows for date/amount/description keywords
  let headerRowIndex = 0;
  let cols = null;

  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const candidateCols = detectColumns(rows[i]);
    if (candidateCols.date !== -1 && (candidateCols.amount !== -1 || candidateCols.debit !== -1 || candidateCols.credit !== -1)) {
      headerRowIndex = i;
      cols = candidateCols;
      break;
    }
  }

  if (!cols) {
    // Fallback: assume first row is header
    cols = detectColumns(rows[0]);
  }

  const rawHeaders = rows[headerRowIndex];
  const dataRows = rows.slice(headerRowIndex + 1);
  const transactions = [];

  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
    const row = dataRows[rowIndex];
    if (!row || row.length === 0 || row.every(cell => !cell || !cell.trim())) {
      continue;
    }

    // 1. Transaction Date
    const rawDate = cols.date !== -1 ? row[cols.date] : null;
    const txDate = normalizeDate(rawDate);
    if (!txDate) {
      // Row lacks a valid transaction date; skip non-transaction/footer rows
      continue;
    }

    // 2. Value Date
    const rawValueDate = cols.valueDate !== -1 ? row[cols.valueDate] : null;
    const valDate = normalizeDate(rawValueDate);

    // 3. Description
    const description = cols.description !== -1 && row[cols.description]
      ? row[cols.description].trim()
      : 'Unspecified Bank Transaction';

    // 4. Bank Reference
    const bankRef = cols.reference !== -1 && row[cols.reference]
      ? row[cols.reference].trim()
      : null;

    // 5. Currency
    let currency = defaultCurrency;
    if (cols.currency !== -1 && row[cols.currency]) {
      currency = normalizeCurrency(row[cols.currency]);
    }

    // 6. Amount & Direction determination
    let amount = 0;
    let direction = Direction.OUTFLOW;

    if (cols.debit !== -1 && cols.credit !== -1) {
      // Two-column format: Debit and Credit
      const debitVal = parseAmount(row[cols.debit]);
      const creditVal = parseAmount(row[cols.credit]);

      if (creditVal !== null && creditVal > 0) {
        amount = creditVal;
        direction = Direction.INFLOW;
      } else if (debitVal !== null && debitVal > 0) {
        amount = debitVal;
        direction = Direction.OUTFLOW;
      } else if (debitVal !== null && debitVal < 0) {
        // Negative in debit is sometimes credit/reversal
        amount = Math.abs(debitVal);
        direction = Direction.INFLOW;
      } else {
        // Both zero or empty, check single amount or skip
        const singleAmt = cols.amount !== -1 ? parseAmount(row[cols.amount]) : 0;
        amount = Math.abs(singleAmt || 0);
        direction = (singleAmt && singleAmt > 0) ? Direction.INFLOW : Direction.OUTFLOW;
      }
    } else if (cols.amount !== -1) {
      // Single amount column
      const rawAmt = row[cols.amount];
      const parsed = parseAmount(rawAmt);
      if (parsed === null) {
        continue;
      }

      // Check type column if present
      const typeVal = cols.type !== -1 && row[cols.type] ? row[cols.type].trim().toUpperCase() : '';
      if (typeVal === 'CR' || typeVal === 'CREDIT' || typeVal === 'DEPOSIT' || typeVal === 'INFLOW') {
        direction = Direction.INFLOW;
        amount = Math.abs(parsed);
      } else if (typeVal === 'DR' || typeVal === 'DEBIT' || typeVal === 'WITHDRAWAL' || typeVal === 'PAYMENT' || typeVal === 'OUTFLOW') {
        direction = Direction.OUTFLOW;
        amount = Math.abs(parsed);
      } else {
        // Based on sign: positive = credit/inflow, negative = debit/outflow
        if (parsed >= 0) {
          direction = Direction.INFLOW;
          amount = parsed;
        } else {
          direction = Direction.OUTFLOW;
          amount = Math.abs(parsed);
        }
      }
    } else {
      continue;
    }

    // Map row to raw object for preservation
    const rawObj = {};
    for (let c = 0; c < row.length; c++) {
      const headerName = rawHeaders[c] || `col_${c}`;
      rawObj[headerName] = row[c];
    }

    // Deterministic source_record_id:
    // If bank reference is available and looks like a unique transaction id, prefix it.
    // Otherwise, generate deterministic hash of row data to prevent duplicate imports.
    const rowFingerprint = `${sourceFile}_row_${rowIndex}_${txDate}_${direction}_${amount}_${description}_${bankRef || ''}`;
    const hash = crypto.createHash('sha256').update(rowFingerprint).digest('hex').slice(0, 16);
    const sourceRecordId = bankRef && bankRef.length >= 6 && !bankRef.startsWith('CHK')
      ? `${bankRef}_${hash.slice(0, 6)}`
      : `row_${rowIndex + 1}_${hash}`;

    transactions.push({
      account_id: defaultAccountId,
      transaction_date: txDate,
      value_date: valDate,
      amount,
      currency,
      direction,
      description,
      bank_reference: bankRef,
      source: SourceType.BANK_CSV,
      source_record_id: sourceRecordId,
      raw_data: rawObj
    });
  }

  return transactions;
}

module.exports = {
  parseBankCsv,
  detectColumns
};
