const { fromMinorUnits, parseAmount, normalizeCurrency } = require('../normalizers/amountNormalizer');
const { normalizeTimestamp } = require('../normalizers/dateNormalizer');
const { ProviderType, SourceType } = require('../models/types');

/**
 * Normalizes a single Dodo Payments JSON object into a canonical PaymentProviderRecord.
 * @param {object} item Raw Dodo Payments object
 * @returns {object|null} Normalized record
 */
function normalizeDodoRecord(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  // Handle webhook event envelope
  if (item.data && typeof item.data === 'object' && (item.type || item.event_type)) {
    const eventType = item.type || item.event_type;
    const inner = normalizeDodoRecord(item.data);
    if (inner) {
      inner.record_type = eventType;
      inner.raw_data.event_type = eventType;
      inner.raw_data.event_id = item.id || item.event_id;
      return inner;
    }
  }

  const providerRecordId = item.payment_id || item.id || item.transaction_id || item.payout_id || item.refund_id;
  if (!providerRecordId) {
    return null;
  }

  // Record/Event type
  const recordType = item.type || item.event_type || item.object || (
    item.payout_id ? 'payout' :
    item.refund_id ? 'refund' :
    item.dispute_id ? 'dispute' : 'payment'
  );

  const currency = normalizeCurrency(item.currency || 'USD');

  // Amount extraction (handle both cents or decimal representations)
  const rawAmt = item.total_amount !== undefined ? item.total_amount :
                 item.amount !== undefined ? item.amount : 0;
  // If amount is an integer >= 100, Dodo typically uses cents/minor units
  let amount = 0;
  if (typeof rawAmt === 'number' && Number.isInteger(rawAmt) && rawAmt >= 100) {
    amount = fromMinorUnits(rawAmt);
  } else {
    amount = parseAmount(rawAmt) || 0;
  }

  // Fee extraction
  let fee = 0;
  const rawFee = item.fee !== undefined ? item.fee :
                 item.payment_fee !== undefined ? item.payment_fee :
                 item.service_fee !== undefined ? item.service_fee : 0;
  if (typeof rawFee === 'number' && Number.isInteger(rawFee) && rawFee >= 100) {
    fee = fromMinorUnits(rawFee);
  } else {
    fee = parseAmount(rawFee) || 0;
  }

  // Net amount extraction
  let netAmount = amount - fee;
  if (item.settlement_amount !== undefined || item.net_amount !== undefined) {
    const rawNet = item.settlement_amount !== undefined ? item.settlement_amount : item.net_amount;
    if (typeof rawNet === 'number' && Number.isInteger(rawNet) && rawNet >= 100) {
      netAmount = fromMinorUnits(rawNet);
    } else {
      netAmount = parseAmount(rawNet) || (amount - fee);
    }
  }

  // Timestamp
  const rawTime = item.created_at || item.timestamp || item.created || item.date || Date.now();
  const transactionTime = normalizeTimestamp(rawTime) || new Date().toISOString();

  // Customer information
  let customerId = null;
  let customerName = null;
  let customerEmail = null;

  if (item.customer && typeof item.customer === 'object') {
    customerId = item.customer.customer_id || item.customer.id || null;
    customerName = item.customer.name || null;
    customerEmail = item.customer.email || null;
  } else {
    customerId = item.customer_id || (typeof item.customer === 'string' ? item.customer : null);
    customerName = item.customer_name || null;
    customerEmail = item.customer_email || null;
  }

  // Related provider IDs
  const relatedIds = {};
  if (item.payment_id) relatedIds.payment_id = item.payment_id;
  if (item.subscription_id) relatedIds.subscription_id = item.subscription_id;
  if (item.invoice_id) relatedIds.invoice_id = item.invoice_id;
  if (item.refund_id) relatedIds.refund_id = item.refund_id;
  if (item.payout_id) relatedIds.payout_id = item.payout_id;
  if (item.product_id) relatedIds.product_id = item.product_id;

  // Status
  const status = item.status || 'unknown';

  return {
    provider: ProviderType.DODO,
    record_type: recordType, // 'payment', 'refund', 'payout', 'dispute'
    provider_record_id: providerRecordId,
    amount,
    currency,
    fee,
    net_amount: netAmount,
    transaction_time: transactionTime,
    status,
    customer_id: customerId,
    customer_name: customerName,
    customer_email: customerEmail,
    related_provider_ids: relatedIds,
    source: SourceType.DODO_JSON,
    source_record_id: providerRecordId,
    raw_data: item
  };
}

/**
 * Parses Dodo Payments JSON file/string content into normalized records.
 * Supports single objects, arrays, and envelopes { payments: [...] } or { items: [...] }.
 * @param {string|object} content 
 * @returns {Array<object>} Normalized payment provider records
 */
function parseDodoJson(content) {
  let parsed = content;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error(`Failed to parse Dodo JSON: ${e.message}`);
    }
  }

  if (!parsed) return [];

  let items = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (Array.isArray(parsed.payments)) {
    items = parsed.payments;
  } else if (Array.isArray(parsed.data)) {
    items = parsed.data;
  } else if (Array.isArray(parsed.items)) {
    items = parsed.items;
  } else if (Array.isArray(parsed.payouts)) {
    items = parsed.payouts;
  } else {
    items = [parsed];
  }

  const results = [];
  for (const item of items) {
    const normalized = normalizeDodoRecord(item);
    if (normalized) {
      results.push(normalized);
    }
  }

  return results;
}

module.exports = {
  parseDodoJson,
  normalizeDodoRecord
};
