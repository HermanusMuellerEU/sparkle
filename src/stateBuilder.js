/**
 * Copyright 2025 Limitless Knowledge Association. Open sourced under MIT license.
 *
 * Build the current state of an item from its files
 */

/**
 * Parse a filename to extract its components
 * @param {string} filename - Filename to parse
 * @returns {Object} Parsed components {itemId, type, action, target, timestamp, random}
 */
function parseFilename(filename) {
  const parts = filename.replace('.json', '').split('.');

  if (parts.length === 1) {
    // Item creation file: <item>.json
    return {
      itemId: parts[0],
      type: 'item',
      timestamp: '0',
      random: ''
    };
  }

  const itemId = parts[0];
  const type = parts[1];

  // Handle dependency files: <item>.dependency.linked/unlinked.<target>.<timestamp>.<random>.json
  if (type === 'dependency') {
    return {
      itemId,
      type,
      action: parts[2], // 'linked' or 'unlinked'
      target: parts[3], // target item ID
      timestamp: parts[4],
      random: parts[5]
    };
  }

  // Handle monitor files: <item>.monitor.added/removed.<hash>.<timestamp>.<random>.json
  if (type === 'monitor') {
    return {
      itemId,
      type,
      action: parts[2], // 'added' or 'removed'
      hash: parts[3], // person hash
      timestamp: parts[4],
      random: parts[5]
    };
  }

  // Handle taken files: <item>.taken.taken/surrendered.<hash>.<timestamp>.<random>.json
  if (type === 'taken') {
    return {
      itemId,
      type,
      action: parts[2], // 'taken' or 'surrendered'
      hash: parts[3], // person hash
      timestamp: parts[4],
      random: parts[5]
    };
  }

  // Handle ignored files: <item>.ignored.set/cleared.<timestamp>.<random>.json
  if (type === 'ignored') {
    return {
      itemId,
      type,
      action: parts[2], // 'set' or 'cleared'
      timestamp: parts[3],
      random: parts[4]
    };
  }

  // Handle other files: <item>.<type>.<timestamp>.<random>.json
  return {
    itemId,
    type,
    timestamp: parts[2],
    random: parts[3]
  };
}

/**
 * Build active dependencies and dependents for an item
 * Processes dependency files where this itemId appears in ANY position
 * @param {Array} files - Array of {filename, data} objects (all files mentioning this item)
 * @param {string} itemId - The item ID we're building state for
 * @returns {{dependencies: Set<string>, dependents: Set<string>}}
 */
function buildActiveDependenciesAndDependents(files, itemId) {
  const dependencyFiles = files.filter(f => {
    const parsed = parseFilename(f.filename);
    return parsed.type === 'dependency';
  });

  // Group by the other item ID (not our itemId)
  // Map structure: otherItemId -> {isForward: boolean, events: [...]}
  // isForward=true means: itemId depends on otherItemId (itemId.dependency.*.otherItemId)
  // isForward=false means: otherItemId depends on itemId (otherItemId.dependency.*.itemId)
  const byOtherItem = new Map();

  for (const file of dependencyFiles) {
    const parsed = parseFilename(file.filename);

    // Determine direction
    let otherItemId;
    let isForward;

    if (parsed.itemId === itemId) {
      // This item is doing the depending (itemId.dependency.*.target)
      otherItemId = parsed.target;
      isForward = true;
    } else {
      // This item is being depended upon (otherItem.dependency.*.itemId)
      otherItemId = parsed.itemId;
      isForward = false;
    }

    const key = `${otherItemId}-${isForward}`;
    if (!byOtherItem.has(key)) {
      byOtherItem.set(key, { otherItemId, isForward, events: [] });
    }

    byOtherItem.get(key).events.push({
      action: parsed.action,
      timestamp: parsed.timestamp,
      data: file.data
    });
  }

  // For each relationship, check if currently active
  const dependencies = new Set();
  const dependents = new Set();

  for (const [key, {otherItemId, isForward, events}] of byOtherItem.entries()) {
    // Sort by timestamp
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Latest action determines if active
    const latest = events[events.length - 1];
    if (latest.action === 'linked') {
      if (isForward) {
        dependencies.add(otherItemId);
      } else {
        dependents.add(otherItemId);
      }
    }
  }

  return { dependencies, dependents };
}

/**
 * Build active dependencies for an item (backward compatibility)
 * @param {Array} files - Array of {filename, data} objects
 * @param {string} itemId - The item ID (optional for backward compatibility)
 * @returns {Set<string>} Set of currently active dependencies (item IDs this item depends on)
 */
