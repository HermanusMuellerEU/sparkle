#!/usr/bin/env node

/**
 * Copyright 2025 Limitless Knowledge Association. Open sourced under MIT license.
 *
 * Sparkle Agent - Daemon web server for Sparkle
 * Runs as a background process, provides HTTP API for Sparkle operations
 */

import { createServer, get as httpGet } from 'http';
import { readFile, writeFile, unlink } from 'fs/promises';
import { join, dirname, isAbsolute, basename } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, createWriteStream, readFileSync, unlinkSync } from 'fs';
import * as portFile from '../src/portFile.js';
import * as sparkle from '../src/sparkle.js';
import { SPARKLE_VERSION } from '../src/version.js';
import { isSparkleVersionOlder } from '../src/sparkleVersion.js';
import { execSyncWithOptions, execAsync } from '../src/execUtils.js';
import {
  getGitRoot,
  getLatestOriginCommit,
  branchExists,
  createBranch,
  setupWorktree,
  initializeSparkleDirectory,
  initializeSparkleWorktree,
  commitAndPush,
  fetchUpdates,
  getCurrentSHA,
  sparkleBranchExistsInOrigin,
  addToGitignore,
  checkOriginRemote,
  onGitAvailabilityChange
} from '../src/gitBranchOps.js';
import { getGitUser } from '../src/gitUtils.js';
import { openBrowser } from '../src/browserLauncher.js';
import { setCommitCallback, setPushCallback, isPushScheduled } from '../src/gitCommitScheduler.js';
import { GitOperations } from '../src/GitOperations.js';
import { HEARTBEAT_INTERVAL_MS } from '../src/heartbeat-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Store version in globalThis at startup - only read once
globalThis.SPARKLE_DAEMON_VERSION = SPARKLE_VERSION;

// Check if running in test mode
const isTestMode = process.argv.includes('--test-mode');
const testId = process.argv.find(arg => arg.startsWith('--test-id='))?.split('=')[1] || null;

// Parse keep-alive timeout:
// - No flag: 60s timeout (default)
// - --keep-alive: infinite (no timeout)
// - --keep-alive=api: 300s timeout (5 min, for CLI usage)
const keepAliveArg = process.argv.find(arg => arg.startsWith('--keep-alive'));
let noClientTimeoutDuration = 60000; // 60 seconds default

if (keepAliveArg === '--keep-alive') {
  noClientTimeoutDuration = null; // infinite
} else if (keepAliveArg === '--keep-alive=api') {
  noClientTimeoutDuration = 300000; // 5 minutes
}

// Import HTTP logging (will be initialized in main() if environment vars present)
import { initHttpLogger, createLogger } from '../src/httpLogger.js';
let logger = null;

// State
let gitRoot;
let worktreePath;
let sparkleDataPath;
let config = null;
let gitOps = null;
let lastChangeSHA = null;
// Tracked separately from lastChangeSHA on purpose. lastChangeSHA is "the SHA of the most
// recent change we told clients about" and is written from local commits too, so it is NOT
// a valid left-hand side for a diff against origin/<branch>. lastRemoteSHA is only ever
// the last origin SHA we have already processed, which is what the fetch diff needs.
let lastRemoteSHA = null;
let lastChangeTimestamp = null;
let fetchIntervalId = null;
let server = null;
let nextFetchTime = null;
let sseClients = []; // Track all SSE connections for broadcasting
let broadcastIntervalId = null; // Global broadcast interval
let gitAvailable = true; // Track git remote availability
let gitStatusReason = 'unknown'; // Track reason for current status
let gitStatusDetails = null; // Track additional details
let lastGitAvailabilityNotification = null; // Track last notification sent
let noClientTimeoutId = null; // Timeout for shutting down when no clients connected
let isFetchInProgress = false; // Track if a fetch operation is currently running
let rebuildInProgress = false; // Track if aggregate rebuild is in progress
let rebuildProgress = { current: 0, total: 0 }; // Rebuild progress tracking
let rebuildStartTime = null; // Track when rebuild started
let versionRebuildPending = false; // Hold data requests until version-change rebuild finishes
let versionRebuildGate = Promise.resolve();
let releaseVersionRebuildGate = null;
let shuttingDown = false; // Track if daemon is shutting down - never reset to false
let loggingEnabled = false; // Track if file logging has been set up
let logStream = null; // File stream for logging
let originalConsoleLog = console.log; // Store original console.log
let originalConsoleError = console.error; // Store original console.error

/**
 * Check if daemon is shutting down
 * @returns {boolean} True if daemon is halting, false otherwise
 */
function isHalting() {
  return shuttingDown;
}

/**
 * Start file logging to daemon.log (idempotent)
 * Can be called multiple times - will only set up logging once
 * Deletes old log file on first successful setup
 */
async function startLogging() {
  // Already enabled - ignore request (idempotent)
  if (loggingEnabled) {
    return;
  }

  // Check if sparkleDataPath exists and is set
  if (!sparkleDataPath || !existsSync(sparkleDataPath)) {
    // Directory doesn't exist yet - can't start logging
    return;
  }

  try {
    const logFilePath = join(sparkleDataPath, 'daemon.log');

    // Delete old log file if it exists (fresh log each run)
    try {
      await unlink(logFilePath);
    } catch (err) {
      // File doesn't exist, that's fine
    }

    // Create log stream
    logStream = createWriteStream(logFilePath, { flags: 'a' });

    // Redirect console to log file
    console.log = (...args) => {
      const timestamp = new Date().toISOString();
      const message = `[${timestamp}] ${args.join(' ')}\n`;
      if (logStream && loggingEnabled) {
        logStream.write(message);
      }
      originalConsoleLog(...args); // Also log to stdout
    };

    console.error = (...args) => {
      const timestamp = new Date().toISOString();
      const message = `[${timestamp}] ERROR: ${args.join(' ')}\n`;
      if (logStream && loggingEnabled) {
        logStream.write(message);
      }
      originalConsoleError(...args); // Also log to stderr
    };

    // Mark as enabled (must be set after console redirection is complete)
    loggingEnabled = true;

    console.log('File logging started');
    if (logger) logger.info('File logging initialized', { logPath: logFilePath });
  } catch (error) {
    // Failed to start logging - leave it ready to try again
    originalConsoleError('Failed to start file logging:', error.message);
    if (logger) logger.error('File logging failed to start', { error: error.message });
  }
}

/**
 * Start the no-client timeout - agent will exit after timeout with no clients
 * Timeout duration depends on --keep-alive flag:
 * - No flag: 60s (browser mode)
 * - --keep-alive=api: 300s (5 min, for CLI)
 * - --keep-alive: infinite (no timeout)
 */
function startNoClientTimeout() {
  // Skip timeout if in infinite keep-alive mode
  if (noClientTimeoutDuration === null) {
    console.log('⏰ No-client timeout NOT started (keep-alive mode)');
    return;
  }

  const timeoutSeconds = noClientTimeoutDuration / 1000;

  // Clear any existing timeout
  if (noClientTimeoutId) {
    console.log(`⏰ Restarting no-client timeout (${timeoutSeconds}s, old: ${noClientTimeoutId})`);
    clearTimeout(noClientTimeoutId);
  } else {
    console.log(`⏰ Starting no-client timeout (${timeoutSeconds} seconds)`);
  }

  noClientTimeoutId = setTimeout(() => {
    console.log(`🔴 DAEMON EXIT REASON: No-client timeout (${timeoutSeconds} seconds elapsed)`);
    console.log(`   - SSE clients: ${sseClients.length}`);
    console.log(`   - Timeout ID was: ${noClientTimeoutId}`);
    console.log(`No clients connected for ${timeoutSeconds} seconds. Shutting down gracefully...`);

    // Set shutdown flag - this prevents any further SSE broadcasts
    shuttingDown = true;

    if (logger) logger.info('Daemon exiting', { reason: 'no_client_timeout', duration: `${timeoutSeconds}s`, sseClients: sseClients.length });

    // Clean up intervals
    if (fetchIntervalId) {
      clearInterval(fetchIntervalId);
    }
    if (broadcastIntervalId) {
      clearInterval(broadcastIntervalId);
    }

    // Close all SSE connections
    console.log(`Closing ${sseClients.length} SSE connections...`);
    sseClients.forEach(client => {
      try {
        client.end();
      } catch (error) {
        console.error('Error closing SSE client:', error.message);
      }
    });
    sseClients = [];

    // Close server and exit
    if (server) {
      server.close(() => {
        console.log('Server closed due to inactivity.');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  }, noClientTimeoutDuration);
}

/**
 * Cancel the no-client timeout when clients connect
 */
function cancelNoClientTimeout() {
  if (noClientTimeoutId) {
    console.log(`⏹️  No-client timeout cancelled (was: ${noClientTimeoutId})`);
    if (logger) logger.info('No-client timeout cancelled');
    clearTimeout(noClientTimeoutId);
    noClientTimeoutId = null;
  }
}

/**
 * Broadcast an SSE event to all connected clients
 */
function broadcastSSE(eventName, data) {
  // If shutting down, close all SSE connections and don't send
  if (isHalting()) {
    console.log(`Not broadcasting ${eventName} - daemon is shutting down. Closing ${sseClients.length} SSE connections.`);
    sseClients.forEach(client => {
      try {
        client.end();
      } catch (error) {
        console.error('Error closing SSE client during broadcast:', error.message);
      }
    });
    sseClients = [];
    return;
  }

  console.log(`Broadcasting SSE event: ${eventName} to ${sseClients.length} clients`, data);
  const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(message);
    } catch (error) {
      console.error(`Failed to send SSE event ${eventName} to client:`, error.message);
    }
  });
}

