/**
 * Copyright 2025 Limitless Knowledge Association. Open sourced under MIT license.
 *
 * Aggregate Model - Manages derived data store for Sparkle
 *
 * Maintains materialized views of current item state in .aggregates/items/
 * These are derived from event files and kept synchronized.
 */

import { join } from 'path';
import { readdir, readFile, stat, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { ensureDir, readJsonFile, writeJsonFile, readMatchingFiles, fileExists } from './fileUtils.js';
import { getAllItemFiles, createPersonData } from './utils.js';
import { buildItemState } from './stateBuilder.js';
import { generateItemId } from './nameUtils.js';
import * as itemEvent from './events/item.js';
import * as taglineEvent from './events/tagline.js';
import * as entryEvent from './events/entry.js';
import * as statusEvent from './events/status.js';
import * as dependencyEvent from './events/dependency.js';
import * as monitorEvent from './events/monitor.js';
import * as ignoredEvent from './events/ignored.js';
import * as takenEvent from './events/taken.js';

/**
 * AggregateModel class - manages aggregate store for a specific directory
 */
export class AggregateModel {
  /**
   * Create an AggregateModel instance
   * @param {string} baseDirectory - Base directory for sparkle data
   */
  constructor(baseDirectory) {
    this.baseDirectory = baseDirectory;
    this.aggregateDir = null;
    this.aggregateItemsDir = null;
    this.aggregateMetadataPath = null;
    this.eventFilesCachePath = null;

    // Rebuild state tracking
    this.rebuildInProgress = false;
    this.rebuildProgress = { current: 0, total: 0 };

    // Callback for when aggregates change (for SSE notifications)
    this.changeNotificationCallback = null;

    // Metrics tracking for incremental vs full rebuilds
    this.metrics = {
      incrementalUpdates: 0,
      fullRebuilds: 0,
      totalFilesReadIncremental: 0,
      totalFilesReadRebuild: 0,
      totalDurationIncremental: 0,
      totalDurationRebuild: 0
    };

    this.initialized = false;
  }

  /**
   * Initialize the aggregate store
   * Creates necessary directories and metadata file if they don't exist
   * @returns {Promise<void>}
   */
  async start() {
    this.aggregateDir = join(this.baseDirectory, '.aggregates');
    this.aggregateItemsDir = join(this.aggregateDir, 'items');
    this.aggregateMetadataPath = join(this.aggregateDir, 'metadata.json');
    this.eventFilesCachePath = join(this.aggregateDir, 'event-files.json');
    this.configPath = join(this.aggregateDir, 'config.json');

    // Create directories if they don't exist
    await ensureDir(this.aggregateDir);
    await ensureDir(this.aggregateItemsDir);

    // Initialize metadata if it doesn't exist
    if (!existsSync(this.aggregateMetadataPath)) {
      await writeJsonFile(this.aggregateMetadataPath, {
        version: 1,
        lastRebuildSHA: null,
        lastRebuildTimestamp: null,
        totalItems: 0
      });
    }

    // Initialize config.json if it doesn't exist
    if (!existsSync(this.configPath)) {
      await writeJsonFile(this.configPath, {
        darkMode: null,
        filters: {
          pending: null,
          monitor: null,
          ignored: null,
          taken: null
        }
      });
    }

    this.initialized = true;
    console.log('Aggregate store initialized:', this.aggregateItemsDir);
  }

  /**
   * Ensure initialized
   * @private
   */
  _ensureInitialized() {
    if (!this.initialized) {
      throw new Error('AggregateModel not initialized. Call start() first.');
    }
  }

  /**
   * Get the path to an aggregate file
   * @param {string} itemId - Item ID
   * @returns {string} Full path to aggregate file
   * @private
   */
  _getAggregatePath(itemId) {
    this._ensureInitialized();
    return join(this.aggregateItemsDir, `${itemId}.json`);
  }

  /**
   * Register callback for when aggregates change
   * @param {Function} callback - Called with (itemId) when aggregate changes
   */
  onAggregateChanged(callback) {
    this.changeNotificationCallback = callback;
  }

  /**
   * Notify that an aggregate has changed
   * @param {string} itemId - Item that changed
   * @private
   */
  _notifyAggregateChanged(itemId) {
    if (this.changeNotificationCallback) {
      this.changeNotificationCallback(itemId);
    }
  }

  /**
   * Build the event files cache - reads all event files from baseDirectory,
   * sorts them by timestamp, and writes to cache file
   * @returns {Promise<Array<string>>} Array of sorted event filenames
   * @private
   */
  async _buildEventFilesCache() {
    this._ensureInitialized();

    const startTime = Date.now();
    console.log('[AggregateModel] Building event files cache...');

    // Read all event files
    const allFiles = await readMatchingFiles(this.baseDirectory, '');

    // Filter to only event files (exclude system files like statuses.json)
    const eventFiles = allFiles.filter(filename => {
      if (filename === 'statuses.json') return false;

      const firstPart = filename.split('.')[0];
      // Event files start with 8-digit item IDs
      return /^\d{8}$/.test(firstPart);
    });

    // Parse timestamps and sort
    const filesWithTimestamps = eventFiles.map(filename => {
      const parts = filename.split('.');
      let timestamp = '0';

      // Extract timestamp based on file type
      if (parts.length === 2 && parts[1] === 'json') {
        // Creation file: itemId.json - use timestamp 0
        timestamp = '0';
      } else if (parts[1] === 'dependency') {
        // Dependency: itemId.dependency.action.target.timestamp.random.json
        timestamp = parts[4] || '0';
      } else if (parts[1] === 'monitor') {
        // Monitor: itemId.monitor.action.hash.timestamp.random.json
        timestamp = parts[4] || '0';
      } else if (parts[1] === 'taken') {
        // Taken: itemId.taken.action.hash.timestamp.random.json
        timestamp = parts[4] || '0';
      } else if (parts[1] === 'ignored') {
        // Ignored: itemId.ignored.action.timestamp.random.json
        timestamp = parts[3] || '0';
      } else {
        // Standard files: itemId.type.timestamp.random.json
        timestamp = parts[2] || '0';
      }

      return { filename, timestamp };
    });

    // Sort by timestamp
    filesWithTimestamps.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Extract just the filenames in sorted order
    const sortedFilenames = filesWithTimestamps.map(f => f.filename);

    // Write to cache
    await writeJsonFile(this.eventFilesCachePath, sortedFilenames);

    const duration = Date.now() - startTime;
    console.log(`[AggregateModel] Event files cache built: ${sortedFilenames.length} files (${duration}ms)`);

    return sortedFilenames;
  }

  /**
   * Get sorted event files, using cache if available
   * @param {Function} filterFn - Optional filter function (filename => boolean)
   * @returns {Promise<Array<string>>} Array of event filenames (sorted by timestamp)
   */
  async getEventFiles(filterFn = null) {
    this._ensureInitialized();

    // Check if cache exists
    let eventFiles;
    if (existsSync(this.eventFilesCachePath)) {
      // Use cached list
      eventFiles = await readJsonFile(this.eventFilesCachePath);
    } else {
      // Build cache
      eventFiles = await this._buildEventFilesCache();
    }

    // Apply filter if provided
    if (filterFn) {
      return eventFiles.filter(filterFn);
    }

    return eventFiles;
  }

  /**
   * Invalidate aggregate for a specific itemId (delete the aggregate file)
   * Called when git pull brings changes affecting this item
   * @param {string} itemId - Item ID to invalidate
   */
  async invalidateAggregate(itemId) {
    this._ensureInitialized();

    const aggregatePath = this._getAggregatePath(itemId);
    if (existsSync(aggregatePath)) {
      await unlink(aggregatePath);
      console.log(`[AggregateModel] Invalidated aggregate for item ${itemId}`);
    }

    // Also invalidate event files cache so it gets rebuilt
    await this.invalidateEventFilesCache();
  }

  /**
   * Invalidate aggregates for files that were pulled from remote
   * Extracts itemIds from filenames and invalidates affected aggregates
   * @param {Array<string>} filenames - Array of event filenames that were pulled
   */
  async invalidateAggregatesForFiles(filenames) {
    this._ensureInitialized();

    const itemIds = new Set();

    // Extract all affected itemIds from filenames
    for (const filename of filenames) {
      const ids = this._extractItemIdsFromFilename(filename);
      ids.forEach(id => itemIds.add(id));
    }

    if (itemIds.size === 0) {
      return;
    }

    console.log(`[AggregateModel] Invalidating ${itemIds.size} aggregates from ${filenames.length} pulled files`);

    // Invalidate each affected aggregate
    for (const itemId of itemIds) {
      const aggregatePath = this._getAggregatePath(itemId);
      if (existsSync(aggregatePath)) {
        await unlink(aggregatePath);
      }
    }

    // Invalidate event files cache once for all changes
    await this.invalidateEventFilesCache();
  }

  /**
   * Invalidate the event files cache (called after git pull brings new files)
   */
  async invalidateEventFilesCache() {
    this._ensureInitialized();

    if (existsSync(this.eventFilesCachePath)) {
      await unlink(this.eventFilesCachePath);
      console.log('[AggregateModel] Event files cache invalidated');
    }
  }

  /**
   * Add a new event file to the cache (called when we create a new file)
   * @param {string} filename - Event filename to add
   */
  async addEventFileToCache(filename) {
    this._ensureInitialized();

    // If cache doesn't exist, nothing to do (it will be built on next read)
    if (!existsSync(this.eventFilesCachePath)) {
      return;
    }

    try {
      const eventFiles = await readJsonFile(this.eventFilesCachePath);

      // Parse timestamp from filename
      const parts = filename.split('.');
      let timestamp = '0';

      if (parts.length === 2 && parts[1] === 'json') {
        timestamp = '0';
      } else if (parts[1] === 'dependency') {
        timestamp = parts[4] || '0';
      } else if (parts[1] === 'monitor') {
        timestamp = parts[4] || '0';
      } else if (parts[1] === 'taken') {
        timestamp = parts[4] || '0';
      } else if (parts[1] === 'ignored') {
        timestamp = parts[3] || '0';
      } else {
        timestamp = parts[2] || '0';
      }

      // Find insertion point to maintain sort order
      let insertIndex = eventFiles.length;
      for (let i = eventFiles.length - 1; i >= 0; i--) {
        const existingParts = eventFiles[i].split('.');
        let existingTimestamp = '0';

        if (existingParts.length === 2 && existingParts[1] === 'json') {
          existingTimestamp = '0';
        } else if (existingParts[1] === 'dependency') {
          existingTimestamp = existingParts[4] || '0';
        } else if (existingParts[1] === 'monitor') {
          existingTimestamp = existingParts[4] || '0';
        } else if (existingParts[1] === 'taken') {
          existingTimestamp = existingParts[4] || '0';
        } else if (existingParts[1] === 'ignored') {
          existingTimestamp = existingParts[3] || '0';
        } else {
          existingTimestamp = existingParts[2] || '0';
        }

        if (timestamp.localeCompare(existingTimestamp) >= 0) {
          insertIndex = i + 1;
          break;
        }
      }

      // Insert at the correct position
      eventFiles.splice(insertIndex, 0, filename);

      // Write updated cache
      await writeJsonFile(this.eventFilesCachePath, eventFiles);

    } catch (error) {
      // If there's any error updating cache, just invalidate it
      console.error('[AggregateModel] Error updating cache, invalidating:', error.message);
      await this.invalidateEventFilesCache();
    }
  }

  /**
   * Get a single aggregate
   * @param {string} itemId - Item ID
   * @returns {Promise<Object|null>} Aggregate data or null if not found
   */
  async getAggregate(itemId) {
    this._ensureInitialized();

    const startTime = Date.now();
    const aggregatePath = this._getAggregatePath(itemId);

    if (!existsSync(aggregatePath)) {
      return null;
    }

    try {
      const aggregate = await readJsonFile(aggregatePath);
      const duration = Date.now() - startTime;
      console.log(`[Aggregate] getAggregate(${itemId}) - ${duration}ms`);
      return aggregate;
    } catch (error) {
      console.error(`Error reading aggregate ${itemId}:`, error);
      return null;
    }
  }

  /**
   * Get all aggregates
   * @returns {Promise<Array>} Array of all aggregates
   */
  async getAllAggregates() {
    this._ensureInitialized();

    const startTime = Date.now();
    const readdirStartTime = Date.now();
    const files = await readdir(this.aggregateItemsDir);
    const readdirDuration = Date.now() - readdirStartTime;

    const jsonFiles = files.filter(f => f.endsWith('.json'));
    console.log(`[Aggregate] getAllAggregates() - readdir: ${readdirDuration}ms, reading ${jsonFiles.length} files...`);

    const readFilesStartTime = Date.now();
    const aggregates = [];

    for (const file of jsonFiles) {
      const filePath = join(this.aggregateItemsDir, file);
      try {
        const aggregate = await readJsonFile(filePath);
        aggregates.push(aggregate);
      } catch (error) {
        console.error(`Error reading aggregate file ${file}:`, error);
      }
    }

    const readFilesDuration = Date.now() - readFilesStartTime;
    const totalDuration = Date.now() - startTime;

    console.log(`[Aggregate] getAllAggregates() - readdir: ${readdirDuration}ms, readAllFiles: ${readFilesDuration}ms, total: ${totalDuration}ms, count: ${aggregates.length}`);

    return aggregates;
  }

  /**
   * Validate an aggregate against its events
   * @param {string} itemId - Item ID to validate
   * @param {Map} [preloadedItemFiles] - Optional result of getAllItemFiles(). Pass it when
   *   validating many items so the whole directory is scanned ONCE rather than once per
   *   item — the per-item scan is what made validateAllAggregates O(items x eventFiles).
   * @returns {Promise<Object>} Validation result {valid: boolean, differences: Array}
   */
  async validateAggregate(itemId, preloadedItemFiles = null) {
    this._ensureInitialized();

    // `errors` mirrors `differences` throughout: callers of the old module-level
    // aggregateManager read `.errors`, callers of this class read `.differences`.
    const fail = (reason) => ({ valid: false, differences: [reason], errors: [reason] });

    const aggregate = await this.getAggregate(itemId);
    if (!aggregate) {
      return fail('Aggregate file not found');
    }

    // Get event files and rebuild state
    const allItemFiles = preloadedItemFiles || await getAllItemFiles(this.baseDirectory);
    const itemFiles = allItemFiles.get(itemId);

    if (!itemFiles || itemFiles.length === 0) {
      return fail('No event files found for item');
    }

    const rebuiltState = buildItemState(itemFiles);

    if (!rebuiltState) {
      return fail('Could not rebuild state from events');
    }

    // Compare aggregate with rebuilt state
    const differences = [];

    // Compare key fields
    const fieldsToCompare = ['itemId', 'tagline', 'status', 'createdTimestamp', 'ignored'];

    for (const field of fieldsToCompare) {
      if (JSON.stringify(aggregate[field]) !== JSON.stringify(rebuiltState[field])) {
        differences.push(`${field}: aggregate=${JSON.stringify(aggregate[field])}, rebuilt=${JSON.stringify(rebuiltState[field])}`);
      }
    }

    // Compare arrays/sets
    const aggregateDeps = new Set(aggregate.dependencies || []);
    const rebuiltDeps = new Set(rebuiltState.dependencies || []);

    if (aggregateDeps.size !== rebuiltDeps.size || ![...aggregateDeps].every(d => rebuiltDeps.has(d))) {
      differences.push(`dependencies: aggregate=${[...aggregateDeps].sort()}, rebuilt=${[...rebuiltDeps].sort()}`);
    }

    // Entry count is the one thing the field comparison above cannot see, and it is
    // exactly what drifts if an incremental update is ever applied twice or missed.
    // Compared against the rebuilt state rather than the raw file count, so an event
    // file that names two items doesn't read as a mismatch on either of them.
    const aggregateEntries = (aggregate.entries || []).length;
    const rebuiltEntries = (rebuiltState.entries || []).length;
    if (aggregateEntries !== rebuiltEntries) {
      differences.push(`entries: aggregate=${aggregateEntries}, rebuilt=${rebuiltEntries}`);
    }

    return {
      valid: differences.length === 0,
      differences,
      errors: differences
    };
  }

  /**
   * Validate all aggregates.
   *
   * Scans the event directory ONCE and reuses it across every item. The previous
   * implementation re-scanned and re-parsed every event file for each item, which
   * measured quadratic: ~15.8s of blocking work at only 200 items / 1200 event files.
   *
   * @returns {Promise<Object>} {valid: boolean, invalidItems: Array<{itemId, errors}>}
   *   Shape matches what the daemon reads (`!status.valid`, `status.invalidItems.length`).
   */
  async validateAllAggregates() {
    this._ensureInitialized();

    const startTime = Date.now();
    const aggregates = await this.getAllAggregates();
    const allItemFiles = await getAllItemFiles(this.baseDirectory);
    const invalidItems = [];

    // Check the UNION of items-that-have-events and items-that-have-an-aggregate.
    //
    // Iterating only the existing aggregates cannot detect a MISSING one, which is
    // precisely the state of a freshly-cloned repo: the worktree arrives full of event
    // files and an empty .aggregates/items. Validation would report "0 aggregates, 0
    // invalid, valid" and the daemon would never build anything, so every item read
    // returned "Item does not exist". Walking the event files as well makes a missing
    // aggregate an invalid one, which is what schedules the rebuild.
    const itemIds = new Set([
      ...allItemFiles.keys(),
      ...aggregates.map(a => a.itemId).filter(Boolean)
    ]);

    for (const itemId of itemIds) {
      const validation = await this.validateAggregate(itemId, allItemFiles);
      if (!validation.valid) {
        invalidItems.push({
          itemId,
          errors: validation.differences,
          differences: validation.differences // legacy alias
        });
      }
    }

    console.log(`[AggregateModel] validateAllAggregates() - ${itemIds.size} items ` +
      `(${aggregates.length} aggregates on disk), ${invalidItems.length} invalid, ` +
      `${Date.now() - startTime}ms`);

    return {
      valid: invalidItems.length === 0,
      invalidItems,
      validCount: itemIds.size - invalidItems.length
    };
  }

  /**
   * Shape a built state into the stored aggregate form.
   *
   * The derived fields and _meta are part of the persisted contract: validateAggregate
   * compares _meta.eventFileCount against the real file count, and the browser/CLI read
   * `creator`, `dependencyCount` and `entryCount`. The incremental path in
   * _applyIncrementalUpdate must keep these in step or every delta-updated item would
   * fail validation and trigger a pointless full rebuild on the next start.
   *
   * @param {Object} state - Output of buildItemState()
   * @param {Array} itemFiles - [{filename, data}] the state was built from
   * @returns {Object} Aggregate ready to persist
   * @private
   */
  _deriveAggregate(state, itemFiles) {
    let lastEventTimestamp = state.created;
    for (const file of itemFiles) {
      const stamp = file.data?.person?.timestamp;
      if (stamp && stamp > lastEventTimestamp) {
        lastEventTimestamp = stamp;
      }
    }

    return {
      ...state,
      creator: state.person, // Rename person to creator for clarity

      // Derived fields
      dependencyCount: state.dependencies ? state.dependencies.length : 0,
      entryCount: state.entries ? state.entries.length : 0,

      // Metadata
      _meta: {
        lastEventTimestamp,
        eventFileCount: itemFiles.length,
        builtAt: new Date().toISOString(),
        builtFromSHA: null // Set by the daemon when available
      }
    };
  }

  /**
   * Rebuild a single aggregate from its events
   * @param {string} itemId - Item ID to rebuild
   * @param {Array} [preloadedFiles] - Optional [{filename, data}] already read from disk.
   *   rebuildAll passes this so a bulk rebuild does ONE directory scan instead of one
   *   scan per item, which is what made the old path O(items x eventFiles).
   * @returns {Promise<Object|null>} The rebuilt aggregate, or null if item doesn't exist
   */
  async rebuildAggregate(itemId, preloadedFiles = null) {
    this._ensureInitialized();

    const startTime = Date.now();
    let itemFiles = preloadedFiles;

    if (!itemFiles) {
      // Get all event files from disk (not cache) mentioning this itemId
      // Match: itemId at start OR .itemId. anywhere in filename
      const allFiles = await readMatchingFiles(this.baseDirectory, '');
      const relevantFilenames = allFiles.filter(filename =>
        filename.startsWith(`${itemId}.`) || filename.includes(`.${itemId}.`)
      );

      // Load file data for all relevant files
      itemFiles = [];
      for (const filename of relevantFilenames) {
        const filePath = join(this.baseDirectory, filename);
        try {
          const data = await readJsonFile(filePath);
          itemFiles.push({ filename, data });
        } catch (error) {
          console.error(`Error reading file ${filename}:`, error.message);
        }
      }
    }

    const filesRead = itemFiles.length;

    if (filesRead === 0) {
      // Item doesn't exist, remove aggregate if it exists
      const aggregatePath = this._getAggregatePath(itemId);
      if (existsSync(aggregatePath)) {
        await unlink(aggregatePath);
        console.log(`Removed aggregate for deleted item: ${itemId}`);
      }
      return null;
    }

    // Build state from events
    const state = buildItemState(itemFiles, itemId);

    if (!state) {
      console.error(`Could not build state for item ${itemId}`);
      return null;
    }

    const aggregate = this._deriveAggregate(state, itemFiles);

    // Write aggregate
    const aggregatePath = this._getAggregatePath(itemId);
    await writeJsonFile(aggregatePath, aggregate);

    const duration = Date.now() - startTime;
    this.metrics.fullRebuilds++;
    this.metrics.totalFilesReadRebuild += filesRead;
    this.metrics.totalDurationRebuild += duration;

    console.log(`[Aggregate] rebuildAggregate(${itemId}) - type: full_rebuild, filesRead: ${filesRead}, eventsProcessed: ${filesRead}, duration: ${duration}ms`);

    // Notify listeners
    this._notifyAggregateChanged(itemId);

    return aggregate;
  }

  /**
   * Rebuild all aggregates from events
   * @param {Function} progressCallback - Optional callback(current, total)
   * @param {{sparkleVersion?: string}} [options] - If sparkleVersion is set, recorded in
   *   metadata only after this rebuild completes successfully.
   * @returns {Promise<void>}
   */
  async rebuildAll(progressCallback = null, options = {}) {
    this._ensureInitialized();

    if (this.rebuildInProgress) {
      throw new Error('Rebuild already in progress');
    }

    this.rebuildInProgress = true;

    try {
      // ONE scan of the event directory for the whole rebuild. Each item's files are
      // handed to rebuildAggregate directly; previously every item re-scanned the whole
      // directory, making a full rebuild quadratic in repo size.
      const startTime = Date.now();
      const allItemFiles = await getAllItemFiles(this.baseDirectory);
      const itemIds = Array.from(allItemFiles.keys());

      this.rebuildProgress = {
        current: 0,
        total: itemIds.length
      };

      console.log(`Rebuilding ${itemIds.length} aggregates...`);

      // Rebuild each item
      for (const itemId of itemIds) {
        await this.rebuildAggregate(itemId, allItemFiles.get(itemId));

        this.rebuildProgress.current++;

        if (progressCallback) {
          progressCallback(this.rebuildProgress.current, this.rebuildProgress.total);
        }

        // Log progress every 100 items
        if (this.rebuildProgress.current % 100 === 0) {
          console.log(`Rebuilt ${this.rebuildProgress.current}/${this.rebuildProgress.total} aggregates`);
        }
      }

      // Update metadata. sparkleVersion is written here — after the loop — so a crash
      // mid-rebuild leaves the old (or missing) version and the next start retries.
      const metadataUpdate = {
        lastRebuildTimestamp: new Date().toISOString(),
        totalItems: itemIds.length
      };
      if (options.sparkleVersion) {
        metadataUpdate.sparkleVersion = options.sparkleVersion;
      }
      await this.updateMetadata(metadataUpdate);

      console.log(`Rebuilt all ${itemIds.length} aggregates in ${Date.now() - startTime}ms`);
    } finally {
      this.rebuildInProgress = false;
      this.rebuildProgress = { current: 0, total: 0 };
    }
  }

  /**
   * Get aggregate rebuild status.
   * Shape matches what the daemon reads (sparkle_agent.js reads `status.progress`
   * and serves `{rebuilding, progress}` from /api/aggregateStatus).
   * @returns {Object} {rebuilding: boolean, progress: {current: number, total: number}}
   */
  getAggregateStatus() {
    return {
      rebuilding: this.rebuildInProgress,
      progress: { ...this.rebuildProgress }
    };
  }

  /**
   * Get metadata
   * @returns {Promise<Object>} Metadata object
   */
  async getMetadata() {
    this._ensureInitialized();

    if (!existsSync(this.aggregateMetadataPath)) {
      return null;
    }

    return await readJsonFile(this.aggregateMetadataPath);
  }

  /**
   * Update metadata
   * @param {Object} updates - Fields to update
   * @returns {Promise<void>}
   */
  async updateMetadata(updates) {
    this._ensureInitialized();

    const metadata = await this.getMetadata() || {};
    Object.assign(metadata, updates);
    await writeJsonFile(this.aggregateMetadataPath, metadata);
  }

  /**
   * Update aggregates affected by an event
   * Called after an event file is written (by controller) or pulled (by git)
   * @param {string} eventFilename - Name of the event file (e.g., "12345678.entry.20250101.abc.json")
   * @param {Object} eventData - Optional event data (if provided, skips file reading for performance)
   * @returns {Promise<void>}
   */
  async updateAggregateForEvent(eventFilename, eventData = null) {
    this._ensureInitialized();

    // Extract all itemIds affected by this event
    const affectedItemIds = this._extractItemIdsFromFilename(eventFilename);

    if (affectedItemIds.length === 0) {
      // Not an event file we care about
      return;
    }

    // Update aggregate for each affected itemId
    for (const itemId of affectedItemIds) {
      await this._updateAggregateIncremental(itemId, eventFilename, eventData);
    }
  }

  /**
   * Incrementally update an aggregate based on a new event
   * @param {string} itemId - Item ID to update
   * @param {string} eventFilename - Event filename
   * @param {Object} eventData - Event data (optional, if null will read file)
   * @returns {Promise<Object|null>} The updated aggregate, or null if it doesn't exist
   * @private
   */
  async _updateAggregateIncremental(itemId, eventFilename, eventData) {
    const startTime = Date.now();
    const operation = this._extractOperation(eventFilename);
    let filesRead = 0;

    try {
      // If no eventData provided, must do full rebuild
      if (!eventData) {
        console.log(`[Aggregate] updateAggregate(${itemId}) - operation: ${operation}, type: full_rebuild, reason: no_event_data`);
        return await this._fullRebuild(itemId, startTime, operation);
      }

      // Read existing aggregate
      const aggregatePath = this._getAggregatePath(itemId);
      if (!existsSync(aggregatePath)) {
        // No aggregate exists, full rebuild (likely item creation)
        console.log(`[Aggregate] updateAggregate(${itemId}) - operation: ${operation}, type: full_rebuild, reason: no_aggregate`);
        return await this._fullRebuild(itemId, startTime, operation);
      }

      const aggregate = await readJsonFile(aggregatePath);
      filesRead++;

      // Parse event type and apply incremental update
      const eventType = this._parseEventType(eventFilename);
      const updated = await this._applyIncrementalUpdate(
        aggregate,
        eventType,
        eventFilename,
        eventData
      );

      // Write updated aggregate
      await writeJsonFile(aggregatePath, updated);

      const duration = Date.now() - startTime;
      this.metrics.incrementalUpdates++;
      this.metrics.totalFilesReadIncremental += filesRead;
      this.metrics.totalDurationIncremental += duration;

      console.log(`[Aggregate] updateAggregate(${itemId}) - operation: ${operation}, type: incremental, filesRead: ${filesRead}, duration: ${duration}ms`);

      // Notify listeners
      this._notifyAggregateChanged(itemId);

      return updated;

    } catch (error) {
      console.error(`[Aggregate] Incremental update failed for ${itemId}, falling back to rebuild:`, error.message);
      return await this._fullRebuild(itemId, startTime, operation);
    }
  }

  /**
   * Perform a full rebuild and track metrics
   * @returns {Promise<Object|null>} The rebuilt aggregate, or null if it doesn't exist
   * @private
   */
  async _fullRebuild(itemId, startTime, operation) {
    // Delegates to rebuildAggregate so both paths write the identical aggregate shape.
    // They used to be separate copies, and the copy here omitted creator/_meta/counts —
    // which meant any incremental update that fell back to a rebuild silently produced a
    // differently-shaped aggregate from the one rebuildAll produced.
    console.log(`[Aggregate] updateAggregate(${itemId}) - operation: ${operation}, type: full_rebuild`);
    return await this.rebuildAggregate(itemId);
  }

  /**
   * Parse event type from filename
   * @private
   */
  _parseEventType(filename) {
    const parts = filename.split('.');

    if (parts.length === 2 && parts[1] === 'json') {
      return 'item_creation';
    }

    return parts[1]; // entry, tagline, status, dependency, monitor, ignored, taken
  }

  /**
   * Extract operation name from filename for logging
   * @private
   */
  _extractOperation(filename) {
    const parts = filename.split('.');

    if (parts.length === 2 && parts[1] === 'json') {
      return 'createItem';
    }

    const type = parts[1];
    const action = parts[2];

    if (type === 'dependency') {
      return action === 'linked' ? 'addDependency' : 'removeDependency';
    } else if (type === 'monitor') {
      return action === 'added' ? 'addMonitor' : 'removeMonitor';
    } else if (type === 'ignored') {
      return action === 'set' ? 'ignoreItem' : 'unignoreItem';
    } else if (type === 'taken') {
      return action === 'taken' ? 'takeItem' : 'surrenderItem';
    } else if (type === 'entry') {
      return 'addEntry';
    } else if (type === 'tagline') {
      return 'alterTagline';
    } else if (type === 'status') {
      return 'updateStatus';
    }

    return type;
  }

  /**
   * Re-derive the computed fields and _meta after an incremental update.
   *
   * Without this the delta path leaves entryCount/dependencyCount/_meta.eventFileCount at
   * whatever the last full rebuild wrote. validateAggregate compares _meta.eventFileCount
   * against the real number of event files on disk, so every delta-updated item would be
   * reported invalid and the daemon would launch a full rebuild on the next start —
   * defeating the entire point of applying deltas.
   *
   * @param {Object} aggregate - Aggregate being updated (mutated in place)
   * @param {Object} eventData - The event just applied
   * @private
   */
  _refreshDerived(aggregate, eventData) {
    aggregate.dependencyCount = aggregate.dependencies ? aggregate.dependencies.length : 0;
    aggregate.entryCount = aggregate.entries ? aggregate.entries.length : 0;

    const meta = aggregate._meta || {};
    const stamp = eventData?.person?.timestamp;
    const lastEventTimestamp =
      stamp && (!meta.lastEventTimestamp || stamp > meta.lastEventTimestamp)
        ? stamp
        : meta.lastEventTimestamp;

    aggregate._meta = {
      ...meta,
      // One new event file on disk per affected item. A dependency event names two items
      // and _extractItemIdsFromFilename returns both, so each gets its own +1 — which is
      // correct, because the file matches both items' file sets.
      eventFileCount: (meta.eventFileCount || 0) + 1,
      lastEventTimestamp,
      builtAt: new Date().toISOString()
    };
  }

  /**
   * Whether a stored monitor is the same person as this event.
   *
   * Rebuilds used to omit `hash`, so hash-only matching left those monitors in place
   * after a remove. Fall back to name+email when hash is missing on either side.
   * @private
   */
  _sameMonitor(monitor, hash, person) {
    if (monitor.hash && hash) {
      return monitor.hash === hash;
    }
    return !!person && monitor.email === person.email && monitor.name === person.name;
  }

  /**
   * Apply an incremental update to an aggregate
   * @private
   */
  async _applyIncrementalUpdate(aggregate, eventType, eventFilename, eventData) {
    const parts = eventFilename.split('.');
    const action = parts[2];

    switch (eventType) {
      case 'entry':
        // Append to entries. `seq` must match what stateBuilder.getEntries() assigns on a
        // full rebuild — 1-based position in creation order — or the number shown against
        // an entry would change depending on whether it arrived via a delta or a rebuild.
        // Appending is correct because events are applied in chronological order, which is
        // the same order getEntries sorts by.
        aggregate.entries = aggregate.entries || [];
        aggregate.entries.push({
          text: eventData.text,
          person: eventData.person,
          seq: aggregate.entries.length + 1
        });
        break;

      case 'tagline':
        // Update tagline
        aggregate.tagline = eventData.tagline;
        break;

      case 'status':
        // Update status
        aggregate.status = eventData.status;
        break;

      case 'dependency':
        // Update dependencies or dependents depending on which item this is
        // filename: itemNeeding.dependency.action.itemNeeded.timestamp.random.json
        const targetItemId = parts[3];
        const sourceItemId = parts[0];

        // Check if this aggregate is the one doing the depending or being depended on
        if (aggregate.itemId === sourceItemId) {
          // This is the item that needs (itemNeeding) - update dependencies
          aggregate.dependencies = aggregate.dependencies || [];
          if (action === 'linked') {
            if (!aggregate.dependencies.includes(targetItemId)) {
              aggregate.dependencies.push(targetItemId);
            }
          } else if (action === 'unlinked') {
            aggregate.dependencies = aggregate.dependencies.filter(id => id !== targetItemId);
          }
        } else {
          // This is the item being needed (itemNeeded) - update dependents
          aggregate.dependents = aggregate.dependents || [];
          if (action === 'linked') {
            if (!aggregate.dependents.includes(sourceItemId)) {
              aggregate.dependents.push(sourceItemId);
            }
          } else if (action === 'unlinked') {
            aggregate.dependents = aggregate.dependents.filter(id => id !== sourceItemId);
          }
        }
        break;

      case 'monitor':
        // Update monitors
        const hash = eventData.hash;
        aggregate.monitors = aggregate.monitors || [];

        if (action === 'added') {
          if (!aggregate.monitors.find(m => this._sameMonitor(m, hash, eventData.person))) {
            aggregate.monitors.push({ hash, ...eventData.person });
          }
        } else if (action === 'removed') {
          aggregate.monitors = aggregate.monitors.filter(m => !this._sameMonitor(m, hash, eventData.person));
        }
        break;

      case 'ignored':
        // Update ignored flag
        aggregate.ignored = (action === 'set');
        break;

      case 'taken':
        // Update takenBy
        if (action === 'taken') {
          aggregate.takenBy = eventData.person;
        } else if (action === 'surrendered') {
          aggregate.takenBy = null;
        }
        break;

      default:
        throw new Error(`Unknown event type: ${eventType}`);
    }

    this._refreshDerived(aggregate, eventData);

    return aggregate;
  }

  /**
   * Extract all itemIds from an event filename
   * @param {string} filename - Event filename
   * @returns {Array<string>} Array of itemIds found in filename
   * @private
   */
  _extractItemIdsFromFilename(filename) {
    const itemIds = new Set();
    const parts = filename.split('.');

    // First part is always an itemId if it's an 8-digit number
    const firstPart = parts[0];
    if (/^\d{8}$/.test(firstPart)) {
      itemIds.add(firstPart);
    }

    // For dependency files: itemId.dependency.action.targetItemId.timestamp.random.json
    // The targetItemId is in position 3
    if (parts[1] === 'dependency' && parts.length >= 4) {
      const targetItemId = parts[3];
      if (/^\d{8}$/.test(targetItemId)) {
        itemIds.add(targetItemId);
      }
    }

    return Array.from(itemIds);
  }

  /**
   * Get metrics for incremental vs full rebuild performance
   * @returns {Object} Metrics object with counts and averages
   */
  getMetrics() {
    const avgFilesIncremental = this.metrics.incrementalUpdates > 0
      ? this.metrics.totalFilesReadIncremental / this.metrics.incrementalUpdates
      : 0;

    const avgFilesRebuild = this.metrics.fullRebuilds > 0
      ? this.metrics.totalFilesReadRebuild / this.metrics.fullRebuilds
      : 0;

    const avgDurationIncremental = this.metrics.incrementalUpdates > 0
      ? this.metrics.totalDurationIncremental / this.metrics.incrementalUpdates
      : 0;

    const avgDurationRebuild = this.metrics.fullRebuilds > 0
      ? this.metrics.totalDurationRebuild / this.metrics.fullRebuilds
      : 0;

    const totalUpdates = this.metrics.incrementalUpdates + this.metrics.fullRebuilds;
    const incrementalPercentage = totalUpdates > 0
      ? (this.metrics.incrementalUpdates / totalUpdates * 100).toFixed(1)
      : 0;

    return {
      incrementalUpdates: this.metrics.incrementalUpdates,
      fullRebuilds: this.metrics.fullRebuilds,
      totalUpdates,
      incrementalPercentage: parseFloat(incrementalPercentage),
      avgFilesReadIncremental: parseFloat(avgFilesIncremental.toFixed(2)),
      avgFilesReadRebuild: parseFloat(avgFilesRebuild.toFixed(2)),
      avgDurationIncremental: parseFloat(avgDurationIncremental.toFixed(2)),
      avgDurationRebuild: parseFloat(avgDurationRebuild.toFixed(2)),
      speedupFactor: avgDurationRebuild > 0 && avgDurationIncremental > 0
        ? parseFloat((avgDurationRebuild / avgDurationIncremental).toFixed(2))
        : 0
    };
  }

  /**
   * Reset metrics counters
   */
  resetMetrics() {
    this.metrics = {
      incrementalUpdates: 0,
      fullRebuilds: 0,
      totalFilesReadIncremental: 0,
      totalFilesReadRebuild: 0,
      totalDurationIncremental: 0,
      totalDurationRebuild: 0
    };
  }

  /**
   * Print metrics summary to console
   */
  printMetrics() {
    const metrics = this.getMetrics();
    console.log('\n=== Aggregate Update Metrics ===');
    console.log(`Total Updates: ${metrics.totalUpdates}`);
    console.log(`  Incremental: ${metrics.incrementalUpdates} (${metrics.incrementalPercentage}%)`);
    console.log(`  Full Rebuilds: ${metrics.fullRebuilds} (${(100 - metrics.incrementalPercentage).toFixed(1)}%)`);
    console.log(`\nAverage Files Read:`);
    console.log(`  Incremental: ${metrics.avgFilesReadIncremental}`);
    console.log(`  Full Rebuild: ${metrics.avgFilesReadRebuild}`);
    console.log(`\nAverage Duration:`);
    console.log(`  Incremental: ${metrics.avgDurationIncremental}ms`);
    console.log(`  Full Rebuild: ${metrics.avgDurationRebuild}ms`);
    if (metrics.speedupFactor > 0) {
      console.log(`\nSpeedup Factor: ${metrics.speedupFactor}x faster`);
    }
    console.log('================================\n');
  }

  // Legacy aliases for backward compatibility.
  // NOTE: a class body's later definition wins, so an alias must never reuse the name of
  // a real method above it. There used to be a `validateAllAggregates()` alias here whose
  // body was `return await this.validateAllAggregates()` — it silently shadowed the real
  // implementation and recursed until the stack blew. It was unreachable while nothing
  // called the method; wiring the daemon to this class made it reachable.
  async initializeAggregateStore() {
    return await this.start();
  }

  async rebuildAllAggregates(progressCallback = null) {
    return await this.rebuildAll(progressCallback);
  }
}
