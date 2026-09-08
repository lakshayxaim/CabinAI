'use strict';

/* CabinAI showcase frontend — vanilla JS thin adapter over /api/*. No business logic. */

const YELLOW_FLAGS = new Set([
  'DATE_OUTSIDE_WINDOW',
  'POSSIBLE_DUPLICATE',
  'PROVIDER_PAYOUT_UNRECONCILED',
  'INSUFFICIENT_EVIDENCE'
]);

const state = { transactions: [] };

function severity(tx) {
  if (!tx.needsReview) return 'green';
  const flags = tx.redFlags || [];
  if (flags.length > 0 && flags.every(f => YELLOW_FLAGS.has(f.code))) return 'yellow';
  return 'red';
}

function dotFor(level) {
  return level === 'green' ? '🟢' : level === 'yellow' ? '🟡' : '🔴';
}

function badgeFor(tx) {
  const level = severity(tx);
  if (level === 'green') {
    if (tx.reviewStatus === 'approved') return '<span class="badge green">Reconciled · Approved by you</span>';
    if (tx.reviewStatus === 'corrected') return '<span class="badge green">Reconciled · Corrected by you</span>';
    return '<span class="badge green">Reconciled</span>';
  }
  if (level === 'yellow') return '<span class="badge yellow">Check recommended</span>';
  return '<span class="badge red">Needs attention</span>';
}

function formatAmount(tx) {
  const sign = tx.direction === 'outflow' ? '−' : '+';
  const abs = Math.abs(tx.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${abs}`;
}

function attentionSummary(tx) {
  if (tx.redFlags && tx.redFlags.length > 0) return tx.redFlags[0].message;
  return 'Needs confirmation';
}

function reconciledSummary(tx) {
  const parts = [];
  if (tx.matchedInvoice) parts.push(tx.matchedInvoice.number ? `Invoice ${tx.matchedInvoice.number} matched` : 'Invoice matched');
  if (tx.category) parts.push(tx.category);
  return parts.join(' · ') || tx.status;
}

function render() {
  const txs = state.transactions;
  const attention = txs.filter(t => t.needsReview);
  const reconciled = txs.filter(t => !t.needsReview);

  document.getElementById('stat-total').textContent = txs.length;
  document.getElementById('stat-reconciled').textContent = reconciled.length;
  document.getElementById('stat-attention').textContent = attention.length;

  const attentionEl = document.getElementById('attention-list');
  attentionEl.innerHTML = attention.length === 0
    ? '<div class="empty">Nothing needs your attention. 🎉</div>'
    : attention.map(tx => `
      <div class="card">
        <div class="dot">${dotFor(severity(tx))}</div>
        <div class="main">
          <div class="row"><span class="title">${escapeHtml(tx.description)}</span><span class="amount">${formatAmount(tx)}</span></div>
          <div class="sub">${escapeHtml(attentionSummary(tx))}</div>
          ${badgeFor(tx)}
          <div class="foot"><button class="btn small" data-review="${tx.id}">Review</button></div>
        </div>
      </div>`).join('');

  const reconciledEl = document.getElementById('reconciled-list');
  reconciledEl.innerHTML = reconciled.length === 0
    ? '<div class="empty">No reconciled transactions yet. Run reconciliation to get started.</div>'
    : reconciled.map(tx => `
      <div class="card">
        <div class="dot">${dotFor('green')}</div>
        <div class="main">
          <div class="row"><span class="title">${escapeHtml(tx.description)}</span><span class="amount">${formatAmount(tx)}</span></div>
          <div class="sub">${escapeHtml(reconciledSummary(tx))}</div>
          ${badgeFor(tx)}
        </div>
      </div>`).join('');

  attentionEl.querySelectorAll('[data-review]').forEach(btn => {
    btn.addEventListener('click', () => openDetail(btn.getAttribute('data-review')));
  });
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function load() {
  const res = await fetch('/api/transactions');
  if (!res.ok) throw new Error('failed to load transactions');
  const body = await res.json();
  state.transactions = body.transactions || [];
  render();
}

function openDetail(id) {
  const tx = state.transactions.find(t => t.id === id);
  if (!tx) return;
  const level = severity(tx);
  const why = [];
  (tx.redFlags || []).forEach(f => why.push(escapeHtml(f.message)));
  if (tx.reasoning) why.push(escapeHtml(tx.reasoning));
  (tx.evidence || []).forEach(e => why.push(escapeHtml(e)));

  const invoiceHtml = tx.matchedInvoice
    ? `<div class="invoice-box"><strong>${escapeHtml(tx.matchedInvoice.number || tx.matchedInvoice.id)}</strong><br/>$${tx.matchedInvoice.total} ${escapeHtml(tx.matchedInvoice.currency || '')}</div>`
    : '<div class="sub">No invoice linked.</div>';

  document.getElementById('detail-body').innerHTML = `
    <h3>${escapeHtml(tx.description)}</h3>
    <div class="amount-big">${formatAmount(tx)}</div>
    <div class="date">${escapeHtml(tx.date || '')}</div>
    <div>${badgeFor(tx)}</div>
    <h4>Why we're asking you to review</h4>
    ${level === 'green'
      ? '<p>CabinAI checked this transaction automatically — no action needed.</p>'
      : (why.length ? `<ul>${why.map(w => `<li>${w}</li>`).join('')}</ul>` : '<p>No details available.</p>' )}
    <h4>Related invoice</h4>
    ${invoiceHtml}
    <h4>Suggested category</h4>
    <div>${escapeHtml(tx.category || '—')}</div>
    <div class="detail-actions">
      <button id="btn-approve" class="btn primary">Approve</button>
      <button id="btn-correct-toggle" class="btn">Correct</button>
    </div>
    <div id="correct-form" class="correct-form" style="display:none">
      <label>Category <input id="f-category" value="${escapeHtml(tx.category || '')}" /></label>
      <label>Matched invoice ID <input id="f-invoice" value="${escapeHtml((tx.matchedInvoice && tx.matchedInvoice.id) || '')}" /></label>
      <label>Matched vendor ID <input id="f-vendor" value="${escapeHtml(tx.matchedVendorId || '')}" /></label>
      <label>Decision
        <select id="f-decision">
          ${['matched', 'categorized', 'unmatched', 'rejected', 'needs_review'].map(d =>
            `<option value="${d}"${tx.status === d ? ' selected' : ''}>${d}</option>`).join('')}
        </select>
      </label>
      <label>Reason <input id="f-reason" placeholder="Why are you correcting this?" /></label>
      <div class="detail-actions"><button id="btn-correct-submit" class="btn primary">Submit correction</button></div>
    </div>`;

  document.getElementById('detail-overlay').classList.remove('hidden');
  document.getElementById('btn-approve').addEventListener('click', async () => {
    await fetch(`/api/reviews/${tx.id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
    });
    closeDetail();
    await load();
  });
  document.getElementById('btn-correct-toggle').addEventListener('click', () => {
    const f = document.getElementById('correct-form');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btn-correct-submit').addEventListener('click', async () => {
    const payload = {
      reason: document.getElementById('f-reason').value || null
    };
    const category = document.getElementById('f-category').value.trim();
    const invoiceId = document.getElementById('f-invoice').value.trim();
    const vendorId = document.getElementById('f-vendor').value.trim();
    const finalDecision = document.getElementById('f-decision').value;
    if (category) payload.category = category;
    if (invoiceId) payload.invoiceId = invoiceId;
    if (vendorId) payload.vendorId = vendorId;
    if (finalDecision) payload.finalDecision = finalDecision;
    await fetch(`/api/reviews/${tx.id}/correct`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    closeDetail();
    await load();
  });
}