/**
 * Update git availability status and notify clients if changed
 * @param {boolean} available - Whether git is available
 * @param {string} reason - Reason code for the status
 * @param {string} details - Optional additional details
 */
function updateGitAvailability(available, reason = 'unknown', details = null) {
  gitAvailable = available;
  gitStatusReason = reason;
  gitStatusDetails = details;

  // Broadcast on change OR if this is initial status (fixes initial connection bug)
  if (lastGitAvailabilityNotification !== available || lastGitAvailabilityNotification === null) {
    lastGitAvailabilityNotification = available;
    broadcastSSE('gitStatus', {
      active: available,
      reason: reason,
      details: details,
      timestamp: Date.now()
    });
    console.log(`Git status: ${available ? 'active' : 'needs refresh'} (${reason})`);
  }
}

/**
 * Start background rebuild of all aggregates
 */
async function startBackgroundRebuild() {
  // Several paths can ask for a repair (startup validation, an undiffable fetch).
  // AggregateModel.rebuildAll throws if one is already running, so gate here.
  if (rebuildInProgress) {
    console.log('Rebuild already in progress, ignoring request');
    return;
  }

  rebuildInProgress = true;
  rebuildStartTime = Date.now();

  // Get initial count
  const status = sparkle.getAggregateStatus();
  rebuildProgress = status.progress;

  // Broadcast rebuild started
  broadcastSSE('rebuildStarted', {
    total: rebuildProgress.total,
    reason: 'corruption_detected'
  });

  try {
    // Non-blocking rebuild with progress
    await sparkle.rebuildAllAggregates((current, total) => {
      rebuildProgress = { current, total };
      const percentage = Math.round((current / total) * 100);

      // Broadcast progress every 10 items
      if (current % 10 === 0 || current === total) {
        broadcastSSE('rebuildProgress', { current, total, percentage });
      }
    });

    // Broadcast completion
    const duration = Date.now() - rebuildStartTime;
    broadcastSSE('rebuildCompleted', {
      total: rebuildProgress.total,
      duration
    });

    console.log(`Aggregate rebuild complete: ${rebuildProgress.total} items in ${duration}ms`);
  } catch (error) {
    console.error('Aggregate rebuild failed:', error);
    broadcastSSE('rebuildFailed', { error: error.message });
  } finally {
    rebuildInProgress = false;
    rebuildStartTime = null;
  }
}

/**
 * Start global broadcast interval for countdown updates
 */
