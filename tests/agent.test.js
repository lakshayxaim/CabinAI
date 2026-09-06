'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  BookkeepingAgent,
  LLMProvider,
  LLMResponse,
  RetryableProviderError,
  GeminiProvider,
  OpenRouterProvider,
  TOOLS,
  getToolSchemas,
  executeTool,
  isToolRegistered,
  lookupVendor,
  findMatchingInvoice,
  calculateAmountDifference,
  checkDuplicateInvoice,
  checkInvoiceStatus,
  AgentDecision,
  TransactionCategory,
  AgentResult,
  AgentAudit
} = require('../src/agent');

const { Direction, DocumentType, InvoiceStatus } = require('../src/models/types');

// --- Mock LLM Provider for Testing ---

class MockProvider extends LLMProvider {
  constructor({ name = 'mock', model = 'mock-model', responses = [] } = {}) {
    super({ model });
    this.providerName = name;
    this.responses = [...responses];
    this.callCount = 0;
    this.history = [];
  }

  enqueueResponse(response) {
    this.responses.push(response);
  }

  async generate(request) {
    this.callCount++;
    this.history.push(request);

    if (this.responses.length === 0) {
      throw new Error(`MockProvider (${this.providerName}): no more queued responses for call #${this.callCount}`);
    }

    const next = this.responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

// --- In-Memory Fake Repositories (Pure JS, no SQLite) ---

function createFakeRepos(initialData = {}) {
  const counterpartiesData = initialData.counterparties || [
    { id: 'cp-aws-01', name: 'Amazon Web Services, Inc.', type: 'vendor', email: 'billing@aws.amazon.com' },
    { id: 'cp-github-01', name: 'GitHub, Inc.', type: 'vendor', email: 'billing@github.com' },
    { id: 'cp-acme-01', name: 'Acme Corporation', type: 'customer', email: 'accounts@acme.com' },
    { id: 'cp-stripe-01', name: 'Stripe Payments', type: 'vendor', email: null }
  ];

  const invoicesData = initialData.invoices || [
    {
      id: 'inv-aws-01',
      invoice_number: 'INV-AWS-2024-9841',
      document_type: DocumentType.PAYABLE,
      counterparty_id: 'cp-aws-01',
      counterparty_name: 'Amazon Web Services, Inc.',
      issue_date: '2024-03-01',
      due_date: '2024-03-31',
      currency: 'USD',
      subtotal: 125.00,
      tax: 0.00,
      total: 125.00,
      status: InvoiceStatus.UNPAID
    },
    {
      id: 'inv-github-01',
      invoice_number: 'GH-2024-03',
      document_type: DocumentType.PAYABLE,
      counterparty_id: 'cp-github-01',
      counterparty_name: 'GitHub, Inc.',
      issue_date: '2024-03-04',
      due_date: '2024-03-18',
      currency: 'USD',
      subtotal: 42.00,
      tax: 0.00,
      total: 42.00,
      status: InvoiceStatus.PAID
    },
    {
      id: 'inv-acme-01',
      invoice_number: 'INV-ACME-1001',
      document_type: DocumentType.RECEIVABLE,
      counterparty_id: 'cp-acme-01',
      counterparty_name: 'Acme Corporation',
      issue_date: '2024-03-01',
      due_date: '2024-03-15',
      currency: 'USD',
      subtotal: 2700.00,
      tax: 0.00,
      total: 2700.00,
      status: InvoiceStatus.UNPAID
    }
  ];

  return {
    counterparties: {
      findAll: () => [...counterpartiesData],
      findById: (id) => counterpartiesData.find(c => c.id === id) || null,
      findByName: (name) => counterpartiesData.find(c => c.name.toLowerCase() === name.toLowerCase()) || null
    },
    invoices: {
      findAll: () => [...invoicesData],
      findById: (id) => invoicesData.find(i => i.id === id) || null,
      findByInvoiceNumber: (num) => invoicesData.filter(i => (i.invoice_number || '').toLowerCase() === (num || '').toLowerCase()),
      findByDocumentType: (docType) => invoicesData.filter(i => i.document_type === docType)
    }
  };
}

// =========================================================================
// SECTION 1: DETERMINISTIC TOOLS UNIT TESTS
// =========================================================================

describe('Session 3 — Deterministic Tools Unit Tests', () => {
  let repos;

  beforeEach(() => {
    repos = createFakeRepos();
  });

  // --- 1. lookup_vendor ---
  describe('lookup_vendor', () => {
    test('finds vendor by exact or fuzzy name match with similarity score', () => {
      const res = lookupVendor({ query: 'AMAZON WEB SERVICES' }, repos);
      assert.equal(res.error, false);
      assert.ok(res.matches.length >= 1);
      assert.equal(res.matches[0].name, 'Amazon Web Services, Inc.');
      assert.ok(res.matches[0].similarity >= 0.8);
      assert.equal(res.matches[0].id, 'cp-aws-01');
    });

    test('returns empty matches when query does not match any counterparty above threshold', () => {
      const res = lookupVendor({ query: 'NONEXISTENT VENDOR XYZ', minSimilarity: 0.8 }, repos);
      assert.equal(res.error, false);
      assert.equal(res.matches.length, 0);
      assert.equal(res.matchCount, 0);
    });

    test('respects limit parameter', () => {
      const res = lookupVendor({ query: 'Inc', minSimilarity: 0.1, limit: 1 }, repos);
      assert.equal(res.error, false);
      assert.ok(res.matches.length <= 1);
    });

    test('rejects invalid arguments (empty/missing query, invalid minSimilarity)', () => {
      assert.equal(lookupVendor({}, repos).error, true);
      assert.equal(lookupVendor({ query: '' }, repos).error, true);
      assert.equal(lookupVendor({ query: 'AWS', minSimilarity: -1 }, repos).error, true);
      assert.equal(lookupVendor({ query: 'AWS', minSimilarity: 1.5 }, repos).error, true);
      assert.equal(lookupVendor({ query: 'AWS', limit: 0 }, repos).error, true);
    });

    test('handles missing counterparties repository safely', () => {
      const res = lookupVendor({ query: 'AWS' }, {});
      assert.equal(res.error, true);
      assert.equal(res.code, 'INTERNAL_ERROR');
    });
  });

  // --- 2. find_matching_invoice ---
  describe('find_matching_invoice', () => {
    test('returns MATCH decision and evidence for exact amount, date, vendor match', () => {
      const tx = {
        amount: 125.00,
        currency: 'USD',
        direction: Direction.OUTFLOW,
        transaction_date: '2024-03-02',
        description: 'AMAZON WEB SERVICES'
      };

      const res = findMatchingInvoice({ transaction: tx }, repos);
      assert.equal(res.error, false);
      assert.equal(res.decision, 'match');
      assert.equal(res.matchedInvoiceId, 'inv-aws-01');
      assert.ok(res.score >= 0.9);
      assert.ok(res.evidence.amountComparison.isExact);
      assert.ok(res.evidence.dateDifference.isWithinWindow);
    });

    test('enforces Session 2 direction rule: OUTFLOW cannot match RECEIVABLE invoice', () => {
      const tx = {
        amount: 2700.00,
        currency: 'USD',
        direction: Direction.OUTFLOW, // incompatible with RECEIVABLE
        transaction_date: '2024-03-03',
        description: 'ACME CORP'
      };

      const res = findMatchingInvoice({ transaction: tx, invoiceIds: ['inv-acme-01'] }, repos);
      assert.equal(res.error, false);
      assert.notEqual(res.decision, 'match');
      assert.equal(res.matchedInvoiceId, null);
      assert.equal(res.allEvaluations[0].isCompatible, false);
    });

    test('enforces Session 2 currency rule: currency mismatch rejected', () => {
      const tx = {
        amount: 125.00,
        currency: 'EUR', // invoice is in USD
        direction: Direction.OUTFLOW,
        transaction_date: '2024-03-02',
        description: 'AMAZON WEB SERVICES'
      };

      const res = findMatchingInvoice({ transaction: tx, invoiceIds: ['inv-aws-01'] }, repos);
      assert.equal(res.error, false);
      assert.notEqual(res.decision, 'match');
      assert.equal(res.matchedInvoiceId, null);
    });

    test('enforces Session 2 exact amount gate: amount discrepancy rejected', () => {
      const tx = {
        amount: 130.00, // invoice total is 125.00
        currency: 'USD',
        direction: Direction.OUTFLOW,
        transaction_date: '2024-03-02',
        description: 'AMAZON WEB SERVICES'
      };

      const res = findMatchingInvoice({ transaction: tx, invoiceIds: ['inv-aws-01'] }, repos);
      assert.equal(res.error, false);
      assert.notEqual(res.decision, 'match');
      assert.equal(res.matchedInvoiceId, null);
    });

    test('rejects invalid arguments', () => {
      assert.equal(findMatchingInvoice({}, repos).error, true);
      assert.equal(findMatchingInvoice({ transaction: 'invalid' }, repos).error, true);
      assert.equal(findMatchingInvoice({ transaction: { amount: 'not-num', currency: 'USD', direction: 'outflow', transaction_date: '2024-01-01' } }, repos).error, true);
      assert.equal(findMatchingInvoice({ transaction: { amount: 10, currency: '', direction: 'outflow', transaction_date: '2024-01-01' } }, repos).error, true);
      assert.equal(findMatchingInvoice({ transaction: { amount: 10, currency: 'USD', direction: 'invalid_dir', transaction_date: '2024-01-01' } }, repos).error, true);
    });
  });

  // --- 3. calculate_amount_difference ---
  describe('calculate_amount_difference', () => {
    test('computes exact match with 0 difference', () => {
      const res = calculateAmountDifference({ expectedAmount: 125.00, actualAmount: 125.00, currency: 'USD' });
      assert.equal(res.error, false);
      assert.equal(res.isExact, true);
      assert.equal(res.absoluteDifference, 0);
      assert.equal(res.signedDifference, 0);
      assert.equal(res.direction, 'equal');
      assert.equal(res.currency, 'USD');
    });

    test('computes actual exceeds expected (positive signed difference)', () => {
      const res = calculateAmountDifference({ expectedAmount: 100.00, actualAmount: 105.50 });
      assert.equal(res.error, false);
      assert.equal(res.isExact, false);
      assert.equal(res.absoluteDifference, 5.50);
      assert.equal(res.signedDifference, 5.50);
      assert.equal(res.direction, 'actual_exceeds_expected');
      assert.equal(res.percentageDifference, 5.5);
    });

    test('computes actual below expected (negative signed difference)', () => {
      const res = calculateAmountDifference({ expectedAmount: 200.00, actualAmount: 190.00 });
      assert.equal(res.error, false);
      assert.equal(res.isExact, false);
      assert.equal(res.absoluteDifference, 10.00);
      assert.equal(res.signedDifference, -10.00);
      assert.equal(res.direction, 'actual_below_expected');
      assert.equal(res.percentageDifference, 5);
    });

    test('validates inputs strictly', () => {
      assert.equal(calculateAmountDifference({}).error, true);
      assert.equal(calculateAmountDifference({ expectedAmount: 'abc', actualAmount: 100 }).error, true);
      assert.equal(calculateAmountDifference({ expectedAmount: 100, actualAmount: 'xyz' }).error, true);
      assert.equal(calculateAmountDifference({ expectedAmount: 100, actualAmount: 100, currency: '' }).error, true);
    });
  });

  // --- 4. check_duplicate_invoice ---
  describe('check_duplicate_invoice', () => {
    test('detects duplicate invoices matching reference invoice by invoice number and details', () => {
      const customRepos = createFakeRepos({
        invoices: [
          {
            id: 'inv-orig',
            invoice_number: 'INV-DUP-100',
            counterparty_name: 'Acme Corp',
            total: 500.00,
            currency: 'USD',
            issue_date: '2024-03-01',
            status: InvoiceStatus.PAID
          },
          {
            id: 'inv-copy',
            invoice_number: 'INV-DUP-100',
            counterparty_name: 'Acme Corp',
            total: 500.00,
            currency: 'USD',
            issue_date: '2024-03-01',
            status: InvoiceStatus.UNPAID
          }
        ]
      });

      const res = checkDuplicateInvoice({ invoiceId: 'inv-orig' }, customRepos);
      assert.equal(res.error, false);
      assert.equal(res.found, true);
      assert.equal(res.duplicateCount, 1);
      assert.equal(res.duplicates[0].invoiceId, 'inv-copy');
      assert.equal(res.duplicates[0].evidence.invoiceNumberMatch, true);
      assert.equal(res.duplicates[0].evidence.amountMatch, true);
    });

    test('returns found: false when reference invoice does not exist', () => {
      const res = checkDuplicateInvoice({ invoiceId: 'non-existent' }, repos);
      assert.equal(res.error, false);
      assert.equal(res.found, false);
      assert.equal(res.duplicateCount, 0);
    });

    test('validates inputs requiring either invoiceId or invoiceNumber', () => {
      assert.equal(checkDuplicateInvoice({}, repos).error, true);
      assert.equal(checkDuplicateInvoice({ invoiceId: 123 }, repos).error, true);
    });
  });

  // --- 5. check_invoice_status ---
  describe('check_invoice_status', () => {
    test('returns normalized invoice status and fields for existing invoice', () => {
      const res = checkInvoiceStatus({ invoiceId: 'inv-aws-01' }, repos);
      assert.equal(res.error, false);
      assert.equal(res.found, true);
      assert.equal(res.invoiceId, 'inv-aws-01');
      assert.equal(res.status, InvoiceStatus.UNPAID);
      assert.equal(res.total, 125.00);
      assert.equal(res.currency, 'USD');
    });

    test('returns found: false and status: null for unknown invoice', () => {
      const res = checkInvoiceStatus({ invoiceId: 'missing-id' }, repos);
      assert.equal(res.error, false);
      assert.equal(res.found, false);
      assert.equal(res.status, null);
    });

    test('validates invoiceId parameter', () => {
      assert.equal(checkInvoiceStatus({}, repos).error, true);
      assert.equal(checkInvoiceStatus({ invoiceId: '' }, repos).error, true);
      assert.equal(checkInvoiceStatus({ invoiceId: 456 }, repos).error, true);
    });
  });
});

// =========================================================================
// SECTION 2: TOOL REGISTRY TESTS
// =========================================================================

describe('Session 3 — Tool Registry Tests', () => {
  let repos;

  beforeEach(() => {
    repos = createFakeRepos();
  });

  test('registry contains all 5 required deterministic tools', () => {
    assert.equal(isToolRegistered('lookup_vendor'), true);
    assert.equal(isToolRegistered('find_matching_invoice'), true);
    assert.equal(isToolRegistered('calculate_amount_difference'), true);
    assert.equal(isToolRegistered('check_duplicate_invoice'), true);
    assert.equal(isToolRegistered('check_invoice_status'), true);
    assert.equal(isToolRegistered('arbitrary_function'), false);
  });

  test('getToolSchemas returns valid schema definitions for all tools', () => {
    const schemas = getToolSchemas();
    assert.equal(schemas.length, 5);
    const names = schemas.map(s => s.name);
    assert.ok(names.includes('lookup_vendor'));
    assert.ok(names.includes('find_matching_invoice'));
    assert.ok(names.includes('calculate_amount_difference'));
    assert.ok(names.includes('check_duplicate_invoice'));
    assert.ok(names.includes('check_invoice_status'));
  });

  test('executeTool handles unknown tool safely without throwing', () => {
    const res = executeTool('non_existent_tool', {}, repos);
    assert.equal(res.success, false);
    assert.equal(res.result.error, true);
    assert.equal(res.result.code, 'UNKNOWN_TOOL');
  });

  test('executeTool catches tool execution errors safely', () => {
    const badRepos = {
      counterparties: {
        findAll: () => { throw new Error('Simulated DB disk failure'); }
      }
    };
    const res = executeTool('lookup_vendor', { query: 'AWS' }, badRepos);
    assert.equal(res.success, false);
    assert.equal(res.result.error, true);
    assert.ok(res.result.code === 'REPOSITORY_ERROR' || res.result.code === 'TOOL_EXECUTION_ERROR');
  });
});

// =========================================================================
// SECTION 3: PROVIDER HISTORY SERIALIZATION (GEMINI & OPENROUTER)
// =========================================================================

describe('Session 3 — Provider History Serialization Tests', () => {
  test('GeminiProvider: correctly serializes model functionCall followed by user functionResponse', () => {
    const fakeGenAI = { models: { generateContent: async () => ({}) } };
    const gemini = new GeminiProvider({ apiKey: 'test-api-key', genAI: fakeGenAI });

    const messages = [
      { role: 'user', content: 'Process transaction 123' },
      {
        role: 'model',
        toolCalls: [
          { id: 'call_1', name: 'lookup_vendor', args: { query: 'Amazon' } }
        ],
        content: 'Calling tool: lookup_vendor({"query":"Amazon"})'
      },
      {
        role: 'tool',
        toolName: 'lookup_vendor',
        toolCallId: 'call_1',
        content: JSON.stringify({ error: false, matches: [{ id: 'cp-aws-01', name: 'Amazon' }] })
      }
    ];

    const contents = gemini._buildContents(messages);
    assert.equal(contents.length, 3);

    // Turn 1: user text
    assert.equal(contents[0].role, 'user');
    assert.deepEqual(contents[0].parts, [{ text: 'Process transaction 123' }]);

    // Turn 2: model functionCall
    assert.equal(contents[1].role, 'model');
    assert.equal(contents[1].parts.length, 1);
    assert.equal(contents[1].parts[0].functionCall.name, 'lookup_vendor');
    assert.deepEqual(contents[1].parts[0].functionCall.args, { query: 'Amazon' });

    // Turn 3: user functionResponse
    assert.equal(contents[2].role, 'user');
    assert.equal(contents[2].parts.length, 1);
    assert.equal(contents[2].parts[0].functionResponse.name, 'lookup_vendor');
    assert.deepEqual(contents[2].parts[0].functionResponse.response, {
      error: false,
      matches: [{ id: 'cp-aws-01', name: 'Amazon' }]
    });
  });

  test('OpenRouterProvider: correctly serializes assistant tool_calls followed by tool response', () => {
    const openrouter = new OpenRouterProvider({ apiKey: 'test-api-key' });

    const messages = [
      { role: 'user', content: 'Process transaction 123' },
      {
        role: 'model',
        toolCalls: [
          { id: 'call_abc_123', name: 'lookup_vendor', args: { query: 'Amazon' } }
        ],
        content: 'Calling tool: lookup_vendor({"query":"Amazon"})'
      },
      {
        role: 'tool',
        toolName: 'lookup_vendor',
        toolCallId: 'call_abc_123',
        content: JSON.stringify({ error: false, matches: [{ id: 'cp-aws-01', name: 'Amazon' }] })
      }
    ];

    const built = openrouter._buildMessages('You are a bookkeeping assistant', messages);
    assert.equal(built.length, 4);

    // System turn
    assert.equal(built[0].role, 'system');
    assert.equal(built[0].content, 'You are a bookkeeping assistant');

    // User turn
    assert.equal(built[1].role, 'user');
    assert.equal(built[1].content, 'Process transaction 123');

    // Assistant tool_calls turn
    assert.equal(built[2].role, 'assistant');
    assert.equal(built[2].content, null);
    assert.equal(built[2].tool_calls.length, 1);
    assert.equal(built[2].tool_calls[0].id, 'call_abc_123');
    assert.equal(built[2].tool_calls[0].type, 'function');
    assert.equal(built[2].tool_calls[0].function.name, 'lookup_vendor');
    assert.equal(built[2].tool_calls[0].function.arguments, JSON.stringify({ query: 'Amazon' }));

    // Tool response turn
    assert.equal(built[3].role, 'tool');
    assert.equal(built[3].tool_call_id, 'call_abc_123');
    assert.equal(typeof built[3].content, 'string');
    assert.ok(built[3].content.includes('cp-aws-01'));
  });
});

// =========================================================================
// SECTION 4: AGENT LOOP & ORCHESTRATION TESTS
// =========================================================================

describe('Session 3 — BookkeepingAgent Loop & Orchestration Tests', () => {
  let repos;

  beforeEach(() => {
    repos = createFakeRepos();
  });

  test('1. No-tool agent response: model categorizes directly', async () => {
    const mockProvider = new MockProvider({
      name: 'gemini',
      model: 'gemini-1.5-flash',
      responses: [
        new LLMResponse({
          text: JSON.stringify({
            category: TransactionCategory.CLOUD_INFRASTRUCTURE,
            confidence: 0.95,
            decision: AgentDecision.CATEGORIZED,
            matchedInvoiceId: null,
            matchedVendorId: null,
            reasoning: 'Standard cloud infrastructure transaction',
            evidence: ['Bank description indicates cloud vendor'],
            needsReview: false
          })
        })
      ]
    });

    const agent = new BookkeepingAgent({
      primaryProvider: mockProvider,
      repos
    });

    const tx = {
      id: 'tx-direct-01',
      amount: 125.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-02',
      description: 'AMAZON WEB SERVICES'
    };

    const result = await agent.processTransaction(tx);

    assert.equal(result.transactionId, 'tx-direct-01');
    assert.equal(result.decision, AgentDecision.CATEGORIZED);
    assert.equal(result.category, TransactionCategory.CLOUD_INFRASTRUCTURE);
    assert.equal(result.confidence, 0.95);
    assert.equal(result.needsReview, false);
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.audit.provider, 'gemini');
    assert.equal(result.audit.fallbackOccurred, false);
    assert.equal(result.audit.toolCalls.length, 0);
  });

  test('2. One tool call: model looks up vendor then concludes', async () => {
    const mockProvider = new MockProvider({
      name: 'gemini',
      model: 'gemini-1.5-flash',
      responses: [
        // Round 1: Model requests lookup_vendor
        new LLMResponse({
          toolCalls: [
            { id: 'call_1', name: 'lookup_vendor', args: { query: 'Amazon Web Services' } }
          ]
        }),
        // Round 2: Model finishes with structured decision
        new LLMResponse({
          text: JSON.stringify({
            category: TransactionCategory.CLOUD_INFRASTRUCTURE,
            confidence: 0.92,
            decision: AgentDecision.CATEGORIZED,
            matchedInvoiceId: null,
            matchedVendorId: 'cp-aws-01',
            reasoning: 'Vendor confirmed as Amazon Web Services',
            evidence: ['lookup_vendor returned cp-aws-01 with similarity > 0.8'],
            needsReview: false
          })
        })
      ]
    });

    const agent = new BookkeepingAgent({
      primaryProvider: mockProvider,
      repos
    });

    const tx = {
      id: 'tx-aws-one-tool',
      amount: 125.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-02',
      description: 'AMAZON WEB SERVICES'
    };

    const result = await agent.processTransaction(tx);

    assert.equal(result.decision, AgentDecision.CATEGORIZED);
    assert.equal(result.matchedVendorId, 'cp-aws-01');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].toolName, 'lookup_vendor');
    assert.equal(result.toolCalls[0].result.error, false);
    assert.equal(result.audit.toolCalls.length, 1);
    assert.equal(mockProvider.callCount, 2);
  });

