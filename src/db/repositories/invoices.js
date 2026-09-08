const crypto = require('crypto');

class InvoicesRepository {
  constructor(db) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO invoices (
        id, invoice_number, document_type, counterparty_id, counterparty_name,
        issue_date, due_date, currency, subtotal, tax, total,
        source, source_file, source_record_id, import_batch_id, status, raw_data
      ) VALUES (
        @id, @invoice_number, @document_type, @counterparty_id, @counterparty_name,
        @issue_date, @due_date, @currency, @subtotal, @tax, @total,
        @source, @source_file, @source_record_id, @import_batch_id, @status, @raw_data
      )
      ON CONFLICT(source, source_record_id) DO NOTHING
    `);

    this.findBySourceRecordStmt = db.prepare(`
      SELECT * FROM invoices WHERE source = ? AND source_record_id = ?
    `);

    this.findByIdStmt = db.prepare(`SELECT * FROM invoices WHERE id = ?`);
  }

  insert(inv) {
    const record = {
      id: inv.id || crypto.randomUUID(),
      invoice_number: inv.invoice_number || null,
      document_type: inv.document_type || 'unknown',
      counterparty_id: inv.counterparty_id || null,
      counterparty_name: inv.counterparty_name || null,
      issue_date: inv.issue_date || null,
      due_date: inv.due_date || null,
      currency: inv.currency || 'USD',
      subtotal: inv.subtotal !== undefined ? inv.subtotal : null,
      tax: inv.tax !== undefined ? inv.tax : null,
      total: (inv.total !== undefined && inv.total !== null) ? inv.total : null,
      source: inv.source || 'invoice_pdf',
      source_file: inv.source_file,
      source_record_id: inv.source_record_id,
      import_batch_id: inv.import_batch_id || null,
      status: inv.status || 'unpaid',
      raw_data: typeof inv.raw_data === 'string' ? inv.raw_data : JSON.stringify(inv.raw_data || {})
    };

    const info = this.insertStmt.run(record);
    if (info.changes > 0) {
      return { inserted: true, record: this.findById(record.id) };
    }

    const existing = this.findBySourceRecordStmt.get(record.source, record.source_record_id);
    return { inserted: false, record: existing };
  }

  insertBatch(invoices) {
    let insertedCount = 0;
    let skippedCount = 0;
    const records = [];

    const runBatch = this.db.transaction((invs) => {
      for (const inv of invs) {
        const result = this.insert(inv);
        if (result.inserted) {
          insertedCount++;
        } else {
          skippedCount++;
        }
        records.push(result.record);
      }
    });

    runBatch(invoices);

    return { insertedCount, skippedCount, records };
  }

  findById(id) {
    return this.findByIdStmt.get(id) || null;
  }

  findAll() {
    return this.db.prepare(`SELECT * FROM invoices ORDER BY issue_date DESC, created_at DESC`).all();
  }

  findByDocumentType(docType) {
    return this.db.prepare(`SELECT * FROM invoices WHERE document_type = ? ORDER BY issue_date DESC`).all(docType);
  }

  findByInvoiceNumber(invoiceNumber) {
    return this.db.prepare(`SELECT * FROM invoices WHERE invoice_number = ?`).all(invoiceNumber);
  }

  count() {
    return this.db.prepare(`SELECT COUNT(*) as count FROM invoices`).get().count;
  }
}

module.exports = InvoicesRepository;
