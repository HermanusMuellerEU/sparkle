/**
 * Copyright 2025 Limitless Knowledge Association. Open sourced under MIT license.
 *
 * Sparkle monitor operations tests
 * Tests: Adding/removing monitors, idempotency
 */

import { setupSparkle } from './sparkle-test-helpers.js';

describe('Sparkle - Monitors', () => {
  let sparkle;

  beforeEach(async () => {
    sparkle = await setupSparkle('monitor-tests');
  });

  describe('Add and remove', () => {
    test('add and remove monitor', async () => {
      const item = await sparkle.createItem('Test item');

      await sparkle.addMonitor(item);

      const detailsWithMonitor = await sparkle.getItemDetails(item);
      expect(detailsWithMonitor.monitors.length).toBe(1);

      await sparkle.removeMonitor(item);

      const detailsWithoutMonitor = await sparkle.getItemDetails(item);
      expect(detailsWithoutMonitor.monitors.length).toBe(0);
    });

    test('clearing monitor after aggregate rebuild stops monitoring', async () => {
      const item = await sparkle.createItem('Test item');

      await sparkle.addMonitor(item);
      const detailsWithMonitor = await sparkle.getItemDetails(item);
      expect(detailsWithMonitor.monitors.length).toBe(1);

      // Rebuild drops any incremental-only fields. Clearing must still work.
      await sparkle.rebuildAggregate(item);

      await sparkle.removeMonitor(item);

      const detailsWithoutMonitor = await sparkle.getItemDetails(item);
      expect(detailsWithoutMonitor.monitors.length).toBe(0);
    });
  });

  describe('Idempotency', () => {
    test('adding when already monitoring', async () => {
      const item = await sparkle.createItem('Test item');

      await sparkle.addMonitor(item);
      await sparkle.addMonitor(item); // Should be ignored

      const details = await sparkle.getItemDetails(item);
      expect(details.monitors.length).toBe(1);
    });

    test('removing when not monitoring', async () => {
      const item = await sparkle.createItem('Test item');

      // Should not throw
      await expect(
        sparkle.removeMonitor(item)
      ).resolves.not.toThrow();
    });

    test('re-adding after removal', async () => {
      const item = await sparkle.createItem('Test item');

      await sparkle.addMonitor(item);
      await sparkle.removeMonitor(item);
      await sparkle.addMonitor(item);

      const details = await sparkle.getItemDetails(item);
      expect(details.monitors.length).toBe(1);
    });
  });
});
