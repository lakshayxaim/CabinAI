const { fromMinorUnits, normalizeCurrency } = require('../normalizers/amountNormalizer');
const { normalizeTimestamp } = require('../normalizers/dateNormalizer');
const { ProviderType, SourceType } = require('../models/types');

/**
 * Normalizes a single Stripe JSON object into a canonical PaymentProviderRecord.
 * @param {object} item Raw Stripe object
 * @returns {object|null} Normalized record
 */
function normalizeStripeRecord(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  // If item is a webhook event: unwrap data.object
  if (item.object === 'event' && item.data && item.data.object) {
    const eventType = item.type;
    const inner = normalizeStripeRecord(item.data.object);
    if (inner) {
      inner.raw_data.event_type = eventType;
      inner.raw_data.event_id = item.id;
      return inner;
    }
  }

  const objectType = item.object || item.type || 'payment';
  const providerRecordId = item.id;
  if (!providerRecordId) {
    return null;
  }

  // Amounts in Stripe are typically in cents (minor currency units)
  const currency = normalizeCurrency(item.currency || 'USD');
  const amount = fromMinorUnits(item.amount !== undefined ? item.amount : 0);

  // Fee and net amount calculation
  let fee = 0;
  let netAmount = amount;

  if (item.fee !== undefined) {
    fee = fromMinorUnits(item.fee);
    netAmount = amount - fee;
  } else if (item.balance_transaction && typeof item.balance_transaction === 'object') {
    // Nested balance_transaction object
    fee = fromMinorUnits(item.balance_transaction.fee || 0);
    netAmount = fromMinorUnits(item.balance_transaction.net !== undefined ? item.balance_transaction.net : item.amount - (item.balance_transaction.fee || 0));
  } else if (item.net !== undefined) {
    netAmount = fromMinorUnits(item.net);
    fee = Math.max(0, amount - netAmount);
  }

  // Transaction timestamp
  const rawTime = item.created || item.arrival_date || item.date || Date.now();
  const transactionTime = normalizeTimestamp(rawTime) || new Date().toISOString();

  // Customer information
  let customerId = null;
  let customerName = null;
  let customerEmail = null;

  if (item.customer) {
    if (typeof item.customer === 'string') {
      customerId = item.customer;
    } else if (typeof item.customer === 'object') {
      customerId = item.customer.id || null;
      customerName = item.customer.name || null;
      customerEmail = item.customer.email || null;
    }
  }

  if (item.billing_details) {
    customerName = customerName || item.billing_details.name || null;
    customerEmail = customerEmail || item.billing_details.email || null;
  } else if (item.customer_details) {
    customerName = customerName || item.customer_details.name || null;
    customerEmail = customerEmail || item.customer_details.email || null;
  }
  if (item.customer_email) {
    customerEmail = customerEmail || item.customer_email;
  }

  // Related provider IDs (e.g. charge, payout, invoice, balance_transaction)
  const relatedIds = {};
  if (item.charge && typeof item.charge === 'string') relatedIds.charge_id = item.charge;
  if (item.latest_charge && typeof item.latest_charge === 'string') relatedIds.charge_id = item.latest_charge;
  if (item.payout && typeof item.payout === 'string') relatedIds.payout_id = item.payout;
  if (item.invoice && typeof item.invoice === 'string') relatedIds.invoice_id = item.invoice;
  if (item.payment_intent && typeof item.payment_intent === 'string') relatedIds.payment_intent_id = item.payment_intent;
  if (item.source && typeof item.source === 'string' && item.source.startsWith('ch_')) relatedIds.charge_id = item.source;
  if (item.balance_transaction) {
    relatedIds.balance_transaction_id = typeof item.balance_transaction === 'string'
      ? item.balance_transaction
      : item.balance_transaction.id;
  }

  // Status
  const status = item.status || (item.paid ? 'succeeded' : 'unknown');

  return {
    provider: ProviderType.STRIPE,
    record_type: objectType, // 'charge', 'payment_intent', 'payout', 'refund', 'balance_transaction'
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
    source: SourceType.STRIPE_JSON,
    source_record_id: providerRecordId,
    raw_data: item
  };
}

/**
 * Parses Stripe JSON file/string content into normalized records.
 * Supports single objects, arrays, and Stripe list envelopes { object: 'list', data: [...] }.
 * @param {string|object} content 
 * @returns {Array<object>} Normalized payment provider records
 */
function parseStripeJson(content) {
  let parsed = content;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error(`Failed to parse Stripe JSON: ${e.message}`);
    }
  }

  if (!parsed) return [];

  let items = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed.object === 'list' && Array.isArray(parsed.data)) {
    items = parsed.data;
  } else if (Array.isArray(parsed.charges)) {
    items = parsed.charges;
  } else if (Array.isArray(parsed.payouts)) {
    items = parsed.payouts;
  } else if (Array.isArray(parsed.items)) {
    items = parsed.items;
  } else {
    items = [parsed];
  }

  const results = [];
  for (const item of items) {
    const normalized = normalizeStripeRecord(item);
    if (normalized) {
      results.push(normalized);
    }
  }

  return results;
}

module.exports = {
  parseStripeJson,
  normalizeStripeRecord
};
