/**
 * Tool Registry for CabinAI Session 3 Agent.
 *
 * Maps tool names to their executor functions and LLM schemas.
 * The agent loop uses this registry for:
 *  - building the tool list to send to the LLM
 *  - dispatching tool calls requested by the model
 *  - rejecting unknown tool names safely
 *
 * Adding a new tool: import it here and add to TOOLS map.
 * The LLM can only invoke tools listed in this registry.
 */

'use strict';

const { lookupVendor, schema: lookupVendorSchema } = require('./lookupVendor');
const { findMatchingInvoice, schema: findMatchingInvoiceSchema } = require('./findMatchingInvoice');
const { calculateAmountDifference, schema: calculateAmountDifferenceSchema } = require('./calculateAmountDifference');
const { checkDuplicateInvoice, schema: checkDuplicateInvoiceSchema } = require('./checkDuplicateInvoice');
const { checkInvoiceStatus, schema: checkInvoiceStatusSchema } = require('./checkInvoiceStatus');

/**
 * Internal tool entry.
 * @typedef {Object} ToolEntry
 * @property {Function} execute  - (args, repos) => result
 * @property {Object}   schema   - LLM function-calling schema
 */

/**
 * Registry of all available deterministic tools.
 * Key = tool name as the model will call it.
 * @type {Record<string, ToolEntry>}
 */
const TOOLS = {
  lookup_vendor: {
    execute: lookupVendor,
    schema: lookupVendorSchema
  },
  find_matching_invoice: {
    execute: findMatchingInvoice,
    schema: findMatchingInvoiceSchema
  },
  calculate_amount_difference: {
    execute: calculateAmountDifference,
    // calculate_amount_difference doesn't need repos — wrap to ignore second arg
    schema: calculateAmountDifferenceSchema
  },
  check_duplicate_invoice: {
    execute: checkDuplicateInvoice,
    schema: checkDuplicateInvoiceSchema
  },
  check_invoice_status: {
    execute: checkInvoiceStatus,
    schema: checkInvoiceStatusSchema
  }
};

/**
 * Returns the list of tool schemas to send to the LLM.
 * @returns {Array<Object>}
 */
function getToolSchemas() {
  return Object.values(TOOLS).map(t => t.schema);
}

/**
 * Executes a tool by name with validated arguments.
 *
 * @param {string} toolName
 * @param {Object} args
 * @param {Object} repos   - { invoices, counterparties, ... }
 * @returns {{ success: boolean, result: Object, error?: string }}
 */
function executeTool(toolName, args, repos) {
  const entry = TOOLS[toolName];
  if (!entry) {
    return {
      success: false,
      result: {
        error: true,
        code: 'UNKNOWN_TOOL',
        message: `Tool "${toolName}" is not registered. Available tools: ${Object.keys(TOOLS).join(', ')}`
      }
    };
  }

  try {
    const result = entry.execute(args, repos);
    return { success: !result?.error, result };
  } catch (err) {
    return {
      success: false,
      result: {
        error: true,
        code: 'TOOL_EXECUTION_ERROR',
        message: `Tool "${toolName}" threw an unexpected error: ${err.message}`
      }
    };
  }
}

/**
 * Returns true if a tool name is registered.
 * @param {string} toolName
 * @returns {boolean}
 */
function isToolRegistered(toolName) {
  return Object.prototype.hasOwnProperty.call(TOOLS, toolName);
}

module.exports = { TOOLS, getToolSchemas, executeTool, isToolRegistered };
