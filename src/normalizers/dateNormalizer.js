/**
 * Deterministic date normalization utilities for financial records.
 * Outputs canonical YYYY-MM-DD or ISO 8601 timestamps.
 */

/**
 * Normalizes input date into canonical YYYY-MM-DD string.
 * @param {string|number|Date} input 
 * @returns {string|null} Canonical YYYY-MM-DD date or null if unparseable
 */
function normalizeDate(input) {
  if (input === null || input === undefined || input === '') {
    return null;
  }

  // Handle Date instance
  if (input instanceof Date && !isNaN(input.getTime())) {
    return input.toISOString().slice(0, 10);
  }

  // Handle Unix timestamp (number or numeric string)
  if (typeof input === 'number' || (typeof input === 'string' && /^\d{10,13}$/.test(input.trim()))) {
    const num = typeof input === 'number' ? input : Number(input.trim());
    // Unix epoch seconds vs milliseconds
    const ms = num < 10000000000 ? num * 1000 : num;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }

  if (typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim();

  // 1. ISO format: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // 2. Text month format: e.g. "15 Jan 2024", "Jan 15, 2024", "January 15 2024"
  const monthNames = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    january: '01', february: '02', march: '03', april: '04', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
  };

  const textMonthMatch1 = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (textMonthMatch1) {
    const [, monStr, dayStr, yearStr] = textMonthMatch1;
    const m = monthNames[monStr.toLowerCase()];
    if (m) {
      return `${yearStr}-${m}-${dayStr.padStart(2, '0')}`;
    }
  }

  const textMonthMatch2 = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (textMonthMatch2) {
    const [, dayStr, monStr, yearStr] = textMonthMatch2;
    const m = monthNames[monStr.toLowerCase()];
    if (m) {
      return `${yearStr}-${m}-${dayStr.padStart(2, '0')}`;
    }
  }

  // 3. Slash/Dash format: MM/DD/YYYY or DD/MM/YYYY
  // Heuristic: If first segment > 12, it must be DD/MM/YYYY.
  // Otherwise, default to standard US bank format MM/DD/YYYY unless specified.
  const slashMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (slashMatch) {
    let [, p1, p2, yr] = slashMatch;
    if (yr.length === 2) {
      const yrNum = parseInt(yr, 10);
      yr = yrNum >= 70 ? `19${yr}` : `20${yr}`;
    }
    const num1 = parseInt(p1, 10);
    const num2 = parseInt(p2, 10);

    let m, d;
    if (num1 > 12 && num2 <= 12) {
      // Must be DD/MM/YYYY
      d = p1.padStart(2, '0');
      m = p2.padStart(2, '0');
    } else {
      // Default to MM/DD/YYYY
      m = p1.padStart(2, '0');
      d = p2.padStart(2, '0');
    }
    return `${yr}-${m}-${d}`;
  }

  // Fallback to JS Date parsing
  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return null;
}

/**
 * Normalizes input date/time into canonical ISO 8601 timestamp string (UTC).
 * @param {string|number|Date} input 
 * @returns {string|null} Canonical ISO 8601 UTC timestamp or null
 */
function normalizeTimestamp(input) {
  if (input === null || input === undefined || input === '') {
    return null;
  }

  if (input instanceof Date && !isNaN(input.getTime())) {
    return input.toISOString();
  }

  if (typeof input === 'number' || (typeof input === 'string' && /^\d{10,13}$/.test(input.trim()))) {
    const num = typeof input === 'number' ? input : Number(input.trim());
    const ms = num < 10000000000 ? num * 1000 : num;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (typeof input === 'string') {
    const d = new Date(input.trim());
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
    // Try normalizeDate as fallback
    const dateStr = normalizeDate(input);
    if (dateStr) {
      return `${dateStr}T00:00:00.000Z`;
    }
  }

  return null;
}

module.exports = {
  normalizeDate,
  normalizeTimestamp
};
