const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DEFAULT_DB_PATH = process.env.CABINAI_DB_PATH || path.join(__dirname, '../../data/cabinai.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * Initializes and returns a SQLite database instance.
 * Automatically runs schema migration if tables do not exist.
 * @param {string} [dbPath] Path to SQLite database file or ':memory:'
 * @returns {Database.Database}
 */
function initDatabase(dbPath = DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);

  // WAL mode for better concurrency and durability
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');

  // Apply schema
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schemaSql);

  return db;
}

module.exports = {
  initDatabase,
  DEFAULT_DB_PATH
};