function startBroadcastInterval() {
  if (broadcastIntervalId) {
    return; // Already running
  }

  broadcastIntervalId = setInterval(() => {
    if (sseClients.length > 0) {
      let countdown;

      if (rebuildInProgress) {
        countdown = 'Syncing...';
      } else if (isFetchInProgress) {
        countdown = 'Updating...';
      } else if (nextFetchTime) {
        const remainingMs = Math.max(0, nextFetchTime - Date.now());
        const totalSeconds = Math.floor(remainingMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        countdown = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      } else {
        return; // No fetch time set yet
      }

      broadcastSSE('countdown', { countdown });
    }
  }, 1000);
}

/**
 * Get repository name from git remote URL
 * Falls back to directory basename if no remote or error
 */
async function getRepositoryName() {
  try {
    // Try to get remote URL
    const remoteUrl = execSyncWithOptions('git config --get remote.origin.url', {
      cwd: gitRoot,
      encoding: 'utf8'
    }).trim();

    // Extract repo name from URL (handles both SSH and HTTPS)
    // Examples:
    //   git@github.com:user/repo.git -> repo
    //   https://github.com/user/repo.git -> repo
    //   https://github.com/user/repo -> repo
    const match = remoteUrl.match(/\/([^\/]+?)(\.git)?$/);
    if (match && match[1]) {
      return match[1];
    }
  } catch (error) {
    // No remote or error - fall back to directory name
  }

  // Fallback: use the git root directory basename
  const { basename } = await import('path');
  return basename(gitRoot);
}

/**
 * Load Sparkle configuration from package.json and merge with project config
 */
async function loadConfig() {
  try {
    gitRoot = await getGitRoot();
    const packageJsonPath = join(gitRoot, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));

    if (packageJson.sparkle_config) {
      config = packageJson.sparkle_config;
      // Set default fetchIntervalMinutes to 10 if not specified
      if (!config.fetchIntervalMinutes) {
        config.fetchIntervalMinutes = 10;
      }
      // Set default worktree_path to .sparkle-worktree if not specified (for backward compatibility)
      if (!config.worktree_path) {
        config.worktree_path = '.sparkle-worktree';
      }

      // NOTE: Port loading happens later in main() after worktree is set up
      // because .aggregates/config.json is in the worktree

      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to load config:', error.message);
    return false;
  }
}


/**
 * Validate git configuration before starting daemon
 * Ensures we're on a valid branch with upstream configured
 */
async function validateGitConfiguration() {
  // Logger MUST be initialized before this is called
  if (!logger) {
    console.error('🔴 DAEMON EXIT REASON: Logger initialization failure (exit code 2)');
    console.error('FATAL: Logger not initialized before git validation');
    process.exit(2); // Exit code 2 = logger failed to start
  }

  logger.info('Validating git configuration');

  // Check current branch (run in gitRoot)
  let currentBranch;
  try {
    // gitRoot should be set before this function is called
    if (!gitRoot) {
      throw new Error('gitRoot not set');
    }
    currentBranch = execSyncWithOptions('git rev-parse --abbrev-ref HEAD', {
      cwd: gitRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'] // Capture all output
    }).trim();
  } catch (error) {
    const errMsg = `Failed to determine current git branch. Is this a git repository? (cwd: ${gitRoot}, error: ${error.message})`;
    logger.error(errMsg);
    throw new Error(errMsg);
  }

  if (!currentBranch || currentBranch === 'HEAD') {
    const errMsg = 'Not on a git branch (detached HEAD state). Sparkle requires a valid branch.';
    logger.error(errMsg);
    throw new Error(errMsg);
  }

  logger.info('Git configuration validated', { currentBranch });
}

/**
 * Invalidate aggregates for changed files from git pull
 * @param {Array<string>} filenames - List of changed filenames
 */
async function invalidateAggregatesForFiles(filenames) {
  if (!filenames || filenames.length === 0) {
    return;
  }

  const affectedItems = new Set();

  // Extract all affected item IDs from changed files
  for (const file of filenames) {
    // Extract just the filename (without path) before splitting
    const filename = file.split('/').pop();
    const itemId = filename.split('.')[0];

    // Only process valid item IDs
    if (/^\d{8}$/.test(itemId)) {
      affectedItems.add(itemId);

      // If dependency file changed, also rebuild the other item
      if (file.includes('.dependency.')) {
        const parts = file.split('.');
        if (parts.length >= 4) {
          const otherItemId = parts[3];
          if (/^\d{8}$/.test(otherItemId)) {
            affectedItems.add(otherItemId);
          }
        }
      }
    }
  }

  if (affectedItems.size === 0) {
    return; // No item changes
  }

  console.log(`Git pull: rebuilding ${affectedItems.size} affected aggregates`);

  // Rebuild all affected aggregates synchronously
  for (const itemId of affectedItems) {
    await sparkle.rebuildAggregate(itemId);
  }

  // Single broadcast for all changes
  broadcastSSE('aggregatesUpdated', {
    itemIds: Array.from(affectedItems),
    reason: 'git_pull'
  });

  console.log(`Git pull: rebuilt ${affectedItems.size} aggregates`);
}

/**
 * Setup worktree and initialize Sparkle data directory
 */
async function setupSparkleEnvironment() {
  const branchName = config.git_branch;
  const directory = config.directory;
  const worktreeDir = config.worktree_path;

  // Validate git configuration before proceeding
  await validateGitConfiguration();

  // Setup worktree with sparse checkout for the sparkle data directory
  worktreePath = await setupWorktree(gitRoot, branchName, directory, worktreeDir);

  // Initialize Sparkle directory
  sparkleDataPath = await initializeSparkleDirectory(worktreePath, directory);

  // Set base directory for sparkle.js
  sparkle.setBaseDirectory(sparkleDataPath);

  // Inject the aggregate manager into sparkle.js (dependency injection)
  const aggregateManagerModule = await import('../src/aggregateManager.js');
  sparkle.setAggregateManager(aggregateManagerModule);

  // Inject the git scheduler into sparkle.js (dependency injection)
  const { scheduleOutboundGit } = await import('../src/gitCommitScheduler.js');
  sparkle.setGitScheduler(scheduleOutboundGit);

  // Initialize aggregate store
  await sparkle.initializeAggregateStore();

  // Register SSE broadcast callback for aggregate changes
  sparkle.onAggregateChanged((itemId) => {
    broadcastSSE('aggregatesUpdated', {
      itemIds: [itemId],
      reason: 'user_edit'
    });
  });

  // Create GitOperations instance for daemon (runs in worktreePath, not sparkleDataPath)
  gitOps = new GitOperations(worktreePath);

  // Wire up pull callback to rebuild aggregates
  gitOps.onFilesPulled(async (filenames) => {
    await invalidateAggregatesForFiles(filenames);
    // Also broadcast statuses update in case statuses.json changed
    broadcastSSE('statusesUpdated', {});
  });

  // Wire up commit completion callback for SSE broadcasts
  gitOps.onCommitComplete(({ success, sha, error }) => {
    if (success) {
      if (sha) {
        lastChangeSHA = sha;
        lastChangeTimestamp = Date.now();
      }
      broadcastSSE('fetchCompleted', { timestamp: Date.now() });
      broadcastSSE('dataUpdated', { timestamp: Date.now(), source: 'auto_commit' });
      updateGitAvailability(true, 'push-success');
    } else {
      updateGitAvailability(false, 'push-failed', error);
      broadcastSSE('fetchCompleted', { timestamp: Date.now(), error });
    }
  });

  // Single outbound-git policy: commit immediately (local, safe), push debounced (best-effort).
  setCommitCallback(async () => {
    await gitOps.commit();
  });
  setPushCallback(async () => {
    await gitOps.syncAndPush();
  });

  // A previous run may have died between a status conflict and its resolution, which
  // leaves the worktree mid-merge — and git refuses every commit until that is cleared.
  // Recover before anything tries to write. Non-fatal.
  try {
    await gitOps.recoverFromInterruptedMerge();
  } catch (error) {
    console.log(`[startup] Merge recovery deferred: ${error.message}`);
  }

  // Guarantee the status merge rule exists. Sparkle branches created before status files
  // existed have no .gitattributes rule, and without it git silently blends concurrent
  // reports into one that nobody published. Non-fatal.
  try {
    await gitOps.ensureStatusMergeRule();
  } catch (error) {
    console.log(`[startup] Status merge rule deferred: ${error.message}`);
  }

  // Rebuild system aggregates (statuses, takers)
  console.log('Rebuilding system aggregates...');
  const { rebuildStatusesAggregate } = await import('../src/statusesAggregate.js');
  const { rebuildTakersAggregate } = await import('../src/takersAggregate.js');
  await rebuildStatusesAggregate(sparkleDataPath);
  await rebuildTakersAggregate(sparkleDataPath);
  console.log('System aggregates rebuilt');

  // Get initial SHA
  lastChangeSHA = await getCurrentSHA(worktreePath);
  lastRemoteSHA = lastChangeSHA;
  lastChangeTimestamp = Date.now();

  console.log(`Sparkle environment ready:`);
  console.log(`  Worktree: ${worktreePath}`);
  console.log(`  Data directory: ${sparkleDataPath}`);
}

/**
 * Work that must happen at startup but must NOT delay the HTTP server coming up.
 *
 * Both of these used to run inline in setupSparkleEnvironment, i.e. before
 * server.listen() and therefore before the port file was written — so `npx sparkle`
 * sat waiting on them. syncAndPush is a network round trip, and aggregate validation
 * was quadratic in repo size (measured ~15.8s at 200 items). Neither is needed to
 * serve a request: the daemon can answer from existing aggregates while they run.
 */
// Resolves when runDeferredStartupWork() has finished. Anything that must observe a
// reconciled worktree awaits this rather than assuming startup already completed —
// moving the work off the pre-listen path means a request can now arrive before it.
let deferredStartupPromise = null;

async function runDeferredStartupWork() {
  // Startup reconciliation: best-effort pull + push to flush any commits stranded while
  // offline in a previous session and pick up remote changes. Non-fatal — the daemon must
  // start even if we're still offline.
  try {
    await gitOps.syncAndPush();
  } catch (error) {
    console.log(`[startup] Reconciliation deferred: ${error.message}`);
  }

  // Validate aggregates, repairing in the background if any are stale.
  try {
    const aggregateStatus = await sparkle.validateAllAggregates();

    if (!aggregateStatus.valid) {
      console.log(`Warning: ${aggregateStatus.invalidItems.length} invalid aggregates found, rebuilding...`);
      startBackgroundRebuild();
    } else {
      console.log('Aggregate store validated successfully');
    }
  } catch (error) {
    console.log(`[startup] Aggregate validation failed: ${error.message}`);
  }
}

/**
 * Setup from existing sparkle branch in origin (for fresh clones)
 * This reads the sparkle_config from package.json (which should be committed)
 * and sets up the worktree by fetching from origin
 */
async function setupFromExistingBranch() {
  // Read config from local package.json (which was committed with sparkle_config)
  const packageJsonPath = join(gitRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));

  const { git_branch, directory, worktree_path } = packageJson.sparkle_config || {};

  if (!git_branch || !directory) {
    throw new Error('No sparkle_config found in package.json');
  }

  // Use default worktree_path if not specified (backward compatibility)
  const finalWorktreePath = worktree_path || '.sparkle-worktree';

  console.log(`Found configuration in package.json: branch=${git_branch}, directory=${directory}, worktree=${finalWorktreePath}`);

  // Fetch the sparkle branch from origin
  console.log(`Fetching ${git_branch} branch from origin...`);
  execSyncWithOptions(`git fetch origin ${git_branch}`, { cwd: gitRoot, stdio: 'inherit' });

  // Set local config
  config = { git_branch, directory, worktree_path: finalWorktreePath };

  // Setup worktree (this will detect the branch exists in origin and track it)
  console.log('Setting up worktree...');
  worktreePath = await setupWorktree(gitRoot, git_branch, directory, finalWorktreePath);
  sparkleDataPath = join(worktreePath, directory);

  console.log('Worktree setup complete.');

  // Add worktree to .gitignore if not already there
  console.log('Updating .gitignore...');
  await addToGitignore(gitRoot, `${finalWorktreePath}/`);

  console.log('Local setup complete.');
}

/**
 * Perform git fetch and check for changes
 */
async function performFetch({ alwaysBroadcast = false } = {}) {
  try {
    // Diff from the last REMOTE sha we processed, not lastChangeSHA. lastChangeSHA is also
    // written by the local-commit callback, so using it here produced ranges spanning
    // unrelated refs whenever a local commit landed between fetches.
    const oldSHA = lastRemoteSHA;
    const result = await fetchUpdates(worktreePath);

    if (result.changed) {
      lastChangeSHA = result.sha;
      lastRemoteSHA = result.sha;
      lastChangeTimestamp = Date.now();
      console.log(`Fetched updates, new SHA: ${result.sha}`);

      // Rebuild affected aggregates by getting changed files.
      // If we cannot determine the changed set, we must NOT silently skip invalidation:
      // doing so left the aggregates stale while still broadcasting dataUpdated, so the
      // daemon looked healthy and the list view quietly froze until a manual reload.
      // Fall back to a full rebuild instead.
      let changedFiles = null;
      try {
        if (oldSHA) {
          const output = execSyncWithOptions(`git diff --name-only ${oldSHA} ${result.sha}`, {
            cwd: worktreePath,
            encoding: 'utf8'
          }).trim();
          changedFiles = output ? output.split('\n') : [];
        }
      } catch (error) {
        console.error(`Failed to diff ${oldSHA}..${result.sha}, falling back to full rebuild:`, error.message);
      }

      if (changedFiles === null) {
        console.log('Changed-file set unavailable — rebuilding all aggregates');
        startBackgroundRebuild();
      } else if (changedFiles.length > 0) {
        await invalidateAggregatesForFiles(changedFiles);
      }

      // Broadcast statuses update event after fetch (in case statuses.json changed)
      broadcastSSE('statusesUpdated', {});
    }

    // Broadcast the generic data-changed event so the client runs its single
    // refresh path. The local-commit path already emits this; the fetch path
    // must too, or views that refresh on 'dataUpdated' (audit trail, status
    // files) only update on a full page reload. When alwaysBroadcast is set
    // (an explicit "Update Now" press) we emit even with no new commits, so a
    // button press always redraws the client.
    if (result.changed || alwaysBroadcast) {
      broadcastSSE('dataUpdated', { timestamp: lastChangeTimestamp, source: 'fetch' });
    }

    // Git availability is updated by fetchUpdates via observer
    return { success: true, ...result };
  } catch (error) {
    console.log('Fetch failed (git unavailable):', error.message);

    // Git availability is updated by fetchUpdates via observer
    return { success: false, changed: false };
  }
}

/**
 * Perform fetch operation asynchronously and broadcast status
 */