  test('3. Multiple sequential tool calls: preserves history and audit trail', async () => {
    const mockProvider = new MockProvider({
      name: 'gemini',
      model: 'gemini-1.5-flash',
      responses: [
        // Round 1: Lookup vendor
        new LLMResponse({
          toolCalls: [
            { id: 'call_step1', name: 'lookup_vendor', args: { query: 'Amazon Web Services' } }
          ]
        }),
        // Round 2: Find matching invoice
        new LLMResponse({
          toolCalls: [
            {
              id: 'call_step2',
              name: 'find_matching_invoice',
              args: {
                transaction: {
                  amount: 125.00,
                  currency: 'USD',
                  direction: 'outflow',
                  transaction_date: '2024-03-02'
                }
              }
            }
          ]
        }),
        // Round 3: Check duplicate invoice
        new LLMResponse({
          toolCalls: [
            { id: 'call_step3', name: 'check_duplicate_invoice', args: { invoiceId: 'inv-aws-01' } }
          ]
        }),
        // Round 4: Final JSON match result
        new LLMResponse({
          text: JSON.stringify({
            category: TransactionCategory.CLOUD_INFRASTRUCTURE,
            confidence: 0.98,
            decision: AgentDecision.MATCHED,
            matchedInvoiceId: 'inv-aws-01',
            matchedVendorId: 'cp-aws-01',
            reasoning: 'Exact invoice match found and verified not a duplicate',
            evidence: [
              'Vendor verified via lookup_vendor',
              'Deterministic invoice match found: inv-aws-01',
              'check_duplicate_invoice confirmed no active duplicates'
            ],
            needsReview: false
          })
        })
      ]
    });

    const agent = new BookkeepingAgent({
      primaryProvider: mockProvider,
      repos
    });

    const tx = {
      id: 'tx-multi-tool',
      amount: 125.00,
      currency: 'USD',
      direction: Direction.OUTFLOW,
      transaction_date: '2024-03-02',
      description: 'AMAZON WEB SERVICES'
    };

    const result = await agent.processTransaction(tx);

    assert.equal(result.decision, AgentDecision.MATCHED);
    assert.equal(result.matchedInvoiceId, 'inv-aws-01');
    assert.equal(result.matchedVendorId, 'cp-aws-01');
    assert.equal(result.confidence, 0.98);
    assert.equal(result.toolCalls.length, 3);
    assert.equal(result.toolCalls[0].toolName, 'lookup_vendor');
    assert.equal(result.toolCalls[1].toolName, 'find_matching_invoice');
    assert.equal(result.toolCalls[2].toolName, 'check_duplicate_invoice');
    assert.equal(result.audit.toolCalls.length, 3);
    assert.equal(mockProvider.callCount, 4);

    // Verify structured history passed to provider:
    // In call #4, message history should contain 1 user + 3*(1 model + 1 tool) = 7 messages
    const lastRequest = mockProvider.history[3];
    assert.equal(lastRequest.messages.length, 7);
    assert.equal(lastRequest.messages[1].role, 'model');
    assert.ok(Array.isArray(lastRequest.messages[1].toolCalls));
    assert.equal(lastRequest.messages[2].role, 'tool');
    assert.equal(lastRequest.messages[3].role, 'model');
    assert.ok(Array.isArray(lastRequest.messages[3].toolCalls));
    assert.equal(lastRequest.messages[4].role, 'tool');
  });