function buildActiveDependencies(files, itemId = null) {
  if (itemId) {
    const {dependencies} = buildActiveDependenciesAndDependents(files, itemId);
    return dependencies;
  }

  // Old behavior for backward compatibility when itemId not provided
  const dependencyFiles = files.filter(f => {
    const parsed = parseFilename(f.filename);
    return parsed.type === 'dependency';
  });

  const byTarget = new Map();

  for (const file of dependencyFiles) {
    const parsed = parseFilename(file.filename);
    if (!byTarget.has(parsed.target)) {
      byTarget.set(parsed.target, []);
    }
    byTarget.get(parsed.target).push({
      action: parsed.action,
      timestamp: parsed.timestamp,
      data: file.data
    });
  }

  const active = new Set();

  for (const [target, events] of byTarget.entries()) {
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const latest = events[events.length - 1];
    if (latest.action === 'linked') {
      active.add(target);
    }
  }

  return active;
}

/**
 * Build active monitors for an item
 * @param {Array} files - Array of {filename, data} objects
 * @returns {Map<string, Object>} Map of hash -> person data for currently active monitors
 */
function buildActiveMonitors(files) {
  const monitorFiles = files.filter(f => {
    const parsed = parseFilename(f.filename);
    return parsed.type === 'monitor';
  });

  // Group by hash
  const byHash = new Map();

  for (const file of monitorFiles) {
    const parsed = parseFilename(file.filename);
    if (!byHash.has(parsed.hash)) {
      byHash.set(parsed.hash, []);
    }
    byHash.get(parsed.hash).push({
      action: parsed.action,
      timestamp: parsed.timestamp,
      data: file.data
    });
  }

  // For each hash, check if currently active
  const active = new Map();

  for (const [hash, events] of byHash.entries()) {
    // Sort by timestamp
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Latest action determines if active
    const latest = events[events.length - 1];
    if (latest.action === 'added') {
      // Include hash so incremental remove can match the same identity the add path stores.
      active.set(hash, { hash, ...latest.data.person });
    }
  }

  return active;
}

/**
 * Build ignored status for an item
 * @param {Array} files - Array of {filename, data} objects
 * @returns {boolean} True if item is currently ignored
 */
function buildIgnoredStatus(files) {
  const ignoredFiles = files.filter(f => {
    const parsed = parseFilename(f.filename);
    return parsed.type === 'ignored';
  });

  if (ignoredFiles.length === 0) {
    return false;
  }

  // Sort by timestamp
  ignoredFiles.sort((a, b) => {
    const aTime = parseFilename(a.filename).timestamp;
    const bTime = parseFilename(b.filename).timestamp;
    return bTime.localeCompare(aTime);
  });

  // Latest action determines if ignored
  const latest = parseFilename(ignoredFiles[0].filename);
  return latest.action === 'set';
}

/**
 * Build the current taker for an item (only one person can take it at a time)
 * @param {Array} files - Array of {filename, data} objects
 * @returns {Object|null} Person data for who currently has taken the item, or null if no one
 */
function buildCurrentTaker(files) {
  const takenFiles = files.filter(f => {
    const parsed = parseFilename(f.filename);
    return parsed.type === 'taken';
  });

  if (takenFiles.length === 0) {
    return null;
  }

  // Sort all taken events by timestamp to find the most recent
  const allEvents = takenFiles.map(file => {
    const parsed = parseFilename(file.filename);
    return {
      action: parsed.action,
      hash: parsed.hash,
      timestamp: parsed.timestamp,
      person: file.data.person
    };
  });

  // Sort by timestamp (most recent last)
  allEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Get the most recent event
  const latest = allEvents[allEvents.length - 1];

  // If the most recent action was 'taken', that person has it
  // If the most recent action was 'surrendered', no one has it
  if (latest.action === 'taken') {
    return latest.person;
  }

  return null;
}

/**
 * Get the current tagline
 * @param {Array} files - Array of {filename, data} objects
 * @returns {string|null} Current tagline or null
 */
function getCurrentTagline(files) {
  const taglineFiles = files.filter(f => {
    const parsed = parseFilename(f.filename);
    return parsed.type === 'tagline';
  });

  if (taglineFiles.length === 0) {
    return null;
  }

  // Sort by timestamp and take the latest
  taglineFiles.sort((a, b) => {
    const aTime = parseFilename(a.filename).timestamp;
    const bTime = parseFilename(b.filename).timestamp;
    return bTime.localeCompare(aTime);
  });

  return taglineFiles[0].data.tagline;
}

/**
 * Get the current status
 * @param {Array} files - Array of {filename, data} objects
 * @returns {string|null} Current status or null
 */