function closeDetail() {
  document.getElementById('detail-overlay').classList.add('hidden');
}

async function runReconciliation() {
  const btn = document.getElementById('btn-reconcile');
  const status = document.getElementById('run-status');
  btn.disabled = true;
  status.textContent = 'Checking your transactions…';
  try {
    const res = await fetch('/api/reconcile', { method: 'POST' });
    if (!res.ok) throw new Error('reconciliation failed');
    await load();
    status.textContent = 'Reconciliation complete';
  } catch (e) {
    status.textContent = 'Reconciliation failed — is the server running?';
  } finally {
    btn.disabled = false;
  }
}

async function loadDemoData() {
  const status = document.getElementById('run-status');
  status.textContent = 'Loading demo data…';
  try {
    await fetch('/api/demo/seed', { method: 'POST' });
    await runReconciliation();
  } catch (e) {
    status.textContent = 'Could not load demo data.';
  }
}

document.getElementById('btn-reconcile').addEventListener('click', runReconciliation);
document.getElementById('btn-seed').addEventListener('click', loadDemoData);
document.getElementById('detail-close').addEventListener('click', closeDetail);
document.getElementById('detail-overlay').addEventListener('click', e => {
  if (e.target.id === 'detail-overlay') closeDetail();
});

load().catch(() => {
  document.getElementById('run-status').textContent = 'Could not reach the API — is the server running?';
});
