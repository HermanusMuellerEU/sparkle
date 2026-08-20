/**
 * Copyright 2025 Limitless Knowledge Association. Open sourced under MIT license.
 *
 * Sparkle - A system to keep track of all the details
 * Main API module (Facade)
 */

import { join } from 'path';
import { readMatchingFiles, readJsonFile, getItemFiles } from './fileUtils.js';
import { buildItemState, buildAllActiveDependencies } from './stateBuilder.js';
import { getItemsDependingOn, wouldCreateCycle } from './dependencyGraph.js';
import { getItemDetails as utilsGetItemDetails, getAllItemFiles as utilsGetAllItemFiles, getAllowedStatuses as utilsGetAllowedStatuses, getTakers as utilsGetTakers } from './utils.js';

// Aggregate Manager (import for convenience, but injected via setAggregateManager)
import * as aggregateManager from './aggregateManager.js';

// Controllers
import * as itemController from './controllers/itemController.js';
import * as taglineController from './controllers/taglineController.js';
import * as entryController from './controllers/entryController.js';
import * as statusController from './controllers/statusController.js';
import * as dependencyController from './controllers/dependencyController.js';
import * as monitorController from './controllers/monitorController.js';
import * as ignoredController from './controllers/ignoredController.js';
import * as takenController from './controllers/takenController.js';
import * as statusFileController from './controllers/statusFileController.js';

// Default base directory for sparkle data (can be overridden for testing)
let baseDirectory = './sparkle-data';

// Injected aggregate manager (can be null for no-op, or a mock for testing)
let injectedAggregateManager = null;

// Injected git scheduler (can be null for no-op, or a function for daemon)
let injectedGitScheduler = null;

/**
 * Set the base directory for sparkle data (primarily for testing)
 * @param {string} dir - Directory path
 */
export function setBaseDirectory(dir) {
  baseDirectory = dir;
}

/**
 * Get the current base directory
 * @returns {string} Current base directory
 */
export function getBaseDirectory() {
  return baseDirectory;
}

/**
 * Set the aggregate manager implementation (dependency injection)
 * @param {Object|null} manager - Aggregate manager implementation (or null to disable)
 */
export function setAggregateManager(manager) {
  injectedAggregateManager = manager;
}

/**
 * Get the current aggregate manager
 * @returns {Object|null} Current aggregate manager
 */
export function getAggregateManager() {
  return injectedAggregateManager;
}

/**
 * Set the git scheduler function (dependency injection)
 * @param {Function|null} scheduler - Function to call after file changes (or null to disable)
 */
export function setGitScheduler(scheduler) {
  injectedGitScheduler = scheduler;
}

/**
 * Get the current git scheduler
 * @returns {Function|null} Current git scheduler
 */
export function getGitScheduler() {
  return injectedGitScheduler;
}

/**
 * Get all allowed statuses (for UI purposes)
 * @returns {Promise<Array<string>>} Array of allowed statuses
 */
export async function getAllowedStatuses() {
  return await utilsGetAllowedStatuses(baseDirectory);
}

/**
 * Update the allowed statuses file
 * @param {Array<string>} statuses - Array of custom status names (excluding 'incomplete' and 'completed')
 * @returns {Promise<void>}
 */
export async function updateStatuses(statuses) {
  await statusController.updateStatusConfiguration(baseDirectory, statuses);
}

/**
 * Get all known takers
 * @returns {Promise<Array<Object>>} Array of takers [{name, email, hash}]
 */
export async function getTakers() {
  return await utilsGetTakers(baseDirectory);
}

/**
 * Get configuration (merged with defaults and local config)
 * @param {Object} localConfig - Optional local configuration from client (localStorage)
 * @returns {Promise<Object>} Configuration object with defaults, project, and merged values
 */
export async function getConfig(localConfig = null) {
  const configManager = await import('./configManager.js');
  const defaults = configManager.getSystemDefaults();
  const project = await configManager.loadProjectConfig(baseDirectory);
  const merged = await configManager.getMergedConfig(baseDirectory, localConfig);

  return {
    defaults,
    project,
    merged
  };
}

