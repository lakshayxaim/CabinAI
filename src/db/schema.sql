-- CabinAI Financial Ingestion Schema (Session 1)
-- Stores normalized financial entities while maintaining strict separation of concerns.

PRAGMA foreign_keys = ON;

-- 1. Import Provenance Metadata
CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL CHECK (source_type IN ('bank_csv', 'invoice_pdf', 'stripe_json', 'dodo_json')),
    filename TEXT,
    file_hash TEXT,
    total_records INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('in_progress', 'completed', 'failed')),
    metadata TEXT, -- JSON string
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for duplicate file import detection
CREATE INDEX IF NOT EXISTS idx_import_batches_hash ON import_batches(file_hash);

-- 2. Counterparties (Vendors & Customers)
CREATE TABLE IF NOT EXISTS counterparties (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('vendor', 'customer', 'both', 'unknown')),
    email TEXT,
    metadata TEXT, -- JSON string
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_counterparties_name ON counterparties(name);

-- 3. Bank Accounts
CREATE TABLE IF NOT EXISTS bank_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    account_number TEXT,
    institution TEXT,
    currency TEXT NOT NULL DEFAULT 'USD',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Bank Transactions (Actual Cash Movement)
CREATE TABLE IF NOT EXISTS bank_transactions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL DEFAULT 'default_account',
    transaction_date TEXT NOT NULL, -- YYYY-MM-DD
    value_date TEXT, -- YYYY-MM-DD
    amount REAL NOT NULL CHECK (amount >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
    description TEXT NOT NULL,
    bank_reference TEXT,
    source TEXT NOT NULL, -- e.g. 'bank_csv'
    source_record_id TEXT NOT NULL, -- unique ID within source (row hash or bank transaction ID)
    import_batch_id TEXT REFERENCES import_batches(id),
    raw_data TEXT, -- JSON string preserving full original record
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_bank_tx_source UNIQUE (source, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_bank_tx_date ON bank_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_bank_tx_direction ON bank_transactions(direction);
CREATE INDEX IF NOT EXISTS idx_bank_tx_source ON bank_transactions(source, source_record_id);

-- 5. Invoices / Bills (AP & AR)
CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    invoice_number TEXT,
    document_type TEXT NOT NULL CHECK (document_type IN ('payable', 'receivable', 'unknown')),
    counterparty_id TEXT REFERENCES counterparties(id),
    counterparty_name TEXT,
    issue_date TEXT, -- YYYY-MM-DD
    due_date TEXT, -- YYYY-MM-DD
    currency TEXT NOT NULL DEFAULT 'USD',
    subtotal REAL,
    tax REAL,
    total REAL, -- Nullable: do not fake or hallucinate total when ambiguous
    source TEXT NOT NULL, -- e.g. 'invoice_pdf'
    source_file TEXT NOT NULL,
    source_record_id TEXT NOT NULL, -- unique ID or hash
    import_batch_id TEXT REFERENCES import_batches(id),
    status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('draft', 'issued', 'unpaid', 'paid', 'void', 'unknown')),
    raw_data TEXT, -- JSON string or raw extracted text/metadata
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_invoices_source UNIQUE (source, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_invoices_doc_type ON invoices(document_type);
CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_source ON invoices(source, source_record_id);

-- 6. Payment Provider Records (Stripe & Dodo Payments)
CREATE TABLE IF NOT EXISTS payment_provider_records (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('stripe', 'dodo')),
    record_type TEXT NOT NULL, -- 'payment', 'payout', 'refund', 'charge', 'balance_transaction', 'dispute'
    provider_record_id TEXT NOT NULL, -- e.g. 'ch_123', 'po_456'
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    fee REAL NOT NULL DEFAULT 0.0,
    net_amount REAL NOT NULL,
    transaction_time TEXT NOT NULL, -- ISO-8601 timestamp
    status TEXT NOT NULL,
    customer_id TEXT,
    customer_name TEXT,
    customer_email TEXT,
    related_provider_ids TEXT, -- JSON: { charge_id, payout_id, balance_transaction_id, invoice_id }
    source TEXT NOT NULL,
    source_record_id TEXT NOT NULL,
    import_batch_id TEXT REFERENCES import_batches(id),
    raw_data TEXT, -- Full original JSON record
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_payment_provider_records UNIQUE (provider, provider_record_id)
);

CREATE INDEX IF NOT EXISTS idx_ppr_provider ON payment_provider_records(provider);
CREATE INDEX IF NOT EXISTS idx_ppr_record_type ON payment_provider_records(record_type);
CREATE INDEX IF NOT EXISTS idx_ppr_provider_id ON payment_provider_records(provider, provider_record_id);

-- 7. Reconciliation / Agent Decisions (Session 4 — additive persistence layer)
-- One row per bank transaction. Upserted idempotently on transaction_id.
-- Authoritative outcome is final_decision; once a human approves/corrects a row
-- (review_status IN ('approved','corrected')), agent re-runs must NOT overwrite
-- the human's final_decision / category / invoice / vendor outcome.
-- API keys are NEVER stored here (provider/model names only).
CREATE TABLE IF NOT EXISTS reconciliation_decisions (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL UNIQUE,
    deterministic_decision TEXT,
    agent_decision TEXT,
    final_decision TEXT NOT NULL,
    category TEXT,
    confidence REAL,
    matched_invoice_id TEXT,
    matched_vendor_id TEXT,
    reasoning TEXT,
    evidence TEXT, -- JSON string array
    red_flags TEXT, -- JSON string array of {code, message} (Session 4 review reasons)
    needs_review INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    model TEXT,
    fallback_occurred INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'corrected')),
    reviewer_decision TEXT,
    correction_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_decisions_tx ON reconciliation_decisions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_decisions_review ON reconciliation_decisions(review_status, needs_review);

-- 8. Human Review Corrections (Session 4)
-- Append-only audit log of reviewer corrections. One row per correction event.
CREATE TABLE IF NOT EXISTS review_corrections (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    original_category TEXT,
    corrected_category TEXT,
    original_invoice_id TEXT,
    corrected_invoice_id TEXT,
    original_vendor_id TEXT,
    corrected_vendor_id TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_corrections_tx ON review_corrections(transaction_id);
