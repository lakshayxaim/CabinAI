const crypto = require('crypto');

class CounterpartiesRepository {
  constructor(db) {
    this.db = db;
    this.findByNameStmt = db.prepare(`SELECT * FROM counterparties WHERE name = ? COLLATE NOCASE`);
    this.findByIdStmt = db.prepare(`SELECT * FROM counterparties WHERE id = ?`);
    this.insertStmt = db.prepare(`
      INSERT INTO counterparties (id, name, type, email, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.updateStmt = db.prepare(`
      UPDATE counterparties
      SET type = ?, email = COALESCE(?, email), metadata = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
  }

  findByName(name) {
    if (!name) return null;
    return this.findByNameStmt.get(name.trim()) || null;
  }

  findById(id) {
    return this.findByIdStmt.get(id) || null;
  }

  /**
   * Finds or creates a counterparty by name.
   * If exists, updates type if new type adds information (e.g. unknown -> vendor or vendor+customer -> both).
   */
  upsert({ name, type = 'unknown', email = null, metadata = {} }) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      return null;
    }
    const cleanName = name.trim();
    const existing = this.findByName(cleanName);

    if (existing) {
      let mergedType = existing.type;
      if (existing.type === 'unknown' && type !== 'unknown') {
        mergedType = type;
      } else if (
        (existing.type === 'vendor' && type === 'customer') ||
        (existing.type === 'customer' && type === 'vendor')
      ) {
        mergedType = 'both';
      }

      const existingMeta = existing.metadata ? JSON.parse(existing.metadata) : {};
      const newMeta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
      const mergedMeta = JSON.stringify({ ...existingMeta, ...newMeta });

      this.updateStmt.run(mergedType, email, mergedMeta, existing.id);
      return this.findById(existing.id);
    }

    const id = crypto.randomUUID();
    const metaStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
    this.insertStmt.run(id, cleanName, type, email, metaStr);
    return this.findById(id);
  }

  findAll() {
    return this.db.prepare(`SELECT * FROM counterparties ORDER BY name ASC`).all();
  }
}

module.exports = CounterpartiesRepository;