/**
 * Save per-project configuration
 * @param {Object} config - Configuration object to save
 * @returns {Promise<void>}
 */
export async function setProjectConfig(config) {
  const configManager = await import('./configManager.js');
  await configManager.saveProjectConfig(baseDirectory, config);
}

/**
 * Create a new item
 * @param {string} tagline - Short description of the item
 * @param {string} [status='incomplete'] - Initial status
 * @param {string} [initialEntry] - Optional initial entry text
 * @returns {Promise<string>} Item ID
 */
export async function createItem(tagline, status = 'incomplete', initialEntry) {
  // The controller applies the event to the aggregate itself (delta path). Passing the
  // manager here instead of calling rebuildAggregate() afterwards is what avoids
  // re-reading every event file in the repo just to record one new item.
  const itemId = await itemController.createItem(
    baseDirectory, tagline, status, initialEntry, injectedAggregateManager);

  // Schedule git commit (if git scheduler is injected)
  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }

  return itemId;
}

/**
 * Get item details (from aggregates if available, otherwise from events)
 * @param {string} itemId - Item identifier
 * @returns {Promise<Object>} Deep copy of item details
 */
export async function getItemDetails(itemId) {
  const startTime = Date.now();

  // Use aggregates if manager is injected
  if (injectedAggregateManager) {
    const aggregate = await injectedAggregateManager.getAggregate(itemId);

    if (!aggregate) {
      throw new Error(`Item ${itemId} does not exist`);
    }

    const duration = Date.now() - startTime;
    console.log(`[Core] getItemDetails(${itemId}) - source: aggregate, duration: ${duration}ms`);

    // Return deep copy
    return JSON.parse(JSON.stringify(aggregate));
  }

  // Fall back to event sourcing
  const result = await utilsGetItemDetails(baseDirectory, itemId);
  const duration = Date.now() - startTime;
  console.log(`[Core] getItemDetails(${itemId}) - source: event sourcing, duration: ${duration}ms`);

  return result;
}

/**
 * Alter the tagline of an item
 * @param {string} itemId - Item identifier
 * @param {string} tagline - New tagline
 */
export async function alterTagline(itemId, tagline) {
  await taglineController.alterTagline(baseDirectory, itemId, tagline, injectedAggregateManager);

  // Schedule git commit (if git scheduler is injected)
  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }
}

/**
 * Add an entry to an item
 * @param {string} itemId - Item identifier
 * @param {string} text - Entry text
 */
export async function addEntry(itemId, text) {
  await entryController.addEntry(baseDirectory, itemId, text, injectedAggregateManager);

  // Schedule git commit (if git scheduler is injected)
  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }
}

/**
 * Update the status of an item
 * @param {string} itemId - Item identifier
 * @param {string} status - New status
 * @param {string} [text=''] - Optional text explanation
 */
export async function updateStatus(itemId, status, text = '') {
  await statusController.updateStatus(baseDirectory, itemId, status, text, injectedAggregateManager);

  // Schedule git commit (if git scheduler is injected)
  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }
}

/**
 * Add a dependency between items
 * @param {string} itemNeeding - Item that needs another
 * @param {string} itemNeeded - Item that is needed
 */
export async function addDependency(itemNeeding, itemNeeded) {
  // One event file names both items; updateAggregateForEvent extracts both IDs from the
  // filename and updates each aggregate, so a single call covers the pair.
  await dependencyController.addDependency(
    baseDirectory, itemNeeding, itemNeeded, injectedAggregateManager);

  // Schedule git commit (if git scheduler is injected)
  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }
}

/**
 * Remove a dependency between items
 * @param {string} itemNeeding - Item that needs another
 * @param {string} itemNeeded - Item that is needed
 */
export async function removeDependency(itemNeeding, itemNeeded) {
  await dependencyController.removeDependency(
    baseDirectory, itemNeeding, itemNeeded, injectedAggregateManager);

  // Schedule git commit (if git scheduler is injected)
  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }
}

/**
 * Add current user as a monitor for an item
 * @param {string} itemId - Item identifier
 */
export async function addMonitor(itemId) {
  await monitorController.addMonitor(baseDirectory, itemId, injectedAggregateManager);

  // Schedule git commit (if git scheduler is injected)
  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }
}

