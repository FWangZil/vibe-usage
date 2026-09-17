import { existsSync, realpathSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';

// Root discovery for Kimi Code. The CLI keeps one data home, and the Kimi Work
// desktop app runs an embedded Kimi Code runtime whose home has the CLI's exact
// layout (issue #85), so both homes are scanned additively.

// Kimi Work's embedded runtime home, relative to the app's Electron userData.
const DAIMON_RUNTIME = ['daimon-share', 'daimon', 'runtime', 'kimi-code', 'home'];

/** Kimi Work's embedded Kimi Code home for this platform. */
export function kimiWorkCodeHome(env = process.env, platform = process.platform, home = homedir()) {
  const pathImpl = platform === 'win32' ? win32 : posix;
  const userData = platform === 'darwin'
    ? pathImpl.join(home, 'Library', 'Application Support')
    : platform === 'win32'
      ? (env.APPDATA?.trim() || pathImpl.join(home, 'AppData', 'Roaming'))
      : (env.XDG_CONFIG_HOME?.trim() || pathImpl.join(home, '.config'));
  return pathImpl.join(userData, 'kimi-desktop', ...DAIMON_RUNTIME);
}

// Two roots can name the same directory (symlinks, a relocated home that still
// resolves to the same store); scanning both would double-count every record.
function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const path of paths) {
    let key = path;
    try { key = realpathSync(path); } catch { /* not created yet — compare as given */ }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}

/**
 * Kimi Code data homes to scan, primary first.
 *
 * `VIBE_USAGE_KIMI_CODE_DIR` (test/relocation hook) replaces discovery entirely,
 * so a fixture never picks up the machine's real stores. Otherwise the CLI home
 * — `$KIMI_CODE_HOME` when set, exactly like the CLI itself — is scanned
 * alongside the Kimi Work desktop home; the desktop app never writes into the
 * CLI home, so the two stores are independent.
 */
export function resolveKimiCodeRoots(env = process.env, platform = process.platform, home = homedir()) {
  const override = env.VIBE_USAGE_KIMI_CODE_DIR?.trim();
  if (override) return [override];
  const pathImpl = platform === 'win32' ? win32 : posix;
  return uniquePaths([
    env.KIMI_CODE_HOME?.trim() || pathImpl.join(home, '.kimi-code'),
    kimiWorkCodeHome(env, platform, home),
  ]);
}

/** Existing Kimi Code session stores, for tool detection (`status`). */
export function findKimiCodeDataDirs() {
  return uniquePaths([
    ...resolveKimiCodeRoots().map(root => join(root, 'sessions')),
    join(homedir(), '.kimi', 'sessions'), // legacy store, always parsed alongside
  ]).filter(existsSync);
}