async function performAsyncFetch({ alwaysBroadcast = false } = {}) {
  // Startup reconciliation pulls remote commits and rebuilds the affected aggregates via
  // the onFilesPulled callback. It now runs in the background so the daemon can start
  // serving immediately, which means a fetch request can land while it is still going.
  // Fetching underneath it would see "no new commits" (reconciliation already merged them)
  // and skip the rebuild, leaving freshly-pulled items with no aggregate to read.
  if (deferredStartupPromise) {
    try {
      await deferredStartupPromise;
    } catch (error) {
      console.log('Deferred startup work failed before fetch:', error.message);
    }
  }

  if (isFetchInProgress) {
    console.log('Fetch already in progress, ignoring request');
    return;
  }

  isFetchInProgress = true;
  broadcastSSE('fetchStatus', { inProgress: true });

  try {
    const result = await performFetch({ alwaysBroadcast });
    return result;
  } finally {
    isFetchInProgress = false;
    broadcastSSE('fetchStatus', { inProgress: false });

    // Reset countdown timer to full interval after fetch completes
    const intervalMs = (config.fetchIntervalMinutes || 10) * 60 * 1000;
    nextFetchTime = Date.now() + intervalMs;
  }
}


/**
 * Test if a port is responding to HTTP requests
 * @param {number} port - Port number to test
 * @returns {Promise<boolean>} True if port is responding
 */
function testPort(port) {
  return new Promise((resolve) => {
    const testReq = httpGet(`http://localhost:${port}/api/ping`, (res) => {
      resolve(true); // Port is responding
    });

    testReq.on('error', () => {
      resolve(false); // Port is not responding
    });

    testReq.setTimeout(1000, () => {
      testReq.destroy();
      resolve(false);
    });
  });
}

/**
 * Check if another daemon is already running
 * Checks both configured port (from config) and last_port.data
 * @returns {Promise<number|false>} Port number if daemon found, false otherwise
 */
async function checkExistingDaemon() {
  // Priority 1: Check configured port (from project config)
  if (config?.port) {
    const isRunning = await testPort(config.port);
    if (isRunning) {
      console.log(`Found existing daemon on configured port ${config.port}`);
      return config.port;
    }
  }

  // Priority 2: Check last_port.data (ephemeral port from previous run).
  // readLivePortFile deletes the file if the recorded PID is gone, so a crashed daemon
  // does not make us think another instance is already running.
  const info = await portFile.readLivePortFile(sparkleDataPath);
  if (!info) {
    return false;
  }

  // Written by an older Sparkle: shut it down and drop the file, then continue starting
  // so this (current) daemon takes over and writes the file in the new format.
  if (info.legacy) {
    await portFile.retireLegacyPortFile(sparkleDataPath, info.port);
    return false;
  }

  const isRunning = await testPort(info.port);
  if (isRunning) {
    console.log(`Found existing daemon on ephemeral port ${info.port}`);
    return info.port;
  }

  return false;
}

/**
 * Write the port file, recording this process's PID alongside the port so readers can
 * tell a live daemon from one that died and left the file behind.
 */
async function writePortFile(port) {
  await portFile.writePortFile(sparkleDataPath, port, process.pid);
}

/**
 * Remove the port file on the way out.
 *
 * Every exit path calls this: without it a stopped daemon kept advertising a port nobody
 * was listening on, and callers that treat "file exists" as "daemon running"
 * (sparkle-halt, the installer) reported a daemon that was long gone. Best effort and
 * synchronous-safe — it also runs from the process 'exit' handler, where async work
 * cannot complete.
 */
function clearPortFileSync() {
  if (!sparkleDataPath) {
    return;
  }
  try {
    const path = portFile.getPortFilePath(sparkleDataPath);
    if (existsSync(path)) {
      unlinkSync(path);
      console.log('Port file removed.');
    }
  } catch (error) {
    // Nothing useful to do while exiting.
  }
}

/**
 * Parse JSON body from request
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

/**
 * Send HTML file
 */