/**
 * Remove current user as a monitor for an item
 * @param {string} itemId - Item identifier
 */
export async function removeMonitor(itemId) {
  await monitorController.removeMonitor(baseDirectory, itemId, injectedAggregateManager);

  // Schedule git commit (if git scheduler is injected)
  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }
}

/**
 * Mark an item as ignored
 * @param {string} itemId - Item identifier
 */
export async function ignoreItem(itemId) {
  await ignoredController.ignoreItem(baseDirectory, itemId, injectedAggregateManager);

  // Schedule git commit (if git scheduler is injected)
  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }
}

/**
 * Remove ignore flag from an item
 * @param {string} itemId - Item identifier
 */
export async function unignoreItem(itemId) {
  await ignoredController.unignoreItem(baseDirectory, itemId, injectedAggregateManager);

  // Schedule git commit (if git scheduler is injected)
  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }
}

/**
 * Take responsibility for an item (only one person can take it at a time)
 * When someone takes an item, they automatically become the sole taker
 * @param {string} itemId - Item identifier
 */
export async function takeItem(itemId) {
  await takenController.takeItem(baseDirectory, itemId, injectedAggregateManager);

  // Schedule git commit (if git scheduler is injected)
  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }
}

/**
 * Surrender (un-take) responsibility for an item
 * Only the current taker can surrender
 * @param {string} itemId - Item identifier
 */
export async function surrenderItem(itemId) {
  await takenController.surrenderItem(baseDirectory, itemId, injectedAggregateManager);

  // Schedule git commit (if git scheduler is injected)
  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }
}

/**
 * Query for pending work - items that are not completed and have no unmet dependencies
 * This is an async generator that yields item IDs that are ready to be worked on
 * @yields {string} Item IDs that are pending work
 */
export async function* pendingWork() {
  // Use aggregates if manager is injected
  if (injectedAggregateManager) {
    const aggregates = await injectedAggregateManager.getAllAggregates();

    // Build dependency map from aggregates
    const allAggregates = new Map();
    for (const aggregate of aggregates) {
      allAggregates.set(aggregate.itemId, aggregate);
    }

    // Check each item
    for (const aggregate of aggregates) {
      // Skip if already completed
      if (aggregate.status === 'completed') {
        continue;
      }

      // Check if all dependencies are met
      const deps = aggregate.dependencies || [];
      let allDependenciesMet = true;

      if (deps.length > 0) {
        for (const depId of deps) {
          const depAggregate = allAggregates.get(depId);
          if (!depAggregate || depAggregate.status !== 'completed') {
            allDependenciesMet = false;
            break;
          }
        }
      }

      // If not completed and all dependencies met, it's pending work
      if (allDependenciesMet) {
        yield aggregate.itemId;
      }
    }
    return;
  }

  // Fall back to event sourcing
  const allItemFiles = await utilsGetAllItemFiles(baseDirectory);
  const activeDeps = buildAllActiveDependencies(allItemFiles);

  // Check each item
  for (const [itemId, files] of allItemFiles.entries()) {
    const state = buildItemState(files);

    if (!state) {
      continue; // Skip if item doesn't exist
    }

    // Skip if already completed
    if (state.status === 'completed') {
      continue;
    }

    // Check if all dependencies are met
    const deps = activeDeps.get(itemId);
    let allDependenciesMet = true;

    if (deps && deps.size > 0) {
      for (const depId of deps) {
        const depFiles = allItemFiles.get(depId);
        if (depFiles) {
          const depState = buildItemState(depFiles);
          if (!depState || depState.status !== 'completed') {
            allDependenciesMet = false;
            break;
          }
        }
      }
    }

    // If not completed and all dependencies met, it's pending work
    if (allDependenciesMet) {
      yield itemId;
    }
  }
}

/**
 * Get all items with their basic information (from aggregates if available, otherwise from events)
 * @returns {Promise<Array>} Array of item objects with id, tagline, status, created
 */
