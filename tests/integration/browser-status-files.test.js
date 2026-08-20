/**
 * Copyright 2025 Limitless Knowledge Association. Open sourced under MIT license.
 *
 * Browser test (Playwright + local Chromium): the Status Files view.
 *
 * Covers the browser half of the feature — the header button, the listing, viewing a
 * report in a new tab, and the download button — plus the two protections that are easy
 * to claim and easy to get wrong: a CI-authored report may run inlined chart JS, but
 * must not reach the daemon's (unauthenticated) API, and a publisher-chosen name must
 * never be parsed as markup.
 */

import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import playwright from 'playwright';
import {
  createTestEnvironment, installSparkle, initializeSparkle, getTarballPath,
  startDaemon, stopDaemon, startLogServer, stopLogServer, createTestId, cleanupEnvironment
} from '../helpers/test-helpers.js';

const execAsync = promisify(execCallback);
const { chromium } = playwright;

describe('Browser status files view', () => {
  const baseDir = join(process.cwd(), '.integration_testing', 'browser-status-files');
  const ctx = {};

  /** Publish via the CLI + stdin, as a CI system would. */
  const publish = async (name, content) => {
    await writeFile(join(ctx.clone, 'payload.tmp'), content, 'utf8');
    await execAsync(`node ${ctx.cliPath} add-status-file '${name}' --json < payload.tmp`, {
      cwd: ctx.clone,
      shell: '/bin/bash'
    });
  };

  beforeAll(async () => {
    await mkdir(baseDir, { recursive: true });
    await startLogServer('browser-status-files', baseDir);
    const env = await createTestEnvironment(baseDir, 'browser-status-files', 1, createTestId());
    ctx.env = env;
    ctx.clone = env.clones[0];
    await installSparkle(ctx.clone, await getTarballPath());
    await initializeSparkle(ctx.clone);
    ctx.cliPath = join(ctx.clone, 'node_modules/sparkle/bin/sparkle.js');
    ctx.port = await startDaemon(ctx.clone, `${createTestId()}-bsf`);
    ctx.base = `http://localhost:${ctx.port}`;

    await publish('build-report.json', '{"build":"green"}\n');
    await publish('nightly.html', '<h1>Nightly</h1>\n');

    // Force the full Chromium build (the default headless-shell isn't installed).
    ctx.browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 240000);

  afterAll(async () => {
    if (ctx.browser) await ctx.browser.close().catch(() => {});
    if (ctx.port) await stopDaemon(ctx.port).catch(() => {});
    await stopLogServer();
    if (ctx.env) await cleanupEnvironment(ctx.env.testDir);
  }, 60000);

  test('the view dropdown offers Status Files and navigates to it', async () => {
    const page = await ctx.browser.newPage();
    try {
      await page.goto(`${ctx.base}/list_view.html`, { waitUntil: 'domcontentloaded' });

      // Status Files is a primary view (a dropdown choice), not a separate button.
      // <option> elements are never "visible" until the select opens, so wait for attached.
      await page.waitForSelector('#viewSelector option[value="status_files.html"]',
        { state: 'attached', timeout: 20000 });
      const label = await page.$eval('#viewSelector option[value="status_files.html"]', o => o.textContent);
      expect(label).toBe('Status Files');
      expect(await page.$('#statusFilesBtn')).toBeNull();

      await page.selectOption('#viewSelector', 'status_files.html');
      await page.waitForURL(/status_files\.html/, { timeout: 10000 });
      await page.waitForSelector('.status-file-table', { timeout: 10000 });
    } finally {
      await page.close();
    }
  }, 90000);

  test('published files are listed with their real names', async () => {
    const page = await ctx.browser.newPage();
    try {
      await page.goto(`${ctx.base}/status_files.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.status-file-name', { timeout: 20000 });

      const names = await page.$$eval('.status-file-name', els => els.map(e => e.textContent));
      expect(names).toContain('build-report.json');
      expect(names).toContain('nightly.html');
    } finally {
      await page.close();
    }
  }, 90000);

  test('clicking a name opens the report in a new tab', async () => {
    const page = await ctx.browser.newPage();
    try {
      await page.goto(`${ctx.base}/status_files.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.status-file-name', { timeout: 20000 });

      const popupPromise = page.waitForEvent('popup', { timeout: 10000 });
      await page.click('.status-file-name:has-text("build-report.json")');
      const popup = await popupPromise;

      expect(popup.url()).toContain('/api/statusFile?name=build-report.json');
      await popup.close();
    } finally {
      await page.close();
    }
  }, 90000);

  test('each row offers a download link', async () => {
    const page = await ctx.browser.newPage();
    try {
      await page.goto(`${ctx.base}/status_files.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.status-file-table', { timeout: 20000 });

      const hrefs = await page.$$eval('a[download]', els => els.map(e => e.getAttribute('href')));
      expect(hrefs.some(h => h.includes('download=1') && h.includes('build-report.json'))).toBe(true);
    } finally {
      await page.close();
    }
  }, 90000);

  test('a report is served sandboxed, so it cannot script against the daemon', async () => {
    // The daemon API has no auth: an HTML report running on its origin could drive any
    // endpoint. It must render, with scripts allowed for charts, but connect blocked.
    const page = await ctx.browser.newPage();
    try {
      const response = await page.goto(`${ctx.base}/api/statusFile?name=nightly.html`);
      const headers = response.headers();
      const csp = headers['content-security-policy'];

      expect(csp).toBe("sandbox allow-scripts; connect-src 'none'");
      expect(csp).not.toMatch(/allow-same-origin/);
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['content-type']).toContain('text/html');
      expect(await response.text()).toBe('<h1>Nightly</h1>\n');
    } finally {
      await page.close();
    }
  }, 90000);

  test('inlined report JS can render charts but cannot reach the daemon API', async () => {
    // Observe actual execution in Chromium, not just the CSP header. Bare `sandbox`
    // used to block every script (Playwright would see the markers stay at their
    // HTML defaults). allow-scripts lets the canvas/eval markers change; connect-src
    // 'none' must still reject fetch so a report cannot drive the unauthenticated API.
    await publish('charts.html', `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Charts</title></head>
<body>
  <canvas id="spark" width="10" height="10"></canvas>
  <div id="chart">waiting</div>
  <div id="eval-chart">waiting</div>
  <div id="fetch-result">pending</div>
  <div id="post-result">pending</div>
  <script>
    (function () {
      var canvas = document.getElementById('spark').getContext('2d');
      canvas.fillStyle = '#00ff00';
      canvas.fillRect(0, 0, 10, 10);
      var pixel = canvas.getImageData(0, 0, 1, 1).data;
      document.getElementById('chart').textContent =
        pixel[1] === 255 ? 'rendered' : 'canvas-failed';

      document.getElementById('eval-chart').textContent = eval("'eval-rendered'");

      fetch('/api/statusFiles')
        .then(function () {
          document.getElementById('fetch-result').textContent = 'api-reached';
        })
        .catch(function () {
          document.getElementById('fetch-result').textContent = 'api-blocked';
        });

      fetch('/api/statusFiles/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'pwned-by-report.txt', text: 'should-not-land' })
      })
        .then(function () {
          document.getElementById('post-result').textContent = 'post-reached';
        })
        .catch(function () {
          document.getElementById('post-result').textContent = 'post-blocked';
        });
    })();
  </script>
</body>
</html>
`);

    const page = await ctx.browser.newPage();
    try {
      await page.goto(`${ctx.base}/api/statusFile?name=${encodeURIComponent('charts.html')}`, {
        waitUntil: 'load'
      });

      // These run in the page: canvas drawing and eval (typical of bundled chart JS).
      expect(await page.locator('#chart').textContent()).toBe('rendered');
      expect(await page.locator('#eval-chart').textContent()).toBe('eval-rendered');

      // These must not complete: GET listing and POST publish against the daemon.
      await page.waitForFunction(() => (
        document.getElementById('fetch-result').textContent === 'api-blocked' &&
        document.getElementById('post-result').textContent === 'post-blocked'
      ), { timeout: 10000 });

      const list = await page.request.get(`${ctx.base}/api/statusFiles`);
      const body = await list.json();
      expect(body.files.map(f => f.name)).not.toContain('pwned-by-report.txt');
    } finally {
      await page.close();
    }
  }, 90000);

  test('the download response is an attachment', async () => {
    // Fetched rather than navigated to: the browser refuses to navigate to this at all,
    // because the attachment header makes it a download — which is the point.
    const page = await ctx.browser.newPage();
    try {
      const response = await page.request.get(
        `${ctx.base}/api/statusFile?name=build-report.json&download=1`
      );

      expect(response.headers()['content-disposition']).toMatch(/attachment/);
      expect(response.headers()['content-disposition']).toMatch(/build-report\.json/);
      expect(await response.text()).toBe('{"build":"green"}\n');
    } finally {
      await page.close();
    }
  }, 90000);

  test('clicking Download actually downloads the report', async () => {
    const page = await ctx.browser.newPage();
    try {
      await page.goto(`${ctx.base}/status_files.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.status-file-table', { timeout: 20000 });

      const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
      await page.click('tr:has-text("build-report.json") a[download]');
      const download = await downloadPromise;

      expect(download.suggestedFilename()).toBe('build-report.json');
    } finally {
      await page.close();
    }
  }, 90000);

  test('a name containing markup is shown as text, never parsed as HTML', async () => {
    await publish('<img src=x onerror=alert(1)>.txt', 'harmless');

    const page = await ctx.browser.newPage();
    try {
      await page.goto(`${ctx.base}/status_files.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.status-file-name', { timeout: 20000 });

      const names = await page.$$eval('.status-file-name', els => els.map(e => e.textContent));
      expect(names).toContain('<img src=x onerror=alert(1)>.txt');

      // The name must not have become a real element.
      expect(await page.$$eval('.status-file-table img', els => els.length)).toBe(0);
    } finally {
      await page.close();
    }
  }, 90000);
});
