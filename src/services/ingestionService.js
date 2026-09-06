const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { parseBankCsv } = require('../parsers/bankCsvParser');
const { parseInvoicePdf } = require('../parsers/invoicePdfParser');
const { parseStripeJson } = require('../parsers/stripeJsonParser');
const { parseDodoJson } = require('../parsers/dodoJsonParser');

const ImportBatchesRepository = require('../db/repositories/importBatches');
const CounterpartiesRepository = require('../db/repositories/counterparties');
const BankTransactionsRepository = require('../db/repositories/bankTransactions');
const InvoicesRepository = require('../db/repositories/invoices');
const PaymentProviderRecordsRepository = require('../db/repositories/paymentProviderRecords');

const { SourceType, CounterpartyType, DocumentType } = require('../models/types');

class IngestionService {
  constructor(db) {
    this.db = db;
    this.importBatches = new ImportBatchesRepository(db);
    this.counterparties = new CounterpartiesRepository(db);
    this.bankTransactions = new BankTransactionsRepository(db);
    this.invoices = new InvoicesRepository(db);
    this.paymentProviderRecords = new PaymentProviderRecordsRepository(db);
  }

  /**
   * Automatically detects source type based on file path or content.
   */
  detectSourceType(filePath, contentBuffer) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.csv') return SourceType.BANK_CSV;
    if (ext === '.pdf') return SourceType.INVOICE_PDF;
    if (ext === '.json') {
      try {
        const str = contentBuffer.toString('utf8');
        if (str.includes('"dodo"') || str.includes('payment_id') || str.includes('dodopay')) {
          return SourceType.DODO_JSON;
        }
        if (str.includes('"stripe"') || str.includes('"object":') || str.includes('ch_') || str.includes('pi_') || str.includes('po_')) {
          return SourceType.STRIPE_JSON;
        }
      } catch {
        // fallback
      }
    }
    return null;
  }

  /**
   * Ingests a file from disk.
   * @param {string} filePath Absolute or relative path to file
   * @param {object} [options]
   * @param {string} [options.sourceType] Explicit source type
   * @param {string} [options.accountId] Bank account ID for CSVs
   * @param {string[]} [options.companyNames] Company names for AP/AR heuristic
   * @returns {Promise<object>} Ingestion summary
   */
  async ingestFile(filePath, options = {}) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const sourceType = options.sourceType || this.detectSourceType(filePath, buffer);

    if (!sourceType) {
      throw new Error(`Unable to determine source type for file: ${filename}`);
    }

    return this.ingestContent(buffer, sourceType, {
      ...options,
      filename
    });
  }

  /**
   * Ingests content buffer or string with idempotency and audit provenance.
   * @param {Buffer|string} content 
   * @param {string} sourceType 
   * @param {object} [options]
   * @returns {Promise<object>} Ingestion summary
   */
  async ingestContent(content, sourceType, options = {}) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const filename = options.filename || 'unknown_source';
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Create provenance batch record
    const batch = this.importBatches.createBatch({
      sourceType,
      filename,
      fileHash,
      metadata: {
        file_size: buffer.length,
        options
      }
    });

    try {
      let result;

      switch (sourceType) {
        case SourceType.BANK_CSV:
          result = await this._ingestBankCsv(buffer.toString('utf8'), batch.id, options);
          break;

        case SourceType.INVOICE_PDF:
          result = await this._ingestInvoicePdf(buffer, batch.id, options);
          break;

        case SourceType.STRIPE_JSON:
          result = await this._ingestStripeJson(buffer.toString('utf8'), batch.id, options);
          break;

        case SourceType.DODO_JSON:
          result = await this._ingestDodoJson(buffer.toString('utf8'), batch.id, options);
          break;

        default:
          throw new Error(`Unsupported source type: ${sourceType}`);
      }

      // Update batch with final counts
      this.importBatches.updateBatch(batch.id, {
        totalRecords: result.totalParsed,
        status: 'completed',
        metadata: {
          file_size: buffer.length,
          inserted_count: result.insertedCount,
          skipped_count: result.skippedCount
        }
      });

      return {
        batchId: batch.id,
        sourceType,
        filename,
        fileHash,
        ...result
      };
    } catch (err) {
      this.importBatches.updateBatch(batch.id, {
        status: 'failed',
        metadata: { error: err.message }
      });
      throw err;
    }
  }

  async _ingestBankCsv(csvString, batchId, options) {
    const parsedTxs = parseBankCsv(csvString, {
      sourceFile: options.filename,
      defaultAccountId: options.accountId,
      defaultCurrency: options.currency
    });

    const txsWithBatch = parsedTxs.map(tx => ({
      ...tx,
      import_batch_id: batchId
    }));

    const batchResult = this.bankTransactions.insertBatch(txsWithBatch);

    return {
      totalParsed: parsedTxs.length,
      insertedCount: batchResult.insertedCount,
      skippedCount: batchResult.skippedCount,
      records: batchResult.records
    };
  }

  async _ingestInvoicePdf(pdfBuffer, batchId, options) {
    const parsedInvoice = await parseInvoicePdf(pdfBuffer, {
      sourceFile: options.filename,
      companyNames: options.companyNames
    });

    parsedInvoice.import_batch_id = batchId;

    // Register counterparty only if genuine name is found
    if (parsedInvoice.counterparty_name && typeof parsedInvoice.counterparty_name === 'string' && parsedInvoice.counterparty_name.trim()) {
      const cleanCp = parsedInvoice.counterparty_name.trim();
      if (!['unknown vendor', 'unknown customer', 'unknown', 'null'].includes(cleanCp.toLowerCase())) {
        const cpType = parsedInvoice.document_type === DocumentType.PAYABLE
          ? CounterpartyType.VENDOR
          : parsedInvoice.document_type === DocumentType.RECEIVABLE
            ? CounterpartyType.CUSTOMER
            : CounterpartyType.UNKNOWN;

        const counterparty = this.counterparties.upsert({
          name: cleanCp,
          type: cpType
        });
        if (counterparty) {
          parsedInvoice.counterparty_id = counterparty.id;
        }
      }
    }

    const insertResult = this.invoices.insert(parsedInvoice);

    return {
      totalParsed: 1,
      insertedCount: insertResult.inserted ? 1 : 0,
      skippedCount: insertResult.inserted ? 0 : 1,
      records: [insertResult.record]
    };
  }

  async _ingestStripeJson(jsonString, batchId, options) {
    const parsedRecords = parseStripeJson(jsonString);

    const recordsWithBatch = [];
    for (const rec of parsedRecords) {
      // Upsert customer counterparty if present
      if (rec.customer_name) {
        this.counterparties.upsert({
          name: rec.customer_name,
          type: CounterpartyType.CUSTOMER,
          email: rec.customer_email
        });
      }
      recordsWithBatch.push({
        ...rec,
        import_batch_id: batchId
      });
    }

    const batchResult = this.paymentProviderRecords.insertBatch(recordsWithBatch);

    return {
      totalParsed: parsedRecords.length,
      insertedCount: batchResult.insertedCount,
      skippedCount: batchResult.skippedCount,
      records: batchResult.records
    };
  }

  async _ingestDodoJson(jsonString, batchId, options) {
    const parsedRecords = parseDodoJson(jsonString);

    const recordsWithBatch = [];
    for (const rec of parsedRecords) {
      if (rec.customer_name) {
        this.counterparties.upsert({
          name: rec.customer_name,
          type: CounterpartyType.CUSTOMER,
          email: rec.customer_email
        });
      }
      recordsWithBatch.push({
        ...rec,
        import_batch_id: batchId
      });
    }

    const batchResult = this.paymentProviderRecords.insertBatch(recordsWithBatch);

    return {
      totalParsed: parsedRecords.length,
      insertedCount: batchResult.insertedCount,
      skippedCount: batchResult.skippedCount,
      records: batchResult.records
    };
  }
}

module.exports = IngestionService;