export async function getAllItems() {
  const startTime = Date.now();

  // Use aggregates if manager is injected
  if (injectedAggregateManager) {
    console.log('[Core] getAllItems() - source: aggregates');
    const aggStartTime = Date.now();

    const aggregates = await injectedAggregateManager.getAllAggregates();

    const aggDuration = Date.now() - aggStartTime;
    const items = [];

    for (const aggregate of aggregates) {
      // Validate that the aggregate has all required fields
      if (aggregate && aggregate.itemId && aggregate.tagline && aggregate.status && aggregate.created) {
        items.push({
          itemId: aggregate.itemId,
          tagline: aggregate.tagline,
          status: aggregate.status,
          created: aggregate.created
        });
      } else if (aggregate) {
        // Log warning for invalid aggregates but don't crash
        console.warn(`Invalid aggregate for ${aggregate.itemId}:`, {
          hasItemId: !!aggregate.itemId,
          hasTagline: !!aggregate.tagline,
          hasStatus: !!aggregate.status,
          hasCreated: !!aggregate.created
        });
      }
    }

    // Sort by creation date (newest first)
    const sortStartTime = Date.now();
    items.sort((a, b) => new Date(b.created) - new Date(a.created));
    const sortDuration = Date.now() - sortStartTime;

    const totalDuration = Date.now() - startTime;
    console.log(`[Core] getAllItems() - fetchAggregates: ${aggDuration}ms, sort: ${sortDuration}ms, total: ${totalDuration}ms, count: ${items.length}`);

    return items;
  }

  // Fall back to event sourcing
  console.log('[Core] getAllItems() - source: event sourcing');
  const allItemFiles = await utilsGetAllItemFiles(baseDirectory);
  const items = [];

  for (const [itemId, files] of allItemFiles.entries()) {
    const state = buildItemState(files);

    // Validate that the state has all required fields
    if (state && state.itemId && state.tagline && state.status && state.created) {
      items.push({
        itemId: state.itemId,
        tagline: state.tagline,
        status: state.status,
        created: state.created
      });
    } else if (state) {
      // Log warning for invalid items but don't crash
      console.warn(`Invalid item state for ${itemId}:`, {
        hasItemId: !!state.itemId,
        hasTagline: !!state.tagline,
        hasStatus: !!state.status,
        hasCreated: !!state.created
      });
    }
  }

  // Sort by creation date (newest first)
  const sortStartTime = Date.now();
  items.sort((a, b) => new Date(b.created) - new Date(a.created));
  const sortDuration = Date.now() - sortStartTime;

  const totalDuration = Date.now() - startTime;
  console.log(`[Core] getAllItems() - eventSourcing: ${totalDuration - sortDuration}ms, sort: ${sortDuration}ms, total: ${totalDuration}ms, count: ${items.length}`);

  return items;
}

/**
 * Get items that could be valid dependents for a given item
 * (items that this item could depend on without creating a cycle)
 * @param {string} itemId - The item that would depend on others
 * @returns {Promise<Object>} Object with candidates array and current array
 */
export async function getPotentialDependencies(itemId) {
  // Verify item exists
  await utilsGetItemDetails(baseDirectory, itemId);

  // Get all items and active dependencies
  const allItemFiles = await utilsGetAllItemFiles(baseDirectory);
  const activeDeps = buildAllActiveDependencies(allItemFiles);

  // Get current dependencies for this item
  const currentDeps = activeDeps.get(itemId) || new Set();

  const candidates = [];
  const current = [];

  // Check each item to see if it could be a valid dependency
  for (const [candidateId, files] of allItemFiles.entries()) {
    // Skip self
    if (candidateId === itemId) {
      continue;
    }

    const state = buildItemState(files);
    // Validate state has required fields
    if (!state || !state.tagline || !state.status || !state.created) {
      continue;
    }

    const isCurrent = currentDeps.has(candidateId);

    // Check if adding this dependency would create a cycle
    // Only check if it's not already a current dependency
    const wouldCycle = !isCurrent && wouldCreateCycle(itemId, candidateId, activeDeps);

    if (!wouldCycle) {
      const itemInfo = {
        itemId: candidateId,
        tagline: state.tagline,
        status: state.status,
        created: state.created
      };

      if (isCurrent) {
        current.push(itemInfo);
      } else {
        candidates.push(itemInfo);
      }
    }
  }

  // Sort both arrays by creation date (newest first)
  candidates.sort((a, b) => new Date(b.created) - new Date(a.created));
  current.sort((a, b) => new Date(b.created) - new Date(a.created));

  return { candidates, current };
}