  test('4. Unknown tool handled safely without crash', async () => {
    const mockProvider = new MockProvider({
      name: 'gemini',
      model: 'gemini-1.5-flash',
      responses: [
        new LLMResponse({
          toolCalls: [{ id: 'call_bad', name: 'non_existent_tool', args: {} }]
        }),
        new LLMResponse({
          text: JSON.stringify({
            category: null,
            confidence: 0,
            decision: AgentDecision.NEEDS_REVIEW,
            matchedInvoiceId: null,
            matchedVendorId: null,
            reasoning: 'Tool unavailable, flagged for review',
            evidence: [],
            needsReview: true
          })
        })
      ]
    });

    const agent = new BookkeepingAgent({ primaryProvider: mockProvider, repos });
    const result = await agent.processTransaction({ id: 'tx-unknown-tool', amount: 50, currency: 'USD', direction: 'outflow', transaction_date: '2024-01-01' });

    assert.equal(result.decision, AgentDecision.NEEDS_REVIEW);
    assert.equal(result.needsReview, true);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].result.code, 'UNKNOWN_TOOL');
  });

  test('5. Invalid arguments to tool handled safely', async () => {
    const mockProvider = new MockProvider({
      name: 'gemini',
      model: 'gemini-1.5-flash',
      responses: [
        new LLMResponse({
          toolCalls: [{ id: 'call_inv', name: 'lookup_vendor', args: { query: '' } }] // empty query -> INVALID_ARGUMENT
        }),
        new LLMResponse({
          text: JSON.stringify({
            category: null,
            confidence: 0,
            decision: AgentDecision.NEEDS_REVIEW,
            matchedInvoiceId: null,
            matchedVendorId: null,
            reasoning: 'Vendor lookup query was invalid',
            evidence: [],
            needsReview: true
          })
        })
      ]
    });

    const agent = new BookkeepingAgent({ primaryProvider: mockProvider, repos });
    const result = await agent.processTransaction({ id: 'tx-invalid-args', amount: 50, currency: 'USD', direction: 'outflow', transaction_date: '2024-01-01' });

    assert.equal(result.decision, AgentDecision.NEEDS_REVIEW);
    assert.equal(result.toolCalls[0].result.code, 'INVALID_ARGUMENT');
  });

  test('6. Max iterations enforced when model loops tools indefinitely', async () => {
    const loopingResponses = [
      new LLMResponse({ toolCalls: [{ id: 'c1', name: 'calculate_amount_difference', args: { expectedAmount: 10, actualAmount: 10 } }] }),
      new LLMResponse({ toolCalls: [{ id: 'c2', name: 'calculate_amount_difference', args: { expectedAmount: 10, actualAmount: 10 } }] }),
      new LLMResponse({ toolCalls: [{ id: 'c3', name: 'calculate_amount_difference', args: { expectedAmount: 10, actualAmount: 10 } }] }),
      // Forced final answer after limit reached (tools=[])
      new LLMResponse({
        text: JSON.stringify({
          category: null,
          confidence: 0,
          decision: AgentDecision.NEEDS_REVIEW,
          reasoning: 'Reached maximum tool loop limit',
          evidence: [],
          needsReview: true
        })
      })
    ];

    const mockProvider = new MockProvider({ name: 'gemini', responses: loopingResponses });
    const agent = new BookkeepingAgent({
      primaryProvider: mockProvider,
      repos,
      maxToolIterations: 3
    });

    const result = await agent.processTransaction({ id: 'tx-loop', amount: 10, currency: 'USD', direction: 'outflow', transaction_date: '2024-01-01' });

    assert.equal(result.decision, AgentDecision.NEEDS_REVIEW);
    assert.equal(result.needsReview, true);
    assert.equal(result.toolCalls.length, 3);
    // 3 tool calls + 1 final forced response
    assert.equal(mockProvider.callCount, 4);
  });

  test('7. Gemini rate-limit triggers seamless OpenRouter fallback', async () => {
    const geminiPrimary = new MockProvider({
      name: 'gemini',
      model: 'gemini-1.5-flash',
      responses: [
        new RetryableProviderError('Rate limit exceeded (HTTP 429)', { statusCode: 429 })
      ]
    });

    const openRouterFallback = new MockProvider({
      name: 'openrouter',
      model: 'openai/gpt-4o-mini',
      responses: [
        new LLMResponse({
          text: JSON.stringify({
            category: TransactionCategory.SOFTWARE,
            confidence: 0.90,
            decision: AgentDecision.CATEGORIZED,
            matchedInvoiceId: null,
            matchedVendorId: null,
            reasoning: 'Handled via OpenRouter fallback successfully',
            evidence: ['Software subscription'],
            needsReview: false
          })
        })
      ]
    });

    const agent = new BookkeepingAgent({
      primaryProvider: geminiPrimary,
      fallbackProvider: openRouterFallback,
      repos
    });

    const tx = { id: 'tx-fallback-01', amount: 42.00, currency: 'USD', direction: 'outflow', transaction_date: '2024-03-04', description: 'GITHUB' };
    const result = await agent.processTransaction(tx);

    assert.equal(result.decision, AgentDecision.CATEGORIZED);
    assert.equal(result.category, TransactionCategory.SOFTWARE);
    assert.equal(result.confidence, 0.90);
    assert.equal(result.audit.fallbackOccurred, true);
    assert.equal(result.audit.provider, 'openrouter');
    assert.equal(result.audit.model, 'openai/gpt-4o-mini');
    assert.equal(geminiPrimary.callCount, 1);
    assert.equal(openRouterFallback.callCount, 1);
  });

  test('8. Both providers unavailable: returns clean FAILED result flagged for review', async () => {
    const geminiPrimary = new MockProvider({
      name: 'gemini',
      responses: [
        new RetryableProviderError('Gemini 503 Overloaded', { statusCode: 503 })
      ]
    });

    const openRouterFallback = new MockProvider({
      name: 'openrouter',
      responses: [
        new RetryableProviderError('OpenRouter 502 Bad Gateway', { statusCode: 502 })
      ]
    });

    const agent = new BookkeepingAgent({
      primaryProvider: geminiPrimary,
      fallbackProvider: openRouterFallback,
      repos
    });

    const result = await agent.processTransaction({ id: 'tx-both-down', amount: 100, currency: 'USD', direction: 'outflow', transaction_date: '2024-01-01' });

    assert.equal(result.decision, AgentDecision.FAILED);
    assert.equal(result.confidence, 0);
    assert.equal(result.needsReview, true);
    assert.ok(result.reasoning.includes('Primary provider (gemini) failed'));
    assert.ok(result.reasoning.includes('Fallback provider (openrouter) also failed'));
    assert.equal(result.audit.finalDecision, AgentDecision.FAILED);
  });

  test('9. Ambiguous Session 2 reconciliation forces needsReview: true', async () => {
    // Repository with two nearly identical invoices
    const ambiguousRepos = createFakeRepos({
      invoices: [
        {
          id: 'inv-amb-01',
          invoice_number: 'INV-A',
          document_type: DocumentType.PAYABLE,
          counterparty_name: 'Acme Software LLC',
          issue_date: '2024-03-01',
          due_date: '2024-03-31',
          currency: 'USD',
          total: 500.00
        },
        {
          id: 'inv-amb-02',
          invoice_number: 'INV-B',
          document_type: DocumentType.PAYABLE,
          counterparty_name: 'Acme Software Inc',
          issue_date: '2024-03-01',
          due_date: '2024-03-31',
          currency: 'USD',
          total: 500.00
        }
      ]
    });

    const mockProvider = new MockProvider({
      name: 'gemini',
      responses: [
        // Round 1: Call find_matching_invoice
        new LLMResponse({
          toolCalls: [{
            id: 'c1',
            name: 'find_matching_invoice',
            args: {
              transaction: {
                amount: 500.00,
                currency: 'USD',
                direction: 'outflow',
                transaction_date: '2024-03-02',
                description: 'ACME SOFTWARE'
              }
            }
          }]
        }),
        // Round 2: Model notes ambiguity from tool and flags for review
        new LLMResponse({
          text: JSON.stringify({
            category: TransactionCategory.SOFTWARE,
            confidence: 0,
            decision: AgentDecision.NEEDS_REVIEW,
            matchedInvoiceId: null,
            matchedVendorId: null,
            reasoning: 'Session 2 deterministic matcher reported ambiguity between two candidate invoices',
            evidence: ['Two candidate invoices scored identically within ambiguity window'],
            needsReview: true
          })
        })
      ]
    });

    const agent = new BookkeepingAgent({ primaryProvider: mockProvider, repos: ambiguousRepos });
    const tx = { id: 'tx-amb', amount: 500.00, currency: 'USD', direction: 'outflow', transaction_date: '2024-03-02', description: 'ACME SOFTWARE' };
    const result = await agent.processTransaction(tx);

    assert.equal(result.decision, AgentDecision.NEEDS_REVIEW);
    assert.equal(result.needsReview, true);
    assert.equal(result.matchedInvoiceId, null);
    assert.equal(result.toolCalls[0].result.ambiguous, true);
  });

  test('10. Insufficient evidence forces needsReview: true with null values, no hallucinations', async () => {
    const mockProvider = new MockProvider({
      name: 'gemini',
      responses: [
        new LLMResponse({
          toolCalls: [{
            id: 'c1',
            name: 'lookup_vendor',
            args: { query: 'UNKNOWN MYSTERY CORP' }
          }]
        }),
        new LLMResponse({
          text: JSON.stringify({
            category: null,
            confidence: 0,
            decision: AgentDecision.NEEDS_REVIEW,
            matchedInvoiceId: null,
            matchedVendorId: null,
            reasoning: 'No matching vendor found in repository. Insufficient evidence.',
            evidence: ['lookup_vendor returned 0 matches'],
            needsReview: true
          })
        })
      ]
    });

    const agent = new BookkeepingAgent({ primaryProvider: mockProvider, repos });
    const tx = { id: 'tx-insufficient', amount: 99.99, currency: 'USD', direction: 'outflow', transaction_date: '2024-01-01', description: 'UNKNOWN MYSTERY CORP' };
    const result = await agent.processTransaction(tx);

    assert.equal(result.category, null);
    assert.equal(result.confidence, 0);
    assert.equal(result.decision, AgentDecision.NEEDS_REVIEW);
    assert.equal(result.matchedInvoiceId, null);
    assert.equal(result.matchedVendorId, null);
    assert.equal(result.needsReview, true);
  });

  test('11. Invariant: model cannot override Session 2 rejection with pre-computed result', async () => {
    // Session 2 matcher pre-computed result says direction is rejected
    const session2Rejection = {
      decision: 'rejected',
      candidateId: null,
      score: 0,
      rejectionReason: 'incompatible_direction'
    };

    const mockProvider = new MockProvider({
      name: 'gemini',
      responses: [
        new LLMResponse({
          text: JSON.stringify({
            category: null,
            confidence: 0,
            decision: AgentDecision.REJECTED,
            matchedInvoiceId: null,
            matchedVendorId: null,
            reasoning: 'Deterministic rejection due to incompatible direction cannot be overridden',
            evidence: ['Session 2 pre-computed rejection authoritative'],
            needsReview: true
          })
        })
      ]
    });

    const agent = new BookkeepingAgent({ primaryProvider: mockProvider, repos });
    const tx = { id: 'tx-rej', amount: 100, currency: 'USD', direction: 'inflow', transaction_date: '2024-01-01' };
    const result = await agent.processTransaction(tx, { session2Result: session2Rejection });

    assert.equal(result.decision, AgentDecision.REJECTED);
    assert.equal(result.matchedInvoiceId, null);
    // Ensure the transaction message sent to model contains the Session 2 authoritative warning
    const userPrompt = mockProvider.history[0].messages[0].content;
    assert.ok(userPrompt.includes('Pre-computed Session 2 Deterministic Match Result'));
    assert.ok(userPrompt.includes('must not override direction, currency, amount, or date-window rejections'));
  });
});

