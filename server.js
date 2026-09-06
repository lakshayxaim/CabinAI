/**
 * CabinAI local showcase server — Session 5 entry point.
 *
 * Wires the EXISTING production backend (Sessions 1–4) to HTTP:
 *   SQLite → IngestionService → ReconciliationPipeline → DecisionService → Express API → static UI
 *
 * Run:  node --env-file=.env server.js   (GEMINI/OPENROUTER keys optional)
 * Then: http://localhost:5000
 *
 * Without provider keys the pipeline runs in deterministic-only mode:
 * deterministic matches still reconcile; everything else queues for review.
 * No secrets are ever served to the browser.
 */

'use strict';

const path = require('path');
const express = require('express');

const { initDatabase } = require('./src/db/connection');
const IngestionService = require('./src/services/ingestionService');
const ReconciliationPipeline = require('./src/services/reconciliationPipeline');
const createApp = require('./src/api/createApp');

const PORT = Number(process.env.PORT) || 5000;

function main() {
  const db = initDatabase();
  const ingestion = new IngestionService(db);
  const pipeline = ReconciliationPipeline.create(db);

  const app = createApp({ db, pipeline, decisions: pipeline.decisions, ingestion });
  app.use(express.static(path.join(__dirname, 'public')));

  app.listen(PORT, () => {
    console.log(`CabinAI is running at http://localhost:${PORT}`);
    console.log(`Provider agent: ${pipeline.agent ? 'enabled' : 'deterministic-only (no provider keys configured)'}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