/**
 * Stream all items as a DAG (Directed Acyclic Graph) structure
 * Performs bidirectional traversal from a reference item, traversing both
 * up through providers (dependents) and down through dependencies.
 *
 * On first encounter of each item, includes full dependency information:
 * {item, neededBy, depth, full: {dependsOn: [], providesTo: []}}
 *
 * On subsequent encounters (when item appears via different path):
 * {item, neededBy, depth}
 *
 * @param {string} referenceId - The item ID to use as the reference point for traversal (required)
 * @yields {Object} {item: itemId, neededBy: parentItemId|null, depth: number, full?: {dependsOn: string[], providesTo: string[]}}
 * @throws {Error} If referenceId is not provided or doesn't exist
 */
export async function* getAllItemsAsDag(referenceId) {
  // Validate referenceId is provided
  if (!referenceId) {
    throw new Error('referenceId parameter is required for getAllItemsAsDag()');
  }

  let allItemIds, activeDeps;

  // Use aggregates if manager is injected
  if (injectedAggregateManager) {
    const aggregates = await injectedAggregateManager.getAllAggregates();

    // Build maps
    allItemIds = new Set();
    activeDeps = new Map();

    for (const aggregate of aggregates) {
      allItemIds.add(aggregate.itemId);
      if (aggregate.dependencies && aggregate.dependencies.length > 0) {
        activeDeps.set(aggregate.itemId, new Set(aggregate.dependencies));
      }
    }
  } else {
    // Fall back to event sourcing
    const allItemFiles = await utilsGetAllItemFiles(baseDirectory);
    activeDeps = buildAllActiveDependencies(allItemFiles);
    allItemIds = new Set(allItemFiles.keys());
  }

  // Verify reference item exists
  if (!allItemIds.has(referenceId)) {
    throw new Error(`Reference item ${referenceId} not found`);
  }

  // Build reverse dependencies map (who depends on each item)
  const reverseDeps = new Map();
  for (const itemId of allItemIds) {
    const dependents = getItemsDependingOn(itemId, activeDeps);
    if (dependents.size > 0) {
      reverseDeps.set(itemId, dependents);
    }
  }

  // Track which items have been yielded to include full info only on first encounter
  const yieldedItems = new Set();
  const visited = new Set();

  // Bidirectional BFS traversal from reference item
  function* traverseBidirectional(startItemId) {
    const queue = [{ itemId: startItemId, neededBy: null, depth: 0 }];

    while (queue.length > 0) {
      const { itemId, neededBy, depth } = queue.shift();

      if (visited.has(itemId)) {
        // Already processing this item (cycle or revisit)
        if (yieldedItems.has(itemId)) {
          // Already emitted, just emit reference marker
          yield { item: itemId, neededBy, depth };
        }
        continue;
      }

      visited.add(itemId);

      // Check if item exists
      if (!allItemIds.has(itemId)) {
        continue;
      }

      // Check if this is the first time we're yielding this item
      const isFirstEncounter = !yieldedItems.has(itemId);

      if (isFirstEncounter) {
        yieldedItems.add(itemId);

        // Include full dependency information on first encounter
        const dependsOn = activeDeps.get(itemId) || new Set();
        const providesTo = reverseDeps.get(itemId) || new Set();

        yield {
          item: itemId,
          neededBy,
          depth,
          full: {
            dependsOn: Array.from(dependsOn),
            providesTo: Array.from(providesTo)
          }
        };
      } else {
        // Subsequent encounters don't include full info
        yield {
          item: itemId,
          neededBy,
          depth
        };
      }

      // Add dependencies (downward traversal) to queue
      const dependencies = activeDeps.get(itemId) || new Set();
      for (const depId of dependencies) {
        if (!visited.has(depId) && allItemIds.has(depId)) {
          queue.push({ itemId: depId, neededBy: itemId, depth: depth + 1 });
        }
      }

      // Add providers (upward traversal) to queue
      const providers = reverseDeps.get(itemId) || new Set();
      for (const provId of providers) {
        if (!visited.has(provId) && allItemIds.has(provId)) {
          queue.push({ itemId: provId, neededBy: itemId, depth: depth + 1 });
        }
      }
    }
  }

  // Traverse from reference item
  yield* traverseBidirectional(referenceId);
}