async function sendHTML(res, filename) {
  try {
    const filePath = join(__dirname, '../public', filename);
    const content = await readFile(filePath, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(content);
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

/** Content types for viewing a published status file in the browser. */
const STATUS_FILE_CONTENT_TYPES = {
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  md: 'text/markdown',
  log: 'text/plain',
  txt: 'text/plain'
};

/**
 * Send a published status file.
 *
 * Status file content is authored by whatever publishes it (a CI system), so it is not
 * trusted the way our own public/ assets are. The daemon's API has no authentication,
 * so an HTML report opened in a tab would otherwise run script against the daemon's own
 * origin and could drive any endpoint. `CSP: sandbox` drops it into a unique opaque
 * origin — it still renders, but it cannot reach the API. `nosniff` stops a text report
 * being re-interpreted as script.
 *
 * @param {Object} res - HTTP response
 * @param {string} name - Status file name (as published)
 * @param {string} content - File content
 * @param {boolean} asDownload - Send as an attachment rather than for display
 */
function sendStatusFile(res, name, content, asDownload) {
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const contentType = STATUS_FILE_CONTENT_TYPES[extension] || 'text/plain';

  const headers = {
    'Content-Type': `${contentType}; charset=utf-8`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  };

  if (asDownload) {
    // RFC 5987: the name is arbitrary text, so it must not be interpolated raw.
    const encodedName = encodeURIComponent(name);
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodedName}`;
  }

  res.writeHead(200, headers);
  res.end(content);
}

/**
 * Send static file from public directory (with security checks)
 */
async function sendStaticFile(res, requestPath) {
  try {
    // Security: Prevent directory traversal attacks
    // Remove leading slash
    const cleanPath = requestPath.replace(/^\/+/, '');

    // Check for directory traversal attempts
    if (cleanPath.includes('..') || cleanPath.includes('\\')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // Build the file path
    const publicDir = join(__dirname, '../public');
    const filePath = join(publicDir, cleanPath);

    // Security: Verify the resolved path is actually within public directory
    const { resolve } = await import('path');
    const resolvedFilePath = resolve(filePath);
    const resolvedPublicDir = resolve(publicDir);

    if (!resolvedFilePath.startsWith(resolvedPublicDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // Determine content type based on file extension
    let contentType = 'text/plain';
    if (cleanPath.endsWith('.html')) {
      contentType = 'text/html';
    } else if (cleanPath.endsWith('.css')) {
      contentType = 'text/css';
    } else if (cleanPath.endsWith('.js')) {
      contentType = 'application/javascript';
    } else if (cleanPath.endsWith('.json')) {
      contentType = 'application/json';
    } else if (cleanPath.endsWith('.png')) {
      contentType = 'image/png';
    } else if (cleanPath.endsWith('.jpg') || cleanPath.endsWith('.jpeg')) {
      contentType = 'image/jpeg';
    } else if (cleanPath.endsWith('.svg')) {
      contentType = 'image/svg+xml';
    }

    // Read and send the file
    const content = await readFile(resolvedFilePath, contentType.startsWith('image/') ? null : 'utf8');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  }
}

/**
 * Handle HTTP requests
 */
async function handleRequest(req, res) {
  // Reject all requests if shutting down
  if (isHalting()) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Server is shutting down');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // Hold data requests until a version-change rebuild finishes. Ping still answers so
  // liveness checks (1s testPort, second-launch detection) see this process. Shutdown
  // must not wait or an upgrade could not replace a daemon stuck in a long rebuild.
  const isShutdown = path === '/api/shutdown' && req.method === 'POST';
  if (versionRebuildPending && path === '/api/ping') {
    sendJSON(res, 503, { rebuilding: true, status: 'starting' });
    return;
  }
  if (!isShutdown) {
    await versionRebuildGate;
  }

  try {
    // Serve HTML pages
    // Redirect root to list_view.html (no hidden defaults)
    if (path === '/' || path === '/index.html') {
      if (config) {
        res.writeHead(302, { 'Location': '/list_view.html' });
        res.end();
      } else {
        await sendHTML(res, 'configuration.html');
      }
      return;
    }

    // Server-Sent Events endpoint for connection monitoring
    if (path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      // Add this client to the list
      sseClients.push(res);

      // Cancel no-client timeout since we have a client
      cancelNoClientTimeout();

      // Start broadcast interval if this is the first client
      if (sseClients.length === 1) {
        startBroadcastInterval();
      }

      // Send initial connection event
      res.write('event: connected\n');
      res.write('data: {"status":"connected"}\n\n');

      // Always send current git status (fixes initial connection bug)
      res.write('event: gitStatus\n');
      res.write(`data: ${JSON.stringify({
        active: gitAvailable,
        reason: gitStatusReason,
        details: gitStatusDetails,
        timestamp: Date.now()
      })}\n\n`);

      // Send initial countdown status
      let countdown;
      if (rebuildInProgress) {
        countdown = 'Syncing...';
      } else if (isFetchInProgress) {
        countdown = 'Updating...';
      } else if (nextFetchTime) {
        const remainingMs = Math.max(0, nextFetchTime - Date.now());
        const totalSeconds = Math.floor(remainingMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        countdown = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      } else {
        countdown = '-';
      }
      res.write('event: countdown\n');
      res.write(`data: ${JSON.stringify({ countdown })}\n\n`);

      // Send heartbeat (per-client, for connection health)
      const heartbeatInterval = setInterval(() => {
        try {
          res.write('event: heartbeat\n');
          res.write(`data: {"timestamp":"${new Date().toISOString()}"}\n\n`);
        } catch (error) {
          clearInterval(heartbeatInterval);
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Clean up on connection close
      req.on('close', () => {
        clearInterval(heartbeatInterval);
        // Remove this client from the list
        sseClients = sseClients.filter(client => client !== res);

        // If no clients left, start the shutdown timeout
        if (sseClients.length === 0) {
          startNoClientTimeout();
        }
      });

      return;
    }

    // API endpoints
    // Cancel timeout on any API call, but only restart if no SSE clients are connected
    if (path.startsWith('/api/') && path !== '/api/shutdown') {
      cancelNoClientTimeout();
      // Only start timeout if there are no connected SSE clients
      // If clients are connected, they will manage the timeout via their disconnect handler
      if (sseClients.length === 0) {
        startNoClientTimeout();
      }
    }

    if (path === '/api/ping') {
      sendJSON(res, 200, { status: 'ok' });
      return;
    }

    if (path === '/api/clientLog' && req.method === 'POST') {
      const body = await parseBody(req);
      const { level, message, data } = body;
      const logPrefix = level === 'error' ? 'CLIENT ERROR:' : 'CLIENT LOG:';
      const logMessage = data ? `${logPrefix} ${message} ${JSON.stringify(data)}` : `${logPrefix} ${message}`;
      if (level === 'error') {
        console.error(logMessage);
      } else {
        console.log(logMessage);
      }
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/version') {
      // Return the version that was frozen at daemon startup
      // This ensures we always report the version the daemon was started with,
      // even if npm install updates the files on disk
      sendJSON(res, 200, { version: globalThis.SPARKLE_DAEMON_VERSION });
      return;
    }

    if (path === '/api/serverInfo') {
      // Return server info including version and whether using fixed port
      const hasFixedPort = config?.port && config.port !== 0;
      const currentPort = server?.address()?.port || 0;
      sendJSON(res, 200, {
        version: globalThis.SPARKLE_DAEMON_VERSION,
        hasFixedPort: hasFixedPort,
        port: currentPort
      });
      return;
    }

    if (path === '/api/internal/aggregateUpdated' && req.method === 'POST') {
      const body = await parseBody(req);

      // Broadcast SSE to clients (external write detected)
      broadcastSSE('aggregatesUpdated', {
        itemIds: [body.itemId],
        reason: 'external_write'
      });

      sendJSON(res, 200, { success: true });
      return;
    }

    // Handle frontend logging (doesn't require configuration)
    if (path === '/log' && req.method === 'POST') {
      const body = await parseBody(req);

      // Handle array of log entries (for batched frontend logs)
      if (Array.isArray(body.logs)) {
        for (const logLine of body.logs) {
          console.log(logLine);
        }
      }

      sendJSON(res, 200, { success: true });
      return;
    }

    // Require configuration for all other endpoints
    if (!config) {
      sendJSON(res, 503, { error: 'Sparkle not configured' });
      return;
    }

    if (path === '/api/status') {
      const branchExists = await sparkleBranchExistsInOrigin(gitRoot, config.git_branch);
      sendJSON(res, 200, {
        configured: true,
        branch: config.git_branch,
        directory: config.directory,
        branchExistsInOrigin: branchExists,
        lastChangeSHA,
        lastChangeTimestamp,
        rootDirectoryName: basename(gitRoot)
      });
      return;
    }

    if (path === '/api/getLastChange') {
      sendJSON(res, 200, {
        sha: lastChangeSHA,
        timestamp: lastChangeTimestamp
      });
      return;
    }

    if (path === '/api/fetch' && req.method === 'POST') {
      // A button press must always redraw the client. On the normal path the
      // fetch below broadcasts 'dataUpdated' unconditionally (alwaysBroadcast).
      // The two early-return branches skip the fetch, so they emit it here so
      // the client's single refresh path still runs on every button press.

      // Defer an explicit fetch while a push is pending; the debounced push does its own
      // fetch/merge, so it will bring remote changes in shortly.
      if (isPushScheduled()) {
        broadcastSSE('dataUpdated', { timestamp: lastChangeTimestamp, source: 'fetch-request' });
        sendJSON(res, 200, {
          success: true,
          deferred: true,
          message: 'Fetch deferred - pending push will fetch/merge'
        });
        return;
      }

      // Ignore if fetch is already in progress
      if (isFetchInProgress) {
        broadcastSSE('dataUpdated', { timestamp: lastChangeTimestamp, source: 'fetch-request' });
        sendJSON(res, 200, { success: false, message: 'Fetch already in progress' });
        return;
      }

      // Start async fetch and return immediately
      performAsyncFetch({ alwaysBroadcast: true });

      // Don't reset nextFetchTime yet - wait until fetch completes
      // The countdown broadcast will show "Updating..." while isFetchInProgress is true

      sendJSON(res, 200, { success: true, message: 'Fetch started' });
      return;
    }

    // Sparkle API endpoints
    if (path === '/api/createItem' && req.method === 'POST') {
      const body = await parseBody(req);
      const itemId = await sparkle.createItem(body.tagline, body.status, body.initialEntry);

      // Send response immediately after file creation
      // (git commit is automatically scheduled by event file)
      sendJSON(res, 200, { itemId });
      return;
    }

    if (path === '/api/getItemDetails' && req.method === 'POST') {
      const startTime = Date.now();
      const body = await parseBody(req);
      console.log(`[API] POST /api/getItemDetails - start: ${new Date(startTime).toISOString()}, itemId: ${body.itemId}`);

      const details = await sparkle.getItemDetails(body.itemId);
      // Add current user to the response
      const currentUser = await getGitUser();

      const endTime = Date.now();
      const duration = endTime - startTime;
      console.log(`[API] POST /api/getItemDetails - end: ${new Date(endTime).toISOString()}, duration: ${duration}ms, itemId: ${body.itemId}`);

      sendJSON(res, 200, { ...details, currentUser });
      return;
    }

    if (path === '/api/alterTagline' && req.method === 'POST') {
      const body = await parseBody(req);
      await sparkle.alterTagline(body.itemId, body.tagline);

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/addEntry' && req.method === 'POST') {
      const body = await parseBody(req);
      await sparkle.addEntry(body.itemId, body.text);

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/updateStatus' && req.method === 'POST') {
      const body = await parseBody(req);
      await sparkle.updateStatus(body.itemId, body.status, body.text);

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/updateTagline' && req.method === 'POST') {
      const body = await parseBody(req);
      await sparkle.alterTagline(body.itemId, body.tagline);

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/addDependency' && req.method === 'POST') {
      const body = await parseBody(req);
      await sparkle.addDependency(body.itemNeeding, body.itemNeeded);

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/removeDependency' && req.method === 'POST') {
      const body = await parseBody(req);
      await sparkle.removeDependency(body.itemNeeding, body.itemNeeded);

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/addMonitor' && req.method === 'POST') {
      const body = await parseBody(req);
      console.log(`API: addMonitor called for item ${body.itemId}`);
      await sparkle.addMonitor(body.itemId);

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/removeMonitor' && req.method === 'POST') {
      const body = await parseBody(req);
      console.log(`API: removeMonitor called for item ${body.itemId}`);
      await sparkle.removeMonitor(body.itemId);

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/ignoreItem' && req.method === 'POST') {
      const body = await parseBody(req);
      console.log(`API: ignoreItem called for item ${body.itemId}`);
      await sparkle.ignoreItem(body.itemId);

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/unignoreItem' && req.method === 'POST') {
      const body = await parseBody(req);
      console.log(`API: unignoreItem called for item ${body.itemId}`);
      await sparkle.unignoreItem(body.itemId);

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/takeItem' && req.method === 'POST') {
      const body = await parseBody(req);
      console.log(`API: takeItem called for item ${body.itemId}`);
      await sparkle.takeItem(body.itemId);

      // Broadcast to all clients that takers list may have been updated
      broadcastSSE('takersUpdated', {});

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/surrenderItem' && req.method === 'POST') {
      const body = await parseBody(req);
      console.log(`API: surrenderItem called for item ${body.itemId}`);
      await sparkle.surrenderItem(body.itemId);

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/pendingWork') {
      const startTime = Date.now();
      console.log(`[API] GET /api/pendingWork - start: ${new Date(startTime).toISOString()}`);

      const items = [];
      for await (const itemId of sparkle.pendingWork()) {
        items.push(itemId);
      }

      const endTime = Date.now();
      const duration = endTime - startTime;
      console.log(`[API] GET /api/pendingWork - end: ${new Date(endTime).toISOString()}, duration: ${duration}ms, items: ${items.length}`);

      sendJSON(res, 200, { items });
      return;
    }

    // A rebuild used to make these endpoints answer 503. The browser's first load calls
    // /api/allItems before it has registered any SSE listeners, so a 503 aborted client
    // initialization outright and the page stayed blank FOREVER — no retry, no recovery,
    // only a manual reload once the rebuild had finished.
    //
    // Aggregates are rebuilt in place and every item that has been rebuilt so far is
    // readable, so serving what exists is strictly better than refusing. Answer 200 with
    // the data we have plus a `rebuilding` marker; the client renders a read-only banner
    // and refreshes when the rebuildCompleted event arrives.
    const rebuildNotice = rebuildInProgress
      ? { rebuilding: true, progress: rebuildProgress }
      : null;

    if (path === '/api/aggregateStatus') {
      sendJSON(res, 200, {
        rebuilding: rebuildInProgress,
        progress: rebuildProgress
      });
      return;
    }

    if (path === '/api/aggregateStatus') {
      sendJSON(res, 200, {
        rebuilding: rebuildInProgress,
        progress: rebuildProgress
      });
      return;
    }

    if (path === '/api/allItems') {
      const startTime = Date.now();
      const searchParam = url.searchParams.get('search');
      console.log(`[API] GET /api/allItems - start: ${new Date(startTime).toISOString()}, search: ${searchParam || 'none'}`);

      const items = await sparkle.getAllItems();

      // Filter items if search parameter provided
      let filteredItems = items;
      if (searchParam) {
        const searchLower = searchParam.toLowerCase();
        filteredItems = items.filter(item => {
          const itemIdMatch = item.itemId && item.itemId.includes(searchLower);
          const taglineMatch = item.tagline && item.tagline.toLowerCase().includes(searchLower);
          return itemIdMatch || taglineMatch;
        });
      }

      const endTime = Date.now();
      const duration = endTime - startTime;
      console.log(`[API] GET /api/allItems - end: ${new Date(endTime).toISOString()}, duration: ${duration}ms, total: ${items.length}, filtered: ${filteredItems.length}`);

      sendJSON(res, 200, { items: filteredItems, ...rebuildNotice });
      return;
    }

    if (path === '/api/dag') {
      const dagStart = Date.now();
      // Extract referenceId query parameter
      const referenceId = url.searchParams.get('referenceId');

      if (!referenceId) {
        sendJSON(res, 400, { error: 'referenceId query parameter is required' });
        return;
      }

      if (logger) logger.info(`[API] GET /api/dag?referenceId=${referenceId} - start: ${new Date(dagStart).toISOString()}`);

      try {
        const nodes = [];
        for await (const node of sparkle.getAllItemsAsDag(referenceId)) {
          nodes.push(node);
        }
        const dagDuration = Date.now() - dagStart;
        if (logger) logger.info(`[API] GET /api/dag?referenceId=${referenceId} - end: ${new Date().toISOString()}, duration: ${dagDuration}ms, nodes: ${nodes.length}`);
        sendJSON(res, 200, { nodes, ...rebuildNotice });
      } catch (error) {
        if (logger) logger.error(`[API] GET /api/dag?referenceId=${referenceId} - error: ${error.message}`);
        sendJSON(res, 404, { error: error.message });
      }
      return;
    }

    if (path === '/api/roots') {
      const rootsStart = Date.now();
      if (logger) logger.info(`[API] GET /api/roots - start: ${new Date(rootsStart).toISOString()}`);

      try {
        const roots = await sparkle.getRootItems();
        const rootsDuration = Date.now() - rootsStart;
        if (logger) logger.info(`[API] GET /api/roots - end: ${new Date().toISOString()}, duration: ${rootsDuration}ms, roots: ${roots.length}`);
        sendJSON(res, 200, { roots, ...rebuildNotice });
      } catch (error) {
        if (logger) logger.error(`[API] GET /api/roots - error: ${error.message}`);
        sendJSON(res, 500, { error: error.message });
      }
      return;
    }

    if (path === '/api/allowedStatuses') {
      const statuses = await sparkle.getAllowedStatuses();
      sendJSON(res, 200, { statuses });
      return;
    }

    if (path === '/api/getTakers') {
      const takers = await sparkle.getTakers();
      sendJSON(res, 200, { takers });
      return;
    }

    if (path === '/api/updateStatuses' && req.method === 'POST') {
      const body = await parseBody(req);
      const newStatuses = await sparkle.updateStatuses(body.statuses);

      // Broadcast to all clients that statuses have been updated (with new list)
      broadcastSSE('statusesUpdated', { statuses: newStatuses });

      // Send response immediately (git commit is automatically scheduled)
      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/statusFiles') {
      const files = await sparkle.listStatusFiles();
      sendJSON(res, 200, { files });
      return;
    }

    if (path === '/api/statusFile') {
      const name = url.searchParams.get('name');
      if (!name) {
        sendJSON(res, 400, { error: 'name is required' });
        return;
      }
      try {
        const content = await sparkle.readStatusFile(name);
        sendStatusFile(res, name, content, url.searchParams.get('download') === '1');
      } catch (error) {
        sendJSON(res, 404, { error: error.message });
      }
      return;
    }

    if (path === '/api/statusFiles/add' && req.method === 'POST') {
      const body = await parseBody(req);
      try {
        const result = await sparkle.addStatusFile(body.name, body.text);
        broadcastSSE('statusFilesUpdated', { name: body.name });
        sendJSON(res, 200, { success: true, ...result });
      } catch (error) {
        sendJSON(res, 400, { error: error.message });
      }
      return;
    }

    if (path === '/api/statusFiles/remove' && req.method === 'POST') {
      const body = await parseBody(req);
      try {
        const result = await sparkle.removeStatusFile(body.name);
        broadcastSSE('statusFilesUpdated', { name: body.name, removed: true });
        sendJSON(res, 200, { success: true, ...result });
      } catch (error) {
        // Removing something that was never published is a caller error, not a crash.
        sendJSON(res, 404, { error: error.message });
      }
      return;
    }

    // --- Saved views -------------------------------------------------------------
    // Named snapshots of on-screen state, stored in the git-ignored .aggregates/ dir so
    // they stay local to the clone but are shared by every browser hitting this daemon.
    if (path === '/api/views' && req.method === 'GET') {
      const savedViews = await import('../src/savedViews.js');
      const views = await savedViews.loadViews(sparkleDataPath);
      sendJSON(res, 200, { views });
      return;
    }

    if (path === '/api/views/save' && req.method === 'POST') {
      const body = await parseBody(req);
      const savedViews = await import('../src/savedViews.js');
      try {
        const views = await savedViews.saveView(
          sparkleDataPath, body.name, body.page, body.state);
        broadcastSSE('viewsUpdated', {});
        sendJSON(res, 200, { success: true, views });
      } catch (error) {
        sendJSON(res, 400, { error: error.message });
      }
      return;
    }

    if (path === '/api/views/delete' && req.method === 'POST') {
      const body = await parseBody(req);
      const savedViews = await import('../src/savedViews.js');
      const { removed, views } = await savedViews.deleteView(sparkleDataPath, body.name);
      if (removed) {
        broadcastSSE('viewsUpdated', {});
      }
      sendJSON(res, 200, { success: true, removed, views });
      return;
    }

    if (path === '/api/config/get' && req.method === 'POST') {
      const body = await parseBody(req);
      const config = await sparkle.getConfig(body.localConfig);
      sendJSON(res, 200, config);
      return;
    }

    if (path === '/api/config/setProject' && req.method === 'POST') {
      const body = await parseBody(req);

      // Check if port is changing
      const configManager = await import('../src/configManager.js');
      const currentProjectConfig = await configManager.loadProjectConfig(sparkleDataPath);
      const oldPort = currentProjectConfig.port;
      const newPort = body.port;
      const portChanged = oldPort !== newPort;

      // Save the new configuration
      await sparkle.setProjectConfig(body);

      // Note: SSE broadcast removed from here to avoid double-broadcast
      // Callers should use /api/config/notifyChange after all config saves are complete

      sendJSON(res, 200, { success: true, portChanged });

      // If port changed, broadcast to all clients then trigger graceful shutdown
      if (portChanged) {
        console.log(`Port changed from ${oldPort || '(ephemeral)'} to ${newPort || '(ephemeral)'}, shutting down daemon...`);
        if (logger) logger.info('Daemon shutdown triggered', { reason: 'port_configuration_changed', oldPort, newPort });

        // Broadcast portChanging event to all connected clients
        broadcastSSE('portChanging', { oldPort, newPort });
        console.log('Broadcast portChanging event to all clients');

        // Shutdown after a brief delay to allow SSE broadcast to reach clients
        setTimeout(() => {
          console.log('🔴 DAEMON EXIT REASON: Port configuration changed (triggering SIGINT)');
          process.kill(process.pid, 'SIGINT');
        }, 500);
      }

      return;
    }

    if (path === '/api/config/notifyChange' && req.method === 'POST') {
      // Broadcast configuration change notification to all connected clients
      // Called after all configuration persistence (localStorage + project + statuses) is complete
      // Ensures exactly ONE SSE broadcast per save operation
      // Includes sender info for debouncing (so sender can ignore its own event)
      const body = await parseBody(req);
      const sender = body.sender || null; // { timestamp, random }

      console.log(`[CONFIG] Received notifyChange request with sender:`, JSON.stringify(sender));
      broadcastSSE('configurationUpdated', { sender });
      console.log(`[CONFIG] Broadcast configurationUpdated SSE with sender:`, JSON.stringify(sender));

      sendJSON(res, 200, { success: true });
      return;
    }

    if (path === '/api/getPotentialDependencies' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = await sparkle.getPotentialDependencies(body.itemId);
      sendJSON(res, 200, result);
      return;
    }

    if (path === '/api/getPotentialDependents' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = await sparkle.getPotentialDependents(body.itemId);
      sendJSON(res, 200, result);
      return;
    }

    if (path === '/api/getItemAuditTrail' && req.method === 'POST') {
      const body = await parseBody(req);

      // Set up streaming response
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked'
      });

      const events = [];
      try {
        // Collect all audit trail events
        for await (const event of sparkle.getItemAuditTrail(body.itemId)) {
          events.push(event);
        }

        // Send as JSON array
        res.end(JSON.stringify({ events }));
      } catch (error) {
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (path === '/api/shutdown' && req.method === 'POST') {
      console.log('🔴 DAEMON EXIT REASON: API shutdown request (triggering SIGINT)');
      if (logger) logger.info('Daemon exiting', { reason: 'api_shutdown_request' });
      sendJSON(res, 200, { message: 'Shutting down...' });
      // Trigger SIGINT to use the graceful shutdown handler
      setTimeout(() => process.kill(process.pid, 'SIGINT'), 100);
      return;
    }

    // Serve JavaScript files from src and public directories
    if ((path.startsWith('/src/') || path.startsWith('/public/')) && path.endsWith('.js')) {
      try {
        const filePath = join(__dirname, '..', path);
        const content = await readFile(filePath, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(content);
        return;
      } catch (error) {
        console.log(`Failed to serve ${path}:`, error.message);
      }
    }

    // Serve static files from public directory (HTML, CSS, JS, images, etc.)
    // This must come after all API routes to avoid conflicts
    if (!path.startsWith('/api/')) {
      await sendStaticFile(res, path);
      return;
    }

    // Not found
    sendJSON(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('Request error:', error);
    sendJSON(res, 500, { error: error.message });
  }
}

/**
 * Start periodic fetch based on configured interval (default 10 minutes)
 */
function startPeriodicFetch() {
  if (fetchIntervalId) {
    clearInterval(fetchIntervalId);
  }

  const intervalMs = (config.fetchIntervalMinutes || 10) * 60 * 1000;

  // Set initial next fetch time
  nextFetchTime = Date.now() + intervalMs;

  fetchIntervalId = setInterval(async () => {
    try {
      await performAsyncFetch();
      // Update next fetch time after each fetch
      nextFetchTime = Date.now() + intervalMs;
    } catch (error) {
      console.error('Periodic fetch error:', error.message);
    }
  }, intervalMs);
}

/**
 * Main startup function
 */
async function main() {
  console.log('[DEBUG] main() called');
  // Initialize HTTP logging if configured via environment
  if (process.env.SPARKLE_LOG_PORT && process.env.SPARKLE_LOG_TOKEN) {
    console.log('[DEBUG] Initializing HTTP logger');
    initHttpLogger(parseInt(process.env.SPARKLE_LOG_PORT), process.env.SPARKLE_LOG_TOKEN);
    console.log('[DEBUG] Creating logger');
    logger = createLogger(process.env.SPARKLE_LOG_TOKEN);
    console.log('[DEBUG] About to call logger.info');
    logger.info('Sparkle Agent starting with HTTP logging');
    console.log('[DEBUG] HTTP logger initialized');
    // Small delay to ensure HTTP request completes
    await new Promise(resolve => setTimeout(resolve, 100));
  } else {
    // Initialize logger without HTTP logging (will use console only)
    logger = createLogger('daemon');
  }

  console.log('[DEBUG] main() continuing after logger init');
  if (logger) logger.info('main() starting');
  console.log('[DEBUG] Logged main() starting');

  // Setup basic paths
  if (logger) logger.info('Getting git root');
  gitRoot = await getGitRoot();
  // Note: worktreePath and sparkleDataPath will be set after loading config
  // For now, set defaults for the file logging setup
  worktreePath = join(gitRoot, '.sparkle-worktree');
  sparkleDataPath = join(worktreePath, 'sparkle-data');
  if (logger) logger.info('Paths set (defaults)', { gitRoot, worktreePath, sparkleDataPath });

  // Try to start file logging (will succeed if sparkleDataPath exists)
  await startLogging();

  console.log('Sparkle Agent starting...');
  if (logger) logger.info('Console logging configured');

  // Register git availability observer
  if (logger) logger.info('Registering git availability observer');
  onGitAvailabilityChange(updateGitAvailability);

  // Load configuration - REQUIRED for daemon to start
  if (logger) logger.info('Loading configuration');
  const hasConfig = await loadConfig();
  if (logger) logger.info('Configuration loaded', { hasConfig });

  if (!hasConfig) {
    console.error('Error: Sparkle is not configured in this repository.');
    console.error('Run: npm install --save-dev sparkle-X.Y.Z.tgz');
    if (logger) logger.error('Daemon exiting', { reason: 'no_config' });
    process.exit(1);
  }

  // Configuration exists, proceed with startup
  if (true) {
    if (logger) logger.info('Config exists, checking worktree');
    // Update paths based on loaded config
    worktreePath = join(gitRoot, config.worktree_path);
    sparkleDataPath = join(worktreePath, config.directory);
    if (logger) logger.info('Paths updated from config', { worktreePath, sparkleDataPath });

    // Check if worktree exists
    const worktreeExists = existsSync(worktreePath);
    if (logger) logger.info('Worktree check', { worktreeExists });

    if (!worktreeExists) {
      // Config exists but worktree doesn't - need to initialize
      console.log('Configuration found but worktree missing, initializing...');
      if (logger) logger.info('Initializing worktree');
      try {
        // Check if sparkle branch exists
        if (logger) logger.info('Checking if sparkle branch exists in origin');
        const branchCheck = await sparkleBranchExistsInOrigin(gitRoot, config.git_branch);
        if (logger) logger.info('Branch check result', { branchCheck });

        if (branchCheck) {
          // Branch exists in origin, set up from it
          if (logger) logger.info('Setting up from existing branch');
          await setupFromExistingBranch();
          console.log('Worktree setup complete from existing branch.');
          if (logger) logger.info('Worktree setup complete');
          // Start file logging now that worktree exists
          await startLogging();
        } else {
          // Branch doesn't exist, create it (first-time setup)
          console.log('Sparkle branch not found, creating...');
          if (logger) logger.info('Creating sparkle branch');
          worktreePath = await initializeSparkleWorktree(gitRoot, config.git_branch, config.directory);
          sparkleDataPath = join(worktreePath, config.directory);
          console.log('Sparkle branch created and worktree initialized.');
          if (logger) logger.info('Branch created and worktree initialized');
          // Start file logging now that worktree exists
          await startLogging();
        }
      } catch (error) {
        console.error('🔴 DAEMON EXIT REASON: Initialization failure (exit code 1)');
        console.error('Failed to initialize Sparkle:', error.message);
        if (logger) logger.error('Daemon exiting', { reason: 'initialization_failure', error: error.message });
        console.error('Please check your network connection and try again.');
        process.exit(1);
      }
    }

    // Normal startup procedure
    console.log('Configuration found, starting normal startup...');
    if (logger) logger.info('Starting normal startup');

    // Setup environment (or verify it's set up)
    if (logger) logger.info('Setting up sparkle environment');
    await setupSparkleEnvironment();
    if (logger) logger.info('Sparkle environment setup complete');

    const aggregateMetadata = await sparkle.getAggregateMetadata();
    if (isSparkleVersionOlder(aggregateMetadata?.sparkleVersion, SPARKLE_VERSION)) {
      versionRebuildPending = true;
      versionRebuildGate = new Promise(resolve => {
        releaseVersionRebuildGate = resolve;
      });
      const builtWith = aggregateMetadata?.sparkleVersion || 'unknown';
      console.log(`Aggregate store built with ${builtWith}; current ${SPARKLE_VERSION}. Holding requests until rebuilt.`);
      if (logger) logger.info('Version-change aggregate rebuild required', { builtWith, current: SPARKLE_VERSION });
    }

    // Start file logging now that sparkleDataPath definitely exists
    await startLogging();

    // Load port configuration from project config (now that worktree/sparkleDataPath exists)
    if (logger) logger.info('Loading port configuration from project config', { sparkleDataPath });
    const configManager = await import('../src/configManager.js');
    const projectConfig = await configManager.loadProjectConfig(sparkleDataPath);
    if (projectConfig.port !== null && projectConfig.port !== undefined) {
      config.port = projectConfig.port;
      console.log(`Using port ${config.port} from project config`);
      if (logger) logger.info('Port loaded from project config', { port: config.port });
    } else {
      if (logger) logger.info('No port configured in project config, will use ephemeral');
    }

    // Check for existing daemon
    if (logger) logger.info('Checking for existing daemon');
    const existingDaemonPort = await checkExistingDaemon();
    if (logger) logger.info('Existing daemon check', { existingDaemonPort });
    if (existingDaemonPort) {
      console.log('Another Sparkle daemon is already running.');
      console.log(`Opening browser to existing daemon on port ${existingDaemonPort}...`);
      if (logger) logger.info('Opening browser to existing daemon', { port: existingDaemonPort });

      // Open browser to existing daemon and exit
      if (!isTestMode) {
        await openBrowser(`http://localhost:${existingDaemonPort}`);
      }

      console.log('🔴 DAEMON EXIT REASON: Another daemon already running (exit code 0)');
      if (logger) logger.info('Daemon exiting', { reason: 'existing_daemon_detected' });
      process.exit(0);
    }

    // Start periodic fetch (initial fetch will happen in background after server starts)
    if (logger) logger.info('Starting periodic fetch');
    startPeriodicFetch();
  } else {
    console.log('No configuration found, initialization required.');
    if (logger) logger.info('No configuration found');
  }

  // Create HTTP server on configured port (or ephemeral if not specified)
  const configuredPort = config?.port || 0; // 0 = ephemeral (current behavior)
  const hasFixedPort = configuredPort !== 0;
  let portConflictDetected = false; // Track if we had a port conflict
  let attemptedPort = configuredPort; // Track what port we tried to use
  if (logger) logger.info('Creating HTTP server', { configuredPort, hasFixedPort });
  server = createServer(handleRequest);

  // Handle port conflict - if fixed port is unavailable, fall back to ephemeral
  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️  Port ${attemptedPort} is already in use.`);
      if (logger) logger.warn('Port conflict detected', { port: attemptedPort, hasFixedPort });

      if (hasFixedPort) {
        // Check if it's a Sparkle daemon on that port
        const isSparkle = await testPort(attemptedPort);

        if (isSparkle) {
          // It's a Sparkle daemon - just open browser to it and exit
          console.log(`✓ Found existing Sparkle daemon on port ${attemptedPort}`);
          console.log('Opening browser to existing daemon...');
          if (logger) logger.info('Opening browser to existing Sparkle daemon', { port: attemptedPort });

          if (!isTestMode) {
            await openBrowser(`http://localhost:${attemptedPort}`);
          }

          console.log('🔴 DAEMON EXIT REASON: Another daemon already running on configured port (exit code 0)');
          if (logger) logger.info('Daemon exiting', { reason: 'existing_daemon_on_configured_port' });
          process.exit(0);
        } else {
          // Not a Sparkle daemon - fall back to ephemeral
          portConflictDetected = true;
          console.log(`⚠️  Port in use by non-Sparkle process. Falling back to ephemeral port...`);
          if (logger) logger.info('Falling back to ephemeral port due to non-Sparkle conflict');

          // Try again with ephemeral port (0)
          server.listen(0, 'localhost');
        }
      } else {
        // This shouldn't happen with ephemeral ports, but handle it
        console.error('🔴 DAEMON EXIT REASON: Failed to bind to ephemeral port (exit code 1)');
        console.error('Fatal error: Cannot bind to any port');
        if (logger) logger.error('Daemon exiting', { reason: 'cannot_bind_port' });
        process.exit(1);
      }
    } else {
      // Other server errors
      console.error('🔴 DAEMON EXIT REASON: Server error (exit code 1)');
      console.error('Server error:', err);
      if (logger) logger.error('Daemon exiting', { reason: 'server_error', error: err.message });
      process.exit(1);
    }
  });

  server.listen(configuredPort, 'localhost', async () => {
    const address = server.address();
    const port = address.port;
    if (logger) logger.info('Server listening', { port, hasFixedPort, portConflictDetected });

    if (hasFixedPort) {
      console.log(`Sparkle Agent listening on http://localhost:${port} (fixed port from config)`);
    } else {
      console.log(`Sparkle Agent listening on http://localhost:${port}`);
    }
    if (isTestMode) {
      console.log(`Test mode: enabled (ID: ${testId || 'none'})`);
      if (logger) logger.info('Test mode enabled', { testId });
    }

    if (hasConfig) {
      // Write port file
      if (logger) logger.info('Writing port file');
      await writePortFile(port);
      if (logger) logger.info('Port file written');

      if (releaseVersionRebuildGate) {
        const previousRequestTimeout = server.requestTimeout;
        server.requestTimeout = 0;
        try {
          console.log(`Rebuilding aggregates for Sparkle ${SPARKLE_VERSION}...`);
          if (logger) logger.info('Version-change aggregate rebuild starting', { version: SPARKLE_VERSION });
          await sparkle.rebuildAllAggregates(null, { sparkleVersion: SPARKLE_VERSION });
          console.log('Aggregate rebuild for version change complete.');
          if (logger) logger.info('Version-change aggregate rebuild complete');
        } catch (error) {
          console.error('Version-change aggregate rebuild failed:', error.message);
          if (logger) logger.error('Version-change aggregate rebuild failed', { error: error.message });
        } finally {
          server.requestTimeout = previousRequestTimeout;
          versionRebuildPending = false;
          releaseVersionRebuildGate();
          releaseVersionRebuildGate = null;
        }
      }

      console.log('Daemon is ready.');
      if (logger) logger.info('Daemon ready');

      // Reconciliation + aggregate validation. Deliberately AFTER the port file is
      // written: the CLI waits on that file, so anything run before it is time the user
      // spends staring at a launching daemon. Both are safe to run against a live server.
      if (logger) logger.info('Starting deferred startup work in background');
      deferredStartupPromise = runDeferredStartupWork();
      deferredStartupPromise.then(() => {
        if (logger) logger.info('Deferred startup work complete');

        // Initial fetch runs after reconciliation so the two do not race on the worktree.
        if (logger) logger.info('Starting initial fetch in background');
        return performFetch();
      }).then(() => {
        if (logger) logger.info('Background initial fetch complete');
      }).catch((error) => {
        console.log('Background startup work failed (normal if offline):', error.message);
        if (logger) logger.warn('Background startup work failed', { error: error.message });
      });
    }

    // Start the no-client timeout - will shut down if no clients connect within timeout
    if (logger) logger.info('Starting no-client timeout');
    startNoClientTimeout();
    if (logger) logger.info('Startup complete');
  });

  // Remove the port file however we leave.
  //
  // 'exit' covers ordinary returns and explicit process.exit() calls from every shutdown
  // path (SIGINT, no-client timeout, port change, fatal errors) with one handler, so no
  // future exit route can forget. It must be synchronous — async work does not run here.
  process.on('exit', clearPortFileSync);

  // SIGTERM has no default Node handler that would reach 'exit' cleanly, and SIGHUP is
  // what a closing terminal sends. Both otherwise left the file behind.
  process.on('SIGTERM', () => {
    console.log('🔴 DAEMON EXIT REASON: SIGTERM signal received');
    if (logger) logger.info('Daemon exiting', { reason: 'sigterm_signal' });
    shuttingDown = true;
    process.exit(0);
  });
  process.on('SIGHUP', () => {
    console.log('🔴 DAEMON EXIT REASON: SIGHUP signal received');
    if (logger) logger.info('Daemon exiting', { reason: 'sighup_signal' });
    shuttingDown = true;
    process.exit(0);
  });

  // A crash is exactly the case the PID check exists for, but if we are still alive
  // enough to run this handler we can clean up properly rather than leave a stale file.
  process.on('uncaughtException', (error) => {
    console.error('🔴 DAEMON EXIT REASON: Uncaught exception');
    console.error(error);
    if (logger) logger.error('Daemon exiting', { reason: 'uncaught_exception', error: error.message });
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('🔴 DAEMON EXIT REASON: SIGINT signal received (exit code 0)');
    console.log('\nShutting down gracefully...');

    // Set shutdown flag - this prevents any further SSE broadcasts
    shuttingDown = true;

    if (logger) logger.info('Daemon exiting', { reason: 'sigint_signal' });
    if (fetchIntervalId) {
      clearInterval(fetchIntervalId);
    }
    if (broadcastIntervalId) {
      clearInterval(broadcastIntervalId);
    }

    // Close all SSE connections before closing the server
    console.log(`Closing ${sseClients.length} SSE connections...`);
    sseClients.forEach(client => {
      try {
        client.end();
      } catch (error) {
        console.error('Error closing SSE client:', error.message);
      }
    });
    sseClients = [];

    // Force close all remaining connections
    server.closeAllConnections();

    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });
}

// Only start the agent if this module is being run directly (not imported)
// Force execution in test mode to work around path resolution issues when spawned
const forceRun = process.argv.includes('--test-mode');
if (import.meta.url === pathToFileURL(process.argv[1]).href || forceRun) {
  main().catch(error => {
    console.error('🔴 DAEMON EXIT REASON: Fatal error in main() (exit code 1)');
    console.error('Fatal error:', error);
    if (logger) logger.error('Daemon exiting', { reason: 'fatal_error', error: error.message, stack: error.stack });
    process.exit(1);
  });
}
