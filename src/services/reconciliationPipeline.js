/**
 * ReconciliationPipeline — Session 5 production orchestrator (thin adapter).
 *
 * Wires the EXISTING Sessions 1–4 implementation end to end:
 *
 *   Bank transaction (SQLite, via Session 1 ingestion)
 *         ↓
 *   DeterministicMatcher (Session 2 — thresholds/rejections untouched)
 *         ↓
 *   BookkeepingAgent (Session 3 — Gemini primary, OpenRouter fallback, tools untouched)
 *         ↓
 *   DecisionService (Session 4 — red flags, human authority untouched)
 *         ↓
 *   SQLite (reconciliation_decisions / review_corrections)
 *
 * This module contains NO accounting rules, NO matching logic, NO red-flag
 * rules and NO LLM logic. It only orchestrates calls between existing modules.
 *
 * Human-authority guarantee: a transaction whose persisted decision has
 * review_status 'approved' or 'corrected' is returned as-is WITHOUT invoking
 * the matcher or the agent, so re-reconciliation can never silently overwrite
 * a human's final_decision / category / invoice / vendor outcome (and never
 * burns LLM calls on locked rows).
 *
 * The agent is optional. When constructed without an agent (e.g. no provider
 * credentials configured), the pipeline runs deterministic matching +
 * DecisionService persistence only. A deterministic MATCH still reconciles;
 * everything else queues for review with red flags.
 */

'use strict';

const DeterministicMatcher = require('../reconciliation/matcher');
const { BookkeepingAgent, GeminiProvider, OpenRouterProvider } = require('../agent');
const { DecisionService } = require('../review');
const BankTransactionsRepository = require('../db/repositories/bankTransactions');
const InvoicesRepository = require('../db/repositories/invoices');
const PaymentProviderRecordsRepository = require('../db/repositories/paymentProviderRecords');
const CounterpartiesRepository = require('../db/repositories/counterparties');

const HUMAN_LOCKED_STATUSES = Object.freeze(['approved', 'corrected']);

class ReconciliationPipeline {
  /**
   * @param {Object} deps
   * @param {Object} deps.db - better-sqlite3 handle (repositories are built from it when not supplied)
   * @param {DeterministicMatcher} [deps.matcher]
   * @param {BookkeepingAgent|null} [deps.agent] - null/undefined = deterministic-only mode
   * @param {DecisionService} [deps.decisions]
   * @param {BankTransactionsRepository} [deps.bankTransactions]
   * @param {InvoicesRepository} [deps.invoices]
   * @param {PaymentProviderRecordsRepository} [deps.paymentProviderRecords]
   * @param {CounterpartiesRepository} [deps.counterparties]
   */
  constructor({
    db,
    matcher,
    agent = null,
    decisions,
    bankTransactions,
    invoices,
    paymentProviderRecords,
    counterparties
  } = {}) {
    if (!db) throw new Error('ReconciliationPipeline: db is required');
    this.db = db;
    this.matcher = matcher || new DeterministicMatcher();
    this.agent = agent || null;
    this.decisions = decisions || DecisionService.create(db);
    this.bankTransactions = bankTransactions || new BankTransactionsRepository(db);
    this.invoices = invoices || new InvoicesRepository(db);
    this.paymentProviderRecords =
      paymentProviderRecords || new PaymentProviderRecordsRepository(db);
    this.counterparties = counterparties || new CounterpartiesRepository(db);
  }

  /**
   * Builds a production BookkeepingAgent (Gemini primary + OpenRouter fallback)
   * when credentials are configured, otherwise returns null so the pipeline
   * runs in deterministic-only mode. Never throws for missing keys.
   *
   * @param {Object} db - better-sqlite3 handle (for read-only agent tool repos)
   * @returns {BookkeepingAgent|null}
   */
  static buildProductionAgent(db) {
    const hasGemini = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
    const hasOpenRouter = Boolean(
      process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim()
    );
    if (!hasGemini && !hasOpenRouter) return null;

    const repos = {
      invoices: new InvoicesRepository(db),
      counterparties: new CounterpartiesRepository(db)
    };
    try {
      const primaryProvider = hasGemini
        ? new GeminiProvider()
        : new OpenRouterProvider();
      const fallbackProvider = hasGemini && hasOpenRouter ? new OpenRouterProvider() : null;
      return new BookkeepingAgent({ primaryProvider, fallbackProvider, repos });
    } catch {
      return null;
    }
  }

  /**
   * Convenience factory wiring real repositories/matcher/DecisionService to a
   * database handle, plus the production agent when credentials exist.
   *
   * @param {Object} db - better-sqlite3 handle
   * @param {Object} [opts]
   * @param {BookkeepingAgent|null} [opts.agent] - explicit agent (tests inject a fake provider agent here)
   * @returns {ReconciliationPipeline}
   */
  static create(db, { agent } = {}) {
    const ownedAgent = agent === undefined ? ReconciliationPipeline.buildProductionAgent(db) : agent;
    return new ReconciliationPipeline({ db, agent: ownedAgent });
  }

  /**
   * Returns the persisted decision when the transaction is human-locked
   * (review_status 'approved' or 'corrected'), otherwise null.
   */
  findHumanLockedDecision(transactionId) {
    const existing = this.decisions.decisions.findByTransactionId(transactionId);
    if (existing && HUMAN_LOCKED_STATUSES.includes(existing.review_status)) {
      return existing;
    }
    return null;
  }

  /**
   * Reconciles a single bank transaction through the full production flow.
   *
   * @param {Object} transaction - normalized bank transaction row (must have id)
   * @returns {Promise<{ record: Object, redFlags: Array, created: boolean, humanLocked: boolean }>}
   */
  async reconcileTransaction(transaction) {
    const transactionId = transaction && (transaction.id || transaction.transaction_id);
    if (!transactionId) {
      throw new Error('ReconciliationPipeline.reconcileTransaction: transaction.id is required');
    }

    // Human authority short-circuit: never re-run matcher/agent over a
    // human-approved or human-corrected decision.
    const locked = this.findHumanLockedDecision(transactionId);
    if (locked) {
      return {
        record: locked,
        redFlags: DecisionService.parseRedFlags(locked.red_flags),
        created: false,
        humanLocked: true
      };
    }

    // Candidate assembly mirrors Session 2's end-to-end contract:
    // every invoice plus every payment-provider record. The matcher's
    // compatibility stage deterministically filters what may match.
    const candidates = [...this.invoices.findAll(), ...this.paymentProviderRecords.findAll()];
    const deterministicResult = this.matcher.matchTransaction(transaction, candidates);

    const agentResult = this.agent
      ? await this.agent.processTransaction(transaction, { session2Result: deterministicResult })
      : null;

    return this.decisions.persistDecision({
      transaction,
      deterministicResult,
      agentResult
    });
  }

  /**
   * Reconciles every bank transaction in the database.
   *
   * @returns {Promise<{ total: number, reconciled: number, needsReview: number, results: Array }>}
   */
  async reconcileAll() {
    const transactions = this.bankTransactions.findAll();
    const results = [];
    for (const tx of transactions) {
      results.push(await this.reconcileTransaction(tx));
    }
    const needsReview = results.filter(r => r.record && Number(r.record.needs_review) === 1).length;
    return {
      total: results.length,
      reconciled: results.length - needsReview,
      needsReview,
      results
    };
  }
}

module.exports = ReconciliationPipeline;
