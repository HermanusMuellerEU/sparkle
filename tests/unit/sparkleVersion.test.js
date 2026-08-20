/**
 * Copyright 2025 Limitless Knowledge Association. Open sourced under MIT license.
 *
 * Sparkle version comparison used to decide aggregate rebuilds on upgrade.
 */

import { isSparkleVersionOlder, parseSparkleVersion } from '../../src/sparkleVersion.js';

describe('sparkleVersion', () => {
  describe('parseSparkleVersion', () => {
    test('parses dotted versions', () => {
      expect(parseSparkleVersion('1.3.0')).toEqual({ parts: [1, 3, 0], prerelease: null });
    });

    test('parses prerelease suffix', () => {
      expect(parseSparkleVersion('0.0.0-test')).toEqual({ parts: [0, 0, 0], prerelease: 'test' });
    });

    test('null and empty are missing', () => {
      expect(parseSparkleVersion(null)).toBe(null);
      expect(parseSparkleVersion('')).toBe(null);
    });
  });

  describe('isSparkleVersionOlder', () => {
    test('missing stored version is older', () => {
      expect(isSparkleVersionOlder(undefined, '1.3.0')).toBe(true);
      expect(isSparkleVersionOlder(null, '1.3.0')).toBe(true);
      expect(isSparkleVersionOlder('', '1.3.0')).toBe(true);
    });

    test('lower major/minor/patch is older', () => {
      expect(isSparkleVersionOlder('1.2.0', '1.3.0')).toBe(true);
      expect(isSparkleVersionOlder('1.3.0', '1.3.1')).toBe(true);
      expect(isSparkleVersionOlder('0.0.0-test', '1.3.0')).toBe(true);
    });

    test('equal version is not older', () => {
      expect(isSparkleVersionOlder('1.3.0', '1.3.0')).toBe(false);
      expect(isSparkleVersionOlder('0.0.0-test', '0.0.0-test')).toBe(false);
    });

    test('newer stored version is not older (downgrade does not rebuild)', () => {
      expect(isSparkleVersionOlder('1.4.0', '1.3.0')).toBe(false);
    });

    test('prerelease is older than the same-number release', () => {
      expect(isSparkleVersionOlder('1.3.0-beta', '1.3.0')).toBe(true);
      expect(isSparkleVersionOlder('1.3.0', '1.3.0-beta')).toBe(false);
    });
  });
});