/**
 * Get root items (items with no providers/dependents)
 * Useful for tree view to determine starting points for DAG traversal
 *
 * @returns {Promise<Array<{itemId: string, hasChildren: boolean}>>} Array of root item objects
 */
export async function getRootItems() {
  let allItemIds, activeDeps;

  // Use aggregates if manager is injected
  if (injectedAggregateManager) {
    const aggregates = await injectedAggregateManager.getAllAggregates();

    // Build maps
    allItemIds = new Set();
    activeDeps = new Map();

    for (const aggregate of aggregates) {
      allItemIds.add(aggregate.itemId);
      if (aggregate.dependencies && aggregate.dependencies.length > 0) {
        activeDeps.set(aggregate.itemId, new Set(aggregate.dependencies));
      }
    }
  } else {
    // Fall back to event sourcing
    const allItemFiles = await utilsGetAllItemFiles(baseDirectory);
    activeDeps = buildAllActiveDependencies(allItemFiles);
    allItemIds = new Set(allItemFiles.keys());
  }

  // Find items that have no other items depending on them (roots)
  const itemsWithDependents = new Set();
  for (const itemsNeeded of activeDeps.values()) {
    for (const itemNeeded of itemsNeeded) {
      itemsWithDependents.add(itemNeeded);
    }
  }

  // Roots are items that are not depended upon by anyone
  const roots = [];
  for (const itemId of allItemIds) {
    if (!itemsWithDependents.has(itemId)) {
      roots.push({
        itemId: itemId,
        hasChildren: activeDeps.has(itemId) && activeDeps.get(itemId).size > 0
      });
    }
  }

  return roots;
}

/**
 * Get items that could be valid dependents of a given item
 * (items that could depend on this item without creating a cycle)
 * @param {string} itemId - The item that others would depend on
 * @returns {Promise<Object>} Object with candidates array and current array
 */
export async function getPotentialDependents(itemId) {
  // Verify item exists
  await utilsGetItemDetails(baseDirectory, itemId);

  // Get all items and active dependencies
  const allItemFiles = await utilsGetAllItemFiles(baseDirectory);
  const activeDeps = buildAllActiveDependencies(allItemFiles);

  // Get items that currently depend on this item (reverse lookup)
  const currentDependents = new Set();
  for (const [needingId, neededIds] of activeDeps.entries()) {
    if (neededIds.has(itemId)) {
      currentDependents.add(needingId);
    }
  }

  const candidates = [];
  const current = [];

  // Check each item to see if it could validly depend on this item
  for (const [candidateId, files] of allItemFiles.entries()) {
    // Skip self
    if (candidateId === itemId) {
      continue;
    }

    const state = buildItemState(files);
    if (!state) {
      continue;
    }

    const isCurrent = currentDependents.has(candidateId);

    // Check if making candidateId depend on itemId would create a cycle
    // Only check if it's not already a current dependent
    const wouldCycle = !isCurrent && wouldCreateCycle(candidateId, itemId, activeDeps);

    if (!wouldCycle) {
      const itemInfo = {
        itemId: candidateId,
        tagline: state.tagline,
        status: state.status,
        created: state.created
      };

      if (isCurrent) {
        current.push(itemInfo);
      } else {
        candidates.push(itemInfo);
      }
    }
  }

  // Sort both arrays by creation date (newest first)
  candidates.sort((a, b) => new Date(b.created) - new Date(a.created));
  current.sort((a, b) => new Date(b.created) - new Date(a.created));

  return { candidates, current };
}

/**
 * Get audit trail for an item - all historical changes
 * This is an async generator that yields audit trail events in chronological order
 * @param {string} itemId - Item identifier
 * @yields {string} One-line text descriptions of what happened
 */
