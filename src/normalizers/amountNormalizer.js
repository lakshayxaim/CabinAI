/**
 * Deterministic amount normalization utilities for financial records.
 * Accurately parses accounting notations, currency symbols, thousands separators,
 * and minor-unit conversions (e.g. cents -> dollars).
 */

/**
 * Parses financial amount string or number to a clean float.
 * Handles accounting negatives: (100.00) -> -100.00
 * Handles currency symbols: $, €, £, ¥, ₹
 * Handles commas: 1,234.56 -> 1234.56
 * @param {string|number} val 
 * @returns {number|null} Clean float or null if invalid
 */
function parseAmount(val) {
  if (val === null || val === undefined || val === '') {
    return null;
  }

  if (typeof val === 'number') {
    return isNaN(val) ? null : Math.round(val * 100) / 100;
  }

  if (typeof val !== 'string') {
    return null;
  }

  let str = val.trim();
  if (!str) return null;

  let isNegative = false;

  // Accounting parenthesis notation: (123.45)
  if (/^\(.*\)$/.test(str)) {
    isNegative = true;
    str = str.slice(1, -1).trim();
  }

  // Trailing CR / DR notation (DR is debit, CR is credit)
  if (/\bDR\b/i.test(str)) {
    str = str.replace(/\bDR\b/gi, '').trim();
    // In bank statements, DR is typically an outflow/debit
  }
  if (/\bCR\b/i.test(str)) {
    str = str.replace(/\bCR\b/gi, '').trim();
  }

  // Check for leading or trailing minus sign
  if (str.startsWith('-')) {
    isNegative = !isNegative;
    str = str.substring(1).trim();
  } else if (str.endsWith('-')) {
    isNegative = !isNegative;
    str = str.slice(0, -1).trim();
  } else if (str.startsWith('+')) {
    str = str.substring(1).trim();
  }

  // Remove currency symbols, non-breaking spaces, and whitespace
  str = str.replace(/[$€£¥₹\s]/g, '');

  // Remove thousands separators (comma before period, or period before comma in EU format)
  // Check if comma is decimal separator (e.g. 1.234,56 or 1234,56)
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(str) || /^\d+,\d{1,2}$/.test(str)) {
    // European style: . is thousands, , is decimal
    str = str.replace(/\./g, '').replace(',', '.');
  } else {
    // Standard style: , is thousands, . is decimal
    str = str.replace(/,/g, '');
  }

  const num = parseFloat(str);
  if (isNaN(num)) {
    return null;
  }

  const result = isNegative ? -Math.abs(num) : num;
  return Math.round(result * 100) / 100;
}

/**
 * Converts minor currency units (cents) to major currency units (e.g. dollars).
 * @param {number|string} minorUnits e.g. 2500 cents
 * @returns {number} e.g. 25.00
 */
function fromMinorUnits(minorUnits) {
  const num = typeof minorUnits === 'number' ? minorUnits : parseAmount(minorUnits);
  if (num === null || isNaN(num)) return 0;
  return Math.round(num) / 100;
}

/**
 * Normalizes ISO currency code (defaults to USD).
 * @param {string} curr 
 * @returns {string} 3-letter uppercase currency code
 */
function normalizeCurrency(curr) {
  if (!curr || typeof curr !== 'string') return 'USD';
  const trimmed = curr.trim().toUpperCase();
  if (trimmed.length === 3) return trimmed;
  // Symbol mappings
  if (trimmed === '$') return 'USD';
  if (trimmed === '€') return 'EUR';
  if (trimmed === '£') return 'GBP';
  if (trimmed === '¥') return 'JPY';
  if (trimmed === '₹') return 'INR';
  return 'USD';
}

module.exports = {
  parseAmount,
  fromMinorUnits,
  normalizeCurrency
};
