/**
 * Copyright 2025 Limitless Knowledge Association. Open sourced under MIT license.
 *
 * Aggregate Manager - module-level facade over a single AggregateModel instance.
 *
 * Maintains materialized views of current item state in .aggregates/items/, derived from
 * the event files and kept synchronized.
 *
 * This module used to be a second, independent implementation of the aggregate store. It
 * had no event-file cache and no incremental path: rebuildAggregate() called
 * getAllItemFiles(), reading and JSON-parsing EVERY event file in the repo in order to
 * update ONE item. Because validateAllAggregates() and rebuildAll() each invoked it once
 * per item, both were O(items x eventFiles) — measured at ~15.8s of blocking work on a
 * repo of only 200 items, all of it before the daemon's HTTP server started listening.
 *
 * AggregateModel already implemented the event-sourced design properly (event-file cache,
 * updateAggregateForEvent -> _applyIncrementalUpdate deltas, metrics) but was reachable
 * only through sparkle-class.js, which nothing in production imported. Rather than keep
 * two divergent implementations, this module is now a thin delegating facade over it.
 *
 * The exported function names, signatures and return shapes are unchanged, so
 * `sparkle.setAggregateManager(aggregateManagerModule)` and every existing caller keep
 * working. `updateAggregateForEvent` is newly exposed — that is the delta entry point.
 */

import { AggregateModel } from './AggregateModel.js';

// Single instance for the process. Recreated whenever initializeAggregateStore() is
// called with a different base directory (unit tests do this between cases).
let model = null;
let currentBaseDirectory = null;

// Callback registered before initialization is replayed onto the model once it exists.
let pendingChangeCallback = null;

/**
 * Get the live model, or throw the same error the old module-level code did.
 * @returns {AggregateModel}
 */
function requireModel() {
  if (!model) {
    throw new Error('Aggregate store not initialized. Call initializeAggregateStore() first.');
  }
  return model;
}

/**
 * Expose the underlying instance (used by sparkle.js to hand controllers the delta path).
 * @returns {AggregateModel|null}
 */
export function getModel() {
  return model;
}

/**
 * Register a callback to be called when an aggregate is rebuilt
 * Used by the daemon to broadcast SSE events
 * @param {Function} callback - Function called with (itemId) when aggregate changes
 */
export function onAggregateChanged(callback) {
  pendingChangeCallback = callback;
  if (model) {
    model.onAggregateChanged(callback);
  }
}

/**
 * Initialize the aggregate store
 * Creates directory structure and validates environment
 * @param {string} baseDir - Base directory for sparkle data
 */
export async function initializeAggregateStore(baseDir) {
  if (!model || currentBaseDirectory !== baseDir) {
    model = new AggregateModel(baseDir);
    currentBaseDirectory = baseDir;
    if (pendingChangeCallback) {
      model.onAggregateChanged(pendingChangeCallback);
    }
  }

  await model.start();
}

/**
 * Read an aggregate file
 * @param {string} itemId - Item ID
 * @returns {Promise<Object|null>} Aggregate object or null if not found
 */
export async function getAggregate(itemId) {
  return await requireModel().getAggregate(itemId);
}

/**
 * Get all aggregates
 * @returns {Promise<Array>} Array of all aggregate objects
 */
export async function getAllAggregates() {
  return await requireModel().getAllAggregates();
}

/**
 * Validate an aggregate against its events
 * @param {string} itemId - Item ID
 * @param {Map} [preloadedItemFiles] - Optional getAllItemFiles() result to avoid re-scanning
 * @returns {Promise<{valid: boolean, differences: string[]}>} Validation result
 */
export async function validateAggregate(itemId, preloadedItemFiles = null) {
  return await requireModel().validateAggregate(itemId, preloadedItemFiles);
}

/**
 * Validate all aggregates
 * @returns {Promise<{valid: boolean, invalidItems: Array}>} Validation result
 */
export async function validateAllAggregates() {
  return await requireModel().validateAllAggregates();
}

/**
 * Rebuild an aggregate from event files
 * @param {string} itemId - Item ID
 * @param {Array} [preloadedFiles] - Optional [{filename, data}] to avoid re-scanning
 * @returns {Promise<Object|null>} The rebuilt aggregate
 */
export async function rebuildAggregate(itemId, preloadedFiles = null) {
  return await requireModel().rebuildAggregate(itemId, preloadedFiles);
}

/**
 * Apply a single event to the aggregates it affects.
 *
 * This is the delta path: it reads the one aggregate and applies the event, instead of
 * re-reading every event file for the item. Falls back to a full rebuild automatically
 * when there is no existing aggregate or no event data to apply.
 *
 * @param {string} eventFilename - Event filename (e.g. "12345678.entry.<ts>.<rnd>.json")
 * @param {Object} [eventData] - Event payload; omit to force a rebuild
 * @returns {Promise<void>}
 */
export async function updateAggregateForEvent(eventFilename, eventData = null) {
  return await requireModel().updateAggregateForEvent(eventFilename, eventData);
}

/**
 * Rebuild all aggregates from event files
 * @param {Function} progressCallback - Optional callback(current, total)
 * @param {{sparkleVersion?: string}} [options]
 * @returns {Promise<void>}
 */
export async function rebuildAll(progressCallback = null, options = {}) {
  return await requireModel().rebuildAll(progressCallback, options);
}

/**
 * Invalidate an aggregate (delete the file so it is rebuilt on next access)
 * @param {string} itemId - Item ID
 */
export async function invalidateAggregate(itemId) {
  return await requireModel().invalidateAggregate(itemId);
}

/**
 * Invalidate aggregates for a set of changed/pulled event files
 * @param {Array<string>} filenames - Event filenames
 */
export async function invalidateAggregatesForFiles(filenames) {
  return await requireModel().invalidateAggregatesForFiles(filenames);
}

/**
 * Get aggregate rebuild status
 * @returns {{rebuilding: boolean, progress: {current: number, total: number}}}
 */
export function getAggregateStatus() {
  if (!model) {
    return { rebuilding: false, progress: { current: 0, total: 0 } };
  }
  return model.getAggregateStatus();
}

/**
 * Get aggregate metadata
 * @returns {Promise<Object|null>}
 */
export async function getMetadata() {
  return await requireModel().getMetadata();
}

/**
 * Update aggregate metadata
 * @param {Object} updates - Fields to merge into metadata
 */
export async function updateMetadata(updates) {
  return await requireModel().updateMetadata(updates);
}

/**
 * Incremental-vs-rebuild performance counters (diagnostics)
 * @returns {Object} Metrics summary
 */
export function getMetrics() {
  if (!model) {
    return null;
  }
  return model.getMetrics();
}