// =========================================================================
// SESSION 3.5: GEMINI TRANSIENT RETRY + OPENROUTER FALLBACK
// =========================================================================

function makeGeminiHttpError(status, statusName, message) {
  const err = new Error(JSON.stringify({
    error: { code: status, message, status: statusName }
  }));
  err.status = status;
  return err;
}

function makeSequencedGenAI(outcomes) {
  const state = { calls: 0 };
  return {
    state,
    models: {
      generateContent: async () => {
        const next = outcomes[state.calls];
        state.calls += 1;
        if (next === undefined) {
          throw new Error(`unexpected extra Gemini generateContent call #${state.calls}`);
        }
        if (next instanceof Error) throw next;
        return next;
      }
    }
  };
}

function categorizedGeminiRaw(reasoning) {
  return {
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify({
            category: TransactionCategory.SOFTWARE,
            confidence: 0.90,
            decision: AgentDecision.CATEGORIZED,
            matchedInvoiceId: null,
            matchedVendorId: null,
            reasoning,
            evidence: ['Bank description indicates software vendor'],
            needsReview: false
          })
        }]
      }
    }]
  };
}

describe('Session 3.5 — Gemini transient retry and OpenRouter fallback', () => {
  let repos;

  beforeEach(() => {
    repos = createFakeRepos();
  });

  test('1. Gemini 503 then 503 then success: stays on Gemini, no fallback', async () => {
    const delays = [];
    const genAI = makeSequencedGenAI([
      makeGeminiHttpError(503, 'UNAVAILABLE', 'This model is currently experiencing high demand.'),
      makeGeminiHttpError(503, 'UNAVAILABLE', 'This model is currently experiencing high demand.'),
      categorizedGeminiRaw('Recovered after transient Gemini 503s')
    ]);

    const gemini = new GeminiProvider({
      apiKey: 'test-api-key',
      genAI,
      maxRetries: 2,
      baseDelayMs: 1000,
      sleep: async (ms) => { delays.push(ms); }
    });

    const agent = new BookkeepingAgent({
      primaryProvider: gemini,
      fallbackProvider: new MockProvider({
        name: 'openrouter',
        model: 'openai/gpt-4o-mini',
        responses: [
          new LLMResponse({
            text: JSON.stringify({
              category: TransactionCategory.SOFTWARE,
              confidence: 0.1,
              decision: AgentDecision.CATEGORIZED,
              matchedInvoiceId: null,
              matchedVendorId: null,
              reasoning: 'Should not be used',
              evidence: [],
              needsReview: false
            })
          })
        ]
      }),
      repos
    });

    const result = await agent.processTransaction({
      id: 'tx-retry-success',
      amount: 42.00,
      currency: 'USD',
      direction: 'outflow',
      transaction_date: '2024-03-04',
      description: 'GITHUB'
    });

    assert.equal(result.decision, AgentDecision.CATEGORIZED);
    assert.equal(result.audit.provider, 'gemini');
    assert.equal(result.audit.fallbackOccurred, false);
    assert.equal(result.audit.fallbackFrom, null);
    assert.equal(genAI.state.calls, 3);
    assert.deepEqual(delays, [1000, 2000]);
  });

  test('2. Gemini 503 exhausted then OpenRouter succeeds', async () => {
    const genAI = makeSequencedGenAI([
      makeGeminiHttpError(503, 'UNAVAILABLE', 'This model is currently experiencing high demand.'),
      makeGeminiHttpError(503, 'UNAVAILABLE', 'This model is currently experiencing high demand.'),
      makeGeminiHttpError(503, 'UNAVAILABLE', 'This model is currently experiencing high demand.')
    ]);

    const gemini = new GeminiProvider({
      apiKey: 'test-api-key',
      genAI,
      maxRetries: 2,
      baseDelayMs: 1000,
      sleep: async () => {}
    });

    const openRouterFallback = new MockProvider({
      name: 'openrouter',
      model: 'openai/gpt-4o-mini',
      responses: [
        new LLMResponse({
          text: JSON.stringify({
            category: TransactionCategory.SOFTWARE,
            confidence: 0.90,
            decision: AgentDecision.CATEGORIZED,
            matchedInvoiceId: null,
            matchedVendorId: null,
            reasoning: 'Handled via OpenRouter after Gemini retries exhausted',
            evidence: ['Software subscription'],
            needsReview: false
          })
        })
      ]
    });

    const agent = new BookkeepingAgent({
      primaryProvider: gemini,
      fallbackProvider: openRouterFallback,
      repos
    });

    const result = await agent.processTransaction({
      id: 'tx-retry-fallback-503',
      amount: 42.00,
      currency: 'USD',
      direction: 'outflow',
      transaction_date: '2024-03-04',
      description: 'GITHUB'
    });

    assert.equal(result.decision, AgentDecision.CATEGORIZED);
    assert.equal(result.audit.fallbackOccurred, true);
    assert.equal(result.audit.provider, 'openrouter');
    assert.equal(result.audit.fallbackFrom, 'gemini');
    assert.equal(result.audit.fallbackReason, '503 UNAVAILABLE');
    assert.equal(genAI.state.calls, 3);
    assert.equal(openRouterFallback.callCount, 1);
  });

  test('3. Gemini 429 retries then OpenRouter fallback', async () => {
    const genAI = makeSequencedGenAI([
      makeGeminiHttpError(429, 'RESOURCE_EXHAUSTED', 'Rate limit exceeded'),
      makeGeminiHttpError(429, 'RESOURCE_EXHAUSTED', 'Rate limit exceeded'),
      makeGeminiHttpError(429, 'RESOURCE_EXHAUSTED', 'Rate limit exceeded')
    ]);

    const gemini = new GeminiProvider({
      apiKey: 'test-api-key',
      genAI,
      maxRetries: 2,
      sleep: async () => {}
    });

    const openRouterFallback = new MockProvider({
      name: 'openrouter',
      model: 'openai/gpt-4o-mini',
      responses: [
        new LLMResponse({
          text: JSON.stringify({
            category: TransactionCategory.SOFTWARE,
            confidence: 0.88,
            decision: AgentDecision.CATEGORIZED,
            matchedInvoiceId: null,
            matchedVendorId: null,
            reasoning: 'Handled via OpenRouter after Gemini 429',
            evidence: ['Software subscription'],
            needsReview: false
          })
        })
      ]
    });

    const agent = new BookkeepingAgent({
      primaryProvider: gemini,
      fallbackProvider: openRouterFallback,
      repos
    });

    const result = await agent.processTransaction({
      id: 'tx-retry-fallback-429',
      amount: 42.00,
      currency: 'USD',
      direction: 'outflow',
      transaction_date: '2024-03-04',
      description: 'GITHUB'
    });

    assert.equal(result.decision, AgentDecision.CATEGORIZED);
    assert.equal(result.audit.fallbackOccurred, true);
    assert.equal(result.audit.provider, 'openrouter');
    assert.equal(result.audit.fallbackFrom, 'gemini');
    assert.equal(result.audit.fallbackReason, '429 RESOURCE_EXHAUSTED');
    assert.equal(genAI.state.calls, 3);
    assert.equal(openRouterFallback.callCount, 1);
  });

  test('4. Gemini invalid request: no retry and no OpenRouter fallback', async () => {
    const genAI = makeSequencedGenAI([
      makeGeminiHttpError(400, 'INVALID_ARGUMENT', 'Invalid request: malformed function call')
    ]);

    const gemini = new GeminiProvider({
      apiKey: 'test-api-key',
      genAI,
      maxRetries: 2,
      sleep: async () => {
        throw new Error('sleep should not be called for invalid requests');
      }
    });

    const openRouterFallback = new MockProvider({
      name: 'openrouter',
      model: 'openai/gpt-4o-mini',
      responses: [
        new LLMResponse({
          text: JSON.stringify({
            category: TransactionCategory.SOFTWARE,
            confidence: 0.90,
            decision: AgentDecision.CATEGORIZED,
            matchedInvoiceId: null,
            matchedVendorId: null,
            reasoning: 'Should not hide Gemini application bugs',
            evidence: [],
            needsReview: false
          })
        })
      ]
    });

    const agent = new BookkeepingAgent({
      primaryProvider: gemini,
      fallbackProvider: openRouterFallback,
      repos
    });

    const result = await agent.processTransaction({
      id: 'tx-invalid-request',
      amount: 42.00,
      currency: 'USD',
      direction: 'outflow',
      transaction_date: '2024-03-04',
      description: 'GITHUB'
    });

    assert.equal(result.decision, AgentDecision.FAILED);
    assert.equal(result.needsReview, true);
    assert.equal(result.audit.fallbackOccurred, false);
    assert.equal(result.audit.provider, 'gemini');
    assert.equal(genAI.state.calls, 1);
    assert.equal(openRouterFallback.callCount, 0);
  });
});
