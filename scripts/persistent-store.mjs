import fs from 'node:fs';
import path from 'node:path';
import { EXACT_PNPM_PIN } from './completed-tree.mjs';
import { assertPathWithinDirectory, findNearestExistingPath, isPathWithin } from './resolve-cache-paths.mjs';

// A persistent self-hosted runner keeps its disk between jobs, but checkout's
// `git clean -ffdx` deletes the in-workspace pnpm store every time. This module
// owns a root outside the workspace that holds the pnpm store, the Corepack
// home, and the Electron download caches, plus a seed marker that says when
// the store was last filled from the dependency cache.
//
// The action only ever creates or deletes the entries named here, directly
// under the root, so the root can be shared with unrelated files.
export const PERSISTENT_STORE_ENTRIES = Object.freeze({
  store: 'pnpm-store',
  electron: 'electron',
  prebuild: 'npm',
  corepack: 'corepack',
});
export const SEED_MARKER_NAME = '.configure-nodejs-seeded';
const SEED_MARKER_TEMPORARY_NAME = `${SEED_MARKER_NAME}.tmp`;
export const DEFAULT_MAX_AGE_DAYS = 14;
const INCOMING_SUFFIX = '.incoming';
const SECONDS_PER_DAY = 86400;

export function isPersistentStoreEnabled(persistentStoreDir = '') {
  return String(persistentStoreDir).trim() !== '';
}

export function normalizeMaxAgeDays(value = String(DEFAULT_MAX_AGE_DAYS)) {
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized) || Number(normalized) < 1) {
    throw new Error(
      `Invalid persistent-store-max-age-days value "${value}". Expected a whole number of days, 1 or more.`,
    );
  }
  return Number(normalized);
}

// Persistent mode only reuses a pnpm store, and the Corepack home it keeps is
// trusted without a download-time hash check, so it needs an exact pin.
export function validatePersistentStoreMode({
  dependencyCache = 'default',
  lookupOnly = 'false',
  packageManager = '',
  packageManagerVersion = '',
}) {
  if (dependencyCache !== 'default') {
    throw new Error('persistent-store-dir cannot be combined with dependency-cache: node-modules.');
  }
  if (lookupOnly !== 'false') {
    throw new Error('persistent-store-dir cannot be combined with lookup-only.');
  }
  if (packageManager !== 'pnpm') {
    throw new Error(`persistent-store-dir supports pnpm only; resolved package manager is ${packageManager || 'unknown'}.`);
  }
  if (!EXACT_PNPM_PIN.test(packageManagerVersion)) {
    throw new Error('persistent-store-dir requires an exact pnpm pin in package.json#packageManager.');
  }
}

// Resolve symlinks in the part of the path that exists, so a root that only
// looks safe (a link to `/`, or into the workspace) is judged by its target.
function realPathOfPossiblyMissing(candidate) {
  const existing = findNearestExistingPath(candidate);
  return path.join(fs.realpathSync(existing), path.relative(existing, candidate));
}

// The root is where every delete in persistent mode happens, so it must be an
// absolute directory that cannot overlap the workspace, the home directory, or
// the filesystem root. Both the given path and its real path are checked.
export function resolvePersistentStoreRoot({
  persistentStoreDir,
  workspace,
  home = '',
}) {
  let given = String(persistentStoreDir).trim();
  // Workflow inputs cannot expand $HOME, so accept a leading `~`.
  if (home && (given === '~' || /^~[\\/]/.test(given))) {
    given = path.join(home, given.slice(1));
  }
  if (!path.isAbsolute(given)) {
    throw new Error(`persistent-store-dir "${given}" must be an absolute path.`);
  }
  const lexical = path.resolve(given);
  const real = realPathOfPossiblyMissing(lexical);
  const protectedPaths = [
    ['the workspace', workspace],
    ['the home directory', home],
  ].filter(([, value]) => value)
    .flatMap(([name, value]) => {
      const resolved = path.resolve(value);
      return [[name, resolved], [name, realPathOfPossiblyMissing(resolved)]];
    });

  for (const candidate of new Set([lexical, real])) {
    if (path.dirname(candidate) === candidate) {
      throw new Error(`persistent-store-dir "${given}" resolves to a filesystem root.`);
    }
    for (const [name, protectedPath] of protectedPaths) {
      // An ancestor of the workspace or home could name it as a managed entry
      // (a workspace or user called `npm`), so ancestors are rejected too.
      if (isPathWithin(candidate, protectedPath)) {
        throw new Error(`persistent-store-dir "${given}" is ${name} or contains it.`);
      }
      if (name === 'the workspace' && isPathWithin(protectedPath, candidate)) {
        throw new Error(`persistent-store-dir "${given}" is inside the workspace, where checkout would delete it.`);
      }
    }
  }
  return real;
}