function getCurrentStatus(files) {
  const statusFiles = files.filter(f => {
    const parsed = parseFilename(f.filename);
    return parsed.type === 'status';
  });

  if (statusFiles.length === 0) {
    return null;
  }

  // Sort by timestamp and take the latest
  statusFiles.sort((a, b) => {
    const aTime = parseFilename(a.filename).timestamp;
    const bTime = parseFilename(b.filename).timestamp;
    return bTime.localeCompare(aTime);
  });

  return statusFiles[0].data.status;
}

/**
 * Get all entries in chronological order
 *
 * Each entry carries a `seq`: a 1-based position in CREATION order, scoped to the item.
 * The oldest entry is 1 and newer entries have higher numbers, so a seq always refers to
 * the same entry no matter how a view chooses to sort or filter. It is a derived, static
 * attribute of the generated aggregate — it is NOT stored in the event files and cannot
 * be edited. The browser renders entries newest-first, so the column reads downward.
 *
 * @param {Array} files - Array of {filename, data} objects
 * @returns {Array<Object>} Array of entry data objects, each with a `seq`
 */
function getEntries(files) {
  const entryFiles = files.filter(f => {
    const parsed = parseFilename(f.filename);
    return parsed.type === 'entry';
  });

  // Sort by timestamp
  entryFiles.sort((a, b) => {
    const aTime = parseFilename(a.filename).timestamp;
    const bTime = parseFilename(b.filename).timestamp;
    return aTime.localeCompare(bTime);
  });

  return entryFiles.map((f, index) => ({ ...f.data, seq: index + 1 }));
}

/**
 * Get item creation data
 * @param {Array} files - Array of {filename, data} objects
 * @returns {Object|null} Item creation data or null
 */
function getItemData(files) {
  const itemFile = files.find(f => {
    const parsed = parseFilename(f.filename);
    return parsed.type === 'item';
  });

  return itemFile ? itemFile.data : null;
}

/**
 * Build dependents (reverse dependencies) for an item
 * @param {string} itemId - The item to find dependents for
 * @param {Map<string, Array>} allItemFiles - Map of all itemId -> Array of {filename, data} objects
 * @returns {Set<string>} Set of item IDs that depend on this item
 */
function buildDependents(itemId, allItemFiles) {
  const dependents = new Set();

  // Scan all items to find ones that have this item as a dependency
  for (const [otherItemId, files] of allItemFiles.entries()) {
    if (otherItemId === itemId) continue; // Skip self

    const dependencies = buildActiveDependencies(files);
    if (dependencies.has(itemId)) {
      dependents.add(otherItemId);
    }
  }

  return dependents;
}

/**
 * Build the complete current state of an item
 * @param {Array} files - Array of {filename, data} objects (includes ALL events mentioning this itemId)
 * @param {string} itemId - The item ID being built (required for dependency/dependent calculation)
 * @returns {Object|null} Item state or null if item doesn't exist
 */
export function buildItemState(files, itemId = null) {
  const itemData = getItemData(files);

  if (!itemData) {
    return null; // Item doesn't exist
  }

  const tagline = getCurrentTagline(files);
  const status = getCurrentStatus(files);

  // Build dependencies and dependents from ALL dependency files mentioning this item
  let dependencies = [];
  let dependents = [];

  if (itemId) {
    const result = buildActiveDependenciesAndDependents(files, itemId);
    dependencies = Array.from(result.dependencies);
    dependents = Array.from(result.dependents);
  } else {
    // Fallback for backward compatibility
    const deps = buildActiveDependencies(files);
    dependencies = Array.from(deps);
  }

  const monitors = buildActiveMonitors(files);
  const takenBy = buildCurrentTaker(files);
  const entries = getEntries(files);
  const ignored = buildIgnoredStatus(files);

  return {
    ...itemData,
    tagline: tagline || itemData.tagline, // Use initial tagline if no updates
    status: status || itemData.status, // Use initial status if no updates
    dependencies,
    dependents,
    monitors: Array.from(monitors.values()),
    takenBy, // Single person object or null
    entries,
    ignored
  };
}

/**
 * Build active dependencies map for all items
 * @param {Map<string, Array>} allItemFiles - Map of itemId -> Array of {filename, data}
 * @returns {Map<string, Set<string>>} Map of itemNeeding -> Set of itemsNeeded
 */
export function buildAllActiveDependencies(allItemFiles) {
  const activeDeps = new Map();

  for (const [itemId, files] of allItemFiles.entries()) {
    const deps = buildActiveDependencies(files);
    if (deps.size > 0) {
      activeDeps.set(itemId, deps);
    }
  }

  return activeDeps;
}

export { parseFilename, buildIgnoredStatus };
