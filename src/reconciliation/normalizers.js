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
  'bill', 'pay', 'online', 'card', 'pos', 'ref', 'txn', 'transaction',
  'fee', 'charge', 'purchase', 'withdrawal', 'check', 'chk', 'bank',
  'monthly', 'annual', 'autopay', 'statement'
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
 * Extracts and normalizes the core vendor tokens from a bank transaction description,
 * stripping common banking transaction descriptors (e.g. WIRE, PAYMENT, TRANSFER)
 * and corporate suffixes.
 * @param {string} description 
 * @returns {string} Normalized counterparty candidate from bank description
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

  // Filter out noise words, digits, and corporate suffixes if other tokens exist
  const filtered = tokens.filter(t => !BANKING_NOISE_WORDS.has(t) && !LEGAL_SUFFIXES.has(t) && !/^\d+$/.test(t));
  if (filtered.length > 0) {
    return filtered.join(' ');
  }

  // If everything was filtered, return normalized base
  return normalizeCounterparty(description);
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
 * Evaluates similarity between bank description/counterparty and document vendor/customer.
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

  const norm1 = normalizeCounterparty(raw1);
  const norm2 = normalizeCounterparty(raw2);

  if (!norm1 || !norm2) {
    return {
      score: null,
      isEvaluated: false,
      normalized1: norm1 || null,
      normalized2: norm2 || null,
      explanation: 'Counterparty name is empty after normalization'
    };
  }

  // Exact normalized match
  if (norm1 === norm2) {
    return {
      score: 1.0,
      isEvaluated: true,
      normalized1: norm1,
      normalized2: norm2,
      explanation: `Exact normalized counterparty match: "${norm1}"`
    };
  }

  // Check bank noise-filtered version
  const cleanBank1 = extractBankCounterparty(raw1);
  const cleanBank2 = extractBankCounterparty(raw2);

  if (cleanBank1 === norm2 || norm1 === cleanBank2 || cleanBank1 === cleanBank2) {
    return {
      score: 1.0,
      isEvaluated: true,
      normalized1: cleanBank1,
      normalized2: cleanBank2,
      explanation: `Exact counterparty match after banking noise removal: "${cleanBank1 || norm1}"`
    };
  }

  // Compute token-level similarity across both regular and noise-cleaned representations
  const baseTokenScore = tokenSimilarity(norm1, norm2);
  const cleanTokenScore1 = cleanBank1 ? tokenSimilarity(cleanBank1, norm2) : 0;
  const cleanTokenScore2 = cleanBank2 ? tokenSimilarity(norm1, cleanBank2) : 0;
  const cleanTokenScoreBoth = (cleanBank1 && cleanBank2) ? tokenSimilarity(cleanBank1, cleanBank2) : 0;

  const bestTokenScore = Math.max(baseTokenScore, cleanTokenScore1, cleanTokenScore2, cleanTokenScoreBoth);

  // If token score is 0 (no common or similar tokens at all), strings are completely different
  if (bestTokenScore === 0) {
    return {
      score: 0.0,
      isEvaluated: true,
      normalized1: norm1,
      normalized2: norm2,
      explanation: `No counterparty match (0.0%): "${norm1}" vs "${norm2}"`
    };
  }

  const finalScore = Math.round(bestTokenScore * 1000) / 1000;

  let explanation;
  if (finalScore >= 0.85) {
    explanation = `High counterparty similarity (${(finalScore * 100).toFixed(1)}%): "${norm1}" vs "${norm2}"`;
  } else if (finalScore >= 0.60) {
    explanation = `Moderate counterparty similarity (${(finalScore * 100).toFixed(1)}%): "${norm1}" vs "${norm2}"`;
  } else {
    explanation = `Low counterparty similarity (${(finalScore * 100).toFixed(1)}%): "${norm1}" vs "${norm2}"`;
  }

  return {
    score: finalScore,
    isEvaluated: true,
    normalized1: norm1,
    normalized2: norm2,
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
