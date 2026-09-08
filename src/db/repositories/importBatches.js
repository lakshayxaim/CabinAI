const crypto = require('crypto');

class ImportBatchesRepository {
  constructor(db) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO import_batches (id, source_type, filename, file_hash, total_records, status, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.findByHashStmt = db.prepare(`
      SELECT * FROM import_batches WHERE file_hash = ? ORDER BY created_at DESC LIMIT 1
    `);
    this.findByIdStmt = db.prepare(`
      SELECT * FROM import_batches WHERE id = ?
    `);
    this.updateStmt = db.prepare(`
      UPDATE import_batches 
      SET total_records = ?, status = ?, metadata = ?
      WHERE id = ?
    `);
  }

  createBatch({ id = crypto.randomUUID(), sourceType, filename, fileHash, totalRecords = 0, status = 'completed', metadata = {} }) {
    const metaStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
    this.insertStmt.run(id, sourceType, filename, fileHash, totalRecords, status, metaStr);
    return this.findById(id);
  }

  findByHash(fileHash) {
    if (!fileHash) return null;
    return this.findByHashStmt.get(fileHash) || null;
  }

  findById(id) {
    return this.findByIdStmt.get(id) || null;
  }

  updateBatch(id, { totalRecords, status, metadata }) {
    const existing = this.findById(id);
    if (!existing) return null;
    const finalRecords = totalRecords !== undefined ? totalRecords : existing.total_records;
    const finalStatus = status !== undefined ? status : existing.status;
    const finalMeta = metadata !== undefined 
      ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata))
      : existing.metadata;
    this.updateStmt.run(finalRecords, finalStatus, finalMeta, id);
    return this.findById(id);
  }
}

module.exports = ImportBatchesRepository;
