/**
 * Deterministic scoring algorithms for CabinAI Session 2 reconciliation engine.
 * Pure mathematical scoring based on amount, date window, and counterparty similarity.
 */

const { RejectionReason, DEFAULT_CONFIG } = require('./types');
const { calculateCounterpartySimilarity } = require('./normalizers');
const { normalizeCurrency } = require('../normalizers/amountNormalizer');

/**
 * Parses YYYY-MM-DD string to UTC timestamp in milliseconds.
 * @param {string|Date} dateVal 
 * @returns {number|null}
 */
function parseDateToMs(dateVal) {
  if (!dateVal) return null;
  if (dateVal instanceof Date) return dateVal.getTime();
  if (typeof dateVal === 'string') {
    // Extract YYYY-MM-DD
    const match = dateVal.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      const [, y, m, d] = match;
      return Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
    }
    const d = new Date(dateVal);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

/**
 * Calculates the difference in days between two date strings (d1 - d2).
 * Positive if d1 is after d2, negative if d1 is before d2.
 * @param {string|Date} d1 
 * @param {string|Date} d2 
 * @returns {number|null}
 */
function daysDifference(d1, d2) {
  const ms1 = parseDateToMs(d1);
  const ms2 = parseDateToMs(d2);
  if (ms1 === null || ms2 === null) return null;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((ms1 - ms2) / MS_PER_DAY);
}

/**
 * Compares two monetary amounts deterministically.
 * Requires currency equality.
 * @param {number} sourceAmount 
 * @param {number} candidateAmount 
 * @param {string} sourceCurrency 
 * @param {string} candidateCurrency 
 * @param {Object} options 
 * @returns {{
 *   isCompatible: boolean,
 *   isExact: boolean,
 *   difference: number|null,
 *   score: number,
 *   rejectionReason: string|null,
 *   explanation: string
 * }}
 */
function compareAmount(sourceAmount, candidateAmount, sourceCurrency = 'USD', candidateCurrency = 'USD', options = {}) {
  const normSourceCurr = normalizeCurrency(sourceCurrency);
  const normCandCurr = normalizeCurrency(candidateCurrency);

  // 1. Currency compatibility check
  if (normSourceCurr !== normCandCurr) {
    return {
      isCompatible: false,
      isExact: false,
      difference: null,
      score: 0.0,
      rejectionReason: RejectionReason.CURRENCY_MISMATCH,
      explanation: `Currency mismatch: source is ${normSourceCurr}, candidate is ${normCandCurr}`
    };
  }

  // 2. Value existence check
  if (sourceAmount === null || sourceAmount === undefined || candidateAmount === null || candidateAmount === undefined || isNaN(sourceAmount) || isNaN(candidateAmount)) {
    return {
      isCompatible: false,
      isExact: false,
      difference: null,
      score: 0.0,
      rejectionReason: RejectionReason.MISSING_AMOUNT,
      explanation: 'Amount missing or null on one of the records'
    };
  }

  const tolerance = options.amountTolerance !== undefined ? options.amountTolerance : DEFAULT_CONFIG.amountTolerance;
  const diff = Math.round(Math.abs(sourceAmount - candidateAmount) * 100) / 100;

  if (diff === 0) {
    return {
      isCompatible: true,
      isExact: true,
      difference: 0,
      score: 1.0,
      rejectionReason: null,
      explanation: `Exact amount match: ${normSourceCurr} ${sourceAmount.toFixed(2)}`
    };
  }

  if (diff <= tolerance && tolerance > 0) {
    const score = Math.round(Math.max(0.5, 1.0 - (diff / tolerance) * 0.3) * 1000) / 1000;
    return {
      isCompatible: true,
      isExact: false,
      difference: diff,
      score,
      rejectionReason: null,
      explanation: `Amount within configured tolerance of ${tolerance.toFixed(2)}: difference is ${diff.toFixed(2)}`
    };
  }

  return {
    isCompatible: false,
    isExact: false,
    difference: diff,
    score: 0.0,
    rejectionReason: RejectionReason.AMOUNT_MISMATCH,
    explanation: `Amount mismatch: source ${sourceAmount.toFixed(2)} vs candidate ${candidateAmount.toFixed(2)} (diff: ${diff.toFixed(2)})`
  };
}

/**
 * Compares transaction date against invoice or provider candidate dates using accounting semantics.
 * @param {string} sourceDate Bank transaction date (YYYY-MM-DD)
 * @param {{
 *   issueDate?: string|null,
 *   dueDate?: string|null,
 *   transactionDate?: string|null,
 *   arrivalDate?: string|null
 * }} candidateDates Candidate date fields
 * @param {Object} options 
 * @returns {{
 *   isWithinWindow: boolean,
 *   daysDifference: number|null,
 *   score: number,
 *   rejectionReason: string|null,
 *   explanation: string
 * }}
 */
function compareDate(sourceDate, candidateDates = {}, options = {}) {
  const windowDays = options.dateWindowDays !== undefined ? options.dateWindowDays : DEFAULT_CONFIG.dateWindowDays;
  const maxDaysBeforeIssue = options.maxDaysBeforeIssue !== undefined ? options.maxDaysBeforeIssue : DEFAULT_CONFIG.maxDaysBeforeIssue;
  const maxDaysAfterDue = options.maxDaysAfterDue !== undefined ? options.maxDaysAfterDue : DEFAULT_CONFIG.maxDaysAfterDue;

  if (!sourceDate) {
    return {
      isWithinWindow: false,
      daysDifference: null,
      score: 0.0,
      rejectionReason: RejectionReason.DATE_OUTSIDE_WINDOW,
      explanation: 'Source transaction date is missing'
    };
  }

  const { issueDate, dueDate, transactionDate, arrivalDate } = candidateDates;

  // Case A: Invoice with issue_date and/or due_date
  if (issueDate || dueDate) {
    // If both issueDate and dueDate are present
    if (issueDate && dueDate) {
      const diffBeforeIssue = daysDifference(issueDate, sourceDate); // positive if source is before issueDate
      const diffAfterDue = daysDifference(sourceDate, dueDate);       // positive if source is after dueDate

      // On-time payment between issue_date and due_date
      if (diffBeforeIssue <= 0 && diffAfterDue <= 0) {
        return {
          isWithinWindow: true,
          daysDifference: 0,
          score: 1.0,
          rejectionReason: null,
          explanation: `Transaction date (${sourceDate}) is within natural billing window (${issueDate} to ${dueDate})`
        };
      }

      // Early payment before issue_date
      if (diffBeforeIssue > 0) {
        const allowedEarly = Math.min(maxDaysBeforeIssue, windowDays);
        if (diffBeforeIssue <= allowedEarly) {
          const score = Math.round((1.0 - (diffBeforeIssue / (allowedEarly + 1)) * 0.1) * 1000) / 1000;
          return {
            isWithinWindow: true,
            daysDifference: diffBeforeIssue,
            score,
            rejectionReason: null,
            explanation: `Transaction date (${sourceDate}) is ${diffBeforeIssue} day(s) before issue date (${issueDate}), within allowable clearing buffer`
          };
        }
        return {
          isWithinWindow: false,
          daysDifference: diffBeforeIssue,
          score: 0.0,
          rejectionReason: RejectionReason.DATE_OUTSIDE_WINDOW,
          explanation: `Transaction date (${sourceDate}) is ${diffBeforeIssue} days before issue date (${issueDate}), outside allowable window`
        };
      }

      // Payment after due_date
      if (diffAfterDue > 0) {
        const allowedLate = options.dateWindowDays !== undefined ? windowDays : maxDaysAfterDue;
        if (diffAfterDue <= allowedLate) {
          const score = Math.round(Math.max(0.5, 1.0 - (diffAfterDue / (allowedLate + 1)) * 0.5) * 1000) / 1000;
          return {
            isWithinWindow: true,
            daysDifference: diffAfterDue,
            score,
            rejectionReason: null,
            explanation: `Transaction date (${sourceDate}) is ${diffAfterDue} day(s) after due date (${dueDate}), within allowable grace period`
          };
        }
        return {
          isWithinWindow: false,
          daysDifference: diffAfterDue,
          score: 0.0,
          rejectionReason: RejectionReason.DATE_OUTSIDE_WINDOW,
          explanation: `Transaction date (${sourceDate}) is ${diffAfterDue} days after due date (${dueDate}), outside allowable window`
        };
      }
    }

    // Only issueDate is present (no dueDate)
    if (issueDate) {
      const daysDiff = daysDifference(sourceDate, issueDate);
      if (daysDiff >= 0) {
        // Source is on or after issueDate
        if (daysDiff <= windowDays) {
          const score = Math.round(Math.max(0.5, 1.0 - (daysDiff / (windowDays + 1)) * 0.5) * 1000) / 1000;
          return {
            isWithinWindow: true,
            daysDifference: daysDiff,
            score,
            rejectionReason: null,
            explanation: `Transaction date (${sourceDate}) is ${daysDiff} day(s) after issue date (${issueDate}), within ${windowDays}-day window`
          };
        }
        return {
          isWithinWindow: false,
          daysDifference: daysDiff,
          score: 0.0,
          rejectionReason: RejectionReason.DATE_OUTSIDE_WINDOW,
          explanation: `Transaction date (${sourceDate}) is ${daysDiff} days after issue date (${issueDate}), exceeding ${windowDays}-day window`
        };
      } else {
        // Source is before issueDate
        const daysBefore = Math.abs(daysDiff);
        const allowedEarly = Math.min(maxDaysBeforeIssue, windowDays);
        if (daysBefore <= allowedEarly) {
          const score = Math.round((1.0 - (daysBefore / (allowedEarly + 1)) * 0.1) * 1000) / 1000;
          return {
            isWithinWindow: true,
            daysDifference: daysBefore,
            score,
            rejectionReason: null,
            explanation: `Transaction date (${sourceDate}) is ${daysBefore} day(s) before issue date (${issueDate}), within allowable clearing buffer`
          };
        }
        return {
          isWithinWindow: false,
          daysDifference: daysBefore,
          score: 0.0,
          rejectionReason: RejectionReason.DATE_OUTSIDE_WINDOW,
          explanation: `Transaction date (${sourceDate}) is ${daysBefore} days before issue date (${issueDate}), outside allowable window`
        };
      }
    }

    // Only dueDate is present
    const daysDiff = Math.abs(daysDifference(sourceDate, dueDate));
    if (daysDiff <= windowDays) {
      const score = Math.round(Math.max(0.5, 1.0 - (daysDiff / (windowDays + 1)) * 0.5) * 1000) / 1000;
      return {
        isWithinWindow: true,
        daysDifference: daysDiff,
        score,
        rejectionReason: null,
        explanation: `Transaction date (${sourceDate}) is ${daysDiff} day(s) from due date (${dueDate}), within ${windowDays}-day window`
      };
    }
    return {
      isWithinWindow: false,
      daysDifference: daysDiff,
      score: 0.0,
      rejectionReason: RejectionReason.DATE_OUTSIDE_WINDOW,
      explanation: `Transaction date (${sourceDate}) is ${daysDiff} days from due date (${dueDate}), exceeding ${windowDays}-day window`
    };
  }

  // Case B: Provider record (transactionDate or arrivalDate)
  const targetDate = arrivalDate || transactionDate;
  if (targetDate) {
    const targetDateNorm = targetDate.slice(0, 10);
    const diff = Math.abs(daysDifference(sourceDate, targetDateNorm));
    if (diff <= windowDays) {
      const score = Math.round(Math.max(0.5, 1.0 - (diff / (windowDays + 1)) * 0.5) * 1000) / 1000;
      return {
        isWithinWindow: true,
        daysDifference: diff,
        score,
        rejectionReason: null,
        explanation: `Transaction date (${sourceDate}) is ${diff} day(s) from provider payout date (${targetDateNorm}), within ${windowDays}-day window`
      };
    }
    return {
      isWithinWindow: false,
      daysDifference: diff,
      score: 0.0,
      rejectionReason: RejectionReason.DATE_OUTSIDE_WINDOW,
      explanation: `Transaction date (${sourceDate}) is ${diff} days from provider payout date (${targetDateNorm}), exceeding ${windowDays}-day window`
    };
  }

  // Candidate has no dates
  return {
    isWithinWindow: false,
    daysDifference: null,
    score: 0.0,
    rejectionReason: RejectionReason.DATE_OUTSIDE_WINDOW,
    explanation: 'Candidate record has no relevant date fields'
  };
}

/**
 * Calculates overall deterministic score and builds transparent reasons object.
 * @param {{
 *   amountResult: Object,
 *   dateResult: Object,
 *   counterpartyResult: Object,
 *   options?: Object
 * }} params 
 * @returns {{
 *   score: number,
 *   reasons: {
 *     amount: string,
 *     date: string,
 *     counterparty: string,
 *     summary: string
 *   }
 * }}
 */
function calculateDeterministicScore({ amountResult, dateResult, counterpartyResult, options = {} }) {
  const reasons = {
    amount: amountResult.explanation,
    date: dateResult.explanation,
    counterparty: counterpartyResult.explanation,
    summary: ''
  };

  // If amount is incompatible or outside tolerance, score is strictly 0
  if (!amountResult.isCompatible) {
    reasons.summary = `Candidate rejected due to amount: ${amountResult.explanation}`;
    return { score: 0.0, reasons };
  }

  // If date is outside window, score is strictly 0
  if (!dateResult.isWithinWindow) {
    reasons.summary = `Candidate rejected due to date: ${dateResult.explanation}`;
    return { score: 0.0, reasons };
  }

  const cpThreshold = options.counterpartyThreshold !== undefined
    ? options.counterpartyThreshold
    : DEFAULT_CONFIG.counterpartyThreshold;

  let finalScore;

  if (counterpartyResult.isEvaluated) {
    // Both counterparties were present and evaluated
    const amountWeight = 0.40;
    const dateWeight = 0.30;
    const counterpartyWeight = 0.30;

    // If counterparty similarity is below threshold (e.g. generic word like "Amazon" vs "Amazon Web Services",
    // or completely different vendors like "AWS" vs "Beta Logistics"),
    // counterparty evidence does not confirm the match and receives 0 contribution.
    const effectiveCpScore = counterpartyResult.score >= cpThreshold ? counterpartyResult.score : 0.0;

    finalScore = (amountResult.score * amountWeight) +
                 (dateResult.score * dateWeight) +
                 (effectiveCpScore * counterpartyWeight);
  } else {
    // Counterparty unknown/missing on one or both sides (e.g. Test 13)
    // Rely strictly on amount + date evidence without inventing vendor identity
    const amountWeight = 0.60;
    const dateWeight = 0.40;

    finalScore = (amountResult.score * amountWeight) +
                 (dateResult.score * dateWeight);
  }

  finalScore = Math.round(finalScore * 1000) / 1000;

  reasons.summary = `Deterministic score ${(finalScore * 100).toFixed(1)}% ` +
    `[Amount: ${(amountResult.score * 100).toFixed(0)}%, ` +
    `Date: ${(dateResult.score * 100).toFixed(0)}%, ` +
    `Counterparty: ${counterpartyResult.isEvaluated ? (counterpartyResult.score * 100).toFixed(0) + '%' : 'N/A'}]`;

  return { score: finalScore, reasons };
}

module.exports = {
  parseDateToMs,
  daysDifference,
  compareAmount,
  compareDate,
  calculateDeterministicScore
};
