'use strict';

const path = require('path');
const fs = require('fs');

// 1. Load environment variables from .env if present
const WORKTREE_ROOT = path.join(__dirname, '..');
const envPath = path.join(WORKTREE_ROOT, '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key] && val) {
        process.env[key] = val;
      }
    }
  }
}

// 2. Validate GEMINI_API_KEY is available (never log the key)
const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
console.log('--- CABINAI REAL GEMINI API INTEGRATION TEST ---');
console.log(`GEMINI_API_KEY configured: ${hasGeminiKey ? 'YES (length > 10)' : 'NO'}`);

if (!hasGeminiKey) {
  console.error('ERROR: GEMINI_API_KEY environment variable is missing.');
  process.exit(1);
}

const { initDatabase } = require('../src/db/connection');
const IngestionService = require('../src/services/ingestionService');
const { SourceType } = require('../src/models/types');
const { DeterministicMatcher } = require('../src/reconciliation');
const InvoicesRepository = require('../src/db/repositories/invoices');
const CounterpartiesRepository = require('../src/db/repositories/counterparties');
const { BookkeepingAgent, GeminiProvider, OpenRouterProvider } = require('../src/agent');

const FIXTURES_DIR = path.join(WORKTREE_ROOT, 'fixtures');

async function main() {
  console.log('\n[1/5] Ingesting fixtures into in-memory SQLite database...');
  const db = initDatabase(':memory:');
  const ingestion = new IngestionService(db);

  // Ingest bank transactions CSV
  const bankCsv = fs.readFileSync(path.join(FIXTURES_DIR, 'bank_transactions.csv'), 'utf8');
  const bankResult = await ingestion.ingestContent(bankCsv, SourceType.BANK_CSV, { filename: 'bank_transactions.csv' });
  console.log(`  - Bank CSV: ${bankResult.insertedCount} records inserted`);

  // Ingest AP invoice PDF
  const apPdf = fs.readFileSync(path.join(FIXTURES_DIR, 'ap_bill_aws.pdf'));
  const apResult = await ingestion.ingestContent(apPdf, SourceType.INVOICE_PDF, { filename: 'ap_bill_aws.pdf' });
  console.log(`  - AP Invoice PDF: ${apResult.insertedCount} invoice inserted`);

  // Ingest AR invoice PDF
  const arPdf = fs.readFileSync(path.join(FIXTURES_DIR, 'ar_invoice_acme.pdf'));
  const arResult = await ingestion.ingestContent(arPdf, SourceType.INVOICE_PDF, { filename: 'ar_invoice_acme.pdf' });
  console.log(`  - AR Invoice PDF: ${arResult.insertedCount} invoice inserted`);

  // Ingest Stripe export JSON
  const stripeJson = fs.readFileSync(path.join(FIXTURES_DIR, 'stripe_export.json'), 'utf8');
  const stripeResult = await ingestion.ingestContent(stripeJson, SourceType.STRIPE_JSON, { filename: 'stripe_export.json' });
  console.log(`  - Stripe JSON: ${stripeResult.insertedCount} records inserted`);

  const invoiceCount = ingestion.invoices.count();
  const bankTxCount = ingestion.bankTransactions.count();
  const counterpartyCount = ingestion.counterparties.findAll().length;
  console.log(`  -> Database populated: ${invoiceCount} invoices, ${bankTxCount} bank transactions, ${counterpartyCount} counterparties.`);

  console.log('\n[2/5] Running Session 2 Deterministic Reconciliation...');
  const matcher = new DeterministicMatcher();
  const allInvoices = ingestion.invoices.findAll();
  const allBankTx = ingestion.bankTransactions.findAll();
  const awsBankTx = allBankTx.find(tx => tx.description.includes('AMAZON WEB SERVICES'));

  if (!awsBankTx) {
    throw new Error('Could not find AWS bank transaction in ingested fixtures');
  }

  console.log(`  - Evaluating Transaction: "${awsBankTx.description}" (${awsBankTx.amount} ${awsBankTx.currency}, ${awsBankTx.direction}, date: ${awsBankTx.transaction_date})`);
  const session2Result = matcher.matchTransaction(awsBankTx, allInvoices);

  console.log(`  - Session 2 Decision: ${session2Result.decision}`);
  console.log(`  - Session 2 Score: ${session2Result.score}`);
  console.log(`  - Session 2 Matched Candidate ID: ${session2Result.candidateId}`);
  console.log(`  - Session 2 Summary: ${session2Result.reasons.summary}`);

  if (session2Result.decision !== 'match') {
    throw new Error(`Expected Session 2 match, got: ${session2Result.decision}`);
  }

  console.log('\n[3/5] Initializing BookkeepingAgent with real GeminiProvider...');
  const repos = {
    invoices: new InvoicesRepository(db),
    counterparties: new CounterpartiesRepository(db)
  };

  // Model configured via GEMINI_MODEL or default
  const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  console.log(`  - Model: ${modelName}`);
  const geminiProvider = new GeminiProvider({ model: modelName });
  const agent = new BookkeepingAgent({
    primaryProvider: geminiProvider,
    repos
  });

  console.log('\n[4/5] Executing real Gemini request through agent loop...');
  const startTime = Date.now();
  const agentResult = await agent.processTransaction(awsBankTx, { session2Result });
  const elapsedMs = Date.now() - startTime;
  console.log(`  - Gemini response received in ${elapsedMs}ms`);

  console.log('\n[5/5] Verifying Agent Decision & Audit Trail...');
  console.log('  --- AGENT RESULT ---');
  console.log(`  Transaction ID:     ${agentResult.transactionId}`);
  console.log(`  Decision:           ${agentResult.decision}`);
  console.log(`  Category:           ${agentResult.category}`);
  console.log(`  Confidence:         ${agentResult.confidence}`);
  console.log(`  Needs Review:       ${agentResult.needsReview}`);
  console.log(`  Matched Invoice ID: ${agentResult.matchedInvoiceId}`);
  console.log(`  Matched Vendor ID:  ${agentResult.matchedVendorId}`);
  console.log(`  Reasoning:          ${agentResult.reasoning}`);
  console.log(`  Evidence:           ${JSON.stringify(agentResult.evidence)}`);
  console.log(`  Tool Calls Count:   ${agentResult.toolCalls.length}`);

  agentResult.toolCalls.forEach((tc, idx) => {
    console.log(`    [Tool Call #${idx + 1}] ${tc.toolName}(${JSON.stringify(tc.arguments)})`);
    console.log(`      -> Result: error=${tc.result.error}, matches=${tc.result.matches ? tc.result.matches.length : (tc.result.matchCount !== undefined ? tc.result.matchCount : 'N/A')}`);
  });

  console.log('\n  --- AUDIT RECORD ---');
  console.log(`  Provider:           ${agentResult.audit.provider}`);
  console.log(`  Model:              ${agentResult.audit.model}`);
  console.log(`  Fallback Occurred:  ${agentResult.audit.fallbackOccurred}`);
  console.log(`  Final Decision:     ${agentResult.audit.finalDecision}`);
  console.log(`  Audit Tools Logged: ${agentResult.audit.toolCalls.length}`);
  console.log(`  Error:              ${agentResult.audit.error || 'None'}`);

  // Assertions for complete verification
  if (agentResult.decision !== 'matched' && agentResult.decision !== 'categorized') {
    throw new Error(`Agent decision expected to be 'matched' or 'categorized', got: ${agentResult.decision}`);
  }
  if (!agentResult.category) {
    throw new Error('Agent expected to determine a valid category');
  }
  if (typeof agentResult.confidence !== 'number' || agentResult.confidence <= 0) {
    throw new Error(`Expected positive confidence score, got: ${agentResult.confidence}`);
  }
  if (agentResult.audit.provider !== 'gemini') {
    throw new Error(`Expected audit provider 'gemini', got: ${agentResult.audit.provider}`);
  }

  console.log('\n>>> REAL GEMINI INTEGRATION TEST PASSED SUCCESSFULLY! <<<');
}

main().catch(err => {
  console.error('\nREAL GEMINI TEST FAILED:', err.message);
  if (err.cause) console.error('Cause:', err.cause);
  process.exit(1);
});
