const crypto = require('crypto');

class PaymentProviderRecordsRepository {
  constructor(db) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO payment_provider_records (
        id, provider, record_type, provider_record_id, amount, currency,
        fee, net_amount, transaction_time, status, customer_id, customer_name,
        customer_email, related_provider_ids, source, source_record_id,
        import_batch_id, raw_data
      ) VALUES (
        @id, @provider, @record_type, @provider_record_id, @amount, @currency,
        @fee, @net_amount, @transaction_time, @status, @customer_id, @customer_name,
        @customer_email, @related_provider_ids, @source, @source_record_id,
        @import_batch_id, @raw_data
      )
      ON CONFLICT(provider, provider_record_id) DO NOTHING
    `);

    this.findByProviderRecordIdStmt = db.prepare(`
      SELECT * FROM payment_provider_records WHERE provider = ? AND provider_record_id = ?
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM payment_provider_records WHERE id = ?`);
  }

  insert(rec) {
    const record = {
      id: rec.id || crypto.randomUUID(),
      provider: rec.provider, // 'stripe' or 'dodo'
      record_type: rec.record_type, // 'payment', 'payout', 'refund', etc.
      provider_record_id: rec.provider_record_id,
      amount: rec.amount,
      currency: rec.currency || 'USD',
      fee: rec.fee !== undefined && rec.fee !== null ? rec.fee : 0.0,
      net_amount: rec.net_amount !== undefined && rec.net_amount !== null ? rec.net_amount : rec.amount - (rec.fee || 0),
      transaction_time: rec.transaction_time,
      status: rec.status || 'unknown',
      customer_id: rec.customer_id || null,
      customer_name: rec.customer_name || null,
      customer_email: rec.customer_email || null,
      related_provider_ids: typeof rec.related_provider_ids === 'string'
        ? rec.related_provider_ids
        : JSON.stringify(rec.related_provider_ids || {}),
      source: rec.source || `${rec.provider}_json`,
      source_record_id: rec.source_record_id || rec.provider_record_id,
      import_batch_id: rec.import_batch_id || null,
      raw_data: typeof rec.raw_data === 'string' ? rec.raw_data : JSON.stringify(rec.raw_data || {})
    };

    const info = this.insertStmt.run(record);
    if (info.changes > 0) {
      return { inserted: true, record: this.findById(record.id) };
    }

    const existing = this.findByProviderRecordIdStmt.get(record.provider, record.provider_record_id);
    return { inserted: false, record: existing };
  }

  insertBatch(records) {
    let insertedCount = 0;
    let skippedCount = 0;
    const insertedRecords = [];

    const runBatch = this.db.transaction((recs) => {
      for (const rec of recs) {
        const result = this.insert(rec);
        if (result.inserted) {
          insertedCount++;
        } else {
          skippedCount++;
        }
        insertedRecords.push(result.record);
      }
    });

    runBatch(records);

    return { insertedCount, skippedCount, records: insertedRecords };
  }

  findById(id) {
    return this.findByIdStmt.get(id) || null;
  }

  findByProviderRecordId(provider, providerRecordId) {
    return this.findByProviderRecordIdStmt.get(provider, providerRecordId) || null;
  }

  findAll() {
    return this.db.prepare(`SELECT * FROM payment_provider_records ORDER BY transaction_time DESC, created_at DESC`).all();
  }

  findByProvider(provider) {
    return this.db.prepare(`SELECT * FROM payment_provider_records WHERE provider = ? ORDER BY transaction_time DESC`).all(provider);
  }

  findByRecordType(recordType) {
    return this.db.prepare(`SELECT * FROM payment_provider_records WHERE record_type = ? ORDER BY transaction_time DESC`).all(recordType);
  }

  count() {
    return this.db.prepare(`SELECT COUNT(*) as count FROM payment_provider_records`).get().count;
  }
}

module.exports = PaymentProviderRecordsRepository;
