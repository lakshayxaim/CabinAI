#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { initDatabase } = require('../src/db/connection');
const IngestionService = require('../src/services/ingestionService');

async function main() {
  const args = process.argv.slice(2);
  const db = initDatabase();
  const service = new IngestionService(db);

  if (args.includes('--stats') || args.includes('-s') || args.length === 0) {
    console.log('\n=== CabinAI Financial Database Status ===\n');
    const bankTxs = service.bankTransactions.count();
    const invoices = service.invoices.count();
    const payables = service.invoices.findByDocumentType('payable').length;
    const receivables = service.invoices.findByDocumentType('receivable').length;
    const ppr = service.paymentProviderRecords.count();
    const counterparties = service.counterparties.findAll().length;

    console.log(`Bank Transactions:        ${bankTxs}`);
    console.log(`Invoices / Bills:         ${invoices} (AP / Payable: ${payables}, AR / Receivable: ${receivables})`);
    console.log(`Payment Provider Records: ${ppr}`);
    console.log(`Counterparties:           ${counterparties}`);
    console.log('\n=========================================\n');

    if (args.length === 0) {
      console.log('Usage: node bin/ingest.js <file_or_directory_path>');
      console.log('       node bin/ingest.js --inspect');
      console.log('       node bin/ingest.js --stats\n');
      return;
    }
  }

  if (args.includes('--inspect')) {
    console.log('\n--- Recent Bank Transactions ---');
    console.table(service.bankTransactions.findAll().slice(0, 10), ['transaction_date', 'direction', 'amount', 'currency', 'description', 'source_record_id']);

    console.log('\n--- Recent Invoices / Bills ---');
    console.table(service.invoices.findAll().slice(0, 10), ['invoice_number', 'document_type', 'counterparty_name', 'issue_date', 'total', 'currency']);

    console.log('\n--- Recent Payment Provider Records ---');
    console.table(service.paymentProviderRecords.findAll().slice(0, 10), ['provider', 'record_type', 'provider_record_id', 'amount', 'fee', 'net_amount', 'status']);
    return;
  }

  const targets = args.filter(a => !a.startsWith('--'));

  for (const target of targets) {
    const fullPath = path.resolve(process.cwd(), target);
    if (!fs.existsSync(fullPath)) {
      console.error(`Error: File or directory not found: ${fullPath}`);
      continue;
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(fullPath);
      for (const file of files) {
        const filePath = path.join(fullPath, file);
        if (fs.statSync(filePath).isFile()) {
          try {
            console.log(`Ingesting file: ${file}...`);
            const res = await service.ingestFile(filePath);
            console.log(`  ✓ Success: Parsed ${res.totalParsed}, Inserted ${res.insertedCount}, Skipped (duplicate) ${res.skippedCount}`);
          } catch (e) {
            console.error(`  ✗ Error ingesting ${file}:`, e.message);
          }
        }
      }
    } else {
      try {
        console.log(`Ingesting file: ${path.basename(fullPath)}...`);
        const res = await service.ingestFile(fullPath);
        console.log(`  ✓ Success: Parsed ${res.totalParsed}, Inserted ${res.insertedCount}, Skipped (duplicate) ${res.skippedCount}`);
      } catch (e) {
        console.error(`  ✗ Error ingesting ${path.basename(fullPath)}:`, e.message);
      }
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