export async function* getItemAuditTrail(itemId) {
  // Verify item exists
  await utilsGetItemDetails(baseDirectory, itemId);

  // Get all files for this item
  const files = await getItemFiles(baseDirectory, itemId);

  // Get all files from all items to find reverse dependencies
  const allFiles = await readMatchingFiles(baseDirectory, '');
  const reverseDependencyFiles = [];

  // Find dependency files where OTHER items depend on THIS item
  // Format: otherItemId.dependency.linked/unlinked.itemId.timestamp.random.json
  for (const filename of allFiles) {
    const parts = filename.split('.');

    // Check if this is a dependency file
    if (parts.length >= 5 && parts[1] === 'dependency') {
      const action = parts[2]; // 'linked' or 'unlinked'
      const targetItemId = parts[3]; // the item being depended upon

      // If the target is our itemId, this is a reverse dependency
      if (targetItemId === itemId && (action === 'linked' || action === 'unlinked')) {
        const filePath = join(baseDirectory, filename);
        const data = await readJsonFile(filePath);
        reverseDependencyFiles.push({ filename, data });
      }
    }
  }

  // Combine files for this item with reverse dependency files for sorting
  const allAuditFiles = [...files, ...reverseDependencyFiles];

  // Sort all files by timestamp (extracted from filename)
  // File format examples:
  // - itemId.json (initial creation - use created timestamp)
  // - itemId.type.timestamp.random.json
  // - itemId.type.suffix.timestamp.random.json
  allAuditFiles.sort((a, b) => {
    const partsA = a.filename.split('.');
    const partsB = b.filename.split('.');

    // For base item file (itemId.json), use the created timestamp
    const timestampA = partsA.length === 2
      ? a.data.created
      : partsA[partsA.length - 3]; // timestamp is 3rd from the end (before random and .json)

    const timestampB = partsB.length === 2
      ? b.data.created
      : partsB[partsB.length - 3];

    return String(timestampA).localeCompare(String(timestampB));
  });

  // Process each file and generate audit trail entries
  for (const file of allAuditFiles) {
    const parts = file.filename.split('.');
    const fileItemId = parts[0]; // The item this file belongs to

    // Initial item creation: itemId.json
    if (parts.length === 2 && parts[1] === 'json') {
      const isoTimestamp = file.data.created; // Already in ISO format
      yield {
        timestamp: isoTimestamp,
        type: 'created',
        person: file.data.person,
        status: file.data.status
      };
      continue;
    }

    // Other record types have format: itemId.type.details.timestamp.json
    const recordType = parts[1];

    // All record types now use consistent person format
    const isoTimestamp = file.data.person.timestamp; // ISO format with milliseconds
    const person = file.data.person;

    switch (recordType) {
      case 'tagline':
        yield {
          timestamp: isoTimestamp,
          type: 'tagline',
          tagline: file.data.tagline,
          person: person
        };
        break;

      case 'entry':
        yield {
          timestamp: isoTimestamp,
          type: 'entry',
          text: file.data.text,
          person: person
        };
        break;

      case 'status':
        yield {
          timestamp: isoTimestamp,
          type: 'status',
          status: file.data.status,
          text: file.data.text || '',
          person: person
        };
        break;

      case 'dependency':
        // Format: itemId.dependency.action.otherItemId.timestamp.json
        const action = parts[2]; // 'linked' or 'unlinked'
        const otherItemId = parts[3];

        // Get the tagline for the related item
        const relatedId = fileItemId === itemId ? otherItemId : fileItemId;
        let relatedItemTagline = null;
        let relatedItemMissing = false;
        try {
          const relatedItemDetails = await utilsGetItemDetails(baseDirectory, relatedId);
          relatedItemTagline = relatedItemDetails.tagline;
        } catch (e) {
          // Item is missing - this indicates a data integrity problem
          relatedItemMissing = true;
        }

        // Check if this is a file from the audited item or a reverse dependency
        const isReverseDependency = fileItemId !== itemId;

        yield {
          timestamp: isoTimestamp,
          type: 'dependency',
          action: action, // 'linked' or 'unlinked'
          reverse: isReverseDependency,
          relatedItemId: relatedId,
          relatedItemTagline: relatedItemTagline,
          relatedItemMissing: relatedItemMissing,
          person: person
        };
        break;

      case 'monitor':
        // Format: itemId.monitor.action.hash.timestamp.json
        const monitorAction = parts[2]; // 'added' or 'removed'

        yield {
          timestamp: isoTimestamp,
          type: 'monitor',
          action: monitorAction, // 'added' or 'removed'
          person: person
        };
        break;

      case 'ignored':
        // Format: itemId.ignored.action.timestamp.json
        const ignoreAction = parts[2]; // 'set' or 'cleared'

        yield {
          timestamp: isoTimestamp,
          type: 'ignored',
          action: ignoreAction, // 'set' or 'cleared'
          person: person
        };
        break;

      case 'taken':
        // Format: itemId.taken.action.hash.timestamp.json
        const takenAction = parts[2]; // 'taken' or 'surrendered'

        yield {
          timestamp: isoTimestamp,
          type: 'taken',
          action: takenAction, // 'taken' or 'surrendered'
          person: person
        };
        break;

      default:
        // Unknown record type
        yield {
          timestamp: isoTimestamp,
          type: 'unknown',
          recordType: recordType
        };
    }
  }
}

