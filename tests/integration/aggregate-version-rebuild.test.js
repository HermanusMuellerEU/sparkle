/**
 * Copyright 2025 Limitless Knowledge Association. Open sourced under MIT license.
 *
 * After a version upgrade the daemon rebuilds item aggregates before serving data.
 * Missing sparkleVersion in .aggregates/metadata.json counts as older.
 */

import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import {
  createTestEnvironment, installSparkle, initializeSparkle, getTarballPath,
  createTestId, cleanupEnvironment, startDaemon, stopDaemon,
  startLogServer, stopLogServer
} from '../helpers/test-helpers.js';
import { makeApiRequest } from '../../src/daemonClient.js';
import { TEST_VERSION } from '../../bin/prepare-test-distribution.js';

describe('Aggregate rebuild on Sparkle version change', () => {
  const baseDir = join(process.cwd(), '.integration_testing', 'aggregate-version-rebuild');
  const ctx = {};

  beforeAll(async () => {
    await mkdir(baseDir, { recursive: true });
    await startLogServer('aggregate-version-rebuild', baseDir);
    const env = await createTestEnvironment(baseDir, 'aggregate-version-rebuild', 1, createTestId());
    ctx.env = env;
    ctx.clone = env.clones[0];
    await installSparkle(ctx.clone, await getTarballPath());
    await initializeSparkle(ctx.clone);
    ctx.dataDir = join(ctx.clone, '.sparkle-worktree', 'sparkle-data');
    ctx.metadataPath = join(ctx.dataDir, '.aggregates', 'metadata.json');
  }, 240000);

  afterAll(async () => {
    if (ctx.port) await stopDaemon(ctx.port).catch(() => {});
    await stopLogServer();
    if (ctx.env) await cleanupEnvironment(ctx.env.testDir);
  }, 60000);

  test('first start stamps sparkleVersion and a second start with an older stamp rebuilds', async () => {
    const port1 = await startDaemon(ctx.clone, `${createTestId()}-v1`);
    ctx.port = port1;

    const created = await makeApiRequest(port1, '/api/createItem', 'POST', {
      tagline: 'Version rebuild item',
      status: 'incomplete'
    });
    expect(created.itemId).toMatch(/^\d{8}$/);

    const afterFirst = JSON.parse(await readFile(ctx.metadataPath, 'utf8'));
    expect(afterFirst.sparkleVersion).toBe(TEST_VERSION);

    await stopDaemon(port1);

    const metadata = JSON.parse(await readFile(ctx.metadataPath, 'utf8'));
    metadata.sparkleVersion = '0.0.0-aaa';
    await writeFile(ctx.metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');

    const port2 = await startDaemon(ctx.clone, `${createTestId()}-v2`);
    ctx.port = port2;

    const details = await makeApiRequest(port2, '/api/getItemDetails', 'POST', { itemId: created.itemId });
    expect(details.tagline).toBe('Version rebuild item');

    const afterSecond = JSON.parse(await readFile(ctx.metadataPath, 'utf8'));
    expect(afterSecond.sparkleVersion).toBe(TEST_VERSION);
  }, 120000);
});
