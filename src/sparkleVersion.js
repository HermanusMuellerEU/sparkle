/**
 * Compare Sparkle package versions (semver-like, including a prerelease suffix).
 *
 * Used to decide whether on-disk aggregates need a full rebuild after an upgrade.
 * "Older" means strictly less than the running version; equal or newer does not rebuild.
 */

/**
 * @param {string|null|undefined} version
 * @returns {{parts: number[], prerelease: string|null}|null}
 */
export function parseSparkleVersion(version) {
  if (version == null || version === '') {
    return null;
  }

  const str = String(version);
  const dash = str.indexOf('-');
  const core = dash === -1 ? str : str.slice(0, dash);
  const prerelease = dash === -1 ? null : str.slice(dash + 1);

  const parts = core.split('.').map(segment => {
    const n = parseInt(segment, 10);
    return Number.isFinite(n) ? n : 0;
  });
  while (parts.length < 3) {
    parts.push(0);
  }

  return { parts: parts.slice(0, 3), prerelease };
}

/**
 * Whether `stored` is missing or strictly older than `current`.
 *
 * @param {string|null|undefined} stored - Version recorded when aggregates were last fully rebuilt
 * @param {string} current - Running Sparkle version
 * @returns {boolean}
 */
export function isSparkleVersionOlder(stored, current) {
  const a = parseSparkleVersion(stored);
  if (!a) {
    return true;
  }

  const b = parseSparkleVersion(current);
  if (!b) {
    return false;
  }

  for (let i = 0; i < 3; i++) {
    if (a.parts[i] < b.parts[i]) {
      return true;
    }
    if (a.parts[i] > b.parts[i]) {
      return false;
    }
  }

  // Equal numeric core: a prerelease is older than the release; otherwise compare suffixes.
  if (a.prerelease && !b.prerelease) {
    return true;
  }
  if (!a.prerelease && b.prerelease) {
    return false;
  }
  if (a.prerelease && b.prerelease && a.prerelease !== b.prerelease) {
    return a.prerelease < b.prerelease;
  }

  return false;
}
