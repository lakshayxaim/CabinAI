/**
 * Deterministic string normalization and similarity algorithms for CabinAI Session 2.
 * Pure JavaScript, no external libraries, no LLMs, no network calls.
 */

// Common legal and corporate entity suffixes to strip safely
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated',
  'corp', 'corporation',
  'llc', 'llp', 'lp', 'lc',
  'ltd', 'limited',
  'co', 'company',
  'gmbh', 'ag', 'sa', 'sarl', 'bv', 'nv',
  'plc', 'pty', 'pvt'
]);

// Common transaction / banking noise words found in bank statement descriptions
const BANKING_NOISE_WORDS = new Set([
  'wire', 'payment', 'transfer', 'payout', 'sub', 'subscription',
  'ach', 'direct', 'deposit', 'dir', 'dep', 'debit', 'credit',
  'bill', 'pay', 'online', 'card', 'pos', 'ref', 'reference', 'txn', 'transaction',
  'fee', 'charge', 'purchase', 'withdrawal', 'check', 'chk', 'bank',
  'monthly', 'annual', 'autopay', 'statement', 'invoice', 'inv'
]);

/**
 * Deterministically normalizes vendor / counterparty name string:
 * - lowercase
 * - trim whitespace
 * - normalize punctuation and symbols (e.g. & -> and)
 * - normalize repeated whitespace
 * - remove non-semantic corporate suffixes where safe
 * @param {string} str 
 * @returns {string} Clean normalized string
 */