// The runner empties RUNNER_TEMP before every job, so a root there never warms.
export function isUnderRunnerTemp({ root, runnerTemp = '' }) {
  return runnerTemp !== '' && isPathWithin(realPathOfPossiblyMissing(path.resolve(runnerTemp)), root);
}

export function persistentStorePaths(root) {
  return {
    root,
    store: path.join(root, PERSISTENT_STORE_ENTRIES.store),
    electron: path.join(root, PERSISTENT_STORE_ENTRIES.electron),
    prebuild: path.join(root, PERSISTENT_STORE_ENTRIES.prebuild),
    corepack: path.join(root, PERSISTENT_STORE_ENTRIES.corepack),
    marker: path.join(root, SEED_MARKER_NAME),
    markerTemporary: path.join(root, SEED_MARKER_TEMPORARY_NAME),
  };
}

// Every delete goes through here: the target must be a direct, named child of
// the root. fs.rmSync removes a symlink itself rather than following it.
function removeManaged(root, target) {
  assertPathWithinDirectory({ boundaryPath: root, candidatePath: target, description: 'Persistent store entry' });
  if (path.dirname(path.resolve(target)) !== path.resolve(root)) {
    throw new Error(`Refusing to delete "${target}": not a direct entry of "${root}".`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

// The marker holds the seed time in epoch seconds. Only a readable, current,
// unexpired marker makes the store warm.
export function readSeedMarker(markerPath, { now, maxAgeDays }) {
  let text;
  try {
    text = fs.readFileSync(markerPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', detail: error.code ?? error.message };
  }
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { state: 'unreadable', detail: 'not epoch seconds' };
  const ageSeconds = now - Number(trimmed);
  if (ageSeconds < 0) return { state: 'future', ageSeconds };
  if (ageSeconds >= maxAgeDays * SECONDS_PER_DAY) return { state: 'expired', ageSeconds };
  return { state: 'warm', ageSeconds };
}

// Remove the marker first, so an interrupted drop leaves a cold store rather
// than a half-deleted one that the next job trusts.
export function dropPersistentStore(paths) {
  removeManaged(paths.root, paths.marker);
  removeManaged(paths.root, paths.markerTemporary);
  for (const name of Object.values(PERSISTENT_STORE_ENTRIES)) {
    removeManaged(paths.root, path.join(paths.root, name));
    removeManaged(paths.root, path.join(paths.root, `${name}${INCOMING_SUFFIX}`));
  }
}

export function invalidatePersistentStore(paths) {
  removeManaged(paths.root, paths.marker);
}

function hasManagedContent(paths) {
  return Object.values(PERSISTENT_STORE_ENTRIES)
    .flatMap((name) => [name, `${name}${INCOMING_SUFFIX}`])
    .some((name) => fs.existsSync(path.join(paths.root, name)));
}

// Decide warm or cold. Anything other than warm drops the store, so the next
// seed starts from only the current lockfile's cache; that bounds its growth.
// A marker whose store has since been deleted is cold too: re-seeding from the
// cache archive is faster than downloading the whole tree from the registry.
export function checkPersistentStore({ paths, now, maxAgeDays }) {
  fs.mkdirSync(paths.root, { recursive: true });
  const marker = readSeedMarker(paths.marker, { now, maxAgeDays });
  const storePresent = fs.existsSync(paths.store) && fs.statSync(paths.store).isDirectory();
  if (marker.state === 'warm' && storePresent) {
    return { warm: true, reason: 'warm', ageSeconds: marker.ageSeconds, dropped: false };
  }
  const reason = marker.state === 'warm' ? 'incomplete' : marker.state;
  const dropped = reason !== 'missing' || hasManagedContent(paths);
  if (dropped) dropPersistentStore(paths);
  return { warm: false, reason, ageSeconds: marker.ageSeconds, dropped };
}

export function describePersistentStoreCheck(result, { paths, maxAgeDays }) {
  const hours = Math.floor((result.ageSeconds ?? 0) / 3600);
  const days = Math.floor((result.ageSeconds ?? 0) / 86400);
  switch (result.reason) {
    case 'warm':
      return `Persistent pnpm store is warm (seeded ${hours} h ago); skipping the dependency cache restore: ${paths.store}`;
    case 'missing':
      return result.dropped
        ? `Persistent pnpm store at ${paths.store} has no seed marker; dropped it to re-seed it.`
        : `No persistent pnpm store at ${paths.store}; seeding it from the dependency cache.`;
    case 'incomplete':
      return `Persistent pnpm store at ${paths.store} is missing although its seed marker is present; re-seeding it.`;
    case 'unreadable':
      return 'Persistent pnpm store seed marker is unreadable; dropped the store to re-seed it.';
    case 'future':
      return 'Persistent pnpm store seed marker is dated in the future; dropped the store to re-seed it.';
    case 'expired':
      return `Persistent pnpm store expired (seeded ${days} d ago, limit ${maxAgeDays} d); dropped it to re-seed from the current lockfile.`;
    default:
      throw new Error(`Unknown persistent store state ${result.reason}.`);
  }
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// On Windows, antivirus and indexers briefly hold files open, which makes a
// directory rename fail with EPERM, EACCES, or EBUSY. Retry those for a while.
function renameWithRetry(rename, source, destination, platform) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return rename(source, destination);
    } catch (error) {
      const transient = platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      if (!transient || attempt >= 10) throw error;
      pause(attempt * 100);
    }
  }
}

// Rename is atomic and keeps pnpm's hardlinks on one volume. Across volumes it
// fails with EXDEV, so copy (cloning where the filesystem can) and remove.
export function moveDirectory(source, destination, { rename = fs.renameSync, platform = process.platform } = {}) {
  try {
    renameWithRetry(rename, source, destination, platform);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(source, destination, {
      recursive: true,
      verbatimSymlinks: true,
      mode: fs.constants.COPYFILE_FICLONE,
    });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

// Move under a temporary name first, so an interrupted move never leaves a
// partial directory under the final name.
function moveInto(paths, source, destination, rename) {
  if (!source || !fs.existsSync(source)) return false;
  const incoming = `${destination}${INCOMING_SUFFIX}`;
  removeManaged(paths.root, incoming);
  moveDirectory(source, incoming, { rename });
  removeManaged(paths.root, destination);
  moveDirectory(incoming, destination, { rename });
  return true;
}

// Write then rename, so a reader never sees a partial marker. The temporary
// name is fixed so a drop can always clean it up after an interruption.
function writeMarker(paths, now) {
  fs.writeFileSync(paths.markerTemporary, `${now}\n`);
  fs.renameSync(paths.markerTemporary, paths.marker);
}

// Cold path, after the normal restore and install: move the workspace store
// and Electron caches under the root and write the marker last, because the
// marker is what makes the next job trust the store.
export function seedPersistentStore({
  paths,
  workspaceStore,
  workspaceElectron = '',
  workspacePrebuild = '',
  now,
  rename = fs.renameSync,
}) {
  if (!fs.existsSync(workspaceStore)) {
    return { seeded: false, moved: [] };
  }
  fs.mkdirSync(paths.root, { recursive: true });
  invalidatePersistentStore(paths);
  const moved = [];
  for (const [name, source, destination] of [
    ['store', workspaceStore, paths.store],
    ['electron', workspaceElectron, paths.electron],
    ['prebuild', workspacePrebuild, paths.prebuild],
  ]) {
    if (moveInto(paths, source, destination, rename)) moved.push(name);
  }
  writeMarker(paths, now);
  return { seeded: true, moved };
}

// The install command carries `--store-dir .pnpm-store`; point it at the
// persistent store instead.
export function withStoreDir(installArguments, storeDir) {
  const index = installArguments.indexOf('--store-dir');
  if (index === -1) return [...installArguments, '--store-dir', storeDir];
  return installArguments.map((value, at) => (at === index + 1 ? storeDir : value));
}

// A COREPACK_HOME the caller set is theirs to manage. An empty one, or one this
// action exported earlier in the job, moves to the persistent root.
export function resolvePersistentCorepackHome({ paths, corepackHome = '', managedCorepackHome = '' }) {
  if (corepackHome !== '' && corepackHome !== managedCorepackHome) {
    return { home: corepackHome, managed: false };
  }
  return { home: paths.corepack, managed: true };
}

// Map a path discovered inside the workspace store to the same place under the
// persistent store, e.g. `.pnpm-store/v10` to `<root>/pnpm-store/v10`.
export function relocateStorePath({ discoveredStorePath, workspaceStore, persistentStore }) {
  if (!discoveredStorePath) return persistentStore;
  if (!isPathWithin(path.resolve(workspaceStore), path.resolve(discoveredStorePath))) {
    return persistentStore;
  }
  return path.join(persistentStore, path.relative(path.resolve(workspaceStore), path.resolve(discoveredStorePath)));
}
