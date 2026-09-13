import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Devin CLI (the agent inside Devin Desktop, formerly Windsurf) keeps every
// session in a single SQLite store: <data>/cli/sessions.db. The data root is
// $XDG_DATA_HOME/devin on macOS/Linux and %APPDATA%\devin on Windows; releases
// before the cognition→devin rename used ~/.local/share/cognition, and very
// early builds wrote cli_sessions.db next to sessions.db (the upgrader merges
// it in place, but an unmigrated install may still have only the old name).
export function getDevinDataDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(home, 'AppData', 'Roaming');
    return join(appData, 'devin');
  }
  const xdgData = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
  return join(xdgData, 'devin');
}

export function getDevinDbPaths(env = process.env) {
  const override = env.VIBE_USAGE_DEVIN_DB?.trim();
  if (override) {
    return [isAbsolute(override) ? override : resolve(override)].filter(existsSync);
  }
  const cliDir = join(getDevinDataDir(env), 'cli');
  return [join(cliDir, 'sessions.db'), join(cliDir, 'cli_sessions.db')]
    .filter(existsSync);
}

export function findDevinDataDirs() {
  return getDevinDbPaths();
}