// ============================================================================
// Export aggregate manager functions for daemon use
// ============================================================================

/**
 * Initialize the aggregate store
 * @param {string} baseDir - Base directory for sparkle data
 */
export async function initializeAggregateStore() {
  return await aggregateManager.initializeAggregateStore(baseDirectory);
}

/**
 * Register callback for when aggregates change (for SSE notifications)
 * @param {Function} callback - Called with (itemId) when aggregate changes
 */
export function onAggregateChanged(callback) {
  return aggregateManager.onAggregateChanged(callback);
}

/**
 * Rebuild all aggregates from events
 * @param {Function} progressCallback - Optional callback(current, total)
 * @param {{sparkleVersion?: string}} [options]
 */
export async function rebuildAllAggregates(progressCallback, options) {
  return await aggregateManager.rebuildAll(progressCallback, options);
}

/**
 * Validate all aggregates
 * @returns {Promise<{valid: boolean, invalidItems: Array}>}
 */
export async function validateAllAggregates() {
  return await aggregateManager.validateAllAggregates();
}

/**
 * Get aggregate rebuild status
 * @returns {{rebuilding: boolean, progress: {current: number, total: number}}}
 */
export function getAggregateStatus() {
  return aggregateManager.getAggregateStatus();
}

/**
 * Get aggregate metadata
 */
export async function getAggregateMetadata() {
  return await aggregateManager.getMetadata();
}

/**
 * Update aggregate metadata
 * @param {Object} updates - Fields to update
 */
export async function updateAggregateMetadata(updates) {
  return await aggregateManager.updateMetadata(updates);
}

/**
 * Rebuild a specific aggregate
 * @param {string} itemId - Item ID
 */
export async function rebuildAggregate(itemId) {
  return await aggregateManager.rebuildAggregate(itemId);
}

/**
 * Publish a status file, adding it if absent and replacing it wholesale if present.
 * Status files carry no per-item aggregate, so only git is scheduled.
 * @param {string} name - Status file name
 * @param {string} text - Full file content
 * @returns {Promise<{name: string, created: boolean, bytes: number}>}
 */
export async function addStatusFile(name, text) {
  const result = await statusFileController.addStatusFile(baseDirectory, name, text);

  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }

  return result;
}

/**
 * Remove a published status file.
 * @param {string} name - Status file name
 * @returns {Promise<{name: string}>}
 */
export async function removeStatusFile(name) {
  const result = await statusFileController.removeStatusFile(baseDirectory, name);

  if (injectedGitScheduler) {
    await injectedGitScheduler();
  }

  return result;
}

/**
 * List published status files.
 * @returns {Promise<Array<{name: string, size: number, modified: string}>>}
 */
export async function listStatusFiles() {
  return await statusFileController.listStatusFiles(baseDirectory);
}

/**
 * Read a published status file.
 * @param {string} name - Status file name
 * @returns {Promise<string>} File content
 */
export async function readStatusFile(name) {
  return await statusFileController.readStatusFile(baseDirectory, name);
}