function normalizeCounterparty(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }

  let s = str.trim().toLowerCase();

  // Replace ampersand with 'and'
  s = s.replace(/&/g, ' and ');

  // Remove common punctuation and apostrophes: e.g. "O'Reilly" -> "oreilly", "Inc." -> "inc"
  s = s.replace(/['’]/g, '');

  // Replace all non-alphanumeric characters with space
  s = s.replace(/[^a-z0-9]/g, ' ');

  // Collapse repeated whitespace
  s = s.replace(/\s+/g, ' ').trim();

  // Split into tokens
  let tokens = s.split(' ').filter(Boolean);

  if (tokens.length === 0) {
    return '';
  }

  // Remove trailing legal suffixes if there is more than 1 token remaining
  // e.g. "amazon web services inc" -> "amazon web services"
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  return tokens.join(' ');
}

/**
 * Conservatively extracts and normalizes the core vendor tokens from a bank transaction description.
 * Strips banking transaction noise words (e.g. WIRE, PAYMENT, TRANSFER, ACH),
 * corporate suffixes, digits, and reference code patterns.
 * If all tokens are noise/reference tokens, returns empty string so that raw noise
 * cannot be falsely attributed as vendor identity.
 *
 * @param {string} description 
 * @returns {string} Clean conservative counterparty representation from bank description
 */
function extractBankCounterparty(description) {
  if (!description || typeof description !== 'string') {
    return '';
  }

  let s = description.trim().toLowerCase();
  s = s.replace(/&/g, ' and ');
  s = s.replace(/['’]/g, '');
  s = s.replace(/[^a-z0-9]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  const tokens = s.split(' ').filter(Boolean);
  if (tokens.length === 0) {
    return '';
  }

  // Filter out noise words, corporate suffixes, tokens with digits, and reference patterns
  const filtered = tokens.filter(t => {
    if (BANKING_NOISE_WORDS.has(t)) return false;
    if (LEGAL_SUFFIXES.has(t)) return false;
    if (/\d/.test(t)) return false; // Reference codes, dates, numbers (e.g. 9841, ref01, inv102)
    if (/^(ref|txn|inv|chk|trf)[a-z0-9]*$/.test(t)) return false;
    return true;
  });

  if (filtered.length === 0) {
    return '';
  }

  // Deduplicate repeated consecutive tokens (e.g. "acme acme" -> "acme")
  const uniqueTokens = [];
  for (const t of filtered) {
    if (uniqueTokens.length === 0 || uniqueTokens[uniqueTokens.length - 1] !== t) {
      uniqueTokens.push(t);
    }
  }

  return uniqueTokens.join(' ');
}

/**
 * Computes Jaro similarity between two strings (0.0 to 1.0).
 * Pure JS implementation.
 * @param {string} s1 
 * @param {string} s2 
 * @returns {number}
 */
function jaroDistance(s1, s2) {
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const len1 = s1.length;
  const len2 = s2.length;
  const matchDistance = Math.floor(Math.max(len1, len2) / 2) - 1;

  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);

    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const m = matches;
  const t = transpositions / 2;
  return ((m / len1) + (m / len2) + ((m - t) / m)) / 3;
}

/**
 * Computes Jaro-Winkler similarity between two strings (0.0 to 1.0).
 * Adds a prefix bonus (standard p = 0.1, max 4 characters).
 * @param {string} s1 
 * @param {string} s2 
 * @returns {number}
 */
function jaroWinkler(s1, s2) {
  const jaro = jaroDistance(s1, s2);
  if (jaro < 0.7) return jaro;

  let prefixLength = 0;
  const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) {
      prefixLength++;
    } else {
      break;
    }
  }

  const p = 0.1;
  return jaro + prefixLength * p * (1 - jaro);
}

/**
 * Computes token-level similarity between two normalized strings.
 * For each token in s1, finds the highest Jaro-Winkler match in s2, and vice versa.
 * Applies a match floor of 0.75 so non-matching tokens contribute 0.
 * This prevents accidental overlap and generic word false positives.
 * @param {string} s1 
 * @param {string} s2 
 * @returns {number} 0.0 to 1.0
 */
function tokenSimilarity(s1, s2) {
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const t1 = s1.split(' ').filter(Boolean);
  const t2 = s2.split(' ').filter(Boolean);

  if (t1.length === 0 || t2.length === 0) return 0.0;

  const TOKEN_MATCH_FLOOR = 0.75;

  // Best match for each token in t1 against t2
  let sum1 = 0;
  for (const token1 of t1) {
    let maxScore = 0;
    for (const token2 of t2) {
      const score = jaroWinkler(token1, token2);
      if (score > maxScore) maxScore = score;
    }
    sum1 += maxScore >= TOKEN_MATCH_FLOOR ? maxScore : 0;
  }

  // Best match for each token in t2 against t1
  let sum2 = 0;
  for (const token2 of t2) {
    let maxScore = 0;
    for (const token1 of t1) {
      const score = jaroWinkler(token2, token1);
      if (score > maxScore) maxScore = score;
    }
    sum2 += maxScore >= TOKEN_MATCH_FLOOR ? maxScore : 0;
  }

  return (sum1 + sum2) / (t1.length + t2.length);
}

/**
 * Deterministic counterparty similarity evaluator.
 * Conservatively evaluates similarity between bank description/counterparty and document vendor/customer.
 * Raw banking noise and reference tokens from the bank description are excluded so they cannot
 * produce a more permissive similarity score than the cleaned vendor representation.
 *
 * @param {string|null} raw1 First counterparty or bank description
 * @param {string|null} raw2 Second counterparty (vendor or customer name)
 * @returns {{
 *   score: number|null,
 *   isEvaluated: boolean,
 *   normalized1: string|null,
 *   normalized2: string|null,
 *   explanation: string
 * }}
 */
function calculateCounterpartySimilarity(raw1, raw2) {
  if (!raw1 || !raw2 || typeof raw1 !== 'string' || typeof raw2 !== 'string') {
    return {
      score: null,
      isEvaluated: false,
      normalized1: raw1 ? normalizeCounterparty(raw1) : null,
      normalized2: raw2 ? normalizeCounterparty(raw2) : null,
      explanation: 'Counterparty unknown or missing; vendor identity cannot be verified'
    };
  }

  // Conservative bank counterparty extraction:
  // Extract conservative cleaned representation for bank description (raw1).
  // If cleanBank1 is non-empty, use it strictly as the vendor representation.
  // Raw banking noise and reference tokens from raw1 must NEVER be used to inflate
  // or produce a more permissive similarity score than the cleaned representation.
  const cleanBank1 = extractBankCounterparty(raw1);
  const norm1 = normalizeCounterparty(raw1);
  const norm2 = normalizeCounterparty(raw2);

  // If cleanBank1 could not be extracted (e.g. description only contained noise like "CHECK #101"
  // or "WIRE TRANSFER 998"), then no genuine vendor name is present.
  // Fall back to norm1 only if raw1 had no identifiable banking noise keywords.
  const hasNoiseTokens = norm1.split(' ').some(t => BANKING_NOISE_WORDS.has(t) || /\d/.test(t));
  const vendor1 = cleanBank1 || (hasNoiseTokens ? '' : norm1);
  const vendor2 = norm2;

  if (!vendor1 || !vendor2) {
    return {
      score: null,
      isEvaluated: false,
      normalized1: vendor1 || null,
      normalized2: vendor2 || null,
      explanation: 'Counterparty unknown or missing; vendor identity cannot be verified'
    };
  }

  // Exact match between conservative vendor representation and normalized candidate
  if (vendor1 === vendor2) {
    return {
      score: 1.0,
      isEvaluated: true,
      normalized1: vendor1,
      normalized2: vendor2,
      explanation: `Exact normalized counterparty match: "${vendor1}"`
    };
  }

  // Token-level similarity strictly between cleaned vendor1 and normalized vendor2.
  // Conservative: Raw banking noise tokens in raw1 are excluded so they cannot produce
  // an accidental or permissive match.
  const tokenScore = tokenSimilarity(vendor1, vendor2);

  // If token score is 0 (no common or similar tokens at all), strings are completely different
  if (tokenScore === 0) {
    return {
      score: 0.0,
      isEvaluated: true,
      normalized1: vendor1,
      normalized2: vendor2,
      explanation: `No counterparty match (0.0%): "${vendor1}" vs "${vendor2}"`
    };
  }

  const finalScore = Math.round(tokenScore * 1000) / 1000;

  let explanation;
  if (finalScore >= 0.85) {
    explanation = `High counterparty similarity (${(finalScore * 100).toFixed(1)}%): "${vendor1}" vs "${vendor2}"`;
  } else if (finalScore >= 0.60) {
    explanation = `Moderate counterparty similarity (${(finalScore * 100).toFixed(1)}%): "${vendor1}" vs "${vendor2}"`;
  } else {
    explanation = `Low counterparty similarity (${(finalScore * 100).toFixed(1)}%): "${vendor1}" vs "${vendor2}"`;
  }

  return {
    score: finalScore,
    isEvaluated: true,
    normalized1: vendor1,
    normalized2: vendor2,
    explanation
  };
}

module.exports = {
  LEGAL_SUFFIXES,
  BANKING_NOISE_WORDS,
  normalizeCounterparty,
  extractBankCounterparty,
  jaroDistance,
  jaroWinkler,
  tokenSimilarity,
  calculateCounterpartySimilarity
};
