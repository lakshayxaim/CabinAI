/**
 * Reconciliation module entry point for CabinAI.
 */

const DeterministicMatcher = require('./matcher');
const normalizers = require('./normalizers');
const scoring = require('./scoring');
const types = require('./types');

module.exports = {
  DeterministicMatcher,
  ...normalizers,
  ...scoring,
  ...types
};
