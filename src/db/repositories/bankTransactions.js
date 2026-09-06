const crypto = require('crypto');

class BankTransactionsRepository {
  constructor(db) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO bank_transactions (
        id, account_id, transaction_date, value_date, amount, currency,
        direction, description, bank_reference, source, source_record_id,
        import_batch_id, raw_data
      ) VALUES (
        @id, @account_id, @transaction_date, @value_date, @amount, @currency,
        @direction, @description, @bank_reference, @source, @source_record_id,
        @import_batch_id, @raw_data
      )
      ON CONFLICT(source, source_record_id) DO NOTHING
    `);

    this.findBySourceRecordStmt = db.prepare(`
      SELECT * FROM bank_transactions WHERE source = ? AND source_record_id = ?
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM bank_transactions WHERE id = ?`);
  }

  /**
   * Inserts a single bank transaction idempotently.
   * If already exists, returns existing record with inserted: false.
   */
  insert(tx) {
    const record = {
      id: tx.id || crypto.randomUUID(),
      account_id: tx.account_id || 'default_account',
      transaction_date: tx.transaction_date,
      value_date: tx.value_date || null,
      amount: tx.amount,
      currency: tx.currency || 'USD',
      direction: tx.direction,
      description: tx.description,
      bank_reference: tx.bank_reference || null,
      source: tx.source || 'bank_csv',
      source_record_id: tx.source_record_id,
      import_batch_id: tx.import_batch_id || null,
      raw_data: typeof tx.raw_data === 'string' ? tx.raw_data : JSON.stringify(tx.raw_data || {})
    };

    const info = this.insertStmt.run(record);
    if (info.changes > 0) {
      return { inserted: true, record: this.findById(record.id) };
    }

    const existing = this.findBySourceRecordStmt.get(record.source, record.source_record_id);
    return { inserted: false, record: existing };
  }

  /**
   * Inserts an array of bank transactions idempotently within a transaction.
   * @param {Array} transactions 
   * @returns {{ insertedCount: number, skippedCount: number, records: Array }}
   */
  insertBatch(transactions) {
    let insertedCount = 0;
    let skippedCount = 0;
    const records = [];

    const runBatch = this.db.transaction((txs) => {
      for (const tx of txs) {
        const result = this.insert(tx);
        if (result.inserted) {
          insertedCount++;
        } else {
          skippedCount++;
        }
        records.push(result.record);
      }
    });

    runBatch(transactions);

    return { insertedCount, skippedCount, records };
  }

  findById(id) {
    return this.findByIdStmt.get(id) || null;
  }

  findAll() {
    return this.db.prepare(`SELECT * FROM bank_transactions ORDER BY transaction_date DESC, created_at DESC`).all();
  }

  findByDirection(direction) {
    return this.db.prepare(`SELECT * FROM bank_transactions WHERE direction = ? ORDER BY transaction_date DESC`).all(direction);
  }

  count() {
    return this.db.prepare(`SELECT COUNT(*) as count FROM bank_transactions`).get().count;
  }
}

module.exports = BankTransactionsRepository;
