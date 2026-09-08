# CabinAI

CabinAI is an AI financial agent for solo founders and freelancers. It connects to your Stripe, Dodo, bank transactions, cards, invoices, and other financial data, then automatically organizes and handles the bookkeeping work in the background.

It reconciles transactions, understands what each payment or expense is for, and makes bookkeeping decisions automatically. When something is unclear or needs a human decision, CabinAI asks you instead of guessing.

### Stack

* **Backend:** Node.js, Express
* **Database:** SQLite
* **AI:** Google Gemini, OpenRouter
* **Frontend:** HTML, CSS, JavaScript

## Project Structure

```text
CabinAI/
├── bin/                    # CLI commands
├── fixtures/               # Sample financial data
├── public/                 # Frontend UI
├── scripts/                # Utility scripts
├── src/
│   ├── agent/              # LLM reasoning and bookkeeping agent
│   ├── api/                # API endpoints
│   ├── db/                 # SQLite database and repositories
│   ├── reconciliation/     # Transaction matching and reconciliation
│   ├── review/             # Human review and decisions
│   └── services/           # Core application services
├── tests/                  # Automated tests
├── server.js               # Express server
├── package.json
└── .env.example
```

## Scripts

```bash
npm start                  # Start the application
npm test                   # Run all tests

npm run test:session1      # Test financial ingestion
npm run test:session2      # Test reconciliation
npm run test:session3      # Test AI agent
npm run test:session4      # Test human review
npm run test:session5      # Test pipeline and API

npm run generate:fixtures  # Generate demo financial data
npm run ingest             # Run the ingestion pipeline
```

