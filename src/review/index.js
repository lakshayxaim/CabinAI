/**
 * Review module entry point for CabinAI Session 4.
 */

'use strict';

const {
  RedFlagCode,
  RedFlagMessages,
  redFlagForRejectionReason,
  looksLikeProviderPayout,
  deriveRedFlags
} = require('./redFlags');
const DecisionService = require('./decisionService');

module.exports = {
  RedFlagCode,
  RedFlagMessages,
  redFlagForRejectionReason,
  looksLikeProviderPayout,
  deriveRedFlags,
  DecisionService
};
