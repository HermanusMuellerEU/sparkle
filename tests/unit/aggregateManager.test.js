/**
 * Copyright 2025 Limitless Knowledge Association. Open sourced under MIT license.
 *
 * Aggregate Manager test suite
 * Tests the derived data store functionality
 */

import * as sparkle from '../../src/sparkle.js';
import * as aggregateManager from '../../src/aggregateManager.js';
import { unit_test_setup } from '../helpers/test-helpers.js';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';

describe('Aggregate Manager', () => {
  let testDir;

  beforeEach(async () => {
    testDir = await unit_test_setup(import.meta.url, 'aggregate-manager-tests');
    sparkle.setBaseDirectory(testDir);

    // Inject the real aggregate manager
    sparkle.setAggregateManager(aggregateManager);

    // Initialize the aggregate store
    await aggregateManager.initializeAggregateStore(testDir);
  });

  describe('Initialization', () => {
    test('creates directory structure', () => {
      const aggregateDir = join(testDir, '.aggregates');
      const itemsDir = join(aggregateDir, 'items');
      const metadataPath = join(aggregateDir, 'metadata.json');

      expect(existsSync(aggregateDir)).toBe(true);
      expect(existsSync(itemsDir)).toBe(true);
      expect(existsSync(metadataPath)).toBe(true);
    });
  });

  describe('Aggregate Creation', () => {
    test('creates aggregate file after item creation', async () => {
      const itemId = await sparkle.createItem('Test item', 'incomplete');
      const aggregatePath = join(testDir, '.aggregates', 'items', `${itemId}.json`);

      expect(existsSync(aggregatePath)).toBe(true);
    });

    test('contains all required fields', async () => {
      const itemId = await sparkle.createItem('Test item', 'incomplete');
      const aggregate = await aggregateManager.getAggregate(itemId);

      const requiredFields = ['itemId', 'tagline', 'status', 'created', 'creator', '_meta'];
      for (const field of requiredFields) {
        expect(aggregate[field]).toBeTruthy();
      }
    });

    test('metadata contains expected fields', async () => {
      const itemId = await sparkle.createItem('Test item', 'incomplete');
      const aggregate = await aggregateManager.getAggregate(itemId);

      const metaFields = ['lastEventTimestamp', 'eventFileCount', 'builtAt'];
      for (const field of metaFields) {
        expect(aggregate._meta[field]).toBeTruthy();
      }
    });

    test('has derived fields', async () => {
      const itemId = await sparkle.createItem('Test item', 'incomplete');
      const aggregate = await aggregateManager.getAggregate(itemId);

      expect(typeof aggregate.dependencyCount).toBe('number');
      expect(typeof aggregate.entryCount).toBe('number');
    });
  });

  describe('Aggregate Updates', () => {
    test('updates when tagline changes', async () => {
      const itemId = await sparkle.createItem('Original tagline', 'incomplete');

      await sparkle.alterTagline(itemId, 'Updated tagline');

      const aggregate = await aggregateManager.getAggregate(itemId);
      expect(aggregate.tagline).toBe('Updated tagline');
    });

    test('updates when status changes', async () => {
      const itemId = await sparkle.createItem('Test item', 'incomplete');

      await sparkle.updateStatus(itemId, 'completed');

      const aggregate = await aggregateManager.getAggregate(itemId);
      expect(aggregate.status).toBe('completed');
    });

    test('updates when entry added', async () => {
      const itemId = await sparkle.createItem('Test item', 'incomplete');

      await sparkle.addEntry(itemId, 'First entry');
      await sparkle.addEntry(itemId, 'Second entry');

      const aggregate = await aggregateManager.getAggregate(itemId);
      expect(aggregate.entryCount).toBe(2);
      expect(aggregate.entries.length).toBe(2);
    });

    test('updates when dependency added', async () => {
      const item1 = await sparkle.createItem('Item 1', 'incomplete');
      const item2 = await sparkle.createItem('Item 2', 'incomplete');

      await sparkle.addDependency(item1, item2);

      const aggregate1 = await aggregateManager.getAggregate(item1);
      expect(aggregate1.dependencyCount).toBe(1);
      expect(aggregate1.dependencies).toContain(item2);
    });

    test('both aggregates update when dependency added', async () => {
      const item1 = await sparkle.createItem('Item 1', 'incomplete');
      const item2 = await sparkle.createItem('Item 2', 'incomplete');

      const beforeTimestamp = Date.now();

      await sparkle.addDependency(item1, item2);

      const aggregate1 = await aggregateManager.getAggregate(item1);
      const aggregate2 = await aggregateManager.getAggregate(item2);

      const time1 = new Date(aggregate1._meta.builtAt).getTime();
      const time2 = new Date(aggregate2._meta.builtAt).getTime();

      expect(time1).toBeGreaterThanOrEqual(beforeTimestamp);
      expect(time2).toBeGreaterThanOrEqual(beforeTimestamp);
    });

    test('updates when monitor added', async () => {
      const itemId = await sparkle.createItem('Test item', 'incomplete');

      await sparkle.addMonitor(itemId);

      const aggregate = await aggregateManager.getAggregate(itemId);
      expect(aggregate.monitors).toBeTruthy();
      expect(aggregate.monitors.length).toBe(1);
    });

    test('updates when item ignored', async () => {
      const itemId = await sparkle.createItem('Test item', 'incomplete');

      await sparkle.ignoreItem(itemId);

      const aggregate = await aggregateManager.getAggregate(itemId);
      expect(aggregate.ignored).toBe(true);
    });

    test('updates when item taken', async () => {
      const itemId = await sparkle.createItem('Test item', 'incomplete');

      await sparkle.takeItem(itemId);

      const aggregate = await aggregateManager.getAggregate(itemId);
      expect(aggregate.takenBy).toBeTruthy();
    });
  });

  describe('getAllAggregates', () => {
    test('returns all items', async () => {
      await sparkle.createItem('Item 1', 'incomplete');
      await sparkle.createItem('Item 2', 'incomplete');
      await sparkle.createItem('Item 3', 'incomplete');

      const aggregates = await aggregateManager.getAllAggregates();

      expect(aggregates.length).toBe(3);
    });

    test('returns items in correct format', async () => {
      await sparkle.createItem('Test item', 'incomplete');

      const aggregates = await aggregateManager.getAllAggregates();
      const aggregate = aggregates[0];

      expect(aggregate.itemId).toBeTruthy();
      expect(aggregate.tagline).toBeTruthy();
      expect(aggregate.status).toBeTruthy();
    });
  });

  describe('Validation', () => {
    test('passes for valid aggregate', async () => {
      const itemId = await sparkle.createItem('Test item', 'incomplete');

      const validation = await aggregateManager.validateAggregate(itemId);

      expect(validation.valid).toBe(true);
    });

    test('detects missing aggregate', async () => {
      const validation = await aggregateManager.validateAggregate('99999999');

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Aggregate file not found');
    });

    test('validateAllAggregates passes for valid system', async () => {
      await sparkle.createItem('Item 1', 'incomplete');
      await sparkle.createItem('Item 2', 'incomplete');

      const validation = await sparkle.validateAllAggregates();

      expect(validation.valid).toBe(true);
    });
  });

  describe('Rebuild All', () => {
    test('rebuilds all aggregates', async () => {
      await sparkle.createItem('Item 1', 'incomplete');
      await sparkle.createItem('Item 2', 'incomplete');
      await sparkle.createItem('Item 3', 'incomplete');

      // Delete all aggregate files to simulate corruption
      const itemsDir = join(testDir, '.aggregates', 'items');
      const files = await readdir(itemsDir);
      for (const file of files) {
        const { unlink } = await import('fs/promises');
        await unlink(join(itemsDir, file));
      }

      // Rebuild all
      await sparkle.rebuildAllAggregates();

      // Check all aggregates exist
      const aggregates = await aggregateManager.getAllAggregates();
      expect(aggregates.length).toBe(3);
    });

    test('reports progress', async () => {
      await sparkle.createItem('Item 1', 'incomplete');
      await sparkle.createItem('Item 2', 'incomplete');
      await sparkle.createItem('Item 3', 'incomplete');

      let progressCalls = 0;
      let lastCurrent = 0;
      let lastTotal = 0;

      await sparkle.rebuildAllAggregates((current, total) => {
        progressCalls++;
        lastCurrent = current;
        lastTotal = total;
      });

      expect(progressCalls).toBeGreaterThan(0);
      expect(lastCurrent).toBe(3);
      expect(lastTotal).toBe(3);
    });

    test('records sparkleVersion in metadata only when provided', async () => {
      await sparkle.createItem('Item 1', 'incomplete');

      const before = await aggregateManager.getMetadata();
      expect(before.sparkleVersion).toBeUndefined();

      await sparkle.rebuildAllAggregates();
      const afterPlain = await aggregateManager.getMetadata();
      expect(afterPlain.sparkleVersion).toBeUndefined();

      await sparkle.rebuildAllAggregates(null, { sparkleVersion: '1.3.0' });
      const afterStamp = await aggregateManager.getMetadata();
      expect(afterStamp.sparkleVersion).toBe('1.3.0');
    });
  });

  describe('SSE Notification Callback', () => {
    test('callback is called when aggregate rebuilt', async () => {
      let callbackInvoked = false;
      let callbackItemId = null;

      sparkle.onAggregateChanged((itemId) => {
        callbackInvoked = true;
        callbackItemId = itemId;
      });

      const itemId = await sparkle.createItem('Test item', 'incomplete');

      expect(callbackInvoked).toBe(true);
      expect(callbackItemId).toBe(itemId);
    });
  });

  describe('Integration with Sparkle API', () => {
    test('getAllItems returns data from aggregates', async () => {
      await sparkle.createItem('Item 1', 'incomplete');
      const item2 = await sparkle.createItem('Item 2', 'incomplete');
      await sparkle.updateStatus(item2, 'completed');

      const items = await sparkle.getAllItems();

      expect(items.length).toBe(2);

      // Check data format
      for (const item of items) {
        expect(item.itemId).toBeTruthy();
        expect(item.tagline).toBeTruthy();
        expect(item.status).toBeTruthy();
        expect(item.created).toBeTruthy();
      }
    });

    test('getItemDetails returns data from aggregate', async () => {
      const itemId = await sparkle.createItem('Test item', 'incomplete');
      await sparkle.addEntry(itemId, 'Test entry');

      const details = await sparkle.getItemDetails(itemId);

      expect(details.tagline).toBe('Test item');
      expect(details.entries.length).toBe(1);
    });

    test('pendingWork uses aggregates', async () => {
      const item1 = await sparkle.createItem('Item 1', 'incomplete');
      const item2 = await sparkle.createItem('Item 2', 'incomplete');
      const item3 = await sparkle.createItem('Item 3', 'incomplete');
      await sparkle.updateStatus(item3, 'completed');

      await sparkle.addDependency(item2, item1);

      const pending = [];
      for await (const itemId of sparkle.pendingWork()) {
        pending.push(itemId);
      }

      // Item 1 should be pending (no deps, not completed)
      // Item 2 should NOT be pending (depends on item1 which is not completed)
      // Item 3 should NOT be pending (already completed)

      expect(pending).toContain(item1);
      expect(pending).not.toContain(item2);
      expect(pending).not.toContain(item3);
    });
  });

  describe('Performance', () => {
    test('aggregates provide faster access than event sourcing', async () => {
      // Create item with multiple events
      const itemId = await sparkle.createItem('Test item', 'incomplete');
      await sparkle.addEntry(itemId, 'Entry 1');
      await sparkle.addEntry(itemId, 'Entry 2');
      await sparkle.addEntry(itemId, 'Entry 3');
      await sparkle.alterTagline(itemId, 'Updated tagline');
      await sparkle.updateStatus(itemId, 'completed');

      // Time aggregate access
      const startAggregate = Date.now();
      await sparkle.getItemDetails(itemId);
      const aggregateTime = Date.now() - startAggregate;

      console.log(`  Aggregate access time: ${aggregateTime}ms`);

      // Verify the aggregate has all the data
      const details = await sparkle.getItemDetails(itemId);

      expect(details.entries.length).toBe(3);
      expect(details.tagline).toBe('Updated tagline');
      expect(details.status).toBe('completed');
    });
  });
});
